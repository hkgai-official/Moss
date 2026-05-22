import { randomUUID } from "node:crypto";
// src/evolution/rpc-client.ts
//
// JSON-line unix-socket client for the moss host daemon. One request per
// connection: client writes a single Request envelope, then reads zero-or-more
// `event` Responses followed by exactly one terminal `result` or `error`.
import * as net from "node:net";

// Read the env var lazily at call time (not at import) so test fixtures /
// per-iteration overrides work without restarting the runtime.
function defaultSock(): string {
  return process.env.MOSS_DAEMON_SOCK ?? "/run/moss.sock";
}

export type RpcEvent = { id: string; type: "event"; data: Record<string, unknown> };
export type RpcResult = { id: string; type: "result"; data: Record<string, unknown> };
export type RpcError = { id: string; type: "error"; data: { message: string } };
export type RpcMessage = RpcEvent | RpcResult | RpcError;

export interface RpcStreamOpts {
  socketPath?: string;
  abortSignal?: AbortSignal;
}

export async function* rpcStream(
  op: string,
  payload: Record<string, unknown>,
  opts: RpcStreamOpts = {},
): AsyncGenerator<RpcMessage> {
  const id = randomUUID();
  const socketPath = opts.socketPath ?? defaultSock();
  const sock = net.createConnection(socketPath);

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => sock.destroy(), { once: true });
  }

  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });

  sock.write(JSON.stringify({ id, op, payload }) + "\n");

  let buf = "";
  const lineQueue: string[] = [];
  let closed = false;
  let resolveNext: (() => void) | null = null;

  sock.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const ln of lines) {
      if (ln.trim()) {
        lineQueue.push(ln);
      }
    }
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });
  sock.on("close", () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });

  while (true) {
    if (lineQueue.length === 0) {
      if (closed) {
        return;
      }
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
    const ln = lineQueue.shift();
    if (!ln) {
      continue;
    }
    let msg: RpcMessage;
    try {
      msg = JSON.parse(ln) as RpcMessage;
    } catch {
      continue;
    }
    yield msg;
    if (msg.type === "result" || msg.type === "error") {
      sock.end();
      return;
    }
  }
}

export interface RpcCallOpts {
  onEvent?: (data: Record<string, unknown>) => void;
  socketPath?: string;
}

/** Convenience: drain stream, return final result data. Throws on error. */
export async function rpcCall(
  op: string,
  payload: Record<string, unknown>,
  opts: RpcCallOpts = {},
): Promise<Record<string, unknown>> {
  for await (const msg of rpcStream(op, payload, { socketPath: opts.socketPath })) {
    if (msg.type === "event") {
      opts.onEvent?.(msg.data);
    } else if (msg.type === "result") {
      return msg.data;
    } else if (msg.type === "error") {
      throw new Error(`RPC error: ${msg.data.message}`);
    }
  }
  throw new Error("RPC stream ended without result");
}
