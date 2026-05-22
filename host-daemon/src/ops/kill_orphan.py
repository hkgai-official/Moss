"""Walk registered coding-agent runners and kill their orphan subprocesses.

Each runner knows how to find its own orphans via a per-provider mechanism
(pkill marker, PID file, etc). Both Claude and Codex currently use the same
MOSS-EVOLUTION-MARKER sentinel; the per-runner abstraction keeps the door
open for a future runner with different cleanup semantics.

Called by /api/evolution/stop to immediately stop burning tokens when a user
clicks Stop, since spawned CLI subprocesses live on the host (not in the
moss-gateway container) and won't be reached by `docker compose restart`.

See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §5.3.
"""
from __future__ import annotations

from typing import Any, AsyncIterator

from src.protocol import Response


async def handle_kill_orphan(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    """Kill orphans across providers.

    Payload:
      providers?: list[str]  # optional whitelist; default = all registered
    """
    # Lazy import to avoid circular import on module load.
    from src.ops.coding_agents import get_runner, list_providers

    requested: list[str] = payload.get("providers") or list_providers()
    results: list[dict[str, Any]] = []
    for name in requested:
        runner = get_runner(name)
        if runner is None:
            results.append({"provider": name, "rc": -1, "error": "unknown provider"})
            continue
        try:
            results.append(await runner.kill_orphans())
        except Exception as e:  # noqa: BLE001 — best-effort cleanup
            results.append({"provider": name, "rc": -1, "error": str(e)})
    yield Response(id=req_id, type="result", data={"results": results})
