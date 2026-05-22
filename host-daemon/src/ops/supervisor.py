"""Job A — file-watch driven swap supervisor (spec §6 responsibility A + §7).

Watches ``$MOSS_DATA_DIR/evo-loop-state/swap-req.json`` for an atomic
write from the container side. When seen, performs::

    docker compose down moss-gateway
    MOSS_IMAGE=<target> docker compose up -d moss-gateway
    -- 90s probe window (spec §7) --
    every 5s: 4-check probe
        check 0: heartbeat.json fresh (ts within 30s)
        check 1: docker inspect ... State.Running == true
        check 2: docker exec ... node /app/openclaw.mjs status --json (rc=0)
        check 3: docker exec ... node /app/openclaw.mjs agents list (rc=0)
    on 3 consecutive passes:
        write last-good-image.txt = <target>
        rm swap-req.json
        update manifest.status = converged
    on 90s timeout:
        ROLLBACK to last-good-image.txt's previous image
        append rollback-history.jsonl
        update manifest.status = rolled_back

v0 uses simple polling (2s interval) instead of inotify — adequate for our
"swap once every several minutes" use pattern and avoids the asyncinotify
dependency. swap-req.json is written atomically (.tmp + rename, see
swap-writer.ts) so we never see a half-written file.

Docker is invoked via ``DOCKER_BIN`` (default ``docker``) for parity
with docker_rpc.py. Override with ``MOSS_DOCKER_BIN="docker"`` on
hosts where the running user isn't in the docker group.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("moss-supervisor")

# Module-level helper: split on whitespace so "docker" works.
DOCKER_BIN = os.environ.get("MOSS_DOCKER_BIN", "docker").split()

# --------------------------------------------------------------------------
# Probe thresholds (spec §7)
# --------------------------------------------------------------------------
SWAP_WINDOW_S = 90
PROBE_INTERVAL_S = 5
PROBE_REQUIRED_PASS_COUNT = 3
HEARTBEAT_MAX_STALENESS_MS = 30_000
WATCH_POLL_INTERVAL_S = 2.0


async def _wait_for_gateway_http(gateway_url: str, max_wait_s: float = 90.0) -> bool:
    """Poll the gateway's /api/health until it returns any HTTP response
    (200 or auth-required 401 both count; we just need the HTTP server
    bound and accepting connections). Used to gate apply-complete webhook
    fires — supervisor brings the container back up, but the embedded
    gateway needs another ~30-60s after compose's "Started" to bind its
    HTTP listener. Returns True if reachable within max_wait_s.
    """
    import os
    from urllib import request, error as urlerror
    health_url = f"{gateway_url}/api/health"
    # Wrap as Request so unit-test mocks (which inspect req.full_url/.headers)
    # see the same object type as _fire_webhook's POST does. Keep method GET.
    req = request.Request(health_url, method="GET")
    deadline = time.time() + max_wait_s
    interval_s = 2.0
    while time.time() < deadline:
        try:
            with request.urlopen(req, timeout=3) as resp:
                _ = resp.status  # any response = listener up
                return True
        except (urlerror.URLError, ConnectionError, OSError):
            pass
        await asyncio.sleep(interval_s)
    return False


async def _fire_webhook(payload: dict) -> None:
    """POST payload to OpenClaw gateway /hooks/<event>.

    Best-effort: probe the HTTP listener first (post-swap fires within
    seconds of compose up, before the gateway's HTTP server has bound).
    All failures are logged but never raised — supervisor loop must keep
    running even when webhook delivery breaks.
    """
    import os
    import json as _json
    from urllib import request, error as urlerror
    gateway_url = os.environ.get("OPENCLAW_GATEWAY_URL", "http://localhost:18789")
    token = os.environ.get("MOSS_HOOKS_TOKEN") or os.environ.get("MOSS_GATEWAY_TOKEN", "")
    event = payload.get("event", "")
    if not await _wait_for_gateway_http(gateway_url):
        log.warning(f"webhook {event}: gateway HTTP unreachable after 90s; skipping")
        return
    url = f"{gateway_url}/hooks/{event}"
    body = _json.dumps({"source": event, "payload": payload}).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(url, data=body, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=10) as resp:
            if resp.status >= 400:
                log.warning(f"webhook {event} returned HTTP {resp.status}")
    except (urlerror.URLError, ConnectionError, OSError) as e:
        log.warning(f"webhook {event} failed: {e}")


def _state_paths(host_data_dir: str) -> dict[str, str]:
    base = f"{host_data_dir}/evo-loop-state"
    return {
        "base": base,
        "swap_req": f"{base}/swap-req.json",
        "heartbeat": f"{base}/heartbeat.json",
        "last_good": f"{base}/last-good-image.txt",
        "rollback_history": f"{base}/rollback-history.jsonl",
        "manifest": f"{base}/current/manifest.json",
    }


# --------------------------------------------------------------------------
# Probe implementation
# --------------------------------------------------------------------------
async def _probe_health(
    container_name: str,
    heartbeat_path: str,
) -> bool:
    """Run the 4-check probe sequence. Returns True only if ALL pass."""
    # check 0: heartbeat freshness
    try:
        hb = json.loads(Path(heartbeat_path).read_text())
        ts = int(hb.get("ts", 0))
        if time.time() * 1000 - ts > HEARTBEAT_MAX_STALENESS_MS:
            return False
    except (FileNotFoundError, ValueError, KeyError):
        return False

    # check 1: docker inspect — container running
    p = await asyncio.create_subprocess_exec(
        *DOCKER_BIN, "inspect", container_name, "--format", "{{.State.Running}}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await p.communicate()
    if p.returncode != 0 or out.decode().strip() != "true":
        return False

    # check 2: gateway status --json — exit 0 = healthy
    p = await asyncio.create_subprocess_exec(
        *DOCKER_BIN, "exec", container_name,
        "node", "/app/openclaw.mjs", "status", "--json",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await p.wait()
    if p.returncode != 0:
        return False

    # check 3: agents list — exit 0 = functional
    p = await asyncio.create_subprocess_exec(
        *DOCKER_BIN, "exec", container_name,
        "node", "/app/openclaw.mjs", "agents", "list",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await p.wait()
    return p.returncode == 0


# --------------------------------------------------------------------------
# Compose-dir resolution (F2 — supervisor must cwd into the dir that owns
# docker-compose.yml). The inner openclaw repo does NOT contain the compose
# file; the moss root dir does. Without this, compose down/up silently
# no-ops (parent ascent disabled in newer compose).
# --------------------------------------------------------------------------
def _resolve_compose_dir() -> str:
    """Find the directory containing docker-compose.yml.

    Precedence:
      1. MOSS_COMPOSE_DIR env (explicit override)
      2. parent of MOSS_OPENCLAW_REPO_DIR (moss root dir; default layout)
      3. "." (preserves legacy behavior for tests with no env set)
    """
    explicit = os.environ.get("MOSS_COMPOSE_DIR")
    if explicit:
        return explicit
    repo_dir = os.environ.get("MOSS_OPENCLAW_REPO_DIR", "")
    if repo_dir:
        return str(Path(repo_dir).parent)
    return "."


# --------------------------------------------------------------------------
# docker compose helpers
# --------------------------------------------------------------------------
async def _compose_down(container_name: str, repo_dir: str) -> None:
    """``docker compose down <svc>`` with no stdout suppression for diagnostics."""
    p = await asyncio.create_subprocess_exec(
        *DOCKER_BIN, "compose", "down", container_name,
        cwd=repo_dir,
    )
    await p.wait()


async def _compose_up(container_name: str, repo_dir: str, image: str) -> None:
    """``MOSS_IMAGE=<image> docker compose up -d <svc>``."""
    env = dict(os.environ)
    env["MOSS_IMAGE"] = image
    p = await asyncio.create_subprocess_exec(
        *DOCKER_BIN, "compose", "up", "-d", container_name,
        cwd=repo_dir, env=env,
    )
    await p.wait()


# --------------------------------------------------------------------------
# Manifest update (atomic + fsync — same pattern as evolution.saveManifest)
# --------------------------------------------------------------------------
def _update_manifest_status(
    manifest_path: str,
    status: str,
    target_image: str,
    rollback_reason: Optional[str] = None,
) -> None:
    """Atomically rewrite manifest.json's status + swap_outcome fields. If the
    manifest is gone (already archived), this is a no-op — we're called after
    the supervisor has done its job and the evolution loop may have moved on.
    """
    p = Path(manifest_path)
    try:
        m = json.loads(p.read_text())
    except FileNotFoundError:
        log.info("manifest already archived; skipping status update")
        return
    m["status"] = status
    swap_outcome: dict[str, Any] = {
        "target_image": target_image,
        "status": "success" if status == "converged" else "rolled_back",
    }
    if rollback_reason:
        swap_outcome["rollback_reason"] = rollback_reason
    m["swap_outcome"] = swap_outcome

    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(m, indent=2))
    # fsync so a host crash mid-write doesn't leave zero-byte content
    fd = os.open(str(tmp), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(tmp), str(p))


# --------------------------------------------------------------------------
# Single swap-request handler
# --------------------------------------------------------------------------
async def _handle_swap_request(
    host_data_dir: str,
    compose_dir: str,
    container_name: str,
) -> None:
    """Handle one swap-req.json file end-to-end (down → up → probe → success
    or rollback). Always removes swap-req.json on exit so a stuck request
    doesn't block subsequent triggers.
    """
    paths = _state_paths(host_data_dir)
    try:
        req = json.loads(Path(paths["swap_req"]).read_text())
    except (FileNotFoundError, ValueError) as e:
        log.warning(f"swap-req unreadable, removing: {e}")
        try:
            Path(paths["swap_req"]).unlink()
        except FileNotFoundError:
            pass
        return

    target = str(req.get("target_image", "")).strip()
    previous = str(req.get("previous_image", "")).strip()
    trigger_id = str(req.get("trigger_id", "?")).strip()
    if not target or not previous:
        log.error(f"swap-req missing fields: {req}")
        try:
            Path(paths["swap_req"]).unlink()
        except FileNotFoundError:
            pass
        return

    log.info(f"[trigger {trigger_id}] swap requested: {previous} → {target}")

    # Phase 1: bring down + back up with the target image
    try:
        await _compose_down(container_name, compose_dir)
        await _compose_up(container_name, compose_dir, target)
    except Exception as e:
        log.exception(f"compose down/up failed: {e}")
        # Don't rollback yet — the probe loop below will time out and trigger
        # rollback uniformly. Falling through.

    # Phase 2: 90s probe window
    start = time.monotonic()
    consecutive_pass = 0
    success = False
    while time.monotonic() - start < SWAP_WINDOW_S:
        await asyncio.sleep(PROBE_INTERVAL_S)
        try:
            ok = await _probe_health(container_name, paths["heartbeat"])
        except Exception as e:
            log.warning(f"probe error: {e}")
            ok = False
        consecutive_pass = consecutive_pass + 1 if ok else 0
        log.info(
            f"[trigger {trigger_id}] probe @ {time.monotonic() - start:.1f}s: "
            f"ok={ok} consecutive={consecutive_pass}"
        )
        if consecutive_pass >= PROBE_REQUIRED_PASS_COUNT:
            success = True
            break

    if success:
        Path(paths["last_good"]).write_text(target)
        try:
            Path(paths["swap_req"]).unlink()
        except FileNotFoundError:
            pass
        _update_manifest_status(paths["manifest"], "converged", target)
        log.info(f"[trigger {trigger_id}] swap successful: image={target}")
        await _fire_webhook({
            "event": "apply-complete",
            "batch_id": str(req.get("batch_id", "")) or "unknown",
            "trigger_id": trigger_id,
            "outcome": "success",
            "target_image": target,
            "applied_image": target,
            "rollback_reason": None,
            "human_summary": (
                f"Applied new version from batch {req.get('batch_id', 'unknown')}. "
                f"New image: {target}."
            ),
        })
        return

    # Phase 3: rollback. F3 — use last-good-image.txt as the source of truth
    # for "what should we rollback to", falling back to the swap-req's
    # previous_image if no last-good has ever been recorded. Previously the
    # rollback trusted the requester's `previous_image` field unconditionally,
    # which meant a stale or corrupt trigger could compose-up a lie.
    rollback_target = previous
    try:
        last_good = Path(paths["last_good"]).read_text().strip()
        if last_good:
            rollback_target = last_good
    except FileNotFoundError:
        pass
    if rollback_target != previous:
        log.warning(
            f"[trigger {trigger_id}] rollback target overridden by last-good: "
            f"swap-req.previous={previous} → last-good={rollback_target}"
        )
    log.warning(
        f"[trigger {trigger_id}] swap failed after {SWAP_WINDOW_S}s; "
        f"rolling back to {rollback_target}"
    )
    try:
        await _compose_down(container_name, compose_dir)
        await _compose_up(container_name, compose_dir, rollback_target)
    except Exception as e:
        log.exception(f"rollback compose failed: {e}")
        # Critical — write to stderr regardless of log handlers being attached
        print(
            f"[supervisor CRITICAL] rollback compose failed for {rollback_target}: {e}",
            flush=True,
        )

    # Append to rollback-history.jsonl — record both the swap-req's previous
    # AND the rollback_target we actually used, so post-mortems can spot
    # last-good vs request divergence.
    history_line = json.dumps({
        "trigger_id": trigger_id,
        "target": target,
        "previous": previous,
        "rollback_target": rollback_target,
        "failed_at": time.time(),
        "reason": "no heartbeat 90s OR probe failed",
    })
    with open(paths["rollback_history"], "a") as f:
        f.write(history_line + "\n")

    try:
        Path(paths["swap_req"]).unlink()
    except FileNotFoundError:
        pass
    _update_manifest_status(
        paths["manifest"], "rolled_back", target, rollback_reason="probe failed"
    )
    await _fire_webhook({
        "event": "apply-complete",
        "batch_id": str(req.get("batch_id", "")) or "unknown",
        "trigger_id": trigger_id,
        "outcome": "rolled_back",
        "target_image": target,
        "applied_image": rollback_target,
        "rollback_reason": "probe failed",
        "human_summary": (
            f"Apply failed for batch {req.get('batch_id', 'unknown')}, "
            f"rolled back to {rollback_target}. Reason: probe failed."
        ),
    })


# --------------------------------------------------------------------------
# Main loop — file-watch via polling
# --------------------------------------------------------------------------
async def supervisor_loop(stop_event: asyncio.Event) -> None:
    """Run the supervisor file-watch loop until ``stop_event`` is set."""
    host_data_dir = os.environ.get("MOSS_DATA_DIR", "")
    container_name = os.environ.get("MOSS_GATEWAY_CONTAINER", "moss-gateway")
    if not host_data_dir:
        log.error("MOSS_DATA_DIR not set; supervisor disabled")
        return

    compose_dir = _resolve_compose_dir()
    compose_file = Path(compose_dir) / "docker-compose.yml"
    if not compose_file.is_file():
        log.error(
            f"docker-compose.yml not found in {compose_dir}; supervisor disabled. "
            f"Set MOSS_COMPOSE_DIR if the default (parent of MOSS_OPENCLAW_REPO_DIR) is wrong."
        )
        return

    paths = _state_paths(host_data_dir)
    swap_req_path = Path(paths["swap_req"])
    log.info(
        f"supervisor watching {swap_req_path} (poll={WATCH_POLL_INTERVAL_S}s), "
        f"compose_dir={compose_dir}"
    )

    while not stop_event.is_set():
        try:
            if swap_req_path.exists():
                await _handle_swap_request(host_data_dir, compose_dir, container_name)
        except Exception as e:
            log.exception(f"supervisor outer error (continuing): {e}")
        # Sleep but wake early if stop_event is set
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=WATCH_POLL_INTERVAL_S)
        except asyncio.TimeoutError:
            pass

    log.info("supervisor loop stopped")


# Backward-compat alias for any existing import sites
async def run_supervisor_loop() -> None:  # pragma: no cover (Slice 1 stub)
    """Deprecated stub. Slice 6 callers use ``supervisor_loop(stop_event)`` directly."""
    stop = asyncio.Event()
    await supervisor_loop(stop)
