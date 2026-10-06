import type { CodeviaSession } from "../runtimeTypes";

/**
 * Subagents (A7): the orchestrator-worker pattern.
 *
 * Spider's main agent stays the single orchestrator. When a task needs broad,
 * multi-file investigation, it can dispatch a **read-only research subagent**
 * as a tool call (`run_subagent`). The subagent runs an isolated agent loop in
 * the same workspace — its own message history, a restricted read-only tool
 * set, a smaller iteration budget, and a wall-clock timeout — and returns only
 * a distilled report. The parent agent never sees the subagent's tool output,
 * which is exactly the point: raw search results stay out of the main context
 * while the conclusion comes back.
 *
 * This mirrors Microsoft Agent Framework / Semantic Kernel's "agent as tool"
 * and orchestrator-worker guidance (an agent is worth dispatching when the task
 * is open-ended and the intermediate work should not pollute the caller's
 * context; a plain function is better when the steps are already known).
 *
 * Safety properties, all enforced by construction:
 * - Subagents are READ-ONLY (tool set excludes writes, commands, `ask_user`,
 *   `update_todo` and `run_subagent`), so they can never modify the workspace,
 *   prompt the user, or spawn further subagents (depth is capped at 1).
 * - Every subagent tool call still routes through the same ToolRouter and
 *   permission pipeline as the parent — there is no bypass.
 *
 * This module is pure (no provider/vscode imports), so the contract, prompt and
 * limits are unit-testable; the orchestration lives in RuntimeManager.
 */

export interface SubagentInput {
  /** The investigation to perform. Self-contained: the subagent sees only this. */
  readonly task: string;
  /** Short human label shown in progress UI (e.g. "Find streaming state"). */
  readonly description?: string;
}

export interface SubagentContext {
  readonly session: CodeviaSession;
  readonly signal?: AbortSignal;
}

export type SubagentStatus = "completed" | "failed" | "cancelled" | "limit" | "unavailable";

export interface SubagentResult {
  readonly status: SubagentStatus;
  /** The distilled report. The only thing the parent model receives. */
  readonly summary: string;
  /** Names of the tools the subagent actually used (observability). */
  readonly toolsUsed: readonly string[];
  /** Model iterations consumed. */
  readonly iterations?: number;
  /** Human-readable note for non-completed outcomes. */
  readonly notes?: string;
}

/** Everything a host must implement to expose `run_subagent`. */
export interface SubagentRunner {
  runSubagent(input: SubagentInput, context: SubagentContext): Promise<SubagentResult>;
}

export const SUBAGENT_LIMITS = {
  /** Longest task description accepted from the model. */
  maxTaskChars: 4_000,
  /** Longest progress label. */
  maxDescriptionChars: 160,
  /** Report length cap (chars) — the subagent's whole value is concision. */
  maxSummaryChars: 8_000,
  /** Tool iterations a subagent may use (smaller than the parent's 20). */
  maxToolIterations: 12,
  /** Wall-clock ceiling for one subagent. */
  timeoutMs: 180_000,
  /** Subagents allowed to run at once across the process. */
  maxConcurrent: 2,
  /** 1 = the main agent may dispatch subagents, but they cannot dispatch more. */
  maxDepth: 1,
} as const;

/** Returns an error string when the model's arguments are unusable. */
export function validateSubagentInput(input: Record<string, unknown>): string | undefined {
  const task = input.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    return "Missing required argument: task";
  }
  if (task.length > SUBAGENT_LIMITS.maxTaskChars) {
    return `task cannot exceed ${SUBAGENT_LIMITS.maxTaskChars} characters.`;
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    return "description must be a string.";
  }
  return undefined;
}

export function normalizeSubagentInput(input: Record<string, unknown>): SubagentInput {
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const rawDescription = typeof input.description === "string" ? input.description.trim() : "";
  const description = rawDescription.length > 0
    ? rawDescription.slice(0, SUBAGENT_LIMITS.maxDescriptionChars)
    : firstLine(task);
  return { task, ...(description.length > 0 ? { description } : {}) };
}

export interface SubagentPromptOptions {
  /** Formatted `.spiderrules` for the workspace (context only). */
  readonly rulesContext?: string;
}

/**
 * The subagent's system prompt. Deliberately narrow: investigate, cite paths,
 * return a self-contained report; never write, never ask the user, never guess.
 */
export function buildSubagentSystemPrompt(
  input: SubagentInput,
  options: SubagentPromptOptions = {},
): string {
  const lines = [
    "You are a read-only research subagent dispatched by Spider (the parent coding agent).",
    "Your job is to investigate the workspace and return a concise, self-contained report.",
    "You have NO tools that write, delete, move, or execute anything, and you cannot ask the user questions. Do not attempt them.",
    "",
    "TASK:",
    input.task,
  ];
  if (input.description && input.description !== firstLine(input.task)) {
    lines.push("", `PURPOSE: ${input.description}`);
  }
  lines.push(
    "",
    "How to work:",
    "- Start broad (repo_map, codebase_search, grep_search), then read only the files that matter.",
    "- Do not dump whole files. Quote the specific lines that support a conclusion, with workspace-relative paths.",
    "- If the answer is not in the workspace, say so — never invent it.",
    "- Finish by calling `finish` with your report, or by replying with the report as plain text.",
    "",
    "Report format:",
    "- The direct answer first.",
    "- Key locations as `path:line`.",
    "- Open questions or uncertainty.",
    "The parent agent sees ONLY your report, not your tool output, so it must stand alone.",
  );
  const rules = options.rulesContext ? `\n\n${options.rulesContext}` : "";
  return `${lines.join("\n")}${rules}`;
}

/** Trims and caps the report so a runaway subagent cannot flood the parent. */
export function clampSubagentSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUBAGENT_LIMITS.maxSummaryChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUBAGENT_LIMITS.maxSummaryChars)}\n…(report truncated)`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  return line.slice(0, SUBAGENT_LIMITS.maxDescriptionChars);
}
