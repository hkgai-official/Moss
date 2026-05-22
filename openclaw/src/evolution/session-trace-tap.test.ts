// src/evolution/session-trace-tap.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionTraceTap } from "./session-trace-tap.js";

describe("SessionTraceTap", () => {
  it("renames file once session_id seen", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "tap-"));
    const tap = new SessionTraceTap(td, 3, "locator");
    tap.recordEvent({ type: "system", session_id: "abc-xyz" });
    tap.recordEvent({ type: "assistant", text: "hi" });
    const final = tap.close();
    expect(final).toContain("iter3_locator_abc-xyz.jsonl");
    expect(fs.existsSync(final)).toBe(true);
    const lines = fs.readFileSync(final, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("keeps placeholder name when no session_id ever arrives", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "tap-"));
    const tap = new SessionTraceTap(td, 1, "planner");
    tap.recordEvent({ type: "assistant", text: "no sid here" });
    const final = tap.close();
    expect(final).toContain("iter1_planner_pending.jsonl");
    expect(fs.existsSync(final)).toBe(true);
  });

  it("close is idempotent", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "tap-"));
    const tap = new SessionTraceTap(td, 1, "x");
    tap.recordEvent({ type: "system", session_id: "abc" });
    const p1 = tap.close();
    const p2 = tap.close();
    expect(p1).toBe(p2);
  });

  it("creates traces dir if missing", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "tap-"));
    const traces = path.join(td, "x", "y", "traces");
    const tap = new SessionTraceTap(traces, 1, "z");
    tap.recordEvent({ type: "system", session_id: "s" });
    tap.close();
    expect(fs.existsSync(traces)).toBe(true);
  });
});
