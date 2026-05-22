"""Entrypoint for the moss host daemon: `python -m src.main`.

Slice 6 wires the supervisor loop alongside the unix-socket RPC server so
both run inside one event loop. Either subsystem stopping (server returning
or supervisor crashing) sets the shared stop event and tears down the other.
"""
from __future__ import annotations

import asyncio
import atexit
import contextlib
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

from src.ops.supervisor import supervisor_loop
from src.server import serve

log = logging.getLogger("moss-daemon-main")


def _pidfile_path(sock_path: str) -> str:
    return sock_path + ".pid"


def _is_live_daemon(pid: int) -> bool:
    """True iff the pid exists AND its cmdline looks like our daemon."""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read().replace(b"\x00", b" ").decode("utf-8", "replace")
    except OSError:
        # process exists but we can't read its cmdline — conservatively
        # assume it might be ours and abort.
        return True
    # match `python ... -m src.main` or `python ... src/main.py`
    return ("src.main" in cmdline) or ("src/main.py" in cmdline)


def _claim_socket(sock_path: str) -> None:
    """Either confirm no live daemon owns sock_path (and clear stale files),
    or abort with a clear error if a live daemon is already running.

    Called before the asyncio server tries to bind. `serve()` itself will
    unlink the socket again — that's fine; the unlink is idempotent. The
    pidfile we write below survives until shutdown.
    """
    pidfile = _pidfile_path(sock_path)
    if os.path.exists(pidfile):
        try:
            with open(pidfile) as f:
                prior_pid = int(f.read().strip())
        except (OSError, ValueError):
            prior_pid = -1
        if prior_pid > 0 and _is_live_daemon(prior_pid):
            print(
                f"daemon already running, pid={prior_pid} (sock={sock_path})",
                file=sys.stderr,
            )
            sys.exit(2)
        # stale pidfile → remove
        with contextlib.suppress(OSError):
            os.unlink(pidfile)
    # stale socket → remove
    if os.path.exists(sock_path):
        with contextlib.suppress(OSError):
            os.unlink(sock_path)


def _write_pidfile(sock_path: str) -> None:
    pidfile = _pidfile_path(sock_path)
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))


def _cleanup(sock_path: str) -> None:
    for p in (sock_path, _pidfile_path(sock_path)):
        with contextlib.suppress(OSError):
            os.unlink(p)


async def _run_all(sock_path: str) -> None:
    """Run RPC server + supervisor in parallel; either ending stops both."""
    stop = asyncio.Event()

    async def _serve_with_stop() -> None:
        try:
            await serve(sock_path)
        finally:
            stop.set()

    async def _supervise_with_stop() -> None:
        try:
            await supervisor_loop(stop)
        finally:
            stop.set()

    server_task = asyncio.create_task(_serve_with_stop(), name="rpc-server")
    supervisor_task = asyncio.create_task(_supervise_with_stop(), name="supervisor")
    try:
        # Block until either task finishes; if one dies the other must too
        # (we already set `stop` in the finally branches above).
        await stop.wait()
    finally:
        for t in (server_task, supervisor_task):
            if not t.done():
                t.cancel()
        # gather with return_exceptions so a CancelledError from one task
        # doesn't mask the original failure of the other
        await asyncio.gather(server_task, supervisor_task, return_exceptions=True)


def _preflight_checks() -> None:
    """Fail-fast on common misconfigurations so the daemon doesn't spend
    minutes booting just to crash mid-trial. Each check appends one human-
    readable error to `errs`; if any errors are present, prints them all
    to stderr and exits with code 3.

    Checks (in order):
      1. docker reachable under the configured MOSS_DOCKER_BIN
      2. MOSS_DATA_DIR exists + writable
      3. MOSS_OPENCLAW_REPO_DIR contains a .git
      4. MOSS_COMPOSE_DIR (or parent(REPO_DIR)) contains docker-compose.yml

    Coding-agent CLI preflight (claude --version / codex --version / ...) is
    handled separately in _preflight_active_runner() so only the ACTIVE
    provider (per MOSS_AGENT_PROVIDER) is required to be installed.

    Override the docker invocation via MOSS_DOCKER_BIN env (e.g.
    MOSS_DOCKER_BIN="docker") to match production layout.
    """
    errs: list[str] = []

    # 1. docker reachable
    docker_bin = os.environ.get("MOSS_DOCKER_BIN", "docker").split()
    try:
        subprocess.run(
            [*docker_bin, "ps"],
            check=True,
            capture_output=True,
            timeout=10,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        bin_display = " ".join(docker_bin)
        errs.append(
            f"`{bin_display} ps` failed; verify Docker is installed and "
            f"your user is in the docker group: "
            f"`sudo usermod -aG docker $USER && newgrp docker`",
        )

    # 2. MOSS_DATA_DIR
    data_dir = os.environ.get("MOSS_DATA_DIR")
    if not data_dir or not Path(data_dir).is_dir():
        errs.append(
            f"MOSS_DATA_DIR={data_dir!r} not set or not a directory "
            f"(run scripts/setup.sh to create it)",
        )
    elif not os.access(data_dir, os.W_OK):
        errs.append(f"MOSS_DATA_DIR={data_dir} is not writable")

    # 3. MOSS_OPENCLAW_REPO_DIR contains a .git
    repo_dir = os.environ.get("MOSS_OPENCLAW_REPO_DIR")
    if not repo_dir or not (Path(repo_dir) / ".git").exists():
        errs.append(
            f"MOSS_OPENCLAW_REPO_DIR={repo_dir!r} is missing .git; "
            f"is it the inner openclaw repo?",
        )

    # 4. MOSS_COMPOSE_DIR (supervisor checks this too at runtime — fail
    #    here so the user doesn't only learn about it when a swap happens
    #    hours into a run).
    compose_dir = os.environ.get(
        "MOSS_COMPOSE_DIR",
        str(Path(repo_dir).parent) if repo_dir else "",
    )
    if not compose_dir or not (Path(compose_dir) / "docker-compose.yml").is_file():
        errs.append(
            f"docker-compose.yml not found in {compose_dir!r}; set "
            f"MOSS_COMPOSE_DIR to the dir that contains it (typically "
            f"parent(MOSS_OPENCLAW_REPO_DIR))",
        )

    if errs:
        print("\n[moss daemon] PREFLIGHT CHECKS FAILED:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        print(
            "\nFix the above and re-run. To skip preflight (NOT recommended), "
            "set MOSS_SKIP_PREFLIGHT=1.",
            file=sys.stderr,
        )
        sys.exit(3)


async def _preflight_active_runner() -> None:
    """Validate the active coding-agent CLI (per MOSS_AGENT_PROVIDER) is usable.

    Per spec §4: only the ACTIVE provider is validated; inactive registered
    providers (e.g., codex when MOSS_AGENT_PROVIDER=claude) are skipped so
    OSS users only need to install the CLI they actually use.
    """
    from src.ops.coding_agents import get_runner, resolve_default

    try:
        provider = resolve_default()
    except ValueError as e:
        print(f"\n[moss daemon] PREFLIGHT CHECKS FAILED:\n  - {e}", file=sys.stderr)
        sys.exit(3)
    runner = get_runner(provider)
    assert runner is not None  # resolve_default already validated
    pf = await runner.preflight()
    if not pf.get("ok"):
        print(
            f"\n[moss daemon] PREFLIGHT CHECKS FAILED:\n"
            f"  - active provider '{provider}' not usable: {pf.get('error')}",
            file=sys.stderr,
        )
        print(
            "\nInstall the CLI or change MOSS_AGENT_PROVIDER. "
            "To skip preflight (NOT recommended), set MOSS_SKIP_PREFLIGHT=1.",
            file=sys.stderr,
        )
        sys.exit(3)
    log.info("preflight: %s OK (%s)", provider, pf.get("version"))


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if os.environ.get("MOSS_SKIP_PREFLIGHT") != "1":
        _preflight_checks()
        asyncio.run(_preflight_active_runner())
    sock = os.environ.get("MOSS_DAEMON_SOCK", "/tmp/moss.sock")
    _claim_socket(sock)
    _write_pidfile(sock)
    log.info(f"pidfile={_pidfile_path(sock)} pid={os.getpid()}")
    atexit.register(_cleanup, sock)
    # Graceful shutdown on signals so atexit handlers fire.
    def _on_signal(signum: int, _frame: object) -> None:
        log.info(f"received signal {signum}, shutting down")
        _cleanup(sock)
        sys.exit(0)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    try:
        asyncio.run(_run_all(sock))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
