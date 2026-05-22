// src/evolution/stages/finalize.ts
//
// Stage 9 finalize: write iteration_<N>/manifest_entry.json + verdict.json
// atomically with fsync ordering, append the IterationEntry to manifest, and
// flush manifest.json. Spec §4 fsync ordering MUST be preserved (entry first,
// then manifest, then any swap-req if applicable). Swap-req is written by
// the loop top-level when it transitions to swap_pending.
import * as fs from "node:fs";
import * as path from "node:path";
import type { EvolutionLog } from "../evolution-log.js";
import {
  appendIteration,
  loadManifest,
  saveManifest,
  type IterationEntry,
  type Manifest,
} from "../state.js";
import type { Verdict } from "../verdict.js";

export interface FinalizeStageInput {
  iter: number;
  iterDir: string;
  manifestPath: string; // container abs
  evolutionLog: EvolutionLog;
  iterationEntry: IterationEntry;
  verdict: Verdict;
  nextStatus: Manifest["status"];
}

export interface FinalizeStageResult {
  manifestEntryPath: string;
  verdictPath: string;
}

export async function runFinalizeStage(input: FinalizeStageInput): Promise<FinalizeStageResult> {
  input.evolutionLog.append({
    iter: input.iter,
    stage: "finalize",
    event: "stage_start",
    data: { verdict: input.verdict, nextStatus: input.nextStatus },
  });

  // 1. Atomic write iteration_<N>/manifest_entry.json
  const entryPath = path.join(input.iterDir, "manifest_entry.json");
  atomicWriteJson(entryPath, input.iterationEntry);

  // 2. Atomic write iteration_<N>/verdict.json
  const verdictPath = path.join(input.iterDir, "verdict.json");
  atomicWriteJson(verdictPath, { verdict: input.verdict, ts: Date.now() });

  // 3. Append iteration to top-level manifest, then update status atomically
  appendIteration(input.manifestPath, input.iterationEntry);
  const m = loadManifest(input.manifestPath);
  m.status = input.nextStatus;
  m.currentStage = `iter${input.iter}_finalized`;
  // Update best_score_so_far using taskEvalPassRate (task-evaluator keypoint scale).
  // IMPORTANT: this MUST match the scale that loop.ts:721 feeds into
  // updateStreaksFromIteration (iterScore = outcome.entry.taskEvalPassRate ?? 0).
  // verdict.ts:262 compares iterScore > bestScoreSoFar; mixing grader scale here
  // with task-eval scale in loop.ts silently defeats the noProgress streak logic.
  // trainResults is still persisted in the entry for the /api/evolution/scores UI.
  const iterMean = input.iterationEntry.taskEvalPassRate ?? 0;
  if (iterMean > m.bestScoreSoFar) {
    m.bestScoreSoFar = iterMean;
  }
  saveManifest(input.manifestPath, m);

  input.evolutionLog.append({
    iter: input.iter,
    stage: "finalize",
    event: "stage_end",
    data: { manifestEntryPath: entryPath, verdictPath },
  });

  return { manifestEntryPath: entryPath, verdictPath };
}

function atomicWriteJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}
