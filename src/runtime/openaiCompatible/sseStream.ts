import type { ChatCompletion } from "../tools/inferenceAgentLoop";
import type { RuntimeToolCall } from "../runtimeTypes";
import { parseNativeToolCalls } from "../tools/parseToolCalls";
import { createStreamGate } from "../ollama/streamGate";

/** One parsed `data:` payload from an SSE chat-completions stream. */
interface SseChatChunk {
  readonly choices?: Array<{
    readonly delta?: {
      readonly content?: string;
      readonly tool_calls?: Array<{
        readonly index?: number;
        readonly id?: string;
        readonly type?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly total_tokens?: number };
}

/**
 * Consumes an OpenAI-compatible SSE chat stream and assembles the final
 * ChatCompletion. Safe text deltas are released through `onDelta` as they
 * arrive, guarded by the same stream gate Ollama uses so partial tool JSON
 * never reaches the UI. Tool-call fragments are buffered and merged by index
 * (the OpenAI streaming form) and only classified after the stream ends.
 *
 * Errors surface as typed RuntimeError values by the caller; aborts cancel
 * the body reader and throw the provider-neutral abort shape.
 */
export async function consumeOpenAiSseStream(
  response: Response,
  signal: AbortSignal | undefined,
  onDelta: ((text: string) => void) | undefined,
): Promise<ChatCompletion> {
  if (!response.body) {
    const payload = (await response.json()) as SseChatChunk & {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
    };
    return {
      content: payload.choices?.[0]?.message?.content ?? "",
      nativeToolCalls: [],
      ...(normalizeUsage(payload.usage) ? { usage: normalizeUsage(payload.usage) } : {}),
    };
  }

  const gate = createStreamGate(onDelta);
  const contentParts: string[] = [];
  const toolCallFragments = new Map<number, { id?: string; name?: string; arguments: string }>();
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleChunk = (chunk: SseChatChunk): void => {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta && typeof delta.content === "string" && delta.content.length > 0) {
      contentParts.push(delta.content);
      gate.push(delta.content);
    }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const fragment of delta.tool_calls) {
        const index = typeof fragment.index === "number" ? fragment.index : 0;
        const existing = toolCallFragments.get(index) ?? { arguments: "" };
        toolCallFragments.set(index, {
          id: fragment.id ?? existing.id,
          name: fragment.function?.name ?? existing.name,
          arguments: (existing.arguments ?? "") + (typeof fragment.function?.arguments === "string" ? fragment.function.arguments : ""),
        });
      }
    }
    const chunkUsage = normalizeUsage(chunk.usage);
    if (chunkUsage) {
      usage = chunkUsage;
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw createCancelled();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = parseSseDataLine(line);
        if (payload) {
          handleChunk(payload);
        }
      }
    }
    const trailing = parseSseDataLine(buffer);
    if (trailing) {
      handleChunk(trailing);
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw createCancelled();
    }
    throw error;
  } finally {
    gate.close();
  }

  // Merge the streamed OpenAI tool-call fragments into the wire shape the
  // parser expects ({id, name, arguments}); classification happens in
  // parseNativeToolCalls exactly as for non-streamed responses.
  const rawCalls = [...toolCallFragments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, fragment]) => fragment)
    .filter((fragment) => typeof fragment.name === "string" && fragment.name.length > 0)
    .map((fragment) => ({
      ...(fragment.id ? { id: fragment.id } : {}),
      name: fragment.name as string,
      arguments: fragment.arguments.length > 0 ? fragment.arguments : "{}",
    }));
  const nativeToolCalls: RuntimeToolCall[] = rawCalls.length > 0 ? parseNativeToolCalls(rawCalls) : [];

  return {
    content: contentParts.join(""),
    nativeToolCalls,
    ...(usage ? { usage } : {}),
  };
}

/** Parses one SSE line; returns undefined for comments, blanks, and `[DONE]`. */
function parseSseDataLine(line: string): SseChatChunk | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }
  const data = trimmed.slice(5).trim();
  if (data.length === 0 || data === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(data) as SseChatChunk;
  } catch {
    return undefined;
  }
}

function normalizeUsage(usage: SseChatChunk["usage"] | undefined) {
  if (!usage) {
    return undefined;
  }
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function createCancelled(): Error {
  const error = new Error("The chat stream was cancelled.");
  error.name = "AbortError";
  return error;
}
