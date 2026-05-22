// src/evolution/round-loop.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvolutionLog } from "./evolution-log.js";
import { parseReviewerVerdict, runRoundLoop } from "./round-loop.js";

describe("parseReviewerVerdict", () => {
  it("extracts APPROVE under ## Verdict", () => {
    expect(parseReviewerVerdict("## Verdict\nAPPROVE\n")).toBe("APPROVE");
  });
  it("extracts REJECT under ## Verdict", () => {
    expect(parseReviewerVerdict("## Verdict\nREJECT\n")).toBe("REJECT");
  });
  it("extracts REJECT_IMPL", () => {
    expect(parseReviewerVerdict("## Verdict\nREJECT_IMPL\n")).toBe("REJECT");
  });
  it("treats REVISE as own verdict", () => {
    expect(parseReviewerVerdict("## Verdict\nREVISE\n")).toBe("REVISE");
  });
  it("returns AMBIGUOUS when no anchor matches", () => {
    expect(parseReviewerVerdict("looks ok")).toBe("AMBIGUOUS");
  });
  it("falls back to tail scan when no Verdict section", () => {
    expect(parseReviewerVerdict("blah blah\n\nFinal: APPROVE\n")).toBe("APPROVE");
  });
});

function setupLogged(td: string) {
  const iterDir = path.join(td, "iter_1");
  fs.mkdirSync(iterDir, { recursive: true });
  const evolutionLog = new EvolutionLog(path.join(td, "evolution-log.jsonl"));
  return { iterDir, evolutionLog };
}

function makeMd(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe("runRoundLoop", () => {
  it("REJECT round 0 → APPROVE round 1 with --resume", async () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    const { iterDir, evolutionLog } = setupLogged(td);

    const workerCalls: Array<{ round: number; resume: string | null }> = [];
    const reviewerCalls: Array<{ round: number; resume: string | null }> = [];
    const reviewerVerdicts = ["## Verdict\nREJECT\n", "## Verdict\nAPPROVE\n"];

    const result = await runRoundLoop({
      maxRounds: 3,
      iterDir,
      loopName: "plan",
      iter: 1,
      evolutionLog,
      runWorker: async (round, resume) => {
        workerCalls.push({ round, resume });
        const md = path.join(iterDir, "plan.md");
        makeMd(md, `plan round ${round}`);
        return { mdPath: md, sessionId: `worker-${round}` };
      },
      runReviewer: async (round, _workerMd, resume) => {
        reviewerCalls.push({ round, resume });
        const md = path.join(iterDir, "plan-reviewer.md");
        makeMd(md, reviewerVerdicts[round]);
        return { mdPath: md, sessionId: `reviewer-${round}` };
      },
    });

    evolutionLog.close();
    expect(result.verdict).toBe("APPROVE");
    expect(result.rounds).toBe(2);
    expect(workerCalls).toEqual([
      { round: 0, resume: null },
      { round: 1, resume: "worker-0" },
    ]);
    expect(reviewerCalls).toEqual([
      { round: 0, resume: null },
      { round: 1, resume: "reviewer-0" },
    ]);
    // Archive dir for round 0 should exist
    expect(fs.existsSync(path.join(iterDir, "revisions", "plan_round_0", "plan.md"))).toBe(true);
    expect(fs.existsSync(path.join(iterDir, "revisions", "plan_round_1", "plan.md"))).toBe(true);
  });

  it("aborts after maxRounds with all REJECT", async () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    const { iterDir, evolutionLog } = setupLogged(td);

    const result = await runRoundLoop({
      maxRounds: 2,
      iterDir,
      loopName: "code",
      iter: 5,
      evolutionLog,
      runWorker: async (round) => {
        const md = path.join(iterDir, "implementer.md");
        makeMd(md, `r${round}`);
        return { mdPath: md, sessionId: `w-${round}` };
      },
      runReviewer: async (round) => {
        const md = path.join(iterDir, "code-reviewer.md");
        makeMd(md, "## Verdict\nREJECT_IMPL\n");
        return { mdPath: md, sessionId: `r-${round}` };
      },
    });

    evolutionLog.close();
    expect(result.verdict).toBe("ABORTED");
    expect(result.rounds).toBe(2);
    expect(result.finalWorkerMdPath).toBeNull();
    expect(fs.existsSync(path.join(iterDir, "revisions", "code_round_0"))).toBe(true);
    expect(fs.existsSync(path.join(iterDir, "revisions", "code_round_1"))).toBe(true);
  });

  it("calls beforeRetry between rounds (code-loop hard-reset path)", async () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    const { iterDir, evolutionLog } = setupLogged(td);

    const beforeRetry = vi.fn(async (_round: number) => {});
    const reviewerVerdicts = ["## Verdict\nREJECT_IMPL\n", "## Verdict\nAPPROVE\n"];

    await runRoundLoop({
      maxRounds: 2,
      iterDir,
      loopName: "code",
      iter: 1,
      evolutionLog,
      beforeRetry,
      runWorker: async (round) => {
        const md = path.join(iterDir, "implementer.md");
        makeMd(md, `r${round}`);
        return { mdPath: md, sessionId: `w-${round}` };
      },
      runReviewer: async (round) => {
        const md = path.join(iterDir, "code-reviewer.md");
        makeMd(md, reviewerVerdicts[round]);
        return { mdPath: md, sessionId: `r-${round}` };
      },
    });
    evolutionLog.close();

    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(beforeRetry).toHaveBeenCalledWith(1);
  });

  it("bailIfStopRequested at round entry — loop never reaches worker", async () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    const { iterDir, evolutionLog } = setupLogged(td);
    const runWorker = vi.fn(async () => {
      const md = path.join(iterDir, "plan.md");
      makeMd(md, "unreached");
      return { mdPath: md, sessionId: "w" };
    });
    const runReviewer = vi.fn(async () => {
      const md = path.join(iterDir, "plan-reviewer.md");
      makeMd(md, "## Verdict\nAPPROVE\n");
      return { mdPath: md, sessionId: "r" };
    });
    await expect(
      runRoundLoop({
        maxRounds: 3,
        iterDir,
        loopName: "plan",
        iter: 1,
        evolutionLog,
        bailIfStopRequested: () => {
          throw new Error("stop requested at round entry");
        },
        runWorker,
        runReviewer,
      }),
    ).rejects.toThrow("stop requested at round entry");
    evolutionLog.close();
    expect(runWorker).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it("bailIfStopRequested between worker and reviewer — reviewer never spawns", async () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    const { iterDir, evolutionLog } = setupLogged(td);
    let bailCalls = 0;
    const runWorker = vi.fn(async () => {
      const md = path.join(iterDir, "plan.md");
      makeMd(md, "ok");
      return { mdPath: md, sessionId: "w" };
    });
    const runReviewer = vi.fn(async () => {
      const md = path.join(iterDir, "plan-reviewer.md");
      makeMd(md, "## Verdict\nAPPROVE\n");
      return { mdPath: md, sessionId: "r" };
    });
    await expect(
      runRoundLoop({
        maxRounds: 3,
        iterDir,
        loopName: "plan",
        iter: 1,
        evolutionLog,
        bailIfStopRequested: () => {
          bailCalls++;
          if (bailCalls >= 2) {
            throw new Error("stop requested mid-round");
          }
        },
        runWorker,
        runReviewer,
      }),
    ).rejects.toThrow("stop requested mid-round");
    evolutionLog.close();
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(runReviewer).not.toHaveBeenCalled();
    expect(bailCalls).toBe(2);
  });

  it("APPROVE on first round → no beforeRetry", async () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    const { iterDir, evolutionLog } = setupLogged(td);
    const beforeRetry = vi.fn(async () => {});

    const result = await runRoundLoop({
      maxRounds: 3,
      iterDir,
      loopName: "plan",
      iter: 1,
      evolutionLog,
      beforeRetry,
      runWorker: async () => {
        const md = path.join(iterDir, "plan.md");
        makeMd(md, "ok");
        return { mdPath: md, sessionId: "w" };
      },
      runReviewer: async () => {
        const md = path.join(iterDir, "plan-reviewer.md");
        makeMd(md, "## Verdict\nAPPROVE\n");
        return { mdPath: md, sessionId: "r" };
      },
    });
    evolutionLog.close();
    expect(result.verdict).toBe("APPROVE");
    expect(result.rounds).toBe(1);
    expect(beforeRetry).not.toHaveBeenCalled();
  });
});
