// src/evolution/webhook-fire.ts
//
// Fire MOSS webhook events to the OpenClaw gateway's /hooks/<event> endpoint.
// Used by the evolution loop to notify the agent of converged/failed terminals.
// Best-effort: HTTP failures are logged, never thrown.

export interface WebhookPayload {
  event: string;
  batch_id: string;
  trigger_id: string;
  human_summary: string;
  [key: string]: unknown;
}

export async function fireWebhook(payload: WebhookPayload): Promise<void> {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";
  // OpenClaw enforces hooks.token !== gateway auth token. Webhook POSTs to
  // /hooks/<event> must use the hooks-specific bearer (MOSS_HOOKS_TOKEN).
  // Fall back to MOSS_GATEWAY_TOKEN only for legacy setups predating the
  // token split — those will fail auth at the gateway and log the error.
  const token = process.env.MOSS_HOOKS_TOKEN ?? process.env.MOSS_GATEWAY_TOKEN ?? "";
  const url = `${gatewayUrl}/hooks/${payload.event}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: payload.event, payload }),
    });
    if (!res.ok) {
      console.error(`[webhook-fire] ${payload.event} POST returned HTTP ${res.status}`);
    }
  } catch (e) {
    console.error(`[webhook-fire] ${payload.event} failed: ${String(e)}`);
  }
}
