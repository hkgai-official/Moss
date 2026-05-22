import type { EvolutionLog } from "../evolution-log.js";
// src/evolution/stages/code-reviewer.ts
//
// Stage 4 (reviewer side): adversarial review of the implementer's diff +
// commit. Verdict: APPROVE / REJECT_IMPL.
import { runRoleStage, type RunRoleStageResult } from "./stage-helper.js";

export interface CodeReviewerStageInput {
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

export async function runCodeReviewerStage(
  input: CodeReviewerStageInput,
): Promise<RunRoleStageResult> {
  return runRoleStage({
    iter: input.iter,
    iterDir: input.iterDir,
    tracesDir: input.tracesDir,
    role: "code_reviewer",
    stage: "code-loop",
    mdFilename: input.round === 0 ? "code-reviewer.md" : `code-reviewer_round_${input.round}.md`,
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
