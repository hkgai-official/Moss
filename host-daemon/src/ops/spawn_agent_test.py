"""Tests for spawn_agent.handle dispatcher."""
from __future__ import annotations

from typing import Any

import pytest

from src.ops import spawn_agent
from src.ops.coding_agents import registry
from src.ops.coding_agents.base import (
    AgentStreamEvent,
    AgentTokens,
    CodingAgentRunner,
)


class _MockRunner(CodingAgentRunner):
    def __init__(self, name: str, events_to_yield: list[AgentStreamEvent]) -> None:
        self._name = name
        self._events = events_to_yield
        self.calls: list[dict[str, Any]] = []

    @property
    def provider_name(self) -> str:
        return self._name

    async def preflight(self) -> dict:
        return {"ok": True, "version": "x", "error": None}

    async def spawn_role(self, **kwargs):  # type: ignore[override]
        self.calls.append(kwargs)
        for e in self._events:
            yield e

    async def kill_orphans(self) -> dict:
        return {"provider": self._name, "rc": 1, "stderr_tail": ""}


@pytest.fixture(autouse=True)
def _reset_registry():
    """Snapshot+restore registry around each test (see registry_test.py)."""
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
async def test_dispatch_uses_default_provider(monkeypatch):
    runner = _MockRunner("claude", [
        AgentStreamEvent(
            kind="event",
            raw_event={"type": "system", "session_id": "s1"},
            session_id="s1",
        ),
        AgentStreamEvent(
            kind="result", session_id="s1",
            exit_code=0, elapsed_s=1.0, model="sonnet",
        ),
    ])
    registry.register(runner)
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "claude")

    payload = {
        "role": "planner", "system_prompt": "p", "user_input": "u",
        "add_dirs": [], "cwd": "/tmp", "timeout_s": 10,
        "resume_session_id": None, "output_log_dir": "/tmp/logs",
    }
    responses = await _collect(spawn_agent.handle("rq", payload))

    assert len(runner.calls) == 1
    assert runner.calls[0]["role"] == "planner"

    result = [r for r in responses if r.type == "result"][0]
    assert result.data["provider"] == "claude"
    assert result.data["session_id"] == "s1"
    assert result.data["exit_code"] == 0
    assert result.data["model"] == "sonnet"


@pytest.mark.asyncio
async def test_agent_override_takes_precedence(monkeypatch):
    claude_runner = _MockRunner("claude", [
        AgentStreamEvent(kind="result", exit_code=0, elapsed_s=0.1, model="sonnet"),
    ])
    codex_runner = _MockRunner("codex", [
        AgentStreamEvent(kind="result", exit_code=0, elapsed_s=0.1, model="gpt-5.5"),
    ])
    registry.register(claude_runner)
    registry.register(codex_runner)
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "claude")

    payload = {
        "role": "implementer", "system_prompt": "p", "user_input": "u",
        "add_dirs": [], "cwd": "/tmp", "timeout_s": 10,
        "resume_session_id": None, "output_log_dir": "/tmp/logs",
        "agent_override": "codex",
    }
    responses = await _collect(spawn_agent.handle("rq", payload))

    assert len(codex_runner.calls) == 1
    assert len(claude_runner.calls) == 0
    result = [r for r in responses if r.type == "result"][0]
    assert result.data["provider"] == "codex"
    assert result.data["model"] == "gpt-5.5"


@pytest.mark.asyncio
async def test_unknown_provider_yields_error(monkeypatch):
    registry.register(_MockRunner("claude", []))
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "claude")

    payload = {
        "role": "planner", "system_prompt": "p", "user_input": "u",
        "add_dirs": [], "cwd": "/tmp", "timeout_s": 10,
        "resume_session_id": None, "output_log_dir": "/tmp/logs",
        "agent_override": "nonexistent",
    }
    responses = await _collect(spawn_agent.handle("rq", payload))

    err_resps = [r for r in responses if r.type == "error"]
    assert err_resps, "expected at least one error response"
    assert "unknown provider" in err_resps[0].data["message"]


@pytest.mark.asyncio
async def test_error_event_propagates(monkeypatch):
    runner = _MockRunner("claude", [
        AgentStreamEvent(kind="error", message="timeout occurred"),
    ])
    registry.register(runner)
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "claude")

    payload = {
        "role": "planner", "system_prompt": "p", "user_input": "u",
        "add_dirs": [], "cwd": "/tmp", "timeout_s": 10,
        "resume_session_id": None, "output_log_dir": "/tmp/logs",
    }
    responses = await _collect(spawn_agent.handle("rq", payload))
    err = [r for r in responses if r.type == "error"][0]
    assert "timeout occurred" in err.data["message"]


@pytest.mark.asyncio
async def test_tokens_serialized_in_result(monkeypatch):
    runner = _MockRunner("claude", [
        AgentStreamEvent(
            kind="result",
            session_id="s2",
            tokens=AgentTokens(input=100, output=20, cache_read=50, cache_write=10, reasoning=3),
            cost_usd=0.005,
            exit_code=0, elapsed_s=2.0, model="sonnet",
        ),
    ])
    registry.register(runner)
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "claude")

    payload = {
        "role": "planner", "system_prompt": "p", "user_input": "u",
        "add_dirs": [], "cwd": "/tmp", "timeout_s": 10,
        "resume_session_id": None, "output_log_dir": "/tmp/logs",
    }
    responses = await _collect(spawn_agent.handle("rq", payload))
    result = [r for r in responses if r.type == "result"][0].data
    assert result["tokens"] == {
        "input": 100, "output": 20, "cache_read": 50, "cache_write": 10, "reasoning": 3,
    }
    assert result["cost_usd"] == pytest.approx(0.005)


@pytest.mark.asyncio
async def test_tokens_none_when_runner_reports_none(monkeypatch):
    runner = _MockRunner("claude", [
        AgentStreamEvent(kind="result", session_id="s3", exit_code=0, elapsed_s=1.0, model="sonnet"),
    ])
    registry.register(runner)
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "claude")

    payload = {
        "role": "planner", "system_prompt": "p", "user_input": "u",
        "add_dirs": [], "cwd": "/tmp", "timeout_s": 10,
        "resume_session_id": None, "output_log_dir": "/tmp/logs",
    }
    responses = await _collect(spawn_agent.handle("rq", payload))
    result = [r for r in responses if r.type == "result"][0].data
    assert result["tokens"] is None
