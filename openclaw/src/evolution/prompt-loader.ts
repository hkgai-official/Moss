// src/evolution/prompt-loader.ts
//
// Read prompt template files from `src/evolution/prompts/` and substitute
// the `{placeholder}` slots. v2.4 prompts use Python-style str.format
// keys; we mimic that behavior with simple regex replace.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(HERE, "prompts");

export type PromptName =
  | "locator"
  | "planner"
  | "plan-reviewer"
  | "implementer"
  | "code-reviewer"
  | "strategic-reviewer"
  | "reviewer"
  | "task-evaluator";

export function loadPrompt(name: PromptName, vars: Record<string, string | number>): string {
  const p = path.join(PROMPTS_DIR, `${name}.md`);
  if (!fs.existsSync(p)) {
    throw new Error(`Prompt template not found: ${p}`);
  }
  let body = fs.readFileSync(p, "utf8");
  for (const [k, v] of Object.entries(vars)) {
    body = body.replaceAll(`{${k}}`, String(v));
  }
  return body;
}

export function promptsDir(): string {
  return PROMPTS_DIR;
}
