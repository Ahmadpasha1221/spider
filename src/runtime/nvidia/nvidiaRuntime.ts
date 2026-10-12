import {
  AgentRuntime,
  ModelCapabilities,
  NvidiaRuntimeConfig,
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
 * Fixed hosted NVIDIA API Catalog endpoint (the cloud-hosted NIM catalog).
 *
 * This is deliberately NOT a self-hosted NIM container, a local OpenAI-compatible
 * server, or some other NVIDIA cloud product: the provider identity owns this
 * URL and it is never user-editable.
 *
 * Docs: https://docs.api.nvidia.com/nim/reference/llm-apis
 *       https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
 */
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** How long a fetched catalog may serve capability lookups for inference. */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;

/** Raw /models entry from the NVIDIA API Catalog (subset we use). */
interface NvidiaModelPayload {
  readonly id?: string;
}

/**
 * Model-id patterns for catalog entries that cannot serve Spider's
 * conversational coding-agent workflow: embedding/reranking/retrieval,
 * text-to-speech and ASR, image/video generation, vision task models
 * (segmentation/detection/OCR), and molecular/bio task models.
 *
 * This is a *suitability* filter over the catalog the API exposes, not a
 * capability inference: the hosted `/v1/models` response carries no per-model
 * capability metadata, so anything we cannot positively treat as a chat model
 * is excluded rather than advertised. It never excludes a model merely because
 * its id contains a vendor or family name (the catalog hosts many non-NVIDIA
 * model families such as `meta/`, `mistralai/`, `qwen/`, `deepseek-ai/`).
 */
const NON_CHAT_MODEL_PATTERNS: readonly RegExp[] = [
  /embed/i,
  /rerank/i,
  /retriev/i,
  /parakeet/i,
  /\briva\b/i,
  /\btts\b/i,
  /\basr\b/i,
  /audio/i,
  /speech/i,
  /diffusion/i,
  /sdxl/i,
  /stable-diffusion/i,
  /consistory/i,
  /flux/i,
  /\bimage/i,
  /video/i,
  /cosmos/i,
  /deplot/i,
  /\bocr/i,
  /segformer/i,
  /segmentation/i,
  /detection/i,
  /yolo/i,
  /monai/i,
  /sam2/i,
  /nv-?clip/i,
  /\besm\b/i,
  /molmim/i,
  /genmol/i,
  /diffdock/i,
  /protein/i,
  /translate/i,
  /nemoguard/i,
  /\bguard\b/i,
  /moderation/i,
];

/**
 * NVIDIA runtime: live model discovery from the hosted API Catalog plus
 * OpenAI-compatible chat inference. Model discovery is deliberately separate
 * from the inference base class so the catalog mapping can evolve without
 * touching the shared agent loop. Provider-specific behavior (endpoint, auth,
 * catalog filtering, error taxonomy) lives here; transport is shared.
 */
export class NvidiaRuntime implements AgentRuntime {
  readonly provider: RuntimeProvider = "nvidia";
  readonly family: RuntimeProviderFamily = "inference";

  private readonly inference: OpenAICompatibleRuntime;
  private readonly fetcher: FetchLike;
  private modelId?: string;
  private catalogCache?: { models: RuntimeModel[]; fetchedAt: number };

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
    const options: OpenAICompatibleRuntimeOptions = {
      provider: "nvidia",
      defaultBaseUrl: NVIDIA_BASE_URL,
      baseUrlEditable: false,
    };
    this.inference = new OpenAICompatibleRuntime(fetcher, options);
  }

  async configure(config: NvidiaRuntimeConfig): Promise<void> {
    // Keep the previously selected model when a reconnect omits modelId.
    const nextModelId = config.modelId ?? this.modelId;
    this.modelId = nextModelId;
    await this.inference.configure({
      provider: "openai-compatible",
      baseUrl: NVIDIA_BASE_URL,
      modelId: nextModelId ?? "",
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  async checkAvailability(signal?: AbortSignal): Promise<RuntimeAvailability> {
    if (!this.getApiKey()) {
      return {
        available: false,
        status: "disconnected",
        message: "Add your NVIDIA API key to connect.",
      };
    }
    try {
      const response = await this.request("/models", { method: "GET", signal });
      if (response.status === 401 || response.status === 403) {
        return {
          available: false,
          status: "error",
          message: "NVIDIA rejected the API key. Check the saved key and try again.",
        };
      }
      if (response.status === 429) {
        return {
          available: false,
          status: "error",
          message: "NVIDIA rate limit reached. Wait a moment and try again.",
        };
      }
      if (!response.ok) {
        return {
          available: false,
          status: "error",
          message: `NVIDIA returned HTTP ${response.status}.`,
        };
      }
      return { available: true, status: "connected", message: "NVIDIA is reachable." };
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "cancelled") {
        throw error;
      }
      return {
        available: false,
        status: "disconnected",
        message: "Could not reach NVIDIA. Check your network connection and try again.",
      };
    }
  }

  /**
   * Fetches the live NVIDIA API Catalog. Always performs a fresh request so
   * "Refresh models" never shows stale data; the result feeds a short-lived
   * cache used for capability lookups during inference.
   */
  async discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const response = await this.request("/models", { method: "GET", signal });
    if (!response.ok) {
      throw mapCatalogError(response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new RuntimeError("unknown", "NVIDIA returned a malformed model catalog.", { cause: error });
    }

    const raw = extractCatalogEntries(payload);
    if (raw.length === 0) {
      throw new RuntimeError("no_models_found", "NVIDIA returned an empty model catalog.");
    }

    const models = raw
      .map(toRuntimeModel)
      .filter((model): model is RuntimeModel => model !== undefined);

    if (models.length === 0) {
      throw new RuntimeError(
        "no_models_found",
        "NVIDIA returned no chat-capable models for this API key.",
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
        "NVIDIA API key is missing. Add your key in Settings before sending a prompt.",
      );
    }
    const modelId = request.modelId ?? this.modelId;
    if (!modelId) {
      throw new RuntimeError("model_unavailable", "Select an NVIDIA model before sending a prompt.");
    }
    // Capability-driven tool calling: from catalog metadata, not model-name
    // checks. The hosted catalog exposes no per-model capability metadata, so
    // native tool calling is NOT advertised (documented as model-dependent by
    // NVIDIA) and Spider uses its existing safe text-tool fallback until a
    // model's behavior is verified.
    const capabilities = await this.capabilitiesFor(modelId, request.signal);
    const nativeTools = capabilities?.toolCalling ?? false;
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
      // Catalog is advisory at inference time; stay conservative when unknown.
      return undefined;
    }
  }

  private async completeChat(
    modelId: string,
    messages: readonly ChatTurn[],
    signal?: AbortSignal,
    nativeTools = false,
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
        // Token streaming for NVIDIA too: same shared SSE consumer and stream
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
      // Some NIM deployments return tool_call arguments as a parsed object; the
      // shared parser accepts both object and JSON-string forms.
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
      return await this.fetcher(`${NVIDIA_BASE_URL}${path}`, { ...init, headers });
    } catch (error) {
      if (init.signal?.aborted) {
        throw new RuntimeError("cancelled", "The NVIDIA request was cancelled.", { cause: error });
      }
      throw new RuntimeError(
        "network_error",
        "Could not reach NVIDIA. Check your network connection and try again.",
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

/**
 * Accepts the OpenAI-style `{ data: [...] }` envelope the hosted catalog
 * returns, and tolerates a bare array (some NIM deployments).
 */
function extractCatalogEntries(payload: unknown): NvidiaModelPayload[] {
  if (Array.isArray(payload)) {
    return payload as NvidiaModelPayload[];
  }
  if (typeof payload === "object" && payload !== null) {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data as NvidiaModelPayload[];
    }
  }
  return [];
}

/** True when an NVIDIA catalog id names a model suited to the chat workflow. */
export function isChatCapableNvidiaModel(rawId: string): boolean {
  const id = rawId.trim();
  if (id.length === 0) {
    return false;
  }
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

export function toRuntimeModel(raw: NvidiaModelPayload): RuntimeModel | undefined {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0 || !isChatCapableNvidiaModel(id)) {
    return undefined;
  }
  return {
    id,
    // The hosted catalog exposes no display name; the id is the authoritative,
    // provider-correct identifier.
    name: id,
    provider: "nvidia",
    capabilities: {
      // Streaming is part of the documented OpenAI-compatible chat API. Native
      // tool calling and structured output are documented but model-dependent
      // and the catalog exposes no per-model metadata, so they are NOT
      // advertised here — Spider uses its existing safe text-tool fallback.
      // Vision is model-dependent and likewise not advertised.
      streaming: true,
      toolCalling: false,
      structuredOutput: false,
    },
  };
}

function mapCatalogError(status: number): RuntimeError {
  if (status === 401 || status === 403) {
    return new RuntimeError("authentication_failed", "NVIDIA rejected the API key. Check the saved key and try again.");
  }
  if (status === 429) {
    return new RuntimeError("provider_unavailable", "NVIDIA rate limit reached. Wait a moment and try again.", { retryable: true });
  }
  return new RuntimeError("provider_unavailable", `NVIDIA returned HTTP ${status} while listing models.`, { retryable: status >= 500 });
}

function chatErrorFor(status: number, body: string): RuntimeError {
  const detail = body.length > 0 ? `: ${truncate(body, 200)}` : ".";
  if (status === 401 || status === 403) {
    // NVIDIA uses 403 both for invalid keys and for a key without access to a
    // specific model/permission; the message stays actionable for both.
    return new RuntimeError(
      "authentication_failed",
      "NVIDIA rejected the request. Check that the API key is valid and has access to the selected model.",
    );
  }
  if (status === 400) {
    return new RuntimeError("invalid_configuration", `NVIDIA rejected the request${detail}`);
  }
  if (status === 402) {
    return new RuntimeError("provider_unavailable", `NVIDIA quota may be exhausted${detail}`, { retryable: false });
  }
  if (status === 404) {
    return new RuntimeError("model_unavailable", `The selected NVIDIA model is unavailable${detail}`);
  }
  if (status === 429) {
    return new RuntimeError("provider_unavailable", "NVIDIA rate limit reached. Wait a moment and try again.", { retryable: true });
  }
  if (status >= 500) {
    return new RuntimeError("provider_unavailable", `NVIDIA chat failed with HTTP ${status}${detail}`, { retryable: true });
  }
  return new RuntimeError("unknown", `NVIDIA chat failed with HTTP ${status}${detail}`);
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
