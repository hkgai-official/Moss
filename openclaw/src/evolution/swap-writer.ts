// src/evolution/swap-writer.ts
//
// Atomic write of `swap-req.json` from the container side. Stage 10 of the
// 9-stage evolution loop calls this to hand off the new image tag to the
// host-daemon supervisor (spec §6 responsibility A + §7).
//
// Atomicity rules (spec §7 line 654-656 + §6 file-watch contract):
//   1. write to <path>.tmp
//   2. fsync the .tmp file (so a host crash mid-write doesn't leave a
//      half-written file the supervisor parses as JSON garbage)
//   3. rename <path>.tmp -> <path> (POSIX atomic on same filesystem)
//
// The supervisor polls for the existence of swap-req.json. Without the
// rename-after-fsync pattern there's a window where it sees an empty file
// or partial JSON and either crashes or, worse, parses {} and tries to
// `docker compose up -d` on an empty image tag.
//
// We deliberately do NOT delete the file ourselves — the supervisor owns
// that lifecycle (it deletes after success or rollback).

import * as fs from "node:fs";
import * as path from "node:path";

export interface SwapRequest {
  targetImage: string;
  previousImage: string;
  triggerId: string;
  batchId: string;
}

export interface SwapRequestOnDisk {
  target_image: string;
  previous_image: string;
  trigger_id: string;
  batch_id: string;
  /** Unix ms when the request was written (for diagnostics). */
  ts: number;
}

/**
 * Atomically write `<stateDir>/swap-req.json`. Throws if any field is empty
 * (defensive: an empty string would otherwise become "openclaw:" which the
 * supervisor would parse as a garbage image tag and silently rollback).
 */
export function writeSwapRequest(stateDir: string, req: SwapRequest): string {
  if (!req.targetImage.trim()) {
    throw new Error("writeSwapRequest: targetImage is required");
  }
  if (!req.previousImage.trim()) {
    throw new Error("writeSwapRequest: previousImage is required");
  }
  if (!req.triggerId.trim()) {
    throw new Error("writeSwapRequest: triggerId is required");
  }
  if (!req.batchId.trim()) {
    throw new Error("writeSwapRequest: batchId is required");
  }
  if (!fs.existsSync(stateDir)) {
    throw new Error(`writeSwapRequest: stateDir does not exist: ${stateDir}`);
  }

  const final = path.join(stateDir, "swap-req.json");
  const tmp = `${final}.tmp`;
  const onDisk: SwapRequestOnDisk = {
    target_image: req.targetImage.trim(),
    previous_image: req.previousImage.trim(),
    trigger_id: req.triggerId.trim(),
    batch_id: req.batchId.trim(),
    ts: Date.now(),
  };
  const json = JSON.stringify(onDisk, null, 2);

  // 1. write to .tmp
  fs.writeFileSync(tmp, json);
  // 2. fsync — opens the file just to fsync, then closes
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // 3. atomic rename
  fs.renameSync(tmp, final);
  return final;
}

/** Helper for tests / status display: read swap-req.json (or null if absent). */
export function readSwapRequest(stateDir: string): SwapRequestOnDisk | null {
  const p = path.join(stateDir, "swap-req.json");
  if (!fs.existsSync(p)) {
    return null;
  }
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as SwapRequestOnDisk;
}
