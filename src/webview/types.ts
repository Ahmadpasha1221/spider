import type { FileChangeSummary } from "../runtime/runtimeTypes";
import type { AgentSession } from "../agent/agentSession";
import type { PermissionRule, PermissionRuleCategory } from "./permissionRules";

export type { PermissionRule, PermissionRuleCategory } from "./permissionRules";

export type GuiRuntimeProvider = "cursor" | "local" | "mock" | "openrouter";
export type LocalProvider = "ollama" | "openai-compatible";

export type WebviewMessage =
  | { type: "SEND_PROMPT"; prompt: string; sessionId: string; messageId?: string }
  | { type: "GET_TRANSCRIPT"; sessionId: string }
  | { type: "CANCEL_RUN"; sessionId: string }
  | { type: "NEW_SESSION"; workspacePath?: string }
  | { type: "SELECT_SESSION"; sessionId: string }
  | { type: "STOP_AGENT"; sessionId: string }
  | { type: "CONNECT_CURSOR"; apiKey?: string }
  | { type: "CONNECT_OPENROUTER"; apiKey: string }
  | { type: "DISCONNECT_OPENROUTER" }
  | { type: "DISCOVER_OPENROUTER_MODELS" }
  | { type: "SELECT_OPENROUTER_MODEL"; modelId: string }
  | { type: "DISCONNECT_CURSOR" }
  | { type: "GET_AUTH_STATUS" }
  | { type: "GET_RUNTIME_STATUS" }
  | { type: "SELECT_RUNTIME"; provider: GuiRuntimeProvider; modelId?: string }
  | { type: "DISCOVER_LOCAL_MODELS"; provider?: LocalProvider }
  | { type: "CONNECT_LOCAL"; provider: LocalProvider; baseUrl?: string; apiKey?: string; modelId?: string }
  | { type: "SELECT_LOCAL_MODEL"; modelId: string }
  | { type: "USE_MOCK_RUNTIME" }
  | { type: "OPEN_FILE"; path: string }
  | { type: "OPEN_DIFF"; changeId: string }
  | { type: "RESOLVE_FILE_CHANGE"; changeId: string; decision: "ACCEPT" | "REJECT" }
  | { type: "APPROVE_PERMISSION"; requestId: string }
  | { type: "DENY_PERMISSION"; requestId: string }
  | { type: "TRY_AGAIN"; sessionId: string }
  | { type: "LIST_SESSIONS" }
  /** Composer shield: enable/disable the temporary runtime auto-approve. */
  | { type: "SET_RUNTIME_AUTO_APPROVE"; enabled: boolean; scope?: "conversation" | "runtime" }
  | { type: "GET_PERMISSION_RULES" }
  | { type: "SET_PERMISSION_RULE"; category: PermissionRuleCategory; rule: PermissionRule }
  /** Chat UI Delete: removes a message from UI and conversation persistence. */
  | { type: "DELETE_MESSAGE"; sessionId: string; messageId: string }
  /** `ask_user`: the user's answer to a pending agent question. */
  | { type: "ANSWER_USER_QUESTION"; requestId: string; answer: string }
  /** `ask_user`: the user dismissed the question without answering. */
  | { type: "CANCEL_USER_QUESTION"; requestId: string }
  | { type: "GET_EXTENSION_INFO" };

export type AuthStatus = "disconnected" | "connecting" | "connected" | "error";

export interface AuthStatusMessage {
  type: "AUTH_STATUS";
  status: AuthStatus;
  hasKey: boolean;
  error?: string;
  message?: string;
}

export interface LocalModelInfo {
  id: string;
  name: string;
  provider: LocalProvider;
}

/** Discovered model entry for dropdowns (local or OpenRouter). */
export interface ModelOption {
  id: string;
  name: string;
  contextWindow?: number;
  toolCalling?: boolean;
  vision?: boolean;
  pricing?: { promptUsdPerMillion?: number; completionUsdPerMillion?: number };
}

export interface OpenRouterModelListMessage {
  type: "OPENROUTER_MODELS";
  models: ModelOption[];
  error?: string;
}

export type SessionListItem = Pick<AgentSession, "sessionId" | "status" | "workspacePath" | "currentTask"> & {
  /** Epoch millis for History page display (optional for compatibility). */
  updatedAt?: number;
};

export interface FileChangeView {
  changeId: string;
  toolName: string;
  path: string;
  status: "APPLIED" | "REVERTED" | "MISSING";
  additions: number;
  deletions: number;
  isNewFile: boolean;
}

/** Categories exposed in Settings → Auto Approve (real permission categories). */
export interface PermissionRulesView {
  rules: Record<PermissionRuleCategory, PermissionRule>;
}

/** Static extension metadata for Settings → About Spider. */
export interface ExtensionInfoView {
  displayName: string;
  version: string;
  publisher: string;
  license: string;
  repositoryUrl?: string;
  activeProvider?: string;
  activeModelId?: string;
}

/** One choice offered by an `ask_user` question. */
export interface UserQuestionOptionView {
  label: string;
  value: string;
  description?: string;
}

/** One task-plan row (sanitized; the host owns the authoritative plan). */
export interface TodoItemView {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export type ExtensionMessage =
  | { type: "AGENT_STATE"; state: AgentState }
  | { type: "AGENT_MESSAGE"; message: string; messageId?: string }
  | { type: "AGENT_TEXT_DELTA"; sessionId: string; text: string }
  | { type: "AGENT_USAGE"; promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number }
  | { type: "FILE_CHANGE"; change: FileChangeView }
  | { type: "FILE_CHANGE_REVERTED"; change: FileChangeView }
  | { type: "AGENT_THINKING"; message: string }
  | { type: "AGENT_TOOL_CALL"; toolCall: { toolCallId?: string; toolName?: string; command?: string; path?: string } }
  | { type: "AGENT_TOOL_RESULT"; result: { toolCallId?: string; toolName?: string; error?: string } }
  | { type: "AGENT_COMMAND_OUTPUT"; command: string; toolCallId?: string; cwd?: string; stdout: string; stderr: string; exitCode: number | null; partial?: boolean }
  | { type: "AGENT_ERROR"; error: string }
  | { type: "PERMISSION_REQUEST"; requestId: string; message: string; command?: string; category?: string; destructive?: boolean }
  | { type: "SESSION_UPDATED"; sessions: SessionListItem[]; activeSessionId?: string }
  | { type: "AUTO_APPROVE_STATE"; enabled: boolean; scope: "conversation" | "runtime" }
  | { type: "PERMISSION_RULES"; rules: Record<PermissionRuleCategory, PermissionRule> }
  /** `ask_user`: a question the agent is waiting on (correlated by requestId). */
  | {
      type: "USER_QUESTION";
      requestId: string;
      question: string;
      options?: UserQuestionOptionView[];
      defaultOption?: string;
      context?: string;
    }
  /** `ask_user`: the question is no longer pending (answered/cancelled). */
  | { type: "USER_QUESTION_CLOSED"; requestId: string }
  /** `update_todo`: sanitized task-plan snapshot for the active conversation. */
  | { type: "TODO_UPDATED"; sessionId: string; items: TodoItemView[] }
  | { type: "EXTENSION_INFO"; info: ExtensionInfoView }
  | AuthStatusMessage
  | {
      type: "RUNTIME_STATUS";
      provider: GuiRuntimeProvider;
      connected: boolean;
      modelId?: string;
      modelName?: string;
      localProvider?: LocalProvider;
      error?: string;
    }
  | { type: "LOCAL_MODELS"; provider: LocalProvider; models: LocalModelInfo[]; error?: string }
  | OpenRouterModelListMessage
  | { type: "SHOW_SETTINGS" }
  | { type: "RUN_STARTED"; runId: string }
  | { type: "RUN_COMPLETED"; runId: string }
  | {
      type: "TRANSCRIPT";
      sessionId: string;
      entries: Array<{
        id?: string;
        kind: "user" | "assistant" | "thinking" | "tool" | "command" | "error" | "system";
        text: string;
        timestamp: number;
        toolName?: string;
        command?: string;
        path?: string;
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
        error?: string;
      }>;
    };

export type AgentState = "idle" | "starting" | "ready" | "running" | "completed" | "failed" | "cancelled" | "disconnected";

export type { FileChangeSummary };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof (value as { type: unknown }).type === "string";
}
