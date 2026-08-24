from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from rlm.harness import FANOUT_REMOVE, HarnessState

VALID_FAN_OUT = {
    "over": "documents",
    "template": "Review RLM_FANOUT_ITEM_9F3A7C21E4D8B065 for issues.",
    "sentinel": "RLM_FANOUT_ITEM_9F3A7C21E4D8B065",
}


class FanOutHarnessTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.state = HarnessState(Path(self._temp.name) / "harness_state.json")

    def test_fan_out_round_trips_at_metadata_key(self) -> None:
        entry = self.state.create_subagent("Fanout", "Reusable fan-out task", fan_out=VALID_FAN_OUT)
        self.assertEqual(entry.metadata["fan_out"], VALID_FAN_OUT)

        reloaded = HarnessState(Path(self._temp.name) / "harness_state.json")
        persisted = reloaded.get("subagent", entry.id)
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted.metadata["fan_out"], VALID_FAN_OUT)

    def test_fan_out_via_generic_metadata_is_validated_identically(self) -> None:
        entry = self.state.create_subagent(
            "Fanout", "via metadata", metadata={"fan_out": VALID_FAN_OUT, "other": 1}
        )
        self.assertEqual(entry.metadata["fan_out"], VALID_FAN_OUT)
        self.assertEqual(entry.metadata["other"], 1)

    def test_both_fan_out_kwarg_and_metadata_fan_out_is_ambiguous(self) -> None:
        before = len(self.state.list("subagent"))
        with self.assertRaises(ValueError):
            self.state.create_subagent("Fanout", "both", fan_out=VALID_FAN_OUT, metadata={"fan_out": VALID_FAN_OUT})
        self.assertEqual(len(self.state.list("subagent")), before)

    def test_malformed_fan_out_rejected_with_entry_wholly_unchanged(self) -> None:
        entry = self.state.create_subagent("Fanout", "original content", id="stable")
        original_dump = json.dumps(entry.metadata, sort_keys=True)

        malformed = [
            "not a dict",
            [],
            {**VALID_FAN_OUT, "extra": "key"},
            {"over": "", "template": "t", "sentinel": VALID_FAN_OUT["sentinel"]},
            {"over": "o", "template": "", "sentinel": VALID_FAN_OUT["sentinel"]},
            {"over": "o", "template": "t", "sentinel": "NOT_A_VALID_SENTINEL"},
            {"over": "o", "template": "t", "sentinel": VALID_FAN_OUT["sentinel"]},  # sentinel absent from template
        ]
        for bad in malformed:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    self.state.update_subagent("stable", "Fanout", "changed", fan_out=bad)
                with self.assertRaises(ValueError):
                    self.state.update_subagent("stable", "Fanout", "changed", metadata={"fan_out": bad})

        persisted = self.state.get("subagent", "stable")
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted.content, "original content")
        self.assertEqual(json.dumps(persisted.metadata, sort_keys=True), original_dump)

    def test_fanout_remove_deletes_key_and_none_means_unchanged(self) -> None:
        entry = self.state.create_subagent("Fanout", "content", id="stable", fan_out=VALID_FAN_OUT)
        self.assertIn("fan_out", entry.metadata)

        unchanged = self.state.update_subagent("stable", "Fanout", "content")
        self.assertIn("fan_out", unchanged.metadata)

        removed = self.state.update_subagent("stable", "Fanout", "content", fan_out=FANOUT_REMOVE)
        self.assertNotIn("fan_out", removed.metadata)

        # FANOUT_REMOVE is only valid on update, never on create.
        with self.assertRaises(ValueError):
            self.state.create_subagent("Fanout", "remove-on-create", fan_out=FANOUT_REMOVE)

    def test_update_fan_out_merges_with_existing_metadata_keys(self) -> None:
        entry = self.state.create_subagent("Fanout", "content", id="stable", metadata={"notes": "keep me"})
        updated = self.state.update_subagent("stable", "Fanout", "content", fan_out=VALID_FAN_OUT)
        self.assertEqual(updated.metadata["notes"], "keep me")
        self.assertEqual(updated.metadata["fan_out"], VALID_FAN_OUT)

    def test_update_fan_out_with_explicit_metadata_kwarg_merges_both(self) -> None:
        self.state.create_subagent("Fanout", "content", id="stable", metadata={"old": 1})
        updated = self.state.update_subagent(
            "stable", "Fanout", "content", fan_out=VALID_FAN_OUT, metadata={"new": 2}
        )
        self.assertEqual(updated.metadata["new"], 2)
        self.assertNotIn("old", updated.metadata)  # explicit metadata still overwrites
        self.assertEqual(updated.metadata["fan_out"], VALID_FAN_OUT)

    def test_update_nonexistent_entry_raises_without_writing(self) -> None:
        with self.assertRaises(ValueError):
            self.state.update_subagent("missing", "Fanout", "content", fan_out=VALID_FAN_OUT)

    def test_fanout_remove_with_metadata_fan_out_is_ambiguous(self) -> None:
        entry = self.state.create_subagent("Fanout", "content", id="stable", fan_out=VALID_FAN_OUT)
        self.assertIn("fan_out", entry.metadata)
        with self.assertRaises(ValueError):
            self.state.update_subagent(
                "stable", "Fanout", "content", fan_out=FANOUT_REMOVE, metadata={"fan_out": VALID_FAN_OUT}
            )
        # nothing changed by the rejected call
        self.assertIn("fan_out", self.state.get("subagent", "stable").metadata)


if __name__ == "__main__":
    unittest.main()
