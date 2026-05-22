"""Claude Code CLI runner.

Ported from src/ops/spawn_claude.py with two behavior changes:
  1. MOSS_MARKER sentinel prefix on --append-system-prompt text (for orphan
     kill via `pkill -f MOSS-EVOLUTION-MARKER`).
  2. AgentTokens extraction from Claude's result event `usage` block.

The spawned claude subprocess inherits the daemon's env via
asyncio.create_subprocess_exec(..., env=os.environ.copy()), so any env
variables set when the daemon was launched flow through unchanged.

See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §5.1.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from .base import (
    AgentStreamEvent,
    AgentTokens,
    CodingAgentRunner,
    _read_line_unbounded,
)

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")

# Prepended to --append-system-prompt text so MOSS-spawned claude processes
# are identifiable in `pkill -f`. The brackets make it visually distinctive
# in argv; pkill greps for the inner substring (PKILL_MARKER) since `[...]`
# in a regex pattern is a character class.
MOSS_MARKER = "[MOSS-EVOLUTION-MARKER]"
PKILL_MARKER = "MOSS-EVOLUTION-MARKER"


def _parse_claude_usage(usage: Any) -> AgentTokens | None:
    """Map Claude result event's `usage` block to AgentTokens.

    Claude reports both cache_read_input_tokens and cache_creation_input_tokens
    (cache writes), which we keep separate so estimateUsageCost can apply the
    correct rate to each (cache-write ~1.25x input, cache-read ~0.1x input).
    """
    if not isinstance(usage, dict):
        return None
    return AgentTokens(
        input=int(usage.get("input_tokens", 0) or 0),
        output=int(usage.get("output_tokens", 0) or 0),
        cache_read=int(usage.get("cache_read_input_tokens", 0) or 0),
        cache_write=int(usage.get("cache_creation_input_tokens", 0) or 0),
        reasoning=0,  # Claude doesn't report reasoning tokens separately
    )


def _resolve_settings_path() -> str | None:
    """Resolve --settings path for the bundled MOSS Claude settings file.

    OSS resolution order:
      1. MOSS_CLAUDE_SETTINGS env (explicit override)
      2. Repo-bundled moss-claude-settings.json (preferred — known plugin-free)
      3. $HOME/.claude/settings.json (whatever the user already has)
      4. Return None — let Claude CLI pick its default

    See spec §5.1 for rationale (disable user plugins so role agents are
    deterministic; user's superpowers plugin SessionStart hook would
    otherwise inject "YOU MUST USE SKILLS" instructions into role prompts).
    """
    explicit = os.environ.get("MOSS_CLAUDE_SETTINGS")
    if explicit:
        return explicit
    # claude.py lives at host-daemon/src/ops/coding_agents/claude.py;
    # bundled settings file is at host-daemon/moss-claude-settings.json
    # → up 4 parents from __file__.
    pkg_default = (
        Path(__file__).resolve().parent.parent.parent.parent / "moss-claude-settings.json"
    )
    if pkg_default.is_file():
        return str(pkg_default)
    home_default = Path.home() / ".claude" / "settings.json"
    if home_default.is_file():
        return str(home_default)
    return None


class ClaudeRunner(CodingAgentRunner):
    @property
    def provider_name(self) -> str:
        return "claude"

    async def preflight(self) -> dict[str, Any]:
        try:
            proc = await asyncio.create_subprocess_exec(
                CLAUDE_BIN, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            return {"ok": False, "version": None, "error": f"claude binary not found: {e}"}
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        except asyncio.TimeoutError:
            return {"ok": False, "version": None, "error": "claude --version timed out"}
        if proc.returncode != 0:
            return {
                "ok": False,
                "version": None,
                "error": f"claude --version rc={proc.returncode}: {err.decode('utf-8', 'replace')[:200]}",
            }
        return {"ok": True, "version": out.decode("utf-8", "replace").strip(), "error": None}

    async def kill_orphans(self) -> dict[str, Any]:
        proc = await asyncio.create_subprocess_exec(
            "pkill", "-TERM", "-f", PKILL_MARKER,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        # pkill: rc=0 → killed >=1, rc=1 → no match (treat as success here).
        return {
            "provider": "claude",
            "rc": proc.returncode,
            "stderr_tail": err.decode("utf-8", "replace")[-200:],
        }

    async def spawn_role(
        self,
        *,
        role: str,
        system_prompt: str,
        user_input: str,
        add_dirs: list[str],
        cwd: str,
        timeout_s: float,
        resume_session_id: str | None,
        output_log_dir: str,
    ):
        Path(output_log_dir).mkdir(parents=True, exist_ok=True)
        stderr_log = Path(output_log_dir) / f"{role}.stderr.log"

        # Prepend MOSS marker so `pkill -f MOSS-EVOLUTION-MARKER` finds orphans.
        # Marker appears inside --append-system-prompt text in argv.
        prompt_with_marker = f"{MOSS_MARKER}\n{system_prompt}"

        settings_path = _resolve_settings_path()
        cmd = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose"]
        if settings_path:
            cmd += ["--settings", settings_path]
        cmd += [
            "--dangerously-skip-permissions",
            "--model", "sonnet",
            "--append-system-prompt", prompt_with_marker,
        ]
        for d in add_dirs:
            cmd += ["--add-dir", d]
        if resume_session_id:
            cmd += ["--resume", resume_session_id]

        env = os.environ.copy()

        started = time.monotonic()
        stderr_fp = open(stderr_log, "wb")
        try:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=cwd,
                    env=env,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=stderr_fp,
                )
            except Exception as e:  # noqa: BLE001
                yield AgentStreamEvent(kind="error", message=f"spawn-claude exec error: {e}")
                return

            # Claude reads user prompt via stdin (different from Codex which
            # uses positional arg + DEVNULL stdin).
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(user_input.encode("utf-8"))
            proc.stdin.close()

            session_id = ""
            cost_usd = 0.0
            tokens: AgentTokens | None = None
            timed_out = False
            line_buffer = bytearray()

            try:
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
                        continue

                    # Sliding metadata extraction (per spec §4 / §5.1)
                    sys_session_id = None
                    if evt.get("type") == "system" and "session_id" in evt:
                        session_id = evt["session_id"]
                        sys_session_id = session_id
                    if evt.get("type") == "result":
                        cost_usd = float(evt.get("total_cost_usd") or 0.0)
                        if not session_id:
                            session_id = evt.get("session_id", "") or ""
                        tokens = _parse_claude_usage(evt.get("usage"))
                    yield AgentStreamEvent(
                        kind="event",
                        raw_event=evt,
                        session_id=sys_session_id,
                        cost_usd=cost_usd if evt.get("type") == "result" else None,
                        tokens=tokens if evt.get("type") == "result" else None,
                    )

                if timed_out:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
                    yield AgentStreamEvent(
                        kind="error",
                        message=f"claude timeout after {timeout_s}s",
                    )
                    return

                rc = await proc.wait()
                yield AgentStreamEvent(
                    kind="result",
                    session_id=session_id,
                    cost_usd=cost_usd,
                    tokens=tokens,
                    model="sonnet",
                    exit_code=rc,
                    elapsed_s=time.monotonic() - started,
                )
            except asyncio.CancelledError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
                raise
            except Exception as e:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    await proc.wait()
                except Exception:  # noqa: BLE001
                    pass
                yield AgentStreamEvent(kind="error", message=f"spawn-claude error: {e}")
        finally:
            try:
                stderr_fp.close()
            except Exception:  # noqa: BLE001
                pass
