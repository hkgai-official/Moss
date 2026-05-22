"""Tests for auto_scan engine.

Pattern mirrors docker_rpc_test.py: tempfile fixtures for filesystem isolation,
monkeypatch for env vars, no real LLM calls (spawn-agent mocked).
"""
from __future__ import annotations

import json
import os
import re as _re
from pathlib import Path

import pytest

from src.ops import auto_scan
from src.protocol import Response


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

def _make_jsonl(turns: list[dict]) -> bytes:
    return b"".join(json.dumps(t).encode("utf-8") + b"\n" for t in turns)


def _setup_data_dir(tmp_path):
    """Create the agents/<id>/sessions/ source dir + return (data_dir, sessions_dir)."""
    data = tmp_path / "data"
    sessions = data / "agents" / "main" / "sessions"
    sessions.mkdir(parents=True)
    return data, sessions


# ---------------------------------------------------------------------------
# is_real_user_text_line
# ---------------------------------------------------------------------------

def test_is_real_user_text_line_recognizes_user_text():
    assert auto_scan.is_real_user_text_line(
        {"role": "user", "content": [{"type": "text", "text": "hi"}]},
    ) is True


def test_is_real_user_text_line_skips_tool_result():
    assert auto_scan.is_real_user_text_line(
        {"role": "user", "content": [{"type": "tool_result", "content": "..."}]},
    ) is False


def test_is_real_user_text_line_skips_assistant():
    assert auto_scan.is_real_user_text_line(
        {"role": "assistant", "content": [{"type": "text", "text": "..."}]},
    ) is False


def test_is_real_user_text_line_handles_malformed_line():
    assert auto_scan.is_real_user_text_line({}) is False
    assert auto_scan.is_real_user_text_line({"role": "user"}) is False
    assert auto_scan.is_real_user_text_line({"role": "user", "content": []}) is False
    assert auto_scan.is_real_user_text_line({"role": "user", "content": "string"}) is False


def test_is_real_user_text_line_recognizes_openclaw_wrapped_format():
    # Real OpenClaw JSONL wraps message: {"type": "message", "message": {"role": ..., "content": [...]}}
    assert auto_scan.is_real_user_text_line(
        {"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
    ) is True


def test_is_real_user_text_line_rejects_openclaw_wrapped_tool_result():
    assert auto_scan.is_real_user_text_line(
        {"type": "message", "message": {"role": "user", "content": [{"type": "tool_result", "content": "..."}]}},
    ) is False


def test_is_real_user_text_line_rejects_openclaw_wrapped_assistant():
    assert auto_scan.is_real_user_text_line(
        {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}},
    ) is False


def test_is_real_user_text_line_rejects_openclaw_non_message_types():
    # model_change, thinking_level_change, custom, session lines should all be rejected
    assert auto_scan.is_real_user_text_line({"type": "model_change", "modelId": "DS3.2"}) is False
    assert auto_scan.is_real_user_text_line({"type": "session", "version": 3}) is False


# ---------------------------------------------------------------------------
# find_chunk_boundary
# ---------------------------------------------------------------------------

def test_find_boundary_returns_latest_user_text(tmp_path):
    turns = [
        {"role": "user", "content": [{"type": "text", "text": "first"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "..."}]},
        {"role": "user", "content": [{"type": "tool_result", "content": "..."}]},
        {"role": "user", "content": [{"type": "text", "text": "second"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "..."}]},
    ]
    source = tmp_path / "session.jsonl"
    source.write_bytes(_make_jsonl(turns))

    line0_len = len(json.dumps(turns[0]).encode("utf-8")) + 1
    line1_len = len(json.dumps(turns[1]).encode("utf-8")) + 1
    line2_len = len(json.dumps(turns[2]).encode("utf-8")) + 1
    expected_boundary = line0_len + line1_len + line2_len

    boundary = auto_scan.find_chunk_boundary(str(source), start_byte=0)
    assert boundary == expected_boundary


def test_find_boundary_returns_none_when_no_user_text(tmp_path):
    turns = [
        {"role": "assistant", "content": [{"type": "text", "text": "..."}]},
        {"role": "user", "content": [{"type": "tool_result", "content": "..."}]},
        {"role": "assistant", "content": [{"type": "text", "text": "..."}]},
    ]
    source = tmp_path / "session.jsonl"
    source.write_bytes(_make_jsonl(turns))
    assert auto_scan.find_chunk_boundary(str(source), start_byte=0) is None


def test_find_boundary_starts_from_start_byte(tmp_path):
    turns = [
        {"role": "user", "content": [{"type": "text", "text": "ignored"}]},
        {"role": "user", "content": [{"type": "text", "text": "found"}]},
    ]
    source = tmp_path / "session.jsonl"
    source.write_bytes(_make_jsonl(turns))
    line0_len = len(json.dumps(turns[0]).encode("utf-8")) + 1
    boundary = auto_scan.find_chunk_boundary(str(source), start_byte=line0_len)
    assert boundary == line0_len


def test_find_boundary_skips_malformed_jsonl_lines(tmp_path):
    source = tmp_path / "session.jsonl"
    valid = json.dumps({"role": "user", "content": [{"type": "text", "text": "ok"}]}).encode("utf-8")
    source.write_bytes(b"this is not json\n" + valid + b"\n")
    boundary = auto_scan.find_chunk_boundary(str(source), start_byte=0)
    assert boundary == len(b"this is not json\n")


def test_find_boundary_recognizes_openclaw_wrapped_user_turns(tmp_path):
    # Real OpenClaw JSONL uses {type: "message", message: {role: ..., content: [...]}}
    # The boundary finder must detect these, not just flat {role: ..., content: [...]} format.
    def _wrap(role, content_type, text):
        return {"type": "message", "id": "x", "message": {"role": role, "content": [{"type": content_type, "text": text}]}}

    turns = [
        {"type": "session", "version": 3, "id": "s1"},
        _wrap("user", "text", "hello"),
        _wrap("assistant", "text", "hi"),
        _wrap("user", "text", "follow up"),  # this should be the boundary
        _wrap("assistant", "text", "done"),
    ]
    source = tmp_path / "session.jsonl"
    source.write_bytes(_make_jsonl(turns))

    line0_len = len(json.dumps(turns[0]).encode("utf-8")) + 1
    line1_len = len(json.dumps(turns[1]).encode("utf-8")) + 1
    line2_len = len(json.dumps(turns[2]).encode("utf-8")) + 1
    expected_boundary = line0_len + line1_len + line2_len  # offset of "follow up" line

    boundary = auto_scan.find_chunk_boundary(str(source), start_byte=0)
    assert boundary == expected_boundary


# ---------------------------------------------------------------------------
# Cursor read/write
# ---------------------------------------------------------------------------

def test_cursor_init_defaults_when_missing(tmp_path):
    state_dir = tmp_path / "auto-scan" / "sess1"
    cursor = auto_scan.load_cursor(str(state_dir))
    assert cursor == {
        "last_copied_byte": 0,
        "next_chunk_index": 0,
        "last_seen_mtime": 0,
        "last_seen_size": 0,
    }


def test_cursor_round_trip(tmp_path):
    state_dir = tmp_path / "auto-scan" / "sess1"
    state_dir.mkdir(parents=True)
    auto_scan.save_cursor(str(state_dir), {
        "last_copied_byte": 12345,
        "next_chunk_index": 3,
        "last_seen_mtime": 1778570440100,
        "last_seen_size": 50000,
    })
    loaded = auto_scan.load_cursor(str(state_dir))
    assert loaded["last_copied_byte"] == 12345
    assert loaded["next_chunk_index"] == 3


def test_cursor_corruption_resets_to_default(tmp_path):
    state_dir = tmp_path / "auto-scan" / "sess1"
    state_dir.mkdir(parents=True)
    (state_dir / "cursor.json").write_text("not valid json{{{")
    loaded = auto_scan.load_cursor(str(state_dir))
    assert loaded["last_copied_byte"] == 0


def test_cursor_save_is_atomic(tmp_path):
    state_dir = tmp_path / "auto-scan" / "sess1"
    state_dir.mkdir(parents=True)
    auto_scan.save_cursor(str(state_dir), {
        "last_copied_byte": 100,
        "next_chunk_index": 1,
        "last_seen_mtime": 0,
        "last_seen_size": 100,
    })
    files = sorted(p.name for p in state_dir.iterdir())
    assert files == ["cursor.json"]


# ---------------------------------------------------------------------------
# extract_chunk
# ---------------------------------------------------------------------------

def test_extract_chunk_bytes_match_source(tmp_path):
    source = tmp_path / "src.jsonl"
    source.write_bytes(b"line0\nline1\nline2\n")
    state_dir = tmp_path / "auto-scan" / "sess1"

    chunk_path = auto_scan.extract_chunk(
        source_path=str(source),
        state_dir=str(state_dir),
        start_byte=6,
        end_byte=12,
        chunk_index=0,
    )
    assert Path(chunk_path).read_bytes() == b"line1\n"
    assert chunk_path == str(state_dir / "chunk_0.jsonl")


def test_extract_chunk_uses_atomic_temp_rename(tmp_path):
    source = tmp_path / "src.jsonl"
    source.write_bytes(b"line0\nline1\n")
    state_dir = tmp_path / "auto-scan" / "sess1"
    auto_scan.extract_chunk(str(source), str(state_dir), 0, 6, chunk_index=0)
    files = sorted(p.name for p in state_dir.iterdir())
    assert files == ["chunk_0.jsonl"]


# ---------------------------------------------------------------------------
# parse_weak_keypoints
# ---------------------------------------------------------------------------

SAMPLE_EVAL_OUTPUT = """\
# Task Evaluator output

## Section 1: Execution Logic Summary

The agent did things.

## Section 2: Keypoint Assessments

### `tool_selection` — adequate

Looked fine.

### `tool_sequencing` — weak

Did things out of order.

### `error_recovery` — missing

Never tried.

### `completion_correctness` — strong

Done well.

## Section 3: Flakiness Note

N/A — single trial.
"""


def test_parse_evaluator_weak_keypoints():
    weak = auto_scan.parse_weak_keypoints(SAMPLE_EVAL_OUTPUT)
    assert sorted(weak) == ["error_recovery", "tool_sequencing"]


def test_parse_evaluator_returns_empty_when_all_ok():
    text = "### `tool_selection` — strong\n\n### `error_recovery` — adequate\n"
    assert auto_scan.parse_weak_keypoints(text) == []


def test_parse_evaluator_handles_no_keypoint_sections():
    assert auto_scan.parse_weak_keypoints("just some prose") == []


# ---------------------------------------------------------------------------
# invoke_task_evaluator (mocked spawn-agent)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_invoke_task_evaluator_builds_correct_payload(monkeypatch, tmp_path):
    """Capture the spawn-agent payload and assert key fields; the fake parses
    the output path out of user_input and writes a canned evaluator output there."""
    captured: dict = {}

    async def fake_spawn(req_id, payload):
        captured.update(payload)
        m = _re.search(r"Write your output to:\s*(\S+)", payload["user_input"])
        if m:
            Path(m.group(1)).write_text("### `tool_selection` — adequate\n")
        yield Response(id=req_id, type="result", data={"exit_code": 0})

    monkeypatch.setattr(auto_scan, "_spawn_agent_handle", fake_spawn)
    # _load_task_evaluator_system_prompt reads from MOSS_OPENCLAW_REPO_DIR; mock it
    # to a temp dir with a stub prompt file.
    repo_root = tmp_path / "openclaw"
    prompt_dir = repo_root / "src" / "evolution" / "prompts"
    prompt_dir.mkdir(parents=True)
    (prompt_dir / "task-evaluator.md").write_text(
        "# Task Evaluator — iteration {iteration}/{max_iter}, batch {batch_id}\n",
    )
    monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", str(repo_root))

    chunk_path = tmp_path / "chunk_0.jsonl"
    chunk_path.write_text('{"role":"user","content":[{"type":"text","text":"hi"}]}\n')
    output_md_path = tmp_path / "chunk_0.md"

    ok = await auto_scan.invoke_task_evaluator(
        chunk_path=str(chunk_path),
        output_md_path=str(output_md_path),
        session_id="sess1",
        chunk_index=0,
        spawn_logs_dir=str(tmp_path / "spawn_logs"),
    )
    assert ok is True
    assert captured["role"] == "task-evaluator"
    assert "scan" in captured["system_prompt"]
    assert "auto-scan-sess1-chunk_0" in captured["system_prompt"]
    assert str(output_md_path) in captured["user_input"]
    assert output_md_path.exists()


@pytest.mark.asyncio
async def test_invoke_task_evaluator_returns_false_on_spawn_error(monkeypatch, tmp_path):
    async def fake_error(req_id, payload):
        yield Response(id=req_id, type="error", data={"message": "boom"})

    monkeypatch.setattr(auto_scan, "_spawn_agent_handle", fake_error)
    # Provide a stub prompt file so the prompt loader doesn't crash before spawn.
    repo_root = tmp_path / "openclaw"
    prompt_dir = repo_root / "src" / "evolution" / "prompts"
    prompt_dir.mkdir(parents=True)
    (prompt_dir / "task-evaluator.md").write_text("stub\n")
    monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", str(repo_root))

    chunk_path = tmp_path / "chunk_0.jsonl"
    chunk_path.write_text("{}\n")

    ok = await auto_scan.invoke_task_evaluator(
        chunk_path=str(chunk_path),
        output_md_path=str(tmp_path / "out.md"),
        session_id="sess1",
        chunk_index=0,
        spawn_logs_dir=str(tmp_path / "spawn_logs"),
    )
    assert ok is False


# ---------------------------------------------------------------------------
# handle_auto_scan_session (integration; spawn-agent mocked)
# ---------------------------------------------------------------------------

def _mock_evaluator_writes_weak(monkeypatch):
    async def fake_eval(chunk_path, output_md_path, session_id, chunk_index,
                       spawn_logs_dir, timeout_s=600.0):
        Path(output_md_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_md_path).write_text("### `tool_sequencing` — weak\n\nbad\n")
        return True
    monkeypatch.setattr(auto_scan, "invoke_task_evaluator", fake_eval)


def _mock_evaluator_writes_adequate(monkeypatch):
    async def fake_eval(chunk_path, output_md_path, session_id, chunk_index,
                       spawn_logs_dir, timeout_s=600.0):
        Path(output_md_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_md_path).write_text("### `tool_selection` — adequate\n")
        return True
    monkeypatch.setattr(auto_scan, "invoke_task_evaluator", fake_eval)


def _mock_evaluator_fails(monkeypatch):
    async def fake_eval(chunk_path, output_md_path, session_id, chunk_index,
                       spawn_logs_dir, timeout_s=600.0):
        return False
    monkeypatch.setattr(auto_scan, "invoke_task_evaluator", fake_eval)


@pytest.mark.asyncio
async def test_session_emit_on_archive_suffix(monkeypatch, tmp_path):
    """`*.jsonl.reset.<ts>` → emit whatever's there even under threshold."""
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl.reset.20260518T120000"
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "do X"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))
    _mock_evaluator_writes_weak(monkeypatch)

    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    assert len(msgs) == 1
    assert msgs[0].type == "result"
    assert msgs[0].data["chunks_emitted"] == 1
    assert msgs[0].data["chunks_added"] == 1


@pytest.mark.asyncio
async def test_session_no_emit_below_threshold(monkeypatch, tmp_path):
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl"
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "hi"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))

    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    assert msgs[0].type == "result"
    assert msgs[0].data["chunks_emitted"] == 0


@pytest.mark.asyncio
async def test_session_rejects_path_outside_glob(monkeypatch, tmp_path):
    monkeypatch.setenv("MOSS_DATA_DIR", str(tmp_path))
    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": "/etc/passwd"}):
        msgs.append(r)
    assert msgs[0].type == "error"
    assert ("outside" in msgs[0].data["message"].lower()
            or "invalid" in msgs[0].data["message"].lower())


@pytest.mark.asyncio
async def test_session_skips_deleted_suffix(monkeypatch, tmp_path):
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl.deleted.20260518T120000"
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "x"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))
    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    assert msgs[0].type == "result"
    assert msgs[0].data["chunks_emitted"] == 0
    assert msgs[0].data.get("note") == "deleted_archive_skipped"


@pytest.mark.asyncio
async def test_session_pool_not_added_when_all_adequate(monkeypatch, tmp_path):
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl.reset.20260518T120000"
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "x"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))
    _mock_evaluator_writes_adequate(monkeypatch)

    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    assert msgs[0].data["chunks_emitted"] == 1
    assert msgs[0].data["chunks_added"] == 0


@pytest.mark.asyncio
async def test_session_evaluator_failure_skips_pool(monkeypatch, tmp_path):
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl.reset.20260518T120000"
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "x"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))
    _mock_evaluator_fails(monkeypatch)

    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    assert msgs[0].type == "result"
    assert msgs[0].data["chunks_emitted"] == 1
    assert msgs[0].data["chunks_added"] == 0


@pytest.mark.asyncio
async def test_session_cursor_advances_and_chunk_immutable(monkeypatch, tmp_path):
    """After successful emit, cursor + chunk file persist. A repeat call sees
    no new bytes → no emission (idempotent)."""
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl.reset.20260518T120000"
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "go"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))
    _mock_evaluator_writes_weak(monkeypatch)

    # First call: emits
    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    assert msgs[0].data["chunks_emitted"] == 1

    # Second call: cursor at EOF, no new bytes → no emission
    msgs2 = []
    async for r in auto_scan.handle_auto_scan_session("req2", {"source_path": str(source)}):
        msgs2.append(r)
    assert msgs2[0].data["chunks_emitted"] == 0


# ---------------------------------------------------------------------------
# handle_auto_scan_catch_up
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_catch_up_iterates_active_and_reset(monkeypatch, tmp_path):
    data, sessions = _setup_data_dir(tmp_path)
    (sessions / "sess_active.jsonl").write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "small"}]},
    ]))
    (sessions / "sess_done.jsonl.reset.20260518T120000").write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "go"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))
    _mock_evaluator_writes_weak(monkeypatch)

    msgs = []
    async for r in auto_scan.handle_auto_scan_catch_up("req1", {}):
        msgs.append(r)
    assert msgs[-1].type == "result"
    d = msgs[-1].data
    assert d["sessions_scanned"] == 2
    assert d["total_chunks_emitted"] == 1
    assert d["total_chunks_added"] == 1


# ---------------------------------------------------------------------------
# Source rewrite detection
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_session_resets_cursor_when_source_truncated(monkeypatch, tmp_path):
    """If cursor.last_seen_size > current_size, the source was rewritten →
    cursor resets to 0 before scanning."""
    data, sessions = _setup_data_dir(tmp_path)
    source = sessions / "sess1.jsonl.reset.20260518T120000"
    # Tiny source
    source.write_bytes(_make_jsonl([
        {"role": "user", "content": [{"type": "text", "text": "small"}]},
    ]))
    monkeypatch.setenv("MOSS_DATA_DIR", str(data))

    # Plant a cursor that thinks the file is much larger
    state_dir = Path(data) / "evo-loop-state" / "auto-scan" / "sess1"
    state_dir.mkdir(parents=True)
    auto_scan.save_cursor(str(state_dir), {
        "last_copied_byte": 999999,
        "next_chunk_index": 5,
        "last_seen_mtime": 0,
        "last_seen_size": 999999,
    })

    _mock_evaluator_writes_weak(monkeypatch)

    msgs = []
    async for r in auto_scan.handle_auto_scan_session("req1", {"source_path": str(source)}):
        msgs.append(r)
    # After reset, cursor reads from 0 → emits the full file
    assert msgs[0].data["chunks_emitted"] == 1
    # New cursor should reflect the actual file size, not 999999
    new_cursor = auto_scan.load_cursor(str(state_dir))
    assert new_cursor["last_copied_byte"] == source.stat().st_size
    assert new_cursor["next_chunk_index"] == 1   # incremented from 0, not from 5


# ---------------------------------------------------------------------------
# DEFAULT_BATCH_SIZE + _get_or_create_open_batch
# ---------------------------------------------------------------------------

def test_batch_size_constant():
    from src.ops.auto_scan import DEFAULT_BATCH_SIZE
    assert DEFAULT_BATCH_SIZE == 8

def test_get_or_create_open_batch_creates_when_none(tmp_path):
    from src.ops.auto_scan import _get_or_create_open_batch
    batch_id = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    assert batch_id.startswith("auto-batch-")
    batch_dir = tmp_path / "evo-loop-state" / "auto-scan-batches" / batch_id
    assert batch_dir.is_dir()
    batch_json = batch_dir / "_batch.json"
    assert batch_json.exists()
    with batch_json.open() as f:
        data = json.load(f)
    assert data["sealed"] is False
    assert data["size"] == 0
    assert data["apply_state"] == "open"
    # Bug 2 fix: batch is owned by its source session (jsonl).
    assert data["session_id"] == "sess-A"


def test_get_or_create_open_batch_returns_existing(tmp_path):
    from src.ops.auto_scan import _get_or_create_open_batch
    first = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    second = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    assert first == second

def test_get_or_create_open_batch_skips_sealed(tmp_path):
    from src.ops.auto_scan import _get_or_create_open_batch
    sealed_id = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    bp = tmp_path / "evo-loop-state" / "auto-scan-batches" / sealed_id / "_batch.json"
    data = json.loads(bp.read_text())
    data["sealed"] = True
    bp.write_text(json.dumps(data))
    next_id = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    assert next_id != sealed_id
    assert next_id.startswith("auto-batch-")


# ---------------------------------------------------------------------------
# Bug 2: auto-scan batches are bucketed per-jsonl (per source session), not
# globally pooled. Spec docs/specs/2026-05-19-evolution-control-surface.md §2.2
# previously read "all non-legacy chunks share the same pool" — that was
# based on the misconception that an OpenClaw session == one jsonl. The real
# OpenClaw session is channel-level, the jsonl is conversation-level, so the
# right batch granularity is per-jsonl (= per source session_id).
# ---------------------------------------------------------------------------

def test_open_batch_is_per_session(tmp_path):
    """Two different source sessions get two different open batches."""
    from src.ops.auto_scan import _get_or_create_open_batch
    a = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    b = _get_or_create_open_batch(str(tmp_path), session_id="sess-B")
    assert a != b


def test_open_batch_filters_other_sessions_when_picking_candidate(tmp_path):
    """If an open batch for sess-A exists, sess-B must not reuse it."""
    from src.ops.auto_scan import _get_or_create_open_batch
    a = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    b = _get_or_create_open_batch(str(tmp_path), session_id="sess-B")
    # sess-A asking again gets its own batch back, not B's
    a_again = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    assert a_again == a
    assert a_again != b


def test_open_batch_skips_legacy_batch_without_session_id(tmp_path):
    """Pre-fix batches on disk (no session_id field) must NOT be picked up by
    the new per-session code. They stay frozen; new chunks land in fresh
    per-session batches."""
    from src.ops.auto_scan import _get_or_create_open_batch
    # Simulate a legacy cross-session batch on disk.
    legacy_dir = tmp_path / "evo-loop-state" / "auto-scan-batches" / "auto-batch-legacy-1"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "_batch.json").write_text(json.dumps({
        "id": "auto-batch-legacy-1",
        "created_at": 1700000000000,
        "sealed": False,
        "size": 3,
        "apply_state": "open",
        # NOTE: no "session_id" field — that's the legacy schema.
    }))
    new_id = _get_or_create_open_batch(str(tmp_path), session_id="sess-A")
    assert new_id != "auto-batch-legacy-1"


# ---------------------------------------------------------------------------
# _append_chunk_to_batch
# ---------------------------------------------------------------------------

def test_append_chunk_appends_and_seals_at_full(tmp_path):
    from src.ops.auto_scan import _append_chunk_to_batch, _get_or_create_open_batch, DEFAULT_BATCH_SIZE
    batch_id = _get_or_create_open_batch(str(tmp_path), session_id="sess-test")
    for i in range(DEFAULT_BATCH_SIZE):
        result = _append_chunk_to_batch(str(tmp_path), batch_id, {
            "source": {"agent_id": "a", "session_id": "s", "cursor_start": i * 100, "cursor_end": (i + 1) * 100},
            "weak_keypoints": ["wk1"],
            "evaluator_verdict": "weak",
            "content_path": "fake.jsonl",
        })
        assert result["batch_id"] == batch_id
    bp = tmp_path / "evo-loop-state" / "auto-scan-batches" / batch_id / "_batch.json"
    data = json.loads(bp.read_text())
    assert data["size"] == DEFAULT_BATCH_SIZE
    assert data["sealed"] is True
    assert data["apply_state"] == "pending_evolution"
    chunks = list((tmp_path / "evo-loop-state" / "auto-scan-batches" / batch_id).glob("chunk-*.json"))
    assert len(chunks) == DEFAULT_BATCH_SIZE


# ---------------------------------------------------------------------------
# _list_batches, _seal_batch, _get_batch_detail
# ---------------------------------------------------------------------------

def test_list_batches_returns_all(tmp_path):
    from src.ops.auto_scan import _list_batches, _get_or_create_open_batch, _seal_batch
    b1 = _get_or_create_open_batch(str(tmp_path), session_id="sess-test")
    _seal_batch(str(tmp_path), b1)
    b2 = _get_or_create_open_batch(str(tmp_path), session_id="sess-test")
    batches = _list_batches(str(tmp_path))
    ids = [b["id"] for b in batches]
    assert b1 in ids and b2 in ids
    sealed_map = {b["id"]: b["sealed"] for b in batches}
    assert sealed_map[b1] is True
    assert sealed_map[b2] is False

def test_get_batch_detail_returns_chunks_and_sources(tmp_path):
    from src.ops.auto_scan import (
        _get_or_create_open_batch, _append_chunk_to_batch, _get_batch_detail,
    )
    batch_id = _get_or_create_open_batch(str(tmp_path), session_id="sess-test")
    _append_chunk_to_batch(str(tmp_path), batch_id, {
        "source": {"agent_id": "a1", "session_id": "s1", "cursor_start": 0, "cursor_end": 100},
        "weak_keypoints": ["wk"],
        "evaluator_verdict": "weak",
        "content_path": "x.jsonl",
    })
    detail = _get_batch_detail(str(tmp_path), batch_id)
    assert detail["id"] == batch_id
    assert detail["size"] == 1
    assert len(detail["chunks"]) == 1
    assert detail["chunks"][0]["source"]["agent_id"] == "a1"


# ---------------------------------------------------------------------------
# handle_auto_scan_batch_list / handle_auto_scan_batch_detail
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_handle_auto_scan_batch_list(tmp_path, monkeypatch):
    from src.ops.auto_scan import handle_auto_scan_batch_list, _get_or_create_open_batch
    monkeypatch.setenv("MOSS_DATA_DIR", str(tmp_path))
    b1 = _get_or_create_open_batch(str(tmp_path), session_id="sess-test")
    responses = []
    async for resp in handle_auto_scan_batch_list("req-1", {}):
        responses.append(resp)
    result = next(r for r in responses if r.type == "result")
    assert "batches" in result.data
    assert any(b["id"] == b1 for b in result.data["batches"])


@pytest.mark.asyncio
async def test_handle_auto_scan_batch_detail(tmp_path, monkeypatch):
    from src.ops.auto_scan import (
        handle_auto_scan_batch_detail, _get_or_create_open_batch, _append_chunk_to_batch,
    )
    monkeypatch.setenv("MOSS_DATA_DIR", str(tmp_path))
    bid = _get_or_create_open_batch(str(tmp_path), session_id="sess-test")
    _append_chunk_to_batch(str(tmp_path), bid, {
        "source": {"agent_id": "a", "session_id": "s", "cursor_start": 0, "cursor_end": 1},
        "weak_keypoints": [],
        "evaluator_verdict": "weak",
        "content_path": "x",
    })
    responses = []
    async for resp in handle_auto_scan_batch_detail("req-1", {"batch_id": bid}):
        responses.append(resp)
    result = next(r for r in responses if r.type == "result")
    assert result.data["id"] == bid
    assert len(result.data["chunks"]) == 1
