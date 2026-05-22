"""OpenAI Codex CLI runner.

See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §5.2 for
design rationale, §11 for the verified Codex 0.118.0 flag list, and
§2.3-2.5 for the probe results that back the implementation choices.

Critical knobs (do not change without re-verifying):
  - subprocess.DEVNULL on stdin (openai/codex#20919 — codex hangs reading
    stdin even when prompt is positional).
  - json.dumps() for the developer_instructions value (TOML basic-string
    compatible; verified §2.3 probe B handles newlines + quotes + backticks).
  - MOSS_MARKER prepended to dev_instructions so pkill -f finds orphans.
    Resume IGNORES new dev_instructions semantically (§2.4 probe B2) but
    the flag still appears in argv → marker works on resumed processes too.
  - --sandbox danger-full-access + approval_policy=never: container is the
    sandbox; we don't want bwrap/landlock layered inside Docker.
  - history.persistence=none: suppresses ~/.codex/history.jsonl interactive
    sidebar; does NOT break resume (§2.4 probe C).

Linux ARG_MAX caveat (per spec §14 item 5): both system_prompt and
user_input are passed via argv. Linux ARG_MAX is typically 2MB; our
role prompts are < 20KB. Prompts >> ARG_MAX would need the AGENTS.md
fallback (not currently implemented; spec §11 documents the path).
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

CODEX_BIN = os.environ.get("CODEX_BIN", "codex")

# Default model. Codex CLI 0.118.0 ships with: gpt-5.4 (top priority),
# gpt-5.4-mini, gpt-5.3-codex, gpt-5.2. The earlier-research-claimed
# "gpt-5.5" doesn't exist in this CLI version. Override via env or
# openclaw.json model_provider config when needed.
DEFAULT_MODEL = os.environ.get("MOSS_CODEX_MODEL", "gpt-5.4")

# Prepended to developer_instructions text so MOSS-spawned codex processes
# are identifiable in `pkill -f`. Brackets make it visually distinctive
# in argv; pkill greps for the inner substring (PKILL_MARKER) since `[...]`
# is regex character-class syntax.
MOSS_MARKER = "[MOSS-EVOLUTION-MARKER]"
PKILL_MARKER = "MOSS-EVOLUTION-MARKER"


def build_codex_cmd(
    system_prompt: str,
    user_input: str,
    add_dirs: list[str],
    cwd: str,
    resume_session_id: str | None,
) -> list[str]:
    """Build the `codex exec` argv. See spec §5.2 for the why of each flag."""
    dev_instructions = f"{MOSS_MARKER}\n{system_prompt}"
    cmd: list[str] = [
        CODEX_BIN, "exec", "--json",
        "--skip-git-repo-check",
        "--sandbox", "danger-full-access",
        "-c", 'approval_policy="never"',
        "-c", f"developer_instructions={json.dumps(dev_instructions)}",
        "-c", 'history.persistence="none"',
        "-m", DEFAULT_MODEL,
        "-C", cwd,
    ]
    for d in add_dirs:
        cmd += ["--add-dir", d]
    if resume_session_id:
        # syntax: codex exec [OPTIONS] resume <SESSION_ID> [PROMPT]
        cmd += ["resume", resume_session_id]
    cmd += [user_input]
    return cmd


def _parse_usage_block(usage: Any) -> AgentTokens | None:
    """Map Codex turn.completed.usage → AgentTokens. Missing fields default to 0.

    Per spec §14 item 4: reasoning_output_tokens may be absent on non-thinking
    models (e.g., gpt-5.5 default); fall back to 0 silently.
    """
    if not isinstance(usage, dict):
        return None
    return AgentTokens(
        input=int(usage.get("input_tokens", 0) or 0),
        output=int(usage.get("output_tokens", 0) or 0),
        cache_read=int(usage.get("cached_input_tokens", 0) or 0),
        cache_write=0,  # Codex doesn't report
        reasoning=int(usage.get("reasoning_output_tokens", 0) or 0),
    )


class CodexRunner(CodingAgentRunner):
    @property
    def provider_name(self) -> str:
        return "codex"

    async def preflight(self) -> dict[str, Any]:
        try:
            proc = await asyncio.create_subprocess_exec(
                CODEX_BIN, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            return {"ok": False, "version": None, "error": f"codex binary not found: {e}"}
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        except asyncio.TimeoutError:
            return {"ok": False, "version": None, "error": "codex --version timed out"}
        if proc.returncode != 0:
            return {
                "ok": False,
                "version": None,
                "error": f"codex --version rc={proc.returncode}: {err.decode('utf-8', 'replace')[:200]}",
            }
        return {"ok": True, "version": out.decode("utf-8", "replace").strip(), "error": None}

    async def kill_orphans(self) -> dict[str, Any]:
        proc = await asyncio.create_subprocess_exec(
            "pkill", "-TERM", "-f", PKILL_MARKER,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        return {
            "provider": "codex",
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

        cmd = build_codex_cmd(
            system_prompt=system_prompt,
            user_input=user_input,
            add_dirs=add_dirs,
            cwd=cwd,
            resume_session_id=resume_session_id,
        )

        started = time.monotonic()
        stderr_fp = open(stderr_log, "wb")
        try:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    cwd=cwd,
                    env=os.environ.copy(),
                    stdin=asyncio.subprocess.DEVNULL,  # CRITICAL — see #20919
                    stdout=asyncio.subprocess.PIPE,
                    stderr=stderr_fp,
                )
            except Exception as e:  # noqa: BLE001
                yield AgentStreamEvent(kind="error", message=f"codex exec error: {e}")
                return

            session_id = ""
            latest_tokens: AgentTokens | None = None
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

                    # Extract sliding metadata (per spec §5.2 event table)
                    if evt.get("type") == "thread.started" and "thread_id" in evt:
                        session_id = evt["thread_id"]
                        yield AgentStreamEvent(
                            kind="event", raw_event=evt, session_id=session_id,
                        )
                        continue
                    if evt.get("type") == "turn.completed":
                        latest_tokens = _parse_usage_block(evt.get("usage"))
                        yield AgentStreamEvent(
                            kind="event", raw_event=evt, tokens=latest_tokens,
                        )
                        continue
                    # All other events pass through opaque
                    yield AgentStreamEvent(kind="event", raw_event=evt)

                if timed_out:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
                    yield AgentStreamEvent(
                        kind="error",
                        message=f"codex timeout after {timeout_s}s",
                    )
                    return

                rc = await proc.wait()
                yield AgentStreamEvent(
                    kind="result",
                    session_id=session_id,
                    tokens=latest_tokens,
                    cost_usd=None,  # Codex doesn't report USD
                    model=DEFAULT_MODEL,
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
                yield AgentStreamEvent(kind="error", message=f"codex spawn error: {e}")
        finally:
            try:
                stderr_fp.close()
            except Exception:  # noqa: BLE001
                pass
