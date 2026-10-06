import {
  AgentRuntime,
  OllamaRuntimeConfig,
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
import { ChatTurn, runInferenceAgentLoop } from "../tools/inferenceAgentLoop";
import { nativeChatTools } from "../tools/toolRegistry";
import { availableToolNames, type AgentMode } from "../tools/toolAvailability";
import { modelSupportsNativeTools } from "../tools/textToolFallback";
import { parseNativeToolCalls } from "../tools/parseToolCalls";
import { createStreamGate } from "./streamGate";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

type FetchLike = typeof fetch;

export class OllamaRuntime implements AgentRuntime {
  readonly provider: RuntimeProvider = "ollama";
  readonly family: RuntimeProviderFamily = "inference";

  private baseUrl = DEFAULT_OLLAMA_BASE_URL;
  private modelId?: string;
  private readonly histories = new Map<string, ChatTurn[]>();
  private readonly fetcher: FetchLike;

  constructor(fetcher: FetchLike = fetch) {
    this.fetcher = fetcher;
  }

  async configure(config: OllamaRuntimeConfig): Promise<void> {
    const modelChanged = this.modelId !== undefined && config.modelId !== undefined && this.modelId !== config.modelId;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.modelId = config.modelId;
    if (modelChanged) {
      this.histories.clear();
    }
  }

  async checkAvailability(signal?: AbortSignal): Promise<RuntimeAvailability> {
    try {
      const response = await this.request("/api/tags", { method: "GET", signal });
      if (!response.ok) {
        return {
          available: false,
          status: "error",
          message: `Ollama returned HTTP ${response.status}. Is the server running?`,
        };
      }
      return { available: true, status: "connected", message: "Ollama is running." };
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new RuntimeError("cancelled", "Ollama availability check was cancelled.", { cause: error });
      }
      return {
        available: false,
        status: "disconnected",
        message: "Ollama is not reachable at " + this.baseUrl + ". Start Ollama and try again.",
      };
    }
  }

  async discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const availability = await this.checkAvailability(signal);
    if (!availability.available) {
      throw new RuntimeError("provider_unavailable", availability.message ?? "Ollama is not available.");
    }

    const response = await this.request("/api/tags", { method: "GET", signal });
    if (!response.ok) {
      throw new RuntimeError("provider_unavailable", `Ollama returned HTTP ${response.status} while listing models.`);
    }

    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string; details?: { family?: string } }> };
    const raw = Array.isArray(payload.models) ? payload.models : [];
    const models: RuntimeModel[] = [];
    for (const model of raw) {
      const id = model.name ?? model.model;
      if (!id) {
        continue;
      }
      models.push({
        id,
        name: id,
        provider: "ollama",
        capabilities: {
          streaming: true,
          toolCalling: modelSupportsNativeTools(id),
          structuredOutput: false,
          codeEditing: false,
          reasoning: model.details?.family?.includes("qwen3") ?? false,
        },
      });
    }
    return models;
  }

  async createSession(request: RuntimeSessionRequest): Promise<{ providerSessionId?: string }> {
    this.histories.set(request.sessionId, []);
    if (request.modelId) {
      this.modelId = request.modelId;
    }
    return { providerSessionId: request.sessionId };
  }

  async resumeSession(request: RuntimeResumeRequest): Promise<{ providerSessionId?: string }> {
    if (!this.histories.has(request.sessionId)) {
      this.histories.set(request.sessionId, []);
    }
    if (request.modelId) {
      this.modelId = request.modelId;
    }
    return { providerSessionId: request.providerSessionId };
  }

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    const modelId = request.modelId ?? this.modelId;
    if (!modelId) {
      throw new RuntimeError("model_unavailable", "Select an Ollama model before sending a prompt.");
    }

    const history = this.histories.get(request.sessionId) ?? [];
    this.histories.set(request.sessionId, history);

    const nativeTools = modelSupportsNativeTools(modelId);
    await this.ensureModelSupports(request, modelId);
    const streamDelta = request.onStreamDelta;
    await runInferenceAgentLoop(
      request,
      history,
      (messages, signal) => this.completeChat(modelId, messages, signal, nativeTools, request.mode, streamDelta, request.usageDeltaSink),
      emit,
      { nativeTools, mode: request.mode },
    );
  }

  /** Capability gate: fail fast with a typed error instead of a confusing upstream failure. */
  private async ensureModelSupports(request: RuntimeSendRequest, modelId: string): Promise<void> {
    if (!request.onStreamDelta) {
      return;
    }
    const capabilities = await this.capabilitiesFor(modelId, request.signal);
    if (capabilities && !capabilities.streaming) {
      throw new RuntimeError("unsupported_capability", `Model ${modelId} does not support streaming.`, { details: { capability: "streaming", modelId } });
    }
  }

  private async capabilitiesFor(modelId: string, signal?: AbortSignal): Promise<RuntimeModel["capabilities"]> {
    try {
      const models = await this.discoverModels(signal);
      return models.find((model) => model.id === modelId)?.capabilities;
    } catch {
      return undefined;
    }
  }

  async cancel(_request: RuntimeCancelRequest): Promise<void> {}

  restoreHistory(sessionId: string, turns: readonly RestoredHistoryTurn[]): boolean {
    const history = this.histories.get(sessionId);
    if (history && history.length > 0) {
      return false;
    }
    this.histories.set(
      sessionId,
      turns.map((turn) => ({ role: turn.role, content: turn.content })),
    );
    return true;
  }

  /** Drops a synthetic session's history (subagent runs) so it cannot leak. */
  disposeHistory(sessionId: string): void {
    this.histories.delete(sessionId);
  }

  dispose(): void {
    this.histories.clear();
  }

  private async completeChat(
    modelId: string,
    messages: readonly ChatTurn[],
    signal?: AbortSignal,
    toolsEnabled = false,
    mode?: AgentMode,
    onDelta?: (text: string) => void,
    onUsage?: (usage: RuntimeUsage) => void,
  ) {
    const payload: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: true,
    };
    if (toolsEnabled) {
      payload.tools = nativeChatTools(availableToolNames(mode));
    }

    let response = await this.request("/api/chat", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      response = await this.request("/api/chat", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId, messages, stream: true }),
      });
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new RuntimeError(
        response.status === 404 ? "model_unavailable" : "unknown",
        detail || `Ollama chat failed with HTTP ${response.status}.`,
      );
    }

    let content = "";
    let usage: RuntimeUsage | undefined;
    const native: unknown[] = [];
    // Classify-before-render: stream chunks are buffered while a tool protocol
    // fragment may be open, so partial JSON like {"name":"fin never reaches
    // the UI. Safe text is released as soon as it is known to be safe.
    const streamGate = createStreamGate(onDelta);
    try {
      for await (const chunk of readNdjson(response, signal)) {
        const delta = extractOllamaContent(chunk);
        streamGate.push(delta);
        content += delta;
        const calls = extractOllamaToolCalls(chunk);
        if (calls) {
          native.push(...calls);
        }
        const chunkUsage = extractOllamaUsage(chunk);
        if (chunkUsage) {
          usage = chunkUsage;
          // Ollama reports totals on the final NDJSON line; surface them live
          // too. The returned completion usage stays authoritative.
          onUsage?.(chunkUsage);
        }
      }
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new RuntimeError("cancelled", "The Ollama run was cancelled.", { cause: error });
      }
      throw toRuntimeError(error);
    }
    streamGate.close();

    return {
      content,
      nativeToolCalls: parseNativeToolCalls(native),
      ...(usage ? { usage } : {}),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await this.fetcher(url, init);
    } catch (error) {
      if (isAbortError(error, init.signal ?? undefined)) {
        throw new RuntimeError("cancelled", "The Ollama request was cancelled.", { cause: error });
      }
      throw new RuntimeError("network_error", `Could not reach Ollama at ${this.baseUrl}.`, {
        retryable: true,
        cause: error,
      });
    }
  }
}

function normalizeBaseUrl(value?: string): string {
  const raw = (value && value.trim().length > 0 ? value : DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  return raw;
}

function extractOllamaToolCalls(chunk: unknown): unknown[] | undefined {
  if (!isRecord(chunk)) {
    return undefined;
  }
  const message = chunk.message;
  if (isRecord(message) && Array.isArray(message.tool_calls)) {
    return message.tool_calls;
  }
  return undefined;
}

/**
 * The stream gate lives in its own module so the OpenAI-compatible SSE path
 * reuses the exact same protocol-safety logic. Re-exported here to keep the
 * historical import path (and its tests) working.
 */
export { createStreamGate } from "./streamGate";

function extractOllamaUsage(chunk: unknown): RuntimeUsage | undefined {
  if (!isRecord(chunk)) {
    return undefined;
  }
  const prompt = typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : undefined;
  const completion = typeof chunk.eval_count === "number" ? chunk.eval_count : undefined;
  if (prompt === undefined && completion === undefined) {
    return undefined;
  }
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function extractOllamaContent(chunk: unknown): string {
  if (!isRecord(chunk)) {
    return "";
  }
  const message = chunk.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content;
  }
  if (typeof chunk.response === "string") {
    return chunk.response;
  }
  return "";
}

async function* readNdjson(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) {
    const text = await response.text();
    if (text.trim().length > 0) {
      yield JSON.parse(text) as unknown;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new RuntimeError("cancelled", "The Ollama stream was cancelled.");
    }
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      yield JSON.parse(trimmed) as unknown;
    }
  }

  const trailing = buffer.trim();
  if (trailing.length > 0) {
    yield JSON.parse(trailing) as unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }
  return new RuntimeError("unknown", error instanceof Error ? error.message : "Ollama request failed.", { cause: error });
}
