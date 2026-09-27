/**
 * Shared streaming gate: buffers model output while it could be part of a
 * tool-protocol fragment (e.g. `{"name":"fin`), then releases only
 * classified-safe text to the UI. Ollama and the OpenAI-compatible SSE path
 * both use it so partial tool JSON never reaches the chat.
 */
export function createStreamGate(onDelta?: (text: string) => void): {
  push(text: string): void;
  close(): void;
} {
  let buffer = "";
  let pendingEmit = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushPending = (): void => {
    if (pendingEmit.length > 0 && onDelta) {
      onDelta(pendingEmit);
    }
    pendingEmit = "";
  };

  return {
    push(text) {
      if (text.length === 0) {
        return;
      }
      buffer += text;
      // Fast path: nothing protocol-like in sight → release immediately.
      if (!buffer.includes("{") && !buffer.includes("<")) {
        pendingEmit += buffer;
        buffer = "";
        flushPending();
        return;
      }
      // Possible protocol: keep buffering until the object is classified.
      if (containsCompleteToolObject(buffer)) {
        // A full tool object arrived — swallow it entirely; the loop will
        // handle it as a structured call from the final content.
        buffer = "";
        return;
      }
      if (looksLikeOpenProtocol(buffer)) {
        // Wait for more chunks before deciding.
        return;
      }
      pendingEmit += buffer;
      buffer = "";
      flushPending();
    },
    close() {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      if (buffer.length > 0) {
        if (containsCompleteToolObject(buffer)) {
          // Fully-formed protocol: drop it.
        } else if (looksLikeOpenProtocol(buffer)) {
          // Unterminated fragment: release the safe prefix before the '{',
          // drop the fragment itself.
          const brace = buffer.lastIndexOf("{");
          const safePrefix = buffer.slice(0, brace).replace(/<tool_call>[\s\S]*$/i, "");
          pendingEmit += safePrefix;
        } else {
          pendingEmit += buffer;
        }
      }
      buffer = "";
      flushPending();
    },
  };
}

function looksLikeOpenProtocol(buffer: string): boolean {
  const openBrace = buffer.lastIndexOf("{");
  if (openBrace === -1) {
    return false;
  }
  const tail = buffer.slice(openBrace);
  return /\{\s*"name"\s*:/.test(tail) || /\{\s*"name"\s*$/.test(tail) || /\{\s*$/.test(tail) || /\{\s*"(?:arguments|input|parameters)"/.test(tail) && !tail.includes("}");
}

function containsCompleteToolObject(buffer: string): boolean {
  return /\{\s*"name"\s*:\s*"[^"]+"[\s\S]*\}/.test(buffer);
}
