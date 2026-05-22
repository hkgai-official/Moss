import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireWebhook } from "./webhook-fire.js";

describe("fireWebhook", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs JSON to the gateway hook endpoint with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENCLAW_GATEWAY_URL = "http://localhost:18789";
    process.env.MOSS_GATEWAY_TOKEN = "test-token";
    await fireWebhook({
      event: "evolution-converged",
      batch_id: "batch-2",
      trigger_id: "t-1",
      human_summary: "Converged",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:18789/hooks/evolution-converged");
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(opts.body));
    expect(body.source).toBe("evolution-converged");
    expect(body.payload.batch_id).toBe("batch-2");
    expect(body.payload.human_summary).toBe("Converged");
  });

  it("omits Authorization header when token is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENCLAW_GATEWAY_URL = "http://localhost:18789";
    process.env.MOSS_GATEWAY_TOKEN = "";
    await fireWebhook({
      event: "evolution-failed",
      batch_id: "b",
      trigger_id: "t",
      human_summary: "x",
    });
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("does not throw when HTTP fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENCLAW_GATEWAY_URL = "http://localhost:18789";
    process.env.MOSS_GATEWAY_TOKEN = "";
    await expect(
      fireWebhook({
        event: "evolution-failed",
        batch_id: "b",
        trigger_id: "t",
        human_summary: "x",
      }),
    ).resolves.toBeUndefined();
  });
});
