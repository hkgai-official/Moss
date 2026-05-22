// src/evolution/modes/user-mode.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlagSnapshot } from "../types/flag-batch.js";
import { UserMode } from "./user-mode.js";

function makeSnapshot(overrides: Partial<FlagSnapshot> = {}): FlagSnapshot {
  return {
    flag_id: "flag-001",
    batch_id: "batch-1",
    flagged_at: 1700000000000,
    flagged_by: "tester",
    user_prompt: { text: "list emails from today", language: "en" },
    agent_trace: [],
    tool_dispatches: [],
    agent_tool_registry_at_flag_time: [],
    source_session_id: "sess-001",
    source_turn_range: [0, 4],
    ...overrides,
  };
}

describe("UserMode", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let dataDir: string;

  beforeEach(() => {
    savedEnv.MOSS_DATA_DIR = process.env.MOSS_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "user-mode-test-"));
    process.env.MOSS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (savedEnv.MOSS_DATA_DIR === undefined) {
      delete process.env.MOSS_DATA_DIR;
    } else {
      process.env.MOSS_DATA_DIR = savedEnv.MOSS_DATA_DIR;
    }
  });

  it("kind === user", () => {
    expect(new UserMode("batch-1").kind).toBe("user");
  });

  it("getBaselineTaskDefinitions reads each flag snapshot in the batch dir", async () => {
    const batchDir = join(dataDir, "evo-loop-state/flag-batch/batch-1");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "_batch.json"), JSON.stringify({ batch_id: "batch-1" }));
    writeFileSync(join(batchDir, "flag-001.json"), JSON.stringify(makeSnapshot()));
    writeFileSync(
      join(batchDir, "flag-002.json"),
      JSON.stringify(makeSnapshot({ flag_id: "flag-002" })),
    );

    const mode = new UserMode("batch-1");
    const tasks = await mode.getBaselineTaskDefinitions();
    expect(tasks.map((t) => t.task_id).sort()).toEqual(["flag-001", "flag-002"]);
  });

  it("task_name is prompt-derived (first 80 chars)", async () => {
    const batchDir = join(dataDir, "evo-loop-state/flag-batch/batch-1");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "flag-001.json"), JSON.stringify(makeSnapshot()));
    const mode = new UserMode("batch-1");
    const tasks = await mode.getBaselineTaskDefinitions();
    expect(tasks[0].task_name).toBe("list emails from today");
  });

  it("v2.6 simplification: tool_endpoints / tools / services are empty (candidate image carries tools)", async () => {
    const batchDir = join(dataDir, "evo-loop-state/flag-batch/batch-1");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "flag-001.json"), JSON.stringify(makeSnapshot()));
    const mode = new UserMode("batch-1");
    const tasks = await mode.getBaselineTaskDefinitions();
    // No tool / endpoint synthesis — sandboxed candidate image owns tools.
    expect(tasks[0].tool_endpoints).toEqual([]);
    expect(tasks[0].tools).toEqual([]);
    expect(tasks[0].services).toEqual([]);
  });

  it("loadBaselineTrace returns the snapshot's agent_trace + tool_dispatches", async () => {
    const batchDir = join(dataDir, "evo-loop-state/flag-batch/batch-1");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "flag-001.json"), JSON.stringify(makeSnapshot()));
    const mode = new UserMode("batch-1");
    const tasks = await mode.getBaselineTaskDefinitions();
    const trace = (await mode.loadBaselineTrace(tasks[0])) as {
      agent_trace: unknown[];
      tool_dispatches: unknown[];
    };
    // tool_dispatches is preserved in the FlagSnapshot for future debugging
    // / replay-miss work (v2.7) but not consumed by user-mode trial.
    expect(Array.isArray(trace.tool_dispatches)).toBe(true);
  });

  it("getLocatorExtraContext returns non-null flagBatchId + flagBatchDir", async () => {
    const mode = new UserMode("batch-1");
    const ctx = await mode.getLocatorExtraContext();
    expect(ctx.flagBatchId).toBe("batch-1");
    expect(ctx.flagBatchDir).toContain("flag-batch/batch-1");
  });

  it("throws when MOSS_DATA_DIR missing", async () => {
    delete process.env.MOSS_DATA_DIR;
    const mode = new UserMode("batch-1");
    await expect(mode.getBaselineTaskDefinitions()).rejects.toThrow(/MOSS_DATA_DIR/);
  });

  it("prepareBaselineTracesForTask writes the snapshot's agent_trace as a JSONL", async () => {
    const batchDir = join(dataDir, "evo-loop-state/flag-batch/batch-1");
    mkdirSync(batchDir, { recursive: true });
    const snap = makeSnapshot({
      agent_trace: [
        { role: "user", content: [{ type: "text", text: "ping" }] },
        { role: "assistant", content: [{ type: "text", text: "pong" }] },
      ] as unknown as FlagSnapshot["agent_trace"],
    });
    writeFileSync(join(batchDir, "flag-001.json"), JSON.stringify(snap));

    const baselineDir = mkdtempSync(join(tmpdir(), "user-mode-baseline-"));
    const mode = new UserMode("batch-1");
    const tasks = await mode.getBaselineTaskDefinitions();
    const tracesDir = await mode.prepareBaselineTracesForTask(tasks[0], baselineDir);

    expect(tracesDir).toBe(join(baselineDir, "traces", "flag-001"));
    const transcript = join(tracesDir, "trial_0_transcript.jsonl");
    const fs = await import("node:fs");
    expect(fs.existsSync(transcript)).toBe(true);
    const lines = fs.readFileSync(transcript, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("message");
    expect(parsed.message.role).toBe("user");
  });

  it("prepareBaselineTracesForTask handles missing snapshot with empty file", async () => {
    const batchDir = join(dataDir, "evo-loop-state/flag-batch/batch-1");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "flag-001.json"), JSON.stringify(makeSnapshot()));
    const baselineDir = mkdtempSync(join(tmpdir(), "user-mode-baseline-"));
    const mode = new UserMode("batch-1");
    // Construct a task that doesn't have a snapshot file (task_id mismatch)
    const fakeTask = {
      task_id: "ghost-flag",
      task_name: "ghost",
      prompt: { text: "", language: "en" },
      tools: [],
      tool_endpoints: [],
      services: [],
      timeout_seconds: 600,
      scoring_components: [],
      reference_solution: null,
    };
    const tracesDir = await mode.prepareBaselineTracesForTask(fakeTask, baselineDir);
    const fs = await import("node:fs");
    const transcript = join(tracesDir, "trial_0_transcript.jsonl");
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.readFileSync(transcript, "utf8")).toBe("");
  });
});
