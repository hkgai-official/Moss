"""DeepSeek-TUI coding-agent runner.

DeepSeek-TUI is an open-source Rust-based coding agent CLI:
  https://github.com/Hmbown/DeepSeek-TUI

MOSS adapts it as a 3rd provider alongside Claude Code and OpenAI Codex,
NOT by modifying deepseek-tui source (it must run unmodified upstream),
and NOT by managing its API key (deepseek-tui has its own auth flow:
`deepseek-tui auth set` / `deepseek-tui login` / per-provider env vars
like DEEPSEEK_API_KEY / SGLANG_API_KEY / etc — same posture as Claude
OAuth and Codex OAuth).

Adapter strategy (see spec §2.2):
  - deepseek-tui has NO CLI flag for system prompt — only the
    config-file `instructions = ["./file.md"]` field. Per spawn we
    mktemp a dir, write instructions.md (MOSS role's system prompt) +
    config.toml (cloned from user's template with instructions injected),
    pass --config <tmp>/config.toml, and clean up in finally.
  - deepseek-tui --json emits a single pretty-printed JSON object after
    exit (NOT NDJSON stream). We transform result.tools[] into per-tool
    AgentStreamEvent(kind="event"), wrap result.output in a Claude-shape
    synthetic "assistant" event (so extract-md.ts works unchanged), then
    yield a terminal result event.
  - Spawn `deepseek-tui` directly (not the `deepseek` dispatcher) —
    only the TUI binary accepts top-level -w/--config flags we need.

See evoclaw/docs/specs/2026-05-18-deepseek-tui-integration-design.md
for the full design rationale and probe-verified behavior table (§11).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import time
import tomllib
from pathlib import Path
from typing import Any

import tomli_w

from .base import AgentStreamEvent, CodingAgentRunner

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------

DEEPSEEK_TUI_BIN = os.environ.get("DEEPSEEK_TUI_BIN", "deepseek-tui")

# DeepSeek-TUI's standard config location. User overrides via
# MOSS_DEEPSEEK_CONFIG_TEMPLATE.
DEFAULT_CONFIG_TEMPLATE = os.path.expanduser("~/.deepseek/config.toml")

# Mktemp prefix — appears in argv as --config /tmp/<this>XXXXXX/config.toml
# → pkill -f "moss-evo-deepseek-" matches.
MOSS_TMP_PREFIX = "moss-evo-deepseek-"
PKILL_MARKER = "moss-evo-deepseek-"

# Prepended to instructions.md content — grep-able marker in role prompts.
MOSS_SYSTEM_MARKER = "[MOSS-EVOLUTION-MARKER]"


# ----------------------------------------------------------------------------
# _render_tmp_config — pure helper
# ----------------------------------------------------------------------------


def _render_tmp_config(
    template_path: str,
    instructions_abs_path: str,
    model_override: str | None = None,
) -> str:
    """Clone user's deepseek-tui config template; inject our instructions.md
    reference; optionally override default_text_model; force memory off;
    return serialized TOML.

    NOTE on overwriting instructions: if template had
    `instructions = ["./AGENTS.md", "~/memory.md"]`, those are DROPPED for
    this MOSS spawn. MOSS role prompts are self-contained; mixing them with
    user's general AGENTS.md could confuse the agent. Documented in spec §14.

    NOTE on [memory]: Round-1 hardening (2026-05-18 post-research) forces
    `[memory] enabled = false` regardless of user's template, to prevent
    cross-spawn memory contamination between MOSS roles. Other [memory]
    keys (path, format) are preserved. User's interactive deepseek-tui
    session memory at ~/.deepseek/memory.md is NOT touched — this only
    affects the per-spawn tmp config MOSS generates.

    NOTE on [mcp] blocks: these survive the re-serialization, so user's
    interactive deepseek-tui MCP setup carries into MOSS spawns. Documented
    as spec §14 item 5.
    """
    with open(template_path, "rb") as f:
        data = tomllib.load(f)

    # Force instructions to a single-element list pointing at our tmp file.
    # ABSOLUTE path so deepseek-tui resolves it independent of cwd.
    data["instructions"] = [instructions_abs_path]

    # Optional model override
    if model_override:
        data["default_text_model"] = model_override

    # Force memory off for per-spawn isolation. Preserve other [memory] keys
    # so user's setup (memory file path, format) is honored if they ever
    # re-enable; we only override the `enabled` flag.
    memory_block = data.get("memory")
    if not isinstance(memory_block, dict):
        memory_block = {}
    memory_block["enabled"] = False
    data["memory"] = memory_block

    return tomli_w.dumps(data)


# ----------------------------------------------------------------------------
# DeepSeekTuiRunner
# ----------------------------------------------------------------------------


class DeepSeekTuiRunner(CodingAgentRunner):
    @property
    def provider_name(self) -> str:
        return "deepseek-tui"

    async def preflight(self) -> dict[str, Any]:
        # 1. binary callable
        try:
            proc = await asyncio.create_subprocess_exec(
                DEEPSEEK_TUI_BIN, "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            return {
                "ok": False,
                "version": None,
                "error": (
                    f"deepseek-tui binary not found: {e}. "
                    "Set DEEPSEEK_TUI_BIN or install from "
                    "github.com/Hmbown/DeepSeek-TUI"
                ),
            }
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "version": None,
                "error": "deepseek-tui --version timed out",
            }
        if proc.returncode != 0:
            return {
                "ok": False,
                "version": None,
                "error": (
                    f"deepseek-tui --version rc={proc.returncode}: "
                    f"{err.decode('utf-8', 'replace')[:200]}"
                ),
            }

        version = out.decode("utf-8", "replace").strip()

        # 2. config template exists + parseable
        template_path = os.environ.get(
            "MOSS_DEEPSEEK_CONFIG_TEMPLATE", DEFAULT_CONFIG_TEMPLATE,
        )
        if not Path(template_path).is_file():
            return {
                "ok": False,
                "version": version,
                "error": (
                    f"MOSS_DEEPSEEK_CONFIG_TEMPLATE={template_path} not a file. "
                    "Run `deepseek-tui login` to create it, or set "
                    "MOSS_DEEPSEEK_CONFIG_TEMPLATE to your config.toml path."
                ),
            }
        try:
            with open(template_path, "rb") as f:
                tomllib.load(f)
        except Exception as e:  # noqa: BLE001
            return {
                "ok": False,
                "version": version,
                "error": f"config template at {template_path} not valid TOML: {e}",
            }

        return {"ok": True, "version": version, "error": None}

    async def kill_orphans(self) -> dict[str, Any]:
        proc = await asyncio.create_subprocess_exec(
            "pkill", "-TERM", "-f", PKILL_MARKER,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        return {
            "provider": "deepseek-tui",
            "rc": proc.returncode,
            "stderr_tail": err.decode("utf-8", "replace")[-200:],
        }

    async def spawn_role(
        self,
        *,
        role: str,
        system_prompt: str,
        user_input: str,
        add_dirs: list[str],  # intentionally ignored; workspace = cwd (spec §5.5)
        cwd: str,
        timeout_s: float,
        resume_session_id: str | None,  # silently ignored; exec mode doesn't persist (spec §2.5)
        output_log_dir: str,
    ):
        Path(output_log_dir).mkdir(parents=True, exist_ok=True)
        stderr_log = Path(output_log_dir) / f"{role}.stderr.log"
        raw_json_log = Path(output_log_dir) / f"{role}.raw.json"

        # 1. mktemp scratch dir for this spawn's instructions + config
        tmp_dir = tempfile.mkdtemp(prefix=MOSS_TMP_PREFIX)
        try:
            instructions_path = Path(tmp_dir) / "instructions.md"
            config_path = Path(tmp_dir) / "config.toml"

            # 2. write system prompt (with marker prefix) to instructions.md
            instructions_path.write_text(
                f"{MOSS_SYSTEM_MARKER}\n{system_prompt}",
                encoding="utf-8",
            )

            # 3. clone user's config template, inject our instructions ref +
            # optional model override from MOSS_DEEPSEEK_MODEL env
            try:
                config_toml = _render_tmp_config(
                    template_path=os.environ.get(
                        "MOSS_DEEPSEEK_CONFIG_TEMPLATE", DEFAULT_CONFIG_TEMPLATE),
                    instructions_abs_path=str(instructions_path),
                    model_override=os.environ.get("MOSS_DEEPSEEK_MODEL") or None,
                )
            except Exception as e:  # noqa: BLE001
                yield AgentStreamEvent(
                    kind="error",
                    message=f"deepseek config render error: {e}",
                )
                return
            config_path.write_text(config_toml, encoding="utf-8")

            # 4. build argv. Workspace ALWAYS = cwd (spec §5.5).
            # Round-1 hardening additions (2026-05-18):
            #   --max-subagents 1     : caps fan-out (issue #510 mutex contention)
            #   --no-project-config   : refuses workspace-level overlay (defensive)
            cmd = [
                DEEPSEEK_TUI_BIN,
                "--config", str(config_path),
                "-w", cwd,
                "--max-subagents", "1",
                "--no-project-config",
                "exec", "--auto", "--json",
                user_input,
            ]

            # 5. build env. Round-1 hardening: set defensive defaults but do
            # NOT clobber values the user already set (setdefault semantics).
            #   APPROVAL_POLICY=never           belt-and-suspenders for --yolo-ish auto-approval
            #   SANDBOX_MODE=workspace-write    portable; doesn't need Linux Landlock kernel
            #   STREAM_IDLE_TIMEOUT_SECS=600    DS3.2 reasoning pauses; default 300 too tight
            #   STREAM_OPEN_TIMEOUT_SECS=90     SGLang cold-warm; default 45 too tight
            # The two timeout vars are v0.8.32+; on v0.8.14 they're silently ignored.
            env = os.environ.copy()
            env.setdefault("DEEPSEEK_APPROVAL_POLICY", "never")
            env.setdefault("DEEPSEEK_SANDBOX_MODE", "workspace-write")
            env.setdefault("DEEPSEEK_STREAM_IDLE_TIMEOUT_SECS", "600")
            env.setdefault("DEEPSEEK_STREAM_OPEN_TIMEOUT_SECS", "90")

            # 6. spawn — stdin DEVNULL defensive, stderr to log file
            started = time.monotonic()
            stderr_fp = None
            try:
                stderr_fp = open(stderr_log, "wb")
                proc = None
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
                        message=f"deepseek-tui exec error: {e}",
                    )
                    return

                # 6. read stdout to EOF, with timeout
                try:
                    stdout_bytes = await asyncio.wait_for(
                        proc.stdout.read(), timeout=timeout_s,
                    )
                except asyncio.TimeoutError:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
                    yield AgentStreamEvent(
                        kind="error",
                        message=f"deepseek-tui timeout after {timeout_s}s",
                    )
                    return

                rc = await proc.wait()
                elapsed = time.monotonic() - started

                # 7. preserve raw json for post-hoc debugging
                try:
                    raw_json_log.write_bytes(stdout_bytes)
                except Exception:  # noqa: BLE001
                    pass

                # 8. parse + transform
                try:
                    result = json.loads(stdout_bytes.decode("utf-8"))
                except Exception as e:  # noqa: BLE001
                    yield AgentStreamEvent(
                        kind="error",
                        message=(
                            f"deepseek-tui output not valid JSON: {e}; "
                            f"head={stdout_bytes[:200]!r}"
                        ),
                    )
                    return

                model = result.get("model", "") or ""
                status = result.get("status", "")

                # 8a. one synthetic event per tool call (defensive against null)
                for tool_call in (result.get("tools") or []):
                    yield AgentStreamEvent(
                        kind="event",
                        raw_event={
                            "type": "tool_call",
                            "tool": tool_call.get("name", "?"),
                            "success": tool_call.get("success", None),
                        },
                    )

                # 8b. one synthetic Claude-shape "assistant" event so the
                # existing extract-md.ts recognizes the final text via its
                # Claude branch (spec §2.4 — zero TS change)
                assistant_text = result.get("output", "") or ""
                if assistant_text:
                    yield AgentStreamEvent(
                        kind="event",
                        raw_event={
                            "type": "assistant",
                            "message": {
                                "role": "assistant",
                                "content": [
                                    {"type": "text", "text": assistant_text},
                                ],
                            },
                        },
                    )

                # 8c. terminal event (error if status=failed, else result)
                if status == "failed":
                    yield AgentStreamEvent(
                        kind="error",
                        message=f"deepseek-tui agent failed: {result.get('error', 'unknown')}",
                    )
                    return

                yield AgentStreamEvent(
                    kind="result",
                    session_id="",  # not available from exec mode
                    tokens=None,    # not reported by deepseek-tui --json
                    cost_usd=None,  # not reported
                    model=model,
                    exit_code=rc,
                    elapsed_s=elapsed,
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
                    message=f"deepseek-tui spawn error: {e}",
                )
            finally:
                if stderr_fp is not None:
                    try:
                        stderr_fp.close()
                    except Exception:  # noqa: BLE001
                        pass
        finally:
            # ALWAYS clean up tmp dir — runs on success, error, timeout, cancel.
            shutil.rmtree(tmp_dir, ignore_errors=True)
