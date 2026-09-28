import { describe, expect, it, vi } from "vitest";
import { OpenRouterRuntime } from "../../../../src/runtime/openrouter/openRouterRuntime";
import type { RuntimeEvent, RuntimeSendRequest, RuntimeToolCall } from "../../../../src/runtime/runtimeTypes";
import { runInferenceAgentLoop } from "../../../../src/runtime/tools/inferenceAgentLoop";

/**
 * End-to-end reproduction of the reported regression: an OpenRouter model emits
 * a native `write_file` tool call over SSE, and the agent loop must execute it
 * and feed the result back to the model (no user tool selection involved).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CATALOG = {
  data: [
    {
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      context_length: 200000,
      architecture: { input_modalities: ["text"] },
      supported_parameters: ["tools", "tool_choice", "stream"],
      pricing: { prompt: "0.000003", completion: "0.000015" },
    },
  ],
};

function sseResponse(payloads: readonly unknown[], finish: "tool_calls" | "stop"): Response {
  const encoder = new TextEncoder();
  const lines = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`);
  lines.push("data: [DONE]\n\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  void finish;
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** First completion: a streamed native write_file call split across fragments. */
function writeToolCallStream(): Response {
  return sseResponse([
    { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_write_1",
                type: "function",
                function: { name: "write_file", arguments: "" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"path":"advanced_functions.py",' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"content":"# advanced python functions"}' } }],
          },
        },
      ],
      finish_reason: "tool_calls",
    },
  ], "tool_calls");
}

/** Second completion: the final assistant summary after the tool result. */
function finalMessageStream(): Response {
  return sseResponse([
    { choices: [{ delta: { role: "assistant", content: "" } }] },
    { choices: [{ delta: { content: "Created advanced_functions.py for you." }, finish_reason: "stop" }] },
  ], "stop");
}

describe("OpenRouter native tool flow (regression)", () => {
  it("executes a model-selected write_file call and returns the result to the model", async () => {
    let chatCalls = 0;
    const calls: RuntimeToolCall[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      if (target.endsWith("/chat/completions")) {
        chatCalls += 1;
        return chatCalls === 1 ? writeToolCallStream() : finalMessageStream();
      }
      throw new TypeError(`Unexpected URL ${target}`);
    }) as unknown as typeof fetch;

    const runtime = new OpenRouterRuntime(fetcher);
    await runtime.configure({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4", apiKey: "test-key" });
    await runtime.createSession({ sessionId: "s1", workspacePath: ".", modelId: "anthropic/claude-sonnet-4" });

    const events: RuntimeEvent[] = [];
    const request: RuntimeSendRequest = {
      sessionId: "s1",
      workspacePath: ".",
      modelId: "anthropic/claude-sonnet-4",
      prompt: "can you create me a python file teaching about advanced python functions",
      onStreamDelta: () => undefined,
      onToolCall: async (call) => {
        calls.push(call);
        return { allowed: true, result: { success: true, tool: call.name, path: "advanced_functions.py", written: true, bytes: 30 } };
      },
    };

    await runtime.sendMessage(request, async (event) => {
      events.push(event);
    });

    // The model autonomously selected write_file — no user tool choice needed.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("write_file");
    expect(calls[0]?.id).toBe("call_write_1");
    expect(calls[0]?.input).toMatchObject({ path: "advanced_functions.py" });

    // No "Unknown tool" feedback was produced.
    const thinking = events.filter((event) => event.type === "thinking").map((event) => event.message);
    expect(thinking.some((message) => /unknown tool/i.test(message))).toBe(false);

    // The tool lifecycle is real and the model produced the final answer.
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.some((event) => event.type === "tool_result")).toBe(true);
    const final = events.filter((event) => event.type === "assistant_message").at(-1);
    expect(final && final.type === "assistant_message" ? final.message : "").toContain("advanced_functions.py");

    // Two model turns: the tool-call turn, then the follow-up after the result.
    expect(chatCalls).toBe(2);
  });

  it("sends the registered write_file schema to the provider", async () => {
    let body: { tools?: Array<{ function: { name: string } }> } | undefined;
    let chatCalls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      if (target.endsWith("/chat/completions")) {
        chatCalls += 1;
        if (chatCalls === 1) {
          body = JSON.parse(String(init?.body ?? "{}")) as typeof body;
        }
        return chatCalls === 1 ? writeToolCallStream() : finalMessageStream();
      }
      throw new TypeError(`Unexpected URL ${target}`);
    }) as unknown as typeof fetch;

    const runtime = new OpenRouterRuntime(fetcher);
    await runtime.configure({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4", apiKey: "test-key" });
    await runtime.createSession({ sessionId: "s1", workspacePath: ".", modelId: "anthropic/claude-sonnet-4" });

    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: ".",
        modelId: "anthropic/claude-sonnet-4",
        prompt: "create a python file",
        onStreamDelta: () => undefined,
        onToolCall: async () => ({ allowed: true, result: { success: true } }),
      },
      async () => undefined,
    );

    const names = (body?.tools ?? []).map((tool) => tool.function.name);
    expect(names).toContain("write_file");
    expect(names).toContain("read_file");
    expect(names).toContain("edit_file");
  });
});

/**
 * Pins the mechanism behind the reported "Unknown tool write_file" message:
 * a registry-known tool that is outside the current mode's available set is
 * reported exactly like a hallucinated tool. Documents why gating the tool set
 * on a user-selectable mode breaks autonomous tool use.
 */
describe("agent-loop tool availability gating", () => {
  const events: RuntimeEvent[] = [];
  let toolCalls = 0;

  function makeCompleteChat() {
    let turn = 0;
    return async () => {
      turn += 1;
      if (turn === 1) {
        return {
          content: "",
          nativeToolCalls: [{ id: "call_1", name: "write_file", input: { path: "a.py", content: "x" } }],
        };
      }
      return { content: "Done." };
    };
  }

  it("reports write_file as unknown when the mode excludes it", async () => {
    events.length = 0;
    toolCalls = 0;
    await runInferenceAgentLoop(
      {
        sessionId: "s1",
        workspacePath: ".",
        prompt: "create a python file",
        onToolCall: async () => {
          toolCalls += 1;
          return { allowed: true, result: { success: true } };
        },
      },
      [],
      makeCompleteChat(),
      async (event) => {
        events.push(event);
      },
      { nativeTools: true, mode: "ask" },
    );

    const thinking = events.filter((event) => event.type === "thinking").map((event) => event.message);
    expect(thinking.some((message) => /Unknown tool/.test(message) && /write_file/.test(message))).toBe(true);
    expect(toolCalls).toBe(0);
  });

  it("executes write_file in the default agent mode", async () => {
    events.length = 0;
    toolCalls = 0;
    await runInferenceAgentLoop(
      {
        sessionId: "s1",
        workspacePath: ".",
        prompt: "create a python file",
        onToolCall: async () => {
          toolCalls += 1;
          return { allowed: true, result: { success: true } };
        },
      },
      [],
      makeCompleteChat(),
      async (event) => {
        events.push(event);
      },
      { nativeTools: true, mode: "agent" },
    );

    expect(toolCalls).toBe(1);
    const thinking = events.filter((event) => event.type === "thinking").map((event) => event.message);
    expect(thinking.some((message) => /Unknown tool/.test(message))).toBe(false);
  });
});
