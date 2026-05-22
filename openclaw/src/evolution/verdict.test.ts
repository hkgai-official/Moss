// src/evolution/verdict.test.ts
import { describe, expect, it } from "vitest";
import {
  decideContinue,
  parseCodeReviewerVerdict,
  parsePlanReviewerVerdict,
  parseStrategicVerdict,
  tagVerdict,
  updateStreaksFromIteration,
  Verdict,
} from "./verdict.js";

describe("verdict — tagVerdict", () => {
  const baseImpl = { commitHash: "abc", buildOk: true, testsOk: true, buildSmokeOk: true };

  it("returns IMPLEMENTER_FAILED if commit_hash is null", () => {
    expect(
      tagVerdict({
        stageATrials: [{ task: "t", trial: 0, score: 0.5, baselineScore: 0.3, judgePassed: true }],
        implementer: { ...baseImpl, commitHash: null },
        strategicReview: null,
      }),
    ).toBe(Verdict.IMPLEMENTER_FAILED);
  });

  it("returns BUILD_FAILED when buildOk=false", () => {
    expect(
      tagVerdict({
        stageATrials: [{ task: "t", trial: 0, score: 0.5, baselineScore: 0.3, judgePassed: true }],
        implementer: { ...baseImpl, buildOk: false },
        strategicReview: null,
      }),
    ).toBe(Verdict.BUILD_FAILED);
  });

  it("maps APPROVE_CONVERGED → CONVERGED", () => {
    expect(
      tagVerdict({
        stageATrials: [{ task: "t", trial: 0, score: 0.6, baselineScore: 0.3, judgePassed: true }],
        implementer: baseImpl,
        strategicReview: { verdict: "APPROVE_CONVERGED" },
      }),
    ).toBe(Verdict.CONVERGED);
  });

  it("maps NEED_MORE_WORK", () => {
    expect(
      tagVerdict({
        stageATrials: [{ task: "t", trial: 0, score: 0.6, baselineScore: 0.3, judgePassed: true }],
        implementer: baseImpl,
        strategicReview: { verdict: "NEED_MORE_WORK" },
      }),
    ).toBe(Verdict.NEED_MORE_WORK);
  });

  it("positive twin of IMPLEMENTER_FAILED: non-null commit + real trials + NEED_MORE_WORK → NEED_MORE_WORK", () => {
    // Regression: 2026-05-11 bug labeled real iters implementer_failed
    // because the commitHash capture path was broken upstream. With a
    // non-null commitHash (40-hex) and the same downstream signals,
    // tagVerdict must defer to strategic.
    const trainResults = Array.from({ length: 12 }).map((_, i) => ({
      task: `T${i % 4}`,
      trial: (i % 3) + 1,
      score: 0.5 + (i % 5) * 0.05,
      baselineScore: 0.22,
      judgePassed: i % 3 === 0,
    }));
    expect(
      tagVerdict({
        stageATrials: trainResults,
        implementer: { ...baseImpl, commitHash: "4f0d83e371d5577cedf973af8aeec7aec7e40e09" },
        strategicReview: { verdict: "NEED_MORE_WORK" },
      }),
    ).toBe(Verdict.NEED_MORE_WORK);
  });

  it("falls back to PARTIAL_PROGRESS on unknown strategic verdict", () => {
    expect(
      tagVerdict({
        stageATrials: [{ task: "t", trial: 0, score: 0.6, baselineScore: 0.3, judgePassed: true }],
        implementer: baseImpl,
        strategicReview: { verdict: "WHO_KNOWS" },
      }),
    ).toBe(Verdict.PARTIAL_PROGRESS);
  });
});

describe("verdict — markdown verdict parsers", () => {
  it("plan reviewer: APPROVE", () => {
    const md = "## Verdict\n\nAPPROVE\n\n## Other";
    expect(parsePlanReviewerVerdict(md)).toBe("APPROVE");
  });
  it("plan reviewer: REJECT_ARCHITECTURAL", () => {
    expect(parsePlanReviewerVerdict("## Verdict\nREJECT_ARCHITECTURAL\n")).toBe(
      "REJECT_ARCHITECTURAL",
    );
  });
  it("plan reviewer: bare REJECT becomes REJECT_ARCHITECTURAL", () => {
    expect(parsePlanReviewerVerdict("## Verdict\nREJECT\n")).toBe("REJECT_ARCHITECTURAL");
  });
  it("plan reviewer: REJECT_COMPLETENESS", () => {
    expect(parsePlanReviewerVerdict("## Verdict\nREJECT_COMPLETENESS\n")).toBe(
      "REJECT_COMPLETENESS",
    );
  });
  it("plan reviewer: missing section returns null", () => {
    expect(parsePlanReviewerVerdict("no verdict here")).toBeNull();
  });

  it("code reviewer: APPROVE", () => {
    expect(parseCodeReviewerVerdict("## Verdict\nAPPROVE\n")).toBe("APPROVE");
  });
  it("code reviewer: REJECT_IMPL", () => {
    expect(parseCodeReviewerVerdict("## Verdict\nREJECT_IMPL\n")).toBe("REJECT_IMPL");
  });
  it("code reviewer: bare REJECT becomes REJECT_IMPL", () => {
    expect(parseCodeReviewerVerdict("## Verdict\nREJECT\n")).toBe("REJECT_IMPL");
  });

  it("strategic: extracts APPROVE_CONVERGED", () => {
    const md = "## Verdict\n\nAPPROVE_CONVERGED\n\n## Notes";
    expect(parseStrategicVerdict(md)).toBe("APPROVE_CONVERGED");
  });
  it("strategic: extracts NEED_MORE_WORK with surrounding text", () => {
    const md = "## Verdict\nVerdict: NEED_MORE_WORK\n";
    expect(parseStrategicVerdict(md)).toBe("NEED_MORE_WORK");
  });
  it("strategic: returns empty on missing section", () => {
    expect(parseStrategicVerdict("no section")).toBe("");
  });
});

describe("verdict — streaks + decideContinue", () => {
  const baseStreaks = {
    consecutiveBuildFailures: 0,
    consecutiveSessionCrashes: 0,
    noProgress: 0,
    progressNoApprove: 0,
  };

  it("updates noProgress when iter score does not exceed best", () => {
    const next = updateStreaksFromIteration(baseStreaks, {
      verdict: Verdict.NEED_MORE_WORK,
      iterScore: 0.4,
      bestScoreSoFar: 0.5,
      sessionCrashedThisIter: false,
    });
    expect(next.noProgress).toBe(1);
    expect(next.progressNoApprove).toBe(0);
  });

  it("updates progressNoApprove when made progress but verdict=NEED_MORE_WORK", () => {
    const next = updateStreaksFromIteration(baseStreaks, {
      verdict: Verdict.NEED_MORE_WORK,
      iterScore: 0.6,
      bestScoreSoFar: 0.5,
      sessionCrashedThisIter: false,
    });
    expect(next.noProgress).toBe(0);
    expect(next.progressNoApprove).toBe(1);
  });

  it("decideContinue: CONVERGED stops with reason converged", () => {
    const d = decideContinue({
      iter: 1,
      maxIter: 3,
      verdict: Verdict.CONVERGED,
      streaks: baseStreaks,
      noProgressStreakLimit: 3,
      progressNoApproveStreakLimit: 4,
      buildFailuresAbort: 3,
      sessionCrashesAbort: 3,
    });
    expect(d.continue).toBe(false);
    expect(d.status).toBe("converged");
  });

  it("decideContinue: max_iter abort", () => {
    const d = decideContinue({
      iter: 3,
      maxIter: 3,
      verdict: Verdict.NEED_MORE_WORK,
      streaks: baseStreaks,
      noProgressStreakLimit: 3,
      progressNoApproveStreakLimit: 4,
      buildFailuresAbort: 3,
      sessionCrashesAbort: 3,
    });
    expect(d.continue).toBe(false);
    expect(d.status).toBe("aborted_max_iter");
  });

  it("decideContinue: no_progress streak abort", () => {
    const d = decideContinue({
      iter: 2,
      maxIter: 8,
      verdict: Verdict.NEED_MORE_WORK,
      streaks: { ...baseStreaks, noProgress: 3 },
      noProgressStreakLimit: 3,
      progressNoApproveStreakLimit: 4,
      buildFailuresAbort: 3,
      sessionCrashesAbort: 3,
    });
    expect(d.continue).toBe(false);
    expect(d.status).toBe("aborted_streak");
  });

  it("decideContinue: continues on NEED_MORE_WORK below limits", () => {
    const d = decideContinue({
      iter: 1,
      maxIter: 3,
      verdict: Verdict.NEED_MORE_WORK,
      streaks: baseStreaks,
      noProgressStreakLimit: 3,
      progressNoApproveStreakLimit: 4,
      buildFailuresAbort: 3,
      sessionCrashesAbort: 3,
    });
    expect(d.continue).toBe(true);
  });
});
