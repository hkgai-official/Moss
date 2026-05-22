// src/evolution/evolution-log.ts
//
// Append-only chronological event log for one evolution trigger. One file per
// trigger, written into `current/evolution-log.jsonl`. Buffered fsync every
// 10 writes (low overhead, max ~10 events lost on crash — acceptable since
// manifest.json is the authoritative state source).
import * as fs from "node:fs";
import * as path from "node:path";

export type EvolutionEventKind =
  | "stage_start"
  | "role_spawned"
  | "role_event"
  | "role_finished"
  | "stage_end"
  | "task_start"
  | "error"
  | "streak_update"
  | "verdict";

export interface EvolutionEvent {
  ts: number;
  iter: number;
  round?: number | null;
  stage: string;
  event: EvolutionEventKind;
  role?: string;
  sessionId?: string;
  data: Record<string, unknown>;
}

export class EvolutionLog {
  private fd: number | null;
  private writeCount = 0;
  private readonly fsyncEvery: number;

  constructor(filePath: string, opts: { fsyncEvery?: number } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, "a");
    this.fsyncEvery = opts.fsyncEvery ?? 10;
  }

  append(evt: Omit<EvolutionEvent, "ts">): void {
    if (this.fd == null) {
      throw new Error("EvolutionLog closed");
    }
    const full: EvolutionEvent = { ts: Date.now(), ...evt };
    fs.writeSync(this.fd, JSON.stringify(full) + "\n");
    this.writeCount++;
    if (this.writeCount % this.fsyncEvery === 0) {
      fs.fsyncSync(this.fd);
    }
  }

  close(): void {
    if (this.fd != null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {
        // ignore best-effort fsync on close
      }
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
