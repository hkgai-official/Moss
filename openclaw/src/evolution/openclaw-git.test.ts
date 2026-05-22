// src/evolution/openclaw-git.test.ts
//
// Regression coverage for the 2026-05-11 bug: readTrainResults silently
// returned all-zero rows for a real, populated grade_summary file because
// (a) it tried fs.existsSync on a host-abs path the container can't see,
// and (b) it expected `{tasks: [...]}` but the daemon writes a top-level
// JSON array.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcCallMock =
  vi.fn<
    (
      op: string,
      payload: Record<string, unknown>,
      opts?: unknown,
    ) => Promise<Record<string, unknown>>
  >();

vi.mock("./rpc-client.js", () => ({
  rpcCall: (op: string, payload: Record<string, unknown>, opts?: unknown) =>
    rpcCallMock(op, payload, opts),
}));

import { commitOpenclawIteration, readTrainResults } from "./openclaw-git.js";

describe("readTrainResults", () => {
  let tmpDir: string;

  beforeAll(() => {
    // path-mapping needs these for pathToContainer. We deliberately point
    // both prefixes at namespaced paths that DON'T overlap tmpDir — that
    // forces pathToContainer's "unmappable, return unchanged" branch, so
    // the file is read directly off-disk at the test path. This mirrors
    // the production case where the trial RPC's returned host-abs path
    // lands inside /home/node/.openclaw which IS visible in-container at
    // the same logical mount point; readTrainResults sees a path it can
    // actually open.
    process.env.MOSS_DATA_DIR = "/host/data";
    process.env.MOSS_OPENCLAW_REPO_DIR = "/host/repo/openclaw";
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-readTrain-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a top-level JSON array (the real daemon shape)", () => {
    const fixtureRows = [
      { task: "T137", trial: 1, score: 0.874, baseline_score: 0.22, judge_passed: true },
      { task: "T137", trial: 2, score: 0.228, baseline_score: 0.22, judge_passed: false },
      { task: "T138", trial: 1, score: 0.5, baseline_score: 0.21, judge_passed: true },
    ];
    const filePath = path.join(tmpDir, "grade_summary_stage_a.json");
    fs.writeFileSync(filePath, JSON.stringify(fixtureRows));

    const result = readTrainResults(filePath, [
      { id: "T137", baseline_score: 0.22 },
      { id: "T138", baseline_score: 0.21 },
    ]);
    expect(result).toEqual([
      { task: "T137", trial: 1, score: 0.874, baselineScore: 0.22, judgePassed: true },
      { task: "T137", trial: 2, score: 0.228, baselineScore: 0.22, judgePassed: false },
      { task: "T138", trial: 1, score: 0.5, baselineScore: 0.21, judgePassed: true },
    ]);
  });

  it("falls back to the original host-abs path when container translation misses (unit-test / direct-host mode)", () => {
    // In-container we'd remap host→container before reading. In unit tests
    // (running directly on the host) the translated path probably doesn't
    // exist; readTrainResults must still pick up the original input path
    // when it's a real file. Otherwise mocked trial runs from outside the
    // container can't be tested without a /home/node/.openclaw tree.
    process.env.MOSS_DATA_DIR = tmpDir;
    const hostPath = path.join(
      tmpDir,
      "evo-loop-state/current/iteration_1/grade_summary_stage_a.json",
    );
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(
      hostPath,
      JSON.stringify([
        { task: "T1", trial: 0, score: 0.9, baseline_score: 0.3, judge_passed: true },
      ]),
    );
    const result = readTrainResults(hostPath, [{ id: "T1", baseline_score: 0.3 }]);
    expect(result).toEqual([
      { task: "T1", trial: 0, score: 0.9, baselineScore: 0.3, judgePassed: true },
    ]);
  });

  it("returns zero-fallback rows when the file is missing", () => {
    const result = readTrainResults(path.join(tmpDir, "does_not_exist.json"), [
      { id: "T1", baseline_score: 0.3 },
    ]);
    expect(result).toEqual([
      { task: "T1", trial: 0, score: 0, baselineScore: 0.3, judgePassed: false },
    ]);
  });

  it("returns zero-fallback when JSON is malformed", () => {
    const filePath = path.join(tmpDir, "grade_summary_stage_a.json");
    fs.writeFileSync(filePath, "{ not: valid json");
    const result = readTrainResults(filePath, [{ id: "T1", baseline_score: 0.3 }]);
    expect(result).toEqual([
      { task: "T1", trial: 0, score: 0, baselineScore: 0.3, judgePassed: false },
    ]);
  });

  it("falls back to manifest baseline when row lacks baseline_score", () => {
    const filePath = path.join(tmpDir, "grade_summary_stage_a.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify([{ task: "T1", trial: 1, score: 0.5, judge_passed: true }]),
    );
    const result = readTrainResults(filePath, [{ id: "T1", baseline_score: 0.42 }]);
    expect(result).toEqual([
      { task: "T1", trial: 1, score: 0.5, baselineScore: 0.42, judgePassed: true },
    ]);
  });

  it("loads the real archived iter-1 fixture from the 2026-05-11 bug report", () => {
    // The bug report (§3, §5) asserts there are 12 rows totaling
    // meanScore ≈ 0.60996. We just check the row count + all scores are
    // populated (i.e. the parser actually walks the array).
    const archived = path.resolve(
      __dirname,
      "../../../openclaw-data/evo-loop-state/archive_sample_2026-05-11_prefix_attempt/iteration_1/grade_summary_stage_a.json",
    );
    if (!fs.existsSync(archived)) {
      // Archive could be moved or pruned in CI; skip rather than fail.
      return;
    }
    // Stage the fixture into our tmpDir so the unmappable-prefix branch
    // applies (HOST_DATA_DIR is /host/data, archived is under repo root).
    const dst = path.join(tmpDir, "grade_summary_stage_a.json");
    fs.copyFileSync(archived, dst);
    const result = readTrainResults(dst, [
      { id: "T137zh_restock_chain_check", baseline_score: 0.2213 },
      { id: "T138_restock_chain_check", baseline_score: 0.209 },
      { id: "T141zh_sla_compliance_audit", baseline_score: 0.3273 },
      { id: "T142_sla_compliance_audit", baseline_score: 0.2527 },
    ]);
    expect(result.length).toBe(12);
    const meanScore = result.reduce((s, r) => s + r.score, 0) / result.length;
    expect(meanScore).toBeGreaterThan(0.6);
    expect(meanScore).toBeLessThan(0.62);
  });
});

describe("commitOpenclawIteration (RPC routing)", () => {
  afterEach(() => {
    rpcCallMock.mockReset();
  });

  it("returns the RPC's commit_hash on success", async () => {
    rpcCallMock.mockResolvedValue({ commit_hash: "abc123def", staged: true });
    const r = await commitOpenclawIteration("/ignored", 4);
    expect(r).toBe("abc123def");
    expect(rpcCallMock).toHaveBeenCalledWith("commit-openclaw-iter", { iter: 4 }, undefined);
  });

  it("returns null when the RPC throws", async () => {
    rpcCallMock.mockRejectedValue(new Error("daemon offline"));
    const r = await commitOpenclawIteration("/ignored", 2);
    expect(r).toBeNull();
  });

  it("returns null when daemon returns empty commit_hash", async () => {
    rpcCallMock.mockResolvedValue({ commit_hash: "", staged: false });
    const r = await commitOpenclawIteration("/ignored", 1);
    expect(r).toBeNull();
  });
});
