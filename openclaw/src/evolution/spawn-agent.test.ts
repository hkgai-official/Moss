// Unit tests for the typed-wrapper translation logic in spawn-agent.ts.
//
// Covers wire-format adapter (snake_case → camelCase + safe coercion), new
// fields (agentOverride, tokens, provider, model), and error/edge cases.
// We mock rpc-client.rpcStream so no daemon, socket, or coding-agent CLI
// is touched.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcMessage } from "./rpc-client.js";

type RpcStreamFn = (
  op: string,
  payload: Record<string, unknown>,
  opts?: unknown,
) => AsyncGenerator<RpcMessage>;

const rpcStreamCalls: Array<{ op: string; payload: Record<string, unknown> }> = [];
const rpcStreamMock = vi.fn<RpcStreamFn>();

vi.mock("./rpc-client.js", () => ({
  rpcStream: (op: string, payload: Record<string, unknown>, opts?: unknown) => {
    rpcStreamCalls.push({ op, payload });
    return rpcStreamMock(op, payload, opts);
  },
}));

import { spawnAgentStream, spawnClaudeStream } from "./spawn-agent.js";

function makeStream(messages: RpcMessage[]): RpcStreamFn {
  return async function* () {
    for (const m of messages) {
      yield m;
    }
  };
}

afterEach(() => {
  rpcStreamCalls.length = 0;
  rpcStreamMock.mockReset();
});

describe("spawn-agent typed wrapper", () => {
  it("forwards snake_case payload + maps result to camelCase", async () => {
    rpcStreamMock.mockImplementationOnce(
      makeStream([
        { id: "x", type: "event", data: { tag: "tool_use", name: "Read" } },
        {
          id: "x",
          type: "result",
          data: {
            exit_code: 0,
            elapsed_s: 12.5,
            session_id: "abc-123",
            cost_usd: 0.42,
            tokens: null,
            provider: "claude",
            model: "sonnet",
          },
        },
      ]),
    );

    const events: Record<string, unknown>[] = [];
    let result: ReturnType<typeof Object> | null = null;
    for await (const m of spawnAgentStream({
      role: "locator",
      systemPrompt: "you are locator",
      userInput: "find files",
      addDirs: ["/host/repo"],
      cwd: "/host/repo",
      timeoutS: 60,
      resumeSessionId: "prev-id",
      outputLogDir: "/host/log",
    })) {
      if (m.kind === "event") {
        events.push(m.event);
      } else {
        result = m.result;
      }
    }

    expect(rpcStreamCalls).toHaveLength(1);
    expect(rpcStreamCalls[0]).toEqual({
      op: "spawn-agent",
      payload: {
        role: "locator",
        system_prompt: "you are locator",
        user_input: "find files",
        add_dirs: ["/host/repo"],
        cwd: "/host/repo",
        timeout_s: 60,
        resume_session_id: "prev-id",
        output_log_dir: "/host/log",
        agent_override: null,
      },
    });

    expect(events).toEqual([{ tag: "tool_use", name: "Read" }]);
    expect(result).toEqual({
      exitCode: 0,
      elapsedS: 12.5,
      sessionId: "abc-123",
      costUsd: 0.42,
      tokens: null,
      provider: "claude",
      model: "sonnet",
    });
  });

  it("nulls resume_session_id when omitted", async () => {
    rpcStreamMock.mockImplementationOnce(
      makeStream([
        {
          id: "x",
          type: "result",
          data: { exit_code: 0, elapsed_s: 1, session_id: "s", cost_usd: 0 },
        },
      ]),
    );
    for await (const _m of spawnAgentStream({
      role: "planner",
      systemPrompt: "p",
      userInput: "u",
      addDirs: [],
      cwd: "/c",
      timeoutS: 1,
      outputLogDir: "/l",
    })) {
      // drain
    }
    expect(rpcStreamCalls[0]?.payload.resume_session_id).toBeNull();
  });

  it("forwards agentOverride to RPC payload as agent_override", async () => {
    rpcStreamMock.mockImplementationOnce(
      makeStream([
        {
          id: "x",
          type: "result",
          data: {
            exit_code: 0,
            elapsed_s: 1,
            session_id: "s",
            cost_usd: 0,
            provider: "codex",
            model: "gpt-5.4",
          },
        },
      ]),
    );
    for await (const _m of spawnAgentStream({
      role: "planner",
      systemPrompt: "p",
      userInput: "u",
      addDirs: [],
      cwd: "/c",
      timeoutS: 1,
      outputLogDir: "/l",
      agentOverride: "codex",
    })) {
      // drain
    }
    expect(rpcStreamCalls[0]?.payload.agent_override).toBe("codex");
  });

  it("parses tokens.{cache_read,cache_write,reasoning} from snake_case wire", async () => {
    rpcStreamMock.mockImplementationOnce(
      makeStream([
        {
          id: "x",
          type: "result",
          data: {
            exit_code: 0,
            elapsed_s: 2.5,
            session_id: "abc",
            cost_usd: 0,
            tokens: {
              input: 100,
              output: 20,
              cache_read: 50,
              cache_write: 5,
              reasoning: 3,
            },
            provider: "codex",
            model: "gpt-5.4",
          },
        },
      ]),
    );

    let result: { tokens: unknown; provider: string; model: string } | null = null;
    for await (const m of spawnAgentStream({
      role: "implementer",
      systemPrompt: "p",
      userInput: "u",
      addDirs: [],
      cwd: "/c",
      timeoutS: 1,
      outputLogDir: "/l",
    })) {
      if (m.kind === "result") {
        result = m.result;
      }
    }
    expect(result?.tokens).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 5,
      reasoning: 3,
    });
    expect(result?.provider).toBe("codex");
    expect(result?.model).toBe("gpt-5.4");
  });

  it("coerces missing/non-string fields without producing '[object Object]'", async () => {
    rpcStreamMock.mockImplementationOnce(makeStream([{ id: "x", type: "result", data: {} }]));
    let result: Record<string, unknown> | null = null;
    for await (const m of spawnAgentStream({
      role: "implementer",
      systemPrompt: "p",
      userInput: "u",
      addDirs: [],
      cwd: "/c",
      timeoutS: 1,
      outputLogDir: "/l",
    })) {
      if (m.kind === "result") {
        result = m.result as unknown as Record<string, unknown>;
      }
    }
    expect(result).toEqual({
      exitCode: -1,
      elapsedS: 0,
      sessionId: "",
      costUsd: 0,
      tokens: null,
      provider: "claude",  // default when unknown
      model: "",
    });
  });

  it("throws with daemon error message when stream emits error", async () => {
    rpcStreamMock.mockImplementationOnce(
      makeStream([{ id: "x", type: "error", data: { message: "claude killed" } }]),
    );
    await expect(async () => {
      for await (const _m of spawnAgentStream({
        role: "code_reviewer",
        systemPrompt: "p",
        userInput: "u",
        addDirs: [],
        cwd: "/c",
        timeoutS: 1,
        outputLogDir: "/l",
      })) {
        // drain
      }
    }).rejects.toThrow(/claude killed/);
  });

  it("throws when stream ends without result", async () => {
    rpcStreamMock.mockImplementationOnce(
      makeStream([{ id: "x", type: "event", data: { tag: "stuff" } }]),
    );
    await expect(async () => {
      for await (const _m of spawnAgentStream({
        role: "strategic_reviewer",
        systemPrompt: "p",
        userInput: "u",
        addDirs: [],
        cwd: "/c",
        timeoutS: 1,
        outputLogDir: "/l",
      })) {
        // drain
      }
    }).rejects.toThrow(/ended without result/);
  });

  it("spawnClaudeStream alias is the same function", () => {
    expect(spawnClaudeStream).toBe(spawnAgentStream);
  });
});
