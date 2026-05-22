// src/evolution/matrix.ts
//
// Keypoint matrix construction + plateau detection for v2.6 reviewer wiring.
// The matrix is the reviewer's primary numeric input: rows are
// per-(task, keypoint), columns are [baseline, iter1, iter2, ...]. The
// reviewer reads the matrix shape (improved/regressed/unchanged per row,
// recency of last upgrade) alongside the task-evaluator narratives to issue
// its 4-verdict decision.

import type { EvolutionDepth } from "./state.js";

export type KeypointTag = "strong" | "adequate" | "weak" | "missing";

const TAG_ORDER: Record<KeypointTag, number> = {
  missing: 0,
  weak: 1,
  adequate: 2,
  strong: 3,
};

export interface BaselineEvaluation {
  /** Locked keypoint list from baseline call (4-7 entries picked by evaluator). */
  keypoints: string[];
  assessments: Record<string, KeypointTag>;
}

export interface IterEvaluation {
  /** Iter-N call MUST score against baseline.keypoints — same keys expected. */
  assessments: Record<string, KeypointTag>;
}

export interface MatrixRow {
  task_id: string;
  keypoint: string;
  /** [baseline, iter1, iter2, ...]; "missing" fills holes. */
  cells: KeypointTag[];
  delta: "improved" | "regressed" | "unchanged";
}

export interface KeypointMatrix {
  rows: MatrixRow[];
}

export function buildKeypointMatrix(
  baseline: Map<string, BaselineEvaluation>,
  iters: Map<number, Map<string, IterEvaluation>>,
): KeypointMatrix {
  const rows: MatrixRow[] = [];
  const sortedIters = [...iters.keys()].sort((a, b) => a - b);

  for (const [taskId, bEval] of baseline.entries()) {
    for (const kp of bEval.keypoints) {
      const cells: KeypointTag[] = [bEval.assessments[kp] ?? "missing"];
      for (const iter of sortedIters) {
        const taskIterEval = iters.get(iter)?.get(taskId);
        cells.push(taskIterEval?.assessments[kp] ?? "missing");
      }
      const first = cells[0];
      const last = cells[cells.length - 1];
      const delta: MatrixRow["delta"] =
        TAG_ORDER[last] > TAG_ORDER[first]
          ? "improved"
          : TAG_ORDER[last] < TAG_ORDER[first]
            ? "regressed"
            : "unchanged";
      rows.push({ task_id: taskId, keypoint: kp, cells, delta });
    }
  }
  return { rows };
}

/** Plateau = no row improved across the last (N+1) cells, where N depends on
 *  evolution depth. Shallow=1, standard=2, deep=3 — same numbers as the
 *  plateau_no_improvement_iters ManifestParam. */
export function detectPlateau(matrix: KeypointMatrix, depth: EvolutionDepth): boolean {
  const noImprovementSinceIters = depth === "shallow" ? 1 : depth === "standard" ? 2 : 3;
  if (matrix.rows.length === 0) return false;

  // Need at least N+1 cells per row to assess.
  const colsToCheck = noImprovementSinceIters + 1;
  let anyHasEnoughCells = false;
  for (const row of matrix.rows) {
    const tail = row.cells.slice(-colsToCheck);
    if (tail.length < colsToCheck) continue;
    anyHasEnoughCells = true;
    for (let i = 1; i < tail.length; i++) {
      if (TAG_ORDER[tail[i]] > TAG_ORDER[tail[i - 1]]) return false;
    }
  }
  // If no row had enough data points, we cannot conclude plateau yet.
  return anyHasEnoughCells;
}

// ---------------------------------------------------------------------------
// Parsers — extract evaluations from task-evaluator markdown output
// ---------------------------------------------------------------------------

/** Match `### \`<keypoint>\` — <tag>` lines.
 *  - Three hashes exactly (not 2, not 4+).
 *  - Backticked snake_case keypoint name.
 *  - Em-dash (U+2014) with surrounding spaces.
 *  - Bare lowercase tag, word-bounded. */
const KEYPOINT_HEADING_RE = /^###(?!#)\s+`([^`]+)`\s+—\s+(strong|adequate|weak|missing)\b/gm;

export function parseTaskEvaluation(md: string): IterEvaluation {
  const assessments: Record<string, KeypointTag> = {};
  KEYPOINT_HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEYPOINT_HEADING_RE.exec(md)) !== null) {
    assessments[m[1]] = m[2] as KeypointTag;
  }
  return { assessments };
}

export function parseBaselineEvaluation(md: string): BaselineEvaluation {
  const iter = parseTaskEvaluation(md);
  return { keypoints: Object.keys(iter.assessments), assessments: iter.assessments };
}

// ---------------------------------------------------------------------------
// Reviewer input: format a KeypointMatrix as a human-readable ASCII table that
// the reviewer prompt embeds verbatim under "## Keypoint matrix". The table
// is a fixed-width grid; reviewer reads cell tags + delta column for signal.
// ---------------------------------------------------------------------------
/** v2.6 polish: per-iter normalized score from task-evaluator output.
 *  Decouples streak progress signal from claweval grader (which is now
 *  demo-only display data, not evolution decision input).
 *
 *  Formula: mean(TAG_ORDER[cell]) / 3 across all (task, keypoint) cells.
 *  Range [0, 1]; "strong" fields → 1.0, "missing" → 0, mixed in between.
 *  Returns 0 when iterEvals is empty (failed iter / not run yet). */
export function computeIterPassRate(
  iterEvals: Map<string, IterEvaluation>,
): number {
  let sum = 0;
  let n = 0;
  for (const ev of iterEvals.values()) {
    for (const tag of Object.values(ev.assessments)) {
      sum += TAG_ORDER[tag];
      n++;
    }
  }
  return n === 0 ? 0 : sum / n / 3;
}

export function formatMatrixForReviewer(matrix: KeypointMatrix): string {
  if (matrix.rows.length === 0) return "(no matrix rows — no baseline evaluations exist)";
  const nIters = matrix.rows[0].cells.length - 1; // first cell is baseline
  const header = ["task", "keypoint", "baseline"];
  for (let i = 1; i <= nIters; i++) header.push(`iter${i}`);
  header.push("delta");
  const rows: string[][] = [header];
  for (const r of matrix.rows) {
    rows.push([r.task_id, r.keypoint, ...r.cells, r.delta]);
  }
  // Compute column widths
  const widths: number[] = [];
  for (let c = 0; c < rows[0].length; c++) {
    widths.push(Math.max(...rows.map((row) => (row[c] ?? "").length)));
  }
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const lines: string[] = [];
  lines.push(rows[0].map((cell, c) => pad(cell, widths[c])).join(" | "));
  lines.push(sep);
  for (let i = 1; i < rows.length; i++) {
    lines.push(rows[i].map((cell, c) => pad(cell, widths[c])).join(" | "));
  }
  return lines.join("\n");
}
