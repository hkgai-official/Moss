// src/evolution/spawn-agent.ts
//
// Typed wrapper around the host-daemon `spawn-agent` op. Maps the wire-level
// snake_case payload to camelCase TypeScript and yields stream events plus a
// final structured result that carries provider + model + tokens so
// downstream (stage-helper) can derive USD when the runner doesn't.
//
// See evoclaw/docs/specs/2026-05-17-multi-coding-agent-design.md §6.1.
import { rpcStream } from "./rpc-client.js";

// Narrow `unknown` (from Record<string, unknown>) to a string. The wire format
// only ever sends primitives at these slots, but we still avoid String(x)
// because that risks "[object Object]" on accidental shape drift and trips
// typescript-eslint(no-base-to-string).
function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  return fallback;
}

export type AgentRole =
  | "locator"
  | "planner"
  | "plan_reviewer"
  | "implementer"
  | "code_reviewer"
  | "strategic_reviewer"
  | "reviewer"
  | "task_evaluator";

/** Alias retained for one transitional release so any external importer of
 *  the old name keeps compiling. Prefer AgentRole in new code. */
export type ClaudeRole = AgentRole;

export type AgentProvider = "claude" | "codex";

export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface SpawnAgentRequest {
  role: AgentRole;
  systemPrompt: string;
  userInput: string;
  addDirs: string[]; // host abs paths
  cwd: string; // host abs path
  timeoutS: number;
  resumeSessionId?: string | null;
  outputLogDir: string; // host abs path
  /** Per-spawn provider override. If unset, daemon picks per MOSS_AGENT_PROVIDER. */
  agentOverride?: AgentProvider | null;
}

export interface SpawnAgentResult {
  exitCode: number;
  elapsedS: number;
  sessionId: string;
  /** USD cost. Native (Claude) OR derived (Codex via stage-helper fallback).
   *  Stays 0 when neither path supplies a value. */
  costUsd: number;
  /** Token usage breakdown. null when the runner didn't report tokens
   *  (e.g., old Claude CLI without usage block). */
  tokens: AgentTokens | null;
  /** Which runner actually executed. */
  provider: AgentProvider;
  /** Model name the runner used (e.g. "sonnet", "gpt-5.4"). Empty when unknown. */
  model: string;
}

export type SpawnAgentStreamItem =
  | { kind: "event"; event: Record<string, unknown> }
  | { kind: "result"; result: SpawnAgentResult };

/** Type aliases retained for one transitional release. */
export type SpawnClaudeRequest = SpawnAgentRequest;
export type SpawnClaudeResult = SpawnAgentResult;
export type SpawnClaudeStreamItem = SpawnAgentStreamItem;

function parseTokens(raw: unknown): AgentTokens | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const t = raw as Record<string, unknown>;
  return {
    input: Number(t.input ?? 0),
    output: Number(t.output ?? 0),
    cacheRead: Number(t.cache_read ?? 0),
    cacheWrite: Number(t.cache_write ?? 0),
    reasoning: Number(t.reasoning ?? 0),
  };
}

export async function* spawnAgentStream(
  req: SpawnAgentRequest,
): AsyncGenerator<SpawnAgentStreamItem> {
  const payload: Record<string, unknown> = {
    role: req.role,
    system_prompt: req.systemPrompt,
    user_input: req.userInput,
    add_dirs: req.addDirs,
    cwd: req.cwd,
    timeout_s: req.timeoutS,
    resume_session_id: req.resumeSessionId ?? null,
    output_log_dir: req.outputLogDir,
    agent_override: req.agentOverride ?? null,
  };
  for await (const msg of rpcStream("spawn-agent", payload)) {
    if (msg.type === "event") {
      yield { kind: "event", event: msg.data };
    } else if (msg.type === "result") {
      const providerRaw = asString(msg.data.provider, "claude");
      const provider: AgentProvider =
        providerRaw === "codex" ? "codex" : "claude";
      yield {
        kind: "result",
        result: {
          exitCode: Number(msg.data.exit_code ?? -1),
          elapsedS: Number(msg.data.elapsed_s ?? 0),
          sessionId: asString(msg.data.session_id),
          costUsd: Number(msg.data.cost_usd ?? 0),
          tokens: parseTokens(msg.data.tokens),
          provider,
          model: asString(msg.data.model),
        },
      };
      return;
    } else {
      throw new Error(`spawn-agent failed: ${msg.data.message}`);
    }
  }
  throw new Error("spawn-agent stream ended without result");
}

/** Backward-compatible name. New code should call spawnAgentStream directly. */
export const spawnClaudeStream = spawnAgentStream;
