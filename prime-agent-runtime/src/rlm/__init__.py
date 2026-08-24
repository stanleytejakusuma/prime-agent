"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import asyncio
import re
import secrets
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover - depends on ipykernel version
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available in kernels
    get_ipython = None  # type: ignore[assignment]

HOST_COMM_TARGET = "host.request"


@dataclass(frozen=True)
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str
    isolation: str | None = None
    worktree_path: str | None = None
    worktree_branch: str | None = None
    preservation_ref: str | None = None
    worktree_status: str | None = None


class RlmAdmissionError(RuntimeError):
    """The host completed an rlm.run admission request with a deterministic rejection."""


class RlmAdmissionTransportError(RuntimeError):
    """The host never completed an rlm.run admission request (transport failure)."""


@dataclass(frozen=True)
class ParallelResult:
    """Outcome of an rlm.parallel() admission pass (total success or partial failure)."""

    handles: list["RLMSpawnHandle"]
    tags: list[str]
    failed_index: int | None
    failed_name: str | None
    error: BaseException | None
    failed_uncertain: bool
    name_plan: list[str]

    @property
    def ok(self) -> bool:
        return self.failed_index is None

    @property
    def summary(self) -> str:
        if self.ok:
            return f"COMPLETE: admitted {len(self.handles)}/{len(self.name_plan)} children"
        return (
            f"PARTIAL FAILURE: admitted {len(self.handles)}/{len(self.name_plan)}, "
            f"failed at index {self.failed_index} (name={self.failed_name}, error={self.error})"
        )


class ParallelAdmissionError(Exception):
    """Raised by rlm.parallel() on the first admission failure; exc.result is the partial outcome."""

    def __init__(self, result: ParallelResult) -> None:
        self.result = result
        super().__init__(result.summary)


@dataclass(frozen=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent:
    rlm_child_id: str
    active_session_id: str | None
    session_id: str | None
    session_name: str
    session_dir: Path
    status: str
    isolation: str | None = None
    worktree_path: str | None = None
    worktree_branch: str | None = None
    preservation_ref: str | None = None
    worktree_status: str | None = None


def _install_control_comm_handlers() -> None:
    """Let comm replies arrive on the control channel during an execute_request."""
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    child_id = payload.get("rlm_child_id")
    name = payload.get("name")
    session_dir = payload.get("session_dir")
    model = payload.get("model")
    if not all(isinstance(value, str) and value for value in (child_id, name, session_dir, model)):
        raise RuntimeError("rlm.run returned an invalid spawn handle")

    def _optional_str(key: str) -> str | None:
        value = payload.get(key)
        return value if isinstance(value, str) and value else None

    return RLMSpawnHandle(
        rlm_child_id=child_id,
        name=name,
        session_dir=Path(session_dir),
        model=model,
        isolation=_optional_str("isolation"),
        worktree_path=_optional_str("worktree_path"),
        worktree_branch=_optional_str("worktree_branch"),
        preservation_ref=_optional_str("preservation_ref"),
        worktree_status=_optional_str("worktree_status"),
    )


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send a typed request to the Prime Agent host and await its reply.

    This is the kernel side of the generic host bridge: Python skills call
    ``await host_request("<type>", {...})`` and the TypeScript host dispatches
    on the type. Raises RuntimeError when the host reports an error or when no
    handler for the type is registered in this session.
    """
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    _install_control_comm_handlers()

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def _on_msg(msg: dict[str, Any]) -> None:
        content = msg.get("content", {})
        reply = content.get("data", {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict):
            return

        status = reply.get("status")
        if status == "ok":
            def _resolve_result() -> None:
                if not future.done():
                    future.set_result({k: v for k, v in reply.items() if k != "status"})
                    comm.close()

            loop.call_soon_threadsafe(_resolve_result)
            return
        if status == "error":
            message = reply.get("error") or f"host request {request_type} failed"
            def _resolve_error() -> None:
                if not future.done():
                    future.set_exception(RlmAdmissionError(str(message)))
                    comm.close()

            loop.call_soon_threadsafe(_resolve_error)
            return

        unexpected = f"host request {request_type} returned unexpected status: {status!r}"
        def _resolve_unexpected() -> None:
            if not future.done():
                future.set_exception(RlmAdmissionError(unexpected))
                comm.close()

        loop.call_soon_threadsafe(_resolve_unexpected)

    def _resolve_transport_failure(detail: str) -> None:
        if not future.done():
            future.set_exception(
                RlmAdmissionTransportError(f"host request {request_type} transport failure: {detail}")
            )
            comm.close()

    comm.on_msg(_on_msg)
    comm.on_close(lambda _msg: loop.call_soon_threadsafe(
        _resolve_transport_failure, "host closed the comm without replying"
    ))
    # request_type goes last so a payload "type" key cannot reroute the request.
    try:
        comm.open(data={**(payload or {}), "type": request_type})
    except Exception as error:  # pragma: no cover - depends on kernel comm channel state
        loop.call_soon_threadsafe(_resolve_transport_failure, str(error))
    try:
        return await future
    finally:
        if not future.done():
            future.cancel()
        comm.close()


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Spawn a recursive Prime Agent child and return once its task is admitted.

    ``model`` selects a child with an exact ``provider/model`` selector.
    ``thinking`` sets the child reasoning level (e.g. 'off', 'low', 'medium', 'high');
    defaults to the parent level; levels invalid for the resolved model fail the spawn.
    ``isolation="worktree"`` runs the child in a fresh git worktree checkout.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _spawn_handle_from_payload(payload)


_FANIN_TAG_RE = re.compile(r"^FANIN ([a-z0-9-]+)$")
_RESERVED_PARALLEL_KWARGS = frozenset({"name", "name_prefix", "names", "start_index", "max_width"})
_FANOUT_PLACEHOLDER = "<RLM_ITEM>"
_FANOUT_SENTINEL_RE = re.compile(r"^RLM_FANOUT_ITEM_[0-9A-F]{16}$")


def parse_fanin(message: str) -> str | None:
    """Return the fan-in tag when the first non-empty line is exactly ``FANIN <tag>``, else None.

    Strict by design: a message whose first line carries extra text is not attributed.
    """
    if not isinstance(message, str):
        raise TypeError(f"message must be str, got {type(message).__name__}")
    first = next((line.strip() for line in message.splitlines() if line.strip()), None)
    if first is None:
        return None
    match = _FANIN_TAG_RE.match(first)
    return match.group(1) if match else None


def expand_fanout(template: str, item: str, sentinel: str) -> str:
    """Substitute one item into a fan-out template by literal sentinel replacement.

    ``str.replace`` is single-pass: items are inserted verbatim and never re-scanned,
    so an item containing the sentinel string is safe.
    """
    if not isinstance(template, str):
        raise TypeError(f"template must be str, got {type(template).__name__}")
    if not isinstance(item, str):
        raise TypeError(f"item must be str, got {type(item).__name__}")
    if not isinstance(sentinel, str):
        raise TypeError(f"sentinel must be str, got {type(sentinel).__name__}")
    if sentinel not in template:
        raise ValueError(f"fan-out sentinel {sentinel!r} not found in template")
    return template.replace(sentinel, item)


def fanout(template: str, items: list[str], sentinel: str) -> list[str]:
    """Expand a fan-out template once per item (mechanical literal substitution only)."""
    return [expand_fanout(template, item, sentinel) for item in items]


def fanout_author(over: str, template: str) -> dict[str, str]:
    """Author a fan-out spec: replace every ``<RLM_ITEM>`` placeholder with a generated sentinel.

    This is the sanctioned authoring path for the harness ``fan_out`` metadata field.
    """
    if not isinstance(over, str) or not over:
        raise ValueError("fan_out.over must be a non-empty str")
    if not isinstance(template, str) or not template:
        raise ValueError("fan_out.template must be a non-empty str")
    if _FANOUT_PLACEHOLDER not in template:
        raise ValueError(f"fan-out placeholder {_FANOUT_PLACEHOLDER!r} not found in template")
    sentinel = "RLM_FANOUT_ITEM_" + secrets.token_hex(8).upper()
    return {"over": over, "template": template.replace(_FANOUT_PLACEHOLDER, sentinel), "sentinel": sentinel}


async def parallel(
    prompts: list[str],
    *,
    name_prefix: str | None = None,
    names: list[str] | None = None,
    start_index: int = 0,
    max_width: int = 20,
    **shared_kwargs: Any,
) -> ParallelResult:
    """Admit N children sequentially and return (or raise) as soon as admission completes.

    Fail-stop semantics: admission stops at the first error. Total success returns a
    ``ParallelResult``; any admission failure raises ``ParallelAdmissionError`` whose
    ``result`` holds the admitted handles and the failed index. Never blocks for
    child answers. Exactly one of ``name_prefix`` or ``names`` is required.
    """
    if not isinstance(prompts, list):
        raise TypeError(f"prompts must be a list of str, got {type(prompts).__name__}")
    if len(prompts) < 1:
        raise ValueError("prompts must not be empty")
    if not isinstance(max_width, int) or isinstance(max_width, bool):
        raise TypeError(f"max_width must be int, got {type(max_width).__name__}")
    if max_width < 1:
        raise ValueError("max_width must be >= 1")
    if len(prompts) > max_width:
        raise ValueError(
            f"parallel() width guard: {len(prompts)} prompts exceed max_width={max_width}"
        )
    if (name_prefix is None) == (names is None):
        raise ValueError("parallel() requires exactly one of name_prefix or names")
    if not isinstance(start_index, int) or isinstance(start_index, bool):
        raise TypeError(f"start_index must be int, got {type(start_index).__name__}")
    if start_index < 0:
        raise ValueError("start_index must be >= 0")
    for index, prompt in enumerate(prompts):
        if not isinstance(prompt, str):
            raise TypeError(f"prompts[{index}] must be str, got {type(prompt).__name__}")
        if not prompt:
            raise ValueError(f"prompts[{index}] must be a non-empty str")
    if name_prefix is not None:
        if not isinstance(name_prefix, str):
            raise TypeError(f"name_prefix must be str, got {type(name_prefix).__name__}")
        if not name_prefix:
            raise ValueError("name_prefix must be a non-empty str")
    if names is not None:
        if not isinstance(names, list):
            raise TypeError(f"names must be a list of str, got {type(names).__name__}")
        if len(names) != len(prompts):
            raise ValueError(f"names length {len(names)} must equal prompts length {len(prompts)}")
        for index, name in enumerate(names):
            if not isinstance(name, str):
                raise TypeError(f"names[{index}] must be str, got {type(name).__name__}")
            if not name:
                raise ValueError(f"names[{index}] must be a non-empty str")

    name_plan = list(names) if names is not None else [f"{name_prefix}-{start_index + i}" for i in range(len(prompts))]
    duplicates = sorted({name for name in name_plan if name_plan.count(name) > 1})
    if duplicates:
        raise ValueError(f"parallel() name plan has duplicate names: {duplicates}")
    reserved = sorted(_RESERVED_PARALLEL_KWARGS & set(shared_kwargs))
    if reserved:
        raise ValueError(
            f"parallel() reserved kwargs must be passed as explicit parameters, not shared_kwargs: {reserved}"
        )

    nonce = secrets.token_hex(12)
    tags = [f"fanout-{nonce}-{i}" for i in range(len(prompts))]
    handles: list[RLMSpawnHandle] = []
    admitted_tags: list[str] = []

    def partial_result(
        failed_index: int | None,
        failed_name: str | None,
        error: BaseException | None,
        failed_uncertain: bool,
    ) -> ParallelResult:
        return ParallelResult(
            handles=handles,
            tags=admitted_tags,
            failed_index=failed_index,
            failed_name=failed_name,
            error=error,
            failed_uncertain=failed_uncertain,
            name_plan=name_plan,
        )

    try:
        for i, prompt in enumerate(prompts):
            fan_in_block = (
                "\n\n[RLM FAN-IN PROTOCOL]\n"
                "Your final report to the parent MUST begin with exactly this line, verbatim:\n"
                f"FANIN {tags[i]}"
            )
            handles.append(await run(prompt + fan_in_block, name=name_plan[i], **shared_kwargs))
            admitted_tags.append(tags[i])
    except asyncio.CancelledError as cancellation:
        admitted = len(handles)
        failed_index = admitted if admitted < len(name_plan) else None
        failed_name = name_plan[admitted] if admitted < len(name_plan) else None
        cancellation.partial_result = partial_result(failed_index, failed_name, None, False)
        raise
    except Exception as error:
        failed_index = len(handles)
        result = partial_result(
            failed_index,
            name_plan[failed_index],
            error,
            isinstance(error, RlmAdmissionTransportError),
        )
        raise ParallelAdmissionError(result) from error

    return partial_result(None, None, None, False)




def _model_from_payload(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    provider = payload.get("provider")
    model_id = payload.get("id")
    name = payload.get("name")
    selector = payload.get("selector")
    if not all(isinstance(value, str) and value for value in (provider, model_id, name, selector)):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(provider=provider, id=model_id, name=name, selector=selector)


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded list of models backed by active user credentials."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model_from_payload(model) for model in models]


def _subagent_from_payload(payload: Any, operation: str = "rlm.list_subagents") -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    child_id = payload.get("rlm_child_id")
    active_session_id = payload.get("active_session_id")
    session_id = payload.get("session_id")
    session_name = payload.get("session_name")
    session_dir = payload.get("session_dir")
    status = payload.get("status")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError(f"{operation} entry is missing rlm_child_id")
    if active_session_id is not None and not isinstance(active_session_id, str):
        raise RuntimeError(f"{operation} entry has invalid active_session_id")
    if session_id is not None and not isinstance(session_id, str):
        raise RuntimeError(f"{operation} entry has invalid session_id")
    if not isinstance(session_name, str) or not session_name:
        raise RuntimeError(f"{operation} entry is missing session_name")
    if not isinstance(session_dir, str) or not session_dir:
        raise RuntimeError(f"{operation} entry is missing session_dir")
    if status not in {"running", "completed", "error"}:
        raise RuntimeError(f"{operation} entry has invalid status")

    def _optional_str(key: str) -> str | None:
        value = payload.get(key)
        return value if isinstance(value, str) and value else None

    return RLMSubagent(
        rlm_child_id=child_id,
        active_session_id=active_session_id,
        session_id=session_id,
        session_name=session_name,
        session_dir=Path(session_dir),
        status=status,
        isolation=_optional_str("isolation"),
        worktree_path=_optional_str("worktree_path"),
        worktree_branch=_optional_str("worktree_branch"),
        preservation_ref=_optional_str("preservation_ref"),
        worktree_status=_optional_str("worktree_status"),
    )


async def list_subagents() -> list[RLMSubagent]:
    """List direct RLM children retained by the current parent session."""
    payload = await host_request("rlm.list_subagents")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


async def delete_subagent(target: str | RLMSubagent) -> RLMSubagent:
    """Delete one running or retained direct child from the current parent session."""
    if isinstance(target, RLMSubagent):
        selector = target.rlm_child_id
    elif isinstance(target, str):
        selector = target.strip()
        if not selector:
            raise ValueError("target must not be empty")
    else:
        raise TypeError(f"target must be str or RLMSubagent, got {type(target).__name__}")
    payload = await host_request("rlm.delete_subagent", {"target": selector})
    return _subagent_from_payload(payload.get("subagent"), "rlm.delete_subagent")


class _HarnessProxy:
    """Resolve the harness state against the current environment on every access.

    The kernel forkserver preimports rlm in a template process before per-session
    env vars exist; a state bound at import time would freeze that (env-less)
    resolution into every forked kernel. Resolving per access picks up the env
    applied after fork. Resolution must never raise (a failure inside the kernel
    namespace would take down the kernel). When the local store is genuinely
    unconfigured (no session env, e.g. --no-session) reads see an empty view but
    local writes raise instructively instead of vanishing on kernel exit; any
    other resolution failure degrades to a shared in-memory store until local
    resolution starts succeeding.
    """

    _fallback: HarnessState | None = None
    _unpersisted: HarnessState | None = None

    def _resolve(self) -> HarnessState:
        try:
            return get_harness_state()
        except RuntimeError as exc:
            if "Local harness state requires" in str(exc):
                if _HarnessProxy._unpersisted is None:
                    _HarnessProxy._unpersisted = HarnessState(
                        in_memory=True,
                        local_write_error=(
                            f"{exc} This session has no persistent local harness store; "
                            "pass global_=True to persist across sessions."
                        ),
                    )
                return _HarnessProxy._unpersisted
            return self._degraded()
        except Exception:  # pragma: no cover - harness access must never raise
            return self._degraded()

    @staticmethod
    def _degraded() -> HarnessState:
        if _HarnessProxy._fallback is None:
            _HarnessProxy._fallback = HarnessState(in_memory=True)
        return _HarnessProxy._fallback

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve(), name)

    def __repr__(self) -> str:
        return repr(self._resolve())


_harness_state = _HarnessProxy()


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)

    parallel = staticmethod(parallel)
    parse_fanin = staticmethod(parse_fanin)
    expand_fanout = staticmethod(expand_fanout)
    fanout = staticmethod(fanout)
    fanout_author = staticmethod(fanout_author)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSubagent) -> RLMSubagent:
        return await delete_subagent(target)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "HarnessEntry",
    "HarnessScope",
    "HarnessState",
    "McpIntegration",
    "McpToolError",
    "NotEnabled",
    "ParallelAdmissionError",
    "ParallelResult",
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "RefinementEvent",
    "RlmAdmissionError",
    "RlmAdmissionTransportError",
    "delete_subagent",
    "expand_fanout",
    "fanout",
    "fanout_author",
    "find_models",
    "get_harness_state",
    "harness",
    "host_request",
    "list_subagents",
    "parallel",
    "parse_fanin",
    "rlm",
    "run",
]

# Lazily re-export the MCP base class. Kept lazy so `import rlm` never requires
# the optional `mcp` SDK — only integration packages that subclass it do.
_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:  # noqa: D401 - module-level lazy attr hook
    if name in _LAZY_MCP:
        from . import mcp_base

        return getattr(mcp_base, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
