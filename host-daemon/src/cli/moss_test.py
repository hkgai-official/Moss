"""Unit tests for the moss CLI. Mocks HTTP and socket layers."""
import io
import json
import socket
import sys
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

# Import the script as a module by adjusting sys.path
import importlib.util
import os

_MOSS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moss")
# spec_from_file_location returns None for extensionless scripts; use SourceFileLoader directly
from importlib.machinery import SourceFileLoader
_loader = SourceFileLoader("moss_cli", _MOSS_PATH)
spec = importlib.util.spec_from_loader("moss_cli", _loader)
moss_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(moss_cli)


@contextmanager
def capture_stdout():
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        yield buf
    finally:
        sys.stdout = old


def make_args(**kwargs):
    """Make a Namespace-like object with the given attributes (and json=False default)."""
    from argparse import Namespace
    base = {"json": False}
    base.update(kwargs)
    return Namespace(**base)


# --- arg parsing ---

def test_parser_status_works():
    parser = moss_cli.build_parser()
    args = parser.parse_args(["evo", "status"])
    assert args.cmd == "status"

def test_parser_apply_requires_batch_id():
    parser = moss_cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["evo", "apply"])

def test_parser_flag_requires_agent_and_session():
    parser = moss_cli.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["evo", "flag"])
    args = parser.parse_args(["evo", "flag", "--agent", "A", "--session", "S"])
    assert args.agent == "A" and args.session == "S"


# --- HTTP commands ---

def test_cmd_status_human(monkeypatch):
    monkeypatch.setattr(moss_cli, "http_get", lambda p: {
        "batch_id": "batch-2", "stage": "plan-loop", "iter": 2,
    })
    with capture_stdout() as out:
        moss_cli.cmd_status(make_args())
    assert "running" in out.getvalue()
    assert "batch=batch-2" in out.getvalue()


def test_cmd_status_idle(monkeypatch):
    monkeypatch.setattr(moss_cli, "http_get", lambda p: {"batch_id": None})
    with capture_stdout() as out:
        moss_cli.cmd_status(make_args())
    assert "idle" in out.getvalue()


def test_cmd_status_json(monkeypatch):
    monkeypatch.setattr(moss_cli, "http_get", lambda p: {"x": 1})
    with capture_stdout() as out:
        moss_cli.cmd_status(make_args(json=True))
    assert json.loads(out.getvalue()) == {"x": 1}


def test_cmd_batches_human(monkeypatch):
    monkeypatch.setattr(moss_cli, "http_get", lambda p: {
        "batches": [{"id": "batch-1", "size": 5, "apply_state": "pending_evolution", "created_at": 1}]
    })
    with capture_stdout() as out:
        moss_cli.cmd_batches(make_args())
    text = out.getvalue()
    assert "batch-1" in text
    assert "5" in text


def test_cmd_start_with_batch(monkeypatch):
    calls = []
    def fake_post(p, body):
        calls.append((p, body))
        return {"manifest_id": "batch-2"}
    monkeypatch.setattr(moss_cli, "http_post", fake_post)
    with capture_stdout() as out:
        moss_cli.cmd_start(make_args(batch_id="batch-2"))
    assert calls == [("/api/evolution/trigger", {"batch_id": "batch-2"})]
    assert "ok" in out.getvalue()
    assert "batch-2" in out.getvalue()


def test_cmd_start_auto_select(monkeypatch):
    """When batch_id is omitted, cmd_start fetches batches and picks the latest non-empty one."""
    get_calls = []
    post_calls = []
    batches_resp = {"batches": [
        {"id": "old-batch", "size": 1},
        {"id": "latest-batch", "size": 2},
    ]}
    def fake_get(p):
        get_calls.append(p)
        return batches_resp
    def fake_post(p, body):
        post_calls.append((p, body))
        return {"manifest_id": "latest-batch"}
    monkeypatch.setattr(moss_cli, "http_get", fake_get)
    monkeypatch.setattr(moss_cli, "http_post", fake_post)
    with capture_stdout() as out:
        moss_cli.cmd_start(make_args(batch_id=None))
    assert "/api/evolution/batches" in get_calls
    assert post_calls == [("/api/evolution/trigger", {"batch_id": "latest-batch"})]
    assert "ok" in out.getvalue()


def test_cmd_start_auto_select_no_batches(monkeypatch):
    """cmd_start exits 1 when there are no non-empty batches."""
    monkeypatch.setattr(moss_cli, "http_get", lambda p: {"batches": []})
    with pytest.raises(SystemExit) as exc:
        moss_cli.cmd_start(make_args(batch_id=None))
    assert exc.value.code == 1


def test_cmd_apply(monkeypatch):
    calls = []
    monkeypatch.setattr(moss_cli, "http_post", lambda p, b: (calls.append((p, b)) or {}))
    with capture_stdout() as out:
        moss_cli.cmd_apply(make_args(batch_id="b-9"))
    assert calls == [("/api/evolution/apply", {"batch_id": "b-9"})]
    assert "ok" in out.getvalue()


def test_cmd_stop(monkeypatch):
    # cmd_stop resolves the active batch_id via http_get first, then posts stop.
    get_calls = []
    post_calls = []
    monkeypatch.setattr(moss_cli, "http_get", lambda p: (get_calls.append(p) or {"batch_id": "b-running"}))
    monkeypatch.setattr(moss_cli, "http_post", lambda p, b: (post_calls.append((p, b)) or {}))
    with capture_stdout() as out:
        moss_cli.cmd_stop(make_args())
    assert get_calls == ["/api/evolution/active"]
    assert post_calls == [("/api/evolution/stop", {"batch_id": "b-running"})]
    assert "ok" in out.getvalue()
    assert "b-running" in out.getvalue()


def test_cmd_stop_noop_when_idle(monkeypatch):
    # When nothing is running, stop should not POST and should print ok/nothing.
    post_calls = []
    monkeypatch.setattr(moss_cli, "http_get", lambda p: {"batch_id": None})
    monkeypatch.setattr(moss_cli, "http_post", lambda p, b: (post_calls.append((p, b)) or {}))
    with capture_stdout() as out:
        moss_cli.cmd_stop(make_args())
    assert post_calls == [], "should not POST when nothing is running"
    assert "ok" in out.getvalue()


# --- Socket commands ---

def test_cmd_flag(monkeypatch, tmp_path):
    # cmd_flag builds source_path from MOSS_DATA_DIR + agent + session and sends it as source_path.
    monkeypatch.setenv("MOSS_DATA_DIR", str(tmp_path))
    expected_source_path = str(tmp_path / "agents" / "A" / "sessions" / "S.jsonl")

    def fake_rpc(op, payload, on_event=None):
        assert op == "auto-scan-session"
        assert payload == {"source_path": expected_source_path}
        return {"batch_id": "auto-batch-x", "chunks_added": 1}

    monkeypatch.setattr(moss_cli, "rpc_call", fake_rpc)
    with capture_stdout() as out:
        moss_cli.cmd_flag(make_args(agent="A", session="S"))
    assert "auto-batch-x" in out.getvalue()
    assert "chunks=1" in out.getvalue()


def test_cmd_catch_up(monkeypatch):
    monkeypatch.setattr(moss_cli, "rpc_call", lambda op, payload, on_event=None: {
        "total_chunks_added": 3, "batches_touched": ["b1", "b2"],
    })
    with capture_stdout() as out:
        moss_cli.cmd_catch_up(make_args())
    assert "chunks_added=3" in out.getvalue()


def test_cmd_batch_human_with_list_response(monkeypatch):
    # Gateway returns a list; cmd_batch must unwrap the first element.
    batch_data = {
        "batch_id": "auto-batch-123",
        "flag_count": 2,
        "apply_state": "open",
        "status": "current",
    }
    monkeypatch.setattr(moss_cli, "http_get", lambda p: [batch_data])
    with capture_stdout() as out:
        moss_cli.cmd_batch(make_args(batch_id="auto-batch-123"))
    text = out.getvalue()
    assert "auto-batch-123" in text
    assert "open" in text


def test_cmd_batch_human_with_dict_response(monkeypatch):
    # Gateway may also return a dict directly; cmd_batch should handle both.
    batch_data = {
        "batch_id": "auto-batch-456",
        "flag_count": 3,
        "apply_state": "pending_evolution",
        "status": "current",
    }
    monkeypatch.setattr(moss_cli, "http_get", lambda p: batch_data)
    with capture_stdout() as out:
        moss_cli.cmd_batch(make_args(batch_id="auto-batch-456"))
    text = out.getvalue()
    assert "auto-batch-456" in text
    assert "pending_evolution" in text


def test_cmd_batch_not_found(monkeypatch):
    monkeypatch.setattr(moss_cli, "http_get", lambda p: [])
    with capture_stdout() as out:
        with pytest.raises(SystemExit):
            moss_cli.cmd_batch(make_args(batch_id="no-such-batch"))
    assert "not found" in out.getvalue()


# --- Error paths ---

def test_http_get_raises_on_connect_failure(monkeypatch):
    from urllib import error as urlerror
    def fake_urlopen(req, timeout=60):
        raise urlerror.URLError("connection refused")
    monkeypatch.setattr(moss_cli.request, "urlopen", fake_urlopen)
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    with pytest.raises(moss_cli.HttpError) as exc:
        moss_cli.http_get("/api/evolution/active")
    assert "cannot reach gateway" in str(exc.value)
