// src/evolution/extract-md.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extractFinalAssistantMd, writeRoleMd } from "./extract-md.js";

describe("extractFinalAssistantMd", () => {
  it("returns empty string for missing path", () => {
    expect(extractFinalAssistantMd("/no/such/path.jsonl")).toBe("");
  });

  it("extracts Codex agent_message shape (item.completed)", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-codex-"));
    const p = path.join(td, "trace.jsonl");
    const events = [
      { event: { type: "thread.started", thread_id: "uuid-abc" } },
      {
        event: {
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "codex reply" },
        },
      },
      { event: { type: "turn.completed", usage: { input_tokens: 100 } } },
    ];
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(extractFinalAssistantMd(p)).toBe("codex reply");
  });

  it("picks the LAST text from a mixed-shape trace", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-mix-"));
    const p = path.join(td, "trace.jsonl");
    const events = [
      {
        event: {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "first text (claude)" }] },
        },
      },
      {
        event: {
          type: "item.completed",
          item: { type: "agent_message", text: "second text (codex)" },
        },
      },
    ];
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(extractFinalAssistantMd(p)).toBe("second text (codex)");
  });

  it("ignores non-agent_message item.completed shapes", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-nonmsg-"));
    const p = path.join(td, "trace.jsonl");
    const events = [
      {
        event: {
          type: "item.completed",
          item: { id: "x", type: "command_execution", command: "ls", exit_code: 0 },
        },
      },
      {
        event: {
          type: "item.completed",
          item: { type: "agent_message", text: "ONLY ME" },
        },
      },
    ];
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(extractFinalAssistantMd(p)).toBe("ONLY ME");
  });

  it("extracts last assistant text across multiple events", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
    const p = path.join(td, "trace.jsonl");
    const events = [
      { type: "system", session_id: "x" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      },
      {
        type: "tool_use",
        message: { role: "assistant", content: [{ type: "tool_use", id: "1" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "FINAL" }] },
      },
      { type: "result", session_id: "x" },
    ];
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(extractFinalAssistantMd(p)).toBe("FINAL");
  });

  it("joins multiple text content blocks with double newline", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
    const p = path.join(td, "trace.jsonl");
    const events = [
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "para1" },
            { type: "text", text: "para2" },
          ],
        },
      },
    ];
    fs.writeFileSync(p, JSON.stringify(events[0]) + "\n");
    expect(extractFinalAssistantMd(p)).toBe("para1\n\npara2");
  });

  it("ignores broken json lines", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
    const p = path.join(td, "trace.jsonl");
    fs.writeFileSync(
      p,
      [
        "not json {",
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n") + "\n",
    );
    expect(extractFinalAssistantMd(p)).toBe("hello");
  });

  it("supports top-level role+content shape (no `message` envelope)", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
    const p = path.join(td, "trace.jsonl");
    fs.writeFileSync(
      p,
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "flat" }] }) + "\n",
    );
    expect(extractFinalAssistantMd(p)).toBe("flat");
  });
});

describe("writeRoleMd", () => {
  it("creates parent dirs and writes the md", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
    const target = path.join(td, "iteration_3", "diagnosis.md");
    writeRoleMd(target, "# diag\n\nbody");
    expect(fs.readFileSync(target, "utf8")).toBe("# diag\n\nbody");
  });
});
