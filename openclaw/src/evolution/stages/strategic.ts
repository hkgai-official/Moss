import type { EvolutionLog } from "../evolution-log.js";
// src/evolution/stages/strategic.ts
//
// Stage 8: Strategic Reviewer — judges per-iter outcome based on score
// progression, lever exhaustion, side-effect signal. Verdict ∈ {
// APPROVE_CONVERGED, NEED_MORE_WORK, FUNDAMENTAL_LIMIT_MODEL,
// FUNDAMENTAL_LIMIT_ARCHITECTURE }. Single fresh spawn per iter.
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface StrategicStageInput {
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

export async function runStrategicStage(input: StrategicStageInput): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "strategic_reviewer",
    stage: "strategic",
    mdFilename: "strategic-reviewer.md",
    systemPrompt: input.systemPrompt,
    userInput: input.userInput,
    addContainerDirs: input.addContainerDirs,
    cwdContainer: input.cwdContainer,
    timeoutS: input.timeoutS,
    evolutionLog: input.evolutionLog,
  });
}
