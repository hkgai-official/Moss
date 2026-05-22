"""Unit tests for ClaudeRunner — exercise spawn_role() directly with mocked subprocess.

Companion to the socket-level smoke test at host-daemon/src/ops/spawn_agent_smoke_test.py
(which exercises the full RPC stack against real claude — gated by binary presence).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from src.ops.coding_agents.base import AgentStreamEvent
from src.ops.coding_agents.claude import MOSS_MARKER, ClaudeRunner


@pytest.fixture
def runner():
    return ClaudeRunner()


@pytest.fixture
def tmp_log_dir(tmp_path):
    return str(tmp_path / "logs")


def _mk_fake_proc(stdout_bytes: bytes, returncode: int = 0):
    """Make a fake process whose stdout is a real StreamReader fed with the bytes."""
    reader = asyncio.StreamReader()
    reader.feed_data(stdout_bytes)
    reader.feed_eof()

    class _FakeStdin:
        def write(self, _data: bytes) -> None: pass
        def close(self) -> None: pass

    class _FakeProc:
        stdin = _FakeStdin()
        stdout = reader
        def __init__(self) -> None:
            self.returncode = returncode
        async def wait(self) -> int: return returncode
        def kill(self) -> None: pass

    return _FakeProc()


async def _collect(gen) -> list[AgentStreamEvent]:
    out: list[AgentStreamEvent] = []
    async for ev in gen:
        out.append(ev)
    return out


# ----------------------------------------------------------------------------
# spawn_role: cmd construction (marker prefix is critical for orphan kill)
# ----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_spawn_role_prepends_marker_to_system_prompt(runner, tmp_log_dir, monkeypatch):
    """The MOSS_MARKER sentinel MUST appear in --append-system-prompt arg."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        captured["kwargs"] = kwargs
        return _mk_fake_proc(b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    gen = runner.spawn_role(
        role="planner",
        system_prompt="ORIGINAL_PROMPT_TEXT",
        user_input="hi",
        add_dirs=[],
        cwd="/tmp",
        timeout_s=10,
        resume_session_id=None,
        output_log_dir=tmp_log_dir,
    )
    _ = await _collect(gen)

    argv = captured["argv"]
    idx = argv.index("--append-system-prompt")
    sysprompt_arg = argv[idx + 1]
    assert sysprompt_arg.startswith(MOSS_MARKER), (
        f"system prompt arg must start with marker, got: {sysprompt_arg!r}"
    )
    assert "ORIGINAL_PROMPT_TEXT" in sysprompt_arg


@pytest.mark.asyncio
async def test_spawn_role_passes_model_sonnet(runner, tmp_log_dir, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_proc(b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    gen = runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=tmp_log_dir,
    )
    _ = await _collect(gen)

    argv = captured["argv"]
    idx = argv.index("--model")
    assert argv[idx + 1] == "sonnet"


@pytest.mark.asyncio
async def test_spawn_role_passes_resume_when_given(runner, tmp_log_dir, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_proc(b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    gen = runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id="sess-xyz", output_log_dir=tmp_log_dir,
    )
    _ = await _collect(gen)

    argv = captured["argv"]
    idx = argv.index("--resume")
    assert argv[idx + 1] == "sess-xyz"


# ----------------------------------------------------------------------------
# spawn_role: event parsing + tokens extraction
# ----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_spawn_role_extracts_tokens_from_result_usage(runner, tmp_log_dir, monkeypatch):
    """If claude result event has a `usage` block, populate AgentTokens."""
    fake_events = [
        {"type": "system", "session_id": "sess-1"},
        {"type": "result", "total_cost_usd": 0.0034,
         "usage": {"input_tokens": 100, "output_tokens": 20,
                   "cache_read_input_tokens": 50,
                   "cache_creation_input_tokens": 10}},
    ]
    stdout_bytes = ("\n".join(json.dumps(e) for e in fake_events) + "\n").encode()

    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(stdout_bytes)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="p", user_input="hi",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=tmp_log_dir,
    ))

    result_evs = [e for e in events if e.kind == "result"]
    assert len(result_evs) == 1
    r = result_evs[0]
    assert r.session_id == "sess-1"
    assert r.cost_usd == pytest.approx(0.0034)
    assert r.tokens is not None
    assert r.tokens.input == 100
    assert r.tokens.output == 20
    assert r.tokens.cache_read == 50
    assert r.tokens.cache_write == 10
    assert r.model == "sonnet"


@pytest.mark.asyncio
async def test_spawn_role_handles_missing_usage_block(runner, tmp_log_dir, monkeypatch):
    """If result event has no usage block, tokens=None (graceful fallback)."""
    fake_events = [
        {"type": "system", "session_id": "sess-2"},
        {"type": "result", "total_cost_usd": 0.001},
    ]
    stdout_bytes = ("\n".join(json.dumps(e) for e in fake_events) + "\n").encode()

    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(stdout_bytes)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="p", user_input="hi",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=tmp_log_dir,
    ))
    result_evs = [e for e in events if e.kind == "result"]
    assert len(result_evs) == 1
    assert result_evs[0].tokens is None
    assert result_evs[0].cost_usd == pytest.approx(0.001)


# ----------------------------------------------------------------------------
# kill_orphans + preflight
# ----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_kill_orphans_greps_marker(runner, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args

        class _FakeProc:
            returncode = 1
            async def communicate(self):
                return (b"", b"")
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    result = await runner.kill_orphans()

    assert captured["argv"] == ("pkill", "-TERM", "-f", "MOSS-EVOLUTION-MARKER")
    assert result["provider"] == "claude"
    assert result["rc"] == 1


@pytest.mark.asyncio
async def test_preflight_ok_when_claude_present(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self):
                return (b"2.0.0 (Claude Code)\n", b"")
        return _FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is True
    assert "2.0.0" in pf["version"]
    assert pf["error"] is None


@pytest.mark.asyncio
async def test_preflight_fails_when_claude_missing(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("[Errno 2] No such file or directory: 'claude'")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is False
    assert pf["version"] is None
    assert "not found" in pf["error"]


@pytest.mark.asyncio
async def test_preflight_fails_when_version_nonzero(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 2
            async def communicate(self):
                return (b"", b"oh no")
        return _FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "rc=2" in pf["error"]


# ----------------------------------------------------------------------------
# basic provider_name + ABC compliance
# ----------------------------------------------------------------------------

def test_provider_name(runner):
    assert runner.provider_name == "claude"


def test_is_instance_of_base(runner):
    from src.ops.coding_agents.base import CodingAgentRunner
    assert isinstance(runner, CodingAgentRunner)
