// src/evolution/types/flag-batch.test.ts
import { describe, expect, it } from "vitest";
import { readFlagBatchWithDefaults } from "../state.js";
import type { FlagBatch, FlagSnapshot } from "./flag-batch.js";

describe("flag-batch types", () => {
  it("FlagSnapshot accepts well-formed snapshot", () => {
    const snap: FlagSnapshot = {
      flag_id: "abc-123",
      batch_id: "batch-1",
      flagged_at: 1234567890,
      flagged_by: "test-user",
      user_prompt: { text: "do thing", language: "en" },
      agent_trace: [],
      tool_dispatches: [],
      agent_tool_registry_at_flag_time: [],
      source_session_id: "sess-1",
      source_turn_range: [0, 5],
    };
    expect(snap.flag_id).toBe("abc-123");
  });

  it("FlagBatch metadata structure", () => {
    const batch: FlagBatch = {
      batch_id: "batch-1",
      created_at: 1234567890,
      status: "current",
      threshold: 5,
      trigger_mode: "manual",
      triggered_at: null,
      triggered_evolution_trigger_id: null,
      flag_count: 0,
      origin: "user",
      user_label: null,
      depth: "standard",
      created_by: "cli",
      apply_state: "pending_evolution",
    };
    expect(batch.status).toBe("current");
  });
});

describe("FlagBatch v2.6 UI extensions", () => {
  it("legacy v6 _batch.json (5 new fields absent) reads with defaults", () => {
    const raw = {
      batch_id: "batch_demo_compliance_001",
      created_at: 0,
      status: "current",
      threshold: 4,
      trigger_mode: "manual",
      triggered_at: null,
      triggered_evolution_trigger_id: null,
      flag_count: 4,
    };
    const fb = readFlagBatchWithDefaults(raw);
    expect(fb.origin).toBe("demo"); // batch_demo_* prefix
    expect(fb.user_label).toBeNull();
    expect(fb.depth).toBe("standard");
    expect(fb.created_by).toBe("cli");
    expect(fb.apply_state).toBe("pending_evolution");
  });

  it("batch_user_* prefix defaults origin=user", () => {
    const raw = {
      batch_id: "batch_user_20260512_140101",
      created_at: 0,
      status: "current",
      threshold: 4,
      trigger_mode: "manual",
      triggered_at: null,
      triggered_evolution_trigger_id: null,
      flag_count: 0,
    } as any;
    expect(readFlagBatchWithDefaults(raw).origin).toBe("user");
  });

  it("full v6.UI fields round-trip unchanged", () => {
    const fb: FlagBatch = {
      batch_id: "batch_user_x",
      created_at: 1,
      status: "current",
      threshold: 4,
      trigger_mode: "manual",
      triggered_at: null,
      triggered_evolution_trigger_id: null,
      flag_count: 0,
      origin: "user",
      user_label: "return",
      depth: "deep",
      created_by: "ui",
      apply_state: "ready_to_apply",
    };
    expect(readFlagBatchWithDefaults(fb)).toEqual(fb);
  });

  it("archived status defaults apply_state to applied", () => {
    const raw = {
      batch_id: "batch_user_x",
      created_at: 0,
      status: "archived",
      threshold: 4,
      trigger_mode: "manual",
      triggered_at: null,
      triggered_evolution_trigger_id: null,
      flag_count: 0,
    };
    expect(readFlagBatchWithDefaults(raw).apply_state).toBe("applied");
  });

  it("throws on non-object input", () => {
    expect(() => readFlagBatchWithDefaults(null)).toThrow();
    expect(() => readFlagBatchWithDefaults("oops")).toThrow();
  });
});
