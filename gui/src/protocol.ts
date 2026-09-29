export type AuthStatus = "disconnected" | "connecting" | "connected" | "error";
export type RuntimeProvider = "cursor" | "local" | "mock" | "openrouter";
export type LocalProvider = "ollama" | "openai-compatible";

export interface LocalModel {
  id: string;
  name: string;
  provider: LocalProvider;
  capabilities?: {
    streaming?: boolean;
    toolCalling?: boolean;
  };
}

/** Discovered model with display metadata (OpenRouter catalog or local). */
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  toolCalling?: boolean;
  vision?: boolean;
  pricing?: { promptUsdPerMillion?: number; completionUsdPerMillion?: number };
}

export type GuiToHost =
  | { type: "SEND_PROMPT"; prompt: string; sessionId: string; messageId?: string }
  | { type: "TRY_AGAIN"; sessionId: string }
  | { type: "CANCEL_RUN"; sessionId: string }
  | { type: "NEW_SESSION" }
  | { type: "SELECT_SESSION"; sessionId: string }
  | { type: "CONNECT_CURSOR"; apiKey?: string }
  | { type: "DISCONNECT_CURSOR" }
  | { type: "CONNECT_OPENROUTER"; apiKey: string }
  | { type: "DISCONNECT_OPENROUTER" }
  | { type: "DISCOVER_OPENROUTER_MODELS" }
  | { type: "SELECT_OPENROUTER_MODEL"; modelId: string }
  | { type: "GET_AUTH_STATUS" }
  | { type: "LIST_SESSIONS" }
  | { type: "GET_TRANSCRIPT"; sessionId: string }
  | { type: "GET_RUNTIME_STATUS" }
  | { type: "SELECT_RUNTIME"; provider: RuntimeProvider; modelId?: string }
  | { type: "DISCOVER_LOCAL_MODELS"; provider?: LocalProvider }
  | { type: "CONNECT_LOCAL"; provider: LocalProvider; baseUrl?: string; apiKey?: string; modelId?: string }
  | { type: "SELECT_LOCAL_MODEL"; modelId: string }
  | { type: "USE_MOCK_RUNTIME" }
  | { type: "APPROVE_PERMISSION"; requestId: string }
  | { type: "DENY_PERMISSION"; requestId: string }
  /** Composer shield: temporary runtime auto-approve (backend authoritative). */
  | { type: "SET_RUNTIME_AUTO_APPROVE"; enabled: boolean; scope?: "conversation" | "runtime" }
  | { type: "GET_PERMISSION_RULES" }
  | { type: "SET_PERMISSION_RULE"; category: PermissionRuleCategory; rule: PermissionRule }
  /** Chat UI Delete: removes a message from the UI and conversation persistence. */
  | { type: "DELETE_MESSAGE"; sessionId: string; messageId: string }
  | { type: "GET_EXTENSION_INFO" }
  | { type: "OPEN_DIFF"; changeId: string }
  | { type: "RESOLVE_FILE_CHANGE"; changeId: string; decision: "ACCEPT" | "REJECT" }
  | { type: "OPEN_FILE"; path: string };

export interface SessionListItem {
  sessionId: string;
  status: string;
  workspacePath: string;
  currentTask?: string;
  updatedAt?: number;
}

/** Categories exposed in Settings → Auto Approve (mirror of src/webview). */
export type PermissionRuleCategory = "READ" | "MODIFY" | "EXECUTE" | "EXTERNAL" | "DESTRUCTIVE";
/** Per-category default: auto-allow, always ask, or always deny. */
export type PermissionRule = "allow" | "ask" | "deny";

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

export interface FileChangeView {
  changeId: string;
  toolName: string;
  path: string;
  status: "APPLIED" | "REVERTED" | "MISSING";
  additions: number;
  deletions: number;
  isNewFile: boolean;
}

export type HostToGui =
  | { type: "AGENT_STATE"; state: string }
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
  | { type: "EXTENSION_INFO"; info: ExtensionInfoView }
  | { type: "AUTH_STATUS"; status: AuthStatus; hasKey: boolean; error?: string; message?: string }
  | { type: "RUNTIME_STATUS"; provider: RuntimeProvider; connected: boolean; modelId?: string; modelName?: string; localProvider?: LocalProvider; error?: string }
  | { type: "LOCAL_MODELS"; provider: LocalProvider; models: LocalModel[]; error?: string }
  | { type: "OPENROUTER_MODELS"; models: ModelInfo[]; error?: string }
  | { type: "SHOW_SETTINGS" }
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
