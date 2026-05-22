"""Supervisor unit tests.

These tests exercise supervisor.py *without* actually running docker — we
monkey-patch the compose helpers and the probe to deterministic stubs so
both happy-path (3 consecutive passes → mark converged) and rollback path
(probe never passes → write rollback-history.jsonl + mark rolled_back) are
covered. End-to-end docker integration is verified by hand via
(internal verification script removed for OSS).
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.ops import supervisor


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    """A scratch ~/.openclaw/evo-loop-state structure."""
    base = tmp_path / "evo-loop-state"
    (base / "current").mkdir(parents=True)
    return base


def _write_swap_req(state_dir: Path, target: str, previous: str, trigger_id: str = "t-1") -> None:
    p = state_dir / "swap-req.json"
    p.write_text(json.dumps({
        "target_image": target,
        "previous_image": previous,
        "trigger_id": trigger_id,
    }))


def _write_manifest(state_dir: Path, status: str = "swap_pending") -> Path:
    p = state_dir / "current" / "manifest.json"
    p.write_text(json.dumps({"status": status, "iterations": []}))
    return p


def _write_heartbeat(state_dir: Path, ts_ms: int | None = None) -> None:
    """Default to ts=now (fresh)."""
    if ts_ms is None:
        ts_ms = int(time.time() * 1000)
    (state_dir / "heartbeat.json").write_text(json.dumps({
        "ts": ts_ms, "status": "alive", "ready": True,
    }))


# --------------------------------------------------------------------------
# Manifest update helper
# --------------------------------------------------------------------------
def test_update_manifest_status_atomic(state_dir: Path) -> None:
    mp = _write_manifest(state_dir, status="swap_pending")
    supervisor._update_manifest_status(str(mp), "converged", "moss:iter3")
    m = json.loads(mp.read_text())
    assert m["status"] == "converged"
    assert m["swap_outcome"] == {
        "target_image": "moss:iter3",
        "status": "success",
    }
    # Verify .tmp file was cleaned up
    assert not (state_dir / "current" / "manifest.json.tmp").exists()


def test_update_manifest_status_rollback_with_reason(state_dir: Path) -> None:
    mp = _write_manifest(state_dir, status="swap_pending")
    supervisor._update_manifest_status(
        str(mp), "rolled_back", "bad-image", rollback_reason="probe failed"
    )
    m = json.loads(mp.read_text())
    assert m["status"] == "rolled_back"
    assert m["swap_outcome"]["rollback_reason"] == "probe failed"


def test_update_manifest_status_missing_file_is_noop(state_dir: Path) -> None:
    """If the manifest is already archived (or never existed), the helper
    must NOT raise — supervisor should still finish the swap-req cleanup."""
    mp = state_dir / "current" / "manifest.json"
    assert not mp.exists()
    # Should not raise
    supervisor._update_manifest_status(str(mp), "converged", "x:y")


# --------------------------------------------------------------------------
# _handle_swap_request — happy path (probe passes 3x)
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handle_swap_request_happy_path(state_dir: Path, monkeypatch) -> None:
    _write_swap_req(state_dir, target="openclaw:new", previous="openclaw:old")
    mp = _write_manifest(state_dir, status="swap_pending")
    _write_heartbeat(state_dir)

    compose_calls: list[tuple[str, ...]] = []

    async def fake_compose_down(name: str, repo: str) -> None:
        compose_calls.append(("down", name))

    async def fake_compose_up(name: str, repo: str, image: str) -> None:
        compose_calls.append(("up", name, image))

    monkeypatch.setattr(supervisor, "_compose_down", fake_compose_down)
    monkeypatch.setattr(supervisor, "_compose_up", fake_compose_up)
    # Always-pass probe → we'll get 3 consecutive on the first 3 ticks
    monkeypatch.setattr(supervisor, "_probe_health", lambda c, h: _AsyncReturn(True))
    # Speed up: make sleep no-op
    monkeypatch.setattr(supervisor, "PROBE_INTERVAL_S", 0.01)
    monkeypatch.setattr(supervisor, "SWAP_WINDOW_S", 5)
    # _handle_swap_request fires apply-complete on success; the real
    # _fire_webhook probes /api/health for up to 90s before sending. This
    # test doesn't assert on webhook delivery — stub the helper out.
    monkeypatch.setattr(supervisor, "_fire_webhook", AsyncMock())

    await supervisor._handle_swap_request(str(state_dir.parent), "/repo", "moss-gateway")

    # compose was called: 1 down, 1 up (no rollback)
    assert ("down", "moss-gateway") in compose_calls
    assert ("up", "moss-gateway", "openclaw:new") in compose_calls
    # And NOT a second up to previous
    ups = [c for c in compose_calls if c[0] == "up"]
    assert len(ups) == 1

    # last-good was written
    assert (state_dir / "last-good-image.txt").read_text() == "openclaw:new"
    # swap-req was removed
    assert not (state_dir / "swap-req.json").exists()
    # manifest marked converged
    m = json.loads(mp.read_text())
    assert m["status"] == "converged"
    assert m["swap_outcome"]["status"] == "success"
    # rollback-history NOT written
    assert not (state_dir / "rollback-history.jsonl").exists()


# --------------------------------------------------------------------------
# _handle_swap_request — rollback path (probe never passes)
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handle_swap_request_rollback(state_dir: Path, monkeypatch) -> None:
    _write_swap_req(state_dir, target="openclaw:bad", previous="openclaw:old", trigger_id="t-rb")
    mp = _write_manifest(state_dir, status="swap_pending")
    _write_heartbeat(state_dir)
    # Pre-populate last-good with the previous image so we can verify it's
    # untouched after rollback (it's only updated on success).
    (state_dir / "last-good-image.txt").write_text("openclaw:old")

    compose_calls: list[tuple[str, ...]] = []

    async def fake_compose_down(name: str, repo: str) -> None:
        compose_calls.append(("down", name))

    async def fake_compose_up(name: str, repo: str, image: str) -> None:
        compose_calls.append(("up", name, image))

    monkeypatch.setattr(supervisor, "_compose_down", fake_compose_down)
    monkeypatch.setattr(supervisor, "_compose_up", fake_compose_up)
    monkeypatch.setattr(supervisor, "_probe_health", lambda c, h: _AsyncReturn(False))
    monkeypatch.setattr(supervisor, "PROBE_INTERVAL_S", 0.01)
    monkeypatch.setattr(supervisor, "SWAP_WINDOW_S", 0.05)  # fast timeout
    # Stub apply-complete webhook to avoid the 90s HTTP probe in _fire_webhook.
    monkeypatch.setattr(supervisor, "_fire_webhook", AsyncMock())

    await supervisor._handle_swap_request(str(state_dir.parent), "/repo", "moss-gateway")

    # compose: 2 downs (target then previous), 2 ups (target then previous)
    downs = [c for c in compose_calls if c[0] == "down"]
    ups = [c for c in compose_calls if c[0] == "up"]
    assert len(downs) == 2
    assert len(ups) == 2
    assert ups[0] == ("up", "moss-gateway", "openclaw:bad")
    assert ups[1] == ("up", "moss-gateway", "openclaw:old")

    # last-good UNCHANGED (still openclaw:old, not bumped to openclaw:bad)
    assert (state_dir / "last-good-image.txt").read_text() == "openclaw:old"
    # swap-req removed
    assert not (state_dir / "swap-req.json").exists()
    # rollback-history.jsonl appended exactly one line
    history = (state_dir / "rollback-history.jsonl").read_text().strip().split("\n")
    assert len(history) == 1
    rec = json.loads(history[0])
    assert rec["trigger_id"] == "t-rb"
    assert rec["target"] == "openclaw:bad"
    assert rec["previous"] == "openclaw:old"
    assert "reason" in rec
    # manifest marked rolled_back
    m = json.loads(mp.read_text())
    assert m["status"] == "rolled_back"
    assert m["swap_outcome"]["rollback_reason"] == "probe failed"


# --------------------------------------------------------------------------
# _handle_swap_request — malformed swap-req is removed, no docker ops
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handle_swap_request_malformed_input(state_dir: Path, monkeypatch) -> None:
    (state_dir / "swap-req.json").write_text("{not json")
    compose_calls: list = []

    async def fake_compose_down(name: str, repo: str) -> None:
        compose_calls.append(("down", name))

    async def fake_compose_up(name: str, repo: str, image: str) -> None:
        compose_calls.append(("up", name, image))

    monkeypatch.setattr(supervisor, "_compose_down", fake_compose_down)
    monkeypatch.setattr(supervisor, "_compose_up", fake_compose_up)

    await supervisor._handle_swap_request(str(state_dir.parent), "/repo", "moss-gateway")
    assert compose_calls == []
    assert not (state_dir / "swap-req.json").exists()


@pytest.mark.asyncio
async def test_handle_swap_request_missing_fields(state_dir: Path, monkeypatch) -> None:
    (state_dir / "swap-req.json").write_text(json.dumps({"target_image": ""}))
    compose_calls: list = []

    async def fake_compose_down(name: str, repo: str) -> None:
        compose_calls.append(("down", name))

    async def fake_compose_up(name: str, repo: str, image: str) -> None:
        compose_calls.append(("up", name, image))

    monkeypatch.setattr(supervisor, "_compose_down", fake_compose_down)
    monkeypatch.setattr(supervisor, "_compose_up", fake_compose_up)

    await supervisor._handle_swap_request(str(state_dir.parent), "/repo", "moss-gateway")
    assert compose_calls == []
    assert not (state_dir / "swap-req.json").exists()


# --------------------------------------------------------------------------
# Probe heartbeat freshness gate
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_probe_health_rejects_stale_heartbeat(state_dir: Path) -> None:
    # heartbeat older than HEARTBEAT_MAX_STALENESS_MS
    stale_ts = int(time.time() * 1000) - 60_000
    _write_heartbeat(state_dir, ts_ms=stale_ts)
    ok = await supervisor._probe_health("any-container", str(state_dir / "heartbeat.json"))
    assert ok is False


@pytest.mark.asyncio
async def test_probe_health_rejects_missing_heartbeat(state_dir: Path) -> None:
    ok = await supervisor._probe_health("any-container", str(state_dir / "no-such-heartbeat.json"))
    assert ok is False


# --------------------------------------------------------------------------
# supervisor_loop — picks up a swap-req file via polling, then exits
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_supervisor_loop_picks_up_request(
    state_dir: Path, monkeypatch, tmp_path: Path
) -> None:
    # Supervisor preflight requires docker-compose.yml in compose_dir (F2).
    fake_compose_dir = tmp_path / "moss"
    fake_compose_dir.mkdir()
    (fake_compose_dir / "docker-compose.yml").write_text("services:\n  moss-gateway:\n")
    monkeypatch.setenv("MOSS_DATA_DIR", str(state_dir.parent))
    monkeypatch.setenv("MOSS_COMPOSE_DIR", str(fake_compose_dir))
    monkeypatch.setattr(supervisor, "WATCH_POLL_INTERVAL_S", 0.05)

    handled: list[str] = []

    async def fake_handle(host_data_dir: str, repo_dir: str, container: str) -> None:
        handled.append(container)
        # Simulate the handler removing the swap-req
        try:
            (state_dir / "swap-req.json").unlink()
        except FileNotFoundError:
            pass

    monkeypatch.setattr(supervisor, "_handle_swap_request", fake_handle)

    stop = asyncio.Event()
    task = asyncio.create_task(supervisor.supervisor_loop(stop))
    # Drop a swap-req after the loop has started polling
    await asyncio.sleep(0.1)
    (state_dir / "swap-req.json").write_text(json.dumps({
        "target_image": "x:1", "previous_image": "x:0", "trigger_id": "t",
    }))
    await asyncio.sleep(0.2)
    stop.set()
    await asyncio.wait_for(task, timeout=2)

    assert handled == ["moss-gateway"]


@pytest.mark.asyncio
async def test_supervisor_loop_disabled_without_env(monkeypatch) -> None:
    """No env vars → loop logs and returns immediately (does not crash daemon)."""
    monkeypatch.delenv("MOSS_DATA_DIR", raising=False)
    monkeypatch.delenv("MOSS_OPENCLAW_REPO_DIR", raising=False)
    stop = asyncio.Event()
    await asyncio.wait_for(supervisor.supervisor_loop(stop), timeout=2)


# --------------------------------------------------------------------------
# F2: _resolve_compose_dir — finds the dir holding docker-compose.yml
# --------------------------------------------------------------------------
def test_resolve_compose_dir_explicit_env(monkeypatch) -> None:
    monkeypatch.setenv("MOSS_COMPOSE_DIR", "/custom/path")
    monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", "/this/should/be/ignored")
    assert supervisor._resolve_compose_dir() == "/custom/path"


def test_resolve_compose_dir_defaults_to_parent_of_repo_dir(monkeypatch) -> None:
    monkeypatch.delenv("MOSS_COMPOSE_DIR", raising=False)
    monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", "/abc/moss/openclaw")
    assert supervisor._resolve_compose_dir() == "/abc/moss"


def test_resolve_compose_dir_falls_back_to_cwd(monkeypatch) -> None:
    monkeypatch.delenv("MOSS_COMPOSE_DIR", raising=False)
    monkeypatch.delenv("MOSS_OPENCLAW_REPO_DIR", raising=False)
    assert supervisor._resolve_compose_dir() == "."


@pytest.mark.asyncio
async def test_supervisor_loop_refuses_to_start_without_compose_file(
    state_dir: Path, monkeypatch, tmp_path: Path
) -> None:
    """Preflight check: compose dir without docker-compose.yml → disabled."""
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    monkeypatch.setenv("MOSS_DATA_DIR", str(state_dir.parent))
    monkeypatch.setenv("MOSS_COMPOSE_DIR", str(empty_dir))
    stop = asyncio.Event()
    # Returns quickly (before stop is set), proving preflight aborted.
    await asyncio.wait_for(supervisor.supervisor_loop(stop), timeout=2)


# --------------------------------------------------------------------------
# F3: rollback uses last-good-image.txt when it diverges from swap-req previous
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_rollback_uses_last_good_when_diverges(
    state_dir: Path, monkeypatch
) -> None:
    """swap-req says previous=X but last-good actually records Y → rollback to Y."""
    _write_swap_req(state_dir, target="x:bad", previous="x:stale-lie")
    _write_manifest(state_dir, status="swap_pending")
    _write_heartbeat(state_dir)
    # The supervisor's own record (truthier than swap-req's claim).
    (state_dir / "last-good-image.txt").write_text("x:actually-good")

    compose_calls: list[tuple[str, ...]] = []

    async def fake_compose_down(name: str, repo: str) -> None:
        compose_calls.append(("down", name))

    async def fake_compose_up(name: str, repo: str, image: str) -> None:
        compose_calls.append(("up", name, image))

    monkeypatch.setattr(supervisor, "_compose_down", fake_compose_down)
    monkeypatch.setattr(supervisor, "_compose_up", fake_compose_up)
    monkeypatch.setattr(supervisor, "_probe_health", lambda c, h: _AsyncReturn(False))
    monkeypatch.setattr(supervisor, "PROBE_INTERVAL_S", 0.01)
    monkeypatch.setattr(supervisor, "SWAP_WINDOW_S", 0.05)
    # Stub apply-complete webhook to skip the 90s HTTP probe.
    monkeypatch.setattr(supervisor, "_fire_webhook", AsyncMock())

    await supervisor._handle_swap_request(
        str(state_dir.parent), "/repo", "moss-gateway"
    )

    ups = [c for c in compose_calls if c[0] == "up"]
    # Phase 1 up = target, Phase 3 up = rollback target (NOT the swap-req's lie)
    assert ups[0] == ("up", "moss-gateway", "x:bad")
    assert ups[1] == ("up", "moss-gateway", "x:actually-good")
    # rollback-history records both fields so the divergence is auditable
    history = (state_dir / "rollback-history.jsonl").read_text().strip().split("\n")
    rec = json.loads(history[0])
    assert rec["previous"] == "x:stale-lie"
    assert rec["rollback_target"] == "x:actually-good"


@pytest.mark.asyncio
async def test_rollback_falls_back_to_previous_when_no_last_good(
    state_dir: Path, monkeypatch
) -> None:
    """No last-good-image.txt yet → fall back to swap-req's previous."""
    _write_swap_req(state_dir, target="x:bad", previous="x:fallback")
    _write_manifest(state_dir, status="swap_pending")
    _write_heartbeat(state_dir)
    # Do NOT write last-good-image.txt.

    compose_calls: list[tuple[str, ...]] = []

    async def fake_compose_down(name: str, repo: str) -> None:
        compose_calls.append(("down", name))

    async def fake_compose_up(name: str, repo: str, image: str) -> None:
        compose_calls.append(("up", name, image))

    monkeypatch.setattr(supervisor, "_compose_down", fake_compose_down)
    monkeypatch.setattr(supervisor, "_compose_up", fake_compose_up)
    monkeypatch.setattr(supervisor, "_probe_health", lambda c, h: _AsyncReturn(False))
    monkeypatch.setattr(supervisor, "PROBE_INTERVAL_S", 0.01)
    monkeypatch.setattr(supervisor, "SWAP_WINDOW_S", 0.05)
    # Stub apply-complete webhook to skip the 90s HTTP probe.
    monkeypatch.setattr(supervisor, "_fire_webhook", AsyncMock())

    await supervisor._handle_swap_request(
        str(state_dir.parent), "/repo", "moss-gateway"
    )

    ups = [c for c in compose_calls if c[0] == "up"]
    assert ups[1] == ("up", "moss-gateway", "x:fallback")


# --------------------------------------------------------------------------
# Tiny helper: an awaitable that resolves to a fixed value, used so we can
# replace the async _probe_health with a sync lambda.
# --------------------------------------------------------------------------
class _AsyncReturn:
    def __init__(self, value):
        self._value = value

    def __await__(self):
        async def inner():
            return self._value
        return inner().__await__()


# --------------------------------------------------------------------------
# _fire_webhook helper
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_fire_webhook_posts_payload(monkeypatch):
    from src.ops.supervisor import _fire_webhook
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    monkeypatch.setenv("MOSS_GATEWAY_TOKEN", "tk")
    monkeypatch.delenv("MOSS_HOOKS_TOKEN", raising=False)
    # Bypass the 90s HTTP gate (its own behavior is covered by
    # test_wait_for_gateway_http_* below); this test only cares about the POST.
    monkeypatch.setattr(
        "src.ops.supervisor._wait_for_gateway_http", AsyncMock(return_value=True)
    )
    captured = {}

    def fake_urlopen(req, timeout=10):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.headers)
        captured["body"] = req.data.decode()
        m = MagicMock()
        m.status = 200
        m.__enter__ = lambda self: self
        m.__exit__ = lambda self, *a: None
        return m

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        await _fire_webhook({
            "event": "apply-complete",
            "batch_id": "b",
            "trigger_id": "t",
            "outcome": "success",
            "human_summary": "ok",
        })

    assert captured["url"] == "http://localhost:18789/hooks/apply-complete"
    # urllib normalizes header capitalization (Authorization -> Authorization)
    auth = captured["headers"].get("Authorization") or captured["headers"].get("authorization")
    assert auth == "Bearer tk"
    body = json.loads(captured["body"])
    assert body["source"] == "apply-complete"
    assert body["payload"]["outcome"] == "success"


@pytest.mark.asyncio
async def test_fire_webhook_uses_hooks_token_when_set(monkeypatch):
    from src.ops.supervisor import _fire_webhook
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    monkeypatch.setenv("MOSS_HOOKS_TOKEN", "hooks-tok")
    monkeypatch.setenv("MOSS_GATEWAY_TOKEN", "api-tok")
    monkeypatch.setattr(
        "src.ops.supervisor._wait_for_gateway_http", AsyncMock(return_value=True)
    )
    captured = {}

    def fake_urlopen(req, timeout=10):
        captured["headers"] = dict(req.headers)
        m = MagicMock()
        m.status = 202
        m.__enter__ = lambda self: self
        m.__exit__ = lambda self, *a: None
        return m

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        await _fire_webhook({"event": "apply-complete", "human_summary": "ok"})

    auth = captured["headers"].get("Authorization") or captured["headers"].get("authorization")
    assert auth == "Bearer hooks-tok", "MOSS_HOOKS_TOKEN must take priority over MOSS_GATEWAY_TOKEN"


@pytest.mark.asyncio
async def test_fire_webhook_omits_auth_without_token(monkeypatch):
    from src.ops.supervisor import _fire_webhook
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    monkeypatch.setenv("MOSS_GATEWAY_TOKEN", "")
    monkeypatch.delenv("MOSS_HOOKS_TOKEN", raising=False)
    monkeypatch.setattr(
        "src.ops.supervisor._wait_for_gateway_http", AsyncMock(return_value=True)
    )
    captured = {}

    def fake_urlopen(req, timeout=10):
        captured["headers"] = dict(req.headers)
        m = MagicMock()
        m.status = 200
        m.__enter__ = lambda self: self
        m.__exit__ = lambda self, *a: None
        return m

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        await _fire_webhook({"event": "evolution-converged", "human_summary": "x"})

    assert captured["headers"].get("Authorization") is None
    assert captured["headers"].get("authorization") is None


@pytest.mark.asyncio
async def test_fire_webhook_swallows_errors(monkeypatch):
    from src.ops.supervisor import _fire_webhook
    from urllib import error as urlerror
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    monkeypatch.setenv("MOSS_GATEWAY_TOKEN", "")
    # Probe succeeds (assume gateway is up) so we exercise the POST error path.
    monkeypatch.setattr(
        "src.ops.supervisor._wait_for_gateway_http", AsyncMock(return_value=True)
    )

    def fake_urlopen(req, timeout=10):
        raise urlerror.URLError("network down")

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        # Should not raise
        await _fire_webhook({"event": "evolution-failed", "human_summary": "x"})


# --------------------------------------------------------------------------
# _wait_for_gateway_http — the HTTP probe used to gate apply-complete fires
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_wait_for_gateway_http_returns_true_on_first_success():
    """Probe sees any HTTP response from /api/health and returns True."""
    from src.ops.supervisor import _wait_for_gateway_http
    seen_urls: list[str] = []

    def fake_urlopen(req, timeout=3):
        seen_urls.append(req.full_url)
        m = MagicMock()
        m.status = 200
        m.__enter__ = lambda self: self
        m.__exit__ = lambda self, *a: None
        return m

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        ok = await _wait_for_gateway_http("http://localhost:18789", max_wait_s=5)
    assert ok is True
    assert seen_urls == ["http://localhost:18789/api/health"]


@pytest.mark.asyncio
async def test_wait_for_gateway_http_returns_false_on_timeout():
    """Probe never sees a response → returns False within budget."""
    from src.ops.supervisor import _wait_for_gateway_http
    from urllib import error as urlerror

    def fake_urlopen(req, timeout=3):
        raise urlerror.URLError("connection refused")

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        # max_wait_s=1 means: try once, sleep 2s, time.time() now > deadline,
        # exit loop. Total ~2s, well under any test timeout.
        ok = await _wait_for_gateway_http("http://localhost:18789", max_wait_s=1)
    assert ok is False


# --------------------------------------------------------------------------
# apply-complete webhook fires on swap success and rollback
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_swap_success_fires_apply_complete(tmp_path: Path, monkeypatch) -> None:
    """When swap probe succeeds, _fire_webhook is called with outcome=success."""
    from unittest.mock import AsyncMock
    state_dir = tmp_path / "evo-loop-state"
    state_dir.mkdir()
    (state_dir / "swap-req.json").write_text(json.dumps({
        "target_image": "img:new",
        "previous_image": "img:old",
        "trigger_id": "t-1",
        "batch_id": "batch-2",
        "ts": 0,
    }))
    (state_dir / "current").mkdir()
    (state_dir / "current" / "manifest.json").write_text(json.dumps({
        "status": "swap_pending", "iterations": [],
    }))
    monkeypatch.setenv("MOSS_DATA_DIR", str(tmp_path))

    with patch.object(supervisor, "_compose_down", AsyncMock(return_value=None)), \
         patch.object(supervisor, "_compose_up", AsyncMock(return_value=None)), \
         patch.object(supervisor, "_probe_health", AsyncMock(return_value=True)), \
         patch.object(supervisor, "_fire_webhook", AsyncMock()) as fw, \
         patch.object(supervisor, "PROBE_INTERVAL_S", 0), \
         patch.object(supervisor, "PROBE_REQUIRED_PASS_COUNT", 1):
        await supervisor._handle_swap_request(str(tmp_path), str(tmp_path), "moss-gateway")

    fw.assert_called_once()
    payload = fw.call_args[0][0]
    assert payload["event"] == "apply-complete"
    assert payload["outcome"] == "success"
    assert payload["batch_id"] == "batch-2"
    assert payload["target_image"] == "img:new"
    assert payload["applied_image"] == "img:new"


@pytest.mark.asyncio
async def test_swap_failure_fires_apply_complete_rollback(tmp_path: Path, monkeypatch) -> None:
    """When swap probe fails, _fire_webhook is called with outcome=rolled_back."""
    from unittest.mock import AsyncMock
    state_dir = tmp_path / "evo-loop-state"
    state_dir.mkdir()
    (state_dir / "swap-req.json").write_text(json.dumps({
        "target_image": "img:new",
        "previous_image": "img:old",
        "trigger_id": "t-1",
        "batch_id": "batch-3",
        "ts": 0,
    }))
    (state_dir / "last-good-image.txt").write_text("img:lastgood")
    (state_dir / "current").mkdir()
    (state_dir / "current" / "manifest.json").write_text(json.dumps({
        "status": "swap_pending", "iterations": [],
    }))
    monkeypatch.setenv("MOSS_DATA_DIR", str(tmp_path))

    with patch.object(supervisor, "_compose_down", AsyncMock(return_value=None)), \
         patch.object(supervisor, "_compose_up", AsyncMock(return_value=None)), \
         patch.object(supervisor, "_probe_health", AsyncMock(return_value=False)), \
         patch.object(supervisor, "_fire_webhook", AsyncMock()) as fw, \
         patch.object(supervisor, "SWAP_WINDOW_S", 0.1), \
         patch.object(supervisor, "PROBE_INTERVAL_S", 0):
        await supervisor._handle_swap_request(str(tmp_path), str(tmp_path), "moss-gateway")

    fw.assert_called_once()
    payload = fw.call_args[0][0]
    assert payload["event"] == "apply-complete"
    assert payload["outcome"] == "rolled_back"
    assert payload["batch_id"] == "batch-3"
    assert payload["applied_image"] == "img:lastgood"
    assert payload["rollback_reason"] == "probe failed"
