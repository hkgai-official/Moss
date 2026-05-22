// src/evolution/stages/task-evaluator.ts
//
// Stage 7.5 handler — runs the per-task task-evaluator role.
// Reads the trial traces for one task, produces a structured md eval at
// `<iterDir>/task_evaluations/<task_id>.md`. The matrix builder later parses
// these md files into IterEvaluation records.
import type { EvolutionLog } from "../evolution-log.js";
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface TaskEvaluatorStageInput {
  iter: number;
  /** Container-abs path of iter dir (stage-helper will resolve to host). */
  iterDir: string;
  tracesDir: string;
  /** Per-task subpath under iter dir: task_evaluations/<task_id>.md */
  taskId: string;
  systemPrompt: string;
  userInput: string;
  addContainerDirs: string[];
  cwdContainer: string;
  timeoutS: number;
  evolutionLog: EvolutionLog;
}

export async function runTaskEvaluatorStage(
  input: TaskEvaluatorStageInput,
): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "task_evaluator",
    stage: "task-evaluator",
    mdFilename: `task_evaluations/${input.taskId}.md`,
    systemPrompt: input.systemPrompt,
    userInput: input.userInput,
    addContainerDirs: input.addContainerDirs,
    cwdContainer: input.cwdContainer,
    timeoutS: input.timeoutS,
    evolutionLog: input.evolutionLog,
    taskId: input.taskId,
  });
}
