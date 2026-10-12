import {
  AgentRuntime,
  GeminiRuntimeConfig,
  ModelCapabilities,
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

/**
 * Fixed official Gemini OpenAI-compatible endpoint (Google AI Studio /
 * Generative Language API). Provider identity owns this URL; it is never a
 * user-editable arbitrary OpenAI-compatible endpoint.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/openai
 */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** How long a fetched catalog may serve capability lookups for inference. */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;

/** Raw /models entry from the Gemini OpenAI-compatible catalog (subset we use). */
interface GeminiModelPayload {
  readonly id?: string;
}

/**
 * Model-id patterns for Gemini models that cannot serve Spider's conversational
 * coding-agent workflow (embeddings, image/audio/video generation, live audio,
 * transcription, music, robotics, managed research agents, …).
 *
 * This is a *suitability* filter over the catalog the compatibility layer
 * exposes, not a capability inference: the compat `/models` response carries no
 * per-model capability metadata, so anything we cannot positively classify as a
 * chat model is excluded rather than advertised.
 */
const NON_CHAT_MODEL_PATTERNS: readonly RegExp[] = [
  /embedding/i,
  /(^|-)image($|-)/i,
  /tts/i,
  /audio/i,
  /(^|-)live($|-)/i,
  /transcribe/i,
  /veo/i,
  /lyria/i,
  /robotics/i,
  /computer-use/i,
  /deep-research/i,
  /antigravity/i,
  /(^|-)omni($|-)/i,
  /nano-banana/i,
  /imagen/i,
  /(^|-)aqa($|-)/i,
];

/**
 * Gemini runtime: live model discovery from the OpenAI-compatible catalog plus
 * OpenAI-compatible chat inference. Model discovery is deliberately separate
 * from the inference base class so the catalog mapping can evolve without
 * touching the shared agent loop. Provider-specific behavior (endpoint, auth,
 * catalog filtering, error taxonomy) lives here; transport is shared.
 */
export class GeminiRuntime implements AgentRuntime {
  readonly provider: RuntimeProvider = "gemini";
  readonly family: RuntimeProviderFamily = "inference";

  private readonly inference: OpenAICompatibleRuntime;
  private readonly fetcher: FetchLike;
  private modelId?: string;
  private catalogCache?: { models: RuntimeModel[]; fetchedAt: number };

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
    const options: OpenAICompatibleRuntimeOptions = {
      provider: "gemini",
      defaultBaseUrl: GEMINI_BASE_URL,
      baseUrlEditable: false,
    };
    this.inference = new OpenAICompatibleRuntime(fetcher, options);
  }

  async configure(config: GeminiRuntimeConfig): Promise<void> {
    // Keep the previously selected model when a reconnect omits modelId.
    const nextModelId = config.modelId ?? this.modelId;
    this.modelId = nextModelId;
    await this.inference.configure({
      provider: "openai-compatible",
      baseUrl: GEMINI_BASE_URL,
      modelId: nextModelId ?? "",
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async checkAvailability(signal?: AbortSignal): Promise<RuntimeAvailability> {
    if (!this.getApiKey()) {
      return {
        available: false,
        status: "disconnected",
        message: "Add your Gemini API key to connect.",
      };
    }
    try {
      const response = await this.request("/models", { method: "GET", signal });
      if (response.status === 401 || response.status === 403) {
        return {
          available: false,
          status: "error",
          message: "Gemini rejected the API key. Check the saved key and try again.",
        };
      }
      if (response.status === 429) {
        return {
          available: false,
          status: "error",
          message: "Gemini rate limit reached. Wait a moment and try again.",
        };
      }
      if (!response.ok) {
        return {
          available: false,
          status: "error",
          message: `Gemini returned HTTP ${response.status}.`,
        };
      }
      return { available: true, status: "connected", message: "Gemini is reachable." };
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "cancelled") {
        throw error;
      }
      return {
        available: false,
        status: "disconnected",
        message: "Could not reach Gemini. Check your network connection and try again.",
      };
    }
  }

  /**
   * Fetches the live Gemini model catalog. Always performs a fresh request so
   * "Refresh models" never shows stale data; the result feeds a short-lived
   * cache used for capability lookups during inference.
   */
  async discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const response = await this.request("/models", { method: "GET", signal });
    if (!response.ok) {
      throw mapCatalogError(response.status);
    }

    let payload: { data?: GeminiModelPayload[] };
    try {
      payload = (await response.json()) as { data?: GeminiModelPayload[] };
    } catch (error) {
      throw new RuntimeError("unknown", "Gemini returned a malformed model catalog.", { cause: error });
    }

    const raw = Array.isArray(payload.data) ? payload.data : [];
    if (raw.length === 0) {
      throw new RuntimeError("no_models_found", "Gemini returned an empty model catalog.");
    }

    const models = raw
      .map(toRuntimeModel)
      .filter((model): model is RuntimeModel => model !== undefined);

    if (models.length === 0) {
      throw new RuntimeError(
        "no_models_found",
        "Gemini returned no chat-capable models for this API key.",
      );
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
    if (!this.getApiKey()) {
      throw new RuntimeError(
        "authentication_failed",
        "Gemini API key is missing. Add your key in Settings before sending a prompt.",
      );
    }
    const modelId = request.modelId ?? this.modelId;
    if (!modelId) {
      throw new RuntimeError("model_unavailable", "Select a Gemini model before sending a prompt.");
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

  /** Drops a synthetic session's history (subagent runs). */
  disposeHistory(sessionId: string): void {
    this.inference.disposeHistory(sessionId);
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
        // Token streaming for Gemini too: same shared SSE consumer and stream
        // gate as the generic OpenAI-compatible base.
        stream: Boolean(onDelta),
        // Without this some OpenAI-compatible layers omit the terminal usage
        // chunk from SSE.
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
    const apiKey = this.getApiKey();
    if (apiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    try {
      return await this.fetcher(`${GEMINI_BASE_URL}${path}`, { ...init, headers });
    } catch (error) {
      if (init.signal?.aborted) {
        throw new RuntimeError("cancelled", "The Gemini request was cancelled.", { cause: error });
      }
      throw new RuntimeError(
        "network_error",
        "Could not reach Gemini. Check your network connection and try again.",
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

/** True when a Gemini model id names a model suited to the chat workflow. */
export function isChatCapableGeminiModel(rawId: string): boolean {
  const id = rawId.trim();
  if (id.length === 0) {
    return false;
  }
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

export function toRuntimeModel(raw: GeminiModelPayload): RuntimeModel | undefined {
  const id = typeof raw.id === "string" ? raw.id.trim().replace(/^models\//, "") : "";
  if (id.length === 0 || !isChatCapableGeminiModel(id)) {
    return undefined;
  }
  return {
    id,
    // The OpenAI-compatible catalog exposes no display name; the id is the
    // authoritative, provider-correct identifier.
    name: id,
    provider: "gemini",
    capabilities: {
      // Documented guarantees of the Gemini OpenAI-compatibility layer for
      // chat completions (not inferred from model names): SSE streaming,
      // function calling, and structured output are all documented. Vision is
      // left undefined because it varies per model and is not advertised by the
      // compatibility catalog.
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
    },
  };
}

function mapCatalogError(status: number): RuntimeError {
  if (status === 401 || status === 403) {
    return new RuntimeError("authentication_failed", "Gemini rejected the API key. Check the saved key and try again.");
  }
  if (status === 429) {
    return new RuntimeError("provider_unavailable", "Gemini rate limit reached. Wait a moment and try again.", { retryable: true });
  }
  return new RuntimeError("provider_unavailable", `Gemini returned HTTP ${status} while listing models.`, { retryable: status >= 500 });
}

function chatErrorFor(status: number, body: string): RuntimeError {
  const detail = body.length > 0 ? `: ${truncate(body, 200)}` : ".";
  if (status === 401 || status === 403) {
    return new RuntimeError("authentication_failed", "Gemini rejected the API key. Check the saved key and try again.");
  }
  if (status === 400) {
    return new RuntimeError("invalid_configuration", `Gemini rejected the request${detail}`);
  }
  if (status === 404) {
    return new RuntimeError("model_unavailable", `The selected Gemini model is unavailable${detail}`);
  }
  if (status === 429) {
    return new RuntimeError("provider_unavailable", "Gemini rate limit reached. Wait a moment and try again.", { retryable: true });
  }
  if (status >= 500) {
    return new RuntimeError("provider_unavailable", `Gemini chat failed with HTTP ${status}${detail}`, { retryable: true });
  }
  return new RuntimeError("unknown", `Gemini chat failed with HTTP ${status}${detail}`);
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
