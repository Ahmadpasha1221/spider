import { describe, expect, it, vi } from "vitest";
import {
  NvidiaRuntime,
  NVIDIA_BASE_URL,
  isChatCapableNvidiaModel,
} from "../../../../src/runtime/nvidia/nvidiaRuntime";
import type { RuntimeEvent, RuntimeSendRequest, RuntimeToolCall } from "../../../../src/runtime/runtimeTypes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CATALOG = {
  object: "list",
  data: [
    { id: "meta/llama-3.3-70b-instruct", object: "model", owned_by: "nvidia" },
    { id: "qwen/qwen2.5-coder-32b-instruct", object: "model", owned_by: "nvidia" },
    { id: "deepseek-ai/deepseek-r1", object: "model", owned_by: "nvidia" },
    { id: "mistralai/mistral-large-2-instruct", object: "model", owned_by: "nvidia" },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", object: "model", owned_by: "nvidia" },
    { id: "nvidia/nv-embedqa-e5-v5", object: "model", owned_by: "nvidia" },
    { id: "nvidia/rerank-qa-mistral-4b", object: "model", owned_by: "nvidia" },
    { id: "nvidia/parakeet-ctc-1.1b", object: "model", owned_by: "nvidia" },
    { id: "stabilityai/stable-diffusion-xl", object: "model", owned_by: "nvidia" },
    { id: "black-forest-labs/flux.1-dev", object: "model", owned_by: "nvidia" },
    { id: "nvidia/cosmos-1.0-diffusion-7b", object: "model", owned_by: "nvidia" },
  ],
};

function fetcherWith(catalogResponse: () => Response, chatResponse?: () => Response) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url).endsWith("/models")) {
      return catalogResponse();
    }
    if (String(url).endsWith("/chat/completions")) {
      return chatResponse
        ? chatResponse()
        : jsonResponse({
            choices: [{ message: { content: "Hello" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          });
    }
    throw new TypeError(`Unexpected URL ${String(url)}`);
  }) as unknown as typeof fetch;
}

describe("NvidiaRuntime", () => {
  it("reports the nvidia provider identity", () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    expect(runtime.provider).toBe("nvidia");
    expect(runtime.family).toBe("inference");
  });

  it("uses the fixed hosted NVIDIA API Catalog endpoint", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonResponse(CATALOG);
    }) as unknown as typeof fetch;

    const runtime = new NvidiaRuntime(fetcher);
    await runtime.discoverModels();

    expect(NVIDIA_BASE_URL).toBe("https://integrate.api.nvidia.com/v1");
    expect(urls[0]).toBe(`${NVIDIA_BASE_URL}/models`);
  });

  it("tags discovered models as nvidia, filters non-chat models, and keeps partner families", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    const models = await runtime.discoverModels();

    const ids = models.map((model) => model.id);
    // Partner-hosted chat models must NOT be excluded for the vendor name.
    expect(ids).toContain("meta/llama-3.3-70b-instruct");
    expect(ids).toContain("qwen/qwen2.5-coder-32b-instruct");
    expect(ids).toContain("nvidia/llama-3.1-nemotron-70b-instruct");
    // Non-chat task models are excluded.
    expect(ids).not.toContain("nvidia/nv-embedqa-e5-v5");
    expect(ids).not.toContain("nvidia/rerank-qa-mistral-4b");
    expect(ids).not.toContain("nvidia/parakeet-ctc-1.1b");
    expect(ids).not.toContain("stabilityai/stable-diffusion-xl");
    expect(ids).not.toContain("black-forest-labs/flux.1-dev");
    expect(ids).not.toContain("nvidia/cosmos-1.0-diffusion-7b");

    for (const model of models) {
      expect(model.provider).toBe("nvidia");
      expect(model.name).toBe(model.id);
    }
  });

  it("advertises only conservative capabilities", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    const [model] = await runtime.discoverModels();
    expect(model.capabilities?.streaming).toBe(true);
    // Native tool calling is model-dependent and not advertised.
    expect(model.capabilities?.toolCalling).toBe(false);
    expect(model.capabilities?.structuredOutput).toBe(false);
    expect(model.capabilities?.vision).toBeUndefined();
  });

  it("accepts a bare-array catalog as well as the OpenAI-style envelope", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse([{ id: "meta/llama-3.1-8b-instruct" }])));
    const [model] = await runtime.discoverModels();
    expect(model.id).toBe("meta/llama-3.1-8b-instruct");
  });

  it("sends the API key as a bearer token and never in the URL", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)}|${new Headers(init?.headers).get("Authorization") ?? ""}`);
      return jsonResponse(CATALOG);
    }) as unknown as typeof fetch;

    const runtime = new NvidiaRuntime(fetcher);
    await runtime.configure({ provider: "nvidia", apiKey: "nvapi-secret" });
    await runtime.discoverModels();

    const [url, authorization] = seen[0].split("|");
    expect(url).toBe(`${NVIDIA_BASE_URL}/models`);
    expect(authorization).toBe("Bearer nvapi-secret");
    expect(url.includes("nvapi-secret")).toBe(false);
  });

  it("reports authentication failure for 401/403", async () => {
    const runtime401 = new NvidiaRuntime(fetcherWith(() => jsonResponse({ error: "invalid key" }, 401)));
    await expect(runtime401.discoverModels()).rejects.toMatchObject({ code: "authentication_failed" });
    const runtime403 = new NvidiaRuntime(fetcherWith(() => jsonResponse({ error: "forbidden" }, 403)));
    await expect(runtime403.discoverModels()).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("reports rate limits as retryable", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse({}, 429)));
    await expect(runtime.discoverModels()).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("reports network failures and unavailable availability", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const runtime = new NvidiaRuntime(fetcher);
    await runtime.configure({ provider: "nvidia", apiKey: "k" });
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "network_error" });
    const availability = await runtime.checkAvailability();
    expect(availability.available).toBe(false);
    expect(availability.status).toBe("disconnected");
  });

  it("throws no_models_found for an empty catalog", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse({ data: [] })));
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "no_models_found" });
  });

  it("throws no_models_found when no chat-capable models remain", async () => {
    const runtime = new NvidiaRuntime(
      fetcherWith(() => jsonResponse({ data: [{ id: "nvidia/nv-embedqa-e5-v5" }, { id: "nvidia/rerank-qa-mistral-4b" }] })),
    );
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "no_models_found" });
  });

  it("throws a malformed-catalog error for an unparsable body", async () => {
    const fetcher = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const runtime = new NvidiaRuntime(fetcher);
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "unknown" });
  });

  it("blocks inference without an API key", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct" });
    await expect(
      runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("uses the selected model and does not advertise native tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({
        choices: [{ message: { content: "Hello" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    }) as unknown as typeof fetch;

    const runtime = new NvidiaRuntime(fetcher);
    await runtime.configure({ provider: "nvidia", apiKey: "k", modelId: "meta/llama-3.3-70b-instruct" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct" });

    const events: RuntimeEvent[] = [];
    await runtime.sendMessage(
      { sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct", prompt: "hi" },
      (event) => {
        events.push(event);
      },
    );

    expect(bodies[0].model).toBe("meta/llama-3.3-70b-instruct");
    // Native tools are NOT sent; the safe text-tool fallback contract is used.
    expect(bodies[0].tools).toBeUndefined();
    const messages = bodies[0].messages as Array<{ role: string; content: string }>;
    // The safe text-tool fallback contract is appended to the system prompt.
    expect(messages[0]?.content).toContain("Never invent tool names");
    expect(events.some((event) => event.type === "assistant_message" && event.message === "Hello")).toBe(true);
  });

  it("executes a text-fallback tool call and preserves the conversation shape", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let chatCalls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      chatCalls += 1;
      if (chatCalls === 1) {
        return jsonResponse({
          choices: [{ message: { content: '{"name":"list_files","arguments":{"path":"."}}' } }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: "Your workspace has a.py." } }] });
    }) as unknown as typeof fetch;

    const runtime = new NvidiaRuntime(fetcher);
    await runtime.configure({ provider: "nvidia", apiKey: "k", modelId: "qwen/qwen2.5-coder-32b-instruct" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "qwen/qwen2.5-coder-32b-instruct" });

    const calls: RuntimeToolCall[] = [];
    const events: RuntimeEvent[] = [];
    const request: RuntimeSendRequest = {
      sessionId: "s1",
      workspacePath: "/ws",
      modelId: "qwen/qwen2.5-coder-32b-instruct",
      prompt: "list files",
      onToolCall: async (call) => {
        calls.push(call);
        return { allowed: true, result: { success: true, files: ["a.py"] } };
      },
    };
    await runtime.sendMessage(request, async (event) => {
      events.push(event);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("list_files");
    expect(calls[0]?.input).toMatchObject({ path: "." });
    const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
    const toolTurn = secondMessages.find((message) => message.role === "tool");
    expect(toolTurn).toBeDefined();
    expect(typeof toolTurn?.tool_call_id).toBe("string");
    expect((toolTurn?.tool_call_id as string).length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "assistant_message" && event.message === "Your workspace has a.py.")).toBe(true);
  });

  it("does not execute a hallucinated tool name", async () => {
    let chatCalls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return jsonResponse({
          choices: [{ message: { content: '{"name":"execute","arguments":{"cmd":"rm -rf /"}}' } }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: "Retrying." } }] });
    }) as unknown as typeof fetch;

    const runtime = new NvidiaRuntime(fetcher);
    await runtime.configure({ provider: "nvidia", apiKey: "k", modelId: "meta/llama-3.3-70b-instruct" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct" });

    let executed = 0;
    const events: RuntimeEvent[] = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "meta/llama-3.3-70b-instruct",
        prompt: "do something",
        onToolCall: async () => {
          executed += 1;
          return { allowed: true, result: {} };
        },
      },
      async (event) => {
        events.push(event);
      },
    );

    expect(executed).toBe(0);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("maps 400/402/404/429/5xx correctly", async () => {
    const make = (status: number) =>
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/models")) {
          return jsonResponse(CATALOG);
        }
        return jsonResponse({ error: "x" }, status);
      }) as unknown as typeof fetch;

    const cases: Array<{ status: number; code: string; retryable?: boolean }> = [
      { status: 400, code: "invalid_configuration" },
      { status: 402, code: "provider_unavailable", retryable: false },
      { status: 404, code: "model_unavailable" },
      { status: 429, code: "provider_unavailable", retryable: true },
      { status: 503, code: "provider_unavailable", retryable: true },
    ];

    for (const testCase of cases) {
      const runtime = new NvidiaRuntime(make(testCase.status));
      await runtime.configure({ provider: "nvidia", apiKey: "k", modelId: "meta/llama-3.3-70b-instruct" });
      await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct" });
      await expect(
        runtime.sendMessage(
          { sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct", prompt: "hi" },
          async () => undefined,
        ),
      ).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it("rejects prompts without a selected model", async () => {
    const runtime = new NvidiaRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    await runtime.configure({ provider: "nvidia", apiKey: "k" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws" });
    await expect(
      runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("streams text deltas and cancels in-flight requests", async () => {
    const encoder = new TextEncoder();
    const sse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      return sse();
    }) as unknown as typeof fetch;

    const runtime = new NvidiaRuntime(fetcher);
    await runtime.configure({ provider: "nvidia", apiKey: "k", modelId: "meta/llama-3.3-70b-instruct" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "meta/llama-3.3-70b-instruct" });

    const deltas: string[] = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "meta/llama-3.3-70b-instruct",
        prompt: "hi",
        onStreamDelta: (text) => deltas.push(text),
      },
      async () => undefined,
    );
    expect(deltas.join("")).toBe("Hello");

    const abortingFetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new TypeError("aborted");
      }
      return jsonResponse(CATALOG);
    }) as unknown as typeof fetch;
    const aborting = new NvidiaRuntime(abortingFetcher);
    await aborting.configure({ provider: "nvidia", apiKey: "k" });
    const controller = new AbortController();
    controller.abort();
    await expect(aborting.discoverModels(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("isChatCapableNvidiaModel", () => {
  it("classifies chat vs specialised models without vendor-name exclusion", () => {
    expect(isChatCapableNvidiaModel("meta/llama-3.3-70b-instruct")).toBe(true);
    expect(isChatCapableNvidiaModel("qwen/qwen2.5-coder-32b-instruct")).toBe(true);
    expect(isChatCapableNvidiaModel("nvidia/llama-3.1-nemotron-70b-instruct")).toBe(true);
    expect(isChatCapableNvidiaModel("nvidia/nv-embedqa-e5-v5")).toBe(false);
    expect(isChatCapableNvidiaModel("nvidia/rerank-qa-mistral-4b")).toBe(false);
    expect(isChatCapableNvidiaModel("nvidia/parakeet-ctc-1.1b")).toBe(false);
    expect(isChatCapableNvidiaModel("black-forest-labs/flux.1-dev")).toBe(false);
    expect(isChatCapableNvidiaModel("   ")).toBe(false);
  });
});
