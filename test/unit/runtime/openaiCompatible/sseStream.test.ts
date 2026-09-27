import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleRuntime } from "../../../../src/runtime/openaiCompatible/openaiCompatibleRuntime";
import { consumeOpenAiSseStream } from "../../../../src/runtime/openaiCompatible/sseStream";
import { OpenRouterRuntime } from "../../../../src/runtime/openrouter/openRouterRuntime";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const CHUNK_HELLO = JSON.stringify({
  choices: [{ delta: { content: "Hello" }, index: 0 }],
});
const CHUNK_WORLD = JSON.stringify({
  choices: [{ delta: { content: " world" }, index: 0 }],
});
const CHUNK_USAGE = JSON.stringify({
  choices: [{ delta: {}, index: 0 }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
});

describe("consumeOpenAiSseStream", () => {
  it("assembles content and releases safe deltas", async () => {
    const deltas: string[] = [];
    const response = sseResponse([CHUNK_HELLO, CHUNK_WORLD, CHUNK_USAGE]);
    const completion = await consumeOpenAiSseStream(response, undefined, (text) => deltas.push(text));

    expect(completion.content).toBe("Hello world");
    expect(deltas.join("")).toBe("Hello world");
    expect(completion.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(completion.nativeToolCalls).toHaveLength(0);
  });

  it("merges streamed tool-call fragments by index and preserves ids", async () => {
    const fragments = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_123", type: "function", function: { name: "list_files", arguments: "" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\":\".\"}" } }] } }] }),
    ];
    const response = sseResponse(fragments);
    const completion = await consumeOpenAiSseStream(response, undefined, undefined);

    expect(completion.content).toBe("");
    expect(completion.nativeToolCalls).toHaveLength(1);
    expect(completion.nativeToolCalls?.[0]).toMatchObject({ id: "call_123", name: "list_files", input: { path: "." } });
  });

  it("keeps parallel tool-call fragments separate per index", async () => {
    const fragments = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_1", function: { name: "list_files", arguments: "{}" } },
        { index: 1, id: "call_2", function: { name: "read_file", arguments: "{\"path\":\"a.py\"}" } },
      ] } }] }),
    ];
    const response = sseResponse(fragments);
    const completion = await consumeOpenAiSseStream(response, undefined, undefined);

    expect(completion.nativeToolCalls.map((call) => call.id)).toEqual(["call_1", "call_2"]);
    expect(completion.nativeToolCalls[1].input).toEqual({ path: "a.py" });
  });

  it("never releases tool-protocol JSON through the delta hook", async () => {
    const deltas: string[] = [];
    const fragments = [
      JSON.stringify({ choices: [{ delta: { content: "{\"name\": \"fin" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "ish\", \"arguments\": {}}" } }] }),
    ];
    const response = sseResponse(fragments);
    const completion = await consumeOpenAiSseStream(response, undefined, (text) => deltas.push(text));

    expect(completion.content).toContain("\"name\"");
    expect(deltas.join("")).not.toContain("\"name\"");
  });

  it("throws a cancelled error when the signal aborts", async () => {
    const controller = new AbortController();
    // A live stream (chunks every 20ms) so the read loop reaches its abort
    // check; a fully static stream would block inside reader.read() itself.
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const live = new ReadableStream<Uint8Array>({
      start(streamController) {
        timer = setInterval(() => {
          streamController.enqueue(encoder.encode(`data: ${CHUNK_HELLO}\n\n`));
        }, 20);
      },
      cancel() {
        // The abort path cancels the reader; stop the producer so the test
        // environment never tears down with a live timer.
        if (timer) {
          clearInterval(timer);
        }
      },
    });
    const response = new Response(live, { status: 200 });
    const pending = consumeOpenAiSseStream(response, controller.signal, undefined);
    setTimeout(() => controller.abort(), 60);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("OpenAICompatibleRuntime streaming", () => {
  it("sends stream:true and Accept: text/event-stream when a delta hook is present", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers).get("Accept") ?? "");
      return sseResponse([CHUNK_HELLO, CHUNK_USAGE]);
    }) as unknown as typeof fetch;

    const runtime = new OpenAICompatibleRuntime(fetcher);
    await runtime.configure({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", modelId: "test-model" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "test-model" });

    const deltas: string[] = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "test-model",
        prompt: "hi",
        onStreamDelta: (text) => deltas.push(text),
      },
      async () => undefined,
    );

    expect(bodies[0].stream).toBe(true);
    expect(headers[0]).toBe("text/event-stream");
    expect(deltas.join("")).toBe("Hello");
  });

  it("keeps stream:false when no delta hook is provided", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const runtime = new OpenAICompatibleRuntime(fetcher);
    await runtime.configure({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", modelId: "test-model" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "test-model" });
    await runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "test-model", prompt: "hi" }, async () => undefined);

    expect(bodies[0].stream).toBe(false);
  });

  it("emits text_delta runtime events through the loop for streamed completions", async () => {
    const fetcher = vi.fn(async () => sseResponse([CHUNK_HELLO, CHUNK_WORLD])) as unknown as typeof fetch;

    const runtime = new OpenAICompatibleRuntime(fetcher);
    await runtime.configure({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", modelId: "test-model" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "test-model" });

    const events: Array<{ type: string; text?: string; message?: string }> = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "test-model",
        prompt: "hi",
        // RuntimeManager wraps this hook into text_delta runtime events; at
        // the runtime boundary the deltas arrive through this callback.
        onStreamDelta: (text) => events.push({ type: "text_delta", text }),
      },
      async (event) => {
        events.push(event as { type: string });
      },
    );

    expect(events.some((event) => event.type === "text_delta" && event.text === "Hello")).toBe(true);
    expect(events.some((event) => event.type === "assistant_message" && event.message === "Hello world")).toBe(true);
  });
});

describe("OpenRouterRuntime streaming", () => {
  it("streams chat completions and preserves the tool_call_id round-trip", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let chatCalls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [{
              id: "vendor/model",
              name: "Vendor Model",
              context_length: 8192,
              architecture: { input_modalities: ["text"] },
              supported_parameters: ["tools"],
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      chatCalls += 1;
      if (chatCalls === 1) {
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_77", type: "function", function: { name: "list_files", arguments: "{}" } }] } }] }),
        ]);
      }
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "Here is your workspace." } }] }),
      ]);
    }) as unknown as typeof fetch;

    const runtime = new OpenRouterRuntime(fetcher);
    await runtime.configure({ provider: "openrouter", apiKey: "k", modelId: "vendor/model" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "vendor/model" });

    const events: Array<{ type: string; message?: string }> = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "vendor/model",
        prompt: "list files",
        onToolCall: async (call) => ({ allowed: true, result: { success: true, files: [call.name] } }),
        onStreamDelta: () => undefined,
      },
      async (event) => {
        events.push(event as { type: string });
      },
    );

    expect(bodies[0].stream).toBe(true);
    const toolTurn = (bodies[1].messages as Array<Record<string, unknown>>).find((message) => message.role === "tool");
    expect(toolTurn?.tool_call_id).toBe("call_77");
    expect(events.some((event) => event.type === "assistant_message" && event.message === "Here is your workspace.")).toBe(true);
  });
});
