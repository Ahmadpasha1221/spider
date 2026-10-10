import type {
  RuntimeEventSink,
  RuntimeSendRequest,
  RuntimeToolCall,
  RuntimeToolCallResponse,
} from "../runtimeTypes";
import { RuntimeError, RuntimeUsage } from "../runtimeTypes";
import { buildAgentSystemPrompt, stripToolCallMarkup } from "./localToolDefinitions";
import { isConfirm, scanDanger } from "./externalContentGuard";
import { parseFallbackToolOutput } from "./textToolFallback";
import { parseNativeToolOutput, type InvalidToolMention, type ParsedToolOutput } from "./parseToolCalls";
import { availableToolNames, DEFAULT_AGENT_MODE, type AgentMode } from "./toolAvailability";
import { buildFallbackToolContract, getRegisteredTool } from "./toolRegistry";
import {
  compactChatTurns,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type CompactionInfo,
  type ContextBudget,
} from "./contextManager";
import { SourceTracingManager } from "../validation/sourceTracing";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * OpenAI-compatible conversation turn. Tool turns carry `tool_call_id`, which
 * MUST equal the id of the corresponding entry in the assistant turn's
 * `tool_calls`; providers reject the request otherwise.
 */
export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  /** Set on "tool" turns: the id of the assistant tool call this result answers. */
  tool_call_id?: string;
}

export interface ChatCompletion {
  readonly content: string;
  readonly nativeToolCalls?: RuntimeToolCall[];
  readonly usage?: RuntimeUsage;
}

export type CompleteChat = (messages: readonly ChatTurn[], signal?: AbortSignal) => Promise<ChatCompletion>;

/**
 * Hard ceiling on model turns that execute tools, and a smaller budget for
 * invalid tool selections so a weak local model cannot hallucinate tools
 * ({"name":"execute"}) forever.
 */
export const MAX_TOOL_ITERATIONS = 20;
export const MAX_INVALID_TOOL_RETRIES = 2;

export interface AgentLoopOptions {
  readonly nativeTools: boolean;
  /**
   * Current mode selecting the available-tool set (architecture item 8).
   * Defaults to "agent" (all registered tools); future modes restrict tools
   * without any changes to the loop itself.
   */
  readonly mode?: AgentMode;
  /**
   * Ceiling for one provider request (estimated tokens). The stored history
   * is never mutated — compaction only narrows the view handed to
   * `completeChat`, keeping the system turn, the latest prompt, and every
   * assistant tool-call/result pair atomic. Defaults to
   * DEFAULT_CONTEXT_BUDGET_TOKENS; normal runs never reach it.
   */
  readonly contextBudget?: ContextBudget;
  /** Observability hook: fired whenever a request view was actually compacted. */
  readonly onCompaction?: (info: CompactionInfo) => void;
}

/**
 * Production agent loop, provider-independent:
 *
 *   AGENT START → UNDERSTAND → DECIDE (direct vs tool) → SELECT TOOL →
 *   VALIDATE NAME → VALIDATE ARGS → PERMISSION → EXECUTE → STRUCTURED RESULT →
 *   MODEL OBSERVES → CONTINUE / VERIFY / FINISH → AGENT COMPLETE
 *
 * Only tools from the central registry are executable. Invalid tool selections
 * become structured feedback to the model (never chat output). The Thinking UI
 * receives safe progress messages only — never hidden chain-of-thought.
 */
export async function runInferenceAgentLoop(
  request: RuntimeSendRequest,
  history: ChatTurn[],
  completeChat: CompleteChat,
  emit: RuntimeEventSink,
  options: AgentLoopOptions = { nativeTools: true },
): Promise<void> {
  const onUsage = (usage: RuntimeUsage): void => {
    if (usage.totalTokens > 0) {
      void request.usageSink?.(usage);
    }
  };

  const mode = options.mode ?? DEFAULT_AGENT_MODE;
  // The current available-tool set: what the model sees, what feedback lists,
  // and what the loop is willing to route. Single source: the registry via
  // toolAvailability.
  const allowedTools = availableToolNames(mode);

  prepareHistory(history, request.retry === true);
  ensureSystemPrompt(history, request.modelId, options.nativeTools, allowedTools, request.executionContextSummary, request.rulesContext, request.systemPrompt, request.skillsCatalogPrompt);
  history.push({ role: "user", content: request.prompt });
  await emit({ type: "status", sessionId: request.sessionId, status: "RUNNING", timestamp: Date.now() });

  // The model sees a budgeted view of the stored history (system + recent
  // tail, tool-call pairs kept atomic). `history` itself stays complete.
  const budget = options.contextBudget ?? { maxTokens: DEFAULT_CONTEXT_BUDGET_TOKENS };
  const modelView = (): ChatTurn[] => {
    const { turns, info } = compactChatTurns(history, budget);
    if (info.compacted) {
      options.onCompaction?.(info);
    }
    return turns;
  };

  if (!request.onToolCall) {
    const completion = await completeChat(modelView(), request.signal);
    if (completion.usage) {
      onUsage(completion.usage);
    }
    const message = visibleText(completion.content) || "(The local model returned an empty response.)";
    history.push({ role: "assistant", content: message });
    await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
    return;
  }

  let invalidToolRetries = 0;
  let lastThinking: string | undefined;

  /** Emits safe progress only; consecutive duplicates are suppressed. */
  const emitThinking = async (message: string): Promise<void> => {
    if (message.length === 0 || message === lastThinking) {
      return;
    }
    lastThinking = message;
    await emit({ type: "thinking", sessionId: request.sessionId, message, timestamp: Date.now() });
  };

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    throwIfAborted(request.signal);
    const completion = await completeChat(modelView(), request.signal);
    SourceTracingManager.getInstance().record({
      sessionId: request.sessionId,
      iteration,
      model: request.modelId,
      boundary: "MODEL_OUTPUT_RAW",
      contentHash: SourceTracingManager.getInstance().computeHash(completion.content),
      contentLength: completion.content.length,
    });
    if (completion.usage) {
      onUsage(completion.usage);
    }

    const output = selectToolOutput(completion, options.nativeTools);
    // Classification gate: only safe text passes to the Thinking UI. Tool
    // protocol (any name, valid or not, complete or partial) never reaches it.
    const visible = visibleText(completion.content);

    // Registry-known tools outside the current available-tool set are
    // recovered exactly like hallucinated tools: structured feedback, retry.
    const { available, unavailable } = partitionByAvailability(output.calls, allowedTools);
    const invalid: InvalidToolMention[] = [
      ...output.invalid,
      ...unavailable.map((call) => ({ name: call.name, raw: call.name, reason: "unknown-tool" as const })),
    ];
    const calls = available;

    // Invalid tool selection: recover with structured feedback, bounded retries.
    if (calls.length === 0 && invalid.length > 0) {
      invalidToolRetries += 1;
      if (invalidToolRetries > MAX_INVALID_TOOL_RETRIES) {
        const message = "I couldn't complete this request because the required tool is not available. Please rephrase the task.";
        history.push({ role: "assistant", content: message });
        await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
        return;
      }
      const names = invalid.map((mention) => mention.name ?? "unknown");
      await emitThinking(`Unknown tool "${names.join(", ")}". Choosing from the available tools…`);
      history.push({ role: "assistant", content: visible });
      history.push({ role: "user", content: invalidToolFeedback(invalid, allowedTools) });
      continue;
    }

    if (calls.length === 0) {
      const message = visible || "(The local model returned an empty response.)";
      history.push({ role: "assistant", content: message });
      await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
      return;
    }

    if (visible.length > 0) {
      await emitThinking(visible);
    }

    history.push({
      role: "assistant",
      content: visible,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: safeJsonArguments(call.input),
        },
      })),
    });

    for (const call of calls) {
      throwIfAborted(request.signal);
      // Risk 3 quarantine: a prior tool result carrying a dangerous pattern
      // (pipe-to-shell, credential path, exfil shape) freezes every
      // state-changing tool until the user replies with explicit
      // confirmation text. Additive: reads still run; writes/executions wait.
      const quarantine = checkQuarantine(call, history, request.prompt);
      if (quarantine.blocked) {
        const message = quarantine.notice;
        history.push({ role: "user", content: message });
        await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
        return;
      }
      SourceTracingManager.getInstance().record({
        sessionId: request.sessionId,
        iteration,
        tool: call.name,
        toolCallId: call.id,
        boundary: "TOOL_CALL_PARSED",
        contentHash: SourceTracingManager.getInstance().computeHash(safeJsonArguments(call.input)),
      });
      await emit({ type: "tool_call", sessionId: request.sessionId, toolCall: call, timestamp: Date.now() });
      await emit({ type: "tool_running", sessionId: request.sessionId, toolCall: call, timestamp: Date.now() });
      await emitThinking(describeToolStart(call));

      const response = await request.onToolCall(call, request.signal);

      await emitCommandOutput(request.sessionId, call, response, emit);
      await emit({
        type: "tool_result",
        sessionId: request.sessionId,
        toolResult: {
          toolCallId: call.id,
          name: call.name,
          ...(response.result !== undefined ? { result: response.result } : {}),
          ...(response.error ? { error: response.error } : {}),
        },
        timestamp: Date.now(),
      });
      // The tool result must reference the exact assistant tool-call id.
      // A missing/empty id would make the whole conversation invalid for
      // OpenAI-compatible providers, so fail explicitly instead of sending a
      // malformed request that would also poison later turns.
      const toolCallId = isNonEmptyString(call.id) ? call.id : undefined;
      if (!toolCallId) {
        throw new RuntimeError(
          "unknown",
          `Tool call "${call.name}" is missing a tool call id; refusing to build an invalid conversation.`,
        );
      }
      history.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(response.result ?? { success: false, tool: call.name, error: response.error ?? "Tool failed." }),
      });

      // If validation gate marked execution as blocked (max repairs exceeded), halt with honest diagnostics
      if (isRecord(response.result) && (response.result.isGateBlocked === true || response.result.isBlocked === true)) {
        const message = `Task halted: Validation gate is BLOCKED. ${response.error ?? "Code validation failed and exceeded maximum repair attempts."}`;
        history.push({ role: "assistant", content: message });
        await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
        return;
      }

      // Terminal: after a successful finish there are no more model calls,
      // tools, or Thinking events. COMPLETED is final for this run.
      if (response.finished) {
        if (response.error) {
          const message = "The task could not be completed successfully.";
          history.push({ role: "assistant", content: message });
          await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
          return;
        }
        await emitThinking("Finishing…");
        const summary = summaryFrom(response.result) || "Done.";
        history.push({ role: "assistant", content: summary });
        await emit({ type: "assistant_message", sessionId: request.sessionId, message: summary, timestamp: Date.now() });
        return;
      }

      if (response.error) {
        await emitThinking(describeToolProblem(call));
      } else {
        await emitThinking("Checking the result…");
      }
    }
  }

  const message = `Stopped after ${MAX_TOOL_ITERATIONS} tool iterations.`;
  history.push({ role: "assistant", content: message });
  await emit({ type: "assistant_message", sessionId: request.sessionId, message, timestamp: Date.now() });
}
const READ_ONLY_QUARANTINE_EXEMPT = new Set(["read_file","read_multiple_files","glob_search","grep_search","codebase_search","fetch_url","search_web","get_problems","list_symbols","go_to_definition","find_references","git_status","git_diff","git_log","git_show","git_blame","repo_map","ask_user"]);
export function checkQuarantine(call: RuntimeToolCall, history: readonly ChatTurn[], userPrompt?: string): { blocked: boolean; notice: string } {
  const empty = { blocked: false, notice: "" };
  if (READ_ONLY_QUARANTINE_EXEMPT.has(call.name)) return empty;
  const haystack = history.filter((t) => t.role === "tool").map((t) => t.content).join("\n");
  if (!haystack) return empty;
  const scan = scanDanger(haystack);
  if (!scan.dangerous) return empty;
  const confirmed = isConfirm(userPrompt ?? "") || history.some((t) => t.role === "user" && isConfirm(t.content));
  if (confirmed) return empty;
  const kinds = [...new Set(scan.matches.map((m) => m.kind))].join(", ");
  const first = scan.matches[0];
  const notice = `Quarantined: refusing ${call.name} until you confirm. Dangerous pattern (${kinds}) was detected in untrusted tool content${first ? ` e.g. "${first.pattern}"` : ""}. ${scan.needConfirm}`;
  return { blocked: true, notice };
}


function selectToolOutput(completion: ChatCompletion, nativeTools: boolean): ParsedToolOutput {
  if (nativeTools) {
    return parseNativeToolOutput(completion.nativeToolCalls ?? []);
  }
  return parseFallbackToolOutput(completion.content);
}

/** Splits parsed calls into tools inside the available set and outside it. */
function partitionByAvailability(
  calls: readonly RuntimeToolCall[],
  allowedTools: readonly string[],
): { available: RuntimeToolCall[]; unavailable: RuntimeToolCall[] } {
  const allowed = new Set(allowedTools);
  const available: RuntimeToolCall[] = [];
  const unavailable: RuntimeToolCall[] = [];
  for (const call of calls) {
    if (allowed.has(call.name)) {
      available.push(call);
    } else {
      unavailable.push(call);
    }
  }
  return { available, unavailable };
}

function invalidToolFeedback(invalid: readonly InvalidToolMention[], allowedTools: readonly string[]): string {
  const requested = invalid.map((mention) => mention.name ?? "unknown").join(", ");
  return [
    "TOOL_ERROR: INVALID_TOOL",
    `requested = "${requested}"`,
    `Unknown tool: ${requested}.`,
    `Available tools:\n${allowedTools.join("\n")}`,
    "Retry by outputting exactly one JSON object with a valid tool name and its arguments, or reply in plain text if no tool is needed.",
  ].join("\n");
}

/**
 * Safe, user-facing progress lines. Never exposes hidden reasoning.
 *
 * The copy lives on the tool definition (`RegisteredTool.summarize`), so the
 * loop has no per-tool branches and a new tool brings its own wording.
 */
export function describeToolStart(call: RuntimeToolCall): string {
  const tool = getRegisteredTool(call.name);
  if (!tool) {
    return `Using ${call.name}…`;
  }
  const input = isRecord(call.input) ? call.input : {};
  return tool.summarize(input);
}

function describeToolProblem(call: RuntimeToolCall): string {
  const input = isRecord(call.input) ? call.input : {};
  const path = typeof input.path === "string" ? input.path : "";
  return `The ${call.name} step did not succeed${path ? ` (${path})` : ""}. Deciding what to do next…`;
}

function ensureSystemPrompt(
  history: ChatTurn[],
  modelId: string | undefined,
  nativeTools: boolean,
  allowedTools: readonly string[],
  executionContextSummary?: string,
  rulesContext?: string,
  systemPromptOverride?: string,
  skillsCatalogPrompt?: string,
): void {
  // A nested run (subagent) supplies its own role prompt; the default Spider
  // prompt would otherwise describe an orchestrator the subagent is not.
  const base = systemPromptOverride ?? buildAgentSystemPrompt(modelId, executionContextSummary, rulesContext, skillsCatalogPrompt);
  const prompt = nativeTools ? base : `${base}\n\n${buildFallbackToolContract(allowedTools)}`;
  const existing = history.find((turn) => turn.role === "system");
  if (!existing) {
    history.unshift({ role: "system", content: prompt });
    return;
  }
  existing.content = prompt;
}

function prepareHistory(history: ChatTurn[], retry: boolean): void {
  if (retry) {
    while (history.length > 0 && history[history.length - 1]?.role !== "system") {
      const last = history.pop();
      if (last?.role === "user") {
        break;
      }
    }
    return;
  }

  const last = history[history.length - 1];
  if (
    last?.role === "assistant"
    && visibleText(last.content).length === 0
    && ((last.tool_calls && last.tool_calls.length > 0) || parseFallbackToolOutput(last.content).calls.length > 0)
  ) {
    history.pop();
  }
}

function visibleText(content: string): string {
  return stripToolCallMarkup(content);
}

/** OpenAI-compatible tool-call arguments are a JSON string. */
function safeJsonArguments(input: unknown): string {
  try {
    return JSON.stringify(isRecord(input) ? input : {});
  } catch {
    return "{}";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function summaryFrom(result: unknown): string {
  if (!isRecord(result)) {
    return "";
  }
  return typeof result.summary === "string" ? result.summary : typeof result.message === "string" ? result.message : "";
}

async function emitCommandOutput(
  sessionId: string,
  call: RuntimeToolCall,
  response: RuntimeToolCallResponse,
  emit: RuntimeEventSink,
): Promise<void> {
  if (call.name !== "run_command" || !isRecord(response.result)) {
    return;
  }
  const result = response.result;
  if (typeof result.stdout !== "string" && typeof result.stderr !== "string") {
    return;
  }
  await emit({
    type: "command_output",
    sessionId,
    command: typeof result.command === "string" ? result.command : commandFromInput(call.input),
    toolCallId: call.id,
    ...(typeof result.cwd === "string" ? { cwd: result.cwd } : {}),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    timestamp: Date.now(),
  });
}

function commandFromInput(input: unknown): string {
  return isRecord(input) && typeof input.command === "string" ? input.command : "";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RuntimeError("cancelled", "The local agent run was cancelled.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
