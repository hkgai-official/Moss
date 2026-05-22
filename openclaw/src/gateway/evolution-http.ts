// Auth: replicated via authorizeGatewayBearerRequestOrReply() (path b verified 2026-05-13).
// control-ui.ts has no auth check; server-http.ts dispatcher applies auth per-handler
// (see /api/channels/ inline check at line ~491). New evolution endpoints follow the
// same pattern: check the bearer token at the top of the handler before dispatching.
//
// Handler implementations live in evolution-http.helpers.ts; this file holds
// the auth + dispatch shell only (kept under ~150 LOC).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  handleActive,
  handleApply,
  handleBatchesList,
  handleComposeBatch,
  handleDiff,
  handleDiscard,
  handleFlag,
  handleFlagPoolList,
  handleScores,
  handleSettingsGet,
  handleSettingsPost,
  handleRestart,
  handleStop,
  handleTrigger,
  handleUnflag,
  type HandlerCtx,
  type HandlerResult,
} from "./evolution-http.helpers.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";

export interface EvolutionHttpOptions {
  dataDir: string;
  openclawRepoDir?: string;
  /** Resolved gateway auth; when present, bearer-token auth is enforced. */
  auth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}

const PREFIX = "/api/evolution/";
const MAX_BODY_BYTES = 1_000_000;

// Read a JSON body from the request stream. We accept the lightweight test
// mock (Record-style `req.on('data', cb)` + `req.on('end', cb)`) as well as
// real IncomingMessage streams; no removeListener semantics are required
// because we resolve exactly once on `end` (or fail-fast on JSON parse).
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const onData = (c: Buffer | string) => {
      if (settled) {
        return;
      }
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += b.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(b);
    };
    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    };
    const onError = (e: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(e);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJson(res: ServerResponse, r: HandlerResult): void {
  res.statusCode = r.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(r.body));
}

export async function handleEvolutionHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: EvolutionHttpOptions,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(PREFIX)) {
    return false;
  }

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain");
    res.end("Method Not Allowed");
    return true;
  }

  // Auth: when a resolved gateway auth is supplied, require a valid bearer token.
  // Replicates the inline pattern used by /api/channels/* in server-http.ts.
  if (opts.auth) {
    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      // Response (401/403) has already been written by the helper.
      return true;
    }
  }

  // Parse path + query
  const [pathPart, queryPart] = url.slice(PREFIX.length).split("?");
  const sub = pathPart;
  const query = new URLSearchParams(queryPart ?? "");
  const ctx: HandlerCtx = {
    dataDir: opts.dataDir,
    openclawRepoDir: opts.openclawRepoDir,
  };

  const key = `${method} ${sub}`;
  // POST handlers consume a JSON body; GET handlers don't.
  if (method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, { status: 400, body: { error: "invalid body", detail: String(e) } });
      return true;
    }
    const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    // Wrap dispatch to surface real errors (otherwise gateway returns
    // generic 500 with no stack — invisible from outside).
    try {
      switch (key) {
        case "POST flag":
          sendJson(res, await handleFlag(ctx, obj));
          return true;
        case "POST unflag":
          sendJson(res, await handleUnflag(ctx, obj));
          return true;
        case "POST compose-batch":
          sendJson(res, await handleComposeBatch(ctx, obj));
          return true;
        case "POST trigger":
          sendJson(res, await handleTrigger(ctx, obj));
          return true;
        case "POST apply":
          sendJson(res, await handleApply(ctx, obj));
          return true;
        case "POST discard":
          sendJson(res, await handleDiscard(ctx, obj));
          return true;
        case "POST stop":
          sendJson(res, await handleStop(ctx, obj));
          return true;
        case "POST restart":
          sendJson(res, await handleRestart(ctx, obj));
          return true;
        case "POST settings":
          sendJson(res, await handleSettingsPost(ctx, obj));
          return true;
        default:
          sendJson(res, { status: 404, body: { error: "Not Found" } });
          return true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      // eslint-disable-next-line no-console
      console.error(`[evolution-http] ${key} threw:`, msg, stack);
      sendJson(res, { status: 500, body: { error: msg, key } });
      return true;
    }
  }
  // GET
  switch (key) {
    case "GET flag-pool":
      sendJson(res, await handleFlagPoolList(ctx));
      return true;
    case "GET active":
      sendJson(res, await handleActive(ctx));
      return true;
    case "GET batches":
      sendJson(res, await handleBatchesList(ctx));
      return true;
    case "GET diff":
      sendJson(res, await handleDiff(ctx, query));
      return true;
    case "GET scores":
      sendJson(res, await handleScores(ctx, query));
      return true;
    case "GET settings":
      sendJson(res, await handleSettingsGet(ctx));
      return true;
    default:
      sendJson(res, { status: 404, body: { error: "Not Found" } });
      return true;
  }
}
