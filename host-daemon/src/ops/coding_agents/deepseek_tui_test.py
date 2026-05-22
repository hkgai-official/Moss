"""Tests for DeepSeekTuiRunner.

Phase 2 (this file's initial content): provider_name, preflight, kill_orphans,
_render_tmp_config (the pure helper). Phase 3 adds spawn_role tests.
Phase 5 adds env-gated live integration test.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any

import pytest

from src.ops.coding_agents.base import AgentStreamEvent
from src.ops.coding_agents.deepseek_tui import (
    DEFAULT_CONFIG_TEMPLATE,
    DEEPSEEK_TUI_BIN,
    MOSS_SYSTEM_MARKER,
    MOSS_TMP_PREFIX,
    PKILL_MARKER,
    DeepSeekTuiRunner,
    _render_tmp_config,
)


@pytest.fixture
def runner():
    return DeepSeekTuiRunner()


# ----------------------------------------------------------------------------
# constants + provider_name
# ----------------------------------------------------------------------------

def test_provider_name(runner):
    assert runner.provider_name == "deepseek-tui"


def test_pkill_marker_in_tmp_prefix():
    # Must be substring of MOSS_TMP_PREFIX so the mktemp dir name contains it
    # → appears in --config argv → pkill -f matches.
    assert PKILL_MARKER in MOSS_TMP_PREFIX or MOSS_TMP_PREFIX.startswith(PKILL_MARKER)


def test_system_marker_constant():
    assert "MOSS" in MOSS_SYSTEM_MARKER and "MARKER" in MOSS_SYSTEM_MARKER


# ----------------------------------------------------------------------------
# preflight
# ----------------------------------------------------------------------------

@pytest.fixture
def good_template(tmp_path):
    """A minimally-valid deepseek-tui config template."""
    p = tmp_path / "config.toml"
    p.write_text('provider = "deepseek"\ndefault_text_model = "deepseek-chat"\n')
    return str(p)


@pytest.mark.asyncio
async def test_preflight_ok(runner, monkeypatch, good_template):
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", good_template)

    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self):
                return (b"deepseek-tui 0.8.14\n", b"")
        return _FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is True
    assert "0.8.14" in pf["version"]
    assert pf["error"] is None


@pytest.mark.asyncio
async def test_preflight_fails_when_binary_missing(runner, monkeypatch, good_template):
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", good_template)

    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("[Errno 2] No such file or directory: 'deepseek-tui'")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "not found" in pf["error"]
    assert "DEEPSEEK_TUI_BIN" in pf["error"] or "install" in pf["error"].lower()


@pytest.mark.asyncio
async def test_preflight_fails_when_version_nonzero(runner, monkeypatch, good_template):
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", good_template)

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
async def test_preflight_fails_when_template_missing(runner, monkeypatch):
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", "/nonexistent/path/config.toml")

    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self):
                return (b"deepseek-tui 0.8.14\n", b"")
        return _FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "not a file" in pf["error"]
    assert "MOSS_DEEPSEEK_CONFIG_TEMPLATE" in pf["error"] or "deepseek-tui login" in pf["error"]


@pytest.mark.asyncio
async def test_preflight_fails_when_template_bad_toml(runner, monkeypatch, tmp_path):
    bad = tmp_path / "bad.toml"
    bad.write_text("this is not toml = =[][[][]]")
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", str(bad))

    async def fake_exec(*args, **kwargs):
        class _FakeProc:
            returncode = 0
            async def communicate(self):
                return (b"deepseek-tui 0.8.14\n", b"")
        return _FakeProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    pf = await runner.preflight()
    assert pf["ok"] is False
    assert "TOML" in pf["error"] or "not valid TOML" in pf["error"]


@pytest.mark.asyncio
async def test_preflight_times_out(runner, monkeypatch, good_template):
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", good_template)

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
# kill_orphans
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

    assert captured["argv"] == ("pkill", "-TERM", "-f", PKILL_MARKER)
    assert result["provider"] == "deepseek-tui"
    assert result["rc"] == 1


# ----------------------------------------------------------------------------
# _render_tmp_config (the pure helper)
# ----------------------------------------------------------------------------

def test_render_injects_instructions(tmp_path):
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        'default_text_model = "deepseek-chat"\n'
        '\n'
        '[providers.deepseek]\n'
        'base_url = "https://api.deepseek.com"\n'
        'model = "deepseek-chat"\n'
    )
    instructions = "/tmp/moss-instructions.md"
    out = _render_tmp_config(str(tpl), instructions)
    import tomllib
    parsed = tomllib.loads(out)
    assert parsed["instructions"] == [instructions]
    assert parsed["provider"] == "deepseek"
    assert parsed["default_text_model"] == "deepseek-chat"
    assert parsed["providers"]["deepseek"]["base_url"] == "https://api.deepseek.com"
    assert parsed["providers"]["deepseek"]["model"] == "deepseek-chat"


def test_render_overrides_existing_instructions(tmp_path):
    """User's prior `instructions = [...]` is fully replaced (spec §14)."""
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        'instructions = ["./AGENTS.md", "/home/user/memory.md"]\n'
    )
    out = _render_tmp_config(str(tpl), "/tmp/moss-only.md")
    import tomllib
    parsed = tomllib.loads(out)
    assert parsed["instructions"] == ["/tmp/moss-only.md"]


def test_render_applies_model_override(tmp_path):
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        'default_text_model = "deepseek-chat"\n'
    )
    out = _render_tmp_config(str(tpl), "/tmp/i.md", model_override="deepseek-reasoner")
    import tomllib
    parsed = tomllib.loads(out)
    assert parsed["default_text_model"] == "deepseek-reasoner"


def test_render_no_model_override_preserves_template(tmp_path):
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        'default_text_model = "deepseek-chat"\n'
    )
    out = _render_tmp_config(str(tpl), "/tmp/i.md", model_override=None)
    import tomllib
    parsed = tomllib.loads(out)
    assert parsed["default_text_model"] == "deepseek-chat"


def test_render_preserves_memory_path_but_forces_enabled_false(tmp_path):
    """Round-1 hardening: even when user template has [memory] enabled=true,
    MOSS forces enabled=false in the per-spawn tmp config to prevent
    cross-spawn memory contamination between MOSS roles. Other [memory]
    keys (path, format, etc) are preserved so user's interactive deepseek
    setup is honored — only the per-spawn override of enabled."""
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        '\n'
        '[memory]\n'
        'path = "/home/user/.deepseek/memory.json"\n'
        'enabled = true\n'
    )
    out = _render_tmp_config(str(tpl), "/tmp/i.md")
    import tomllib
    parsed = tomllib.loads(out)
    # path + other keys: preserved (so deepseek-tui reads same memory file
    # IF it were enabled — but it isn't)
    assert parsed["memory"]["path"] == "/home/user/.deepseek/memory.json"
    # enabled: forced false regardless of template value
    assert parsed["memory"]["enabled"] is False


def test_render_disables_memory_when_block_absent(tmp_path):
    """Round-1 hardening: even when user template has no [memory] block at
    all, MOSS adds one with enabled=false (explicit > default)."""
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        'default_text_model = "deepseek-chat"\n'
    )
    out = _render_tmp_config(str(tpl), "/tmp/i.md")
    import tomllib
    parsed = tomllib.loads(out)
    assert parsed["memory"]["enabled"] is False


def test_render_fails_on_bad_template(tmp_path):
    bad = tmp_path / "bad.toml"
    bad.write_text("not = valid toml = ]][[")
    with pytest.raises(Exception):
        _render_tmp_config(str(bad), "/tmp/i.md")


# ============================================================================
# Round-1 hardening (2026-05-18, post-research)
# ============================================================================


def _capture_argv_and_env(monkeypatch, captured: dict, stdout_json: bytes):
    """Helper: monkeypatch create_subprocess_exec to capture argv + env."""
    import asyncio as _asyncio

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        captured["env"] = kwargs.get("env", {})
        return _mk_fake_completed_proc(stdout_json)

    monkeypatch.setattr(_asyncio, "create_subprocess_exec", fake_exec)


@pytest.mark.asyncio
async def test_spawn_argv_includes_max_subagents_1(runner, runtime_env, monkeypatch):
    """Hardening: cap subagent fan-out to 1 (per #510/#511 contention)."""
    captured: dict[str, Any] = {}
    _capture_argv_and_env(monkeypatch, captured, _good_deepseek_json())

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    argv = list(captured["argv"])
    assert "--max-subagents" in argv
    idx = argv.index("--max-subagents")
    assert argv[idx + 1] == "1"


@pytest.mark.asyncio
async def test_spawn_argv_includes_no_project_config(runner, runtime_env, monkeypatch):
    """Hardening: refuse workspace-level .deepseek/config.toml overlay
    (defensive; orchestrator should fully control config)."""
    captured: dict[str, Any] = {}
    _capture_argv_and_env(monkeypatch, captured, _good_deepseek_json())

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    argv = list(captured["argv"])
    assert "--no-project-config" in argv


@pytest.mark.asyncio
async def test_spawn_env_sets_hardening_vars(runner, runtime_env, monkeypatch):
    """Hardening: subprocess env should have:
      - DEEPSEEK_APPROVAL_POLICY=never (belt-and-suspenders for --yolo)
      - DEEPSEEK_SANDBOX_MODE=workspace-write (portable; doesn't need Landlock)
      - DEEPSEEK_STREAM_IDLE_TIMEOUT_SECS=600 (DS3.2 reasoning pauses; default 300 too tight)
      - DEEPSEEK_STREAM_OPEN_TIMEOUT_SECS=90 (SGLang cold-warm; default 45 too tight)
    On v0.8.14 the timeout vars are silently ignored; on v0.8.32+ they take effect.
    Approval+sandbox vars are honored across recent versions."""
    # Make sure these vars are NOT already in the runner's inherited env
    for k in ("DEEPSEEK_APPROVAL_POLICY", "DEEPSEEK_SANDBOX_MODE",
              "DEEPSEEK_STREAM_IDLE_TIMEOUT_SECS",
              "DEEPSEEK_STREAM_OPEN_TIMEOUT_SECS"):
        monkeypatch.delenv(k, raising=False)

    captured: dict[str, Any] = {}
    _capture_argv_and_env(monkeypatch, captured, _good_deepseek_json())

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    env = captured["env"]
    assert env.get("DEEPSEEK_APPROVAL_POLICY") == "never"
    assert env.get("DEEPSEEK_SANDBOX_MODE") == "workspace-write"
    assert env.get("DEEPSEEK_STREAM_IDLE_TIMEOUT_SECS") == "600"
    assert env.get("DEEPSEEK_STREAM_OPEN_TIMEOUT_SECS") == "90"


@pytest.mark.asyncio
async def test_spawn_env_does_not_clobber_user_overrides(runner, runtime_env, monkeypatch):
    """Hardening must not stomp on user-set env vars — if they explicitly
    set e.g. DEEPSEEK_SANDBOX_MODE=read-only, MOSS should honor that."""
    monkeypatch.setenv("DEEPSEEK_SANDBOX_MODE", "read-only")
    monkeypatch.setenv("DEEPSEEK_APPROVAL_POLICY", "on-request")

    captured: dict[str, Any] = {}
    _capture_argv_and_env(monkeypatch, captured, _good_deepseek_json())

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    env = captured["env"]
    assert env.get("DEEPSEEK_SANDBOX_MODE") == "read-only"
    assert env.get("DEEPSEEK_APPROVAL_POLICY") == "on-request"
    # Timeouts still default since user didn't set them
    assert env.get("DEEPSEEK_STREAM_IDLE_TIMEOUT_SECS") == "600"


# ============================================================================
# spawn_role — Phase 3 (the meat)
# ============================================================================


def _mk_fake_completed_proc(stdout_bytes: bytes, returncode: int = 0):
    reader = asyncio.StreamReader()
    reader.feed_data(stdout_bytes)
    reader.feed_eof()

    class _FakeProc:
        stdout = reader
        def __init__(self):
            self.returncode = returncode
        async def wait(self): return returncode
        def kill(self): pass

    return _FakeProc()


def _good_deepseek_json(model: str = "DS3.2") -> bytes:
    return json.dumps({
        "mode": "agent",
        "model": model,
        "prompt": "test prompt",
        "output": "Here is the role output.\n\nDone.",
        "tools": [
            {"name": "read_file", "success": True, "output": "<file content>"},
            {"name": "write_file", "success": True, "output": ""},
        ],
        "status": "completed",
        "error": None,
    }).encode("utf-8")


async def _collect(gen):
    out = []
    async for ev in gen:
        out.append(ev)
    return out


@pytest.fixture
def runtime_env(monkeypatch, tmp_path):
    tpl = tmp_path / "config.toml"
    tpl.write_text(
        'provider = "deepseek"\n'
        'default_text_model = "deepseek-chat"\n'
        '[providers.deepseek]\n'
        'base_url = "https://api.deepseek.com"\n'
        'model = "deepseek-chat"\n'
    )
    log_dir = tmp_path / "logs"
    monkeypatch.setenv("MOSS_DEEPSEEK_CONFIG_TEMPLATE", str(tpl))
    return {"template": str(tpl), "log_dir": str(log_dir)}


# ─── argv composition ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_spawn_argv_uses_workspace_equals_cwd(runner, runtime_env, monkeypatch):
    """workspace ALWAYS = cwd; add_dirs ignored. Spec §5.5 workspace note."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="sys", user_input="hi",
        add_dirs=["/some/iter/dir", "/another/dir"],
        cwd="/the/openclaw/repo",
        timeout_s=60, resume_session_id=None,
        output_log_dir=runtime_env["log_dir"],
    ))

    argv = list(captured["argv"])
    w_idx = argv.index("-w")
    assert argv[w_idx + 1] == "/the/openclaw/repo"
    assert "/some/iter/dir" not in argv
    assert "/another/dir" not in argv


@pytest.mark.asyncio
async def test_spawn_argv_includes_exec_auto_json_mandatory(runner, runtime_env, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    argv = list(captured["argv"])
    assert "exec" in argv
    assert "--auto" in argv
    assert "--json" in argv


@pytest.mark.asyncio
async def test_spawn_argv_config_points_at_mktemp(runner, runtime_env, monkeypatch):
    """--config arg must point at our mktemp dir (so instructions override
    is in effect), NOT the user template directly."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    argv = list(captured["argv"])
    cfg_idx = argv.index("--config")
    cfg_path = argv[cfg_idx + 1]
    assert MOSS_TMP_PREFIX in cfg_path
    assert cfg_path.endswith("config.toml")
    assert cfg_path != runtime_env["template"]


@pytest.mark.asyncio
async def test_spawn_uses_devnull_stdin(runner, runtime_env, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["kwargs"] = kwargs
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assert captured["kwargs"]["stdin"] is asyncio.subprocess.DEVNULL


@pytest.mark.asyncio
async def test_spawn_argv_user_input_is_last(runner, runtime_env, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="MY_USER_PROMPT_42",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assert captured["argv"][-1] == "MY_USER_PROMPT_42"


# ─── instructions.md + config.toml file content ───────────────────────────

@pytest.mark.asyncio
async def test_spawn_writes_instructions_with_marker(runner, runtime_env, monkeypatch):
    """Capture instructions.md content BEFORE cleanup runs by reading inside
    fake_exec (which fires while spawn_role still holds the tmp dir).
    Content starts with MOSS_SYSTEM_MARKER, then system_prompt."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        argv = list(args)
        cfg_path = argv[argv.index("--config") + 1]
        tmp_dir = Path(cfg_path).parent
        captured["instructions_content"] = (tmp_dir / "instructions.md").read_text()
        captured["config_content"] = Path(cfg_path).read_text()
        return _mk_fake_completed_proc(_good_deepseek_json())

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="THE_ROLE_PROMPT", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))

    assert captured["instructions_content"].startswith(MOSS_SYSTEM_MARKER)
    assert "THE_ROLE_PROMPT" in captured["instructions_content"]

    import tomllib
    cfg = tomllib.loads(captured["config_content"])
    assert len(cfg["instructions"]) == 1
    assert cfg["instructions"][0].startswith("/")


# ─── event transformation ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_spawn_transforms_tools_to_events(runner, runtime_env, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    tool_events = [e for e in events if e.kind == "event"
                   and e.raw_event.get("type") == "tool_call"]
    assert len(tool_events) == 2
    assert [e.raw_event["tool"] for e in tool_events] == ["read_file", "write_file"]


@pytest.mark.asyncio
async def test_spawn_synthesizes_claude_shape_assistant_event(runner, runtime_env, monkeypatch):
    """Decision §2.4: synthetic Claude-shape "assistant" event so the existing
    extract-md.ts recognizes the final text via its Claude branch."""
    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assistant_events = [e for e in events if e.kind == "event"
                        and e.raw_event.get("type") == "assistant"]
    assert len(assistant_events) == 1
    msg = assistant_events[0].raw_event["message"]
    assert msg["role"] == "assistant"
    assert msg["content"][0]["type"] == "text"
    assert "Here is the role output" in msg["content"][0]["text"]


@pytest.mark.asyncio
async def test_spawn_yields_terminal_result_event(runner, runtime_env, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(_good_deepseek_json(model="DS3.2"))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    results = [e for e in events if e.kind == "result"]
    assert len(results) == 1
    r = results[0]
    assert r.exit_code == 0
    assert r.model == "DS3.2"
    assert r.session_id == ""
    assert r.tokens is None
    assert r.cost_usd is None


# ─── MOSS_DEEPSEEK_MODEL override ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_spawn_honors_model_override(runner, runtime_env, monkeypatch):
    monkeypatch.setenv("MOSS_DEEPSEEK_MODEL", "deepseek-reasoner")
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        argv = list(args)
        cfg_path = argv[argv.index("--config") + 1]
        import tomllib
        captured["cfg"] = tomllib.loads(Path(cfg_path).read_text())
        return _mk_fake_completed_proc(_good_deepseek_json(model="deepseek-reasoner"))

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assert captured["cfg"]["default_text_model"] == "deepseek-reasoner"


# ─── resume_session_id silently ignored ───────────────────────────────────

@pytest.mark.asyncio
async def test_spawn_ignores_resume_session_id(runner, runtime_env, monkeypatch):
    """resume_session_id is accepted per ABC but silently ignored.
    deepseek-tui exec mode doesn't persist sessions. Spec §2.5."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured["argv"] = args
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id="any-uuid-here",
        output_log_dir=runtime_env["log_dir"],
    ))
    results = [e for e in events if e.kind == "result"]
    assert len(results) == 1
    assert "--resume" not in captured["argv"]
    assert "any-uuid-here" not in " ".join(captured["argv"])


# ─── failure paths ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_spawn_yields_error_on_status_failed(runner, runtime_env, monkeypatch):
    bad_json = json.dumps({
        "mode": "agent", "model": "DS3.2", "prompt": "x",
        "output": "", "tools": [],
        "status": "failed", "error": "DeepSeek API key not found",
    }).encode("utf-8")

    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(bad_json)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    err = [e for e in events if e.kind == "error"]
    assert len(err) >= 1
    assert "API key" in err[0].message or "failed" in err[0].message.lower()


@pytest.mark.asyncio
async def test_spawn_yields_error_on_truncated_json(runner, runtime_env, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(b'{"mode": "agent", "output": "...incomplete')
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    err = [e for e in events if e.kind == "error"]
    assert len(err) >= 1
    assert "not valid JSON" in err[0].message
    assert "head=" in err[0].message


@pytest.mark.asyncio
async def test_spawn_yields_error_on_timeout_and_cleans_tmp(runner, runtime_env, monkeypatch):
    """If subprocess never finishes within timeout_s, kill + error AND clean tmp."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        argv = list(args)
        captured["tmp_dir"] = str(Path(argv[argv.index("--config") + 1]).parent)
        class _HangProc:
            stdout = asyncio.StreamReader()
            def __init__(self):
                self.returncode = None
            async def wait(self): return -9
            def kill(self): pass
        return _HangProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=0.1,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    err = [e for e in events if e.kind == "error"]
    assert len(err) >= 1
    assert "timeout" in err[0].message.lower()
    assert not Path(captured["tmp_dir"]).exists()


@pytest.mark.asyncio
async def test_spawn_yields_error_on_subprocess_spawn_failure(runner, runtime_env, monkeypatch, tmp_path):
    """When create_subprocess_exec raises: error event, tmp dir cleaned,
    stderr_log file was created (proves open() inside try, closed in finally)."""
    captured: dict[str, Any] = {}

    real_mkdtemp = tempfile.mkdtemp
    def spy_mkdtemp(*a, **kw):
        d = real_mkdtemp(*a, **kw)
        captured["tmp_dir"] = d
        return d
    monkeypatch.setattr(tempfile, "mkdtemp", spy_mkdtemp)

    async def fake_exec(*args, **kwargs):
        raise FileNotFoundError("deepseek-tui not found")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    log_dir = str(tmp_path / "logs")
    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=log_dir,
    ))
    err = [e for e in events if e.kind == "error"]
    assert len(err) >= 1
    assert "deepseek-tui" in err[0].message
    assert not Path(captured["tmp_dir"]).exists()
    assert (Path(log_dir) / "planner.stderr.log").exists()


# ─── tmp dir + raw.json lifecycle ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_spawn_cleans_up_tmp_dir(runner, runtime_env, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        argv = list(args)
        captured["tmp_dir"] = str(Path(argv[argv.index("--config") + 1]).parent)
        return _mk_fake_completed_proc(_good_deepseek_json())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assert not Path(captured["tmp_dir"]).exists()


@pytest.mark.asyncio
async def test_spawn_cleanup_on_error_path(runner, runtime_env, monkeypatch):
    """Even on JSON parse failure path, tmp dir is cleaned."""
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        argv = list(args)
        captured["tmp_dir"] = str(Path(argv[argv.index("--config") + 1]).parent)
        return _mk_fake_completed_proc(b"NOT_JSON_AT_ALL")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assert not Path(captured["tmp_dir"]).exists()


@pytest.mark.asyncio
async def test_spawn_cleanup_on_cancellation(runner, runtime_env, monkeypatch):
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        argv = list(args)
        captured["tmp_dir"] = str(Path(argv[argv.index("--config") + 1]).parent)
        class _SlowProc:
            stdout = asyncio.StreamReader()
            def __init__(self): self.returncode = None
            async def wait(self): return -9
            def kill(self): pass
        return _SlowProc()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    async def runner_task():
        async for _ in runner.spawn_role(
            role="planner", system_prompt="s", user_input="u",
            add_dirs=[], cwd="/tmp", timeout_s=60,
            resume_session_id=None, output_log_dir=runtime_env["log_dir"],
        ):
            pass

    task = asyncio.create_task(runner_task())
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not Path(captured["tmp_dir"]).exists()


@pytest.mark.asyncio
async def test_spawn_writes_raw_json_artifact(runner, runtime_env, monkeypatch):
    test_json = _good_deepseek_json(model="DS3.2")
    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(test_json)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    _ = await _collect(runner.spawn_role(
        role="my_role", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    raw_path = Path(runtime_env["log_dir"]) / "my_role.raw.json"
    assert raw_path.exists()
    assert raw_path.read_bytes() == test_json


@pytest.mark.asyncio
async def test_spawn_handles_null_tools_array(runner, runtime_env, monkeypatch):
    """Defensive: result.tools is sometimes null instead of []."""
    null_tools = json.dumps({
        "mode": "agent", "model": "DS3.2", "prompt": "x",
        "output": "fine", "tools": None,
        "status": "completed", "error": None,
    }).encode("utf-8")
    async def fake_exec(*args, **kwargs):
        return _mk_fake_completed_proc(null_tools)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    events = await _collect(runner.spawn_role(
        role="planner", system_prompt="s", user_input="u",
        add_dirs=[], cwd="/tmp", timeout_s=60,
        resume_session_id=None, output_log_dir=runtime_env["log_dir"],
    ))
    assert [e for e in events if e.kind == "result"]
    assert not [e for e in events if e.kind == "event"
                and e.raw_event.get("type") == "tool_call"]
