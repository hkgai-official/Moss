// src/evolution/types/task-definition.ts
//
// Shared TaskDefinition. UserMode derives this from FlagSnapshot (most fields
// empty since user mode relies on the candidate image's own sandboxed tools).

import type { ToolDefinitionLite, UserPrompt } from "./flag-batch.js";

export interface ServiceConfig {
  name: string;
  command: string;
  port: number;
  health_check?: string;
}

export interface ToolEndpoint {
  tool_name: string;
  url: string;
  method: string;
}

export interface TaskDefinition {
  task_id: string;
  task_name: string;
  prompt: UserPrompt;
  tools: ToolDefinitionLite[];
  tool_endpoints: ToolEndpoint[];
  services: ServiceConfig[];
  timeout_seconds: number;
  // unused in v2.6 (task-evaluator replaces numeric scoring)
  scoring_components: unknown[];
  reference_solution: string | null;
}
