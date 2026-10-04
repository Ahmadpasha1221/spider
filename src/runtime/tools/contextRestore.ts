import type { RestoredHistoryTurn } from "../runtimeTypes";

/**
 * Deterministic model-history restoration from a persisted transcript.
 *
 * The transcript is display-complete but lossy: tool entries carry no
 * `tool_call_id`, no `tool_calls` array, and no model arguments, so a tool
 * conversation can NEVER be faithfully replayed — and replaying tool turns
 * without paired ids would make the provider reject the whole request (see
 * the tool_call_id lifecycle fix). Restoration is therefore intentionally
 * text-only:
 *
 * - `user` entries → user turns,
 * - `assistant` entries → assistant turns (empty texts dropped),
 * - `thinking` / `tool` / `command` / `error` / `system` entries → skipped
 *   (transient or non-replayable; tool results without ids are invalid).
 *
 * The result contains no `tool` roles and no `tool_calls`, so it always
 * passes `toOpenAiMessages` validation. Callers cap it (most recent turns)
 * and usually run it through `compactChatTurns` before handing it to a
 * provider. Nothing here is silent: the transcript stays complete, and the
 * model simply continues from the readable conversation — never from a
 * fabricated tool history.
 */

export interface RestorableTranscriptEntry {
  readonly kind: "user" | "assistant" | "thinking" | "tool" | "command" | "error" | "system";
  readonly text: string;
}

export interface RestoreOptions {
  /** Keep at most this many turns (most recent). Defaults to 50. */
  readonly maxTurns?: number;
  /** Drop texts longer than this (characters) rather than truncating mid-word. Defaults to 8000. */
  readonly maxCharsPerTurn?: number;
}

export const DEFAULT_RESTORE_MAX_TURNS = 50;
export const DEFAULT_RESTORE_MAX_CHARS = 8_000;

/** Text-only, id-free turns safe to seed a fresh provider history with. */
export function restoreChatTurns(
  entries: readonly RestorableTranscriptEntry[],
  options: RestoreOptions = {},
): RestoredHistoryTurn[] {
  const maxTurns = options.maxTurns ?? DEFAULT_RESTORE_MAX_TURNS;
  const maxChars = options.maxCharsPerTurn ?? DEFAULT_RESTORE_MAX_CHARS;
  const turns: RestoredHistoryTurn[] = [];
  for (const entry of entries) {
    if (entry.kind !== "user" && entry.kind !== "assistant") {
      continue;
    }
    const text = entry.text.trim();
    if (text.length === 0 || text.length > maxChars) {
      continue;
    }
    turns.push({ role: entry.kind, content: text });
  }
  // Most recent turns win when the transcript is longer than the cap.
  return turns.slice(Math.max(0, turns.length - Math.max(1, maxTurns)));
}
