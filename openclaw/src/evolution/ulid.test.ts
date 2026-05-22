import { describe, it, expect } from "vitest";
import { ulid } from "./ulid.js";

describe("ulid", () => {
  it("returns 26-char Crockford Base32 string", () => {
    const id = ulid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("two consecutive calls are monotonic time-prefix-wise", () => {
    const a = ulid();
    const b = ulid();
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
  it("two consecutive calls produce different ids", () => {
    expect(ulid()).not.toBe(ulid());
  });
});
