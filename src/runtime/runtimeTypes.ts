import type { PermissionRequest } from "../permissions/permissionTypes";
import type { AgentMode } from "./tools/toolAvailability";
import type { TaskPlan, TodoItem } from "./state/taskPlan";
import type {
  UserQuestionAnswer,
  UserQuestionRequestInput,
  UserQuestion,
} from "./userInteraction/userQuestionBroker";

export type RuntimeProvider = "cursor" | "ollama" | "openai-compatible" | "openrouter" | "mock";

export type RuntimeProviderFamily = "agent" | "inference" | "mock";

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly codeEditing?: boolean;
  readonly reasoning?: boolean;
  /** Model can accept images in chat messages. */
  readonly vision?: boolean;
}

export interface RuntimeUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd?: number;
}

export interface FileChangeSummary {
  readonly changeId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: "write_file" | "edit_file";
  readonly path: string;
  readonly status: "APPLIED" | "REVERTED" | "MISSING";
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: DiffHunk[];
  readonly appliedAt: number;
}

export interface ModelPricing {
  /** USD per one million prompt tokens. */
  readonly promptUsdPerMillion?: number;
  /** USD per one million completion tokens. */
  readonly completionUsdPerMillion?: number;
}

export interface RuntimeModel {
  readonly id: string;
  readonly name: string;
  readonly provider: RuntimeProvider;
  readonly contextWindow?: number;
  readonly capabilities?: ModelCapabilities;
  readonly pricing?: ModelPricing;
}

export type RuntimeSessionStatus =
  | "IDLE"
  | "STARTING"
  | "READY"
  | "RUNNING"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "DISCONNECTED";

export interface RuntimeErrorInfo {
  readonly message: string;
  readonly category: string;
}

export interface CodeviaSession {
  readonly sessionId: string;
  readonly provider: RuntimeProvider;
  readonly modelId?: string;
  readonly workspacePath: string;
  readonly providerSessionId?: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly status: RuntimeSessionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly currentTask?: string;
  readonly error?: RuntimeErrorInfo;
}

export interface RuntimeMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content?: string;
  readonly toolCall?: RuntimeToolCall;
  readonly toolResult?: RuntimeToolResult;
}

export interface RuntimeToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface RuntimeToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RuntimeToolCallResponse {
  readonly allowed: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly finished?: boolean;
}

export type RuntimeErrorCode =
  | "provider_unavailable"
  | "authentication_failed"
  | "no_models_found"
  | "model_unavailable"
  | "network_error"
  | "unsupported_capability"
  | "agent_not_found"
  | "session_not_found"
  | "invalid_configuration"
  | "cancelled"
  | "unknown";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: Record<string, unknown>; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export interface RuntimeAvailability {
  readonly available: boolean;
  readonly status: "connected" | "disconnected" | "error";
  readonly message?: string;
}

export interface RuntimeSessionRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly modelId?: string;
}

export interface RuntimeResumeRequest {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly workspacePath: string;
  readonly modelId?: string;
}

export interface RuntimeSendRequest {
  readonly sessionId: string;
  readonly providerSessionId?: string;
  readonly workspacePath: string;
  readonly modelId?: string;
  readonly prompt: string;
  readonly retry?: boolean;
  /** Current agent mode selecting the available-tool set (defaults to "agent"). */
  readonly mode?: AgentMode;
  /**
   * Safe, secret-free summary of the resolved execution environment for this
   * workspace. Injected into the system prompt so the model knows where
   * run_command executes without probing the shell itself.
   */
  readonly executionContextSummary?: string;
  /**
   * Formatted `.spiderrules` content for this workspace (see
   * `src/runtime/rules/workspaceRules.ts`). Injected into the
   * system prompt as user instructions; rules are context only
   * and never alter permissions, tools or safety controls.
   */
  readonly rulesContext?: string;
  readonly messages?: readonly RuntimeMessage[];
  readonly signal?: AbortSignal;
  readonly onToolCall?: (
    call: RuntimeToolCall,
    signal?: AbortSignal,
  ) => Promise<RuntimeToolCallResponse>;
  /** Streaming hook: called with each text chunk as it arrives from the model. */
  readonly onStreamDelta?: (text: string) => void;
  /** Usage hook: called once per model completion with token counts. */
  readonly usageSink?: (usage: RuntimeUsage) => void;
  /**
   * Live usage hook: called while a stream is still open when the provider
   * reports running totals. Values are cumulative snapshots for the current
   * completion (not deltas to add) and are never accumulated — only the
   * final `usageSink` call counts toward session totals.
   */
  readonly usageDeltaSink?: (usage: RuntimeUsage) => void;
}

export interface RuntimeCancelRequest {
  readonly sessionId: string;
  readonly providerSessionId?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

export type DiffHunk = {
  readonly header: string;
  readonly lines: Array<{ type: "context" | "add" | "del"; text: string; oldLine?: number; newLine?: number }>;
};

export type RuntimeEvent =
  | { type: "status"; sessionId: string; status: RuntimeSessionStatus; timestamp: number }
  | { type: "user_question"; sessionId: string; request: UserQuestion; timestamp: number }
  | { type: "user_question_resolved"; sessionId: string; requestId: string; timestamp: number }
  | { type: "todo_updated"; sessionId: string; plan: TaskPlan; timestamp: number }
  | { type: "thinking"; sessionId: string; message: string; timestamp: number }
  | { type: "text_delta"; sessionId: string; text: string; timestamp: number }
  | {
      type: "assistant_message";
      sessionId: string;
      message: string;
      /** Transcript entry id so the chat UI can Copy/Delete this exact reply. */
      messageId?: string;
      timestamp: number;
    }
  | { type: "text_delta"; sessionId: string; text: string; timestamp: number }
  | { type: "usage"; sessionId: string; usage: RuntimeUsage; timestamp: number; partial?: boolean }
  | { type: "file_change"; sessionId: string; change: FileChangeSummary; timestamp: number }
  | { type: "file_change_reverted"; sessionId: string; change: FileChangeSummary; timestamp: number }
  | { type: "tool_call"; sessionId: string; toolCall: RuntimeToolCall; timestamp: number }
  | { type: "tool_running"; sessionId: string; toolCall: RuntimeToolCall; timestamp: number }
  | { type: "tool_result"; sessionId: string; toolResult: RuntimeToolResult; timestamp: number }
  | {
      type: "command_output";
      sessionId: string;
      command: string;
      /** Tool call this output belongs to, so the UI updates the same box. */
      toolCallId: string;
      cwd?: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      /**
       * True for incremental chunks emitted while the command is still
       * running; the final event (partial absent) carries the authoritative
       * exit code and complete output.
       */
      partial?: boolean;
      timestamp: number;
    }
  | { type: "permission_request"; sessionId: string; request: PermissionRequest; timestamp: number }
  | { type: "error"; sessionId: string; error: RuntimeError; timestamp: number }
  | { type: "completed"; sessionId: string; timestamp: number }
  | { type: "cancelled"; sessionId: string; timestamp: number };

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;

export type CursorRuntimeConfig = {
  readonly provider: "cursor";
  readonly modelId?: string;
};

export type OllamaRuntimeConfig = {
  readonly provider: "ollama";
  readonly baseUrl?: string;
  readonly modelId?: string;
};

export type OpenAICompatibleRuntimeConfig = {
  readonly provider: "openai-compatible";
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey?: string;
};

export type OpenRouterRuntimeConfig = {
  readonly provider: "openrouter";
  readonly modelId?: string;
  readonly apiKey?: string;
};

export type MockRuntimeConfig = {
  readonly provider: "mock";
  readonly scenario?: MockRuntimeScenario;
  readonly delayMs?: number;
};

export type MockRuntimeScenario =
  | "default"
  | "streaming"
  | "tool-calls"
  | "error"
  | "cancellation"
  | "long-running"
  | "permission"
  | "provider-unavailable"
  | "model-unavailable";

export type RuntimeProviderConfig =
  | CursorRuntimeConfig
  | OllamaRuntimeConfig
  | OpenAICompatibleRuntimeConfig
  | OpenRouterRuntimeConfig
  | MockRuntimeConfig;

export interface ResolvedRuntimeConfig {
  readonly provider: RuntimeProvider;
  /** Active provider profile id; locates the profile's stored credential. */
  readonly profileId?: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly scenario?: MockRuntimeScenario;
  readonly delayMs?: number;
}

export interface RuntimeToolExecutorContext {
  readonly session: CodeviaSession;
  readonly signal?: AbortSignal;
  /**
   * Live output hook for long-running tools (run_command). Chunks reach the UI
   * while the command runs instead of only when it exits.
   */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Human-in-the-loop gateway for `ask_user`. Injected by the runtime so the
   * tool never touches the webview or the broker directly.
   */
  readonly askUser?: (request: UserQuestionRequestInput) => Promise<UserQuestionAnswer>;
  /** Authoritative task-plan writer for `update_todo`. */
  readonly taskPlan?: { update(items: readonly TodoItem[]): TaskPlan };
}

export interface RuntimeToolExecutor {
  execute(call: RuntimeToolCall, context: RuntimeToolExecutorContext): Promise<unknown>;
}

export interface AgentRuntime {
  readonly provider: RuntimeProvider;
  readonly family: RuntimeProviderFamily;
  configure(config: RuntimeProviderConfig): Promise<void>;
  checkAvailability(signal?: AbortSignal): Promise<RuntimeAvailability>;
  discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]>;
  createSession(request: RuntimeSessionRequest): Promise<{ providerSessionId?: string }>;
  resumeSession(request: RuntimeResumeRequest): Promise<{ providerSessionId?: string }>;
  sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void>;
  cancel(request: RuntimeCancelRequest): Promise<void>;
  dispose(): void;
  /**
   * Seeds a fresh (empty) model history from restored transcript turns —
   * used once per session after a restart, when the in-memory history was
   * lost but the persisted transcript survived. Implementations must only
   * seed when their current history is empty (never overwrite live history)
   * and return whether they seeded. Turns are text-only by construction
   * (see contextRestore), so no tool_call_id pairing can break.
   */
  restoreHistory?(sessionId: string, turns: readonly RestoredHistoryTurn[]): boolean;
}

/**
 * Text-only conversation turn safe for history restoration. No `tool` role,
 * no `tool_calls`: replaying tool turns without their original provider ids
 * would produce an invalid conversation.
 */
export interface RestoredHistoryTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}
