"""Tests for coding_agents/registry.py."""
from __future__ import annotations

import pytest

from src.ops.coding_agents import registry
from src.ops.coding_agents.base import AgentStreamEvent, CodingAgentRunner


class _FakeRunner(CodingAgentRunner):
    """Minimal fake runner for registry tests."""

    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def provider_name(self) -> str:
        return self._name

    async def preflight(self) -> dict:
        return {"ok": True, "version": "0.0.1-fake", "error": None}

    async def spawn_role(self, **kwargs):  # type: ignore[override]
        yield AgentStreamEvent(kind="result", exit_code=0, elapsed_s=0.0)

    async def kill_orphans(self) -> dict:
        return {"provider": self._name, "rc": 1, "stderr_tail": ""}


@pytest.fixture(autouse=True)
def _reset_registry():
    """Snapshot+restore registry around each test so the package-default
    ClaudeRunner registered by coding_agents/__init__.py is preserved for
    other test modules that depend on it (e.g. spawn_agent_smoke_test.py)."""
    snapshot = dict(registry._RUNNERS)  # type: ignore[attr-defined]
    registry._RUNNERS.clear()  # type: ignore[attr-defined]
    yield
    registry._RUNNERS.clear()  # type: ignore[attr-defined]
    registry._RUNNERS.update(snapshot)  # type: ignore[attr-defined]


def test_register_and_get():
    r = _FakeRunner("foo")
    registry.register(r)
    assert registry.get_runner("foo") is r


def test_register_duplicate_raises():
    registry.register(_FakeRunner("dup"))
    with pytest.raises(ValueError, match="already registered"):
        registry.register(_FakeRunner("dup"))


def test_get_runner_unknown_returns_none():
    assert registry.get_runner("nonexistent") is None


def test_list_providers_sorted():
    registry.register(_FakeRunner("zeta"))
    registry.register(_FakeRunner("alpha"))
    assert registry.list_providers() == ["alpha", "zeta"]


def test_resolve_default_from_env(monkeypatch):
    registry.register(_FakeRunner("claude"))
    registry.register(_FakeRunner("codex"))
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "codex")
    assert registry.resolve_default() == "codex"


def test_resolve_default_unset_uses_claude(monkeypatch):
    registry.register(_FakeRunner("claude"))
    monkeypatch.delenv("MOSS_AGENT_PROVIDER", raising=False)
    assert registry.resolve_default() == "claude"


def test_resolve_default_unknown_raises(monkeypatch):
    registry.register(_FakeRunner("claude"))
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "nonexistent")
    with pytest.raises(ValueError, match="not in registered providers"):
        registry.resolve_default()


def test_resolve_default_case_insensitive(monkeypatch):
    registry.register(_FakeRunner("claude"))
    monkeypatch.setenv("MOSS_AGENT_PROVIDER", "CLAUDE")
    assert registry.resolve_default() == "claude"
