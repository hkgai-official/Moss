// src/evolution/stages/plan-loop.ts
//
// Stage 2 wrapper: alternates Planner + Plan Reviewer up to MAX_PLAN_ROUNDS+1
// attempts. APPROVE → exit; REJECT → retry. P>0 uses --resume on both.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvolutionLog } from "../evolution-log.js";
import { bailIfStopRequested } from "../loop.js";
import { runRoundLoop, type RoundLoopResult } from "../round-loop.js";
import { runPlanReviewerStage } from "./plan-reviewer.js";
import { runPlannerStage } from "./planner.js";

export interface PlanLoopInput {
  iter: number;
  iterDir: string;
  tracesDir: string;
  /** maxRounds — total attempts allowed (e.g. MAX_PLAN_ROUNDS+1 = 3). */
  maxRounds: number;
  evolutionLog: EvolutionLog;
  /** System prompt + user input templates for Planner. user input is
   *  round-aware: round 0 should briefly task the Planner; round > 0 must
   *  explicitly tell Planner that the prior plan was REJECTED and they
   *  must rewrite (not re-state). See bug_plan_loop_resume_v25.md. */
  plannerSystemPrompt: string;
  plannerUserInput: (round: number) => string;
  plannerTimeoutS: number;
  /** Same for Plan Reviewer — round-aware. */
  planReviewerSystemPrompt: string;
  planReviewerUserInput: (round: number) => string;
  planReviewerTimeoutS: number;
  addContainerDirs: string[];
  cwdContainer: string;
  /** v2.6 polish: state dir + active inputSetId so the round-loop can check
   *  the user-Stop sentinel between sub-stages. Without these the loop would
   *  spawn plan-reviewer immediately after planner is pkilled. */
  stateDir: string;
  inputSetId: string;
}

export interface PlanLoopResult extends RoundLoopResult {
  /** Final approved plan.md path (canonical), or null on abort. */
  planMdPath: string | null;
  planReviewerMdPath: string | null;
  plannerSessionId: string;
  planReviewerSessionId: string;
}

export async function runPlanLoop(input: PlanLoopInput): Promise<PlanLoopResult> {
  const result = await runRoundLoop({
    maxRounds: input.maxRounds,
    iterDir: input.iterDir,
    loopName: "plan",
    iter: input.iter,
    evolutionLog: input.evolutionLog,
    bailIfStopRequested: () =>
      bailIfStopRequested(
        input.stateDir,
        input.inputSetId,
        input.iter,
        "plan-loop",
        input.evolutionLog,
      ),
    runWorker: async (round, prevSessionId) => {
      const r = await runPlannerStage({
        iter: input.iter,
        iterDir: input.iterDir,
        tracesDir: input.tracesDir,
        round,
        resumeSessionId: prevSessionId,
        systemPrompt: input.plannerSystemPrompt,
        userInput: input.plannerUserInput(round),
        timeoutS: input.plannerTimeoutS,
        evolutionLog: input.evolutionLog,
        addContainerDirs: input.addContainerDirs,
        cwdContainer: input.cwdContainer,
      });
      return { mdPath: r.mdPath, sessionId: r.sessionId };
    },
    runReviewer: async (round, _workerMdPath, prevSessionId) => {
      const r = await runPlanReviewerStage({
        iter: input.iter,
        iterDir: input.iterDir,
        tracesDir: input.tracesDir,
        round,
        resumeSessionId: prevSessionId,
        systemPrompt: input.planReviewerSystemPrompt,
        userInput: input.planReviewerUserInput(round),
        timeoutS: input.planReviewerTimeoutS,
        evolutionLog: input.evolutionLog,
        addContainerDirs: input.addContainerDirs,
        cwdContainer: input.cwdContainer,
      });
      return { mdPath: r.mdPath, sessionId: r.sessionId };
    },
  });

  // On APPROVE, promote the round's plan.md / plan-reviewer.md to the
  // canonical iter-level paths if they aren't already there. Round 0 already
  // writes there directly; round >0 writes to plan_round_R.md, so promote.
  let planMdPath: string | null = result.finalWorkerMdPath;
  let planReviewerMdPath: string | null = result.finalReviewerMdPath;
  if (planMdPath && path.basename(planMdPath) !== "plan.md") {
    const canonical = path.join(input.iterDir, "plan.md");
    fs.copyFileSync(planMdPath, canonical);
    planMdPath = canonical;
  }
  if (planReviewerMdPath && path.basename(planReviewerMdPath) !== "plan-reviewer.md") {
    const canonical = path.join(input.iterDir, "plan-reviewer.md");
    fs.copyFileSync(planReviewerMdPath, canonical);
    planReviewerMdPath = canonical;
  }

  return {
    ...result,
    planMdPath,
    planReviewerMdPath,
    plannerSessionId: result.workerSessionId,
    planReviewerSessionId: result.reviewerSessionId,
  };
}
