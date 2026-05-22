// src/evolution/state.ts
//
// Manifest read/write with atomic writes (tmp file + fsync + rename) so a
// crash mid-write cannot corrupt prior state. TS port of v2_2/lib/state.py.
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlagBatch } from "./types/flag-batch.js";
import type { Verdict } from "./verdict.js";

export interface TrainResult {
  task: string;
  trial: number;
  score: number;
  baselineScore: number;
  judgePassed: boolean;
}

export interface ValidationRun {
  trials: number;
  meanScore: number;
}

export interface IterationEntry {
  iteration: number;
  verdict: Verdict;
  commitHash: string | null;
  imageTag: string | null;
  trainResults: TrainResult[];
  validationRun: ValidationRun | null;
  diagnosisMdPath: string | null;
  planMdPath: string | null;
  planReviewerMdPath: string | null;
  implementerMdPath: string | null;
  codeReviewerMdPath: string | null;
  reviewerMdPath: string | null;
  reviewerVerdict: string | null;
  /** v2.6: per-task task-evaluator output paths keyed by task_id */
  taskEvaluations: Record<string, string>;
  /** v2.6 polish: per-iter keypoint pass rate from task-evaluator output.
   *  Range [0, 1]. Optional because (a) old v5/v6 archives don't have it
   *  and (b) failed iterations that never ran task-evaluator have no
   *  meaningful value. Consumers read via `?? 0` fallback. */
  taskEvalPassRate?: number;
  elapsedS: number;
  planRoundCount: number;
  codeRoundCount: number;
  sessionIdByRole: Record<string, string> | null;
}

export type ManifestStatus =
  | "initialized"
  | "in_progress"
  | "swap_pending"
  | "converged"
  | "rolled_back"
  | "failed"
  | "aborted_max_iter"
  | "aborted_streak";

export interface SwapOutcome {
  targetImage: string;
  status: "success" | "rolled_back";
  rollbackReason?: string;
}

export interface ManifestParams {
  max_iter: number;
  max_plan_rounds: number;
  max_code_retries: number;
  n_trials_per_task: number;
  claweval_task_timeout_s: number;
  validation_trials: number;
  build_smoke_timeout_s: number;
  docker_build_timeout_s: number;
  consecutive_build_failures_for_abort: number;
  consecutive_session_crashes_for_abort: number;
  no_progress_streak_limit: number;
  progress_no_approve_streak_limit: number;
  locator_session_timeout_s: number;
  planner_session_timeout_s: number;
  plan_reviewer_session_timeout_s: number;
  implementer_session_timeout_s: number;
  code_reviewer_session_timeout_s: number;
  strategic_reviewer_timeout_s: number;
  /** v2.6: per-task task-evaluator session timeout (used in Stage 0.5 baseline + Stage 7.5 per-iter). */
  task_evaluator_session_timeout_s: number;
  /** v2.6: reviewer session timeout (Stage 8 — succeeds Strategic Reviewer). */
  reviewer_session_timeout_s: number;
  plateau_no_improvement_iters: number;
  // Optional members tracked by spec but unused in v0 dry-run
  swap_window_s?: number;
  probe_interval_s?: number;
  probe_required_pass_count?: number;
  heartbeat_max_staleness_s?: number;
  stale_lock_threshold_s?: number;
  [extra: string]: number | boolean | undefined;
}

export const DEFAULT_PARAMS: ManifestParams = {
  max_iter: 3,
  max_plan_rounds: 2,
  max_code_retries: 1,
  n_trials_per_task: 3,
  claweval_task_timeout_s: 300,
  validation_trials: 1,
  build_smoke_timeout_s: 240,
  docker_build_timeout_s: 600,
  consecutive_build_failures_for_abort: 3,
  consecutive_session_crashes_for_abort: 3,
  no_progress_streak_limit: 3,
  progress_no_approve_streak_limit: 4,
  locator_session_timeout_s: 1800,
  planner_session_timeout_s: 1800,
  plan_reviewer_session_timeout_s: 1500,
  implementer_session_timeout_s: 3600,
  code_reviewer_session_timeout_s: 1800,
  strategic_reviewer_timeout_s: 1200,
  task_evaluator_session_timeout_s: 1500,
  reviewer_session_timeout_s: 1200,
  plateau_no_improvement_iters: 2,
  swap_window_s: 90,
  probe_interval_s: 5,
  probe_required_pass_count: 3,
  heartbeat_max_staleness_s: 30,
  stale_lock_threshold_s: 300,
};

export type EvolutionDepth = "shallow" | "standard" | "deep";

export const DEFAULT_PARAMS_BY_DEPTH: Record<EvolutionDepth, ManifestParams> = {
  shallow: {
    ...DEFAULT_PARAMS,
    max_iter: 3,
    max_plan_rounds: 1,
    max_code_retries: 0,
    n_trials_per_task: 2,
    plateau_no_improvement_iters: 1,
  },
  standard: {
    ...DEFAULT_PARAMS,
    max_iter: 5,
    max_plan_rounds: 2,
    max_code_retries: 1,
    n_trials_per_task: 3,
    plateau_no_improvement_iters: 2,
  },
  deep: {
    ...DEFAULT_PARAMS,
    max_iter: 8,
    max_plan_rounds: 3,
    max_code_retries: 2,
    n_trials_per_task: 5,
    plateau_no_improvement_iters: 3,
  },
};

export interface Streaks {
  consecutiveBuildFailures: number;
  consecutiveSessionCrashes: number;
  noProgress: number;
  progressNoApprove: number;
}

export interface BatchTaskRef {
  id: string;
  baseline_score: number;
}

export interface Manifest {
  schemaVersion: 6;
  /** v2.6: which EvolutionMode was used to run this trigger */
  mode: "user";
  /** v2.6: evolution_depth tier — controls max_iter / max_plan_rounds / etc */
  evolutionDepth: EvolutionDepth;
  /** v2.6: when mode==user, the flag-batch id consumed by this trigger; null in demo */
  flagBatchId: string | null;
  triggerId: string;
  triggerSource: "manual" | "marked-issues" | "cron";
  triggeredAt: number;
  triggeredBy: string;
  inputSetId: string;
  inputManifestPath: string;
  startingImage: string;
  startingCommit: string | null;
  startingBranch: string;
  evolutionBranch: string;
  params: ManifestParams;
  tasks: { stage_a: BatchTaskRef[]; stage_c: BatchTaskRef[] };
  validationSet: string;
  status: ManifestStatus;
  currentIteration: number;
  currentStage: string;
  iterations: IterationEntry[];
  streaks: Streaks;
  /** Highest `taskEvalPassRate` observed across iterations so far. Used by
   *  verdict.ts:262 to compute `madeProgress` for the noProgress streak.
   *
   *  **Scale**: [0, 1] in task-evaluator keypoint-pass-rate units
   *  (mean of TAG_ORDER[cell]/3 across keypoints), NOT claweval grader
   *  task_score units. The two scales were unified in v2.6 polish work to
   *  fix a silent streak regression. finalize.ts writes this value from
   *  `entry.taskEvalPassRate`; loop.ts reads it for the streak comparison. */
  bestScoreSoFar: number;
  swapOutcome: SwapOutcome | null;
}

export function loadManifest(p: string): Manifest {
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.schemaVersion === 5) {
    return readV5AsV6(parsed);
  }
  return parsed as unknown as Manifest;
}

/**
 * v2.6 UI: read a FlagBatch with read-time defaults for the 5 new fields
 * (origin, user_label, depth, created_by, apply_state). Legacy v6 _batch.json
 * fixtures (pre-UI) lack these fields; this defaulter keeps them readable.
 *
 * Defaults:
 *   - origin: inferred from batch_id prefix. Demo prefixes on disk:
 *       - "demo-*"        — claweval demo fixtures (curated batches)
 *       - "sim-*"         — simulator-generated demo batches
 *       - "batch_demo_*"  — legacy v2.6-era naming, kept for forward-compat
 *     anything else → "user"
 *   - user_label: null
 *   - depth: "standard"
 *   - created_by: "cli"
 *   - apply_state: "applied" if status==="archived", else "pending_evolution"
 */
export function readFlagBatchWithDefaults(raw: unknown): FlagBatch {
  if (raw == null || typeof raw !== "object") {
    throw new Error("readFlagBatchWithDefaults: input must be a non-null object");
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.batch_id === "string" ? r.batch_id : "";
  const isDemoPrefix =
    id.startsWith("demo-") || id.startsWith("sim-") || id.startsWith("batch_demo_");
  const inferred_origin: FlagBatch["origin"] = isDemoPrefix ? "demo" : "user";
  const default_apply_state: FlagBatch["apply_state"] =
    r.status === "archived" ? "applied" : "pending_evolution";
  return {
    batch_id: r.batch_id as string,
    created_at: (r.created_at as number | undefined) ?? 0,
    status: (r.status as FlagBatch["status"] | undefined) ?? "current",
    threshold: (r.threshold as number | undefined) ?? 4,
    trigger_mode: (r.trigger_mode as FlagBatch["trigger_mode"] | undefined) ?? "manual",
    triggered_at: (r.triggered_at as number | null | undefined) ?? null,
    triggered_evolution_trigger_id:
      (r.triggered_evolution_trigger_id as string | null | undefined) ?? null,
    flag_count: (r.flag_count as number | undefined) ?? 0,
    origin: (r.origin as FlagBatch["origin"] | undefined) ?? inferred_origin,
    user_label: (r.user_label as string | null | undefined) ?? null,
    depth: (r.depth as FlagBatch["depth"] | undefined) ?? "standard",
    created_by: (r.created_by as FlagBatch["created_by"] | undefined) ?? "cli",
    apply_state: (r.apply_state as FlagBatch["apply_state"] | undefined) ?? default_apply_state,
  };
}

/**
 * Read a v5 manifest and adapt fields so it satisfies the v6 Manifest type.
 * Read-only adaptation: does NOT mutate the on-disk file. v5 archives stay v5.
 */
function readV5AsV6(v5: Record<string, unknown>): Manifest {
  const params = (v5.params ?? {}) as Record<string, unknown>;
  const iterations = ((v5.iterations as Array<Record<string, unknown>>) ?? []).map((iter) => ({
    iteration: iter.iteration,
    verdict: iter.verdict,
    commitHash: iter.commitHash ?? null,
    imageTag: iter.imageTag ?? null,
    trainResults: iter.trainResults ?? [],
    validationRun: iter.validationRun ?? null,
    diagnosisMdPath: iter.diagnosisMdPath ?? null,
    planMdPath: iter.planMdPath ?? null,
    planReviewerMdPath: iter.planReviewerMdPath ?? null,
    implementerMdPath: iter.implementerMdPath ?? null,
    codeReviewerMdPath: iter.codeReviewerMdPath ?? null,
    // RENAMED in v6
    reviewerMdPath: iter.strategicReviewMdPath ?? iter.reviewerMdPath ?? null,
    reviewerVerdict: iter.strategicVerdict ?? iter.reviewerVerdict ?? null,
    // NEW in v6
    taskEvaluations: iter.taskEvaluations ?? {},
    elapsedS: iter.elapsedS ?? 0,
    planRoundCount: iter.planRoundCount ?? 0,
    codeRoundCount: iter.codeRoundCount ?? 0,
    sessionIdByRole: iter.sessionIdByRole ?? null,
  })) as IterationEntry[];

  return {
    schemaVersion: 6,
    // NEW v6 fields — assume v5 archives were all demo mode @ standard depth
    mode: "user",
    evolutionDepth: "standard",
    flagBatchId: null,
    triggerId: v5.triggerId as string,
    triggerSource: v5.triggerSource as Manifest["triggerSource"],
    triggeredAt: v5.triggeredAt as number,
    triggeredBy: v5.triggeredBy as string,
    inputSetId: v5.inputSetId as string,
    inputManifestPath: v5.inputManifestPath as string,
    startingImage: v5.startingImage as string,
    startingCommit: (v5.startingCommit as string | null) ?? null,
    startingBranch: v5.startingBranch as string,
    evolutionBranch: v5.evolutionBranch as string,
    params: {
      ...DEFAULT_PARAMS,
      ...(params as Partial<ManifestParams>),
      // v5 had max_code_rounds; v6 uses max_code_retries
      max_code_retries:
        (params.max_code_retries as number | undefined) ??
        (params.max_code_rounds as number | undefined) ??
        1,
      plateau_no_improvement_iters:
        (params.plateau_no_improvement_iters as number | undefined) ?? 2,
    },
    tasks: (v5.tasks as Manifest["tasks"]) ?? { stage_a: [], stage_c: [] },
    validationSet: (v5.validationSet as string) ?? "",
    status: v5.status as ManifestStatus,
    currentIteration: (v5.currentIteration as number) ?? 0,
    currentStage: (v5.currentStage as string) ?? "init",
    iterations,
    streaks: (v5.streaks as Streaks) ?? {
      consecutiveBuildFailures: 0,
      consecutiveSessionCrashes: 0,
      noProgress: 0,
      progressNoApprove: 0,
    },
    bestScoreSoFar: (v5.bestScoreSoFar as number) ?? 0,
    swapOutcome: (v5.swapOutcome as SwapOutcome | null) ?? null,
  };
}

/** Atomic write: write to {p}.tmp in same dir, fsync, then rename. */
export function saveManifest(p: string, m: Manifest): void {
  const dir = path.dirname(p);
  // ensure parent dir exists
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + ".tmp";
  const data = JSON.stringify(m, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

export function appendIteration(p: string, entry: IterationEntry): void {
  const m = loadManifest(p);
  m.iterations.push(entry);
  m.currentIteration = entry.iteration;
  saveManifest(p, m);
}

export interface CreateManifestArgs {
  triggerId: string;
  triggerSource: "manual" | "marked-issues" | "cron";
  triggeredBy: string;
  inputSetId: string;
  inputManifestPath: string;
  startingImage: string;
  startingCommit: string | null;
  startingBranch: string;
  evolutionBranch: string;
  validationSet: string;
  params?: Partial<ManifestParams>;
  tasks?: { stage_a: BatchTaskRef[]; stage_c: BatchTaskRef[] };
  /** v2.6: defaults to "user" when omitted */
  mode?: "user";
  /** v2.6: defaults to "standard" when omitted; applied as base, params overrides win */
  evolutionDepth?: EvolutionDepth;
  /** v2.6: only set when mode==="user" */
  flagBatchId?: string | null;
}

export function createManifest(args: CreateManifestArgs): Manifest {
  const mode = args.mode ?? "user";
  const evolutionDepth = args.evolutionDepth ?? "standard";
  const depthParams = DEFAULT_PARAMS_BY_DEPTH[evolutionDepth];
  const params: ManifestParams = { ...depthParams, ...args.params };
  return {
    schemaVersion: 6,
    mode,
    evolutionDepth,
    flagBatchId: args.flagBatchId ?? null,
    triggerId: args.triggerId,
    triggerSource: args.triggerSource,
    triggeredAt: Date.now(),
    triggeredBy: args.triggeredBy,
    inputSetId: args.inputSetId,
    inputManifestPath: args.inputManifestPath,
    startingImage: args.startingImage,
    startingCommit: args.startingCommit,
    startingBranch: args.startingBranch,
    evolutionBranch: args.evolutionBranch,
    params,
    tasks: args.tasks ?? { stage_a: [], stage_c: [] },
    validationSet: args.validationSet,
    status: "initialized",
    currentIteration: 0,
    currentStage: "init",
    iterations: [],
    streaks: {
      consecutiveBuildFailures: 0,
      consecutiveSessionCrashes: 0,
      noProgress: 0,
      progressNoApprove: 0,
    },
    bestScoreSoFar: 0,
    swapOutcome: null,
  };
}
