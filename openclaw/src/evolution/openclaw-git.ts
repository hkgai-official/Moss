// src/evolution/openclaw-git.ts
//
// Helpers that touch the openclaw inner-repo git state and the host-side
// grade-summary file produced by the trial RPC.
//
// Both helpers run from *inside* the moss-gateway container, but the inner
// openclaw repo (MOSS_OPENCLAW_REPO_DIR) is NOT bind-mounted into the
// container — only HOST_DATA_DIR and a read-only /app/src view are mounted
// (see docker-compose.yml). So:
//   - `commitOpenclawIteration` routes the `git` calls through the host
//     daemon (which runs on the host and can see the repo directly).
//   - `readTrainResults` translates the host-abs grade-summary path the
//     trial RPC returned back into its container-visible equivalent under
//     /home/node/.openclaw before doing `fs.readFileSync`.
//
// History (2026-05-11 bug report): earlier versions of these helpers ran
// `execFileSync("git", ["-C", hostPath, ...])` and `fs.existsSync(hostPath)`
// directly on host-absolute paths from inside the container; both failed
// silently with ENOENT, producing `verdict=implementer_failed` even when
// the Implementer agent had committed real changes via spawn-claude.
import * as fs from "node:fs";
import { commitOpenclawIter } from "./docker-rpc.js";
import { pathToContainer } from "./path-mapping.js";
import type { TrainResult } from "./state.js";

/** Stage + commit any tree mutations the Implementer agent left in the
 *  inner openclaw repo. Routed through the daemon — the inner repo is not
 *  visible from inside the container. Returns the post-commit HEAD sha, or
 *  `null` if the RPC failed for any reason (caller treats null as
 *  "implementer failed"). */
export async function commitOpenclawIteration(
  _repoHostDir: string,
  iter: number,
): Promise<string | null> {
  // _repoHostDir is unused — the daemon reads MOSS_OPENCLAW_REPO_DIR
  // from its own env. The parameter is kept for call-site compatibility;
  // daemon enforces the path.
  try {
    const r = await commitOpenclawIter({ iter });
    return r.commitHash || null;
  } catch {
    return null;
  }
}

/** Read the host-side grade_summary_stage_<stage>.json the trial RPC
 *  produced. The RPC returns a host-abs path; we translate it into the
 *  container-visible path under /home/node/.openclaw before reading.
 *
 *  File schema is a top-level JSON array (see host-daemon/.../trial_runner.py
 *  which does `json.dumps(grade_summary, indent=2)` with `grade_summary:
 *  list[dict]`). The pre-fix shape `{tasks: [...]}` never matched reality
 *  and silently produced an empty array.
 *
 *  On any failure (missing file, parse error, schema mismatch) returns
 *  zero-score placeholders so the verdict logic can distinguish "trial
 *  ran but every task scored zero" from "no trial rows at all" via
 *  `stageATrials.length`. */
export function readTrainResults(
  gradeSummaryPathHostAbs: string,
  stageATasks: Array<{ id: string; baseline_score: number }>,
): TrainResult[] {
  const zeroFallback = (): TrainResult[] =>
    stageATasks.map((t) => ({
      task: t.id,
      trial: 0,
      score: 0,
      baselineScore: t.baseline_score,
      judgePassed: false,
    }));

  if (!gradeSummaryPathHostAbs) {
    return zeroFallback();
  }
  // In production this code runs inside the moss-gateway container, where the
  // daemon-returned path is a host-abs path the container can't see — translate
  // it via pathToContainer to the matching /home/node/.openclaw/... view first.
  // In unit-test contexts (running directly on the host) the original path is
  // already readable, so we fall back to it when the translated path is
  // missing. Both branches share the same parse logic.
  const containerPath = pathToContainer(gradeSummaryPathHostAbs);
  let pathToRead: string | null = null;
  if (fs.existsSync(containerPath)) {
    pathToRead = containerPath;
  } else if (containerPath !== gradeSummaryPathHostAbs && fs.existsSync(gradeSummaryPathHostAbs)) {
    pathToRead = gradeSummaryPathHostAbs;
  }
  if (pathToRead === null) {
    return zeroFallback();
  }
  try {
    const raw = fs.readFileSync(pathToRead, "utf8");
    const parsed = JSON.parse(raw) as Array<{
      task?: string;
      trial?: number;
      score?: number;
      baseline_score?: number;
      judge_passed?: boolean;
    }>;
    if (!Array.isArray(parsed)) {
      return zeroFallback();
    }
    const baselineByTask = new Map(stageATasks.map((t) => [t.id, t.baseline_score]));
    return parsed
      .filter((r): r is { task: string } & typeof r => typeof r.task === "string")
      .map((r) => ({
        task: r.task,
        trial: r.trial ?? 0,
        score: r.score ?? 0,
        // Prefer the per-row baseline the daemon emitted; fall back to the
        // manifest task list if absent (legacy shape).
        baselineScore: r.baseline_score ?? baselineByTask.get(r.task) ?? 0,
        judgePassed: r.judge_passed ?? false,
      }));
  } catch {
    return zeroFallback();
  }
}
