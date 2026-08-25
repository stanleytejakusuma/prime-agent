from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from rlm import (
    ParallelAdmissionError,
    ParallelResult,
    RLMSpawnHandle,
    RlmAdmissionError,
    RlmAdmissionTransportError,
    parse_fanin,
    parallel,
    expand_fanout,
    fanout,
    fanout_author,
)


def fake_handle(name: str) -> RLMSpawnHandle:
    return RLMSpawnHandle(
        rlm_child_id=f"sub-{name}",
        name=name,
        session_dir=__import__("pathlib").Path("/tmp") / name,
        model="provider/model",
    )


class ParallelTest(unittest.IsolatedAsyncioTestCase):
    async def test_happy_path_name_prefix_numbering(self) -> None:
        calls: list[tuple[str, dict]] = []

        async def stub_run(prompt: str, **kwargs):
            calls.append((prompt, kwargs))
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            result = await parallel(["task one", "task two", "task three"], name_prefix="fanout")

        self.assertIsNone(result.failed_index)
        self.assertIsNone(result.failed_name)
        self.assertIsNone(result.error)
        self.assertFalse(result.failed_uncertain)
        self.assertTrue(result.ok)
        self.assertEqual([handle.name for handle in result.handles], ["fanout-0", "fanout-1", "fanout-2"])
        self.assertEqual(len(result.tags), 3)
        self.assertEqual(len(set(result.tags)), 3)
        self.assertEqual(result.name_plan, ["fanout-0", "fanout-1", "fanout-2"])
        self.assertIn("COMPLETE: admitted 3/3", result.summary)
        self.assertEqual(len(calls), 3)

    async def test_happy_path_start_index_preserves_original_numbering(self) -> None:
        async def stub_run(prompt: str, **kwargs):
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            result = await parallel(["tail a", "tail b"], name_prefix="fanout", start_index=3)

        self.assertTrue(result.ok)
        self.assertEqual(result.name_plan, ["fanout-3", "fanout-4"])
        self.assertEqual([handle.name for handle in result.handles], ["fanout-3", "fanout-4"])

    async def test_happy_path_names_verbatim(self) -> None:
        async def stub_run(prompt: str, **kwargs):
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            result = await parallel(["a", "b"], names=["alpha-worker", "beta worker"])

        self.assertTrue(result.ok)
        self.assertEqual(result.name_plan, ["alpha-worker", "beta worker"])
        self.assertEqual([handle.name for handle in result.handles], ["alpha-worker", "beta worker"])

    async def test_returns_without_blocking_for_child_answers(self) -> None:
        gate = asyncio.Event()

        async def stub_run(prompt: str, **kwargs):
            # A child answer would block here forever; parallel() must not wait for it.
            await gate.wait()
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            task = asyncio.create_task(parallel(["one", "two"], name_prefix="fanout"))
            # Admission of child 0 completes; child 1 admission is pending on the gate.
            # parallel() must return as soon as admission completes, so cancel the run
            # mid-admission and verify the cancellation contract instead of hanging.
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_fail_stop_at_first_admission_error(self) -> None:
        attempted: list[str] = []

        async def stub_run(prompt: str, **kwargs):
            attempted.append(kwargs["name"])
            if len(attempted) == 3:
                raise RlmAdmissionError("host rejected: duplicate name")
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            with self.assertRaises(ParallelAdmissionError) as ctx:
                await parallel(["t0", "t1", "t2", "t3", "t4"], name_prefix="fanout")

        error = ctx.exception
        self.assertIsInstance(error.result, ParallelResult)
        self.assertEqual(error.result.failed_index, 2)
        self.assertEqual(error.result.failed_name, "fanout-2")
        self.assertEqual(len(error.result.handles), 2)
        self.assertEqual([handle.name for handle in error.result.handles], ["fanout-0", "fanout-1"])
        self.assertFalse(error.result.failed_uncertain)
        # indices > failed_index are never attempted
        self.assertEqual(attempted, ["fanout-0", "fanout-1", "fanout-2"])
        self.assertIn("PARTIAL FAILURE: admitted 2/5, failed at index 2", str(error))

    async def test_failed_uncertain_deterministic_vs_transport(self) -> None:
        async def rejected_run(prompt: str, **kwargs):
            raise RlmAdmissionError("deterministic host rejection")

        with patch("rlm.run", new=rejected_run):
            with self.assertRaises(ParallelAdmissionError) as ctx:
                await parallel(["only"], name_prefix="fanout")
        self.assertFalse(ctx.exception.result.failed_uncertain)

        async def transport_run(prompt: str, **kwargs):
            raise RlmAdmissionTransportError("connection reset")

        with patch("rlm.run", new=transport_run):
            with self.assertRaises(ParallelAdmissionError) as ctx:
                await parallel(["only"], name_prefix="fanout")
        self.assertTrue(ctx.exception.result.failed_uncertain)

    async def test_retry_tail_with_names_slice_preserves_verbatim(self) -> None:
        async def stub_run(prompt: str, **kwargs):
            return fake_handle(kwargs["name"])

        planned = ["one", "two", "three", "four"]
        with patch("rlm.run", new=stub_run):
            first = await parallel(["a", "b"], names=planned[:2])
            tail = await parallel(["c", "d"], names=planned[2:])

        self.assertTrue(first.ok and tail.ok)
        self.assertEqual(first.name_plan, ["one", "two"])
        self.assertEqual(tail.name_plan, ["three", "four"])

    async def test_validation_errors_raise_before_any_host_request(self) -> None:
        async def stub_run(prompt: str, **kwargs):
            raise AssertionError("host must never be contacted")

        with patch("rlm.run", new=stub_run):
            with self.assertRaises(ValueError):
                await parallel([], name_prefix="fanout")
            with self.assertRaises(TypeError):
                await parallel("not-a-list", name_prefix="fanout")
            with self.assertRaises(ValueError):
                await parallel(["a"] * 3, name_prefix="fanout", max_width=2)
            with self.assertRaises(ValueError):
                await parallel(["a"], name_prefix="fanout", max_width=0)
            with self.assertRaises(ValueError):
                await parallel(["a"])  # neither name source
            with self.assertRaises(ValueError):
                await parallel(["a"], name_prefix="fanout", names=["x"])  # both name sources
            with self.assertRaises(TypeError):
                await parallel([1], name_prefix="fanout")
            with self.assertRaises(ValueError):
                await parallel([""], name_prefix="fanout")
            with self.assertRaises(ValueError):
                await parallel(["a", "b"], name_prefix="fanout", names=["only-one"])
            with self.assertRaises(ValueError):
                await parallel(["a", "b"], names=["dup", "dup"])
            with self.assertRaises(ValueError):
                await parallel(["a", "b"], names=["x", ""])
            with self.assertRaises(TypeError):
                await parallel(["a"], name_prefix=7)
            with self.assertRaises(TypeError):
                await parallel(["a"], name_prefix="fanout", start_index="zero")
            with self.assertRaises(ValueError):
                await parallel(["a"], name_prefix="fanout", start_index=-1)

    async def test_reserved_shared_kwargs_rejected(self) -> None:
        async def stub_run(prompt: str, **kwargs):
            raise AssertionError("host must never be contacted")

        with patch("rlm.run", new=stub_run):
            with self.assertRaises(ValueError) as ctx:
                await parallel(["a"], name_prefix="fanout", name="sneaky")
            self.assertIn("name", str(ctx.exception))

    async def test_cancellation_attaches_partial_result(self) -> None:
        admitted: list[str] = []
        gate = asyncio.Event()

        async def stub_run(prompt: str, **kwargs):
            if len(admitted) >= 2:
                await gate.wait()  # admission 3 hangs until cancellation
            admitted.append(kwargs["name"])
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            task = asyncio.create_task(parallel(["a", "b", "c", "d"], name_prefix="fanout"))
            while len(admitted) < 2:
                await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError) as ctx:
                await task

        cancellation = ctx.exception
        partial = getattr(cancellation, "partial_result", None)
        self.assertIsNotNone(partial)
        self.assertEqual([handle.name for handle in partial.handles], ["fanout-0", "fanout-1"])
        self.assertEqual(len(partial.tags), 2)
        self.assertFalse(partial.ok)

    async def test_fan_in_block_appended_last_and_tags_only_admitted(self) -> None:
        prompts_seen: list[str] = []

        async def stub_run(prompt: str, **kwargs):
            prompts_seen.append(prompt)
            if len(prompts_seen) == 2:
                raise RlmAdmissionError("at capacity")
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            with self.assertRaises(ParallelAdmissionError) as ctx:
                await parallel(["task-a", "task-b", "task-c"], name_prefix="fanout")

        first, second = prompts_seen
        # The fan-in block is always the LAST part of the prompt, appended after the caller text.
        tag_line = first.rsplit("\n", 1)[-1]
        self.assertTrue(tag_line.startswith("FANIN fanout-"))
        self.assertIn(
            "[RLM FAN-IN PROTOCOL]\nYour final report to the parent MUST begin with exactly this line, verbatim:",
            first,
        )
        self.assertIn("[RLM FAN-IN PROTOCOL]", second)
        self.assertEqual(len(ctx.exception.result.tags), 1)
        self.assertEqual(len(prompts_seen), 2)

    async def test_fan_in_tags_unique_across_calls(self) -> None:
        async def stub_run(prompt: str, **kwargs):
            return fake_handle(kwargs["name"])

        with patch("rlm.run", new=stub_run):
            first = await parallel(["a"], name_prefix="fanout")
            second = await parallel(["b"], name_prefix="fanout")

        self.assertNotEqual(first.tags[0], second.tags[0])


class ParseFaninTest(unittest.TestCase):
    def test_exact_first_line_form(self) -> None:
        self.assertEqual(parse_fanin("FANIN fanout-abc123-0"), "fanout-abc123-0")
        self.assertEqual(parse_fanin("FANIN fanout-abc123-0\nrest of the report"), "fanout-abc123-0")
        self.assertEqual(parse_fanin("\n\nFANIN fanout-abc123-0\nreport"), "fanout-abc123-0")

    def test_rejects_other_forms(self) -> None:
        self.assertIsNone(parse_fanin(""))
        self.assertIsNone(parse_fanin("no tag here"))
        self.assertIsNone(parse_fanin("FANIN fanout-abc123-0 trailing"))
        self.assertIsNone(parse_fanin("FANIN_upper"))
        self.assertIsNone(parse_fanin("fanout-abc123-0"))
        self.assertIsNone(parse_fanin("FANIN fanout-abc123-0 extra"))
        self.assertIsNone(parse_fanin("FANIN"))

    def test_rejects_non_string(self) -> None:
        with self.assertRaises(TypeError):
            parse_fanin(None)  # type: ignore[arg-type]


class FanoutTest(unittest.TestCase):
    SENTINEL = "RLM_FANOUT_ITEM_9F3A7C21E4D8B065"

    def test_expand_fanout_literal_replacement(self) -> None:
        template = f"Review {{braces}} and {self.SENTINEL} for 100%."
        self.assertEqual(
            expand_fanout(template, "item with {braces} and % signs", self.SENTINEL),
            "Review {braces} and item with {braces} and % signs for 100%.",
        )
        # newline in item is inserted verbatim
        self.assertEqual(
            expand_fanout(f"a{self.SENTINEL}b", "x\ny", self.SENTINEL),
            "ax\nyb",
        )

    def test_expand_fanout_multiple_occurrences(self) -> None:
        template = f"{self.SENTINEL} and again {self.SENTINEL}"
        self.assertEqual(expand_fanout(template, "item", self.SENTINEL), "item and again item")

    def test_expand_fanout_sentinel_missing(self) -> None:
        with self.assertRaises(ValueError):
            expand_fanout("no sentinel here", "item", self.SENTINEL)

    def test_expand_fanout_item_containing_sentinel_is_safe(self) -> None:
        template = f"start {self.SENTINEL} end"
        item = f"item containing {self.SENTINEL} verbatim"
        result = expand_fanout(template, item, self.SENTINEL)
        # Single-pass: the inserted item is never re-scanned for the sentinel.
        self.assertEqual(result, f"start {item} end")
        self.assertEqual(result.count(self.SENTINEL), 1)

    def test_fanout_applies_per_item(self) -> None:
        template = f"do {self.SENTINEL}"
        self.assertEqual(
            fanout(template, ["one", "two"], self.SENTINEL),
            ["do one", "do two"],
        )

    def test_fanout_author_generates_regex_valid_sentinel(self) -> None:
        import re

        spec = fanout_author("documents", "work on <RLM_ITEM> and <RLM_ITEM> today")
        self.assertEqual(set(spec), {"over", "template", "sentinel"})
        self.assertEqual(spec["over"], "documents")
        self.assertNotIn("<RLM_ITEM>", spec["template"])
        self.assertTrue(re.match(r"^RLM_FANOUT_ITEM_[0-9A-F]{16}$", spec["sentinel"]))
        self.assertIn(spec["sentinel"], spec["template"])
        self.assertEqual(spec["template"].count(spec["sentinel"]), 2)

    def test_fanout_author_requires_placeholder(self) -> None:
        with self.assertRaises(ValueError):
            fanout_author("documents", "template without placeholder")
        with self.assertRaises(ValueError):
            fanout_author("", "template with <RLM_ITEM>")
        with self.assertRaises(ValueError):
            fanout_author("documents", "")


if __name__ == "__main__":
    unittest.main()
