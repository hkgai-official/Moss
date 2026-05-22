// src/evolution/loop.swap-gate.test.ts
//
// v2.6 UI: tests for the MOSS_AUTO_APPLY_ON_CONVERGE env-var gate that
// controls whether a converged evolution loop auto-writes swap-req.json
// (legacy, overnight scripts) vs hands off to the MOSS UI by flipping the
// batch's apply_state to "ready_to_apply".
//
// We don't drive the full loop here (that's loop.dry-run.test.ts) — these
// tests just pin the predicate's strict-"1" semantics so callers can rely on
// it and so accidental "true"/"yes" doesn't silently re-enable auto-swap.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { shouldAutoApplyOnConverge } from "./loop.js";

const originalEnv = process.env.MOSS_AUTO_APPLY_ON_CONVERGE;

beforeEach(() => {
  delete process.env.MOSS_AUTO_APPLY_ON_CONVERGE;
});

afterAll(() => {
  // Restore whatever the harness had set, to avoid bleeding into other suites.
  if (originalEnv === undefined) {
    delete process.env.MOSS_AUTO_APPLY_ON_CONVERGE;
  } else {
    process.env.MOSS_AUTO_APPLY_ON_CONVERGE = originalEnv;
  }
});

describe("shouldAutoApplyOnConverge — strict MOSS_AUTO_APPLY_ON_CONVERGE=1 gate", () => {
  it("env unset → false (UI gate is the default)", () => {
    expect(shouldAutoApplyOnConverge()).toBe(false);
  });

  it('env="0" → false', () => {
    process.env.MOSS_AUTO_APPLY_ON_CONVERGE = "0";
    expect(shouldAutoApplyOnConverge()).toBe(false);
  });

  it('env="1" → true (legacy overnight-script opt-in)', () => {
    process.env.MOSS_AUTO_APPLY_ON_CONVERGE = "1";
    expect(shouldAutoApplyOnConverge()).toBe(true);
  });

  it('env="true" → false (strict; only literal "1" enables auto-swap)', () => {
    process.env.MOSS_AUTO_APPLY_ON_CONVERGE = "true";
    expect(shouldAutoApplyOnConverge()).toBe(false);
  });

  it('env="yes" → false (strict)', () => {
    process.env.MOSS_AUTO_APPLY_ON_CONVERGE = "yes";
    expect(shouldAutoApplyOnConverge()).toBe(false);
  });

  it('env="" (empty string) → false', () => {
    process.env.MOSS_AUTO_APPLY_ON_CONVERGE = "";
    expect(shouldAutoApplyOnConverge()).toBe(false);
  });
});
