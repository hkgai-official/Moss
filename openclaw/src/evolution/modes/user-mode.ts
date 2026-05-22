// src/evolution/modes/user-mode.ts
//
// v2.6 user evolution mode: reads flag-batch on disk and derives a
// TaskDefinition per flag snapshot. Trial substrate is the auto_replay
// server (Task 6.3/6.5) — toolEndpoints get rewritten to point at it, and
// the per-task mock_replay_table holds the responses captured at flag time.

import * as fs from "node:fs";
import * as path from "node:path";
import { runUserModeBatchTrial } from "../docker-rpc.js";
import type { FlagSnapshot } from "../types/flag-batch.js";
import type { TaskDefinition } from "../types/task-definition.js";
import type {
  BatchTrialArgs,
  BatchTrialResult,
  EvolutionMode,
  LocatorExtraContext,
  TrialArgs,
} from "./mode.js";

export class UserMode implements EvolutionMode {
  readonly kind = "user" as const;

  constructor(private readonly batchId: string) {}

  private batchDir(): string {
    // Inside moss-gateway container: data dir is mounted at /home/node/.openclaw
    // (see docker-compose.yml). When run outside container (tests / scripts),
    // fall back to MOSS_DATA_DIR.
    const inContainer = fs.existsSync("/home/node/.openclaw");
    const dataDir = inContainer ? "/home/node/.openclaw" : process.env.MOSS_DATA_DIR;
    if (!dataDir) {
      throw new Error("UserMode: MOSS_DATA_DIR not set");
    }
    return path.join(dataDir, "evo-loop-state/flag-batch", this.batchId);
  }

  async getBaselineTaskDefinitions(): Promise<TaskDefinition[]> {
    const dir = this.batchDir();
    if (!fs.existsSync(dir)) {
      throw new Error(`UserMode: flag batch dir does not exist: ${dir}`);
    }
    // Each task = one flag snapshot file. _batch.json is metadata, not a task.
    const flagFiles = fs
      .readdirSync(dir)
      .filter((f) => f !== "_batch.json" && f.endsWith(".json"))
      .sort();
    return flagFiles.map((f) => {
      const snap: FlagSnapshot = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return {
        task_id: snap.flag_id,
        task_name: snap.user_prompt.text.slice(0, 80) || snap.flag_id,
        prompt: snap.user_prompt,
        // User mode trial uses the candidate image's own tools (sandboxed).
        // Fields below are populated empty to keep the TaskDefinition shape
        // compatible with demo mode without injecting v2.6-specific extras.
        tools: [],
        tool_endpoints: [],
        services: [],
        timeout_seconds: 600,
        scoring_components: [],
        reference_solution: null,
      };
    });
  }

  async loadBaselineTrace(task: TaskDefinition): Promise<unknown> {
    const snapPath = path.join(this.batchDir(), `${task.task_id}.json`);
    if (!fs.existsSync(snapPath)) {
      return { agent_trace: [], tool_dispatches: [] };
    }
    const snap: FlagSnapshot = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    return {
      task_id: snap.flag_id,
      agent_trace: snap.agent_trace,
      tool_dispatches: snap.tool_dispatches,
      source_session_id: snap.source_session_id,
    };
  }

  async runIterTrial(args: TrialArgs): Promise<unknown> {
    // Per-task entry point — UserMode wraps it as a batch of one to share
    // the same worker-pool code path. Most callers should use runBatchTrial.
    return this.runBatchTrial({
      iter: args.iter,
      tasks: [args.task],
      imageTag: args.imageTag,
      iterDir: args.iterDir,
      nTrials: 1,
    });
  }

  async runBatchTrial(args: BatchTrialArgs): Promise<BatchTrialResult> {
    // host-daemon expects host-abs paths; iteration.ts passes container-abs
    // iter_dir so we translate here. The candidate image carries whatever
    // tools the agent needs (sandboxed by v2.6 OSS assumption).
    const { pathToHost } = await import("../path-mapping.js");
    const r = await runUserModeBatchTrial({
      imageTag: args.imageTag,
      iterDir: pathToHost(args.iterDir),
      nTrials: args.nTrials,
      tasks: args.tasks.map((t) => ({
        taskId: t.task_id,
        userPrompt: t.prompt.text,
      })),
    });
    return {
      tasks: r.tasks,
      // No grade_summary in user mode — orchestrator uses task-evaluator
      // (Stage 7.5) for signal.
      gradeSummaryPath: undefined,
    };
  }

  async prepareBaselineTracesForTask(task: TaskDefinition, baselineDir: string): Promise<string> {
    // User mode: materialize the flag snapshot's captured agent_trace into
    // a transcript JSONL the task-evaluator can read. One file per task
    // under <baselineDir>/traces/<task_id>/trial_0_transcript.jsonl so the
    // tracesPath layout matches what Stage 7.5 produces (only the trial
    // number is "0" to mark baseline).
    const snapPath = path.join(this.batchDir(), `${task.task_id}.json`);
    const taskTracesDir = path.join(baselineDir, "traces", task.task_id);
    fs.mkdirSync(taskTracesDir, { recursive: true });
    const out = path.join(taskTracesDir, "trial_0_transcript.jsonl");

    if (!fs.existsSync(snapPath)) {
      // Empty stub — task-evaluator will fall back to choosing keypoints
      // from user_prompt + tools alone.
      fs.writeFileSync(out, "");
      return taskTracesDir;
    }
    const snap: FlagSnapshot = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    // Wrap each trace message as a {type:"message", message: ...} record
    // so the line format matches the openclaw session JSONL the agent
    // produces at trial time. task-evaluator reads either shape.
    const lines = (snap.agent_trace ?? []).map((msg) =>
      JSON.stringify({ type: "message", message: msg }),
    );
    fs.writeFileSync(out, lines.join("\n") + (lines.length ? "\n" : ""));
    return taskTracesDir;
  }

  async getLocatorExtraContext(): Promise<LocatorExtraContext> {
    return {
      flagBatchId: this.batchId,
      flagBatchDir: this.batchDir(),
    };
  }
}
