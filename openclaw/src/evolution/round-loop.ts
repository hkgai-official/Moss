// src/evolution/round-loop.ts
//
// Reusable round-loop driver for plan-loop (Stage 2) and code-loop (Stage 4).
// Each round = (Worker spawn → Reviewer spawn → archive). Reviewer's verdict
// drives whether to break (APPROVE) or retry (REJECT/REVISE) up to maxRounds.
//
// Critical:
//   - rounds 1..maxRounds use --resume on the worker + reviewer (continuity)
//   - code-loop calls beforeRetry() between rounds → host daemon hard-resets
//     openclaw to H_pre so round C+1 starts from a clean tree
//   - artifacts of every round (worker.md + reviewer.md) are copied into
//     `revisions/<loopName>_round_<R>/` so post-mortem can replay rejections.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvolutionLog } from "./evolution-log.js";

export type ReviewerVerdict = "APPROVE" | "REJECT" | "REVISE" | "AMBIGUOUS";

/** Spec-compatible verdict scan. Looks for `## Verdict` section first; falls
 *  back to anchored APPROVE/REJECT/REVISE tokens in the last 2KB of the md. */
export function parseReviewerVerdict(reviewerMd: string): ReviewerVerdict {
  // Prefer explicit `## Verdict` section
  const sectionMatch = reviewerMd.match(/##\s*Verdict[^\n]*\n([\s\S]*?)(?:\n##\s|\n*$)/);
  const candidates = sectionMatch ? [sectionMatch[1]] : [];
  // Fall back to last 2KB
  candidates.push(reviewerMd.slice(-2000));

  for (const c of candidates) {
    const up = c.toUpperCase();
    // Most specific first
    if (/\bAPPROVE\b/.test(up) && !/REJECT|REVISE/.test(up)) {
      return "APPROVE";
    }
    if (/REJECT_IMPL|REJECT_ARCHITECTURAL|REJECT_COMPLETENESS|\bREJECT\b/.test(up)) {
      return "REJECT";
    }
    if (/\bREVISE\b/.test(up)) {
      return "REVISE";
    }
    if (/\bAPPROVE\b/.test(up)) {
      return "APPROVE";
    }
  }
  return "AMBIGUOUS";
}

export interface RoundWorkerOutput {
  mdPath: string;
  sessionId: string;
}

export interface RoundLoopOpts {
  /** P=0..maxRounds-1; e.g. 3 → max 3 attempts (rounds 0,1,2). */
  maxRounds: number;
  iterDir: string;
  loopName: "plan" | "code";
  iter: number;
  evolutionLog: EvolutionLog;
  runWorker: (round: number, prevSessionId: string | null) => Promise<RoundWorkerOutput>;
  runReviewer: (
    round: number,
    workerMdPath: string,
    prevSessionId: string | null,
  ) => Promise<RoundWorkerOutput>;
  /** Called between rounds before runWorker (round > 0). Code-loop uses this
   *  to invoke `hardResetOpenclaw` so retry starts clean. */
  beforeRetry?: (round: number) => Promise<void>;
  /** v2.6 polish: cooperative cancellation. Called at every sub-stage boundary
   *  inside the round-loop (top of round, between worker→reviewer). Caller
   *  injects a closure that throws `EvolutionStopRequested` when the user has
   *  POSTed /api/evolution/stop. Without this, pkill of the current claude
   *  just makes the round-loop think the role finished and spawn the next
   *  one — Stop wouldn't actually stop. */
  bailIfStopRequested?: () => void;
}

export interface RoundLoopResult {
  finalWorkerMdPath: string | null;
  finalReviewerMdPath: string | null;
  workerSessionId: string;
  reviewerSessionId: string;
  /** 1..maxRounds (or maxRounds = aborted after exhausting attempts). */
  rounds: number;
  verdict: ReviewerVerdict | "ABORTED";
}

export async function runRoundLoop(opts: RoundLoopOpts): Promise<RoundLoopResult> {
  let prevWorkerSession: string | null = null;
  let prevReviewerSession: string | null = null;

  for (let round = 0; round < opts.maxRounds; round++) {
    // Sentinel 1: top of round. Catches Stop before we burn tokens spawning
    // the worker for round 0 or before beforeRetry's hard-reset for round >0.
    opts.bailIfStopRequested?.();

    if (round > 0 && opts.beforeRetry) {
      await opts.beforeRetry(round);
    }

    opts.evolutionLog.append({
      iter: opts.iter,
      round,
      stage: `${opts.loopName}-loop`,
      event: "stage_start",
      data: { worker_resume: prevWorkerSession, reviewer_resume: prevReviewerSession },
    });

    const worker = await opts.runWorker(round, prevWorkerSession);

    // Sentinel 2: between worker and reviewer. Catches Stop after pkill of
    // the worker — without this, the loop would proceed to spawn the reviewer
    // immediately and the kill was wasted token-saving.
    opts.bailIfStopRequested?.();

    const reviewer = await opts.runReviewer(round, worker.mdPath, prevReviewerSession);

    const reviewerMd = fs.existsSync(reviewer.mdPath)
      ? fs.readFileSync(reviewer.mdPath, "utf8")
      : "";
    const verdict = parseReviewerVerdict(reviewerMd);

    opts.evolutionLog.append({
      iter: opts.iter,
      round,
      stage: `${opts.loopName}-loop`,
      event: "verdict",
      data: { verdict },
    });

    archiveRound(opts.iterDir, opts.loopName, round, worker.mdPath, reviewer.mdPath);

    if (verdict === "APPROVE") {
      return {
        finalWorkerMdPath: worker.mdPath,
        finalReviewerMdPath: reviewer.mdPath,
        workerSessionId: worker.sessionId,
        reviewerSessionId: reviewer.sessionId,
        rounds: round + 1,
        verdict,
      };
    }

    prevWorkerSession = worker.sessionId;
    prevReviewerSession = reviewer.sessionId;
  }

  return {
    finalWorkerMdPath: null,
    finalReviewerMdPath: null,
    workerSessionId: "",
    reviewerSessionId: "",
    rounds: opts.maxRounds,
    verdict: "ABORTED",
  };
}

function archiveRound(
  iterDir: string,
  loopName: "plan" | "code",
  round: number,
  workerMd: string,
  reviewerMd: string,
): void {
  const archDir = path.join(iterDir, "revisions", `${loopName}_round_${round}`);
  fs.mkdirSync(archDir, { recursive: true });
  for (const src of [workerMd, reviewerMd]) {
    if (fs.existsSync(src)) {
      const dst = path.join(archDir, path.basename(src));
      try {
        fs.copyFileSync(src, dst);
      } catch {
        // best effort: ignore archive failures, evolution-log already records the round
      }
    }
  }
}
