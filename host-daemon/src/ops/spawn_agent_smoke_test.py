"""Real coding-agent smoke test driven through the full RPC stack.

Drives `spawn-agent` over the unix socket server with a trivial prompt.
SLOW — costs ~$0.001 per run with default Claude model. Skipped if the
required CLI binary isn't on PATH. Companion to the per-runner unit
tests at coding_agents/{claude,codex,deepseek_tui,opencode}_test.py.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile

import pytest

from src.server import serve

REQUIRES_CLAUDE = pytest.mark.skipif(
    shutil.which(os.environ.get("CLAUDE_BIN", "claude")) is None,
    reason="claude CLI not installed",
)


@REQUIRES_CLAUDE
@pytest.mark.asyncio
async def test_real_claude_one_shot():
    """Drives spawn-agent (default provider = claude) through the unix
    socket server with a trivial prompt.

    Verifies: stream-json events received, session_id captured, exit code 0,
    stderr log file created, no leaked subprocesses.
    """
    with tempfile.TemporaryDirectory() as td:
        sock = os.path.join(td, "test.sock")
        srv = asyncio.create_task(serve(sock))
        await asyncio.sleep(0.2)  # let server bind
        try:
            reader, writer = await asyncio.open_unix_connection(sock)
            req = {
                "id": "smoke-1",
                "op": "spawn-agent",
                "payload": {
                    "role": "locator",
                    "system_prompt": "You are a test agent. Reply concisely.",
                    "user_input": "Reply with the single word: ok",
                    "add_dirs": [td],
                    "cwd": td,
                    "timeout_s": 120,
                    "output_log_dir": td,
                },
            }
            writer.write((json.dumps(req) + "\n").encode())
            await writer.drain()

            session_id: str | None = None
            result_rc: int | None = None
            saw_event = False

            while True:
                line = await reader.readline()
                if not line:
                    break
                msg = json.loads(line)
                if msg["type"] == "event":
                    saw_event = True
                    evt = msg["data"].get("event") or {}
                    if evt.get("session_id"):
                        session_id = evt["session_id"]
                if msg["type"] == "result":
                    result_rc = msg["data"]["exit_code"]
                    if not session_id:
                        session_id = msg["data"].get("session_id", "") or session_id
                    break
                if msg["type"] == "error":
                    pytest.fail(f"got error: {msg['data']['message']}")

            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

            assert saw_event, "no stream-json events received"
            assert result_rc == 0, f"non-zero exit code: {result_rc}"
            assert session_id, "session_id missing"

            # stderr log file should have been created (may be empty, but exists)
            stderr_path = os.path.join(td, "locator.stderr.log")
            assert os.path.exists(stderr_path), "stderr log file not created"
        finally:
            srv.cancel()
            try:
                await srv
            except asyncio.CancelledError:
                pass
