import type { ChatTurn } from "./inferenceAgentLoop";

/**
 * Explicit context management for the agent loop.
 *
 * The runtime model history (`ChatTurn[]` per session) grows without bound:
 * every tool call appends an assistant turn plus one tool-result turn, and
 * long runs eventually exceed the model's context window — failing deep into
 * a task with no signal about what was lost. This module is the single place
 * that decides what the model actually sees:
 *
 *   stored history (complete, never mutated here)
 *     → estimate → budget → compact → provider request
 *
 * Rules (hard invariants, all covered by tests):
 * - the system prompt turn is always kept,
 * - the latest turn (the current user prompt) is always kept,
 * - an assistant `tool_calls` turn and its tool-result turns are ONE atomic
 *   unit: they are kept or dropped together, never split, so the wire format
 *   can never contain an orphaned tool message,
 * - compaction drops the OLDEST units first and keeps the recent tail,
 * - when nothing needs dropping, the input array is returned unchanged.
 *
 * Token estimation is documented, not precise: without a provider tokenizer
 * the fallback is ~4 characters per token. Budgets should therefore keep a
 * comfortable margin below the model's real context window.
 */

/** Rough characters-per-token fallback used when no tokenizer is available. */
export const CHARS_PER_TOKEN_FALLBACK = 4;

/**
 * Default ceiling for one provider request. Large enough that normal runs
 * never compact (zero behavior change), small enough to protect models with
 * modest context windows from unbounded tool-output growth.
 */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 100_000;

export interface ContextBudget {
  /** Maximum estimated tokens for the compacted provider request. */
  readonly maxTokens: number;
}

export interface CompactionInfo {
  readonly compacted: boolean;
  /** Turns dropped from the provider view (stored history is untouched). */
  readonly droppedTurns: number;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
}

/** Documented-fallback token estimate for one turn (content + tool JSON). */
export function estimateTurnTokens(turn: ChatTurn): number {
  let chars = turn.content.length;
  if (turn.tool_calls) {
    for (const call of turn.tool_calls) {
      chars += call.id.length + call.function.name.length + call.function.arguments.length;
    }
  }
  if (turn.tool_call_id) {
    chars += turn.tool_call_id.length;
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_FALLBACK));
}

export function estimateTokens(turns: readonly ChatTurn[]): number {
  let total = 0;
  for (const turn of turns) {
    total += estimateTurnTokens(turn);
  }
  return total;
}

/**
 * Builds the provider-safe view of a full history: the system turn plus the
 * most recent units that fit the budget. Pure — the input is never mutated
 * and tool-call/result pairs are never separated.
 */
export function compactChatTurns<T extends ChatTurn>(
  history: readonly T[],
  budget: ContextBudget = { maxTokens: DEFAULT_CONTEXT_BUDGET_TOKENS },
): { turns: T[]; info: CompactionInfo } {
  const estimatedTokensBefore = estimateTokens(history);
  if (estimatedTokensBefore <= budget.maxTokens || history.length === 0) {
    return {
      turns: [...history],
      info: { compacted: false, droppedTurns: 0, estimatedTokensBefore, estimatedTokensAfter: estimatedTokensBefore },
    };
  }

  const units = splitUnits(history);
  const system = units.system;
  const tail = units.tail;
  const systemTokens = system ? estimateTurnTokens(system) : 0;

  // Always keep the latest turn (the current prompt); grow backwards.
  const kept: T[] = [];
  let used = systemTokens;
  // Reserve order: iterate tail units newest-first, unshift survivors.
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const unit = tail[index] as T[];
    const cost = estimateTokens(unit);
    const isLatest = index === tail.length - 1;
    if (!isLatest && used + cost > budget.maxTokens) {
      continue;
    }
    kept.unshift(...unit);
    used += cost;
  }
  const turns = system ? [system, ...kept] : kept;
  return {
    turns,
    info: {
      compacted: true,
      droppedTurns: history.length - turns.length,
      estimatedTokensBefore,
      estimatedTokensAfter: estimateTokens(turns),
    },
  };
}

interface SplitUnits<T> {
  readonly system?: T;
  /** Newest-last atomic units (single turns or tool-call groups). */
  readonly tail: T[][];
}

/**
 * Segments history into atomic units. An assistant turn carrying `tool_calls`
 * absorbs every following `tool` turn as one group; a stray `tool` turn
 * without a preceding assistant call still joins the previous unit so it can
 * never be orphaned alone.
 */
function splitUnits<T extends ChatTurn>(history: readonly T[]): SplitUnits<T> {
  let system: T | undefined;
  const tail: T[][] = [];
  for (const turn of history) {
    if (turn.role === "system" && !system) {
      system = turn;
      continue;
    }
    if (turn.role === "assistant" && turn.tool_calls && turn.tool_calls.length > 0) {
      tail.push([turn]);
      continue;
    }
    if (turn.role === "tool") {
      // Tool results belong to the preceding unit, whatever it is: a tool
      // turn must never stand alone, or the provider would see an orphaned
      // tool message. A leading tool turn with no predecessor is already
      // malformed — drop it rather than send an invalid conversation.
      const last = tail[tail.length - 1];
      if (last) {
        last.push(turn);
      }
      continue;
    }
    tail.push([turn]);
  }
  return { ...(system ? { system } : {}), tail };
}
