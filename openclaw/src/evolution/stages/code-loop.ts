// src/evolution/stages/code-loop.ts
//
// Stage 4 wrapper: alternates Implementer + Code Reviewer up to
// MAX_CODE_ROUNDS+1 attempts. CRITICAL: between rejection of round C and
// retry round C+1, the host daemon must hard-reset openclaw to H_pre to
// revert any in-flight Implementer edits — otherwise round C+1's git diff is
// contaminated by C's failed attempt.
import * as fs from "node:fs";
import * as path from "node:path";
import { hardResetOpenclaw } from "../docker-rpc.js";
import type { EvolutionLog } from "../evolution-log.js";
import { bailIfStopRequested } from "../loop.js";
import { runRoundLoop, type RoundLoopResult } from "../round-loop.js";
import { runCodeReviewerStage } from "./code-reviewer.js";
import { runImplementerStage } from "./implementer.js";

export interface CodeLoopInput {
  iter: number;
  iterDir: string;
  tracesDir: string;
  maxRounds: number;
  evolutionLog: EvolutionLog;
  implementerSystemPrompt: string;
  implementerUserInput: string;
  implementerTimeoutS: number;
  codeReviewerSystemPrompt: string;
  codeReviewerUserInput: string;
  codeReviewerTimeoutS: number;
  addContainerDirs: string[];
  cwdContainer: string;
  /** Commit hash of openclaw HEAD before iter 1 — supervisor / host daemon
   *  resets to this on rejection retry. */
  hPre: string;
  /** v2.6 polish: state dir + active inputSetId so the round-loop can check
   *  the user-Stop sentinel between sub-stages. Without these the loop would
   *  spawn code-reviewer immediately after implementer is pkilled. */
  stateDir: string;
  inputSetId: string;
}

export interface CodeLoopResult extends RoundLoopResult {
  implementerMdPath: string | null;
  codeReviewerMdPath: string | null;
  implementerSessionId: string;
  codeReviewerSessionId: string;
}

export async function runCodeLoop(input: CodeLoopInput): Promise<CodeLoopResult> {
  const result = await runRoundLoop({
    maxRounds: input.maxRounds,
    iterDir: input.iterDir,
    loopName: "code",
    iter: input.iter,
    evolutionLog: input.evolutionLog,
    bailIfStopRequested: () =>
      bailIfStopRequested(
        input.stateDir,
        input.inputSetId,
        input.iter,
        "code-loop",
        input.evolutionLog,
      ),
    beforeRetry: async (round) => {
      input.evolutionLog.append({
        iter: input.iter,
        round,
        stage: "code-loop",
        event: "stage_start",
        data: { hard_reset_to: input.hPre },
      });
      const r = await hardResetOpenclaw({ hPre: input.hPre });
      if (!r.ok) {
        throw new Error(`hard-reset openclaw to ${input.hPre} failed`);
      }
    },
    runWorker: async (round, prevSessionId) => {
      const r = await runImplementerStage({
        iter: input.iter,
        iterDir: input.iterDir,
        tracesDir: input.tracesDir,
        round,
        resumeSessionId: prevSessionId,
        systemPrompt: input.implementerSystemPrompt,
        userInput: input.implementerUserInput,
        timeoutS: input.implementerTimeoutS,
        evolutionLog: input.evolutionLog,
        addContainerDirs: input.addContainerDirs,
        cwdContainer: input.cwdContainer,
      });
      return { mdPath: r.mdPath, sessionId: r.sessionId };
    },
    runReviewer: async (round, _workerMd, prevSessionId) => {
      const r = await runCodeReviewerStage({
        iter: input.iter,
        iterDir: input.iterDir,
        tracesDir: input.tracesDir,
        round,
        resumeSessionId: prevSessionId,
        systemPrompt: input.codeReviewerSystemPrompt,
        userInput: input.codeReviewerUserInput,
        timeoutS: input.codeReviewerTimeoutS,
        evolutionLog: input.evolutionLog,
        addContainerDirs: input.addContainerDirs,
        cwdContainer: input.cwdContainer,
      });
      return { mdPath: r.mdPath, sessionId: r.sessionId };
    },
  });

  // Promote final round's md to canonical iter-level path
  let implementerMdPath = result.finalWorkerMdPath;
  let codeReviewerMdPath = result.finalReviewerMdPath;
  if (implementerMdPath && path.basename(implementerMdPath) !== "implementer.md") {
    const canonical = path.join(input.iterDir, "implementer.md");
    fs.copyFileSync(implementerMdPath, canonical);
    implementerMdPath = canonical;
  }
  if (codeReviewerMdPath && path.basename(codeReviewerMdPath) !== "code-reviewer.md") {
    const canonical = path.join(input.iterDir, "code-reviewer.md");
    fs.copyFileSync(codeReviewerMdPath, canonical);
    codeReviewerMdPath = canonical;
  }

  return {
    ...result,
    implementerMdPath,
    codeReviewerMdPath,
    implementerSessionId: result.workerSessionId,
    codeReviewerSessionId: result.reviewerSessionId,
  };
}
