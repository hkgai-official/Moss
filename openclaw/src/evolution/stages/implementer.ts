import type { EvolutionLog } from "../evolution-log.js";
// src/evolution/stages/implementer.ts
//
// Stage 4 (worker side): Implementer commits code per the approved plan.
// After session ends the orchestrator runs `git -C <openclaw> commit -m
// "evolved iter N"` from inside loop.ts (this stage just spawns the role).
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface ImplementerStageInput {
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

export async function runImplementerStage(
  input: ImplementerStageInput,
): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "implementer",
    stage: "code-loop",
    mdFilename: input.round === 0 ? "implementer.md" : `implementer_round_${input.round}.md`,
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
