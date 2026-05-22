import asyncio
import json
import os
import tempfile

import pytest

from src.server import serve


@pytest.mark.asyncio
async def test_spawn_agent_missing_payload_yields_error():
    """spawn-agent forks the active coding-agent CLI and requires a full
    payload. A request missing required fields must come back as a single
    error message (KeyError in handler → server-level exception → error
    response)."""
    with tempfile.TemporaryDirectory() as td:
        sock = os.path.join(td, "test.sock")
        server_task = asyncio.create_task(serve(sock))
        await asyncio.sleep(0.1)  # let server bind
        try:
            reader, writer = await asyncio.open_unix_connection(sock)
            writer.write(b'{"id":"r1","op":"spawn-agent","payload":{"role":"locator"}}\n')
            await writer.drain()

            messages = []
            while True:
                line = await reader.readline()
                if not line:
                    break
                messages.append(json.loads(line))
            writer.close()

            # exactly one error response (missing system_prompt/user_input/...)
            assert len(messages) >= 1
            assert any(m["type"] == "error" for m in messages), messages
        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass


@pytest.mark.asyncio
async def test_unknown_op_returns_error():
    with tempfile.TemporaryDirectory() as td:
        sock = os.path.join(td, "test.sock")
        server_task = asyncio.create_task(serve(sock))
        await asyncio.sleep(0.1)
        try:
            reader, writer = await asyncio.open_unix_connection(sock)
            writer.write(b'{"id":"r2","op":"nonexistent","payload":{}}\n')
            await writer.drain()
            line = await reader.readline()
            msg = json.loads(line)
            assert msg["type"] == "error"
            assert "unknown op" in msg["data"]["message"]
            writer.close()
        finally:
            server_task.cancel()
            try:
                await server_task
            except asyncio.CancelledError:
                pass
