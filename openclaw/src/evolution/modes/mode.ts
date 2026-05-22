// src/evolution/modes/mode.ts
//
// Strategy pattern interface. UserMode implements this.
// loop.ts is mode-agnostic: it delegates the four variance points
// (baseline task definitions / baseline trace / iter trial / locator extra
// context) to req.mode.

import type { TaskDefinition } from "../types/task-definition.js";

export interface TrialArgs {
  iter: number;
  task: TaskDefinition;
  imageTag: string;
  iterDir: string; // host-abs, for trace output
}

export interface BatchTrialArgs {
  iter: number;
  tasks: TaskDefinition[];
  imageTag: string;
  iterDir: string; // host-abs, for trace output
  nTrials: number; // per-task
}

/** Per-task result inside a BatchTrialResult. */
export interface BatchTrialTaskResult {
  taskId: string;
  trialN: number;
  tracePath: string;
  exitCode: number;
}

export interface BatchTrialResult {
  /** One entry per (task, trial). UserMode populates this directly from
   *  per-task auto_replay trials. */
  tasks: BatchTrialTaskResult[];
  /** Optional grade_summary path. UserMode uses task-evaluator instead, so
   *  this stays undefined and iteration.ts falls back to trainResults: []. */
  gradeSummaryPath?: string;
  /** Optional aggregate score from a batch RPC (unused by UserMode). */
  meanScore?: number;
  nPassed?: number;
  nFailed?: number;
}

export interface LocatorExtraContext {
  flagBatchId: string | null;
  flagBatchDir: string | null; // host-abs path to flag-batch dir
}

export interface EvolutionMode {
  readonly kind: "user";

  getBaselineTaskDefinitions(): Promise<TaskDefinition[]>;
  loadBaselineTrace(task: TaskDefinition): Promise<unknown>;
  /** Stage 0.5: produce a container-readable directory of baseline trace
   *  files that the task-evaluator can ingest. UserMode materializes the
   *  flag snapshot's agent_trace into a transcript JSONL under
   *  `<baselineDir>/traces/<task_id>/` and returns that path. */
  prepareBaselineTracesForTask(task: TaskDefinition, baselineDir: string): Promise<string>;
  /** Stage 7 trial substrate. UserMode spawns a worker pool internally. */
  runBatchTrial(args: BatchTrialArgs): Promise<BatchTrialResult>;
  /** Legacy per-task API retained for completeness — Task 2.4 calls
   *  runBatchTrial instead. Implementations may treat this as advisory
   *  (e.g. internally invoke runBatchTrial with a single-task list). */
  runIterTrial(args: TrialArgs): Promise<unknown>;
  getLocatorExtraContext(): Promise<LocatorExtraContext>;
}
