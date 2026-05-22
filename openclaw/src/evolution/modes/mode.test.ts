// src/evolution/modes/mode.test.ts
import { describe, expect, it } from "vitest";
import type { TaskDefinition } from "../types/task-definition.js";
import type {
  BatchTrialArgs,
  BatchTrialResult,
  EvolutionMode,
  LocatorExtraContext,
  TrialArgs,
} from "./mode.js";

class MockMode implements EvolutionMode {
  readonly kind = "user" as const;
  async getBaselineTaskDefinitions(): Promise<TaskDefinition[]> {
    return [];
  }
  async loadBaselineTrace(): Promise<unknown> {
    return {};
  }
  async runIterTrial(_args: TrialArgs): Promise<unknown> {
    return {};
  }
  async runBatchTrial(_args: BatchTrialArgs): Promise<BatchTrialResult> {
    return { tasks: [] };
  }
  async prepareBaselineTracesForTask(_task: TaskDefinition, _baselineDir: string): Promise<string> {
    return "/mock";
  }
  async getLocatorExtraContext(): Promise<LocatorExtraContext> {
    return { flagBatchId: null, flagBatchDir: null };
  }
}

describe("EvolutionMode interface", () => {
  it("mock impl satisfies interface", async () => {
    const m: EvolutionMode = new MockMode();
    expect(m.kind).toBe("user");
    expect(await m.getBaselineTaskDefinitions()).toEqual([]);
    const ctx = await m.getLocatorExtraContext();
    expect(ctx.flagBatchId).toBeNull();
    expect(ctx.flagBatchDir).toBeNull();
  });
});
