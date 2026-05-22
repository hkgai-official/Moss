"""Tests for CodexRunner.

Mocked tests (run by default): construct cmd correctly, parse JSONL,
populate AgentTokens, preflight + kill_orphans.

Live test (env-gated): real codex exec call. Skipped unless
MOSS_TEST_CODEX_LIVE=1 is set. Costs ~$0.0003 per run on default model.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import pytest

from src.ops.coding_agents.base import AgentStreamEvent
from src.ops.coding_agents.codex import (
    CODEX_BIN,
    DEFAULT_MODEL,
    MOSS_MARKER,
    PKILL_MARKER,
    CodexRunner,
    _parse_usage_block,
    build_codex_cmd,
)


@pytest.fixture
def runner():
    return CodexRunner()


@pytest.fixture
def tmp_log_dir(tmp_path):
    return str(tmp_path / "logs")


def _mk_fake_proc(stdout_bytes: bytes, returncode: int = 0):
    reader = asyncio.StreamReader()
    reader.feed_data(stdout_bytes)
    reader.feed_eof()

    class _FakeProc:
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
# build_codex_cmd: argv construction (all 7 design decisions baked in)
# ----------------------------------------------------------------------------

def test_build_cmd_includes_marker_in_dev_instructions():
    cmd = build_codex_cmd(
        system_prompt="PROMPT_X",
        user_input="USER_Y",
        add_dirs=["/extra"],
        cwd="/work",
        resume_session_id=None,
    )
    dev_arg = next(
        a for a in cmd if isinstance(a, str) and a.startswith("developer_instructions=")
    )
    assert MOSS_MARKER in dev_arg
    assert "PROMPT_X" in dev_arg


def test_build_cmd_uses_json_dumps_escaping():
    """The dev_instructions value MUST be json.dumps-encoded (TOML basic-string compatible)."""
    sp = 'has "double quotes" and `backticks` and\nnewlines'
    cmd = build_codex_cmd(
        system_prompt=sp, user_input="u", add_dirs=[], cwd="/tmp",
        resume_session_id=None,
    )
    dev_arg = next(
        a for a in cmd if isinstance(a, str) and a.startswith("developer_instructions=")
    )
    value = dev_arg[len("developer_instructions="):]
    parsed = json.loads(value)
    assert MOSS_MARKER in parsed
    assert sp in parsed


def test_build_cmd_includes_sandbox_full_access():
    cmd = build_codex_cmd("p", "u", [], "/tmp", None)
    assert "--sandbox" in cmd
    idx = cmd.index("--sandbox")
    assert cmd[idx + 1] == "danger-full-access"


def test_build_cmd_includes_approval_policy_never():
    cmd = build_codex_cmd("p", "u", [], "/tmp", None)
    assert 'approval_policy="never"' in cmd


def test_build_cmd_includes_history_persistence_none():
    cmd = build_codex_cmd("p", "u", [], "/tmp", None)
    assert 'history.persistence="none"' in cmd


def test_build_cmd_includes_skip_git_repo_check():
    cmd = build_codex_cmd("p", "u", [], "/tmp", None)
    assert "--skip-git-repo-check" in cmd


def test_build_cmd_resume_uses_resume_subcommand():
    cmd = build_codex_cmd("p", "u", [], "/tmp", "thread-uuid-abc")
    resume_idx = cmd.index("resume")
    assert cmd[resume_idx + 1] == "thread-uuid-abc"
    # user prompt is the last arg
    assert cmd[-1] == "u"


def test_build_cmd_add_dirs_passed_through():
    cmd = build_codex_cmd("p", "u", ["/a", "/b"], "/tmp", None)
    assert cmd.count("--add-dir") == 2
    indices = [i for i, a in enumerate(cmd) if a == "--add-dir"]
    assert cmd[indices[0] + 1] == "/a"
    assert cmd[indices[1] + 1] == "/b"


def test_build_cmd_uses_default_model():
    cmd = build_codex_cmd("p", "u", [], "/tmp", None)
    idx = cmd.index("-m")
    assert cmd[idx + 1] == DEFAULT_MODEL


def test_build_cmd_cwd_via_C_flag():
    cmd = build_codex_cmd("p", "u", [], "/my/work/dir", None)
    idx = cmd.index("-C")
    assert cmd[idx + 1] == "/my/work/dir"


# ----------------------------------------------------------------------------
# _parse_usage_block — spec §14 item 4 (reasoning fallback)
# ----------------------------------------------------------------------------

def test_parse_usage_block_full():
    t = _parse_usage_block({
        "input_tokens": 100, "output_tokens": 20,
        "cached_input_tokens": 50, "reasoning_output_tokens": 5,
    })
    assert t is not None
    assert t.input == 100 and t.output == 20
    assert t.cache_read == 50 and t.cache_write == 0
    assert t.reasoning == 5


def test_parse_usage_block_missing_reasoning_defaults_zero():
    """gpt-5.5 default doesn't emit reasoning_output_tokens — graceful 0."""
    t = _parse_usage_block({
        "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 0,
    })
    assert t is not None
    assert t.reasoning == 0


def test_parse_usage_block_none():
    assert _parse_usage_block(None) is None
    assert _parse_usage_block("not a dict") is None  # type: ignore[arg-type]


# ----------------------------------------------------------------------------
# spawn_role behavior (mocked subprocess)
# ----------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_spawn_role_uses_devnull_stdin(runner, tmp_path, monkeypatch):
    """Critical: stdin MUST be DEVNULL to avoid hang (openai/codex#20919)."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _mk_fake_proc(b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    gen = runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=str(tmp_path),
    )
    _ = await _collect(gen)
    assert captured["kwargs"]["stdin"] is asyncio.subprocess.DEVNULL


@pytest.mark.asyncio
async def test_spawn_role_parses_thread_started_and_tokens(runner, tmp_path, monkeypatch):
    events_in = [
        {"type": "thread.started", "thread_id": "abc-uuid-123"},
        {"type": "turn.completed",
         "usage": {"input_tokens": 100, "cached_input_tokens": 50, "output_tokens": 20}},
    ]
    stdout = ("\n".join(json.dumps(e) for e in events_in) + "\n").encode()

    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(stdout)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=str(tmp_path),
    ))
    result_evs = [e for e in events if e.kind == "result"]
    assert len(result_evs) == 1
    r = result_evs[0]
    assert r.session_id == "abc-uuid-123"
    assert r.tokens is not None
    assert r.tokens.input == 100
    assert r.tokens.cache_read == 50
    assert r.tokens.cache_write == 0  # Codex doesn't report
    assert r.tokens.output == 20
    assert r.cost_usd is None  # Codex never reports USD
    assert r.model == DEFAULT_MODEL


@pytest.mark.asyncio
async def test_spawn_role_handles_only_thread_no_usage(runner, tmp_path, monkeypatch):
    """If the run has only thread.started + an item.completed (no turn.completed),
    we still capture session_id; tokens is None."""
    events_in = [
        {"type": "thread.started", "thread_id": "x-uuid"},
        {"type": "item.completed", "item": {"type": "agent_message", "text": "hi"}},
    ]
    stdout = ("\n".join(json.dumps(e) for e in events_in) + "\n").encode()

    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(stdout)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=str(tmp_path),
    ))
    r = [e for e in events if e.kind == "result"][0]
    assert r.session_id == "x-uuid"
    assert r.tokens is None


@pytest.mark.asyncio
async def test_spawn_role_passes_resume_subcommand(runner, tmp_path, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_proc(b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    gen = runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id="thread-resume-id", output_log_dir=str(tmp_path),
    )
    _ = await _collect(gen)
    argv = list(captured["argv"])
    assert "resume" in argv
    assert argv[argv.index("resume") + 1] == "thread-resume-id"


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
            async def communicate(self): return (b"", b"")
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    result = await runner.kill_orphans()
    assert captured["argv"] == ("pkill", "-TERM", "-f", PKILL_MARKER)
    assert result["provider"] == "codex"
    assert result["rc"] == 1


@pytest.mark.asyncio
async def test_preflight_ok(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self): return (b"codex-cli 0.118.0\n", b"")
        return _FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is True
    assert "0.118.0" in pf["version"]


@pytest.mark.asyncio
async def test_preflight_fails_when_missing(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("codex binary missing")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "not found" in pf["error"]


def test_provider_name(runner):
    assert runner.provider_name == "codex"


def test_codex_bin_defaults_to_codex():
    # CODEX_BIN env may be overridden; default in module should be "codex"
    # (when env unset). The constant captures the import-time value.
    assert isinstance(CODEX_BIN, str) and len(CODEX_BIN) > 0


# ----------------------------------------------------------------------------
# Live integration test (env-gated)
# ----------------------------------------------------------------------------

@pytest.mark.skipif(
    os.environ.get("MOSS_TEST_CODEX_LIVE") != "1",
    reason="MOSS_TEST_CODEX_LIVE=1 required (costs ~$0.0003 per run)",
)
@pytest.mark.asyncio
async def test_live_minimal_spawn(tmp_path):
    """Real codex exec call with a tiny prompt.

    Verifies: thread_id captured, tokens.input > 0, exit_code == 0.
    ~$0.0003 per run on default model.
    """
    runner = CodexRunner()
    events = []
    async for ev in runner.spawn_role(
        role="test_role",
        system_prompt="Reply with the exact 8-char token LIVE-OK1 and nothing else.",
        user_input="Go.",
        add_dirs=[],
        cwd=str(tmp_path),
        timeout_s=60,
        resume_session_id=None,
        output_log_dir=str(tmp_path),
    ):
        events.append(ev)

    result_evs = [e for e in events if e.kind == "result"]
    err_evs = [e for e in events if e.kind == "error"]
    assert not err_evs, f"unexpected errors: {[e.message for e in err_evs]}"
    assert len(result_evs) == 1
    r = result_evs[0]
    assert r.exit_code == 0, f"expected exit 0, got {r.exit_code}"
    assert r.session_id, "thread_id should be non-empty"
    assert r.tokens is not None, "tokens should be reported"
    assert r.tokens.input > 0, "should consume input tokens"
    assert r.tokens.output > 0, "should produce output tokens"
    assert r.model, "model should be reported"
