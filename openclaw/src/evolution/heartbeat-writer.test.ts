// src/evolution/heartbeat-writer.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HeartbeatWriter } from "./heartbeat-writer.js";

describe("HeartbeatWriter", () => {
  it("writes initial heartbeat on start + can be force-ticked", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
    const p = path.join(td, "heartbeat.json");
    let counter = 0;
    const hb = new HeartbeatWriter(p, () => ({ stage: "x", counter: counter++ }));
    hb.start(60_000);
    const initial = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(initial.stage).toBe("x");
    expect(typeof initial.ts).toBe("number");
    hb.tickNow();
    const second = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(second.counter).toBeGreaterThan(initial.counter);
    hb.stop();
  });

  it("creates parent dir if missing", () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
    const p = path.join(td, "nested", "heartbeat.json");
    const hb = new HeartbeatWriter(p, () => ({ stage: "x" }));
    hb.start(60_000);
    expect(fs.existsSync(p)).toBe(true);
    hb.stop();
  });
});
