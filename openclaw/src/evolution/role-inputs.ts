// src/evolution/role-inputs.ts
//
// Compose the per-role user-input strings for the spawned coding-agent
// sessions. Kept separate from loop.ts so the state-machine code stays
// focused on orchestration, not prompt wiring.
//
// Path-translation contract (important):
//   The TS code runs INSIDE the moss-gateway container, where evolution-loop
//   state lives at `/home/node/.openclaw/...`. The spawned coding-agent CLIs
//   (Claude, Codex, future) run on the HOST, where the same files live at
//   `${MOSS_DATA_DIR}/...`. To avoid agents seeing paths they can't access,
//   every path embedded into a prompt is translated to its host-absolute
//   form via pathToHost(). The translation is idempotent (host paths pass
//   through unchanged), so callers can pass either form.
import { pathToHost } from "./path-mapping.js";
import type { TrainResult } from "./state.js";

// Helper: translate any container-prefix path to host-absolute. Idempotent.
const h = pathToHost;

// Helper: build a host-absolute path under the per-iteration dir. The
// container-side template `iteration_${iter}/<file>` would point to the
// openclaw repo cwd on host (wrong); this resolves it under MOSS_DATA_DIR.
function iterHostPath(iter: number, ...parts: string[]): string {
  return h(`/home/node/.openclaw/evo-loop-state/current/iteration_${iter}/${parts.join("/")}`);
}

// Helper: the per-trigger current/ dir on host.
function currentHostDir(): string {
  return h("/home/node/.openclaw/evo-loop-state/current");
}

export interface LocatorComposeArgs {
  iter: number;
  inputSetId: string;
  inputManifestPath: string;
}

export function composeLocatorUserInput(args: LocatorComposeArgs): string {
  return `# Locator user message — iter ${args.iter}

Batch: ${args.inputSetId}
Manifest: ${h(args.inputManifestPath)}

Read the prior iteration artifacts under
\`${currentHostDir()}/iteration_<N-1>/\` if any, plus the
trial transcripts under \`traces/stage_a_train/<task>/\` inside that dir.
Diagnose the architectural failure modes and write
\`${iterHostPath(args.iter, "diagnosis.md")}\`.
`;
}

export function composePlannerUserInput(iter: number, locatorMdPath: string, round = 0): string {
  const planMd = iterHostPath(iter, "plan.md");
  const planReviewerMd = iterHostPath(iter, "plan-reviewer.md");
  if (round === 0) {
    return `# Planner user message — iter ${iter} round 0

Locator's diagnosis is at: ${h(locatorMdPath)}
Read it, then write \`${planMd}\` with a structured fix proposal.
Architecture map: \`${h("/app/src/evolution/architecture-map.md")}\`.
`;
  }
  // round > 0 — Plan Reviewer REJECTED, Planner is --resume'd
  const archivedPlan = iterHostPath(iter, "revisions", `plan_round_${round - 1}`, "plan.md");
  const archivedReviewerMd = iterHostPath(
    iter, "revisions", `plan_round_${round - 1}`, "plan-reviewer.md",
  );
  return `# Planner user message — iter ${iter} round ${round} (post-REJECT revision)

Plan Reviewer REJECTED your round ${round - 1} plan. Their feedback is at:
\`${planReviewerMd}\`

**STOP**. Even though your chat history shows you already wrote a plan in the
prior turn, that plan was rejected — it is no longer the valid plan for this
iter. You MUST rewrite it. Do not respond with "the plan is already complete".

**Required reading order:**
1. \`${planReviewerMd}\` — pay attention to:
   - \`## Verdict\` (REJECT_ARCHITECTURAL or REJECT_COMPLETENESS)
   - Every Issue in the body, each Issue's Severity + Revision direction
   - \`## Required modifications\` if present
2. \`${planMd}\` (your prior round's output) — recall framing,
   then prepare to overwrite

**Your task this round**: rewrite the ENTIRE \`${planMd}\`
(overwrite the existing file at that path) incorporating every Issue the
reviewer raised. Keep the section structure schema from your system prompt.

Per Issue: either ACCEPT (incorporate the modification into plan.md) or
DECLINE. If you decline, you MUST add a \`## Disagreement rationale\` h2
section to plan.md naming the Issue and citing source-level evidence for
why the reviewer is wrong. Silent disagreement (= ignoring an Issue) is
process failure.

Do NOT create plan_v1.md / plan_round_${round}.md / etc — the orchestrator
archives prior rounds to \`${archivedPlan}\` etc. You write to canonical
\`${planMd}\`.
`;
}

export function composePlanReviewerUserInput(
  iter: number,
  locatorMdPath: string,
  round = 0,
): string {
  const planMd = iterHostPath(iter, "plan.md");
  const planReviewerMd = iterHostPath(iter, "plan-reviewer.md");
  if (round === 0) {
    return `# Plan Reviewer user message — iter ${iter} round 0

Review \`${planMd}\` against \`${h(locatorMdPath)}\`. Output
\`${planReviewerMd}\` with a \`## Verdict\` section saying
APPROVE or REJECT_ARCHITECTURAL or REJECT_COMPLETENESS.
`;
  }
  const archivedPlan = iterHostPath(iter, "revisions", `plan_round_${round - 1}`, "plan.md");
  const archivedReviewerMd = iterHostPath(
    iter, "revisions", `plan_round_${round - 1}`, "plan-reviewer.md",
  );
  return `# Plan Reviewer user message — iter ${iter} round ${round} (post-Planner-revision)

Planner revised the plan in response to your round ${round - 1} REJECT.
The NEW plan (this round) is at:
\`${planMd}\` (overwritten — sibling \`plan.md\` only, no
versioned files at the iter root)

For diff/context, the archived prior round artifacts are at:
- \`${archivedPlan}\` (Planner round ${round - 1})
- \`${archivedReviewerMd}\` (your round ${round - 1} REJECT)

**STOP**. Even though your chat history shows you already wrote a review in
the prior turn, that review applied to a PRIOR plan version. Planner has
rewritten it. You MUST re-review the new version. Do not respond with
"the review is already complete".

**Re-review checklist:**
- Read the new \`${planMd}\` from scratch (it overwrote the prior version).
- For each Issue you raised in your round ${round - 1} review: did Planner
  ACCEPT (modification incorporated) or DECLINE (Disagreement rationale
  added with valid source evidence)? Silent omission = fail.
- Run your normal Step 1 / Step 2 audit against the NEW plan.

Output \`${planReviewerMd}\` (overwrite the prior version)
with a fresh \`## Verdict\`: APPROVE / REJECT_ARCHITECTURAL / REJECT_COMPLETENESS.
`;
}

export function composeImplementerUserInput(iter: number, planMdPath: string): string {
  return `# Implementer user message — iter ${iter}

Implement the plan at: ${h(planMdPath)}.
Make ONE git commit when done with subject prefix \`evo(iter${iter}):\`.
Write \`${iterHostPath(iter, "implementer.md")}\` summarizing the change.
`;
}

export function composeCodeReviewerUserInput(iter: number, planMdPath: string): string {
  return `# Code Reviewer user message — iter ${iter}

Review the diff produced by Implementer against \`${h(planMdPath)}\`. Output
\`${iterHostPath(iter, "code-reviewer.md")}\` with \`## Verdict\` ∈ {APPROVE,
REJECT_IMPL}.
`;
}

export interface StrategicComposeArgs {
  iter: number;
  planMdPath: string;
  gradeSummaryPath: string;
  meanScore: number;
  nPassed: number;
  nFailed: number;
}

export function composeStrategicUserInput(args: StrategicComposeArgs): string {
  return `# Strategic Reviewer user message — iter ${args.iter}

Plan: ${h(args.planMdPath)}
Trial A grade summary: ${h(args.gradeSummaryPath)} (mean ${args.meanScore})
n_passed: ${args.nPassed} / n_failed: ${args.nFailed}

Review whether this iter converged the batch. Output
\`${iterHostPath(args.iter, "strategic-reviewer.md")}\` with \`## Verdict\` ∈
{APPROVE_CONVERGED, NEED_MORE_WORK, FUNDAMENTAL_LIMIT_MODEL,
FUNDAMENTAL_LIMIT_ARCHITECTURE}.
`;
}

// ---------------------------------------------------------------------------
// v2.6: reviewer (succeeds Strategic Reviewer)
// ---------------------------------------------------------------------------

export interface ReviewerComposeArgs {
  iter: number;
  /** Host-or-container abs path of iteration_{iter}/. Composer normalizes
   *  via pathToHost (idempotent). Reviewer reads task_evaluations/ + plan.md
   *  from here. */
  iterDir: string;
  /** Optional host-or-container abs path of prior iter's reviewer.md. */
  priorReviewerMdPath: string | null;
  /** Pre-formatted matrix summary string (plain text table the orchestrator
   *  built from the keypoint matrix). Reviewer reads this verbatim. */
  matrixSummary: string;
}

export function composeReviewerUserInput(args: ReviewerComposeArgs): string {
  const iterDirHost = h(args.iterDir);
  const priorBlock = args.priorReviewerMdPath
    ? `Prior reviewer verdict: ${h(args.priorReviewerMdPath)}\n`
    : "Prior reviewer verdict: (none — this is iter 1)\n";
  return `# Reviewer user message — iter ${args.iter}

Iteration dir: ${iterDirHost}
Read per-task evaluations from: ${iterDirHost}/task_evaluations/*.md
Plan this iter: ${iterDirHost}/plan.md
${priorBlock}
## Keypoint matrix

${args.matrixSummary}

Synthesize per-task evaluations + the matrix, decide CONVERGED /
NEED_MORE_WORK / FUNDAMENTAL_LIMIT_MODEL / FUNDAMENTAL_LIMIT_ARCHITECTURE.
Write \`${iterDirHost}/reviewer.md\` with a single \`## Verdict\`
section containing exactly one of those four labels.
`;
}

// ---------------------------------------------------------------------------
// v2.6: task-evaluator
// ---------------------------------------------------------------------------

export interface TaskEvaluatorComposeArgs {
  iter: number;
  task: { task_id: string; task_name: string };
  /** Host-or-container abs path holding trial traces for this task.
   *  Composer normalizes via pathToHost (idempotent). */
  tracesPath: string;
  /** Host-or-container abs path where the evaluator should write its md. */
  outputPath: string;
  /** Null for baseline (free choice of 4-7 keypoints); non-null for iter-N
   *  (locked list — evaluator MUST score against exactly these keypoints). */
  keypointsList: string[] | null;
}

export function composeTaskEvaluatorUserInput(args: TaskEvaluatorComposeArgs): string {
  const keypointsBlock = args.keypointsList
    ? `## Keypoints (locked from baseline)\n\nUse exactly these keypoints — do not add or drop:\n${args.keypointsList.map((k) => `- ${k}`).join("\n")}\n`
    : `## Keypoints\n\n(baseline call — pick 4-7 keypoints from the dimension library that are relevant to this task)\n`;
  return `# Task Evaluator user message — iter ${args.iter} — task ${args.task.task_id}

Task: ${args.task.task_name}

${keypointsBlock}

Trial traces for this task: ${h(args.tracesPath)}
Output path: ${h(args.outputPath)}

Read the trial traces, assess this task per your role prompt, write the
evaluation markdown to the output path. n_trials_per_task copies of traces
may be present — synthesize one evaluation across them.
`;
}

// ---------------------------------------------------------------------------
// Trial-result helpers
// ---------------------------------------------------------------------------

export function meanScore(trainResults: TrainResult[]): number {
  if (trainResults.length === 0) {
    return 0;
  }
  return trainResults.reduce((a, b) => a + b.score, 0) / trainResults.length;
}
