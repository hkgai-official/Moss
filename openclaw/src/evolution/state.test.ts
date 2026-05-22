// src/evolution/state.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createManifest,
  DEFAULT_PARAMS_BY_DEPTH,
  loadManifest,
  saveManifest,
  type EvolutionDepth,
  type Manifest,
} from "./state.js";

function buildManifest(): Manifest {
  return createManifest({
    triggerId: "test-1",
    triggerSource: "manual",
    triggeredBy: "tester",
    inputSetId: "batch_03",
    inputManifestPath: "x.yaml",
    startingImage: "moss:base",
    startingCommit: null,
    startingBranch: "master",
    evolutionBranch: "evo/test-1",
    validationSet: "v1.yaml",
    params: { max_iter: 3 },
  });
}

describe("state — saveManifest / loadManifest", () => {
  it("saves and loads minimal manifest atomically", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "ev-"));
    const p = path.join(td, "manifest.json");
    saveManifest(p, buildManifest());
    const m = loadManifest(p);
    expect(m.triggerId).toBe("test-1");
    expect(m.params.max_iter).toBe(3);
    expect(m.streaks.noProgress).toBe(0);
  });

  it("crash mid-write leaves prior state intact", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "ev-"));
    const p = path.join(td, "manifest.json");
    saveManifest(p, buildManifest());
    // simulate crashed concurrent writer leaving a broken .tmp behind
    fs.writeFileSync(p + ".tmp", "broken json {");
    const m = loadManifest(p);
    expect(m.triggerId).toBe("test-1");
  });

  it("createManifest applies default params + merges overrides", () => {
    const m = buildManifest();
    expect(m.params.max_plan_rounds).toBe(2);
    expect(m.params.max_code_retries).toBe(1);
    expect(m.params.max_iter).toBe(3);
    expect(m.status).toBe("initialized");
    expect(m.iterations).toEqual([]);
  });
});

describe("readV5AsV6 backward-compat", () => {
  it("loads a v5 manifest and adapts to v6 shape without mutating disk", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "ev-v5-"));
    const p = path.join(td, "manifest.json");
    const v5Raw = {
      schemaVersion: 5,
      triggerId: "v5-trigger",
      triggerSource: "manual",
      triggeredAt: 1700000000000,
      triggeredBy: "tester",
      inputSetId: "sample_compliance_audit",
      inputManifestPath: "x.yaml",
      startingImage: "moss:base",
      startingCommit: null,
      startingBranch: "master",
      evolutionBranch: "evo/v5",
      params: { max_iter: 4, max_code_rounds: 2 },
      tasks: { stage_a: [], stage_c: [] },
      validationSet: "",
      status: "converged",
      currentIteration: 1,
      currentStage: "finalize",
      iterations: [
        {
          iteration: 1,
          verdict: "CONVERGED",
          commitHash: "abc123",
          imageTag: "moss:v5-iter1",
          trainResults: [],
          validationRun: null,
          diagnosisMdPath: null,
          planMdPath: null,
          planReviewerMdPath: null,
          implementerMdPath: null,
          codeReviewerMdPath: null,
          strategicReviewMdPath: "old/strategic.md",
          strategicVerdict: "CONVERGED",
          elapsedS: 12,
          planRoundCount: 1,
          codeRoundCount: 1,
          sessionIdByRole: null,
        },
      ],
      streaks: {
        consecutiveBuildFailures: 0,
        consecutiveSessionCrashes: 0,
        noProgress: 0,
        progressNoApprove: 0,
      },
      bestScoreSoFar: 0.5,
      swapOutcome: null,
    };
    fs.writeFileSync(p, JSON.stringify(v5Raw));

    const m = loadManifest(p);
    expect(m.schemaVersion).toBe(6);
    expect(m.mode).toBe("user");
    expect(m.evolutionDepth).toBe("standard");
    expect(m.flagBatchId).toBeNull();
    expect(m.params.max_code_retries).toBe(2);
    expect(m.iterations[0].reviewerMdPath).toBe("old/strategic.md");
    expect(m.iterations[0].reviewerVerdict).toBe("CONVERGED");
    expect(m.iterations[0].taskEvaluations).toEqual({});

    // on-disk file remains v5 (read-only adaptation)
    const reread = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(reread.schemaVersion).toBe(5);
    expect(reread.iterations[0].strategicReviewMdPath).toBe("old/strategic.md");
  });
});

describe("DEFAULT_PARAMS_BY_DEPTH", () => {
  it("shallow has max_iter=3, max_plan_rounds=1, max_code_retries=0", () => {
    expect(DEFAULT_PARAMS_BY_DEPTH.shallow.max_iter).toBe(3);
    expect(DEFAULT_PARAMS_BY_DEPTH.shallow.max_plan_rounds).toBe(1);
    expect(DEFAULT_PARAMS_BY_DEPTH.shallow.max_code_retries).toBe(0);
  });
  it("standard is default (matches v2.5 numbers)", () => {
    expect(DEFAULT_PARAMS_BY_DEPTH.standard.max_iter).toBe(5);
    expect(DEFAULT_PARAMS_BY_DEPTH.standard.max_plan_rounds).toBe(2);
    expect(DEFAULT_PARAMS_BY_DEPTH.standard.max_code_retries).toBe(1);
    expect(DEFAULT_PARAMS_BY_DEPTH.standard.n_trials_per_task).toBe(3);
  });
  it("deep allows more iters", () => {
    expect(DEFAULT_PARAMS_BY_DEPTH.deep.max_iter).toBe(8);
  });
  it("all tiers have plateau_no_improvement_iters", () => {
    expect(DEFAULT_PARAMS_BY_DEPTH.shallow.plateau_no_improvement_iters).toBe(1);
    expect(DEFAULT_PARAMS_BY_DEPTH.standard.plateau_no_improvement_iters).toBe(2);
    expect(DEFAULT_PARAMS_BY_DEPTH.deep.plateau_no_improvement_iters).toBe(3);
  });
});
