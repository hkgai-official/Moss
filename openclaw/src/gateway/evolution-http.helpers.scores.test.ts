import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { handleScores } from "./evolution-http.helpers.js";

describe("handleScores", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scores-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 when manifestId param missing", async () => {
    const r = await handleScores({ dataDir: tmpDir }, new URLSearchParams());
    expect(r.status).toBe(400);
  });

  it("returns 404 when manifest not found", async () => {
    const r = await handleScores(
      { dataDir: tmpDir },
      new URLSearchParams({ manifestId: "nonexistent" }),
    );
    expect(r.status).toBe(404);
  });

  it("returns iter score means from manifest.iterations[].trainResults", async () => {
    // Setup: stateDir + archive/<id>/manifest.json + flag-batch/<id>/_batch.json
    const stateDir = path.join(tmpDir, "evo-loop-state");
    const archiveDir = path.join(stateDir, "archive", "demo-fixture-1");
    const batchDir = path.join(stateDir, "flag-batch", "demo-fixture-1");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 6,
        triggerId: "demo-fixture-1",
        inputSetId: "demo-fixture-1",
        triggerSource: "manual",
        triggeredAt: Date.now(),
        triggeredBy: "test",
        inputManifestPath: "/tmp/fixture.yaml",
        startingImage: "test:base",
        startingCommit: null,
        startingBranch: "main",
        evolutionBranch: "evo-v2.6/demo-fixture-1",
        validationSet: "demo-fixture-1",
        mode: "user",
        evolutionDepth: "standard",
        flagBatchId: "demo-fixture-1",
        params: { max_iter: 3 },
        tasks: { stage_a: [], stage_c: [] },
        status: "converged",
        currentIteration: 2,
        currentStage: "finalize",
        iterations: [
          {
            iteration: 1, verdict: "need_more_work", commitHash: "abc", imageTag: "openclaw:v2.6-iter1",
            trainResults: [
              { task: "T1", trial: 1, score: 0.5, baselineScore: 0.3, judgePassed: false },
              { task: "T1", trial: 2, score: 0.7, baselineScore: 0.3, judgePassed: true },
              { task: "T2", trial: 1, score: 0.6, baselineScore: 0.4, judgePassed: true },
            ],
            validationRun: null, diagnosisMdPath: null, planMdPath: null,
            planReviewerMdPath: null, implementerMdPath: null, codeReviewerMdPath: null,
            reviewerMdPath: null, reviewerVerdict: null, taskEvaluations: {},
            elapsedS: 60, planRoundCount: 1, codeRoundCount: 1, sessionIdByRole: null,
          },
          {
            iteration: 2, verdict: "converged", commitHash: "def", imageTag: "openclaw:v2.6-iter2",
            trainResults: [
              { task: "T1", trial: 1, score: 0.9, baselineScore: 0.3, judgePassed: true },
              { task: "T2", trial: 1, score: 0.8, baselineScore: 0.4, judgePassed: true },
            ],
            validationRun: null, diagnosisMdPath: null, planMdPath: null,
            planReviewerMdPath: null, implementerMdPath: null, codeReviewerMdPath: null,
            reviewerMdPath: null, reviewerVerdict: null, taskEvaluations: {},
            elapsedS: 60, planRoundCount: 1, codeRoundCount: 1, sessionIdByRole: null,
          },
        ],
        streaks: { consecutiveBuildFailures: 0, consecutiveSessionCrashes: 0, noProgress: 0, progressNoApprove: 0 },
        bestScoreSoFar: 0.85,
        swapOutcome: null,
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(batchDir, "_batch.json"),
      JSON.stringify({
        batch_id: "demo-fixture-1",
        created_at: Date.now(),
        status: "current",
        threshold: 0,
        trigger_mode: "manual",
        triggered_at: Date.now(),
        triggered_evolution_trigger_id: "demo-fixture-1",
        flag_count: 0,
        origin: "demo",
        user_label: "sample_compliance_audit",
        depth: "standard",
        created_by: "ui",
        apply_state: "ready_to_apply",
      }, null, 2),
    );

    const r = await handleScores(
      { dataDir: tmpDir },
      new URLSearchParams({ manifestId: "demo-fixture-1" }),
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      iters: { iter: number; mean: number; verdict: string | null }[];
      templateId: string;
    };
    expect(body.iters).toHaveLength(2);
    // iter1: (0.5+0.7+0.6)/3 = 0.6
    expect(body.iters[0].mean).toBeCloseTo(0.6, 3);
    expect(body.iters[0].verdict).toBe("need_more_work");
    // iter2: (0.9+0.8)/2 = 0.85
    expect(body.iters[1].mean).toBeCloseTo(0.85, 3);
    expect(body.iters[1].verdict).toBe("converged");
    expect(body.templateId).toBe("sample_compliance_audit");
  });

  it("returns baseline=null when fixture dir does not exist", async () => {
    // Same fixture as above but with templateId pointing at a baseline dir
    // we don't create. baseline should be null, not 500.
    const stateDir = path.join(tmpDir, "evo-loop-state");
    const archiveDir = path.join(stateDir, "archive", "demo-fixture-2");
    const batchDir = path.join(stateDir, "flag-batch", "demo-fixture-2");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(batchDir, { recursive: true });
    // Minimal manifest with no iterations
    fs.writeFileSync(path.join(archiveDir, "manifest.json"), JSON.stringify({
      schemaVersion: 6, triggerId: "demo-fixture-2", inputSetId: "demo-fixture-2",
      triggerSource: "manual", triggeredAt: 0, triggeredBy: "t",
      inputManifestPath: "", startingImage: "", startingCommit: null,
      startingBranch: "main", evolutionBranch: "", validationSet: "",
      mode: "user", evolutionDepth: "standard", flagBatchId: "demo-fixture-2",
      params: { max_iter: 1 }, tasks: { stage_a: [], stage_c: [] },
      status: "in_progress", currentIteration: 0, currentStage: "init",
      iterations: [],
      streaks: { consecutiveBuildFailures: 0, consecutiveSessionCrashes: 0, noProgress: 0, progressNoApprove: 0 },
      bestScoreSoFar: 0, swapOutcome: null,
    }, null, 2));
    fs.writeFileSync(path.join(batchDir, "_batch.json"), JSON.stringify({
      batch_id: "demo-fixture-2", created_at: 0, status: "current", threshold: 0,
      trigger_mode: "manual", triggered_at: 0, triggered_evolution_trigger_id: null,
      flag_count: 0, origin: "demo", user_label: "no_such_template",
      depth: "standard", created_by: "ui", apply_state: "running",
    }, null, 2));

    // Set MOSS_OPENCLAW_REPO_DIR so manifestRoot resolves but the template dir doesn't exist
    process.env.MOSS_OPENCLAW_REPO_DIR = "/data/moss/openclaw";

    const r = await handleScores(
      { dataDir: tmpDir },
      new URLSearchParams({ manifestId: "demo-fixture-2" }),
    );
    expect(r.status).toBe(200);
    const body = r.body as { baseline: unknown; iters: unknown[] };
    expect(body.baseline).toBeNull();
    expect(body.iters).toHaveLength(0);
  });
});
