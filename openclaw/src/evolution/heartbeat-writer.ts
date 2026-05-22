// src/evolution/heartbeat-writer.ts
//
// Always-on 10s heartbeat writer. Writes `heartbeat.json` atomically (tmp file
// + rename) into evo-loop-state/. Host supervisor reads it during the post-
// swap probe window. Also written when no evolution loop is active so the
// supervisor can detect a stuck container.
import * as fs from "node:fs";
import * as path from "node:path";

export type HeartbeatState = Record<string, unknown>;

export type HeartbeatStateProvider = () => HeartbeatState;

export class HeartbeatWriter {
  private timer: NodeJS.Timeout | null = null;
  private readonly filePath: string;
  private readonly getState: HeartbeatStateProvider;

  constructor(filePath: string, getState: HeartbeatStateProvider) {
    this.filePath = filePath;
    this.getState = getState;
  }

  start(intervalMs = 10_000): void {
    if (this.timer) {
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Don't keep the event loop alive solely for the heartbeat
    this.timer.unref?.();
  }

  /** Force a single write (used by tests to verify behavior without sleeping). */
  tickNow(): void {
    this.tick();
  }

  private tick(): void {
    const data = { ts: Date.now(), ...this.getState() };
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.filePath);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
