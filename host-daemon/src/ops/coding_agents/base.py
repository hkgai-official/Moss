"""Provider-neutral base types for coding-agent runners.

See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §4 for
rationale and contract details.
"""
from __future__ import annotations

import asyncio
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal


async def _read_line_unbounded(
    reader: asyncio.StreamReader,
    buffer: bytearray,
    timeout_s: float,
) -> bytes | None:
    """Read one '\\n'-terminated line with NO upper bound on line length.

    asyncio.StreamReader.readline() defaults to 64 KB; stream-json events
    from coding-agent CLIs can be much larger (final assistant message can
    hit MBs). This function reads in 64KB chunks and reassembles lines via
    a caller-owned `buffer` (bytearray). The buffer holds any post-newline
    residue between calls — avoids the StreamReader feed_data-after-feed_eof
    failure mode that bit the previous "push tail back into reader" design.

    Args:
        reader: asyncio.StreamReader (typically subprocess stdout).
        buffer: caller-owned bytearray holding inter-call residue.
                Initialize as bytearray() before first call.
        timeout_s: overall deadline for this single line read.

    Returns:
        - bytes (the line, including the trailing '\\n') when a line completes.
        - bytes (residual data without '\\n') if EOF arrives mid-line.
        - None if EOF arrives with no data buffered.

    Raises:
        asyncio.TimeoutError on deadline exceeded.
    """
    deadline = time.monotonic() + timeout_s
    while True:
        nl = buffer.find(b"\n")
        if nl >= 0:
            line = bytes(buffer[: nl + 1])
            del buffer[: nl + 1]
            return line

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise asyncio.TimeoutError()
        try:
            data = await asyncio.wait_for(reader.read(65536), timeout=remaining)
        except asyncio.TimeoutError:
            raise
        if not data:
            # EOF. If buffer has a partial final line (no trailing \n),
            # return it; otherwise signal "no more lines" with None.
            if buffer:
                line = bytes(buffer)
                buffer.clear()
                return line
            return None
        buffer.extend(data)


@dataclass
class AgentTokens:
    """Token usage breakdown. All counts in raw tokens (not micro-tokens).

    cache_read and cache_write are split because they have different per-token
    costs (cache-write ~1.25x input, cache-read ~0.1x input for Claude). A
    runner that doesn't distinguish them must fill cache_read only (the
    common case for read-heavy workloads like ours).
    """
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int = 0  # for reasoning models; 0 if N/A


@dataclass
class AgentStreamEvent:
    """Provider-neutral wire event emitted by a runner during spawn_role.

    Three event kinds with strict per-kind invariants:

      - "event":  intermediate stream-json event from the CLI.
                  Required: raw_event.
                  Optional metadata extracted as the stream progresses:
                  session_id, tokens, cost_usd, model.
                  exit_code, elapsed_s, message MUST be None.
                  raw_event is the opaque CLI-native JSON object; do NOT
                  parse it in consumers (kept opaque so providers stay
                  decoupled from stage code). Consumers record raw_event
                  into the trace.
      - "result": one-shot terminal event when CLI exits cleanly.
                  Required: exit_code, elapsed_s, session_id, model.
                  Optional: tokens, cost_usd (one MUST be set if pricing is
                  desired downstream; both may be set).
                  message MUST be None. raw_event MAY be empty.
      - "error":  spawn failed (timeout, bad exec, CLI returned error JSON).
                  Required: message.
                  Optional: exit_code, elapsed_s (best-effort).
                  session_id, tokens, cost_usd, model MUST be None.
    """
    kind: Literal["event", "result", "error"]
    raw_event: dict[str, Any] = field(default_factory=dict)
    session_id: str | None = None
    tokens: AgentTokens | None = None
    cost_usd: float | None = None  # only set when CLI reports natively
    model: str | None = None       # which model the runner actually used
    exit_code: int | None = None
    elapsed_s: float | None = None
    message: str | None = None     # error kind only


class CodingAgentRunner(ABC):
    """Base for spawning evolution role agents.

    One subclass per CLI (Claude, Codex, future).
    Subclasses MUST be stateless / thread-safe — registry holds one
    instance per provider, shared across all concurrent spawns.
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Stable identifier used in payloads, env vars, logs. e.g. 'claude'."""

    @abstractmethod
    async def preflight(self) -> dict[str, Any]:
        """Verify the underlying CLI is installed + usable.

        Called at daemon boot for the ACTIVE provider (resolved from
        MOSS_AGENT_PROVIDER); inactive providers are skipped (no-op).
        Returns: {"ok": bool, "version": str | None, "error": str | None}
        Must NOT raise — return ok=False with a clear error message instead.
        Should be cheap (< 1s); typically runs `<bin> --version`.
        """

    @abstractmethod
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
    ) -> AsyncIterator[AgentStreamEvent]:
        """Spawn one role agent. Yields events until 'result' or 'error'.

        Contract:
          - Last yield is always exactly one 'result' or one 'error' event.
          - Stdin to CLI MUST be DEVNULL or closed-after-write (some CLIs
            hang waiting on stdin even when prompt is passed positionally
            — see openai/codex#20919).
          - On asyncio.CancelledError, MUST kill subprocess and re-raise.
          - On timeout, yield 'error' and clean up subprocess.
          - stderr goes to {output_log_dir}/{role}.stderr.log
          - System prompt MUST have provider's MOSS-EVOLUTION-MARKER
            sentinel prepended in argv (per spec §2.5).
        """

    @abstractmethod
    async def kill_orphans(self) -> dict[str, Any]:
        """Best-effort kill of orphan subprocesses from this provider.

        Both Claude and Codex runners share the same MOSS-EVOLUTION-MARKER
        sentinel (per spec §2.5); the per-runner method exists so a future
        runner with a different cleanup mechanism (PID file, etc.) can
        override without changing the base.

        Returns:
          { "provider": str, "rc": int, "stderr_tail": str }
          rc=0 → killed >=1, rc=1 → no match (treat as success).
        """
