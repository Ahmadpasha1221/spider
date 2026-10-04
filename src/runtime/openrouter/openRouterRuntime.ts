import {
  AgentRuntime,
  ModelCapabilities,
  ModelPricing,
  OpenRouterRuntimeConfig,
  RestoredHistoryTurn,
  RuntimeAvailability,
  RuntimeCancelRequest,
  RuntimeError,
  RuntimeEventSink,
  RuntimeModel,
  RuntimeProvider,
  RuntimeProviderFamily,
  RuntimeResumeRequest,
  RuntimeSendRequest,
  RuntimeSessionRequest,
  RuntimeUsage,
} from "../runtimeTypes";
import { ChatTurn, ChatCompletion, runInferenceAgentLoop } from "../tools/inferenceAgentLoop";
import { nativeChatTools } from "../tools/toolRegistry";
import { availableToolNames, type AgentMode } from "../tools/toolAvailability";
import { parseNativeToolCalls } from "../tools/parseToolCalls";
import {
  OpenAICompatibleRuntime,
  type OpenAICompatibleRuntimeOptions,
} from "../openaiCompatible/openaiCompatibleRuntime";
import { toOpenAiMessages } from "../openaiCompatible/openAiMessages";
import { consumeOpenAiSseStream } from "../openaiCompatible/sseStream";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** How long a fetched catalog may serve capability lookups for inference. */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;

/** Raw /models entry from the OpenRouter catalog (subset of fields we use). */
interface OpenRouterModelPayload {
  readonly id?: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly architecture?: {
    readonly input_modalities?: readonly string[];
    readonly output_modalities?: readonly string[];
  };
  readonly supported_parameters?: readonly string[];
  readonly pricing?: {
    readonly prompt?: string;
    readonly completion?: string;
  };
}

/**
 * OpenRouter runtime: live model discovery from the public catalog plus
 * OpenAI-compatible chat inference. Model discovery is deliberately separate
 * from the inference base class so the catalog mapping can evolve without
 * touching the shared agent loop.
 */
export class OpenRouterRuntime implements AgentRuntime {
  readonly provider: RuntimeProvider = "openrouter";
  readonly family: RuntimeProviderFamily = "inference";

  private readonly inference: OpenAICompatibleRuntime;
  private readonly fetcher: FetchLike;
  private modelId?: string;
  private catalogCache?: { models: RuntimeModel[]; fetchedAt: number };

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
    const options: OpenAICompatibleRuntimeOptions = {
      provider: "openrouter",
      defaultBaseUrl: OPENROUTER_BASE_URL,
      baseUrlEditable: false,
    };
    this.inference = new OpenAICompatibleRuntime(fetcher, options);
  }

  async configure(config: OpenRouterRuntimeConfig): Promise<void> {
    // Keep the previously selected model when a reconnect omits modelId.
    const nextModelId = config.modelId ?? this.modelId;
    this.modelId = nextModelId;
    await this.inference.configure({
      provider: "openai-compatible",
      baseUrl: OPENROUTER_BASE_URL,
      modelId: nextModelId ?? "",
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async checkAvailability(signal?: AbortSignal): Promise<RuntimeAvailability> {
    try {
      const response = await this.request("/models", { method: "GET", signal });
      if (response.status === 401 || response.status === 403) {
        return {
          available: false,
          status: "error",
          message: "OpenRouter rejected the API key. Check the saved key and try again.",
        };
      }
      if (response.status === 429) {
        return {
          available: false,
          status: "error",
          message: "OpenRouter rate limit reached. Wait a moment and try again.",
        };
      }
      if (!response.ok) {
        return {
          available: false,
          status: "error",
          message: `OpenRouter returned HTTP ${response.status}.`,
        };
      }
      return { available: true, status: "connected", message: "OpenRouter is reachable." };
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "cancelled") {
        throw error;
      }
      return {
        available: false,
        status: "disconnected",
        message: "OpenRouter is unreachable. Check your network connection and try again.",
      };
    }
  }

  /**
   * Fetches the live OpenRouter catalog. Always performs a fresh request so
   * "Refresh models" never shows stale data; the result feeds a short-lived
   * cache used for capability lookups during inference.
   */
  async discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const response = await this.request("/models", { method: "GET", signal });
    if (!response.ok) {
      throw mapCatalogError(response.status);
    }

    let payload: { data?: OpenRouterModelPayload[] };
    try {
      payload = (await response.json()) as { data?: OpenRouterModelPayload[] };
    } catch (error) {
      throw new RuntimeError("unknown", "OpenRouter returned a malformed model catalog.", { cause: error });
    }

    const raw = Array.isArray(payload.data) ? payload.data : [];
    const models = raw
      .map(toRuntimeModel)
      .filter((model): model is RuntimeModel => model !== undefined);

    if (models.length === 0) {
      throw new RuntimeError("no_models_found", "OpenRouter returned an empty model catalog.");
    }
    this.catalogCache = { models, fetchedAt: Date.now() };
    return models;
  }

  async createSession(request: RuntimeSessionRequest): Promise<{ providerSessionId?: string }> {
    if (request.modelId) {
      this.modelId = request.modelId;
    }
    return this.inference.createSession({ ...request, modelId: request.modelId ?? this.modelId });
  }

  async resumeSession(request: RuntimeResumeRequest): Promise<{ providerSessionId?: string }> {
    if (request.modelId) {
      this.modelId = request.modelId;
    }
    return this.inference.resumeSession({ ...request, modelId: request.modelId ?? this.modelId });
  }

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    const modelId = request.modelId ?? this.modelId;
    if (!modelId) {
      throw new RuntimeError("model_unavailable", "Select an OpenRouter model before sending a prompt.");
    }
    // Capability-driven tool calling: from catalog metadata, not model-name checks.
    const capabilities = await this.capabilitiesFor(modelId, request.signal);
    const nativeTools = capabilities?.toolCalling ?? true;
    if (request.onStreamDelta && capabilities && !capabilities.streaming) {
      throw new RuntimeError(
        "unsupported_capability",
        `Model ${modelId} does not support streaming.`,
        { details: { capability: "streaming", modelId } },
      );
    }
    const streamDelta = request.onStreamDelta;
    await runInferenceAgentLoop(
      request,
      this.historyFor(request.sessionId),
      (messages, signal) => this.completeChat(modelId, messages, signal, nativeTools, request.mode, streamDelta, request.usageDeltaSink),
      emit,
      { nativeTools, mode: request.mode },
    );
  }

  private historyFor(sessionId: string): ChatTurn[] {
    // The inference runtime owns histories; expose the same map by key.
    return this.inference.historyFor(sessionId);
  }

  restoreHistory(sessionId: string, turns: readonly RestoredHistoryTurn[]): boolean {
    return this.inference.restoreHistory(sessionId, turns);
  }

  async cancel(request: RuntimeCancelRequest): Promise<void> {
    await this.inference.cancel(request);
  }

  dispose(): void {
    this.inference.dispose();
  }

  private async capabilitiesFor(modelId: string, signal?: AbortSignal): Promise<ModelCapabilities | undefined> {
    const cached = this.catalogCache;
    if (cached && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
      return cached.models.find((model) => model.id === modelId)?.capabilities;
    }
    try {
      const models = await this.discoverModels(signal);
      return models.find((model) => model.id === modelId)?.capabilities;
    } catch {
      // Catalog is advisory at inference time; assume native tools when unknown.
      return undefined;
    }
  }

  private async completeChat(
    modelId: string,
    messages: readonly ChatTurn[],
    signal?: AbortSignal,
    nativeTools = true,
    mode?: AgentMode,
    onDelta?: (text: string) => void,
    onUsage?: (usage: RuntimeUsage) => void,
  ): Promise<ChatCompletion> {
    const response = await this.request("/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(onDelta ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: toOpenAiMessages(messages),
        // Token streaming for OpenRouter too: same shared SSE consumer and
        // stream gate as the generic OpenAI-compatible base.
        stream: Boolean(onDelta),
        // Without this OpenRouter omits the terminal usage chunk from SSE.
        ...(onDelta ? { stream_options: { include_usage: true } } : {}),
        ...(nativeTools ? { tools: nativeChatTools(availableToolNames(mode)) } : {}),
      }),
    });

    if (!response.ok) {
      throw chatErrorFor(response.status, await safeBodyText(response));
    }

    if (onDelta) {
      return consumeOpenAiSseStream(response, signal, onDelta, onUsage);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = payload.choices?.[0]?.message;
    const usage = normalizeOpenAiUsage(payload.usage);
    return {
      content: message?.content ?? "",
      nativeToolCalls: parseNativeToolCalls(message?.tool_calls),
      ...(usage ? { usage } : {}),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const apiKey = await this.getApiKey();
    if (apiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    try {
      return await this.fetcher(`${OPENROUTER_BASE_URL}${path}`, { ...init, headers });
    } catch (error) {
      if (init.signal?.aborted) {
        throw new RuntimeError("cancelled", "The OpenRouter request was cancelled.", { cause: error });
      }
      throw new RuntimeError(
        "network_error",
        "Could not reach OpenRouter. Check your network connection and try again.",
        { retryable: true, cause: error },
      );
    }
  }

  private getApiKey(): string | undefined {
    return this.inference.getApiKey();
  }
}

function normalizeOpenAiUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined) {
  if (!usage) {
    return undefined;
  }
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function toRuntimeModel(raw: OpenRouterModelPayload): RuntimeModel | undefined {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0) {
    return undefined;
  }
  const inputModalities = raw.architecture?.input_modalities ?? [];
  const supportedParameters = raw.supported_parameters ?? [];
  const pricing = toPricing(raw.pricing);
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : id,
    provider: "openrouter",
    ...(typeof raw.context_length === "number" && raw.context_length > 0 ? { contextWindow: raw.context_length } : {}),
    capabilities: {
      streaming: true,
      toolCalling: supportedParameters.includes("tools") || supportedParameters.includes("tool_choice"),
      structuredOutput: supportedParameters.includes("structured_outputs") || supportedParameters.includes("response_format"),
      vision: inputModalities.includes("image"),
    },
    ...(pricing ? { pricing } : {}),
  };
}

function toPricing(raw: OpenRouterModelPayload["pricing"]): ModelPricing | undefined {
  const prompt = pricePerMillion(raw?.prompt);
  const completion = pricePerMillion(raw?.completion);
  if (prompt === undefined && completion === undefined) {
    return undefined;
  }
  return {
    ...(prompt !== undefined ? { promptUsdPerMillion: prompt } : {}),
    ...(completion !== undefined ? { completionUsdPerMillion: completion } : {}),
  };
}

/** OpenRouter prices are USD strings per token; convert to per-million. */
function pricePerMillion(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.round(parsed * 1_000_000 * 1000) / 1000;
}

function mapCatalogError(status: number): RuntimeError {
  if (status === 401 || status === 403) {
    return new RuntimeError("authentication_failed", "OpenRouter rejected the API key. Check the saved key and try again.");
  }
  if (status === 429) {
    return new RuntimeError("provider_unavailable", "OpenRouter rate limit reached. Wait a moment and try again.", { retryable: true });
  }
  return new RuntimeError("provider_unavailable", `OpenRouter returned HTTP ${status} while listing models.`, { retryable: status >= 500 });
}

function chatErrorFor(status: number, body: string): RuntimeError {
  const detail = body.length > 0 ? `: ${truncate(body, 200)}` : ".";
  if (status === 401 || status === 403) {
    return new RuntimeError("authentication_failed", "OpenRouter rejected the API key. Check the saved key and try again.");
  }
  if (status === 429) {
    return new RuntimeError("provider_unavailable", "OpenRouter rate limit reached. Wait a moment and try again.", { retryable: true });
  }
  if (status === 404) {
    return new RuntimeError("model_unavailable", `The selected OpenRouter model is unavailable${detail}`);
  }
  if (status >= 500) {
    return new RuntimeError("provider_unavailable", `OpenRouter chat failed with HTTP ${status}${detail}`, { retryable: true });
  }
  return new RuntimeError("unknown", `OpenRouter chat failed with HTTP ${status}${detail}`);
}

async function safeBodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
