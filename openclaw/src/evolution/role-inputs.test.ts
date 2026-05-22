// Regression test for the container-path-leak-into-prompt bug. Without this,
// composers embedded /home/node/.openclaw/... paths into user prompts that get
// sent to coding-agent CLIs running on the HOST (not in the container) —
// where /home/node/ either doesn't exist or isn't writable.
//
// Claude tolerates this by heuristically remapping via --add-dir + the
// _path_tree.md crib sheet. Codex does literal mkdir -p and errors with
// "Failed to create parent directories". After the fix, composers translate
// any container-prefix paths to host absolute paths via pathToHost(), so
// both providers see a directly-usable host path.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  composeCodeReviewerUserInput,
  composeImplementerUserInput,
  composeLocatorUserInput,
  composePlanReviewerUserInput,
  composePlannerUserInput,
  composeReviewerUserInput,
  composeStrategicUserInput,
  composeTaskEvaluatorUserInput,
} from "./role-inputs.js";

const HOST_DATA_DIR = "/host/abs/.moss";
const HOST_REPO_DIR = "/host/abs/moss/openclaw";

beforeAll(() => {
  process.env.MOSS_DATA_DIR = HOST_DATA_DIR;
  process.env.MOSS_OPENCLAW_REPO_DIR = HOST_REPO_DIR;
});

/** Asserts: text contains the expected host substring AND does NOT contain
 *  any leaked container prefix (/home/node/.openclaw or /app or /benchmark). */
function expectNoContainerLeak(text: string): void {
  for (const banned of ["/home/node/.openclaw", "/app/", "/benchmark/"]) {
    expect(text, `unexpected container path "${banned}" in:\n${text}`).not.toContain(banned);
  }
}

describe("composer host-path translation (regression for codex breakage)", () => {
  afterEach(() => {
    // composers must be deterministic functions of args + env; no leakage.
  });

  // -- task-evaluator: the one that bit codex on Stage 0.5 baseline --
  describe("composeTaskEvaluatorUserInput", () => {
    it("translates container tracesPath + outputPath to host", () => {
      const out = composeTaskEvaluatorUserInput({
        iter: 0,
        task: { task_id: "T137", task_name: "test task" },
        tracesPath: "/home/node/.openclaw/evo-loop-state/current/baseline/traces/T137",
        outputPath: "/home/node/.openclaw/evo-loop-state/current/baseline/task_evaluations/T137.md",
        keypointsList: null,
      });
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/baseline/traces/T137`);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/baseline/task_evaluations/T137.md`);
    });

    it("leaves already-host-absolute paths unchanged (idempotent)", () => {
      const out = composeTaskEvaluatorUserInput({
        iter: 0,
        task: { task_id: "T1", task_name: "x" },
        tracesPath: "/some/already/host/path",
        outputPath: "/another/host/path.md",
        keypointsList: null,
      });
      expectNoContainerLeak(out);
      expect(out).toContain("/some/already/host/path");
      expect(out).toContain("/another/host/path.md");
    });
  });

  // -- locator --
  describe("composeLocatorUserInput", () => {
    it("translates inputManifestPath + literal ~/.openclaw paths to host abs", () => {
      const out = composeLocatorUserInput({
        iter: 1,
        inputSetId: "demo-batch",
        inputManifestPath: "/home/node/.openclaw/evo-loop-state/current/manifest.json",
      });
      expectNoContainerLeak(out);
      // The literal ~/.openclaw/evo-loop-state/current/iteration_<N-1>/ in the
      // prompt template must become a host-abs path; otherwise the agent's
      // tilde expands to /home/user/.openclaw (wrong/nonexistent).
      expect(out).not.toContain("~/.openclaw");
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/`);
    });
  });

  // -- planner --
  describe("composePlannerUserInput", () => {
    it("round 0: translates locatorMdPath + iteration paths", () => {
      const out = composePlannerUserInput(
        1,
        "/home/node/.openclaw/evo-loop-state/current/iteration_1/diagnosis.md",
      );
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_1/diagnosis.md`);
      // iteration_<iter>/plan.md literal — must become host-abs
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_1/plan.md`);
    });

    it("round 1 (REJECT revision): translates archive paths too", () => {
      const out = composePlannerUserInput(
        2,
        "/home/node/.openclaw/evo-loop-state/current/iteration_2/diagnosis.md",
        1,
      );
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_2/plan.md`);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_2/plan-reviewer.md`);
    });
  });

  // -- plan-reviewer --
  describe("composePlanReviewerUserInput", () => {
    it("translates locatorMdPath + iteration paths", () => {
      const out = composePlanReviewerUserInput(
        1,
        "/home/node/.openclaw/evo-loop-state/current/iteration_1/diagnosis.md",
      );
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_1/`);
    });
  });

  // -- implementer --
  describe("composeImplementerUserInput", () => {
    it("translates planMdPath + implementer.md", () => {
      const out = composeImplementerUserInput(
        3,
        "/home/node/.openclaw/evo-loop-state/current/iteration_3/plan.md",
      );
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_3/plan.md`);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_3/implementer.md`);
    });
  });

  // -- code-reviewer --
  describe("composeCodeReviewerUserInput", () => {
    it("translates planMdPath + code-reviewer.md", () => {
      const out = composeCodeReviewerUserInput(
        3,
        "/home/node/.openclaw/evo-loop-state/current/iteration_3/plan.md",
      );
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_3/code-reviewer.md`);
    });
  });

  // -- strategic-reviewer --
  describe("composeStrategicUserInput", () => {
    it("translates planMdPath + gradeSummaryPath + strategic-reviewer.md", () => {
      const out = composeStrategicUserInput({
        iter: 2,
        planMdPath: "/home/node/.openclaw/evo-loop-state/current/iteration_2/plan.md",
        gradeSummaryPath: "/home/node/.openclaw/evo-loop-state/current/iteration_2/grade_summary_stage_a.json",
        meanScore: 0.5,
        nPassed: 2,
        nFailed: 2,
      });
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_2/plan.md`);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_2/strategic-reviewer.md`);
    });
  });

  // -- reviewer (v2.6) --
  describe("composeReviewerUserInput", () => {
    it("translates iterDir + priorReviewerMdPath + reviewer.md", () => {
      const out = composeReviewerUserInput({
        iter: 2,
        iterDir: "/home/node/.openclaw/evo-loop-state/current/iteration_2",
        priorReviewerMdPath: "/home/node/.openclaw/evo-loop-state/current/iteration_1/reviewer.md",
        matrixSummary: "(matrix text)",
      });
      expectNoContainerLeak(out);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_2`);
      expect(out).toContain(`${HOST_DATA_DIR}/evo-loop-state/current/iteration_1/reviewer.md`);
    });

    it("priorReviewerMdPath null on iter 1", () => {
      const out = composeReviewerUserInput({
        iter: 1,
        iterDir: "/home/node/.openclaw/evo-loop-state/current/iteration_1",
        priorReviewerMdPath: null,
        matrixSummary: "(matrix)",
      });
      expectNoContainerLeak(out);
      expect(out).toContain("Prior reviewer verdict: (none — this is iter 1)");
    });
  });
});
