"""OpenCode coding-agent runner.

OpenCode is the open-source, provider-agnostic coding agent CLI:
  https://opencode.ai
  https://github.com/sst/opencode

MOSS adapts it as a 4th provider alongside Claude Code, OpenAI Codex,
and DeepSeek-TUI. The non-obvious bits:

  - opencode has NO --system-prompt flag. The only way to inject a system
    prompt is via an "agent" definition (markdown file with frontmatter,
    or JSON `agent.<name>.prompt`). Per spawn we mktemp a dir, write an
    opencode.json with the role's prompt under a fixed agent name, pass
    OPENCODE_CONFIG=<tmp>/opencode.json, and select it with `--agent`.

  - Authentication is the user's problem (same posture as Claude OAuth,
    Codex auth, DeepSeek-TUI config). opencode reads provider-specific
    env vars (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, ...)
    or `~/.local/share/opencode/auth.json` populated by `opencode auth login`.

  - Default model MUST be passed explicitly. With `--model` omitted,
    opencode 1.15.5 silently auto-selects a free OpenCode Zen model and
    makes a real network call. We default to anthropic/claude-sonnet-4-6
    (matching the Claude provider's default); override via
    MOSS_OPENCODE_MODEL=provider/model.

  - The orphan-kill marker is embedded in argv via `--title "[MOSS-EVOLUTION-MARKER]"`
    so `pkill -f MOSS-EVOLUTION-MARKER` matches the same sentinel used by
    claude.py / codex.py / deepseek_tui.py. The tmp-dir prefix
    `moss-evo-opencode-` is incidental — env vars don't appear in argv,
    so we don't rely on it for pkill.

  - `--pure` disables opencode's external-plugin auto-install. We
    additionally set OPENCODE_DISABLE_EXTERNAL_SKILLS=1 /
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 so the user's interactive
    opencode skill setup doesn't leak into MOSS role prompts (same reason
    claude.py uses moss-claude-settings.json).

NDJSON event schema (verified against opencode 1.15.5 live capture):

  Every line shares the envelope:
    {"type": "<kind>", "timestamp": <ms>, "sessionID": "ses_...", ...payload}

  Observed kinds:
    step_start   — model turn start
    step_finish  — model turn end. Carries `part.reason` ("stop", "tool-calls"),
                   `part.tokens {total, input, output, reasoning, cache:{read,write}}`,
                   `part.cost` (USD), `part.snapshot` (git hash).
    tool_use     — fully-formed tool call (part.tool, part.state.input/output)
    text         — assistant text chunk (part.text)
    reasoning    — thinking block (only emitted with --thinking)
    error        — fatal. `{error: {name, data: {message}}}`. Stream then aborts.

  The stream ends with EOF + exit 0 on success — opencode has no dedicated
  "done" envelope. The last `step_finish` with `part.reason == "stop"` is
  the de-facto completion signal.

See evoclaw/docs/specs/2026-05-20-opencode-integration-design.md.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from .base import (
    AgentStreamEvent,
    AgentTokens,
    CodingAgentRunner,
    _read_line_unbounded,
)

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

OPENCODE_BIN = os.environ.get("OPENCODE_BIN", "opencode")

# Required: opencode 1.15.5 auto-selects a free OpenCode Zen model when
# --model is omitted and makes a real network call without warning. We
# always pass --model. Default mirrors claude.py's "sonnet" choice
# (Anthropic Sonnet 4.6); override via MOSS_OPENCODE_MODEL=provider/model.
DEFAULT_MODEL = os.environ.get(
    "MOSS_OPENCODE_MODEL", "anthropic/claude-sonnet-4-6",
)

# Optional reasoning-effort variant ("high" | "max" | "minimal" | ...).
# Empty → omitted from argv. Provider-specific; see `opencode models --verbose`.
DEFAULT_VARIANT = os.environ.get("MOSS_OPENCODE_VARIANT", "").strip()

# Mktemp prefix for the per-spawn opencode.json (cleaned up in finally).
MOSS_TMP_PREFIX = "moss-evo-opencode-"

# Embedded in argv via --title (pkill -f target) AND prepended to the agent
# prompt body (so it also appears in conversation history for trace audit).
MOSS_MARKER = "[MOSS-EVOLUTION-MARKER]"
PKILL_MARKER = "MOSS-EVOLUTION-MARKER"

# Per-spawn agent name. Unlikely to collide with user-defined agents in
# their global `~/.config/opencode/opencode.json` (which deep-merges with
# ours via OPENCODE_CONFIG).
MOSS_AGENT_NAME = "moss-evolution"


# ----------------------------------------------------------------------------
# Pure helpers (tested in isolation)
# ----------------------------------------------------------------------------


def _build_opencode_config(system_prompt: str) -> str:
    """Render the per-spawn opencode.json contents (JSON string).

    Pinned posture overrides user's global config via deep-merge:
      share="disabled"  — never auto-upload sessions to opencode.ai
      autoupdate=false  — don't side-quest into self-update mid-run
      agent.moss-evolution — primary mode, prompt = MOSS marker + role prompt
    """
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "share": "disabled",
        "autoupdate": False,
        "agent": {
            MOSS_AGENT_NAME: {
                "mode": "primary",
                "prompt": f"{MOSS_MARKER}\n{system_prompt}",
            },
        },
    }
    return json.dumps(cfg)


def _parse_opencode_tokens(tokens_block: Any) -> AgentTokens | None:
    """Map opencode `step_finish.part.tokens` → AgentTokens.

    Shape (opencode 1.15.5):
      {total, input, output, reasoning, cache: {read, write}}

    All fields may be int or missing. Coerce defensively; return None when
    `tokens_block` isn't a dict.
    """
    if not isinstance(tokens_block, dict):
        return None
    cache = tokens_block.get("cache")
    if not isinstance(cache, dict):
        cache = {}
    return AgentTokens(
        input=int(tokens_block.get("input", 0) or 0),
        output=int(tokens_block.get("output", 0) or 0),
        cache_read=int(cache.get("read", 0) or 0),
        cache_write=int(cache.get("write", 0) or 0),
        reasoning=int(tokens_block.get("reasoning", 0) or 0),
    )


def build_opencode_cmd(
    *,
    role: str,
    user_input: str,
    cwd: str,
    model: str,
    variant: str,
    resume_session_id: str | None,
) -> list[str]:
    """Build the `opencode run` argv. See module docstring for flag rationale."""
    cmd: list[str] = [
        OPENCODE_BIN, "run",
        "--format", "json",
        "--dangerously-skip-permissions",
        "--pure",
        "--print-logs", "--log-level", "WARN",
        "--dir", cwd,
        "--agent", MOSS_AGENT_NAME,
        "--model", model,
        # --title embeds the orphan-kill marker in argv (pkill -f target)
        # and tags the session for human inspection in `opencode session list`.
        "--title", f"{MOSS_MARKER} role={role}",
    ]
    if variant:
        cmd += ["--variant", variant]
    if resume_session_id:
        cmd += ["--session", resume_session_id]
    # `--` terminator keeps the user prompt as a single positional even if
    # it starts with `-`. opencode collects trailing positionals into the
    # `message` array and joins them.
    cmd += ["--", user_input]
    return cmd


# ----------------------------------------------------------------------------
# OpencodeRunner
# ----------------------------------------------------------------------------


class OpencodeRunner(CodingAgentRunner):
    @property
    def provider_name(self) -> str:
        return "opencode"

    async def preflight(self) -> dict[str, Any]:
        try:
            proc = await asyncio.create_subprocess_exec(
                OPENCODE_BIN, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            return {
                "ok": False,
                "version": None,
                "error": (
                    f"opencode binary not found: {e}. "
                    "Set OPENCODE_BIN or install from https://opencode.ai"
                ),
            }
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "version": None,
                "error": "opencode --version timed out",
            }
        if proc.returncode != 0:
            return {
                "ok": False,
                "version": None,
                "error": (
                    f"opencode --version rc={proc.returncode}: "
                    f"{err.decode('utf-8', 'replace')[:200]}"
                ),
            }
        return {
            "ok": True,
            "version": out.decode("utf-8", "replace").strip(),
            "error": None,
        }

    async def kill_orphans(self) -> dict[str, Any]:
        proc = await asyncio.create_subprocess_exec(
            "pkill", "-TERM", "-f", PKILL_MARKER,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        return {
            "provider": "opencode",
            "rc": proc.returncode,
            "stderr_tail": err.decode("utf-8", "replace")[-200:],
        }

    async def spawn_role(
        self,
        *,
        role: str,
        system_prompt: str,
        user_input: str,
        add_dirs: list[str],  # opencode has no --add-dir; ignored (cwd is the workspace)
        cwd: str,
        timeout_s: float,
        resume_session_id: str | None,
        output_log_dir: str,
    ):
        Path(output_log_dir).mkdir(parents=True, exist_ok=True)
        stderr_log = Path(output_log_dir) / f"{role}.stderr.log"

        # mktemp the per-spawn config; cleaned up in the outer finally.
        tmp_dir = tempfile.mkdtemp(prefix=MOSS_TMP_PREFIX)
        try:
            config_path = Path(tmp_dir) / "opencode.json"
            config_path.write_text(
                _build_opencode_config(system_prompt),
                encoding="utf-8",
            )

            cmd = build_opencode_cmd(
                role=role,
                user_input=user_input,
                cwd=cwd,
                model=DEFAULT_MODEL,
                variant=DEFAULT_VARIANT,
                resume_session_id=resume_session_id,
            )

            env = os.environ.copy()
            # Layer our per-spawn config on top of user's global config
            # via the documented extra-config-file hook.
            env["OPENCODE_CONFIG"] = str(config_path)
            # Belt-and-suspenders: keep MOSS role prompts deterministic
            # against user's interactive opencode skill auto-loads.
            env.setdefault("OPENCODE_DISABLE_EXTERNAL_SKILLS", "1")
            env.setdefault("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "1")

            started = time.monotonic()
            stderr_fp = open(stderr_log, "wb")
            proc = None
            try:
                try:
                    proc = await asyncio.create_subprocess_exec(
                        *cmd, cwd=cwd, env=env,
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=stderr_fp,
                    )
                except Exception as e:  # noqa: BLE001
                    yield AgentStreamEvent(
                        kind="error",
                        message=f"opencode exec error: {e}",
                    )
                    return

                assert proc.stdout is not None
                session_id = ""
                tokens: AgentTokens | None = None
                cost_usd: float | None = None
                timed_out = False
                stream_error_msg: str | None = None
                line_buffer = bytearray()

                while True:
                    remaining = timeout_s - (time.monotonic() - started)
                    if remaining <= 0:
                        timed_out = True
                        break
                    try:
                        line = await _read_line_unbounded(
                            proc.stdout, line_buffer, remaining,
                        )
                    except asyncio.TimeoutError:
                        timed_out = True
                        break
                    if line is None:
                        break
                    try:
                        evt = json.loads(line.decode("utf-8"))
                    except Exception:  # noqa: BLE001
                        # opencode emits well-formed NDJSON to stdout; logs
                        # go to stderr. A stray non-JSON line is almost
                        # certainly artifact noise — skip, don't abort.
                        continue

                    # sessionID arrives on every event; sticky-capture once.
                    sid = evt.get("sessionID")
                    sid_for_event: str | None = None
                    if isinstance(sid, str) and sid:
                        sid_for_event = sid
                        if not session_id:
                            session_id = sid

                    # step_finish carries token + cost ledger. Accumulate
                    # to the latest seen — a multi-turn resume can emit
                    # several step_finish events; the final one wins.
                    if evt.get("type") == "step_finish":
                        part = evt.get("part") if isinstance(evt.get("part"), dict) else {}
                        new_tokens = _parse_opencode_tokens(part.get("tokens"))
                        if new_tokens is not None:
                            tokens = new_tokens
                        if isinstance(part.get("cost"), (int, float)):
                            cost_usd = float(part["cost"])

                    # An "error" envelope is fatal: yield the raw event for
                    # trace fidelity, then break out and emit a terminal
                    # error event. opencode may emit more lines after error
                    # but we don't trust them as a successful result.
                    if evt.get("type") == "error":
                        err_block = evt.get("error") if isinstance(evt.get("error"), dict) else {}
                        data = err_block.get("data") if isinstance(err_block.get("data"), dict) else {}
                        stream_error_msg = str(
                            data.get("message")
                            or err_block.get("name")
                            or "opencode stream error"
                        )
                        yield AgentStreamEvent(
                            kind="event",
                            raw_event=evt,
                            session_id=sid_for_event,
                        )
                        break

                    yield AgentStreamEvent(
                        kind="event",
                        raw_event=evt,
                        session_id=sid_for_event,
                    )

                if stream_error_msg is not None:
                    # Reap the subprocess so we don't leak.
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        try:
                            proc.kill()
                        except ProcessLookupError:
                            pass
                        await proc.wait()
                    yield AgentStreamEvent(
                        kind="error", message=stream_error_msg,
                    )
                    return

                if timed_out:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
                    yield AgentStreamEvent(
                        kind="error",
                        message=f"opencode timeout after {timeout_s}s",
                    )
                    return

                rc = await proc.wait()
                yield AgentStreamEvent(
                    kind="result",
                    session_id=session_id,
                    tokens=tokens,
                    cost_usd=cost_usd,
                    model=DEFAULT_MODEL,
                    exit_code=rc,
                    elapsed_s=time.monotonic() - started,
                )
            except asyncio.CancelledError:
                if proc is not None:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        await proc.wait()
                    except Exception:  # noqa: BLE001
                        pass
                raise
            except Exception as e:  # noqa: BLE001
                if proc is not None:
                    try:
                        proc.kill()
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        await proc.wait()
                    except Exception:  # noqa: BLE001
                        pass
                yield AgentStreamEvent(
                    kind="error",
                    message=f"opencode spawn error: {e}",
                )
            finally:
                try:
                    stderr_fp.close()
                except Exception:  # noqa: BLE001
                    pass
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
