// src/evolution/session-trace-tap.ts
//
// Receives stream-json events from one spawn-claude RPC and writes them as a
// raw jsonl trace under `session-traces/iter<N>_<role>_<sid>.jsonl`. The file
// starts with a `_pending` placeholder name; once the first event with a
// `session_id` is seen, the writer flushes + closes the placeholder and
// reopens the destination path. close() returns the final path.
import * as fs from "node:fs";
import * as path from "node:path";

export class SessionTraceTap {
  private fd: number;
  private currentPath: string;
  private sessionId: string | null = null;
  private readonly tracesDir: string;
  private readonly iter: number;
  private readonly role: string;
  private closed = false;

  constructor(tracesDir: string, iter: number, role: string) {
    fs.mkdirSync(tracesDir, { recursive: true });
    this.tracesDir = tracesDir;
    this.iter = iter;
    this.role = role;
    const placeholder = path.join(tracesDir, `iter${iter}_${role}_pending.jsonl`);
    this.fd = fs.openSync(placeholder, "w");
    this.currentPath = placeholder;
  }

  recordEvent(evt: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error("SessionTraceTap closed");
    }
    fs.writeSync(this.fd, JSON.stringify(evt) + "\n");
    if (this.sessionId == null) {
      const sid = this.extractSessionId(evt);
      if (sid) {
        this.sessionId = sid;
      }
    }
  }

  /** Try a few common stream-json shapes for the session_id field. */
  private extractSessionId(evt: Record<string, unknown>): string | null {
    if (typeof evt["session_id"] === "string") {
      return evt["session_id"];
    }
    if (typeof evt["sessionId"] === "string") {
      return evt["sessionId"];
    }
    const data = evt["data"];
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d["session_id"] === "string") {
        return d["session_id"];
      }
      if (typeof d["sessionId"] === "string") {
        return d["sessionId"];
      }
    }
    return null;
  }

  /** Closes the file. If a session_id was seen, renames to the canonical
   *  `iter<N>_<role>_<sid>.jsonl` form. Returns the final path. */
  close(): string {
    if (this.closed) {
      return this.currentPath;
    }
    this.closed = true;
    try {
      fs.fsyncSync(this.fd);
    } catch {
      // best effort
    }
    fs.closeSync(this.fd);

    if (this.sessionId) {
      const finalP = path.join(
        this.tracesDir,
        `iter${this.iter}_${this.role}_${this.sessionId}.jsonl`,
      );
      try {
        fs.renameSync(this.currentPath, finalP);
        this.currentPath = finalP;
      } catch {
        // race / permission — leave as pending
      }
    }
    return this.currentPath;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getCurrentPath(): string {
    return this.currentPath;
  }
}
