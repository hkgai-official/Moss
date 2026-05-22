"""Real docker ops: build, build-smoke, hard-reset-openclaw.

Docker invocations go through ``DOCKER_BIN`` (default: ``docker``). On hosts
where the running user isn't in the docker group, override with
``MOSS_DOCKER_BIN="docker"``.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, AsyncIterator

from src.protocol import Response

# Module-level helper: split on whitespace so "docker" works.
DOCKER_BIN = os.environ.get("MOSS_DOCKER_BIN", "docker").split()


async def _docker(*args: str, **kw: Any) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(*DOCKER_BIN, *args, **kw)


# --------------------------------------------------------------------------
# docker-build
# --------------------------------------------------------------------------
async def handle_build(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    tag = payload["tag"]
    context_dir = payload["context_dir"]
    timeout_s = float(payload.get("timeout_s", 600))

    proc = await _docker(
        "build", "-t", tag, context_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None

    started = time.monotonic()
    try:
        while True:
            remaining = timeout_s - (time.monotonic() - started)
            if remaining <= 0:
                proc.kill()
                await proc.wait()
                yield Response(id=req_id, type="error", data={"message": "docker build timeout"})
                return
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                yield Response(id=req_id, type="error", data={"message": "docker build timeout"})
                return
            if not line:
                break
            yield Response(
                id=req_id, type="event",
                data={"log": line.decode("utf-8", errors="replace").rstrip()},
            )

        rc = await proc.wait()
        if rc != 0:
            yield Response(id=req_id, type="error", data={"message": f"docker build exit {rc}"})
            return

        # inspect for image_id + size
        inspect = await _docker(
            "inspect", "--format", "{{.Id}} {{.Size}}", tag,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await inspect.communicate()
        if inspect.returncode != 0:
            yield Response(id=req_id, type="error",
                           data={"message": f"docker inspect failed: {err.decode()[:200]}"})
            return
        try:
            image_id, size_str = out.decode().strip().split(" ", 1)
            size_mb = int(int(size_str) / 1024 / 1024)
        except Exception as e:
            yield Response(id=req_id, type="error",
                           data={"message": f"inspect parse error: {e}"})
            return

        yield Response(id=req_id, type="result",
                       data={"image_id": image_id, "size_mb": size_mb})
    except asyncio.CancelledError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()
        raise


# --------------------------------------------------------------------------
# build-smoke (port of legacy build-smoke port — async)
# --------------------------------------------------------------------------
async def _run_step(
    label: str,
    cmd: list[str],
    cwd: str,
    timeout_s: float,
    log_lines: list[str],
) -> bool:
    """Run a subprocess step, append truncated output to log_lines, return ok."""
    log_lines.append(f"\n=== {label} ===")
    log_lines.append(f"$ {' '.join(cmd)}")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
            log_lines.append(f"TIMEOUT after {timeout_s}s")
            return False
        log_lines.append(f"--- output (last 1KB) ---")
        log_lines.append(out.decode("utf-8", errors="replace")[-1000:])
        log_lines.append(f"exit code: {proc.returncode}")
        return proc.returncode == 0
    except Exception as e:
        log_lines.append(f"EXCEPTION: {type(e).__name__}: {e}")
        return False


async def handle_build_smoke(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    """6-step build smoke verifier (ported from orchestrator/v2_2/lib/build_smoke.py).

    1. pnpm tsgo --noEmit (typecheck)
    2. pnpm build (bundler)
    3. docker build -t <tag> .
    4. docker run -d <tag>
    5. docker exec ... agents list
    6. docker rm -f (cleanup, always runs)
    """
    image_tag = payload["image_tag"]
    repo_dir = os.environ["MOSS_OPENCLAW_REPO_DIR"]
    timeout_s = float(payload.get("timeout_s", 600))
    skip_pnpm = bool(payload.get("skip_pnpm_steps", False))
    container_name = payload.get("container_name", f"moss-smoke-{int(time.time())}")
    log_lines: list[str] = []

    # Best-effort cleanup of any leftover smoke container before starting
    pre = await _docker("rm", "-f", container_name,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL)
    await pre.wait()

    try:
        # Step 1+2: pnpm steps (only if not skipped)
        if not skip_pnpm:
            ok = await _run_step("Step 1: pnpm tsgo --noEmit",
                                 ["pnpm", "tsgo", "--noEmit"], repo_dir, 180, log_lines)
            if not ok:
                yield Response(id=req_id, type="result", data={
                    "ok": False, "failed_step": "tsgo",
                    "log_tail": "\n".join(log_lines)[-2000:],
                })
                return
            ok = await _run_step("Step 2: pnpm build",
                                 ["pnpm", "build"], repo_dir, 180, log_lines)
            if not ok:
                yield Response(id=req_id, type="result", data={
                    "ok": False, "failed_step": "build",
                    "log_tail": "\n".join(log_lines)[-2000:],
                })
                return
        else:
            log_lines.append("(Steps 1+2 skipped via skip_pnpm_steps=True)")

        # Step 3: docker build (skip if image already exists)
        check = await _docker("image", "inspect", image_tag,
                              stdout=asyncio.subprocess.DEVNULL,
                              stderr=asyncio.subprocess.DEVNULL)
        await check.wait()
        if check.returncode != 0:
            ok = await _run_step(
                "Step 3: docker build",
                [*DOCKER_BIN, "build", "-t", image_tag, "."],
                repo_dir, 300, log_lines,
            )
            if not ok:
                yield Response(id=req_id, type="result", data={
                    "ok": False, "failed_step": "docker_build",
                    "log_tail": "\n".join(log_lines)[-2000:],
                })
                return
        else:
            log_lines.append(f"\n=== Step 3: docker build (skipped — image {image_tag} exists) ===")

        # Step 4: docker run -d --name <name>
        ok = await _run_step(
            "Step 4: docker run -d",
            [*DOCKER_BIN, "run", "-d", "--name", container_name, image_tag],
            repo_dir, 60, log_lines,
        )
        if not ok:
            yield Response(id=req_id, type="result", data={
                "ok": False, "failed_step": "docker_run",
                "log_tail": "\n".join(log_lines)[-2000:],
            })
            return

        # Wait for gateway to come up. Poll status --json every 1s up to 20s,
        # then run the canonical agents-list verification.
        log_lines.append("\n(waiting up to 20s for gateway to come up)")
        gateway_ok = False
        for _ in range(20):
            await asyncio.sleep(1)
            chk = await _docker("exec", container_name,
                                "node", "/app/openclaw.mjs", "status", "--json",
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL)
            await chk.wait()
            if chk.returncode == 0:
                gateway_ok = True
                break
        if not gateway_ok:
            # capture container logs for diagnostic
            logs = await _docker("logs", "--tail", "100", container_name,
                                 stdout=asyncio.subprocess.PIPE,
                                 stderr=asyncio.subprocess.STDOUT)
            out, _ = await logs.communicate()
            log_lines.append("\n=== docker logs (last 100, truncated) ===")
            log_lines.append(out.decode("utf-8", errors="replace")[-1500:])
            yield Response(id=req_id, type="result", data={
                "ok": False, "failed_step": "container-status",
                "log_tail": "\n".join(log_lines)[-2000:],
            })
            return

        # Step 5: agents list
        ok = await _run_step(
            "Step 5: docker exec agents list",
            [*DOCKER_BIN, "exec", container_name,
             "node", "/app/openclaw.mjs", "agents", "list"],
            repo_dir, 30, log_lines,
        )
        if not ok:
            logs = await _docker("logs", "--tail", "100", container_name,
                                 stdout=asyncio.subprocess.PIPE,
                                 stderr=asyncio.subprocess.STDOUT)
            out, _ = await logs.communicate()
            log_lines.append("\n=== docker logs (last 100, truncated) ===")
            log_lines.append(out.decode("utf-8", errors="replace")[-1500:])
            yield Response(id=req_id, type="result", data={
                "ok": False, "failed_step": "agents_list",
                "log_tail": "\n".join(log_lines)[-2000:],
            })
            return

        yield Response(id=req_id, type="result", data={
            "ok": True, "failed_step": None,
            "log_tail": "\n".join(log_lines)[-2000:],
        })
    finally:
        # Step 6: cleanup (always)
        rm = await _docker("rm", "-f", container_name,
                           stdout=asyncio.subprocess.DEVNULL,
                           stderr=asyncio.subprocess.DEVNULL)
        await rm.wait()


# --------------------------------------------------------------------------
# hard-reset-openclaw
# --------------------------------------------------------------------------
async def handle_hard_reset(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    """Hard-reset the inner openclaw repo to commit ``h_pre``.

    Deliberately does NOT run ``git clean -fd``: that wipes ANY untracked
    file in the working tree, which during the v0 acceptance run nuked
    ``src/evolution/`` because that source wasn't part of H_pre. Reset
    alone reverts tracked-file modifications. Untracked files left alone."""
    h_pre = payload["h_pre"]
    repo_dir = os.environ["MOSS_OPENCLAW_REPO_DIR"]
    for cmd in [
        ["git", "-C", repo_dir, "reset", "--hard", h_pre],
    ]:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        if proc.returncode != 0:
            yield Response(
                id=req_id, type="error",
                data={"message": f"{cmd[0]} {cmd[3]}: {out.decode('utf-8', 'replace')[:300]}"},
            )
            return
    yield Response(id=req_id, type="result", data={"ok": True, "h_pre": h_pre})


# --------------------------------------------------------------------------
# commit-openclaw-iter
# --------------------------------------------------------------------------
async def handle_commit_openclaw_iter(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    """Stage + commit any tree mutations the Implementer agent left in the
    inner openclaw repo, then return HEAD.

    Must run on the host: the inner repo (``MOSS_OPENCLAW_REPO_DIR``) is NOT
    bind-mounted into the moss-gateway container, so the framework cannot do
    this with a local ``git -C <hostPath>``. The Implementer itself already
    runs on the host via spawn-claude, so its own commits land here too —
    this handler exists to capture any straggler edits and to surface the
    HEAD sha back to the framework.

    Idempotent: if there are no staged changes, just returns current HEAD.
    """
    iter_ = int(payload["iter"])
    repo_dir = os.environ["MOSS_OPENCLAW_REPO_DIR"]

    if not os.path.isdir(repo_dir):
        yield Response(id=req_id, type="error",
                       data={"message": f"MOSS_OPENCLAW_REPO_DIR not a directory: {repo_dir}"})
        return

    async def _run(cmd: list[str]) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        return proc.returncode or 0, out.decode("utf-8", errors="replace")

    # 1. add -A — stage everything (no-op if tree clean)
    rc, out = await _run(["git", "-C", repo_dir, "add", "-A"])
    if rc != 0:
        yield Response(id=req_id, type="error",
                       data={"message": f"git add -A failed: {out[:300]}"})
        return

    # 2. diff --cached --quiet: exit 0 = nothing staged; exit 1 = staged diff.
    rc, _out = await _run(["git", "-C", repo_dir, "diff", "--cached", "--quiet"])
    staged = (rc != 0)

    # 3. commit if staged
    if staged:
        rc, out = await _run(
            ["git", "-C", repo_dir, "commit", "-m", f"evolved iter {iter_}"],
        )
        if rc != 0:
            yield Response(id=req_id, type="error",
                           data={"message": f"git commit failed: {out[:300]}"})
            return

    # 4. rev-parse HEAD
    rc, out = await _run(["git", "-C", repo_dir, "rev-parse", "HEAD"])
    if rc != 0:
        yield Response(id=req_id, type="error",
                       data={"message": f"git rev-parse HEAD failed: {out[:300]}"})
        return
    commit_hash = out.strip()

    yield Response(id=req_id, type="result",
                   data={"commit_hash": commit_hash, "staged": staged})


# --------------------------------------------------------------------------
# get-baseline-commit
# --------------------------------------------------------------------------
async def handle_get_baseline_commit(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    """Return ``H_pre`` (current HEAD of the inner openclaw repo) for the
    gateway's evolution preflight.

    Daemon-side replacement for the prior in-container ``fs.existsSync`` +
    ``execFileSync('git rev-parse HEAD')`` calls. The container cannot see
    the host openclaw repo, so this RPC does the work host-side.
    """
    repo_dir = os.environ.get("MOSS_OPENCLAW_REPO_DIR", "")
    if not repo_dir:
        yield Response(id=req_id, type="error",
                       data={"message": "MOSS_OPENCLAW_REPO_DIR not set"})
        return
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        yield Response(id=req_id, type="error",
                       data={"message": f"openclaw repo missing or not a git repo at {repo_dir}"})
        return
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", repo_dir, "rev-parse", "HEAD",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        yield Response(id=req_id, type="error", data={
            "message": f"git rev-parse HEAD failed: {out.decode('utf-8', 'replace')[:200]}",
        })
        return
    yield Response(id=req_id, type="result", data={
        "h_pre": out.decode("utf-8", "replace").strip(),
        "repo_dir": repo_dir,
    })


# --------------------------------------------------------------------------
# run-trial: re-exported from trial_runner
# --------------------------------------------------------------------------
# Slice 3 wires the real handler in src/server.py. We keep a thin re-export
# for back-compat with any caller that still imports docker_rpc.handle_run_trial.
from src.ops import trial_runner as _trial_runner  # noqa: E402

handle_run_trial = _trial_runner.handle_run_trial
