// src/evolution/iteration.ts
//
// One full iteration's worth of state-machine logic (Stages 1..9). Extracted
// from loop.ts so the outer loop stays compact. Each call writes per-stage
// progress into manifest (currentStage), runs the role/RPC, finally calls
// `runFinalizeStage` to persist the IterationEntry + update manifest status.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvolutionLog } from "./evolution-log.js";
import { extractFinalAssistantMd } from "./extract-md.js";
import {
  type BaselineEvaluation,
  buildKeypointMatrix,
  computeIterPassRate,
  detectPlateau,
  formatMatrixForReviewer,
  type IterEvaluation,
  parseTaskEvaluation,
} from "./matrix.js";
import type { EvolutionMode } from "./modes/mode.js";
import { commitOpenclawIteration, readTrainResults } from "./openclaw-git.js";
import { loadPrompt } from "./prompt-loader.js";
import {
  composeCodeReviewerUserInput,
  composeImplementerUserInput,
  composeLocatorUserInput,
  composePlanReviewerUserInput,
  composePlannerUserInput,
  composeReviewerUserInput,
  composeTaskEvaluatorUserInput,
} from "./role-inputs.js";
import { runBuildStage } from "./stages/build.js";
import { runCodeLoop, type CodeLoopResult } from "./stages/code-loop.js";
import { runFinalizeStage } from "./stages/finalize.js";
import { runLocatorStage } from "./stages/locator.js";
import { runPlanLoop, type PlanLoopResult } from "./stages/plan-loop.js";
import { runReviewerStage } from "./stages/reviewer.js";
import { runTaskEvaluatorStage } from "./stages/task-evaluator.js";
import { runTrialStage } from "./stages/trial.js";
import { type EvolutionDepth, type IterationEntry, type Manifest, saveManifest } from "./state.js";
import type { TaskDefinition } from "./types/task-definition.js";
import {
  parseReviewerVerdict,
  tagVerdict,
  Verdict,
  type ImplementerOutcome,
  type StrategicReviewOutcome,
} from "./verdict.js";
import { bailIfStopRequested } from "./loop.js";

export interface LoopContext {
  stateDir: string;
  currentDir: string;
  manifestPath: string;
  tracesDir: string;
  evolutionLog: EvolutionLog;
  manifest: Manifest;
  openclawContainerDir: string;
  openclawHostRepoDir: string;
  hPre: string;
  /** v2.6: evolution mode strategy adapter (UserMode). iteration.ts delegates
   *  baseline + trial substrate to this. (Currently unused; Task 2.4 will wire
   *  it into Stage 7.) */
  mode: EvolutionMode;
  /** v2.6: depth tier (already baked into manifest.params; surfaced here so
   *  reviewer/task-evaluator wiring can read it without re-fetching). */
  depth: EvolutionDepth;
  /** v2.6: cross-mode TaskDefinition[] resolved once in Stage 0.5 from
   *  mode.getBaselineTaskDefinitions(). iteration.ts reads this for Stage 7.5. */
  tasks: TaskDefinition[];
  /** v2.6: per-task baseline evaluation (built in Stage 0.5). Keypoints from
   *  this map are LOCKED for all iter-N task-evaluator calls. */
  baselineEvals: Map<string, BaselineEvaluation>;
  /** v2.6: per-iter per-task evaluations accumulated through the loop. Keyed
   *  by iter number → task_id → IterEvaluation. */
  iterEvals: Map<number, Map<string, IterEvaluation>>;
}

export interface TriggerRequestRef {
  inputSetId: string;
  inputManifestPath: string;
  validationSet: string;
  stageATasks?: Array<{ id: string; baseline_score: number }>;
}

export interface ServiceCurrentRef {
  current: { triggerId: string; stage: string; iter: number; inputSetId: string } | null;
}

export interface IterationOutcome {
  entry: IterationEntry;
  verdict: Verdict;
  imageTag: string | null;
  sessionCrashed: boolean;
}

export async function runOneIteration(
  ctx: LoopContext,
  iter: number,
  req: TriggerRequestRef,
  service: ServiceCurrentRef,
  iterDir: string,
  iterStartMs: number,
): Promise<IterationOutcome> {
  const sharedAddDirs = [iterDir, ctx.openclawContainerDir];
  const sharedCwd = ctx.openclawContainerDir;
  const params = ctx.manifest.params;

  const updateStage = (stage: string): void => {
    service.current = {
      triggerId: ctx.manifest.triggerId,
      stage,
      iter,
      inputSetId: req.inputSetId,
    };
    ctx.manifest.currentStage = stage;
    saveManifest(ctx.manifestPath, ctx.manifest);
  };

  updateStage("locator");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "locator", ctx.evolutionLog);

  // train_tasks: prefer req.stageATasks when populated; fall back to ctx.tasks
  // (UserMode leaves stageATasks=[] but ctx.tasks is set in Stage 0.5 by
  // mode.getBaselineTaskDefinitions).
  const trainTaskIds = req.stageATasks?.length
    ? req.stageATasks.map((t) => t.id)
    : ctx.tasks.map((t) => t.task_id);
  const promptVars = {
    iteration: iter,
    max_iter: params.max_iter,
    batch_id: req.inputSetId,
    train_tasks: trainTaskIds.join(", "),
  };

  // Stage 1: Locator
  const locator = await runLocatorStage({
    iter,
    iterDir,
    tracesDir: ctx.tracesDir,
    systemPrompt: loadPrompt("locator", promptVars),
    userInput: composeLocatorUserInput({
      iter,
      inputSetId: req.inputSetId,
      inputManifestPath: req.inputManifestPath,
    }),
    evolutionLog: ctx.evolutionLog,
    timeoutS: params.locator_session_timeout_s,
    addContainerDirs: sharedAddDirs,
    cwdContainer: sharedCwd,
  });

  // Stage 2: plan-loop
  updateStage("plan-loop");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "plan-loop", ctx.evolutionLog);
  const planResult = await runPlanLoop({
    iter,
    iterDir,
    tracesDir: ctx.tracesDir,
    maxRounds: params.max_plan_rounds + 1,
    evolutionLog: ctx.evolutionLog,
    plannerSystemPrompt: loadPrompt("planner", promptVars),
    plannerUserInput: (round) => composePlannerUserInput(iter, locator.mdPath, round),
    plannerTimeoutS: params.planner_session_timeout_s,
    planReviewerSystemPrompt: loadPrompt("plan-reviewer", promptVars),
    planReviewerUserInput: (round) => composePlanReviewerUserInput(iter, locator.mdPath, round),
    planReviewerTimeoutS: params.plan_reviewer_session_timeout_s,
    addContainerDirs: sharedAddDirs,
    cwdContainer: sharedCwd,
    stateDir: ctx.stateDir,
    inputSetId: req.inputSetId,
  });
  if (planResult.verdict === "ABORTED") {
    return makeFailedIteration(
      ctx,
      iter,
      iterDir,
      iterStartMs,
      locator,
      planResult,
      null,
      Verdict.PLAN_REJECTED_MAX_ROUNDS,
    );
  }

  // Stage 4: code-loop (with hard-reset between rounds)
  updateStage("code-loop");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "code-loop", ctx.evolutionLog);
  const codeResult = await runCodeLoop({
    iter,
    iterDir,
    tracesDir: ctx.tracesDir,
    maxRounds: params.max_code_retries + 1,
    evolutionLog: ctx.evolutionLog,
    implementerSystemPrompt: loadPrompt("implementer", promptVars),
    implementerUserInput: composeImplementerUserInput(iter, planResult.planMdPath ?? ""),
    implementerTimeoutS: params.implementer_session_timeout_s,
    codeReviewerSystemPrompt: loadPrompt("code-reviewer", promptVars),
    codeReviewerUserInput: composeCodeReviewerUserInput(iter, planResult.planMdPath ?? ""),
    codeReviewerTimeoutS: params.code_reviewer_session_timeout_s,
    addContainerDirs: sharedAddDirs,
    cwdContainer: sharedCwd,
    hPre: ctx.hPre,
    stateDir: ctx.stateDir,
    inputSetId: req.inputSetId,
  });
  if (codeResult.verdict === "ABORTED") {
    return makeFailedIteration(
      ctx,
      iter,
      iterDir,
      iterStartMs,
      locator,
      planResult,
      codeResult,
      Verdict.CODE_REJECTED_MAX_ROUNDS,
    );
  }

  // Per-iter Implementer git commit. Routed through the host daemon — the
  // inner openclaw repo isn't visible from inside the container.
  const commitHash = await commitOpenclawIteration(ctx.openclawHostRepoDir, iter);

  // Stage 6: build + smoke
  updateStage("build");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "build", ctx.evolutionLog);
  const imageTag = `openclaw:v2.5-iter${iter}`;
  const build = await runBuildStage({
    iter,
    evolutionLog: ctx.evolutionLog,
    contextContainerDir: ctx.openclawContainerDir,
    imageTag,
  });
  fs.writeFileSync(path.join(iterDir, "image_tag.txt"), build.imageTag);
  if (commitHash) {
    fs.writeFileSync(path.join(iterDir, "commit.txt"), commitHash);
  }

  if (!build.buildOk || !build.buildSmokeOk) {
    const v = !build.buildOk ? Verdict.BUILD_FAILED : Verdict.BUILD_SMOKE_FAILED;
    return makeFailedIteration(
      ctx,
      iter,
      iterDir,
      iterStartMs,
      locator,
      planResult,
      codeResult,
      v,
      { commitHash, imageTag, buildOk: build.buildOk, buildSmokeOk: build.buildSmokeOk },
    );
  }

  // Stage 7: trial A — mode-agnostic via runBatchTrial. Demo path wraps the
  // claweval batch RPC; user path wraps the auto_replay worker-pool RPC.
  // Both produce per-(task, trial) trace files under
  // iter_dir/traces/stage_a_train/<task>/trial_<n>_transcript.jsonl, which
  // is exactly what Stage 7.5 task-evaluator reads.
  updateStage("trial_a");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "trial_a", ctx.evolutionLog);
  ctx.evolutionLog.append({
    iter,
    stage: "trial_a",
    event: "stage_start",
    data: {
      mode: ctx.mode.kind,
      imageTag,
      taskCount: ctx.tasks.length,
      nTrials: params.n_trials_per_task,
    },
  });
  const trialBatch = await ctx.mode.runBatchTrial({
    iter,
    tasks: ctx.tasks,
    imageTag,
    iterDir,
    nTrials: params.n_trials_per_task,
  });
  ctx.evolutionLog.append({
    iter,
    stage: "trial_a",
    event: "stage_end",
    data: {
      mode: ctx.mode.kind,
      perTaskCount: trialBatch.tasks.length,
      meanScore: trialBatch.meanScore,
      nPassed: trialBatch.nPassed,
      nFailed: trialBatch.nFailed,
    },
  });
  // Demo mode populates gradeSummaryPath; user mode leaves it undefined and
  // the orchestrator falls back to trainResults: [] (Stage 7.5 task-evaluator
  // becomes the sole verdict-grounding signal).
  const trainResults = trialBatch.gradeSummaryPath
    ? readTrainResults(trialBatch.gradeSummaryPath, req.stageATasks ?? [])
    : [];

  // Stage 7.5: per-task task-evaluator. Runs one Claude session per task,
  // scoring the same keypoints chosen at baseline (Stage 0.5). Output goes to
  // iteration_{iter}/task_evaluations/<task_id>.md and is parsed back into an
  // IterEvaluation so the matrix builder + plateau detector see it.
  updateStage("task-evaluator");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "task-evaluator", ctx.evolutionLog);
  const thisIterEvals = new Map<string, IterEvaluation>();
  const taskEvaluationPaths: Record<string, string> = {};
  for (let taskIndex = 0; taskIndex < ctx.tasks.length; taskIndex++) {
    const task = ctx.tasks[taskIndex];
    // Per-task progress event for the UI events panel — matches the
    // baseline-evaluator task_start contract in loop.ts.
    ctx.evolutionLog.append({
      iter,
      stage: "task-evaluator",
      event: "task_start",
      data: {
        task_id: task.task_id,
        task_name: task.task_name,
        task_index: taskIndex + 1,
        task_count: ctx.tasks.length,
      },
    });
    const baselineKeypoints = ctx.baselineEvals.get(task.task_id)?.keypoints ?? null;
    const tracesPath = path.join(iterDir, "traces/stage_a_train", task.task_id);
    const outputPath = path.join(iterDir, "task_evaluations", `${task.task_id}.md`);
    const result = await runTaskEvaluatorStage({
      iter,
      iterDir,
      tracesDir: ctx.tracesDir,
      taskId: task.task_id,
      systemPrompt: loadPrompt("task-evaluator", promptVars),
      userInput: composeTaskEvaluatorUserInput({
        iter,
        task: { task_id: task.task_id, task_name: task.task_name },
        tracesPath,
        outputPath,
        keypointsList: baselineKeypoints,
      }),
      addContainerDirs: sharedAddDirs,
      cwdContainer: sharedCwd,
      timeoutS: params.task_evaluator_session_timeout_s,
      evolutionLog: ctx.evolutionLog,
    });
    taskEvaluationPaths[task.task_id] = result.mdPath;
    const md = fs.existsSync(result.mdPath) ? fs.readFileSync(result.mdPath, "utf8") : "";
    thisIterEvals.set(task.task_id, parseTaskEvaluation(md));
  }
  ctx.iterEvals.set(iter, thisIterEvals);
  const taskEvalPassRate = computeIterPassRate(thisIterEvals);

  // Stage 8: reviewer. Reads task_evaluations/*.md + a pre-formatted keypoint
  // matrix and issues a 4-verdict decision (CONVERGED / NEED_MORE_WORK /
  // FUNDAMENTAL_LIMIT_MODEL / FUNDAMENTAL_LIMIT_ARCHITECTURE). Plateau
  // adjustment is applied below (orchestrator may downgrade NEED_MORE_WORK).
  updateStage("reviewer");
  bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "reviewer", ctx.evolutionLog);
  const matrix = buildKeypointMatrix(ctx.baselineEvals, ctx.iterEvals);
  const matrixSummary = formatMatrixForReviewer(matrix);
  const priorReviewerMdPath =
    iter > 1 ? path.join(ctx.currentDir, `iteration_${iter - 1}`, "reviewer.md") : null;
  const reviewer = await runReviewerStage({
    iter,
    iterDir,
    tracesDir: ctx.tracesDir,
    systemPrompt: loadPrompt("reviewer", promptVars),
    userInput: composeReviewerUserInput({
      iter,
      iterDir,
      priorReviewerMdPath,
      matrixSummary,
    }),
    evolutionLog: ctx.evolutionLog,
    timeoutS: params.reviewer_session_timeout_s,
    addContainerDirs: sharedAddDirs,
    cwdContainer: sharedCwd,
  });
  const reviewerMd = extractFinalAssistantMd(reviewer.tracePath);
  let reviewerVerdictRaw =
    parseReviewerVerdict(reviewerMd) || parseReviewerVerdict(reviewer.mdPath);

  // Plateau adjustment: if reviewer said NEED_MORE_WORK but the matrix shows
  // no row improved across the last (N+1) cells (N from depth tier), the
  // orchestrator downgrades the verdict to CONVERGED. Reasoning stays in
  // reviewer.md; an evolution-log entry records the override.
  if (reviewerVerdictRaw === "NEED_MORE_WORK" && detectPlateau(matrix, ctx.depth)) {
    ctx.evolutionLog.append({
      iter,
      stage: "plateau-override",
      event: "verdict",
      data: {
        original: "NEED_MORE_WORK",
        adjusted: "CONVERGED",
        depth: ctx.depth,
      },
    });
    reviewerVerdictRaw = "CONVERGED";
  }

  const strategicReview: StrategicReviewOutcome = {
    // Map the new 4-verdict closed set back to the v2.5 verdict.ts contract.
    // verdict.ts:tagVerdict still uses APPROVE_CONVERGED-keyed branches.
    verdict: reviewerVerdictRaw === "CONVERGED" ? "APPROVE_CONVERGED" : reviewerVerdictRaw,
    feedbackMd: reviewerMd,
  };

  const implOutcome: ImplementerOutcome = {
    commitHash,
    buildOk: build.buildOk,
    testsOk: true,
    buildSmokeOk: build.buildSmokeOk,
  };
  const verdict = tagVerdict({
    stageATrials: trainResults,
    implementer: implOutcome,
    strategicReview,
  });

  // Optional Stage 9b: validation when CONVERGED
  let validationRun: { trials: number; meanScore: number } | null = null;
  if (verdict === Verdict.CONVERGED && req.validationSet) {
    updateStage("trial_c");
    bailIfStopRequested(ctx.stateDir, req.inputSetId, iter, "trial_c", ctx.evolutionLog);
    const trialC = await runTrialStage({
      iter,
      evolutionLog: ctx.evolutionLog,
      imageTag,
      manifestContainerPath: req.validationSet,
      iterContainerDir: iterDir,
      nTrials: params.validation_trials,
      stage: "c",
    });
    validationRun = { trials: params.validation_trials, meanScore: trialC.meanScore };
  }

  const elapsedS = (Date.now() - iterStartMs) / 1000;
  const entry: IterationEntry = {
    iteration: iter,
    verdict,
    commitHash,
    imageTag,
    trainResults,
    validationRun,
    diagnosisMdPath: locator.mdPath,
    planMdPath: planResult.planMdPath,
    planReviewerMdPath: planResult.planReviewerMdPath,
    implementerMdPath: codeResult.implementerMdPath,
    codeReviewerMdPath: codeResult.codeReviewerMdPath,
    reviewerMdPath: reviewer.mdPath,
    reviewerVerdict: reviewerVerdictRaw || null,
    taskEvaluations: taskEvaluationPaths,
    taskEvalPassRate,
    elapsedS,
    planRoundCount: planResult.rounds,
    codeRoundCount: codeResult.rounds,
    sessionIdByRole: {
      locator: locator.sessionId,
      planner: planResult.plannerSessionId,
      plan_reviewer: planResult.planReviewerSessionId,
      implementer: codeResult.implementerSessionId,
      code_reviewer: codeResult.codeReviewerSessionId,
      reviewer: reviewer.sessionId,
    },
  };

  // Stage 9: finalize (atomic + fsync)
  const nextStatus: Manifest["status"] =
    verdict === Verdict.CONVERGED ? "swap_pending" : "in_progress";
  await runFinalizeStage({
    iter,
    iterDir,
    manifestPath: ctx.manifestPath,
    evolutionLog: ctx.evolutionLog,
    iterationEntry: entry,
    verdict,
    nextStatus,
  });

  return { entry, verdict, imageTag, sessionCrashed: false };
}

function makeFailedIteration(
  ctx: LoopContext,
  iter: number,
  iterDir: string,
  iterStartMs: number,
  locator: { mdPath: string; sessionId: string },
  planResult: PlanLoopResult,
  codeResult: CodeLoopResult | null,
  verdict: Verdict,
  buildState?: {
    commitHash: string | null;
    imageTag: string;
    buildOk: boolean;
    buildSmokeOk: boolean;
  },
): IterationOutcome {
  const elapsedS = (Date.now() - iterStartMs) / 1000;
  const entry: IterationEntry = {
    iteration: iter,
    verdict,
    commitHash: buildState?.commitHash ?? null,
    imageTag: buildState?.imageTag ?? null,
    trainResults: [],
    validationRun: null,
    diagnosisMdPath: locator.mdPath,
    planMdPath: planResult.planMdPath,
    planReviewerMdPath: planResult.planReviewerMdPath,
    implementerMdPath: codeResult?.implementerMdPath ?? null,
    codeReviewerMdPath: codeResult?.codeReviewerMdPath ?? null,
    reviewerMdPath: null,
    reviewerVerdict: null,
    taskEvaluations: {},
    taskEvalPassRate: 0,
    elapsedS,
    planRoundCount: planResult.rounds,
    codeRoundCount: codeResult?.rounds ?? 0,
    sessionIdByRole: {
      locator: locator.sessionId,
      planner: planResult.plannerSessionId,
      plan_reviewer: planResult.planReviewerSessionId,
      implementer: codeResult?.implementerSessionId ?? "",
      code_reviewer: codeResult?.codeReviewerSessionId ?? "",
    },
  };
  void runFinalizeStage({
    iter,
    iterDir,
    manifestPath: ctx.manifestPath,
    evolutionLog: ctx.evolutionLog,
    iterationEntry: entry,
    verdict,
    nextStatus: "in_progress",
  });
  return { entry, verdict, imageTag: buildState?.imageTag ?? null, sessionCrashed: false };
}
