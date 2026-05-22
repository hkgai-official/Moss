"""asyncio unix socket server. Reads JSON-line requests, dispatches to ops,
streams responses back. Closes connection on op completion or socket break."""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, AsyncIterator, Awaitable, Callable

from src.ops import auto_scan, docker_rpc, kill_orphan, spawn_agent, trial_runner

# Importing the coding_agents package triggers __init__.py auto-registration.
import src.ops.coding_agents  # noqa: F401

from src.protocol import Request, Response

log = logging.getLogger("moss-daemon")

# Each handler is an async generator returning Response objects.
OpHandler = Callable[[str, dict[str, Any]], AsyncIterator[Response]]

OP_TABLE: dict[str, OpHandler] = {
    # Canonical names (post-2026-05-17 multi-coding-agent abstraction)
    "spawn-agent": spawn_agent.handle,
    "kill-orphan": kill_orphan.handle_kill_orphan,
    # Unchanged ops
    "docker-build": docker_rpc.handle_build,
    "run-trial": trial_runner.handle_run_trial,
    "run-user-mode-batch-trial": trial_runner.handle_run_user_mode_batch_trial,
    "build-smoke": docker_rpc.handle_build_smoke,
    "hard-reset-openclaw": docker_rpc.handle_hard_reset,
    "commit-openclaw-iter": docker_rpc.handle_commit_openclaw_iter,
    "get-baseline-commit": docker_rpc.handle_get_baseline_commit,
    # Auto-scan engine (passive; trigger layer out of scope — see
    # docs/specs/2026-05-18-auto-scan-engine.md)
    "auto-scan-session": auto_scan.handle_auto_scan_session,
    "auto-scan-catch-up": auto_scan.handle_auto_scan_catch_up,
    "auto-scan-batch-list": auto_scan.handle_auto_scan_batch_list,
    "auto-scan-batch-detail": auto_scan.handle_auto_scan_batch_detail,
}


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        line = await reader.readline()
        if not line:
            return
        try:
            req = Request.parse(line.decode().strip())
        except (ValueError, KeyError) as e:
            writer.write(
                Response(id="?", type="error", data={"message": f"bad request: {e}"})
                .serialize()
                .encode()
            )
            await writer.drain()
            return

        handler = OP_TABLE.get(req.op)
        if handler is None:
            writer.write(
                Response(id=req.id, type="error", data={"message": f"unknown op: {req.op}"})
                .serialize()
                .encode()
            )
            await writer.drain()
            return

        async for resp in handler(req.id, req.payload):
            writer.write(resp.serialize().encode())
            await writer.drain()
    except Exception as e:
        log.exception("client handler error")
        try:
            writer.write(
                Response(id="?", type="error", data={"message": str(e)}).serialize().encode()
            )
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def serve(sock_path: str) -> None:
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    server = await asyncio.start_unix_server(handle_client, path=sock_path)
    os.chmod(sock_path, 0o666)
    log.info(f"listening on {sock_path}")
    async with server:
        await server.serve_forever()
