// src/evolution/verdict.ts
//
// Per-iteration verdict + streak tracking. TS port of v2_2/lib/verdict.py
// + the verdict-parsing helpers from v2_4/orchestrator.py.

import * as fs from "node:fs";
import type { Streaks } from "./state.js";

/** Closed verdict enum. Matches v2_2 Verdict + Strategic Reviewer mapping. */
export const Verdict = {
  CONVERGED: "converged",
  NEED_MORE_WORK: "need_more_work",
  FUNDAMENTAL_LIMIT_MODEL: "fundamental_limit_model",
  FUNDAMENTAL_LIMIT_ARCHITECTURE: "fundamental_limit_arch",

  // System failures (short-circuit before strategic review)
  BUILD_FAILED: "build_failed",
  BUILD_SMOKE_FAILED: "build_smoke_failed",
  IMPLEMENTER_FAILED: "implementer_failed",

  // Session failures
  ARCHITECT_OUTPUT_MALFORMED: "architect_output_malformed",
  ARCHITECT_VIOLATED_READONLY: "architect_violated_readonly",
  REVIEWER_REJECTED_MAX_ROUNDS: "reviewer_rejected_max_rounds",
  REVIEWER_VIOLATED_READONLY: "reviewer_violated_readonly",

  // Plan-loop / code-loop exhaustion
  PLAN_REJECTED_MAX_ROUNDS: "plan_rejected_max_rounds",
  CODE_REJECTED_MAX_ROUNDS: "code_rejected_max_rounds",
  IMPLEMENTER_BLOCKED: "implementer_blocked",

  // Defensive fallback
  PARTIAL_PROGRESS: "partial_progress",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export const VERDICT_VALUES: readonly Verdict[] = Object.values(Verdict);

export interface TrialResult {
  task: string;
  trial: number;
  score: number;
  baselineScore: number;
  judgePassed: boolean;
}

export interface ImplementerOutcome {
  commitHash: string | null;
  buildOk: boolean;
  testsOk: boolean;
  filesChanged?: number;
  buildSmokeOk?: boolean;
}

export interface StrategicReviewOutcome {
  verdict: string; // raw string, gets mapped via _STRATEGIC_VERDICT_MAP
  feedbackMd?: string;
}

const STRATEGIC_VERDICT_MAP: Record<string, Verdict> = {
  APPROVE_CONVERGED: Verdict.CONVERGED,
  NEED_MORE_WORK: Verdict.NEED_MORE_WORK,
  FUNDAMENTAL_LIMIT_MODEL: Verdict.FUNDAMENTAL_LIMIT_MODEL,
  FUNDAMENTAL_LIMIT_ARCHITECTURE: Verdict.FUNDAMENTAL_LIMIT_ARCHITECTURE,
};

export function mapStrategicVerdict(verdictStr: string): Verdict {
  const cleaned = (verdictStr || "").trim().toUpperCase();
  return STRATEGIC_VERDICT_MAP[cleaned] ?? Verdict.PARTIAL_PROGRESS;
}

export function tagVerdict(args: {
  stageATrials: TrialResult[];
  implementer: ImplementerOutcome;
  strategicReview: StrategicReviewOutcome | null;
}): Verdict {
  const { implementer, stageATrials, strategicReview } = args;

  // System-level short-circuits (preserve v2.3 ordering)
  if (implementer.commitHash == null || !implementer.testsOk) {
    return Verdict.IMPLEMENTER_FAILED;
  }
  if (!implementer.buildOk) {
    return Verdict.BUILD_FAILED;
  }
  if (implementer.buildSmokeOk === false) {
    return Verdict.BUILD_SMOKE_FAILED;
  }

  // v2.6: prefer Reviewer's verdict when present, since Reviewer reads
  // task_evaluations + keypoint matrix and may converge a batch even when
  // grade_summary trial results are empty (user mode has no grade_summary
  // by design — task-evaluator carries the signal).
  if (strategicReview != null && strategicReview.verdict) {
    return mapStrategicVerdict(strategicReview.verdict);
  }

  // No reviewer verdict: fall back to v2.5 trial-presence short-circuits.
  if (stageATrials.length === 0) {
    return Verdict.IMPLEMENTER_FAILED;
  }

  return Verdict.PARTIAL_PROGRESS;
}

// ---------------------------------------------------------------------------
// Verdict parsing helpers (port of v2_4/orchestrator.py::parse_*_verdict)
// ---------------------------------------------------------------------------

/** Extract text under a `## Verdict` heading until the next `## ` or EOF. */
function sectionText(md: string, heading: string): string {
  const lines = md.split("\n");
  let inSection = false;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (inSection) {
      if (line.startsWith("## ")) {
        break;
      }
      out.push(line);
    } else if (line.trim() === heading) {
      inSection = true;
    }
  }
  return out.join("\n");
}

export type PlanReviewerVerdict = "APPROVE" | "REJECT_ARCHITECTURAL" | "REJECT_COMPLETENESS" | null;

export function parsePlanReviewerVerdict(md: string): PlanReviewerVerdict {
  const section = sectionText(md, "## Verdict");
  if (!section) {
    return null;
  }
  for (const raw of section.split("\n")) {
    const ln = raw.trim();
    if (!ln) {
      continue;
    }
    const up = ln.toUpperCase();
    // most specific first to avoid REJECT swallowing REJECT_ARCHITECTURAL
    for (const cand of ["REJECT_ARCHITECTURAL", "REJECT_COMPLETENESS", "APPROVE"] as const) {
      if (up.includes(cand)) {
        return cand;
      }
    }
    if (up.includes("REJECT")) {
      return "REJECT_ARCHITECTURAL";
    }
    return null;
  }
  return null;
}

export type CodeReviewerVerdict = "APPROVE" | "REJECT_IMPL" | null;

export function parseCodeReviewerVerdict(md: string): CodeReviewerVerdict {
  const section = sectionText(md, "## Verdict");
  if (!section) {
    return null;
  }
  for (const raw of section.split("\n")) {
    const ln = raw.trim();
    if (!ln) {
      continue;
    }
    const up = ln.toUpperCase();
    if (up.includes("REJECT_IMPL")) {
      return "REJECT_IMPL";
    }
    if (up.includes("APPROVE")) {
      return "APPROVE";
    }
    if (up.includes("REJECT")) {
      return "REJECT_IMPL";
    }
    return null;
  }
  return null;
}

function parseVerdictFromSection(text: string, candidates: readonly string[]): string {
  const lines = text.split("\n");
  let inSection = false;
  for (const raw of lines) {
    const stripped = raw.trim();
    if (inSection) {
      if (!stripped) continue;
      if (stripped.startsWith("## ")) return "";
      const up = stripped.toUpperCase();
      for (const cand of candidates) {
        if (up.includes(cand)) return cand;
      }
      return "";
    }
    if (stripped === "## Verdict") {
      inSection = true;
    }
  }
  return "";
}

function loadVerdictText(mdOrPath: string): string {
  if (mdOrPath.startsWith("/") || mdOrPath.startsWith(".")) {
    if (!fs.existsSync(mdOrPath)) return "";
    return fs.readFileSync(mdOrPath, "utf8");
  }
  return mdOrPath;
}

export function parseStrategicVerdict(mdOrPath: string): string {
  const text = loadVerdictText(mdOrPath);
  if (!text) return "";
  return parseVerdictFromSection(text, [
    "APPROVE_CONVERGED",
    "NEED_MORE_WORK",
    "FUNDAMENTAL_LIMIT_MODEL",
    "FUNDAMENTAL_LIMIT_ARCHITECTURE",
  ]);
}

/** v2.6 Reviewer verdict — 4-verdict closed set. Note the convergence verdict
 *  is bare CONVERGED here (v2.5 was APPROVE_CONVERGED); orchestrator translates. */
export function parseReviewerVerdict(mdOrPath: string): string {
  const text = loadVerdictText(mdOrPath);
  if (!text) return "";
  return parseVerdictFromSection(text, [
    "CONVERGED",
    "NEED_MORE_WORK",
    "FUNDAMENTAL_LIMIT_MODEL",
    "FUNDAMENTAL_LIMIT_ARCHITECTURE",
  ]);
}

// ---------------------------------------------------------------------------
// Streak tracking (drives `decideContinue`)
// ---------------------------------------------------------------------------

export function updateStreaksFromIteration(
  prev: Streaks,
  args: {
    verdict: Verdict;
    iterScore: number;
    bestScoreSoFar: number;
    sessionCrashedThisIter: boolean;
  },
): Streaks {
  const next: Streaks = { ...prev };
  if (args.sessionCrashedThisIter) {
    next.consecutiveSessionCrashes += 1;
  } else {
    next.consecutiveSessionCrashes = 0;
  }

  if (args.verdict === Verdict.BUILD_FAILED || args.verdict === Verdict.BUILD_SMOKE_FAILED) {
    next.consecutiveBuildFailures += 1;
  } else {
    next.consecutiveBuildFailures = 0;
  }

  const madeProgress = args.iterScore > args.bestScoreSoFar + 1e-9;
  if (madeProgress) {
    next.noProgress = 0;
    if (args.verdict === Verdict.NEED_MORE_WORK) {
      next.progressNoApprove += 1;
    } else if (args.verdict === Verdict.CONVERGED) {
      next.progressNoApprove = 0;
    }
  } else {
    next.noProgress += 1;
  }
  return next;
}

export interface ContinueDecision {
  continue: boolean;
  reason: string;
  status?: "converged" | "aborted_max_iter" | "aborted_streak";
}

/** Decide if outer loop should continue to next iter. */
export function decideContinue(args: {
  iter: number;
  maxIter: number;
  verdict: Verdict;
  streaks: Streaks;
  noProgressStreakLimit: number;
  progressNoApproveStreakLimit: number;
  buildFailuresAbort: number;
  sessionCrashesAbort: number;
}): ContinueDecision {
  if (args.verdict === Verdict.CONVERGED) {
    return { continue: false, reason: "converged", status: "converged" };
  }
  if (
    args.verdict === Verdict.FUNDAMENTAL_LIMIT_MODEL ||
    args.verdict === Verdict.FUNDAMENTAL_LIMIT_ARCHITECTURE
  ) {
    return { continue: false, reason: args.verdict, status: "aborted_streak" };
  }
  if (args.iter >= args.maxIter) {
    return { continue: false, reason: "max_iter_reached", status: "aborted_max_iter" };
  }
  if (args.streaks.noProgress >= args.noProgressStreakLimit) {
    return { continue: false, reason: "no_progress_streak", status: "aborted_streak" };
  }
  if (args.streaks.progressNoApprove >= args.progressNoApproveStreakLimit) {
    return { continue: false, reason: "progress_no_approve_streak", status: "aborted_streak" };
  }
  if (args.streaks.consecutiveBuildFailures >= args.buildFailuresAbort) {
    return { continue: false, reason: "build_failures_streak", status: "aborted_streak" };
  }
  if (args.streaks.consecutiveSessionCrashes >= args.sessionCrashesAbort) {
    return { continue: false, reason: "session_crashes_streak", status: "aborted_streak" };
  }
  return { continue: true, reason: "ok" };
}
