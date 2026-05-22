"""Tests for OpencodeRunner.

Mocked (run by default): argv construction, NDJSON parsing, session/token/cost
extraction, error-event handling, timeout + cleanup, preflight, kill_orphans,
config rendering.

Live test (env-gated): real `opencode run` call. Skipped unless
MOSS_TEST_OPENCODE_LIVE=1. Cost depends on MOSS_OPENCODE_MODEL.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import pytest

from src.ops.coding_agents.base import AgentStreamEvent
from src.ops.coding_agents.opencode import (
    DEFAULT_MODEL,
    MOSS_AGENT_NAME,
    MOSS_MARKER,
    MOSS_TMP_PREFIX,
    OPENCODE_BIN,
    PKILL_MARKER,
    OpencodeRunner,
    _build_opencode_config,
    _parse_opencode_tokens,
    build_opencode_cmd,
)


@pytest.fixture
def runner():
    return OpencodeRunner()


def _mk_fake_proc(stdout_bytes: bytes, returncode: int = 0):
    reader = asyncio.StreamReader()
    reader.feed_data(stdout_bytes)
    reader.feed_eof()

    class _FakeProc:
        stdout = reader

        def __init__(self) -> None:
            self.returncode = returncode

        async def wait(self) -> int:
            return returncode

        def kill(self) -> None:
            pass

    return _FakeProc()


async def _collect(gen) -> list[AgentStreamEvent]:
    out: list[AgentStreamEvent] = []
    async for ev in gen:
        out.append(ev)
    return out


# ----------------------------------------------------------------------------
# constants + provider_name
# ----------------------------------------------------------------------------


def test_provider_name(runner):
    assert runner.provider_name == "opencode"


def test_marker_constants():
    # Same sentinel as claude/codex/deepseek-tui so `pkill -f MOSS-EVOLUTION-MARKER`
    # finds opencode orphans too (spec §2.5 shared marker).
    assert "MOSS" in MOSS_MARKER and "MARKER" in MOSS_MARKER
    assert PKILL_MARKER in MOSS_MARKER


def test_tmp_prefix_unique_to_opencode():
    # Doesn't collide with deepseek-tui's `moss-evo-deepseek-` prefix.
    assert MOSS_TMP_PREFIX.startswith("moss-evo-")
    assert "opencode" in MOSS_TMP_PREFIX


def test_opencode_bin_defaults_to_opencode():
    # OPENCODE_BIN env may override; default in module should be "opencode"
    # (when env unset). The constant captures the import-time value.
    assert isinstance(OPENCODE_BIN, str) and len(OPENCODE_BIN) > 0


# ----------------------------------------------------------------------------
# _build_opencode_config — pure helper
# ----------------------------------------------------------------------------


def test_config_injects_marker_into_agent_prompt():
    cfg = json.loads(_build_opencode_config("ROLE_PROMPT_X"))
    prompt = cfg["agent"][MOSS_AGENT_NAME]["prompt"]
    assert prompt.startswith(MOSS_MARKER)
    assert "ROLE_PROMPT_X" in prompt


def test_config_disables_share_and_autoupdate():
    """OSS defaults: never auto-share, don't side-quest into updates mid-run."""
    cfg = json.loads(_build_opencode_config("p"))
    assert cfg["share"] == "disabled"
    assert cfg["autoupdate"] is False


def test_config_agent_mode_is_primary():
    cfg = json.loads(_build_opencode_config("p"))
    assert cfg["agent"][MOSS_AGENT_NAME]["mode"] == "primary"


def test_config_emits_valid_json():
    # Round-trip via json.loads/json.dumps to verify it's parseable.
    cfg_str = _build_opencode_config('has "quotes" and `backticks` and\nnewlines')
    cfg = json.loads(cfg_str)
    # Newlines + quotes survive
    prompt = cfg["agent"][MOSS_AGENT_NAME]["prompt"]
    assert "quotes" in prompt and "backticks" in prompt and "\n" in prompt


def test_config_includes_schema_pointer():
    """$schema lets opencode validate; helps catch config drift early."""
    cfg = json.loads(_build_opencode_config("p"))
    assert "opencode.ai/config.json" in cfg["$schema"]


# ----------------------------------------------------------------------------
# _parse_opencode_tokens — pure helper
# ----------------------------------------------------------------------------


def test_parse_tokens_full():
    t = _parse_opencode_tokens({
        "total": 200, "input": 150, "output": 30, "reasoning": 10,
        "cache": {"read": 100, "write": 50},
    })
    assert t is not None
    assert t.input == 150 and t.output == 30 and t.reasoning == 10
    assert t.cache_read == 100 and t.cache_write == 50


def test_parse_tokens_missing_cache_block():
    t = _parse_opencode_tokens({"input": 10, "output": 5})
    assert t is not None
    assert t.input == 10 and t.output == 5
    assert t.cache_read == 0 and t.cache_write == 0
    assert t.reasoning == 0


def test_parse_tokens_cache_is_null():
    """Defensive: opencode may emit cache: null on cold sessions."""
    t = _parse_opencode_tokens({"input": 10, "output": 5, "cache": None})
    assert t is not None
    assert t.cache_read == 0 and t.cache_write == 0


def test_parse_tokens_none_or_not_dict():
    assert _parse_opencode_tokens(None) is None
    assert _parse_opencode_tokens("not a dict") is None  # type: ignore[arg-type]


# ----------------------------------------------------------------------------
# build_opencode_cmd — argv construction
# ----------------------------------------------------------------------------


def test_build_cmd_includes_marker_in_title():
    """The orphan-kill marker must appear in argv (pkill -f target)."""
    cmd = build_opencode_cmd(
        role="planner", user_input="u", cwd="/w",
        model="anthropic/claude-sonnet-4-6", variant="",
        resume_session_id=None,
    )
    assert "--title" in cmd
    title = cmd[cmd.index("--title") + 1]
    assert MOSS_MARKER in title
    assert "role=planner" in title


def test_build_cmd_passes_format_json():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="",
        resume_session_id=None,
    )
    assert "--format" in cmd
    assert cmd[cmd.index("--format") + 1] == "json"


def test_build_cmd_dangerously_skip_permissions():
    """Containers are the sandbox; we don't want opencode's per-action prompts."""
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="",
        resume_session_id=None,
    )
    assert "--dangerously-skip-permissions" in cmd


def test_build_cmd_pure_disables_external_plugins():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="",
        resume_session_id=None,
    )
    assert "--pure" in cmd


def test_build_cmd_passes_dir_as_cwd():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/the/repo", model="m", variant="",
        resume_session_id=None,
    )
    idx = cmd.index("--dir")
    assert cmd[idx + 1] == "/the/repo"


def test_build_cmd_selects_moss_agent():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="",
        resume_session_id=None,
    )
    idx = cmd.index("--agent")
    assert cmd[idx + 1] == MOSS_AGENT_NAME


def test_build_cmd_passes_model():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w",
        model="anthropic/claude-sonnet-4-6", variant="",
        resume_session_id=None,
    )
    idx = cmd.index("--model")
    assert cmd[idx + 1] == "anthropic/claude-sonnet-4-6"


def test_build_cmd_omits_variant_when_empty():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="",
        resume_session_id=None,
    )
    assert "--variant" not in cmd


def test_build_cmd_includes_variant_when_set():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="high",
        resume_session_id=None,
    )
    assert "--variant" in cmd
    assert cmd[cmd.index("--variant") + 1] == "high"


def test_build_cmd_resume_session_uses_session_flag():
    cmd = build_opencode_cmd(
        role="r", user_input="u", cwd="/w", model="m", variant="",
        resume_session_id="ses_abc123",
    )
    assert "--session" in cmd
    assert cmd[cmd.index("--session") + 1] == "ses_abc123"


def test_build_cmd_user_input_is_last_after_terminator():
    """`--` terminator + user prompt as last positional, so a prompt
    starting with `-` doesn't get misparsed as a flag."""
    cmd = build_opencode_cmd(
        role="r", user_input="--looks-like-a-flag", cwd="/w", model="m",
        variant="", resume_session_id=None,
    )
    assert cmd[-2] == "--"
    assert cmd[-1] == "--looks-like-a-flag"


# ----------------------------------------------------------------------------
# spawn_role behavior (mocked subprocess)
# ----------------------------------------------------------------------------


@pytest.fixture
def log_dir(tmp_path):
    return str(tmp_path / "logs")


def _ndjson(events: list[dict]) -> bytes:
    return ("\n".join(json.dumps(e) for e in events) + "\n").encode("utf-8")


def _good_stream(session_id: str = "ses_abc") -> bytes:
    return _ndjson([
        {"type": "step_start", "timestamp": 1, "sessionID": session_id},
        {"type": "text", "timestamp": 2, "sessionID": session_id,
         "part": {"text": "Hello "}},
        {"type": "tool_use", "timestamp": 3, "sessionID": session_id,
         "part": {"tool": "read", "callID": "call_1",
                  "state": {"status": "completed", "input": {}, "output": "..."}}},
        {"type": "step_finish", "timestamp": 4, "sessionID": session_id,
         "part": {
             "reason": "stop",
             "tokens": {
                 "total": 200, "input": 150, "output": 30, "reasoning": 5,
                 "cache": {"read": 100, "write": 25},
             },
             "cost": 0.0023,
             "snapshot": "abcd1234",
         }},
    ])


@pytest.mark.asyncio
async def test_spawn_uses_devnull_stdin(runner, log_dir, monkeypatch):
    """Defensive: subprocess stdin DEVNULL so opencode can't hang waiting on input."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _mk_fake_proc(_good_stream())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    assert captured["kwargs"]["stdin"] is asyncio.subprocess.DEVNULL


@pytest.mark.asyncio
async def test_spawn_writes_per_spawn_config_file(runner, log_dir, monkeypatch):
    """OPENCODE_CONFIG env points at a mktemp file under MOSS_TMP_PREFIX,
    and that file contains the role's system prompt under the MOSS agent."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        env = kwargs["env"]
        cfg_path = env["OPENCODE_CONFIG"]
        captured["cfg_path"] = cfg_path
        captured["cfg_content"] = Path(cfg_path).read_text()
        return _mk_fake_proc(_good_stream())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="THE_PROMPT_BODY", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))

    assert MOSS_TMP_PREFIX in captured["cfg_path"]
    cfg = json.loads(captured["cfg_content"])
    assert cfg["agent"][MOSS_AGENT_NAME]["prompt"].startswith(MOSS_MARKER)
    assert "THE_PROMPT_BODY" in cfg["agent"][MOSS_AGENT_NAME]["prompt"]


@pytest.mark.asyncio
async def test_spawn_sets_skill_disable_env_vars(runner, log_dir, monkeypatch):
    """Belt-and-suspenders: deterministic role prompts require ignoring
    user's interactive opencode skill auto-loads."""
    for k in ("OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"):
        monkeypatch.delenv(k, raising=False)

    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["env"] = kwargs["env"]
        return _mk_fake_proc(_good_stream())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    _ = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    assert captured["env"]["OPENCODE_DISABLE_EXTERNAL_SKILLS"] == "1"
    assert captured["env"]["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] == "1"


@pytest.mark.asyncio
async def test_spawn_skill_disable_does_not_clobber_user_overrides(runner, log_dir, monkeypatch):
    """If the user explicitly sets these to 0, we don't stomp on them."""
    monkeypatch.setenv("OPENCODE_DISABLE_EXTERNAL_SKILLS", "0")

    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["env"] = kwargs["env"]
        return _mk_fake_proc(_good_stream())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    _ = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    assert captured["env"]["OPENCODE_DISABLE_EXTERNAL_SKILLS"] == "0"


@pytest.mark.asyncio
async def test_spawn_extracts_session_id_and_tokens_and_cost(runner, log_dir, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(_good_stream(session_id="ses_xyz789"))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))

    results = [e for e in events if e.kind == "result"]
    assert len(results) == 1
    r = results[0]
    assert r.session_id == "ses_xyz789"
    assert r.tokens is not None
    assert r.tokens.input == 150 and r.tokens.output == 30
    assert r.tokens.cache_read == 100 and r.tokens.cache_write == 25
    assert r.tokens.reasoning == 5
    assert r.cost_usd == pytest.approx(0.0023)
    assert r.model == DEFAULT_MODEL
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_spawn_yields_raw_events_in_order(runner, log_dir, monkeypatch):
    """Consumers (TS extract-md, trace recorders) expect raw opencode envelopes
    in stream order. The runner forwards them opaque."""
    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(_good_stream())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    raw_kinds = [e.raw_event.get("type") for e in events if e.kind == "event"]
    assert raw_kinds == ["step_start", "text", "tool_use", "step_finish"]


@pytest.mark.asyncio
async def test_spawn_handles_error_envelope(runner, log_dir, monkeypatch):
    """An opencode {"type":"error",...} event aborts with kind='error'."""
    stream = _ndjson([
        {"type": "step_start", "timestamp": 1, "sessionID": "ses_e"},
        {"type": "error", "timestamp": 2, "sessionID": "ses_e",
         "error": {"name": "UnknownError",
                   "data": {"message": "rate limit exceeded"}}},
        # Anything after the error envelope shouldn't matter for the result.
        {"type": "step_finish", "timestamp": 3, "sessionID": "ses_e",
         "part": {"reason": "stop", "tokens": {"input": 1}, "cost": 0.0}},
    ])

    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(stream)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))

    errs = [e for e in events if e.kind == "error"]
    assert len(errs) == 1
    assert "rate limit" in errs[0].message
    assert not [e for e in events if e.kind == "result"]


@pytest.mark.asyncio
async def test_spawn_skips_stray_non_json_lines(runner, log_dir, monkeypatch):
    """opencode logs go to stderr; if anything stray shows up on stdout
    (truncated line, ANSI noise), it's skipped without aborting."""
    stream = (
        b"this is not json\n"
        + _ndjson([
            {"type": "step_finish", "timestamp": 1, "sessionID": "ses_y",
             "part": {"reason": "stop", "tokens": {"input": 10},
                      "cost": 0.0001}},
        ])
    )

    async def fake_exec(*args, **kwargs):
        return _mk_fake_proc(stream)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    results = [e for e in events if e.kind == "result"]
    assert len(results) == 1
    assert results[0].session_id == "ses_y"


@pytest.mark.asyncio
async def test_spawn_resume_passes_session_flag(runner, log_dir, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_proc(_good_stream())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    _ = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id="ses_resume_me", output_log_dir=log_dir,
    ))
    argv = list(captured["argv"])
    assert "--session" in argv
    assert argv[argv.index("--session") + 1] == "ses_resume_me"


@pytest.mark.asyncio
async def test_spawn_timeout_kills_process_and_cleans_tmp(runner, log_dir, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["cfg_path"] = kwargs["env"]["OPENCODE_CONFIG"]

        class _HangProc:
            stdout = asyncio.StreamReader()  # never feeds anything

            def __init__(self):
                self.returncode = None

            async def wait(self):
                return -9

            def kill(self):
                pass

        return _HangProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=0.1,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    err = [e for e in events if e.kind == "error"]
    assert len(err) >= 1
    assert "timeout" in err[0].message.lower()
    # tmp dir is cleaned even on timeout
    assert not Path(captured["cfg_path"]).parent.exists()


@pytest.mark.asyncio
async def test_spawn_cleans_tmp_on_spawn_failure(runner, log_dir, monkeypatch, tmp_path):
    """When create_subprocess_exec raises (e.g., binary missing), tmp dir
    is still cleaned by the outer finally."""
    captured: dict[str, Any] = {}

    real_mkdtemp = tempfile.mkdtemp

    def spy_mkdtemp(*a, **kw):
        d = real_mkdtemp(*a, **kw)
        captured["tmp_dir"] = d
        return d

    monkeypatch.setattr(tempfile, "mkdtemp", spy_mkdtemp)

    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("opencode not found")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    events = await _collect(runner.spawn_role(
        role="r", system_prompt="p", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=10,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    err = [e for e in events if e.kind == "error"]
    assert len(err) >= 1
    assert "opencode" in err[0].message
    assert not Path(captured["tmp_dir"]).exists()
    assert (Path(log_dir) / "r.stderr.log").exists()


@pytest.mark.asyncio
async def test_spawn_cleans_tmp_on_cancellation(runner, log_dir, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["cfg_path"] = kwargs["env"]["OPENCODE_CONFIG"]

        class _SlowProc:
            stdout = asyncio.StreamReader()

            def __init__(self):
                self.returncode = None

            async def wait(self):
                return -9

            def kill(self):
                pass

        return _SlowProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    async def driver():
        async for _ in runner.spawn_role(
            role="r", system_prompt="p", user_input="u",
            add_dirs=[], cwd="/tmp", timeout_s=60,
            resume_session_id=None, output_log_dir=log_dir,
        ):
            pass

    task = asyncio.create_task(driver())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not Path(captured["cfg_path"]).parent.exists()


# ----------------------------------------------------------------------------
# kill_orphans
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kill_orphans_greps_shared_marker(runner, monkeypatch):
    """opencode shares MOSS-EVOLUTION-MARKER with claude/codex/deepseek-tui."""
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
    assert captured["argv"] == ("pkill", "-TERM", "-f", PKILL_MARKER)
    assert result["provider"] == "opencode"
    assert result["rc"] == 1


# ----------------------------------------------------------------------------
# preflight
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preflight_ok(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self):
                return (b"1.15.5\n", b"")

        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    pf = await runner.preflight()
    assert pf["ok"] is True
    assert "1.15.5" in pf["version"]
    assert pf["error"] is None


@pytest.mark.asyncio
async def test_preflight_fails_when_binary_missing(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("[Errno 2] No such file or directory: 'opencode'")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "not found" in pf["error"]
    assert "OPENCODE_BIN" in pf["error"] or "opencode.ai" in pf["error"]


@pytest.mark.asyncio
async def test_preflight_fails_when_version_nonzero(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 2
            async def communicate(self):
                return (b"", b"some weird error")

        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "rc=2" in pf["error"]


@pytest.mark.asyncio
async def test_preflight_times_out(runner, monkeypatch):
    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self):
                await asyncio.sleep(60)
                return (b"", b"")

        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "timed out" in pf["error"]


# ----------------------------------------------------------------------------
# Live integration test (env-gated)
# ----------------------------------------------------------------------------


@pytest.mark.skipif(
    os.environ.get("MOSS_TEST_OPENCODE_LIVE") != "1",
    reason="MOSS_TEST_OPENCODE_LIVE=1 required (real network call; cost depends on MOSS_OPENCODE_MODEL)",
)
@pytest.mark.asyncio
async def test_live_minimal_spawn(tmp_path):
    """Real `opencode run` call with a tiny prompt.

    Verifies: session_id captured, tokens.input > 0, exit_code == 0.
    Cost depends on MOSS_OPENCODE_MODEL. Authenticate first via
    `opencode auth login` or by exporting the relevant provider env var
    (ANTHROPIC_API_KEY for the default model).
    """
    runner = OpencodeRunner()
    events: list[AgentStreamEvent] = []
    async for ev in runner.spawn_role(
        role="test_role",
        system_prompt="Reply with the exact 8-char token LIVE-OK1 and nothing else.",
        user_input="Go.",
        add_dirs=[],
        cwd=str(tmp_path),
        timeout_s=120,
        resume_session_id=None,
        output_log_dir=str(tmp_path),
    ):
        events.append(ev)

    err_evs = [e for e in events if e.kind == "error"]
    assert not err_evs, f"unexpected errors: {[e.message for e in err_evs]}"
    results = [e for e in events if e.kind == "result"]
    assert len(results) == 1
    r = results[0]
    assert r.exit_code == 0, f"expected exit 0, got {r.exit_code}"
    assert r.session_id, "session_id should be non-empty"
    assert r.tokens is not None, "tokens should be reported"
    assert r.tokens.input > 0, "should consume input tokens"
    assert r.tokens.output > 0, "should produce output tokens"
    assert r.model, "model should be reported"
