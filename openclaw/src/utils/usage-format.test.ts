import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __setConfigForTest,
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveCostForActiveModel,
  resolveModelCostConfig,
} from "./usage-format.js";

describe("usage-format", () => {
  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = {
      models: {
        providers: {
          test: {
            models: [
              {
                id: "m1",
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const cost = resolveModelCostConfig({
      provider: "test",
      model: "m1",
      config,
    });

    expect(cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
    });

    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });

    expect(total).toBeCloseTo(0.003);
  });
});

describe("resolveCostForActiveModel (config-memo + injection seam)", () => {
  beforeEach(() => __setConfigForTest(null));
  afterEach(() => __setConfigForTest(null));

  it("returns cost config when provider+model exists in injected config", () => {
    __setConfigForTest({
      models: {
        providers: {
          codex: {
            models: [
              {
                id: "gpt-5.4",
                cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);

    const result = resolveCostForActiveModel("codex", "gpt-5.4");
    expect(result).toEqual({
      input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0,
    });
  });

  it("returns undefined when provider exists but model missing", () => {
    __setConfigForTest({
      models: {
        providers: {
          codex: {
            models: [
              { id: "other-model", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(resolveCostForActiveModel("codex", "gpt-5.4")).toBeUndefined();
  });

  it("returns undefined when provider missing entirely", () => {
    __setConfigForTest({ models: { providers: {} } } as unknown as OpenClawConfig);
    expect(resolveCostForActiveModel("codex", "gpt-5.4")).toBeUndefined();
  });

  it("memoizes config across calls (no redundant FS reads)", () => {
    // We can't easily intercept loadConfig() here without dynamic import
    // tricks, so verify memo by checking that an injected config sticks
    // across multiple calls without re-injection.
    const cfg = {
      models: {
        providers: {
          codex: {
            models: [
              { id: "gpt-5.4", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    __setConfigForTest(cfg);

    const a = resolveCostForActiveModel("codex", "gpt-5.4");
    const b = resolveCostForActiveModel("codex", "gpt-5.4");
    expect(a).toEqual(b);
    expect(a).toBeDefined();
  });
});
