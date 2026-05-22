// src/evolution/extract-md.ts
//
// Recover a role's final markdown output from its session-trace jsonl. All 6
// stages call this after spawn-agent (Claude or Codex) exits + tap closes.
//
// Provider-shape-aware extraction:
//   - Claude stream-json: { type: "assistant", message: { role: "assistant",
//                          content: [{type:"text", text:"..."}] } }
//   - Codex JSONL:        { type: "item.completed",
//                          item: { type: "agent_message", text: "..." } }
// In both cases we walk the trace and keep the LAST text we saw.
import * as fs from "node:fs";
import * as path from "node:path";

interface AssistantContent {
  type: string;
  text?: string;
}

interface AssistantMsgShape {
  role?: string;
  content?: AssistantContent[];
}

interface CodexItemShape {
  id?: string;
  type?: string;
  text?: string;
}

interface TraceEvent {
  type?: string;
  message?: AssistantMsgShape;
  // Some stream-json shapes embed the message at top level
  role?: string;
  content?: AssistantContent[];
  // Codex item.completed shape: { type: "item.completed", item: { type: "agent_message", text: "..." } }
  item?: CodexItemShape;
  // Host daemon wraps each stream-json event as {event: <runner-event>} —
  // see ops/spawn_agent.handle response shape. The top-level recordEvent in
  // session-trace-tap stores `m.event` (which is the daemon's `data`)
  // verbatim, so trace lines are `{"event": {type:"assistant", ...}}` (Claude)
  // or `{"event": {type:"item.completed", item:{...}}}` (Codex).
  event?: TraceEvent;
}

/** Parse one jsonl trace, return the *last* agent text content (text-blocks
 *  joined with double newline). Recognizes both Claude and Codex shapes.
 *  Returns "" if no agent text found or path does not exist. */
export function extractFinalAssistantMd(tracePath: string): string {
  if (!fs.existsSync(tracePath)) {
    return "";
  }
  const raw = fs.readFileSync(tracePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let lastText = "";
  for (const ln of lines) {
    let parsed: TraceEvent;
    try {
      parsed = JSON.parse(ln) as TraceEvent;
    } catch {
      continue;
    }

    // Host daemon wraps each stream-json event as {event: ...}; unwrap up to
    // 2 levels in case future intermediate code adds another layer.
    let evt: TraceEvent = parsed;
    if (evt.event) {
      evt = evt.event;
    }
    if (evt.event) {
      evt = evt.event;
    }

    // --- Claude branch ---
    // The "assistant marker" can be either evt.type=="assistant" (claude
    // stream-json shape) or msg.role=="assistant" (legacy / unwrapped).
    const msg: AssistantMsgShape | undefined = evt.message ?? evt;
    const isAssistant = evt.type === "assistant" || msg?.role === "assistant";
    if (isAssistant && Array.isArray(msg?.content)) {
      const texts = msg.content
        .filter(
          (c): c is AssistantContent & { text: string } =>
            c.type === "text" && typeof c.text === "string",
        )
        .map((c) => c.text);
      if (texts.length > 0) {
        const joined = texts.join("\n\n");
        if (joined.trim()) {
          lastText = joined;
        }
      }
      continue;
    }

    // --- Codex branch ---
    // {type:"item.completed", item:{type:"agent_message", text:"..."}}
    if (evt.type === "item.completed" && evt.item) {
      const item = evt.item;
      if (
        item.type === "agent_message" &&
        typeof item.text === "string" &&
        item.text.trim()
      ) {
        lastText = item.text;
      }
    }
  }
  return lastText;
}

/** Write a role's md to disk creating parent dirs. */
export function writeRoleMd(mdPath: string, content: string): void {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, content);
}
