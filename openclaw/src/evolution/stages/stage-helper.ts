// src/evolution/stages/stage-helper.ts
//
// Shared boilerplate for any stage that spawns one Claude role: open trace
// tap → stream events → record evolution-log → on close, extract last
// assistant text and persist as `<role>.md`. All 6 stages share this helper.
import * as fs from "node:fs";
import * as path from "node:path";
import { estimateUsageCost, resolveCostForActiveModel } from "../../utils/usage-format.js";
import { EvolutionLog } from "../evolution-log.js";
import { extractFinalAssistantMd, writeRoleMd } from "../extract-md.js";
import { pathToHost } from "../path-mapping.js";
import { SessionTraceTap } from "../session-trace-tap.js";
import {
  type AgentProvider,
  type AgentRole,
  type AgentTokens,
  spawnAgentStream,
} from "../spawn-agent.js";

/** Alias retained so existing imports of ClaudeRole keep working. */
export type ClaudeRole = AgentRole;

export interface RunRoleStageOpts {
  iter: number;
  iterDir: string; // container abs path
  tracesDir: string; // container abs path
  role: AgentRole;
  /** stage label for evolution-log (may be a sub-stage like `plan-loop`). */
  stage: string;
  /** Filename inside iterDir to write the final markdown to (e.g. "diagnosis.md"). */
  mdFilename: string;
  systemPrompt: string;
  userInput: string;
  /** Container-abs paths the spawned Claude can read. Will be path-mapped. */
  addContainerDirs: string[];
  cwdContainer: string;
  timeoutS: number;
  resumeSessionId?: string | null;
  evolutionLog: EvolutionLog;
  round?: number | null;
  /** v2.6 polish: when set, included in stage_start and stage_end event
   *  data. Used by the UI events panel to label task-evaluator entries by
   *  which task is being evaluated. */
  taskId?: string;
}

export interface RunRoleStageResult {
  mdPath: string; // container abs
  sessionId: string;
  exitCode: number;
  costUsd: number;
  elapsedS: number;
  tracePath: string;
}

export async function runRoleStage(opts: RunRoleStageOpts): Promise<RunRoleStageResult> {
  const { evolutionLog, role, iter, stage } = opts;

  evolutionLog.append({
    iter,
    round: opts.round ?? null,
    stage,
    event: "stage_start",
    role,
    data: {
      resume: opts.resumeSessionId ?? null,
      ...(opts.taskId ? { task_id: opts.taskId } : {}),
    },
  });

  const tap = new SessionTraceTap(opts.tracesDir, iter, role);

  const addDirsHost = opts.addContainerDirs.map((p) => pathToHost(p));
  const cwdHost = pathToHost(opts.cwdContainer);
  const outputLogDirHost = pathToHost(opts.iterDir);

  evolutionLog.append({
    iter,
    round: opts.round ?? null,
    stage,
    event: "role_spawned",
    role,
    data: { addDirs: addDirsHost, cwd: cwdHost },
  });

  let sessionId = "";
  let exitCode = -1;
  let costUsd = 0;
  let elapsedS = 0;
  // Initialize defensively so an early error (no result event) still produces
  // a well-formed evolution-log entry. provider defaults to "claude" because
  // that's the historic-default runner; the actual provider arrives in the
  // result event when the spawn completes cleanly.
  let provider: AgentProvider = "claude";
  let model = "";
  let tokens: AgentTokens | null = null;

  try {
    for await (const m of spawnAgentStream({
      role,
      systemPrompt: opts.systemPrompt,
      userInput: opts.userInput,
      addDirs: addDirsHost,
      cwd: cwdHost,
      timeoutS: opts.timeoutS,
      resumeSessionId: opts.resumeSessionId ?? null,
      outputLogDir: outputLogDirHost,
    })) {
      if (m.kind === "event") {
        tap.recordEvent(m.event);
        // Cheap metadata-only log entry (don't echo full content)
        const evtType = typeof m.event["type"] === "string" ? m.event["type"] : "unknown";
        evolutionLog.append({
          iter,
          round: opts.round ?? null,
          stage,
          event: "role_event",
          role,
          data: { evtType },
        });
      } else if (m.kind === "result") {
        sessionId = m.result.sessionId;
        exitCode = m.result.exitCode;
        costUsd = m.result.costUsd;
        elapsedS = m.result.elapsedS;
        tokens = m.result.tokens;
        provider = m.result.provider;
        model = m.result.model;
      }
    }
  } finally {
    tap.close();
  }

  // USD fallback (spec §6.2): if the runner didn't report cost natively
  // (Codex case — turn.completed.usage has tokens only), derive USD from
  // tokens using the per-(provider, model) cost config in openclaw.json.
  // No-op when cost is already > 0 (Claude case), when tokens absent, or
  // when no matching cost config exists (cost stays 0 → UI shows tokens).
  if (costUsd <= 0 && tokens && model) {
    const costCfg = resolveCostForActiveModel(provider, model);
    const derived = estimateUsageCost({
      usage: {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
      },
      cost: costCfg,
    });
    if (typeof derived === "number" && derived > 0) {
      costUsd = derived;
    }
  }

  const tracePath = tap.getCurrentPath();
  const mdContent = extractFinalAssistantMd(tracePath);
  const mdPath = path.join(opts.iterDir, opts.mdFilename);
  // Several role prompts (locator, planner, implementer) instruct the LLM to
  // write its rich output directly to <role>.md via the Write tool. In that
  // case the file already exists with the full content; the trace's
  // last-assistant-text is just a summary chat reply that would clobber it
  // with much less information. Always preserve a separate summary copy
  // (<role>.summary.md) for diff-friendly review, and only write the main
  // mdPath when the role didn't already populate it.
  let preExistingSize = 0;
  try {
    preExistingSize = fs.statSync(mdPath).size;
  } catch {
    preExistingSize = 0;
  }
  if (mdContent) {
    const summaryPath = mdPath.replace(/\.md$/i, ".summary.md");
    writeRoleMd(summaryPath, mdContent);
  }
  if (preExistingSize < 256) {
    // role didn't write its own md — fall back to the assistant's chat text.
    writeRoleMd(mdPath, mdContent);
  }

  evolutionLog.append({
    iter,
    round: opts.round ?? null,
    stage,
    event: "role_finished",
    role,
    sessionId,
    data: { mdPath, exitCode, costUsd, elapsedS, provider, model },
  });
  evolutionLog.append({
    iter,
    round: opts.round ?? null,
    stage,
    event: "stage_end",
    role,
    data: {
      elapsed_s: elapsedS,
      ...(opts.taskId ? { task_id: opts.taskId } : {}),
    },
  });

  return { mdPath, sessionId, exitCode, costUsd, elapsedS, tracePath };
}
