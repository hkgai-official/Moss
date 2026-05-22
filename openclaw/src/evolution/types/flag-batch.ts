// src/evolution/types/flag-batch.ts
//
// User-flag mechanism types (v2.6).
// FlagSnapshot = one flagged user-agent task cycle.
// FlagBatch = a current/archived batch of snapshots.

export interface UserPrompt {
  text: string;
  language?: string;
}

export interface ToolDispatchRecord {
  tool_name: string;
  method?: string;
  input: unknown;
  response_status: number;
  response_body: unknown;
}

export interface ToolDefinitionLite {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

export interface FlagSnapshot {
  flag_id: string;
  batch_id: string;
  flagged_at: number;
  flagged_by: string;
  user_prompt: UserPrompt;
  // structurally compatible with claw-eval TraceMessage[]
  agent_trace: Array<Record<string, unknown>>;
  /** Captured tool dispatches from the flagged session — optional in v2.6
   *  since UserMode trial uses the candidate image's own sandboxed tools.
   *  Reserved for v2.7+ replay-substrate work. */
  tool_dispatches?: ToolDispatchRecord[];
  /** Tool registry the agent had access to at flag time — optional in v2.6
   *  for the same reason. */
  agent_tool_registry_at_flag_time?: ToolDefinitionLite[];
  optional_reason?: string;
  source_session_id: string;
  source_turn_range: [number, number];
  /** 0-based rank among user-role messages in the source session.
   *  Optional for backward compatibility with v2.6 flags written before this
   *  field was added. Used by the chat-tab UI to bind flag-pool entries back
   *  to specific user-message bubbles. */
  source_user_message_index?: number;
}

export interface FlagBatch {
  batch_id: string;
  created_at: number;
  status: "current" | "archived";
  threshold: number;
  trigger_mode: "auto" | "manual";
  triggered_at: number | null;
  triggered_evolution_trigger_id: string | null;
  flag_count: number;
  // v2.6 UI extensions
  origin: "user" | "demo";
  user_label: string | null;
  depth: "shallow" | "standard" | "deep";
  created_by: "ui" | "cli" | "auto";
  apply_state:
    | "pending_evolution"
    | "running"
    | "ready_to_apply"
    | "applied"
    | "discarded"
    | "failed";
}
