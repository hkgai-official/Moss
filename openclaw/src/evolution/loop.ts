// src/evolution/loop.ts
//
// 9-stage evolution loop state machine. Spec §4. Per-iter sequence:
//   1 locator → 2 plan-loop → 3 (implicit snapshot) → 4 code-loop
//   → 5 (promote) → 6 build → 7 trial-a → 8 strategic → 9 finalize
//   → optional 9b trial-c (validation) → optional 10 swap-req
//
// This file is the main module entry; `startEvolutionService(deps)` returns
// a stoppable handle, and `triggerEvolutionLoop()` is the free function used
// by the `/evolve` slash command (Slice 5 imports it from here).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBaselineCommit } from "./docker-rpc.js";
import { EvolutionLog } from "./evolution-log.js";
import { HeartbeatWriter, type HeartbeatStateProvider } from "./heartbeat-writer.js";
import { fireWebhook } from "./webhook-fire.js";
import { runOneIteration, type LoopContext } from "./iteration.js";
import { parseBaselineEvaluation } from "./matrix.js";
import type { EvolutionMode } from "./modes/mode.js";
import { renderPathTreeMd } from "./path-mapping.js";
import { loadPrompt } from "./prompt-loader.js";
import { composeTaskEvaluatorUserInput } from "./role-inputs.js";
import { runTaskEvaluatorStage } from "./stages/task-evaluator.js";
import {
  createManifest,
  type EvolutionDepth,
  loadManifest,
  readFlagBatchWithDefaults,
  saveManifest,
  type Manifest,
} from "./state.js";
import { writeSwapRequest } from "./swap-writer.js";
import type { FlagBatch } from "./types/flag-batch.js";
import { decideContinue, updateStreaksFromIteration, Verdict } from "./verdict.js";

// ---------------------------------------------------------------------------
// v2.6 UI: auto-apply gate
// ---------------------------------------------------------------------------

/** When `MOSS_AUTO_APPLY_ON_CONVERGE=1`, retain the v2.5 legacy behaviour
 *  (auto-write swap-req.json at end of a converged loop). Any other value —
 *  unset, "0", "true", "yes", "" — means the loop stops at "ready_to_apply"
 *  and waits for the user to click Apply in the MOSS UI, which then POSTs to
 *  /api/evolution/apply (which is what writes swap-req.json).
 *
 *  Strict "1" check (not truthy-ish) so overnight scripts that have been
 *  trained to set "1" keep working, and any accidental "true"/"yes" doesn't
 *  silently re-enable auto-swap. */
/** Returns true if the user has POSTed /api/evolution/stop for this batch.
 *  Reads <stateDir>/stop-requested.json; matches by batch_id (inputSetId).
 *  Best-effort — missing/malformed file means "not requested". */
function isStopRequested(stateDir: string, inputSetId: string): boolean {
  try {
    const p = path.join(stateDir, "stop-requested.json");
    if (!fs.existsSync(p)) return false;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { batch_id?: unknown };
    return typeof raw.batch_id === "string" && raw.batch_id === inputSetId;
  } catch {
    return false;
  }
}

/** Remove the stop sentinel — called on loop entry so a stale file from a
 *  previous run can't accidentally abort a fresh trigger. */
function clearStopSentinel(stateDir: string): void {
  try {
    const p = path.join(stateDir, "stop-requested.json");
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // best effort
  }
}

/** Thrown by bailIfStopRequested when the user-Stop sentinel matches the
 *  current loop's inputSetId. runEvolutionLoop catches it to unwind cleanly
 *  setting finalVerdict = Verdict.PARTIAL_PROGRESS. */
export class EvolutionStopRequested extends Error {
  constructor(public readonly stage: string) {
    super(`stop requested at stage=${stage}`);
    this.name = "EvolutionStopRequested";
  }
}

/** Stage-entry sentinel check. Logs an error event and throws
 *  EvolutionStopRequested if the user has POSTed /api/evolution/stop for
 *  this loop's batch. Caller (runEvolutionLoop) catches and breaks the iter
 *  loop. No-op when sentinel missing or batch_id mismatches.
 *
 *  Side effect: appends one evolution-log entry on bail so post-mortem
 *  shows where the stop landed. */
export function bailIfStopRequested(
  stateDir: string,
  inputSetId: string,
  iter: number,
  stage: string,
  evolutionLog?: EvolutionLog,
): void {
  if (!isStopRequested(stateDir, inputSetId)) return;
  evolutionLog?.append({
    iter, stage, event: "error",
    data: { error: "user_stop_requested" },
  });
  throw new EvolutionStopRequested(stage);
}

export function shouldAutoApplyOnConverge(): boolean {
  return process.env.MOSS_AUTO_APPLY_ON_CONVERGE === "1";
}

/** Best-effort write of `_batch.apply_state` (v2.6 UI gate signal). Uses an
 *  atomic temp-file + rename so a concurrent /api/evolution/list reader never
 *  sees a half-written JSON. Failures are logged and swallowed: the manifest
 *  on disk is still the source of truth for whether convergence happened, so
 *  a human / supervisor can recover by hand. */
async function updateBatchApplyState(
  batchDir: string,
  newState: FlagBatch["apply_state"],
): Promise<void> {
  const p = path.join(batchDir, "_batch.json");
  if (!fs.existsSync(p)) {
    return;
  }
  try {
    const fb = readFlagBatchWithDefaults(JSON.parse(fs.readFileSync(p, "utf8")));
    fb.apply_state = newState;
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(fb, null, 2);
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error(`[loop] updateBatchApplyState failed for ${p}: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry types
// ---------------------------------------------------------------------------

export interface TriggerRequest {
  triggerSource: "manual" | "marked-issues" | "cron";
  triggeredBy: string;
  inputSetId: string;
  inputManifestPath: string;
  validationSet: string;
  startingImage: string;
  startingBranch: string;
  startingCommit: string | null;
  /** Optional override of params.max_iter (else default 3). */
  overrideMaxIter?: number;
  /** Pre-loaded baseline scores per task; fed forward to the manifest. */
  stageATasks?: Array<{ id: string; baseline_score: number }>;
  /** v2.6: caller-supplied triggerId. Used by gateway compose-batch so it can
   *  persist `triggered_evolution_trigger_id` into _batch.json BEFORE the
   *  fire-and-forget call returns. Falls back to randomUUID() if absent. */
  triggerId?: string;
  /** v2.6: evolution mode strategy. Required — caller must supply (UserMode for the conversation-driven flow). */
  mode: EvolutionMode;
  /** v2.6: depth tier seeding ManifestParams. Defaults to "standard". */
  depth?: EvolutionDepth;
  /** v2.6: only meaningful when mode.kind==="user". */
  flagBatchId?: string | null;
}

export interface ServiceDeps {
  /** Container path of the evo-loop-state mount (default: /home/node/.openclaw). */
  rootDataDir?: string;
  /** Container path of openclaw repo (default: /app). */
  openclawContainerDir?: string;
  /** Used by Implementer per-iter commit (host abs). Defaults to env
   *  MOSS_OPENCLAW_REPO_DIR. */
  openclawHostRepoDir?: string;
  /** Initial commit hash (H_pre) — set in Slice 0. Used for code-loop
   *  hard-reset. */
  hPre?: string;
}

export interface ServiceHandle {
  stop: () => Promise<void>;
  trigger: (req: TriggerRequest) => Promise<RunOutcome>;
  /** Non-null when boot validation failed; service still runs heartbeat
   *  but `trigger()` (and the `/evolve` command) will reject. */
  bootError: string | null;
}

/** Error thrown when a second `/evolve` arrives during an active loop. The
 *  `/evolve` slash command catches this specifically to render a user-facing
 *  message instead of bubbling a stack trace. */
export class EvolutionBusyError extends Error {
  readonly inputSetId: string | null;
  constructor(inputSetId: string | null) {
    super(
      inputSetId
        ? `Evolution loop already running for ${inputSetId}`
        : "Evolution loop already running",
    );
    this.name = "EvolutionBusyError";
    this.inputSetId = inputSetId;
  }
}

/** Error thrown when boot validation failed. The `/evolve` slash command
 *  catches this specifically to surface the boot reason. */
export class EvolutionNotReadyError extends Error {
  readonly bootError: string;
  constructor(bootError: string) {
    super(`Evolution service not ready: ${bootError}`);
    this.name = "EvolutionNotReadyError";
    this.bootError = bootError;
  }
}

export interface RunOutcome {
  triggerId: string;
  status: Manifest["status"];
  finalIteration: number;
  finalVerdict: Verdict | null;
  finalImageTag: string | null;
}

// ---------------------------------------------------------------------------
// Module-level singleton (Slice 5 imports `triggerEvolutionLoop` directly)
// ---------------------------------------------------------------------------

interface ServiceState {
  rootDataDir: string;
  stateDir: string;
  openclawContainerDir: string;
  openclawHostRepoDir: string;
  hPre: string;
  heartbeat: HeartbeatWriter;
  busy: boolean;
  current: { triggerId: string; stage: string; iter: number; inputSetId: string } | null;
  /** v2.6 polish: owner token. triggerEvolutionLoop's finally only clears
   *  busy/current/currentToken when currentToken still matches its own
   *  generated token — prevents an orphan loop's late finally from
   *  clobbering a newly-arrived trigger's state after handleStop. */
  currentToken: string | null;
  bootError: string | null;
}

let serviceHandle: ServiceState | null = null;

// ---------------------------------------------------------------------------
// Boot validation (§11)
// ---------------------------------------------------------------------------

/** Validate env + inner repo. Returns null on success, error string on
 *  failure. Even on failure the heartbeat keeps running (we just refuse
 *  triggers); the caller logs and surfaces via `serviceHandle.bootError`.
 *
 *  H_pre is fetched via the `get-baseline-commit` host-daemon RPC rather
 *  than via in-container `fs.existsSync` + `execFileSync('git rev-parse
 *  HEAD')` — the inner openclaw repo is not bind-mounted into the
 *  moss-gateway container (see `openclaw-git.ts` header for the same
 *  invariant). Daemon errors are surfaced verbatim. */
export async function validateBootEnv(opts: { hostDataDir?: string; hostRepoDir?: string }): Promise<{
  error: string | null;
  hPre: string | null;
}> {
  const hostDataDir = opts.hostDataDir ?? process.env.MOSS_DATA_DIR ?? "";
  if (!hostDataDir) {
    return { error: "MOSS_DATA_DIR is not set", hPre: null };
  }
  let hPre: string;
  try {
    const r = await getBaselineCommit();
    hPre = r.hPre;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), hPre: null };
  }
  if (!/^[0-9a-f]{40}$/.test(hPre)) {
    return { error: `git rev-parse HEAD returned unexpected value: ${hPre}`, hPre: null };
  }
  return { error: null, hPre };
}

/** Start the always-on evolution service (heartbeat + boot-recover). */
export async function startEvolutionService(deps: ServiceDeps = {}): Promise<ServiceHandle> {
  if (serviceHandle) {
    throw new Error("EvolutionService already started");
  }
  const rootDataDir = deps.rootDataDir ?? "/home/node/.openclaw";
  const stateDir = path.join(rootDataDir, "evo-loop-state");
  fs.mkdirSync(stateDir, { recursive: true });

  const openclawContainerDir = deps.openclawContainerDir ?? "/app";
  let openclawHostRepoDir = deps.openclawHostRepoDir ?? process.env.MOSS_OPENCLAW_REPO_DIR ?? "";
  let hPre = deps.hPre ?? process.env.MOSS_H_PRE ?? "";

  // Heartbeat is always-on (per §7) regardless of boot-validation outcome —
  // supervisor relies on it to detect a swap-pending container's liveness.
  const heartbeatState: HeartbeatStateProvider = () => ({
    pid: process.pid,
    activeTrigger: serviceHandle?.current ?? null,
  });
  const heartbeat = new HeartbeatWriter(path.join(stateDir, "heartbeat.json"), heartbeatState);
  heartbeat.start(10_000);

  // Boot-recovery: if `.lock` exists from a prior crashed run, archive
  // current/ and force-mark status=failed.
  await bootRecover(stateDir);

  // Boot validation. The container cannot fs.existsSync a host path, so we
  // accept three modes:
  //   (1) deps.hPre injected (test fixtures) — skip validation.
  //   (2) MOSS_H_PRE env set — caller pre-validated host repo; trust it.
  //   (3) Otherwise: try local existsSync (works only if host repo is mounted
  //       into the container, e.g. dev runs); fail soft if not.
  let bootError: string | null = null;
  if (!deps.hPre) {
    if (hPre && /^[0-9a-f]{40}$/.test(hPre)) {
      // Mode (2): trust env-provided H_pre.
      openclawHostRepoDir = openclawHostRepoDir || (process.env.MOSS_OPENCLAW_REPO_DIR ?? "");
      if (!openclawHostRepoDir) {
        bootError = "MOSS_OPENCLAW_REPO_DIR is not set";
      }
    } else {
      const v = await validateBootEnv({ hostDataDir: rootDataDir, hostRepoDir: openclawHostRepoDir });
      if (v.error) {
        bootError = v.error;
        // eslint-disable-next-line no-console
        console.error(`[evolution] boot validation failed: ${v.error}`);
      } else if (v.hPre) {
        hPre = v.hPre;
        openclawHostRepoDir = openclawHostRepoDir || (process.env.MOSS_OPENCLAW_REPO_DIR ?? "");
      }
    }
  }

  serviceHandle = {
    rootDataDir,
    stateDir,
    openclawContainerDir,
    openclawHostRepoDir,
    hPre,
    heartbeat,
    busy: false,
    current: null,
    currentToken: null,
    bootError,
  };

  return {
    stop: async () => {
      heartbeat.stop();
      serviceHandle = null;
    },
    trigger: async (req) => triggerEvolutionLoop(req),
    bootError,
  };
}

/** Free-function trigger entry — Slice 5 imports this directly.
 *
 *  Throws:
 *  - `EvolutionNotReadyError` when boot validation failed (env / repo missing)
 *  - `EvolutionBusyError` when another loop is already in progress
 *  - generic `Error` when service isn't started at all
 */
export async function triggerEvolutionLoop(req: TriggerRequest): Promise<RunOutcome> {
  if (!serviceHandle) {
    throw new Error("EvolutionService not started");
  }
  if (serviceHandle.bootError) {
    throw new EvolutionNotReadyError(serviceHandle.bootError);
  }
  if (serviceHandle.busy) {
    const activeId = serviceHandle.current?.inputSetId ?? null;
    throw new EvolutionBusyError(activeId);
  }

  // Generate (or accept caller-supplied) triggerId; same value owns the
  // service-state slot and seeds the manifest.
  const myToken = req.triggerId ?? randomUUID();
  serviceHandle.busy = true;
  serviceHandle.currentToken = myToken;
  serviceHandle.current = {
    triggerId: myToken,
    stage: "queued",
    iter: 0,
    inputSetId: req.inputSetId,
  };
  try {
    return await runEvolutionLoop(serviceHandle, { ...req, triggerId: myToken });
  } finally {
    // Owner check: only clear if I still hold the slot. Orphan loops whose
    // state was already replaced by a later trigger MUST NOT clobber the
    // new owner's state.
    if (serviceHandle && serviceHandle.currentToken === myToken) {
      serviceHandle.busy = false;
      serviceHandle.current = null;
      serviceHandle.currentToken = null;
    }
  }
}

/** User-Stop escape hatch. The HTTP `/api/evolution/stop` handler calls this
 *  to free the service for a fresh trigger immediately, instead of waiting
 *  for the orphan loop to honor the stop sentinel at the next iter boundary.
 *  The orphan loop keeps running until its next yield point, but its writes
 *  to apply_state / heartbeat are now stale and ignored by the UI.
 *  Safe to call concurrently; idempotent. */
export function forceClearBusy(): void {
  if (!serviceHandle) return;
  serviceHandle.busy = false;
  serviceHandle.current = null;
  serviceHandle.currentToken = null; // so orphan loop's finally won't match
}

/** Snapshot of current service state for `/evolve status` and tests. */
export function getServiceStatus():
  | {
      started: false;
    }
  | {
      started: true;
      bootError: string | null;
      busy: boolean;
      current: { triggerId: string; stage: string; iter: number; inputSetId: string } | null;
    } {
  if (!serviceHandle) {
    return { started: false };
  }
  return {
    started: true,
    bootError: serviceHandle.bootError,
    busy: serviceHandle.busy,
    current: serviceHandle.current,
  };
}

// ---------------------------------------------------------------------------
// Boot-recovery (§5 stale-lock + §8 cross-swap resume)
// ---------------------------------------------------------------------------

/** Read `last-good-image.txt` if the supervisor has ever recorded one.
 *  Returns null when the file is missing (first ever swap) so the caller can
 *  fall back to `req.startingImage`. Exported for unit tests. */
export function readLastGoodImage(stateDir: string): string | null {
  const p = path.join(stateDir, "last-good-image.txt");
  try {
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function bootRecover(stateDir: string): Promise<void> {
  const lockPath = path.join(stateDir, ".lock");
  const currentDir = path.join(stateDir, "current");
  const manifestPath = path.join(currentDir, "manifest.json");
  const lockExists = fs.existsSync(lockPath);
  const manifestExists = fs.existsSync(manifestPath);

  // Three boot scenarios we recover from:
  //   (a) crashed mid-run: .lock + manifest in_progress → flip failed, archive
  //   (b) supervisor swap after CONVERGED: NO .lock (loop's finally removed it)
  //       + manifest status=converged → archive so next trigger starts clean
  //   (c) clean idle boot: no .lock + no manifest → nothing to do
  if (!lockExists && !manifestExists) {
    return;
  }

  // Dangling .lock with no manifest → clear lock and return
  if (lockExists && !manifestExists) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
    return;
  }

  const m = loadManifest(manifestPath);
  const archiveDir = path.join(stateDir, "archive", m.triggerId);
  fs.mkdirSync(path.dirname(archiveDir), { recursive: true });

  // For v0 we never resume mid-iter — any in_progress / initialized state
  // found at boot means the previous loop crashed or the container swapped.
  // Mark failed and archive (per spec §8 "v0 does not support resuming between mid-iter states").
  if (m.status === "in_progress" || m.status === "initialized") {
    m.status = "failed";
    saveManifest(manifestPath, m);
  }
  // Move current/ → archive/<trigger_id>/  (covers both scenarios a & b)
  try {
    fs.renameSync(currentDir, archiveDir);
  } catch {
    // best effort archive
  }
  if (lockExists) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop body
// ---------------------------------------------------------------------------

async function runEvolutionLoop(service: ServiceState, req: TriggerRequest): Promise<RunOutcome> {
  const triggerId = req.triggerId ?? randomUUID();
  service.current = { triggerId, stage: "init", iter: 0, inputSetId: req.inputSetId };

  // Wipe any stale stop sentinel left from a prior cancelled run.
  clearStopSentinel(service.stateDir);

  // Acquire .lock atomically
  const lockPath = path.join(service.stateDir, ".lock");
  const loopStartMs = Date.now();
  fs.writeFileSync(lockPath, JSON.stringify({ triggerId, pid: process.pid, ts: loopStartMs }));

  const currentDir = path.join(service.stateDir, "current");
  fs.mkdirSync(currentDir, { recursive: true });
  const tracesDir = path.join(currentDir, "session-traces");
  fs.mkdirSync(tracesDir, { recursive: true });

  // Build initial manifest
  const params = req.overrideMaxIter ? { max_iter: req.overrideMaxIter } : undefined;
  const mode: EvolutionMode = req.mode;
  const depth: EvolutionDepth = req.depth ?? "standard";
  const flagBatchId: string | null = req.flagBatchId ?? null;
  const manifest = createManifest({
    triggerId,
    triggerSource: req.triggerSource,
    triggeredBy: req.triggeredBy,
    inputSetId: req.inputSetId,
    inputManifestPath: req.inputManifestPath,
    startingImage: req.startingImage,
    startingCommit: req.startingCommit,
    startingBranch: req.startingBranch,
    evolutionBranch: `evo-v2.6/${triggerId}`,
    validationSet: req.validationSet,
    params,
    tasks: { stage_a: req.stageATasks ?? [], stage_c: [] },
    mode: mode.kind,
    evolutionDepth: depth,
    flagBatchId,
  });
  manifest.status = "in_progress";
  const manifestPath = path.join(currentDir, "manifest.json");
  saveManifest(manifestPath, manifest);

  const evolutionLog = new EvolutionLog(path.join(currentDir, "evolution-log.jsonl"));
  evolutionLog.append({
    iter: 0,
    stage: "init",
    event: "stage_start",
    data: { triggerId, inputSetId: req.inputSetId, params: manifest.params },
  });

  // Snapshot _path_tree.md once per trigger — written into each iter dir
  // when iter dir is created (so `add_dirs` includes it).
  const pathTreeMd = renderPathTreeMd();

  // Stage 0.5: baseline task-evaluator. Resolve the task list once and run
  // task-evaluator on the baseline trace for each task. Keypoints picked here
  // get locked — every iter-N task-evaluator call MUST score against the same
  // list, otherwise the matrix builder can't pivot rows consistently.
  // Output goes under `<currentDir>/baseline/task_evaluations/<task_id>.md`
  // so post-mortem inspection sees the same layout as iteration_K/.
  const tasksList = await mode.getBaselineTaskDefinitions();
  const baselineEvals = new Map<string, ReturnType<typeof parseBaselineEvaluation>>();
  const baselineDir = path.join(currentDir, "baseline");
  fs.mkdirSync(baselineDir, { recursive: true });
  evolutionLog.append({
    iter: 0,
    stage: "baseline-evaluator",
    event: "stage_start",
    data: { taskCount: tasksList.length },
  });

  // Hoist verdict vars here so the baseline-evaluator try/catch can set
  // finalVerdict=PARTIAL_PROGRESS and let the iter loop be skipped cleanly.
  let finalVerdict: Verdict | null = null;
  let finalImageTag: string | null = null;
  let finalIteration = 0;

  // Flag: set by the baseline-evaluator catch block so we skip the iter loop.
  let skipIterLoop = false;

  try {
    for (let taskIndex = 0; taskIndex < tasksList.length; taskIndex++) {
      const task = tasksList[taskIndex];
      // Stage-entry sentinel: bail before starting a new baseline task if the
      // user has clicked Stop. Throws EvolutionStopRequested, caught below.
      bailIfStopRequested(service.stateDir, req.inputSetId, 0, "baseline-evaluator", evolutionLog);
      // Per-task progress event so the UI events panel can render
      // "T137zh task-eval start [1/4]" instead of bare "Stage task eval start".
      evolutionLog.append({
        iter: 0,
        stage: "baseline-evaluator",
        event: "task_start",
        data: {
          task_id: task.task_id,
          task_name: task.task_name,
          task_index: taskIndex + 1,
          task_count: tasksList.length,
        },
      });
      // Mode picks where baseline traces come from. Demo: static claweval
      // baseline-traces dir (no materialization). User: writes the flag snapshot's
      // captured agent_trace as a transcript JSONL under <baselineDir>/traces/.
      await mode.loadBaselineTrace(task);
      const baselineTracesPath = await mode.prepareBaselineTracesForTask(task, baselineDir);
      const outputPath = path.join(baselineDir, "task_evaluations", `${task.task_id}.md`);
      const result = await runTaskEvaluatorStage({
        iter: 0,
        iterDir: baselineDir,
        tracesDir,
        taskId: task.task_id,
        systemPrompt: loadPrompt("task-evaluator", {
          iteration: 0,
          max_iter: manifest.params.max_iter,
          batch_id: manifest.inputSetId,
        }),
        userInput: composeTaskEvaluatorUserInput({
          iter: 0,
          task: { task_id: task.task_id, task_name: task.task_name },
          tracesPath: baselineTracesPath,
          outputPath,
          keypointsList: null, // baseline = free choice (locks the set for iter-N)
        }),
        addContainerDirs: [baselineDir, service.openclawContainerDir],
        cwdContainer: service.openclawContainerDir,
        timeoutS: manifest.params.task_evaluator_session_timeout_s,
        evolutionLog,
      });
      const md = fs.existsSync(result.mdPath) ? fs.readFileSync(result.mdPath, "utf8") : "";
      baselineEvals.set(task.task_id, parseBaselineEvaluation(md));
    }
  } catch (e) {
    if (e instanceof EvolutionStopRequested) {
      evolutionLog.append({
        iter: 0, stage: "baseline-evaluator",
        event: "error",
        data: { error: "user_stop_requested", at_stage: e.stage },
      });
      finalVerdict = Verdict.PARTIAL_PROGRESS;
      finalIteration = 0;
      skipIterLoop = true;
    } else {
      throw e;
    }
  }

  if (!skipIterLoop) {
    evolutionLog.append({
      iter: 0,
      stage: "baseline-evaluator",
      event: "stage_end",
      data: {
        keypointsByTask: Object.fromEntries(
          [...baselineEvals.entries()].map(([k, v]) => [k, v.keypoints]),
        ),
      },
    });
  }

  const ctx: LoopContext = {
    stateDir: service.stateDir,
    currentDir,
    manifestPath,
    tracesDir,
    evolutionLog,
    manifest,
    openclawContainerDir: service.openclawContainerDir,
    openclawHostRepoDir: service.openclawHostRepoDir,
    hPre: service.hPre,
    mode,
    depth,
    tasks: tasksList,
    baselineEvals,
    iterEvals: new Map(),
  };

  try {
    for (let iter = 1; !skipIterLoop && iter <= manifest.params.max_iter; iter++) {
      // User-triggered Stop sentinel — bail before starting a new iter.
      // /api/evolution/stop has already flipped batch.apply_state to "failed";
      // we just record the abort in the log and break out cleanly.
      if (isStopRequested(service.stateDir, req.inputSetId)) {
        evolutionLog.append({
          iter,
          round: null,
          stage: "iter_start",
          event: "error",
          data: { error: "user_stop_requested", triggerId },
        });
        clearStopSentinel(service.stateDir);
        finalVerdict = Verdict.PARTIAL_PROGRESS;
        break;
      }
      try {
        service.current = { triggerId, stage: "iter_start", iter, inputSetId: req.inputSetId };
        finalIteration = iter;
        const iterStart = Date.now();
        const iterDir = path.join(currentDir, `iteration_${iter}`);
        fs.mkdirSync(iterDir, { recursive: true });
        fs.writeFileSync(path.join(iterDir, "_path_tree.md"), pathTreeMd);

        const outcome = await runOneIteration(ctx, iter, req, service, iterDir, iterStart);

        finalVerdict = outcome.verdict;
        finalImageTag = outcome.imageTag;

        // Reload manifest from disk — runOneIteration's finalize stage appended
        // the iteration entry there, so our in-memory `manifest` ref is stale
        // and would clobber `iterations[]` if we wrote it back.
        const reloaded = loadManifest(manifestPath);
        ctx.manifest = reloaded;

        const iterMean = outcome.entry.taskEvalPassRate ?? 0;
        reloaded.streaks = updateStreaksFromIteration(reloaded.streaks, {
          verdict: outcome.verdict,
          iterScore: iterMean,
          bestScoreSoFar: reloaded.bestScoreSoFar,
          sessionCrashedThisIter: outcome.sessionCrashed,
        });
        saveManifest(manifestPath, reloaded);
        evolutionLog.append({
          iter,
          stage: "loop",
          event: "streak_update",
          data: { ...reloaded.streaks },
        });

        // Decide continue
        const decision = decideContinue({
          iter,
          maxIter: reloaded.params.max_iter,
          verdict: outcome.verdict,
          streaks: reloaded.streaks,
          noProgressStreakLimit: reloaded.params.no_progress_streak_limit,
          progressNoApproveStreakLimit: reloaded.params.progress_no_approve_streak_limit,
          buildFailuresAbort: reloaded.params.consecutive_build_failures_for_abort,
          sessionCrashesAbort: reloaded.params.consecutive_session_crashes_for_abort,
        });
        evolutionLog.append({
          iter,
          stage: "loop",
          event: "verdict",
          data: { decision, verdict: outcome.verdict },
        });

        if (!decision.continue) {
          const m2 = loadManifest(manifestPath);
          // Preserve swap_pending if finalize already set it on convergence;
          // only override when decision.status is more terminal than current.
          if (m2.status !== "swap_pending" || decision.status !== "converged") {
            m2.status = decision.status ?? "aborted_max_iter";
          }
          saveManifest(manifestPath, m2);
          break;
        }
      } catch (e) {
        // Stage-entry sentinel thrown by bailIfStopRequested inside
        // runOneIteration. Log where the stop landed and break cleanly.
        if (e instanceof EvolutionStopRequested) {
          evolutionLog.append({
            iter, stage: "loop",
            event: "error",
            data: { error: "user_stop_requested", at_stage: e.stage },
          });
          finalVerdict = Verdict.PARTIAL_PROGRESS;
          break;
        }
        throw e;
      }
    }

    // Post-loop: status finalization
    const m = loadManifest(manifestPath);
    if (m.status === "in_progress") {
      m.status = "aborted_max_iter";
      saveManifest(manifestPath, m);
    }

    // Stage 10: emit swap-req.json if we converged with a viable image. This
    // is the bridge to the host-daemon supervisor.
    //
    // v2.6 UI: this stage is now gated behind MOSS_AUTO_APPLY_ON_CONVERGE.
    //   - Default (env unset or != "1"): MOSS UI flow — DO NOT auto-write the
    //     swap-req. Instead flip the FlagBatch.apply_state to "ready_to_apply"
    //     so the UI surfaces an Apply button; user clicks it →
    //     POST /api/evolution/apply (handleApply in evolution-http.helpers)
    //     does the writeSwapRequest call.
    //   - Legacy (MOSS_AUTO_APPLY_ON_CONVERGE=1): overnight experiment
    //     scripts that opt in get the v2.5 auto-swap behaviour preserved,
    //     and apply_state goes straight to "applied".
    // Without one of these branches the production/UI runs would silently NOT
    // swap (see swap-mechanism-audit F1).
    if (finalVerdict === Verdict.CONVERGED && finalImageTag) {
      // v2.6 polish: derive batchDir from flagBatchId, not from inputManifestPath.
      // inputManifestPath is overloaded — user mode passes the batch dir, demo
      // mode passes a yaml path. flagBatchId is the canonical identity.
      const batchDir = req.flagBatchId
        ? path.join(service.stateDir, "flag-batch", req.flagBatchId)
        : null;
      const autoApply = shouldAutoApplyOnConverge();
      try {
        if (autoApply) {
          // Legacy path: write swap-req.json and mark batch applied.
          const previousImage = readLastGoodImage(service.stateDir) ?? req.startingImage;
          writeSwapRequest(service.stateDir, {
            targetImage: finalImageTag,
            previousImage,
            triggerId,
            batchId: req.flagBatchId ?? req.inputSetId,
          });
          if (batchDir) {
            await updateBatchApplyState(batchDir, "applied");
          }
          evolutionLog.append({
            iter: finalIteration,
            stage: "swap-req-emit",
            event: "stage_end",
            data: {
              targetImage: finalImageTag,
              previousImage,
              autoApply: true,
            },
          });
        } else {
          // Default path: hand off to UI. swap-req.json is NOT written here.
          if (batchDir) {
            await updateBatchApplyState(batchDir, "ready_to_apply");
          }
          evolutionLog.append({
            iter: finalIteration,
            stage: "swap-req-emit",
            event: "stage_end",
            data: {
              targetImage: finalImageTag,
              autoApply: false,
              applyState: batchDir ? "ready_to_apply" : null,
              note: "ui_gate: swap-req.json deferred until POST /api/evolution/apply",
            },
          });
        }
      } catch (e) {
        // Don't crash the loop just because swap emission / batch state
        // update failed; the converged manifest is still on disk so a human
        // can swap manually.
        evolutionLog.append({
          iter: finalIteration,
          stage: "swap-req-emit",
          event: "stage_end",
          data: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    } else if (req.flagBatchId) {
      // v2.6: Non-CONVERGED terminal (need_more_work / max_iter_reached / etc.)
      // — mark the batch as `failed` so UI shows the row in error/done state
      // instead of leaving it stuck at "pending_evolution". This is the
      // completing-without-converge case the spec §8 state machine requires.
      // v2.6 polish: derive batchDir from flagBatchId (not inputManifestPath).
      const batchDir = path.join(service.stateDir, "flag-batch", req.flagBatchId);
      try {
        await updateBatchApplyState(batchDir, "failed");
        evolutionLog.append({
          iter: finalIteration,
          stage: "swap-req-emit",
          event: "stage_end",
          data: {
            applyState: "failed",
            verdict: finalVerdict,
            note: "non-converged terminal; batch marked failed",
          },
        });
      } catch (e) {
        evolutionLog.append({
          iter: finalIteration,
          stage: "swap-req-emit",
          event: "stage_end",
          data: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }

    // Fire terminal webhooks. Best-effort — errors are swallowed by fireWebhook
    // itself; we log them here for diagnostics.
    const batchId = req.flagBatchId ?? req.inputSetId;
    if (finalVerdict === Verdict.CONVERGED && finalImageTag) {
      await fireWebhook({
        event: "evolution-converged",
        batch_id: batchId,
        trigger_id: triggerId,
        iter_count: finalIteration,
        summary_path: `evo-loop-state/${batchId}/finalize/summary.md`,
        target_image: finalImageTag,
        previous_image: req.startingImage,
        duration_s: Math.floor((Date.now() - loopStartMs) / 1000),
        human_summary: `Evolution converged for ${batchId} in ${finalIteration} iteration(s). Target image: ${finalImageTag}.`,
      });
    } else if (finalVerdict === Verdict.PARTIAL_PROGRESS) {
      // User-initiated stop.
      await fireWebhook({
        event: "evolution-failed",
        batch_id: batchId,
        trigger_id: triggerId,
        iter_count: finalIteration,
        failed_stage: "user-stop",
        failed_iter: finalIteration,
        error_message: "stop requested by user",
        log_path: `evo-loop-state/${batchId}/evolution-log.jsonl`,
        human_summary: `Evolution stopped by user at iter ${finalIteration}.`,
      });
    } else {
      // Iter-limit exhaustion or non-converged verdict (NEED_MORE_WORK, etc.).
      await fireWebhook({
        event: "evolution-failed",
        batch_id: batchId,
        trigger_id: triggerId,
        iter_count: finalIteration,
        failed_stage: "iter-limit",
        failed_iter: finalIteration,
        error_message: `Reached iter limit ${finalIteration} without convergence`,
        log_path: `evo-loop-state/${batchId}/evolution-log.jsonl`,
        human_summary: `Evolution did not converge for ${batchId} within ${finalIteration} iteration(s).`,
      });
    }
  } catch (fatalErr) {
    // Generic stage error escaped the per-iter catch — fire failed webhook then
    // re-throw so the caller sees the error.
    const batchId = req.flagBatchId ?? req.inputSetId;
    const errorMessage = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    await fireWebhook({
      event: "evolution-failed",
      batch_id: batchId,
      trigger_id: triggerId,
      iter_count: finalIteration,
      failed_stage: "unknown",
      failed_iter: finalIteration,
      error_message: errorMessage,
      log_path: `evo-loop-state/${batchId}/iter-${finalIteration}/log.txt`,
      human_summary: `Evolution failed for ${batchId} at iter ${finalIteration}. Error: ${errorMessage}.`,
    });
    throw fatalErr;
  } finally {
    // Always clear the stop sentinel so the next trigger starts clean even if
    // this run was stopped mid-way.
    clearStopSentinel(service.stateDir);
    evolutionLog.close();
    // .lock will be cleared on next clean shutdown / boot-recover
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }

  return {
    triggerId,
    status: loadManifest(manifestPath).status,
    finalIteration,
    finalVerdict,
    finalImageTag,
  };
}

// Test-only: reset the module-level singleton (called by dry-run test setup).
export function _resetServiceForTests(): void {
  serviceHandle = null;
}

// Test-only: expose the singleton for direct state inspection in concurrency tests.
export function _getServiceHandleForTests(): ServiceState | null {
  return serviceHandle;
}

// Test-only: directly exercise runEvolutionLoop without going through the
// trigger() guard — used by the dry-run test which builds its own manifest.
export async function _runEvolutionLoopForTests(
  service: ServiceState,
  req: TriggerRequest,
): Promise<RunOutcome> {
  return runEvolutionLoop(service, req);
}
