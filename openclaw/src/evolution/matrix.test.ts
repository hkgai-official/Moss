// src/evolution/matrix.test.ts
import { describe, expect, it } from "vitest";
import {
  buildKeypointMatrix,
  computeIterPassRate,
  detectPlateau,
  formatMatrixForReviewer,
  type BaselineEvaluation,
  type IterEvaluation,
  type KeypointTag,
  parseBaselineEvaluation,
  parseTaskEvaluation,
} from "./matrix.js";

const T = (tag: KeypointTag): KeypointTag => tag;

describe("buildKeypointMatrix", () => {
  it("rows are per-task per-keypoint; cells are [baseline, iter1, iter2, ...]", () => {
    const baseline = new Map<string, BaselineEvaluation>([
      [
        "T1",
        {
          keypoints: ["tool_seq", "result"],
          assessments: { tool_seq: T("weak"), result: T("strong") },
        },
      ],
    ]);
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map([["T1", { assessments: { tool_seq: T("adequate"), result: T("strong") } }]])],
      [2, new Map([["T1", { assessments: { tool_seq: T("strong"), result: T("strong") } }]])],
    ]);
    const matrix = buildKeypointMatrix(baseline, iters);
    expect(matrix.rows.length).toBe(2);
    const tsRow = matrix.rows.find((r) => r.keypoint === "tool_seq")!;
    expect(tsRow.task_id).toBe("T1");
    expect(tsRow.cells).toEqual(["weak", "adequate", "strong"]);
    expect(tsRow.delta).toBe("improved");
    const resultRow = matrix.rows.find((r) => r.keypoint === "result")!;
    expect(resultRow.delta).toBe("unchanged");
  });

  it("missing iter eval fills with 'missing'", () => {
    const baseline = new Map<string, BaselineEvaluation>([
      ["T1", { keypoints: ["k"], assessments: { k: T("weak") } }],
    ]);
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map()], // T1 absent
    ]);
    const matrix = buildKeypointMatrix(baseline, iters);
    expect(matrix.rows[0].cells).toEqual(["weak", "missing"]);
    expect(matrix.rows[0].delta).toBe("regressed");
  });
});

describe("detectPlateau", () => {
  const baseline = new Map<string, BaselineEvaluation>([
    ["T1", { keypoints: ["k"], assessments: { k: T("weak") } }],
  ]);

  it("shallow plateau: 1 iter with no upgrade beyond baseline", () => {
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map([["T1", { assessments: { k: T("weak") } }]])],
    ]);
    expect(detectPlateau(buildKeypointMatrix(baseline, iters), "shallow")).toBe(true);
  });

  it("shallow non-plateau: latest iter improves", () => {
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map([["T1", { assessments: { k: T("adequate") } }]])],
    ]);
    expect(detectPlateau(buildKeypointMatrix(baseline, iters), "shallow")).toBe(false);
  });

  it("standard plateau: 2 consecutive iters with no upgrade", () => {
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map([["T1", { assessments: { k: T("weak") } }]])],
      [2, new Map([["T1", { assessments: { k: T("weak") } }]])],
    ]);
    expect(detectPlateau(buildKeypointMatrix(baseline, iters), "standard")).toBe(true);
  });

  it("standard non-plateau if any of last 2 iters had upgrade", () => {
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map([["T1", { assessments: { k: T("adequate") } }]])],
      [2, new Map([["T1", { assessments: { k: T("adequate") } }]])],
    ]);
    // iter1 had +1 upgrade over baseline, so the last 3 cells [weak, adequate, adequate] contain an upgrade
    expect(detectPlateau(buildKeypointMatrix(baseline, iters), "standard")).toBe(false);
  });

  it("not enough data → not plateau", () => {
    const iters = new Map<number, Map<string, IterEvaluation>>([]);
    expect(detectPlateau(buildKeypointMatrix(baseline, iters), "standard")).toBe(false);
  });
});

describe("parseTaskEvaluation", () => {
  const sample = [
    "# Task Evaluation — T137 — iter 2",
    "",
    "## Execution Logic Summary",
    "agent did things...",
    "",
    "## Keypoint Assessments",
    "",
    "### `tool_sequencing` — adequate",
    "",
    "Called list before filter — sensible.",
    "",
    "### `information_extraction` — strong",
    "",
    "Pulled all 3 keypoints correctly.",
    "",
    "### `result_reporting` — weak",
    "",
    "Missing root cause analysis.",
    "",
    "## Flakiness Note",
    "none.",
  ].join("\n");

  it("extracts assessments from `### `name` — tag` headings", () => {
    const ev = parseTaskEvaluation(sample);
    expect(ev.assessments).toEqual({
      tool_sequencing: "adequate",
      information_extraction: "strong",
      result_reporting: "weak",
    });
  });

  it("ignores headings with wrong depth (####, ##)", () => {
    const bad = "#### `foo` — strong\n## `bar` — weak\n";
    expect(parseTaskEvaluation(bad).assessments).toEqual({});
  });

  it("ignores headings without backticks around the keypoint name", () => {
    const bad = "### foo — strong\n";
    expect(parseTaskEvaluation(bad).assessments).toEqual({});
  });

  it("ignores tag values outside the closed set", () => {
    const bad = "### `foo` — excellent\n";
    expect(parseTaskEvaluation(bad).assessments).toEqual({});
  });

  it("parseBaselineEvaluation also returns the keypoints list in heading order", () => {
    const bev = parseBaselineEvaluation(sample);
    expect(bev.keypoints).toEqual([
      "tool_sequencing",
      "information_extraction",
      "result_reporting",
    ]);
  });
});

describe("formatMatrixForReviewer", () => {
  it("renders a header + rows ASCII grid with baseline + iter columns", () => {
    const baseline = new Map<string, BaselineEvaluation>([
      ["T1", { keypoints: ["k1"], assessments: { k1: T("weak") } }],
    ]);
    const iters = new Map<number, Map<string, IterEvaluation>>([
      [1, new Map([["T1", { assessments: { k1: T("strong") } }]])],
    ]);
    const md = formatMatrixForReviewer(buildKeypointMatrix(baseline, iters));
    expect(md).toContain("task");
    expect(md).toContain("keypoint");
    expect(md).toContain("baseline");
    expect(md).toContain("iter1");
    expect(md).toContain("delta");
    expect(md).toContain("T1");
    expect(md).toContain("weak");
    expect(md).toContain("strong");
    expect(md).toContain("improved");
  });

  it("returns a friendly empty marker when no rows", () => {
    const empty = buildKeypointMatrix(new Map(), new Map());
    expect(formatMatrixForReviewer(empty)).toMatch(/no.*matrix/i);
  });
});

describe("computeIterPassRate", () => {
  it("returns 0 for empty map", () => {
    expect(computeIterPassRate(new Map())).toBe(0);
  });
  it("returns 0 for empty assessments", () => {
    const evals = new Map<string, IterEvaluation>([["T1", { assessments: {} }]]);
    expect(computeIterPassRate(evals)).toBe(0);
  });
  it("returns 1.0 for all strong", () => {
    const evals = new Map<string, IterEvaluation>([
      ["T1", { assessments: { k1: "strong", k2: "strong" } }],
    ]);
    expect(computeIterPassRate(evals)).toBeCloseTo(1.0);
  });
  it("returns 0 for all missing", () => {
    const evals = new Map<string, IterEvaluation>([
      ["T1", { assessments: { k1: "missing", k2: "missing" } }],
    ]);
    expect(computeIterPassRate(evals)).toBe(0);
  });
  it("averages across tasks", () => {
    // (3+1+2+2)/4 / 3 = 8/12 = 2/3
    const evals = new Map<string, IterEvaluation>([
      ["T1", { assessments: { k1: "strong", k2: "weak" } }],
      ["T2", { assessments: { k1: "adequate", k2: "adequate" } }],
    ]);
    expect(computeIterPassRate(evals)).toBeCloseTo(2 / 3, 3);
  });
});
