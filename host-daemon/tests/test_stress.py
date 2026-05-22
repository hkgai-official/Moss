"""Stress: 10 concurrent clients, 5 sequential ops each, no message loss.

Uses unknown-op path (one deterministic error response per request) so the
test exercises the server's framing + concurrency without depending on real
claude CLI or docker.
"""
import asyncio
import json
import os
import tempfile

import pytest

from src.server import serve


@pytest.mark.asyncio
async def test_concurrent_clients_no_event_loss():
    with tempfile.TemporaryDirectory() as td:
        sock = os.path.join(td, "stress.sock")
        srv = asyncio.create_task(serve(sock))
        await asyncio.sleep(0.1)
        try:

            async def one_client(i: int) -> None:
                for j in range(5):
                    reader, writer = await asyncio.open_unix_connection(sock)
                    writer.write(
                        f'{{"id":"c{i}-{j}","op":"__nonexistent__","payload":{{}}}}\n'.encode()
                    )
                    await writer.drain()
                    msgs = []
                    while True:
                        line = await reader.readline()
                        if not line:
                            break
                        msgs.append(json.loads(line))
                    writer.close()
                    assert len(msgs) == 1, f"client {i} op {j} got {len(msgs)} msgs, expected 1"
                    assert msgs[0]["type"] == "error"
                    assert "unknown op" in msgs[0]["data"]["message"]

            await asyncio.gather(*(one_client(i) for i in range(10)))
        finally:
            srv.cancel()
            try:
                await srv
            except asyncio.CancelledError:
                pass
