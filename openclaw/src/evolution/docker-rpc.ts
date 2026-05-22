// src/evolution/docker-rpc.ts
//
// Typed wrappers around the host-daemon docker-* ops. All paths in the request
// payloads must already be host-absolute (use `pathToHost()` before calling).
import { rpcCall } from "./rpc-client.js";

// Narrow `unknown` (from Record<string, unknown>) to a string. The wire format
// only ever sends primitives at these slots, but we still avoid String(x)
// because that risks "[object Object]" on accidental shape drift and trips
// typescript-eslint(no-base-to-string).
function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  return fallback;
}

export interface DockerBuildResult {
  imageId: string;
  sizeMb: number;
}

export interface RunTrialRequest {
  imageTag: string;
  manifestPath: string; // host abs
  nTrials: number;
  iterDir: string; // host abs
  stage: "a" | "c";
}

export interface RunTrialResult {
  gradeSummaryPath: string;
  nPassed: number;
  nFailed: number;
  meanScore: number;
}

export interface BuildSmokeResult {
  ok: boolean;
  failedStep: string | null;
  logTail: string;
}

export async function dockerBuild(opts: {
  tag: string;
  contextDir: string;
}): Promise<DockerBuildResult> {
  const r = await rpcCall("docker-build", {
    tag: opts.tag,
    context_dir: opts.contextDir,
  });
  return {
    imageId: asString(r.image_id),
    sizeMb: Number(r.size_mb ?? 0),
  };
}

export async function runTrial(req: RunTrialRequest): Promise<RunTrialResult> {
  const r = await rpcCall("run-trial", {
    image_tag: req.imageTag,
    manifest_path: req.manifestPath,
    n_trials: req.nTrials,
    iter_dir: req.iterDir,
    stage: req.stage,
  });
  return {
    gradeSummaryPath: asString(r.grade_summary_path),
    nPassed: Number(r.n_passed ?? 0),
    nFailed: Number(r.n_failed ?? 0),
    meanScore: Number(r.mean_score ?? 0),
  };
}

export async function buildSmoke(opts: { imageTag: string }): Promise<BuildSmokeResult> {
  const r = await rpcCall("build-smoke", { image_tag: opts.imageTag });
  const failed = r.failed_step;
  return {
    ok: Boolean(r.ok),
    failedStep: typeof failed === "string" ? failed : null,
    logTail: asString(r.log_tail),
  };
}

export async function hardResetOpenclaw(opts: { hPre: string }): Promise<{ ok: boolean }> {
  const r = await rpcCall("hard-reset-openclaw", { h_pre: opts.hPre });
  return { ok: Boolean(r.ok) };
}

// ---------------------------------------------------------------------------
// v2.6: UserMode batch trial substrate RPC
// Server-side in host-daemon trial_runner.handle_run_user_mode_batch_trial.
// Worker-pool semantics mirror demo mode's run-trial: spawn N workers
// (default 3) in parallel, set them up ONCE, then dispatch (task, trial)
// pairs from an asyncio queue. Per task: run agent with user_prompt and
// collect transcript. The candidate image is expected to carry whatever
// tools the agent might call (sandboxed by assumption).
// ---------------------------------------------------------------------------

export interface UserModeBatchTrialTask {
  taskId: string;
  userPrompt: string;
}

export interface RunUserModeBatchTrialRequest {
  imageTag: string;
  iterDir: string;
  tasks: UserModeBatchTrialTask[];
  /** Trials per task (Stage A; default 1). */
  nTrials?: number;
  /** Concurrent worker pool size (default 3, capped at tasks.length). */
  nWorkers?: number;
  perTaskTimeoutS?: number;
}

export interface RunUserModeBatchTrialPerTaskResult {
  taskId: string;
  trialN: number;
  tracePath: string;
  exitCode: number;
}

export interface RunUserModeBatchTrialResult {
  tasks: RunUserModeBatchTrialPerTaskResult[];
  nWorkers: number;
}

export async function runUserModeBatchTrial(
  req: RunUserModeBatchTrialRequest,
): Promise<RunUserModeBatchTrialResult> {
  const payload: Record<string, unknown> = {
    image_tag: req.imageTag,
    iter_dir: req.iterDir,
    tasks: req.tasks.map((t) => ({
      task_id: t.taskId,
      user_prompt: t.userPrompt,
    })),
  };
  if (req.nTrials !== undefined) {payload.n_trials = req.nTrials;}
  if (req.nWorkers !== undefined) {payload.n_workers = req.nWorkers;}
  if (req.perTaskTimeoutS !== undefined) {payload.per_task_timeout_s = req.perTaskTimeoutS;}

  const r = await rpcCall("run-user-mode-batch-trial", payload);
  const rawTasks = (r.tasks as Array<Record<string, unknown>>) ?? [];
  return {
    tasks: rawTasks.map((t) => ({
      taskId: asString(t.task_id),
      trialN: Number(t.trial_n ?? 1),
      tracePath: asString(t.trace_path),
      exitCode: Number(t.exit_code ?? -1),
    })),
    nWorkers: Number(r.n_workers ?? 0),
  };
}

export interface CommitOpenclawIterResult {
  commitHash: string;
  staged: boolean;
}

/** Stage + commit any post-Implementer mutations in the inner openclaw
 *  repo and return HEAD. Must go through the daemon because the inner repo
 *  is NOT mounted into the moss-gateway container (only HOST_DATA_DIR + a
 *  read-only /app/src view are mounted; see docker-compose.yml). */
export async function commitOpenclawIter(opts: {
  iter: number;
}): Promise<CommitOpenclawIterResult> {
  const r = await rpcCall("commit-openclaw-iter", { iter: opts.iter });
  return {
    commitHash: asString(r.commit_hash),
    staged: Boolean(r.staged),
  };
}

export interface GetBaselineCommitResult {
  hPre: string;
  repoDir: string;
}

/** Return the inner openclaw repo's current HEAD sha (H_pre). Used by
 *  `startEvolutionService` preflight in lieu of the prior in-container
 *  `fs.existsSync` + `execFileSync('git rev-parse HEAD')` against a host
 *  path the container cannot see. The daemon owns the repo path lookup. */
export async function getBaselineCommit(): Promise<GetBaselineCommitResult> {
  const r = await rpcCall("get-baseline-commit", {});
  return {
    hPre: asString(r.h_pre),
    repoDir: asString(r.repo_dir),
  };
}

// ---------------------------------------------------------------------------
// Generic single-shot RPC helper (re-exports rpcCall under a stable name so
// callers outside this module don't need to import rpc-client directly).
// ---------------------------------------------------------------------------

/** Fire-and-await a single RPC op against the host daemon. Reads streamed
 *  responses until type=result or type=error. For one-shot ops like
 *  kill-orphan this is a single round-trip.
 *
 *  Throws on type=error response or socket connection failure. */
export async function callHostDaemonOp<T = Record<string, unknown>>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  return rpcCall(op, payload) as Promise<T>;
}
