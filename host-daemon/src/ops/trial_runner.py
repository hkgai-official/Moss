"""4-phase ephemeral trial worker orchestrator.

Phase 1: docker run -d N worker containers (long-lived for this iteration).
Phase 2: fork host-side benchmark.py per (task, trial_n), pin via
         WILDCLAW_CONTAINER, dispatch via asyncio queue.
Phase 3: collect results into grade_summary_stage_<stage>.json + mirror
         result.json/transcript.jsonl into iter_dir/traces/.
Phase 4: docker rm -f all workers (always runs).

CRITICAL design constraint: ``benchmark.py`` is the host script
(~800 LOC), reused **unmodified**. The host daemon only does container
lifecycle + work queue. result.json path is verified against benchmark.py:136
(``results_dir = RESULTS_ROOT / run_id / task_id``).

Docker invocations go through ``DOCKER_BIN`` (default ``docker``). On hosts
where the daemon user isn't in the docker group, override with
``MOSS_DOCKER_BIN="docker"``.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

import yaml

from src.protocol import Response

DOCKER_BIN = os.environ.get("MOSS_DOCKER_BIN", "docker").split()


async def _docker(*args: str, **kw: Any) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(*DOCKER_BIN, *args, **kw)


def _resolve_paths() -> tuple[str, str, str]:
    """Read env at call time (not import time) so tests can patch env."""
    repo_dir = os.environ["MOSS_OPENCLAW_REPO_DIR"]
    moss_root = str(Path(repo_dir).parent)
    benchmark_py = f"{moss_root}/benchmark/claw-eval/runner/benchmark.py"
    return repo_dir, moss_root, benchmark_py


def load_manifest_tasks(manifest_path: str) -> list[dict[str, Any]]:
    """Load tasks list from a v3 manifest yaml. Each task must have ``id``;
    ``baseline_score`` is optional (defaults to 0.0)."""
    with open(manifest_path) as f:
        manifest = yaml.safe_load(f)
    return list(manifest.get("tasks") or [])


def build_work_items(
    tasks: list[dict[str, Any]], n_trials: int,
) -> list[tuple[str, float, int]]:
    """Cartesian product of tasks × trials → flat work list."""
    return [
        (t["id"], float(t.get("baseline_score") or 0.0), n)
        for t in tasks
        for n in range(1, n_trials + 1)
    ]


def result_path_for(
    moss_root: str, run_id: str, task_id: str,
) -> Path:
    """benchmark.py:136 →  RESULTS_ROOT / run_id / task_id / result.json"""
    return (
        Path(moss_root)
        / "benchmark/claw-eval/results"
        / run_id
        / task_id
        / "result.json"
    )


def make_run_id(manifest_path: str, iter_n: str, task_id: str, trial_n: int) -> str:
    """Stable, human-readable run-id used as the benchmark's results subdir."""
    stem = Path(manifest_path).stem
    return f"evo/{stem}/iter{iter_n}/{task_id}-t{trial_n}"


def _normalize_iter_n(iter_dir: str) -> str:
    """Extract the bare iter number from an iter_dir path.

    Handles three naming conventions:
        iteration_3 → "3"
        iter0       → "0"
        3           → "3"
    Two removeprefix calls are idempotent (each pops at most once).
    """
    return Path(iter_dir).name.removeprefix("iteration_").removeprefix("iter")


async def _setup_claweval_worker(name: str) -> bool:
    """Register the claweval agent in a worker container.

    Workers are spawned with `sleep infinity` entrypoint, so the gateway is
    NOT yet running. We pre-populate openclaw.json with the provider
    config (matching the production gateway's openclaw.json), then run
    `agents add` to append the claweval entry, then phase 1.7 starts the
    gateway which reads everything cleanly at boot — no SIGUSR1 restart, no
    runtime "auth-profiles.json missing" error.
    """
    if not os.environ.get("MOSS_MODEL_API_KEY", ""):
        print(f"[claweval-setup] {name}: MOSS_MODEL_API_KEY not set in daemon env")
        return False

    # Step 1: ensure /tmp_workspace exists owned by node
    proc = await _docker(
        "exec", "-u", "root", name,
        "sh", "-c", "mkdir -p /tmp_workspace && chown node:node /tmp_workspace",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err1 = await proc.communicate()
    if proc.returncode != 0:
        print(f"[claweval-setup] {name}: mkdir /tmp_workspace failed: {err1!r}")
        return False

    # Step 2: write the gateway-level openclaw.json with auth.profiles +
    # models.providers.<key> so the agent runtime can find the API key.
    # The apiKey field uses "${MOSS_MODEL_API_KEY}" so the gateway expands it
    # from the container env at boot (same pattern as production gateway).
    openclaw_json = json.dumps({
        "meta": {"lastTouchedVersion": "2026.2.22-2"},
        "auth": {
            "profiles": {
                "chat:default": {
                    "provider": "chat",
                    "mode": "api_key",
                }
            }
        },
        "models": {
            "mode": "merge",
            "providers": {
                "chat": {
                    "baseUrl": os.environ["MOSS_MODEL_BASE_URL"],
                    "apiKey": "${MOSS_MODEL_API_KEY}",
                    "api": "openai-completions",
                    "models": [{
                        "id": os.environ["MOSS_MODEL_ID"],
                        "name": os.environ["MOSS_MODEL_ID"],
                        "contextWindow": 131072,
                        "maxTokens": 8192,
                    }],
                }
            }
        },
        "agents": {
            "defaults": {
                "model": {"primary": f"chat/{os.environ['MOSS_MODEL_ID']}"},
                "workspace": "/home/node/.openclaw/workspace",
                "compaction": {"mode": "safeguard"},
                "maxConcurrent": 4,
                "subagents": {"maxConcurrent": 8},
            },
            "list": [{"id": "main"}],
        },
    })
    proc = await _docker(
        "exec", "-i", "-u", "root", name, "sh", "-c",
        "mkdir -p /home/node/.openclaw && "
        "cat > /home/node/.openclaw/openclaw.json && "
        "chown -R node:node /home/node/.openclaw",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err2 = await proc.communicate(input=openclaw_json.encode())
    if proc.returncode != 0:
        print(f"[claweval-setup] {name}: write openclaw.json failed: {err2!r}")
        return False

    # Step 3: register claweval. Appends to openclaw.json's agents.list +
    # creates agents/claweval/{agent,sessions}/ directories.
    proc = await _docker(
        "exec", "-u", "node", name,
        "node", "/app/openclaw.mjs", "agents", "add", "claweval",
        "--model", f"chat/{os.environ['MOSS_MODEL_ID']}",
        "--workspace", "/tmp_workspace",
        "--non-interactive",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out3, err3 = await proc.communicate()
    if proc.returncode != 0:
        print(f"[claweval-setup] {name}: agents add failed rc={proc.returncode} "
              f"stdout={out3[-200:]!r} stderr={err3[-200:]!r}")
        return False

    # Step 4: verify claweval is in agents list. No retry needed now that the
    # gateway isn't running and can't race with us.
    proc = await _docker(
        "exec", "-u", "node", name,
        "node", "/app/openclaw.mjs", "agents", "list",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out4, err4 = await proc.communicate()
    if b"claweval" not in out4:
        print(f"[claweval-setup] {name}: claweval not in agents list; "
              f"stdout={out4[-300:]!r} stderr={err4[-200:]!r}")
        return False
    return True


async def _start_gateway_in_worker(name: str, deadline_s: float = 60.0) -> bool:
    """Start the openclaw gateway inside a worker container (which was spawned
    with `--entrypoint sleep infinity` so the gateway didn't auto-start).
    Polls the gateway log for the "listening on ws://" message; returns True
    once seen within deadline_s.
    """
    # Detached exec so the gateway keeps running after this call returns.
    proc = await _docker(
        "exec", "-u", "node", "-d", name,
        "sh", "-c",
        "docker-entrypoint.sh node /app/openclaw.mjs gateway "
        "--allow-unconfigured > /tmp/gw.log 2>&1",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        print(f"[gateway-start] {name}: exec failed: {err!r}")
        return False

    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        proc = await _docker(
            "exec", name, "sh", "-c",
            "grep -q 'listening on ws://' /tmp/gw.log",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if proc.returncode == 0:
            return True
        await asyncio.sleep(1.0)
    # Surface the tail of the log so failures are debuggable.
    proc = await _docker(
        "exec", name, "sh", "-c", "tail -20 /tmp/gw.log",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    print(f"[gateway-start] {name}: timeout; tail=\n{out.decode('utf-8', 'replace')}")
    return False


async def _smoke_test_worker(name: str, timeout_s: float = 30.0) -> tuple[bool, str]:
    """Cheap end-to-end ping against a worker's claweval agent.

    Runs `agent --agent claweval --message "Reply exactly: OK" --json` via
    docker exec and parses stdout. Returns (True, "ok") on a healthy round
    trip; otherwise (False, <excerpt>) with enough log tail to debug
    auth / path / config errors before we pay for a full trial.
    """
    proc = await _docker(
        "exec", "-u", "node", name,
        "timeout", "20",
        "node", "/app/openclaw.mjs", "agent",
        "--agent", "claweval",
        "--message", "Reply exactly: OK",
        "--json",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        await proc.wait()
        return False, f"timeout after {timeout_s}s"

    if proc.returncode != 0:
        excerpt = (err.decode("utf-8", "replace") or out.decode("utf-8", "replace"))[-300:]
        return False, f"rc={proc.returncode}: {excerpt}"

    raw = out.decode("utf-8", "replace").strip()
    try:
        parsed = json.loads(raw)
    except Exception as e:
        return False, f"non-json stdout ({e}): {raw[-200:]}"

    if parsed.get("status") != "ok":
        return False, f"status={parsed.get('status')!r}: {raw[-200:]}"

    text = ""
    try:
        payloads = (parsed.get("result") or {}).get("payloads") or []
        if payloads:
            text = payloads[0].get("text", "")
    except Exception:
        text = ""
    if "ok" not in text.lower():
        return False, f"reply missing OK: text={text[:200]!r}"
    return True, "ok"


async def handle_run_trial(req_id: str, payload: dict[str, Any]) -> AsyncIterator[Response]:
    image_tag = payload["image_tag"]
    manifest_path = payload["manifest_path"]
    n_trials = int(payload.get("n_trials", 3))
    iter_dir = payload["iter_dir"]            # host abs
    stage = payload["stage"]                   # e.g. "a" | "b"
    n_workers = int(payload.get("n_workers", 3))
    worker_health_timeout_s = float(payload.get("worker_health_timeout_s", 120))
    per_task_timeout_s = float(payload.get("per_task_timeout_s", 600))

    repo_dir, moss_root, benchmark_py = _resolve_paths()

    # manifest_path is relative-from-moss-root in the RPC payload (e.g.
    # "benchmark/claw-eval/manifests/...yaml"). Resolve to host abs
    # so subsequent open() works regardless of daemon cwd.
    from pathlib import Path as _P
    if not _P(manifest_path).is_absolute():
        manifest_path = str(_P(moss_root) / manifest_path)

    # Load manifest
    try:
        tasks = load_manifest_tasks(manifest_path)
    except Exception as e:
        yield Response(id=req_id, type="error",
                       data={"message": f"manifest load failed: {e}"})
        return
    if not tasks:
        yield Response(id=req_id, type="error",
                       data={"message": f"manifest has no tasks: {manifest_path}"})
        return

    iter_n = _normalize_iter_n(iter_dir)
    workers: list[str] = []

    # ----- Phase 1: spin up workers -----
    # Bridge networking (no --network host) — workers each have their own
    # netns so port 18789 doesn't conflict.
    # No host-data-dir copy: per-worker `_setup_claweval_worker` writes
    # /home/node/.openclaw/openclaw.json + registers the claweval agent
    # from scratch inside the container. This decouples trial workers from
    # any host openclaw-data state, so we don't share/conflict with the
    # main gateway container's mount.
    for i in range(n_workers):
        name = f"moss-trial-iter{iter_n}-w{i+1}-{uuid.uuid4().hex[:6]}"
        cmd = [
            "run", "-d", "--name", name,
            "-v", f"{iter_dir}:/iter_dir",
            "-v", f"{moss_root}/benchmark:/app/benchmark",
            "-e", f"MOSS_MODEL_API_KEY={os.environ.get('MOSS_MODEL_API_KEY', '')}",
            "-e", f"MOSS_MODEL_BASE_URL={os.environ.get('MOSS_MODEL_BASE_URL', '')}",
            "-e", f"MOSS_MODEL_ID={os.environ['MOSS_MODEL_ID']}",
        ]
        # Spawn with sleep entrypoint so the gateway is NOT auto-started. We
        # need to register the claweval agent before the gateway boots, because
        # `agents add` writes openclaw.json which triggers the gateway's
        # debounced (~9s) file watcher → "commands field changed → full
        # process restart" → SIGUSR1 → on a freshly-init'd worker the new
        # process fails to start cleanly and the container dies. By holding
        # off the gateway until after registration, we sidestep the restart.
        cmd += ["--entrypoint", "sleep", image_tag, "infinity"]
        proc = await _docker(*cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            for w in workers:  # cleanup partial spin-up
                rm = await _docker("rm", "-f", w,
                                   stdout=asyncio.subprocess.DEVNULL,
                                   stderr=asyncio.subprocess.DEVNULL)
                await rm.wait()
            yield Response(id=req_id, type="error", data={
                "message": f"worker spin-up failed: {err.decode('utf-8', 'replace')[:300]}",
            })
            return
        workers.append(name)
        yield Response(id=req_id, type="event",
                       data={"phase": "spawn-worker", "name": name})

    try:
        # NOTE: no separate `worker-healthy` phase here. The old check ran
        # `openclaw.mjs status --json` which only lints config and would
        # succeed even with the gateway down. With sleep-entrypoint workers,
        # the real readiness signal is Phase 1.7's "listening on ws://" poll.
        # ----- Phase 1.5: claweval agent setup -----
        # Workers were spawned with sleep entrypoint (gateway not running),
        # so `agents add` writes openclaw.json without racing the gateway's
        # config-change → SIGUSR1 → full-process-restart path.
        claweval_oks = await asyncio.gather(
            *(_setup_claweval_worker(w) for w in workers)
        )
        for w, ok in zip(workers, claweval_oks):
            yield Response(id=req_id, type="event",
                           data={"phase": "claweval-setup", "name": w, "ok": ok})
        if not all(claweval_oks):
            yield Response(id=req_id, type="error", data={
                "message": "claweval agent registration failed on one or more workers",
                "workers_ok": dict(zip(workers, claweval_oks)),
            })
            return

        # ----- Phase 1.7: start gateway in each worker -----
        # docker exec -d so it runs after exec returns; we then poll the log
        # file until "listening on ws://" appears.
        gw_oks = await asyncio.gather(
            *(_start_gateway_in_worker(w, deadline_s=worker_health_timeout_s)
              for w in workers)
        )
        for w, ok in zip(workers, gw_oks):
            yield Response(id=req_id, type="event",
                           data={"phase": "gateway-start", "name": w, "ok": ok})
        if not all(gw_oks):
            yield Response(id=req_id, type="error", data={
                "message": "gateway failed to start on one or more workers",
                "workers_ok": dict(zip(workers, gw_oks)),
            })
            return

        # ----- Phase 1.8: cheap smoke test on each worker -----
        # Catches auth / path / config errors with a single agent ping
        # before we pay for a full 12-task trial.
        smoke_results = await asyncio.gather(
            *(_smoke_test_worker(w) for w in workers)
        )
        for w, (ok, detail) in zip(workers, smoke_results):
            yield Response(id=req_id, type="event",
                           data={"phase": "smoke-test", "name": w,
                                 "ok": ok, "detail": detail})
        if not all(ok for ok, _ in smoke_results):
            yield Response(id=req_id, type="error", data={
                "message": "claweval smoke test failed on one or more workers",
                "workers": {w: {"ok": ok, "detail": detail}
                            for w, (ok, detail) in zip(workers, smoke_results)},
            })
            return

        # ----- Phase 2: work queue, n_workers concurrent -----
        # asyncio.Queue avoids race on worker assignment that a sem+timestamp
        # scheme would have.
        work_items = build_work_items(tasks, n_trials)
        worker_q: asyncio.Queue[str] = asyncio.Queue()
        for w in workers:
            worker_q.put_nowait(w)

        async def run_one(task_id: str, baseline: float, trial_n: int) -> dict[str, Any]:
            w = await worker_q.get()
            try:
                run_id = make_run_id(manifest_path, iter_n, task_id, trial_n)
                env = os.environ.copy()
                env["WILDCLAW_CONTAINER"] = w
                # benchmark.py imports claw_eval + pydantic + pyyaml (editable-
                # installed in user's miniconda env). When daemon runs under
                # sudo, root's python3 (3.10 system) lacks all of these.
                # Use the configured Python (MOSS_PYTHON env, fallback to
                # user's miniconda path if it exists, else system python3).
                claw_eval_src = str(Path(moss_root) / "benchmark/claw-eval/src")
                env["PYTHONPATH"] = claw_eval_src + os.pathsep + env.get("PYTHONPATH", "")
                python_bin = os.environ.get("MOSS_PYTHON", "python3")
                proc = await asyncio.create_subprocess_exec(
                    python_bin, benchmark_py,
                    "--manifest", manifest_path,
                    "--run-id", run_id,
                    "--task", task_id,
                    cwd=moss_root, env=env,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                try:
                    out, _ = await asyncio.wait_for(
                        proc.communicate(), timeout=per_task_timeout_s,
                    )
                    rc = proc.returncode
                except asyncio.TimeoutError:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    await proc.wait()
                    out = b"<benchmark.py timed out>"
                    rc = -1
                return {
                    "task_id": task_id,
                    "baseline_score": baseline,
                    "trial_n": trial_n,
                    "rc": rc,
                    "log_tail": out.decode("utf-8", "replace")[-500:],
                    "run_id": run_id,
                    "worker": w,
                }
            finally:
                worker_q.put_nowait(w)

        results = await asyncio.gather(
            *(run_one(*item) for item in work_items),
            return_exceptions=False,
        )

        # ----- Phase 3: collect grade summaries -----
        grade_summary: list[dict[str, Any]] = []
        for r in results:
            run_id = r["run_id"]
            result_p = result_path_for(moss_root, run_id, r["task_id"])
            grade: dict[str, Any] = {}
            if result_p.exists():
                try:
                    grade = json.loads(result_p.read_text())
                except Exception:
                    grade = {}
            # Match the plan: read from grade["grade"]["task_score"] /
            # grade["grade"]["judge_passed"]. Fall back to top-level
            # task_score / passed if grade subobject missing.
            grade_sub = grade.get("grade") or {}
            score = float(
                grade_sub.get("task_score")
                if grade_sub.get("task_score") is not None
                else (grade.get("task_score") or 0.0)
            )
            judge_passed = bool(
                grade_sub.get("judge_passed")
                if grade_sub.get("judge_passed") is not None
                else grade.get("passed", False)
            )
            grade_summary.append({
                "task": r["task_id"],
                "trial": r["trial_n"],
                "score": score,
                "baseline_score": r["baseline_score"],
                "judge_passed": judge_passed,
                "rc": r["rc"],
                "run_id": run_id,
                "worker": r["worker"],
            })
            # Mirror result + transcript into iter_dir traces.
            tr_dir = Path(iter_dir) / f"traces/stage_{stage}_train" / r["task_id"]
            tr_dir.mkdir(parents=True, exist_ok=True)
            tp = result_p.parent / "transcript.jsonl"
            if result_p.exists():
                (tr_dir / f"trial_{r['trial_n']}_result.json").write_bytes(
                    result_p.read_bytes()
                )
            if tp.exists():
                (tr_dir / f"trial_{r['trial_n']}_transcript.jsonl").write_bytes(
                    tp.read_bytes()
                )

        summary_path = Path(iter_dir) / f"grade_summary_stage_{stage}.json"
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(grade_summary, indent=2))
        n_passed = sum(1 for g in grade_summary if g["judge_passed"])
        n_failed = len(grade_summary) - n_passed
        mean_score = (
            sum(g["score"] for g in grade_summary) / len(grade_summary)
            if grade_summary else 0.0
        )

        yield Response(id=req_id, type="result", data={
            "grade_summary_path": str(summary_path),
            "n_passed": n_passed,
            "n_failed": n_failed,
            "mean_score": mean_score,
        })
    finally:
        # ----- Phase 4: teardown (always runs) -----
        for w in workers:
            rm = await _docker("rm", "-f", w,
                               stdout=asyncio.subprocess.DEVNULL,
                               stderr=asyncio.subprocess.DEVNULL)
            await rm.wait()


# ===========================================================================
# UserMode trial substrate
# ===========================================================================
#
# User-mode trial is intentionally minimal:
#
#   - spawn worker pool of N container instances of the candidate image (B)
#   - per worker: register claweval agent + start gateway (reuses demo helpers)
#   - per task: docker exec agent --message <user_prompt> → collect transcript
#
# Tools are whatever the candidate image carries (sandbox containers per the
# MOSS assumption). No mock_replay_table, no auto_replay server, no tool
# endpoint rewriting — the image is expected to be self-contained.
#
# This intentionally diverges from the earlier (over-engineered) design that
# used a captured-response replay table. See git log around commit fd6bc70
# for that earlier code path; the simplification is per design discussion
# 2026-05-12.
# ---------------------------------------------------------------------------


def _build_user_mode_prompt(user_prompt: str) -> str:
    """Compose the agent's user message for a user-mode trial.

    Plain user_prompt + a brief environment hint. No tool-endpoint block —
    the candidate image (B) is responsible for providing whatever tools the
    agent might call; the trial is testing how that image responds to the
    user's flagged ask, not a synthetic replay scenario.
    """
    parts: list[str] = [user_prompt or ""]
    parts.append("")
    parts.append("--- Environment ---")
    parts.append("Workspace: /tmp_workspace (write any files / scripts here).")
    parts.append("Report your final result inline (chat reply).")
    return "\n".join(parts)


async def handle_run_user_mode_batch_trial(
    req_id: str, payload: dict[str, Any],
) -> AsyncIterator[Response]:
    """UserMode batch trial RPC handler — worker pool variant.

    Mirrors demo mode handle_run_trial's pool semantics: spawn N workers
    in parallel, setup each one ONCE (openclaw.json + claweval agent
    register + gateway start), then dispatch (task, trial) pairs from an
    asyncio.Queue so workers process tasks concurrently. The fixed setup
    cost is paid ONCE per worker, not per task.

    Differences from demo's handle_run_trial (the only mode-specific bits):

      - Tasks are passed inline in payload['tasks'] (no claweval manifest yaml);
        each task is just {task_id, user_prompt} — extracted from the flag
        snapshot.
      - Per-task setup: none beyond what demo does. The candidate image (B)
        carries its own tools / sandbox stack; the agent is expected to call
        them directly inside its worker container.
      - Agent message is just the user_prompt + a brief environment hint;
        no tool-endpoint block to inject.
      - No grade_summary — caller uses task-evaluator (Stage 7.5) for signal.

    Payload shape (see TS docker-rpc.ts RunUserModeBatchTrialRequest):
        image_tag: str
        iter_dir: str (host abs)
        tasks: [{task_id, user_prompt}]
        n_trials: int (per-task; default 1)
        n_workers: int (default 3)
        per_task_timeout_s: float (default 600)
        worker_health_timeout_s: float (default 120)
    """
    image_tag = payload["image_tag"]
    iter_dir = payload["iter_dir"]            # host abs
    tasks_in = list(payload.get("tasks") or [])
    n_trials = int(payload.get("n_trials", 1))
    n_workers_req = int(payload.get("n_workers", 3))
    per_task_timeout_s = float(payload.get("per_task_timeout_s", 600))
    worker_health_timeout_s = float(payload.get("worker_health_timeout_s", 120))

    if not tasks_in:
        yield Response(
            id=req_id, type="error",
            data={"message": "tasks list is empty"},
        )
        return

    _, moss_root, _ = _resolve_paths()
    iter_n = _normalize_iter_n(iter_dir)

    # ----- Phase 1: spawn workers (parallel) -----
    # n_workers capped at n_tasks: more workers than tasks is wasteful.
    n_workers = min(n_workers_req, len(tasks_in))
    workers: list[str] = []
    for i in range(n_workers):
        name = f"moss-user-trial-iter{iter_n}-w{i + 1}-{uuid.uuid4().hex[:6]}"
        cmd = [
            "run", "-d", "--name", name,
            "-v", f"{iter_dir}:/iter_dir",
            "-e", f"MOSS_MODEL_API_KEY={os.environ.get('MOSS_MODEL_API_KEY', '')}",
            "-e", f"MOSS_MODEL_BASE_URL={os.environ.get('MOSS_MODEL_BASE_URL', '')}",
            "-e", f"MOSS_MODEL_ID={os.environ['MOSS_MODEL_ID']}",
            "--entrypoint", "sleep", image_tag, "infinity",
        ]
        proc = await _docker(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            # rollback any partial spawn
            for w in workers:
                rm = await _docker(
                    "rm", "-f", w,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await rm.wait()
            yield Response(
                id=req_id, type="error",
                data={"message": f"worker spawn failed: {err.decode('utf-8', 'replace')[:300]}"},
            )
            return
        workers.append(name)
        yield Response(
            id=req_id, type="event",
            data={"phase": "spawn-worker", "name": name},
        )

    try:
        # ----- Phase 2.5: claweval agent setup (parallel) -----
        claweval_oks = await asyncio.gather(
            *(_setup_claweval_worker(w) for w in workers),
        )
        for w, ok in zip(workers, claweval_oks):
            yield Response(
                id=req_id, type="event",
                data={"phase": "claweval-setup", "name": w, "ok": ok},
            )
        if not all(claweval_oks):
            yield Response(
                id=req_id, type="error",
                data={
                    "message": "claweval agent registration failed on one or more workers",
                    "workers_ok": dict(zip(workers, claweval_oks)),
                },
            )
            return

        # ----- Phase 2.7: start gateway (parallel) -----
        gw_oks = await asyncio.gather(
            *(_start_gateway_in_worker(w, deadline_s=worker_health_timeout_s)
              for w in workers),
        )
        for w, ok in zip(workers, gw_oks):
            yield Response(
                id=req_id, type="event",
                data={"phase": "gateway-start", "name": w, "ok": ok},
            )
        if not all(gw_oks):
            yield Response(
                id=req_id, type="error",
                data={
                    "message": "gateway failed to start on one or more workers",
                    "workers_ok": dict(zip(workers, gw_oks)),
                },
            )
            return

        # ----- Phase 3: build work queue (task, trial_n) × worker pool -----
        work_items: list[tuple[dict, int]] = []
        for t in tasks_in:
            for trial_n in range(1, n_trials + 1):
                work_items.append((t, trial_n))

        worker_q: asyncio.Queue[str] = asyncio.Queue()
        for w in workers:
            worker_q.put_nowait(w)

        async def run_one(task: dict, trial_n: int) -> dict[str, Any]:
            w = await worker_q.get()
            task_id = task["task_id"]
            try:
                full_prompt = _build_user_mode_prompt(
                    task.get("user_prompt", ""),
                )
                full_msg = f"/new {full_prompt}"

                # Run the agent. Tools come from the candidate image itself
                # (sandboxed by assumption — see MOSS design note).
                agent_proc = await _docker(
                    "exec", "-u", "node", w,
                    "timeout", str(int(per_task_timeout_s)),
                    "node", "/app/openclaw.mjs", "agent",
                    "--agent", "claweval",
                    "--message", full_msg,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _out, err = await agent_proc.communicate()
                rc = agent_proc.returncode

                # Collect transcript — latest session jsonl this run.
                trace_dir = Path(iter_dir) / "traces" / "stage_a_train" / task_id
                trace_dir.mkdir(parents=True, exist_ok=True)
                cp_proc = await _docker(
                    "exec", w, "sh", "-c",
                    "ls -t /home/node/.openclaw/agents/claweval/sessions/*.jsonl 2>/dev/null "
                    "| head -1 | xargs -I{} cat {} || true",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                trace_bytes, _ = await cp_proc.communicate()
                transcript_path = trace_dir / f"trial_{trial_n}_transcript.jsonl"
                transcript_path.write_bytes(trace_bytes or b"")

                # Cleanup so next task on this worker reads a fresh session.
                cleanup = await _docker(
                    "exec", "-u", "node", w, "sh", "-c",
                    "rm -f /home/node/.openclaw/agents/claweval/sessions/*.jsonl 2>/dev/null || true",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await cleanup.wait()

                return {
                    "task_id": task_id, "trial_n": trial_n,
                    "rc": rc, "trace_path": str(transcript_path),
                    "worker": w,
                    "stderr_tail": (err or b"").decode("utf-8", "replace")[-300:],
                }
            except Exception as e:  # noqa: BLE001 — defensive: any worker-internal failure shouldn't kill the batch
                return {
                    "task_id": task_id, "trial_n": trial_n,
                    "rc": -2, "trace_path": "",
                    "worker": w,
                    "error": str(e),
                }
            finally:
                worker_q.put_nowait(w)

        # Stream per-task events as they complete (real-time progress) so
        # the orchestrator's evolution-log captures correct ordering.
        pending = {asyncio.create_task(run_one(t, n)) for (t, n) in work_items}
        results: list[dict[str, Any]] = []
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for fut in done:
                r = fut.result()
                results.append(r)
                event_data: dict[str, Any] = {
                    "phase": "task-finished",
                    "task_id": r["task_id"],
                    "trial_n": r["trial_n"],
                    "rc": r["rc"],
                    "worker": r.get("worker"),
                }
                if r.get("error"):
                    event_data["error"] = r["error"]
                yield Response(id=req_id, type="event", data=event_data)

        yield Response(
            id=req_id, type="result",
            data={
                "tasks": [
                    {
                        "task_id": r["task_id"],
                        "trial_n": r["trial_n"],
                        "trace_path": r.get("trace_path", ""),
                        "exit_code": r["rc"],
                    }
                    for r in results
                ],
                "n_workers": n_workers,
            },
        )
    finally:
        # ----- Phase 4: teardown all workers (best-effort) -----
        for w in workers:
            rm = await _docker(
                "rm", "-f", w,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await rm.wait()
