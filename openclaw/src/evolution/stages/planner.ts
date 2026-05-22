import type { EvolutionLog } from "../evolution-log.js";
// src/evolution/stages/planner.ts
//
// Stage 2 (worker side): Planner produces a structural fix proposal. Called
// from plan-loop with a round index. Round 0 fresh; round > 0 uses --resume
// against the previous Planner session.
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface PlannerStageInput {
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

export async function runPlannerStage(input: PlannerStageInput): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "planner",
    stage: "plan-loop",
    mdFilename: input.round === 0 ? "plan.md" : `plan_round_${input.round}.md`,
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
