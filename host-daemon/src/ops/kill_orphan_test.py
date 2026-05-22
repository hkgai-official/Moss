"""Tests for the generalized kill_orphan that walks the runner registry."""
from __future__ import annotations

import pytest

from src.ops import kill_orphan
from src.ops.coding_agents import registry
from src.ops.coding_agents.base import CodingAgentRunner


class _MockRunner(CodingAgentRunner):
    def __init__(self, name: str, kill_result: dict) -> None:
        self._name = name
        self._kr = kill_result

    @property
    def provider_name(self) -> str:
        return self._name

    async def preflight(self) -> dict:
        return {"ok": True, "version": "x", "error": None}

    async def spawn_role(self, **kwargs):  # type: ignore[override]
        if False:  # async-generator placeholder
            yield

    async def kill_orphans(self) -> dict:
        return self._kr


@pytest.fixture(autouse=True)
def _reset_registry():
    """Snapshot+restore registry around each test (the global has prod runners
    registered by importing the package)."""
    snapshot = dict(registry._RUNNERS)  # type: ignore[attr-defined]
    registry._RUNNERS.clear()  # type: ignore[attr-defined]
    yield
    registry._RUNNERS.clear()  # type: ignore[attr-defined]
    registry._RUNNERS.update(snapshot)  # type: ignore[attr-defined]


async def _collect(gen):
    out = []
    async for r in gen:
        out.append(r)
    return out


@pytest.mark.asyncio
async def test_default_walks_all_registered():
    registry.register(_MockRunner("claude", {"provider": "claude", "rc": 1, "stderr_tail": ""}))
    registry.register(_MockRunner("codex", {"provider": "codex", "rc": 0, "stderr_tail": ""}))

    responses = await _collect(kill_orphan.handle_kill_orphan("rq", {}))
    result = responses[-1]
    assert result.type == "result"
    providers = sorted(r["provider"] for r in result.data["results"])
    assert providers == ["claude", "codex"]


@pytest.mark.asyncio
async def test_payload_providers_filter():
    registry.register(_MockRunner("claude", {"provider": "claude", "rc": 1, "stderr_tail": ""}))
    registry.register(_MockRunner("codex", {"provider": "codex", "rc": 0, "stderr_tail": ""}))

    responses = await _collect(
        kill_orphan.handle_kill_orphan("rq", {"providers": ["claude"]}),
    )
    result = responses[-1]
    providers = [r["provider"] for r in result.data["results"]]
    assert providers == ["claude"]


@pytest.mark.asyncio
async def test_unknown_provider_in_payload_yields_error_entry():
    registry.register(_MockRunner("claude", {"provider": "claude", "rc": 1, "stderr_tail": ""}))

    responses = await _collect(
        kill_orphan.handle_kill_orphan("rq", {"providers": ["nonexistent"]}),
    )
    result = responses[-1]
    entry = result.data["results"][0]
    assert entry["provider"] == "nonexistent"
    assert entry["rc"] == -1
    assert "unknown" in entry["error"]


@pytest.mark.asyncio
async def test_runner_exception_captured_in_results():
    """If a runner's kill_orphans raises, the error is captured per-provider, not propagated."""
    class _BoomRunner(CodingAgentRunner):
        @property
        def provider_name(self) -> str: return "boom"
        async def preflight(self): return {"ok": True, "version": "x", "error": None}
        async def spawn_role(self, **kw):
            if False: yield
        async def kill_orphans(self):
            raise RuntimeError("pkill not in PATH")

    registry.register(_BoomRunner())

    responses = await _collect(kill_orphan.handle_kill_orphan("rq", {}))
    result = responses[-1]
    entry = result.data["results"][0]
    assert entry["provider"] == "boom"
    assert entry["rc"] == -1
    assert "pkill not in PATH" in entry["error"]
