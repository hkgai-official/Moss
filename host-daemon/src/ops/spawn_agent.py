"""Generic coding-agent spawn dispatcher.

Replaces src/ops/spawn_claude.py. Selects the runner via MOSS_AGENT_PROVIDER
(or payload.agent_override) and forwards events/results back as Response.

See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §4.
"""
from __future__ import annotations

from typing import Any, AsyncIterator

from src.protocol import Response

from .coding_agents import get_runner, resolve_default
from .coding_agents.base import AgentTokens


def _tokens_to_dict(t: AgentTokens | None) -> dict[str, int] | None:
    if t is None:
        return None
    return {
        "input": t.input,
        "output": t.output,
        "cache_read": t.cache_read,
        "cache_write": t.cache_write,
        "reasoning": t.reasoning,
    }


async def handle(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    """Dispatch a coding-agent spawn to the configured provider.

    Payload fields:
      role, system_prompt, user_input, add_dirs, cwd, timeout_s,
      resume_session_id, output_log_dir,
      agent_override?: str  # optional per-spawn provider override

    Yields:
      Response (event)* — opaque CLI events
      Response (result)  — terminal {exit_code, elapsed_s, session_id, cost_usd, tokens, provider, model}
      OR Response (error) — {message}
    """
    provider = payload.get("agent_override") or resolve_default()
    runner = get_runner(provider)
    if runner is None:
        yield Response(
            id=req_id, type="error", data={"message": f"unknown provider: {provider}"},
        )
        return

    args = dict(
        role=payload["role"],
        system_prompt=payload["system_prompt"],
        user_input=payload["user_input"],
        add_dirs=payload.get("add_dirs", []),
        cwd=payload["cwd"],
        timeout_s=float(payload.get("timeout_s", 1800)),
        resume_session_id=payload.get("resume_session_id"),
        output_log_dir=payload["output_log_dir"],
    )

    session_id = ""
    tokens: AgentTokens | None = None
    cost_usd: float | None = None
    model = ""
    exit_code = -1
    elapsed_s = 0.0

    async for ev in runner.spawn_role(**args):
        if ev.kind == "event":
            yield Response(id=req_id, type="event", data={"event": ev.raw_event})
            if ev.session_id:
                session_id = ev.session_id
            if ev.cost_usd is not None:
                cost_usd = ev.cost_usd
            if ev.tokens is not None:
                tokens = ev.tokens
            if ev.model:
                model = ev.model
        elif ev.kind == "result":
            session_id = ev.session_id or session_id
            tokens = ev.tokens or tokens
            cost_usd = ev.cost_usd if ev.cost_usd is not None else cost_usd
            model = ev.model or model
            if ev.exit_code is not None:
                exit_code = ev.exit_code
            if ev.elapsed_s is not None:
                elapsed_s = ev.elapsed_s
        elif ev.kind == "error":
            yield Response(
                id=req_id, type="error", data={"message": ev.message or "spawn error"},
            )
            return

    yield Response(id=req_id, type="result", data={
        "exit_code": exit_code,
        "elapsed_s": elapsed_s,
        "session_id": session_id,
        "cost_usd": cost_usd if cost_usd is not None else 0.0,
        "tokens": _tokens_to_dict(tokens),
        "provider": provider,
        "model": model,
    })
