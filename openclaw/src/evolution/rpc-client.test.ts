import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { rpcCall, rpcStream } from "./rpc-client.js";

function startStubServer(replies: string[]): { sock: string; close: () => void } {
  const sock = path.join(
    os.tmpdir(),
    `moss-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
  );
  if (fs.existsSync(sock)) {
    fs.unlinkSync(sock);
  }
  const server = net.createServer((conn) => {
    conn.on("data", () => {
      for (const reply of replies) {
        conn.write(reply + "\n");
      }
      conn.end();
    });
  });
  server.listen(sock);
  return {
    sock,
    close: () => {
      server.close();
      try {
        fs.unlinkSync(sock);
      } catch {
        // noop: socket may already be cleaned up
      }
    },
  };
}

describe("rpc-client", () => {
  it("streams events then result", async () => {
    const { sock, close } = startStubServer([
      '{"id":"x","type":"event","data":{"k":1}}',
      '{"id":"x","type":"event","data":{"k":2}}',
      '{"id":"x","type":"result","data":{"final":"ok"}}',
    ]);
    try {
      const events: Record<string, unknown>[] = [];
      const result = await rpcCall(
        "test",
        {},
        {
          socketPath: sock,
          onEvent: (e) => events.push(e),
        },
      );
      expect(events).toHaveLength(2);
      expect(result).toEqual({ final: "ok" });
    } finally {
      close();
    }
  });

  it("throws on error message", async () => {
    const { sock, close } = startStubServer([
      '{"id":"x","type":"error","data":{"message":"boom"}}',
    ]);
    try {
      await expect(rpcCall("test", {}, { socketPath: sock })).rejects.toThrow(/boom/);
    } finally {
      close();
    }
  });

  it("rpcStream allows iteration without await-all", async () => {
    const { sock, close } = startStubServer([
      '{"id":"x","type":"event","data":{"k":1}}',
      '{"id":"x","type":"result","data":{"final":"ok"}}',
    ]);
    try {
      const seen: string[] = [];
      for await (const m of rpcStream("test", {}, { socketPath: sock })) {
        seen.push(m.type);
      }
      expect(seen).toEqual(["event", "result"]);
    } finally {
      close();
    }
  });
});
