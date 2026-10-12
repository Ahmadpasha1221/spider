import { describe, expect, it, vi } from "vitest";
import {
  GeminiRuntime,
  GEMINI_BASE_URL,
  isChatCapableGeminiModel,
} from "../../../../src/runtime/gemini/geminiRuntime";
import type { RuntimeEvent, RuntimeSendRequest, RuntimeToolCall } from "../../../../src/runtime/runtimeTypes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CATALOG = {
  data: [
    { id: "gemini-3.8-flash", object: "model", owned_by: "google" },
    { id: "gemini-2.5-pro", object: "model", owned_by: "google" },
    { id: "gemini-embedding-001", object: "model", owned_by: "google" },
    { id: "gemini-2.5-flash-image", object: "model", owned_by: "google" },
    { id: "gemini-3.8-flash-tts", object: "model", owned_by: "google" },
    { id: "gemini-2.5-flash-native-audio-preview-12-2025", object: "model", owned_by: "google" },
    { id: "veo-3.1-generate-preview", object: "model", owned_by: "google" },
    { id: "lyria-3.5", object: "model", owned_by: "google" },
    { id: "gemini-robotics-er-2-preview", object: "model", owned_by: "google" },
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

describe("GeminiRuntime", () => {
  it("reports the gemini provider identity", () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    expect(runtime.provider).toBe("gemini");
    expect(runtime.family).toBe("inference");
  });

  it("uses the fixed OpenAI-compatible Gemini endpoint", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return jsonResponse(CATALOG);
    }) as unknown as typeof fetch;

    const runtime = new GeminiRuntime(fetcher);
    await runtime.discoverModels();

    expect(GEMINI_BASE_URL).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(urls[0]).toBe(`${GEMINI_BASE_URL}/models`);
  });

  it("tags discovered models as gemini and filters out non-chat models", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    const models = await runtime.discoverModels();

    const ids = models.map((model) => model.id);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).not.toContain("gemini-embedding-001");
    expect(ids).not.toContain("gemini-2.5-flash-image");
    expect(ids).not.toContain("gemini-3.8-flash-tts");
    expect(ids).not.toContain("gemini-2.5-flash-native-audio-preview-12-2025");
    expect(ids).not.toContain("veo-3.1-generate-preview");
    expect(ids).not.toContain("lyria-3.5");
    expect(ids).not.toContain("gemini-robotics-er-2-preview");

    for (const model of models) {
      expect(model.provider).toBe("gemini");
      expect(model.name).toBe(model.id);
    }
  });

  it("does not overclaim vision capability", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    const [flash] = await runtime.discoverModels();
    expect(flash.capabilities?.streaming).toBe(true);
    expect(flash.capabilities?.toolCalling).toBe(true);
    expect(flash.capabilities?.structuredOutput).toBe(true);
    // Vision varies per model and is not advertised by the compat catalog.
    expect(flash.capabilities?.vision).toBeUndefined();
  });

  it("normalizes a models/ prefix on catalog ids", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse({ data: [{ id: "models/gemini-3.8-flash" }] })));
    const [model] = await runtime.discoverModels();
    expect(model.id).toBe("gemini-3.8-flash");
  });

  it("sends the API key as a bearer token and never in the URL", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)}|${new Headers(init?.headers).get("Authorization") ?? ""}`);
      return jsonResponse(CATALOG);
    }) as unknown as typeof fetch;

    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "AIza-secret" });
    await runtime.discoverModels();

    const [url, authorization] = seen[0].split("|");
    expect(url).toBe(`${GEMINI_BASE_URL}/models`);
    expect(authorization).toBe("Bearer AIza-secret");
    expect(url.includes("AIza-secret")).toBe(false);
  });

  it("reports authentication failure for invalid API keys", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse({ error: "invalid key" }, 401)));
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("reports rate limits as retryable", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse({}, 429)));
    await expect(runtime.discoverModels()).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("reports network failures and unavailable availability", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "k" });
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "network_error" });
    const availability = await runtime.checkAvailability();
    expect(availability.available).toBe(false);
    expect(availability.status).toBe("disconnected");
  });

  it("throws no_models_found for an empty catalog", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse({ data: [] })));
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "no_models_found" });
  });

  it("throws no_models_found when the catalog has no chat-capable models", async () => {
    const runtime = new GeminiRuntime(
      fetcherWith(() => jsonResponse({ data: [{ id: "gemini-embedding-001" }, { id: "veo-3.1-generate-preview" }] })),
    );
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "no_models_found" });
  });

  it("throws a malformed-catalog error for an unparsable body", async () => {
    const fetcher = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const runtime = new GeminiRuntime(fetcher);
    await expect(runtime.discoverModels()).rejects.toMatchObject({ code: "unknown" });
  });

  it("blocks inference without an API key", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });
    await expect(
      runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("uses the selected model and native tools for chat completions", async () => {
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

    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });

    const events: RuntimeEvent[] = [];
    await runtime.sendMessage(
      { sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash", prompt: "hi" },
      (event) => {
        events.push(event);
      },
    );

    expect(bodies[0].model).toBe("gemini-3.8-flash");
    expect(Array.isArray(bodies[0].tools)).toBe(true);
    expect(events.some((event) => event.type === "assistant_message" && event.message === "Hello")).toBe(true);
  });

  it("maps model_unavailable when the selected model is missing", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) {
        return jsonResponse(CATALOG);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-gone" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-gone" });
    await expect(
      runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-gone", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("maps 400 to a non-retryable configuration error and 5xx to retryable", async () => {
    const make = (status: number) =>
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/models")) {
          return jsonResponse(CATALOG);
        }
        return jsonResponse({ error: "bad" }, status);
      }) as unknown as typeof fetch;

    const bad = new GeminiRuntime(make(400));
    await bad.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    await bad.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });
    await expect(
      bad.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "invalid_configuration", retryable: false });

    const server = new GeminiRuntime(make(503));
    await server.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    await server.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });
    await expect(
      server.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("rejects prompts without a selected model", async () => {
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    await runtime.configure({ provider: "gemini", apiKey: "k" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws" });
    await expect(
      runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("preserves native tool-call ids across a multi-step tool flow", async () => {
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
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "call_123", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { content: "Your workspace has a.py." } }] });
    }) as unknown as typeof fetch;

    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });

    const calls: RuntimeToolCall[] = [];
    const events: RuntimeEvent[] = [];
    const request: RuntimeSendRequest = {
      sessionId: "s1",
      workspacePath: "/ws",
      modelId: "gemini-3.8-flash",
      prompt: "list files",
      onToolCall: async (call) => {
        calls.push(call);
        return { allowed: true, result: { success: true, files: ["a.py"] } };
      },
    };
    await runtime.sendMessage(request, async (event) => {
      events.push(event);
    });

    expect(calls[0]?.id).toBe("call_123");
    expect(calls[0]?.name).toBe("list_files");
    const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
    const toolTurn = secondMessages.find((message) => message.role === "tool");
    expect(toolTurn?.tool_call_id).toBe("call_123");
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
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "call_x", type: "function", function: { name: "execute", arguments: "{}" } }],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { content: "Sorry, retrying." } }] });
    }) as unknown as typeof fetch;

    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });

    let executed = 0;
    const events: RuntimeEvent[] = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "gemini-3.8-flash",
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

    // A tool name that is not in the registry is never executed and never
    // surfaces a real tool lifecycle; the run ends without dispatching it.
    expect(executed).toBe(0);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("normalizes streaming output and cancels in-flight requests", async () => {
    const encoder = new TextEncoder();
    const sse = new Response(
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
      return sse;
    }) as unknown as typeof fetch;

    const runtime = new GeminiRuntime(fetcher);
    await runtime.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });

    const deltas: string[] = [];
    await runtime.sendMessage(
      {
        sessionId: "s1",
        workspacePath: "/ws",
        modelId: "gemini-3.8-flash",
        prompt: "hi",
        onStreamDelta: (text) => deltas.push(text),
      },
      async () => undefined,
    );
    expect(deltas.join("")).toBe("Hello");

    // Cancellation: an aborted signal surfaces as a cancelled RuntimeError.
    const abortingFetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new TypeError("aborted");
      }
      return jsonResponse(CATALOG);
    }) as unknown as typeof fetch;
    const aborting = new GeminiRuntime(abortingFetcher);
    await aborting.configure({ provider: "gemini", apiKey: "k", modelId: "gemini-3.8-flash" });
    const controller = new AbortController();
    controller.abort();
    await expect(aborting.discoverModels(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("keeps an empty-key connect from reusing another provider's key", async () => {
    // Configuring Gemini without a key must not inherit a previously configured
    // OpenAI-compatible key held by a different runtime instance.
    const runtime = new GeminiRuntime(fetcherWith(() => jsonResponse(CATALOG)));
    await runtime.configure({ provider: "gemini", modelId: "gemini-3.8-flash" });
    await runtime.createSession({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash" });
    await expect(
      runtime.sendMessage({ sessionId: "s1", workspacePath: "/ws", modelId: "gemini-3.8-flash", prompt: "hi" }, async () => undefined),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });
});

describe("isChatCapableGeminiModel", () => {
  it("classifies chat vs specialised models", () => {
    expect(isChatCapableGeminiModel("gemini-3.8-flash")).toBe(true);
    expect(isChatCapableGeminiModel("gemini-2.5-pro")).toBe(true);
    expect(isChatCapableGeminiModel("gemini-embedding-001")).toBe(false);
    expect(isChatCapableGeminiModel("gemini-2.5-flash-image")).toBe(false);
    expect(isChatCapableGeminiModel("veo-3.1-generate-preview")).toBe(false);
    expect(isChatCapableGeminiModel("   ")).toBe(false);
  });
});
