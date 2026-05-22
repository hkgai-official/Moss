import type { EvolutionLog } from "../evolution-log.js";
// src/evolution/stages/locator.ts
//
// Stage 1: Locator — diagnoses architectural failure modes from prior trial
// transcripts and clusters them. Single spawn, fresh session, output is
// `iteration_<N>/diagnosis.md`.
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface LocatorStageInput {
  iter: number;
  iterDir: string;
  tracesDir: string;
  systemPrompt: string;
  userInput: string;
  evolutionLog: EvolutionLog;
  timeoutS: number;
  /** Container-abs dirs to expose (typically iterDir + /app/src). */
  addContainerDirs: string[];
  cwdContainer: string;
}

export async function runLocatorStage(input: LocatorStageInput): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "locator",
    stage: "locator",
    mdFilename: "diagnosis.md",
    systemPrompt: input.systemPrompt,
    userInput: input.userInput,
    addContainerDirs: input.addContainerDirs,
    cwdContainer: input.cwdContainer,
    timeoutS: input.timeoutS,
    evolutionLog: input.evolutionLog,
  });
}
