"""Auto-scan engine — passive session-flag harvester.

Spec: docs/specs/2026-05-18-auto-scan-engine.md.

RPC ops: auto-scan-session / auto-scan-catch-up / auto-scan-batch-list
/ auto-scan-batch-detail. The engine is purely passive — no schedulers,
watchers, timers, or boot-time auto-runs. Trigger layer is out of scope.
"""
from __future__ import annotations

import glob as _glob
import json
import os
import re
import time
from typing import Any, AsyncIterator, Optional

from src.protocol import Response


# ---------------------------------------------------------------------------
# Constants + config
# ---------------------------------------------------------------------------

DEFAULT_CHUNK_THRESHOLD_BYTES = 1_048_576  # 1 MiB
DEFAULT_BATCH_SIZE = 8  # chunks per batch before auto-seal

DEFAULT_CURSOR: dict = {
    "last_copied_byte": 0,
    "next_chunk_index": 0,
    "last_seen_mtime": 0,
    "last_seen_size": 0,
}

# Allow only paths matching agents/<id>/sessions/<sid>.jsonl[.reset.<ts>|.deleted.<ts>].
# A separate runtime check confirms the path is under MOSS_DATA_DIR.
_ALLOWED_SOURCE_RE = re.compile(
    r".*/agents/[^/]+/sessions/[^/]+\.jsonl(\.reset\.[^/]+|\.deleted\.[^/]+)?$"
)

# Mechanical parse of `### \`<keypoint>\` — <tag>` lines per task-evaluator.md:46-58.
_KEYPOINT_HEADING_RE = re.compile(
    r"^###\s+`([a-z_]+)`\s+—\s+(strong|adequate|weak|missing)\s*$",
    re.MULTILINE,
)

_TASK_EVALUATOR_PROMPT_RELPATH = "src/evolution/prompts/task-evaluator.md"


def _chunk_threshold_bytes() -> int:
    raw = os.environ.get("MOSS_AUTO_SCAN_CHUNK_BYTES", "")
    if not raw:
        return DEFAULT_CHUNK_THRESHOLD_BYTES
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_CHUNK_THRESHOLD_BYTES


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _validate_source_path(source_path: str) -> Optional[str]:
    if not source_path or not _ALLOWED_SOURCE_RE.match(source_path):
        return ("source_path outside allowed glob "
                "(must match agents/*/sessions/*.jsonl[.reset.*|.deleted.*])")
    return None


def _session_id_from_path(source_path: str) -> str:
    name = os.path.basename(source_path)
    for marker in (".jsonl.reset.", ".jsonl.deleted."):
        if marker in name:
            return name.split(marker, 1)[0]
    if name.endswith(".jsonl"):
        return name[: -len(".jsonl")]
    return name


def _is_reset_archive(source_path: str) -> bool:
    return ".jsonl.reset." in os.path.basename(source_path)


def _is_deleted_archive(source_path: str) -> bool:
    return ".jsonl.deleted." in os.path.basename(source_path)


def _evo_loop_state_dir(data_dir: str) -> str:
    return os.path.join(data_dir, "evo-loop-state")


def _auto_scan_root(data_dir: str) -> str:
    return os.path.join(_evo_loop_state_dir(data_dir), "auto-scan")


def _auto_scan_batches_dir(data_dir: str) -> str:
    """Return the auto-scan-batches directory under evo-loop-state.

    This matches the path the gateway reads from
    (<dataDir>/evo-loop-state/auto-scan-batches/) so that
    `moss evo batches` picks up auto-scan-produced batches.
    """
    return os.path.join(_evo_loop_state_dir(data_dir), "auto-scan-batches")


def _session_state_dir(data_dir: str, session_id: str) -> str:
    return os.path.join(_auto_scan_root(data_dir), session_id)




# ---------------------------------------------------------------------------
# Batch directory helpers (direct-to-batch, no pool)
# ---------------------------------------------------------------------------

def _get_or_create_open_batch(data_dir: str, session_id: str) -> str:
    """Return the id of the current open (not sealed) batch for ``session_id``.

    Bug 2 fix: batches are bucketed per source session (= per jsonl /
    conversation), not globally pooled. The original spec §2.2 said all
    non-legacy chunks share one pool; that was based on the misconception
    that an OpenClaw session == one jsonl. The real OpenClaw session is
    channel-level, the jsonl is conversation-level, so the correct
    granularity is per-jsonl. Legacy batches without a ``session_id`` field
    are ignored as candidates (left frozen) so old cross-session pools
    don't keep collecting chunks from any session.

    Creates a new batch if no open batch exists for this session, or if all
    existing ones for this session are sealed.
    """
    import time as _time
    batches_dir = _auto_scan_batches_dir(data_dir)
    os.makedirs(batches_dir, exist_ok=True)

    candidates = []
    for name in sorted(os.listdir(batches_dir)):
        bp = os.path.join(batches_dir, name, "_batch.json")
        if not os.path.isfile(bp):
            continue
        try:
            with open(bp) as f:
                data = json.load(f)
            if data.get("sealed", False):
                continue
            if data.get("session_id") != session_id:
                continue
            candidates.append((data.get("created_at", 0), name))
        except (json.JSONDecodeError, OSError):
            continue

    if candidates:
        candidates.sort()
        return candidates[-1][1]

    now_ms = int(_time.time() * 1000)
    new_id = f"auto-batch-{now_ms}"
    # Guard against same-millisecond collisions: bump until the id is unused.
    while os.path.exists(os.path.join(batches_dir, new_id)):
        now_ms += 1
        new_id = f"auto-batch-{now_ms}"
    new_dir = os.path.join(batches_dir, new_id)
    os.makedirs(new_dir, exist_ok=True)
    payload = {
        "id": new_id,
        "created_at": now_ms,
        "sealed": False,
        "size": 0,
        "apply_state": "open",
        "session_id": session_id,
    }
    bp = os.path.join(new_dir, "_batch.json")
    tmp = bp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, bp)
    return new_id


def _append_chunk_to_batch(data_dir: str, batch_id: str, chunk_metadata: dict) -> dict:
    """Append a chunk record to a batch directory. Auto-seals when size reaches
    DEFAULT_BATCH_SIZE. Returns {"batch_id", "seq", "sealed"}."""
    import time as _time
    batch_dir = os.path.join(_auto_scan_batches_dir(data_dir), batch_id)
    bp = os.path.join(batch_dir, "_batch.json")
    with open(bp) as f:
        batch = json.load(f)
    seq = batch["size"] + 1
    chunk = {
        "seq": seq,
        "added_at": int(_time.time() * 1000),
        **chunk_metadata,
    }
    chunk_path = os.path.join(batch_dir, f"chunk-{seq:04d}.json")
    tmp = chunk_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(chunk, f, indent=2)
    os.replace(tmp, chunk_path)

    batch["size"] = seq
    if seq >= DEFAULT_BATCH_SIZE:
        batch["sealed"] = True
        batch["apply_state"] = "pending_evolution"
    tmp = bp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(batch, f, indent=2)
    os.replace(tmp, bp)
    return {"batch_id": batch_id, "seq": seq, "sealed": batch["sealed"]}


def _seal_batch(data_dir: str, batch_id: str) -> None:
    bp = os.path.join(_auto_scan_batches_dir(data_dir), batch_id, "_batch.json")
    with open(bp) as f:
        batch = json.load(f)
    batch["sealed"] = True
    batch["apply_state"] = "pending_evolution"
    tmp = bp + ".tmp"
    with open(tmp, "w") as f:
        json.dump(batch, f, indent=2)
    os.replace(tmp, bp)


def _list_batches(data_dir: str) -> list[dict]:
    batches_dir = _auto_scan_batches_dir(data_dir)
    if not os.path.isdir(batches_dir):
        return []
    out = []
    for name in sorted(os.listdir(batches_dir)):
        bp = os.path.join(batches_dir, name, "_batch.json")
        if not os.path.isfile(bp):
            continue
        try:
            with open(bp) as f:
                out.append(json.load(f))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def _get_batch_detail(data_dir: str, batch_id: str) -> dict:
    batch_dir = os.path.join(_auto_scan_batches_dir(data_dir), batch_id)
    bp = os.path.join(batch_dir, "_batch.json")
    if not os.path.isfile(bp):
        raise FileNotFoundError(f"batch {batch_id} not found")
    with open(bp) as f:
        batch = json.load(f)
    chunks = []
    for name in sorted(os.listdir(batch_dir)):
        if not name.startswith("chunk-") or not name.endswith(".json"):
            continue
        with open(os.path.join(batch_dir, name)) as f:
            chunks.append(json.load(f))
    batch["chunks"] = chunks
    return batch


# ---------------------------------------------------------------------------
# JSONL line discriminator + boundary search
# ---------------------------------------------------------------------------

def is_real_user_text_line(line_obj: dict) -> bool:
    """True iff this JSONL line is a real user-text turn (role==user AND
    content[0].type=='text'). tool_result turns are excluded.

    Handles both formats:
    - Flat: {"role": "user", "content": [...]} (simplified/test format)
    - OpenClaw wrapped: {"type": "message", "message": {"role": "user", "content": [...]}}
    """
    # Unwrap OpenClaw envelope if present
    if line_obj.get("type") == "message" and isinstance(line_obj.get("message"), dict):
        msg = line_obj["message"]
    else:
        msg = line_obj
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if not isinstance(content, list) or not content:
        return False
    first = content[0]
    if not isinstance(first, dict):
        return False
    return first.get("type") == "text"


def find_chunk_boundary(source_path: str, start_byte: int) -> Optional[int]:
    """Return the byte offset of the LATEST real-user-text turn in
    [start_byte, EOF), or None if no such turn exists. Malformed JSONL
    lines are silently skipped."""
    latest: Optional[int] = None
    try:
        with open(source_path, "rb") as f:
            f.seek(start_byte)
            offset = start_byte
            for line in f:
                stripped = line.rstrip(b"\n")
                if stripped:
                    try:
                        obj = json.loads(stripped.decode("utf-8", errors="replace"))
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        offset += len(line)
                        continue
                    if isinstance(obj, dict) and is_real_user_text_line(obj):
                        latest = offset
                offset += len(line)
    except FileNotFoundError:
        return None
    return latest


# ---------------------------------------------------------------------------
# Cursor persistence (atomic)
# ---------------------------------------------------------------------------

def _cursor_path(state_dir: str) -> str:
    return os.path.join(state_dir, "cursor.json")


def load_cursor(state_dir: str) -> dict:
    path = _cursor_path(state_dir)
    if not os.path.isfile(path):
        return dict(DEFAULT_CURSOR)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        out = dict(DEFAULT_CURSOR)
        out.update({k: data[k] for k in DEFAULT_CURSOR if k in data})
        return out
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_CURSOR)


def save_cursor(state_dir: str, cursor: dict) -> None:
    os.makedirs(state_dir, exist_ok=True)
    path = _cursor_path(state_dir)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cursor, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Chunk extraction (atomic byte-range copy)
# ---------------------------------------------------------------------------

def extract_chunk(
    source_path: str,
    state_dir: str,
    start_byte: int,
    end_byte: int,
    chunk_index: int,
) -> str:
    """Copy bytes [start_byte, end_byte) from source_path to
    <state_dir>/chunk_<chunk_index>.jsonl atomically. Returns the chunk path."""
    os.makedirs(state_dir, exist_ok=True)
    chunk_path = os.path.join(state_dir, f"chunk_{chunk_index}.jsonl")
    tmp = chunk_path + ".tmp"
    with open(source_path, "rb") as src, open(tmp, "wb") as dst:
        src.seek(start_byte)
        remaining = end_byte - start_byte
        while remaining > 0:
            buf = src.read(min(remaining, 65536))
            if not buf:
                break
            dst.write(buf)
            remaining -= len(buf)
        dst.flush()
        os.fsync(dst.fileno())
    os.replace(tmp, chunk_path)
    return chunk_path


# ---------------------------------------------------------------------------
# Evaluator output parsing
# ---------------------------------------------------------------------------

def parse_weak_keypoints(evaluator_md: str) -> list[str]:
    """Return keypoint names tagged 'weak' or 'missing' in the markdown.
    Returns [] if no keypoint sections found or all are strong/adequate."""
    weak: list[str] = []
    for match in _KEYPOINT_HEADING_RE.finditer(evaluator_md):
        name, tag = match.group(1), match.group(2)
        if tag in ("weak", "missing"):
            weak.append(name)
    return weak


# ---------------------------------------------------------------------------
# Task-Evaluator invocation
# ---------------------------------------------------------------------------

async def _spawn_agent_handle(
    req_id: str, payload: dict[str, Any],
) -> AsyncIterator[Response]:
    """Indirection layer over src.ops.spawn_agent.handle so tests can monkeypatch."""
    from src.ops import spawn_agent
    async for r in spawn_agent.handle(req_id, payload):
        yield r


def _load_task_evaluator_system_prompt(session_id: str, chunk_index: int) -> str:
    repo_dir = os.environ.get("MOSS_OPENCLAW_REPO_DIR", "")
    prompt_path = os.path.join(repo_dir, _TASK_EVALUATOR_PROMPT_RELPATH)
    with open(prompt_path, "r", encoding="utf-8") as f:
        raw = f.read()
    return (raw
            .replace("{iteration}", "scan")
            .replace("{max_iter}", "scan")
            .replace("{batch_id}", f"auto-scan-{session_id}-chunk_{chunk_index}"))


def _build_evaluator_user_input(
    chunk_path: str,
    output_md_path: str,
    session_id: str,
    chunk_index: int,
) -> str:
    return (
        f"You are evaluating a single production session chunk.\n\n"
        f"task_id: auto-{session_id}-chunk_{chunk_index}\n"
        f"task_name: auto-{session_id}-chunk_{chunk_index}\n"
        f"n_trials: 1\n"
        f"trial_transcript_path: {chunk_path}\n\n"
        f"Read the JSONL at the trial_transcript_path. The first user-text turn "
        f"is the task root; subsequent turns are the agent's execution. Pick "
        f"4-7 keypoints from your 8-dimension library and score them on the "
        f"4-tag scale (strong/adequate/weak/missing).\n\n"
        f"Single-trial input: Section 3 (Flakiness Note) has no signal — write "
        f"\"N/A — single trial\" or omit.\n\n"
        f"Write your output to: {output_md_path}"
    )


async def invoke_task_evaluator(
    chunk_path: str,
    output_md_path: str,
    session_id: str,
    chunk_index: int,
    spawn_logs_dir: str,
    timeout_s: float = 600.0,
) -> bool:
    """Invoke Task-Evaluator on a chunk. Returns True on success (output file
    exists at output_md_path), False on any failure (no exception raised)."""
    payload: dict[str, Any] = {
        "role": "task-evaluator",
        "system_prompt": _load_task_evaluator_system_prompt(session_id, chunk_index),
        "user_input": _build_evaluator_user_input(
            chunk_path, output_md_path, session_id, chunk_index,
        ),
        "add_dirs": [os.path.dirname(chunk_path)],
        "cwd": os.path.dirname(chunk_path),
        "timeout_s": timeout_s,
        "output_log_dir": spawn_logs_dir,
    }
    req_id = f"auto-scan-eval-{session_id}-{chunk_index}"
    try:
        async for r in _spawn_agent_handle(req_id, payload):
            if r.type == "error":
                return False
        return os.path.isfile(output_md_path)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# RPC handlers
# ---------------------------------------------------------------------------

async def handle_auto_scan_session(
    req_id: str, payload: dict[str, Any],
) -> AsyncIterator[Response]:
    """Process one source JSONL from its cursor to current EOF. See spec
    for the full state machine."""
    data_dir = os.environ.get("MOSS_DATA_DIR", "")
    if not data_dir:
        yield Response(id=req_id, type="error", data={"message": "MOSS_DATA_DIR not set"})
        return

    source_path = payload.get("source_path", "")
    err = _validate_source_path(source_path)
    if err:
        yield Response(id=req_id, type="error", data={"message": err})
        return

    session_id = _session_id_from_path(source_path)

    if _is_deleted_archive(source_path):
        yield Response(id=req_id, type="result", data={
            "session_id": session_id, "chunks_emitted": 0, "chunks_added": 0,
            "note": "deleted_archive_skipped",
        })
        return

    if not os.path.isfile(source_path):
        yield Response(id=req_id, type="result", data={
            "session_id": session_id, "chunks_emitted": 0, "chunks_added": 0,
            "note": "source_not_found",
        })
        return

    state_dir = _session_state_dir(data_dir, session_id)
    cursor = load_cursor(state_dir)

    current_size = os.path.getsize(source_path)
    if cursor["last_seen_size"] > current_size:
        cursor = dict(DEFAULT_CURSOR)

    is_archive = _is_reset_archive(source_path)
    bytes_pending = current_size - cursor["last_copied_byte"]
    threshold = _chunk_threshold_bytes()

    if not is_archive and bytes_pending < threshold:
        yield Response(id=req_id, type="result", data={
            "session_id": session_id, "chunks_emitted": 0, "chunks_added": 0,
        })
        return

    # Determine end_byte:
    # - archive: emit all remaining (last user-text isn't required to delimit; the source is closed)
    # - active: must find a real user-text boundary; otherwise wait
    if is_archive:
        if cursor["last_copied_byte"] >= current_size:
            yield Response(id=req_id, type="result", data={
                "session_id": session_id, "chunks_emitted": 0, "chunks_added": 0,
            })
            return
        end_byte = current_size
    else:
        boundary = find_chunk_boundary(source_path, cursor["last_copied_byte"])
        if boundary is None or boundary <= cursor["last_copied_byte"]:
            yield Response(id=req_id, type="result", data={
                "session_id": session_id, "chunks_emitted": 0, "chunks_added": 0,
                "note": "no_user_boundary_in_window",
            })
            return
        end_byte = boundary

    # Step (a): write chunk atomically
    chunk_index = cursor["next_chunk_index"]
    start_byte = cursor["last_copied_byte"]
    chunk_path = extract_chunk(
        source_path=source_path,
        state_dir=state_dir,
        start_byte=start_byte,
        end_byte=end_byte,
        chunk_index=chunk_index,
    )

    # Step (b): commit-point — advance cursor atomically
    new_cursor = {
        "last_copied_byte": end_byte,
        "next_chunk_index": chunk_index + 1,
        "last_seen_mtime": int(os.path.getmtime(source_path) * 1000),
        "last_seen_size": current_size,
    }
    save_cursor(state_dir, new_cursor)

    # Step (c): invoke Task-Evaluator (post-commit; failure here doesn't roll back the chunk)
    eval_outputs_dir = os.path.join(state_dir, "evaluator_outputs")
    os.makedirs(eval_outputs_dir, exist_ok=True)
    output_md_path = os.path.join(eval_outputs_dir, f"chunk_{chunk_index}.md")
    spawn_logs_dir = os.path.join(state_dir, "spawn_logs")

    eval_ok = await invoke_task_evaluator(
        chunk_path=chunk_path,
        output_md_path=output_md_path,
        session_id=session_id,
        chunk_index=chunk_index,
        spawn_logs_dir=spawn_logs_dir,
    )

    chunks_added = 0
    batch_id: Optional[str] = None
    if eval_ok:
        try:
            with open(output_md_path, "r", encoding="utf-8") as f:
                evaluator_md = f.read()
        except OSError:
            evaluator_md = ""
        weak = parse_weak_keypoints(evaluator_md)
        if weak:
            # Bug 2: bucket batches per source jsonl (= per session_id), not
            # in a global pool. See _get_or_create_open_batch docstring.
            batch_id = _get_or_create_open_batch(data_dir, session_id=session_id)
            _append_chunk_to_batch(data_dir, batch_id, {
                "source": {
                    "agent_id": "auto-scan",
                    "session_id": session_id,
                    "cursor_start": start_byte,
                    "cursor_end": end_byte,
                },
                "weak_keypoints": weak,
                "evaluator_verdict": "weak",
                "content_path": chunk_path,
            })
            chunks_added = 1

    yield Response(id=req_id, type="result", data={
        "session_id": session_id,
        "chunks_emitted": 1,
        "chunks_added": chunks_added,
        "batch_id": batch_id,
    })


async def handle_auto_scan_catch_up(
    req_id: str, payload: dict[str, Any],
) -> AsyncIterator[Response]:
    data_dir = os.environ.get("MOSS_DATA_DIR", "")
    if not data_dir:
        yield Response(id=req_id, type="error", data={"message": "MOSS_DATA_DIR not set"})
        return

    active_glob = payload.get("active_glob", "agents/*/sessions/*.jsonl")
    reset_glob = payload.get("reset_glob", "agents/*/sessions/*.jsonl.reset.*")

    paths: list[str] = []
    paths += sorted(_glob.glob(os.path.join(data_dir, active_glob)))
    paths += sorted(_glob.glob(os.path.join(data_dir, reset_glob)))

    sessions_scanned = 0
    total_chunks = 0
    total_added = 0
    for p in paths:
        sessions_scanned += 1
        async for r in handle_auto_scan_session(
            f"{req_id}-{sessions_scanned}", {"source_path": p},
        ):
            if r.type == "result":
                total_chunks += r.data.get("chunks_emitted", 0)
                total_added += r.data.get("chunks_added", 0)

    yield Response(id=req_id, type="result", data={
        "sessions_scanned": sessions_scanned,
        "total_chunks_emitted": total_chunks,
        "total_chunks_added": total_added,
    })


async def handle_auto_scan_batch_list(
    req_id: str, payload: dict[str, Any],
) -> AsyncIterator[Response]:
    import os
    data_dir = os.environ.get("MOSS_DATA_DIR", "")
    if not data_dir:
        yield Response(id=req_id, type="error", data={"message": "MOSS_DATA_DIR not set"})
        return
    batches = _list_batches(data_dir)
    yield Response(id=req_id, type="result", data={"batches": batches})


async def handle_auto_scan_batch_detail(
    req_id: str, payload: dict[str, Any],
) -> AsyncIterator[Response]:
    import os
    data_dir = os.environ.get("MOSS_DATA_DIR", "")
    if not data_dir:
        yield Response(id=req_id, type="error", data={"message": "MOSS_DATA_DIR not set"})
        return
    batch_id = payload.get("batch_id", "")
    if not batch_id:
        yield Response(id=req_id, type="error", data={"message": "batch_id required"})
        return
    try:
        detail = _get_batch_detail(data_dir, batch_id)
    except FileNotFoundError as e:
        yield Response(id=req_id, type="error", data={"message": str(e)})
        return
    yield Response(id=req_id, type="result", data=detail)
