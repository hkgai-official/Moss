#!/usr/bin/env bun
/**
 * scripts/run-legacy-strategic.ts — manually run the v2.5 mechanical evaluation
 * chain (grade_summary read + strategic-reviewer Claude session) on an already-
 * completed iteration directory, writing output to <iter_dir>/legacy/ so it
 * sits alongside the v2.6 reviewer.md without overwriting it.
 *
 * This is intentionally OUTSIDE the production loop — iteration.ts does NOT
 * call this. It's here so the operator can A/B-compare v2.5 numerical reviewer
 * vs v2.6 task-evaluator + matrix + reviewer on the same iter's trial output.
 *
 * Usage (inside the moss-gateway container, after an iter finished):
 *   bun /app/scripts/run-legacy-strategic.ts <iter_dir>
 *
 * Where <iter_dir> is a container-absolute path like:
 *   /home/node/.openclaw/evo-loop-state/current/iteration_3
 *
 * Output:
 *   <iter_dir>/legacy/strategic-reviewer.md
 *   <iter_dir>/legacy/strategic-verdict.txt
 *
 * Inputs read:
 *   <iter_dir>/plan.md                 # to feed composeStrategicUserInput
 *   <iter_dir>/grade_summary_stage_a.json  # the v2.5 trial result
 *
 * The script reuses the existing stages/strategic.ts + role-inputs.ts +
 * verdict.parseStrategicVerdict — those files were deliberately preserved when
 * v2.6 Task 3.4 introduced reviewer.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EvolutionLog } from "../src/evolution/evolution-log.js";
import { extractFinalAssistantMd } from "../src/evolution/extract-md.js";
import { loadPrompt } from "../src/evolution/prompt-loader.js";
import { composeStrategicUserInput } from "../src/evolution/role-inputs.js";
import { runStrategicStage } from "../src/evolution/stages/strategic.js";
import { DEFAULT_PARAMS } from "../src/evolution/state.js";
import { parseStrategicVerdict } from "../src/evolution/verdict.js";

interface GradeRow {
  task: string;
  trial: number;
  score: number;
  baseline_score: number;
  judge_passed: boolean;
}

async function main(): Promise<void> {
  const iterDir = process.argv[2];
  if (!iterDir) {
    console.error("usage: bun run-legacy-strategic.ts <iter_dir>");
    process.exit(2);
  }
  if (!fs.existsSync(iterDir)) {
    console.error(`iter_dir does not exist: ${iterDir}`);
    process.exit(2);
  }

  // Reconstruct strategic input from on-disk artifacts.
  const planMdPath = path.join(iterDir, "plan.md");
  const gradePath = path.join(iterDir, "grade_summary_stage_a.json");
  if (!fs.existsSync(gradePath)) {
    console.error(`missing grade_summary_stage_a.json under ${iterDir}`);
    process.exit(3);
  }
  const grade = JSON.parse(fs.readFileSync(gradePath, "utf8")) as GradeRow[];
  const nPassed = grade.filter((g) => g.judge_passed).length;
  const nFailed = grade.length - nPassed;
  const meanScore = grade.length === 0 ? 0 : grade.reduce((a, g) => a + g.score, 0) / grade.length;

  const iterNum = Number(path.basename(iterDir).replace(/^iteration_/, ""));
  if (!Number.isFinite(iterNum)) {
    console.error(
      `cannot infer iter number from ${path.basename(iterDir)} — expected iteration_<N>/`,
    );
    process.exit(2);
  }

  const legacyDir = path.join(iterDir, "legacy");
  fs.mkdirSync(legacyDir, { recursive: true });

  // The strategic stage writes its md into iterDir directly. Redirect to
  // <iterDir>/legacy by running with a temp iterDir mirror, then move output.
  const tracesDir = path.join(path.dirname(iterDir), "session-traces");
  fs.mkdirSync(tracesDir, { recursive: true });
  const evolutionLog = new EvolutionLog(path.join(legacyDir, "evolution-log.jsonl"));

  console.log(`[legacy] running strategic on ${iterDir}`);
  console.log(
    `[legacy] grade summary: nPassed=${nPassed} nFailed=${nFailed} meanScore=${meanScore.toFixed(3)}`,
  );

  const result = await runStrategicStage({
    iter: iterNum,
    iterDir: legacyDir, // strategic writes <iterDir>/strategic-reviewer.md
    tracesDir,
    systemPrompt: loadPrompt("strategic-reviewer", {
      iteration: iterNum,
      max_iter: DEFAULT_PARAMS.max_iter,
      batch_id: "(legacy-rerun)",
    }),
    userInput: composeStrategicUserInput({
      iter: iterNum,
      planMdPath,
      gradeSummaryPath: gradePath,
      meanScore,
      nPassed,
      nFailed,
    }),
    evolutionLog,
    timeoutS: DEFAULT_PARAMS.strategic_reviewer_timeout_s,
    addContainerDirs: [iterDir, legacyDir],
    cwdContainer: legacyDir,
  });

  const md = extractFinalAssistantMd(result.tracePath);
  const verdict = parseStrategicVerdict(md) || parseStrategicVerdict(result.mdPath);

  fs.writeFileSync(path.join(legacyDir, "strategic-verdict.txt"), verdict + "\n");
  evolutionLog.close();

  console.log(`[legacy] verdict: ${verdict}`);
  console.log(`[legacy] outputs:`);
  console.log(`  ${path.join(legacyDir, "strategic-reviewer.md")}`);
  console.log(`  ${path.join(legacyDir, "strategic-verdict.txt")}`);
}

void main();
