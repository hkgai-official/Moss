// src/evolution/stages/reviewer.ts
//
// Stage 8: Reviewer (v2.6 — succeeds Strategic Reviewer).
// Reads per-task task_evaluations/*.md + keypoint matrix; emits one of 4
// verdicts: CONVERGED / NEED_MORE_WORK / FUNDAMENTAL_LIMIT_MODEL /
// FUNDAMENTAL_LIMIT_ARCHITECTURE. Plateau detection runs AFTER and may
// downgrade NEED_MORE_WORK → CONVERGED based on depth tier.
import type { EvolutionLog } from "../evolution-log.js";
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface ReviewerStageInput {
  iter: number;
  iterDir: string;
  tracesDir: string;
  systemPrompt: string;
  userInput: string;
  evolutionLog: EvolutionLog;
  timeoutS: number;
  addContainerDirs: string[];
  cwdContainer: string;
}

export async function runReviewerStage(input: ReviewerStageInput): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "reviewer",
    stage: "reviewer",
    mdFilename: "reviewer.md",
    systemPrompt: input.systemPrompt,
    userInput: input.userInput,
    addContainerDirs: input.addContainerDirs,
    cwdContainer: input.cwdContainer,
    timeoutS: input.timeoutS,
    evolutionLog: input.evolutionLog,
  });
}
