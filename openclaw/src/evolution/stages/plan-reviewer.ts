import type { EvolutionLog } from "../evolution-log.js";
// src/evolution/stages/plan-reviewer.ts
//
// Stage 2 (reviewer side): adversarial review of the plan. Each round is
// FRESH per spec — no --resume on plan reviewer (the v2.4 doc allows resume
// but v0 spec sets reviewer as fresh-each-round; we follow the call site,
// which can pass either).
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface PlanReviewerStageInput {
  iter: number;
  iterDir: string;
  tracesDir: string;
  round: number;
  systemPrompt: string;
  userInput: string;
  resumeSessionId: string | null;
  evolutionLog: EvolutionLog;
  timeoutS: number;
  addContainerDirs: string[];
  cwdContainer: string;
}

export async function runPlanReviewerStage(
  input: PlanReviewerStageInput,
): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "plan_reviewer",
    stage: "plan-loop",
    mdFilename: input.round === 0 ? "plan-reviewer.md" : `plan-reviewer_round_${input.round}.md`,
    systemPrompt: input.systemPrompt,
    userInput: input.userInput,
    addContainerDirs: input.addContainerDirs,
    cwdContainer: input.cwdContainer,
    timeoutS: input.timeoutS,
    resumeSessionId: input.resumeSessionId,
    evolutionLog: input.evolutionLog,
    round: input.round,
  });
}
