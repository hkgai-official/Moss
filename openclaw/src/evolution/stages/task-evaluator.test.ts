// src/evolution/stages/task-evaluator.test.ts
import { describe, expect, it } from "vitest";
import { runTaskEvaluatorStage, type TaskEvaluatorStageInput } from "./task-evaluator.js";

describe("task-evaluator stage", () => {
  it("is a function with the right shape", () => {
    expect(typeof runTaskEvaluatorStage).toBe("function");
    // Shape-check input type compiles
    const _stub: TaskEvaluatorStageInput = {
      iter: 1,
      iterDir: "/tmp/iter",
      tracesDir: "/tmp/traces",
      taskId: "T001",
      systemPrompt: "x",
      userInput: "y",
      addContainerDirs: [],
      cwdContainer: "/app",
      timeoutS: 1500,
      evolutionLog: { append: () => {} } as never,
    };
    expect(_stub.taskId).toBe("T001");
  });
});
