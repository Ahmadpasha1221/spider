import type {
  AuthStatus,
  ExtensionInfoView,
  FileChangeView,
  LocalModel,
  LocalProvider,
  ModelInfo,
  PermissionRule,
  PermissionRuleCategory,
  RuntimeProvider,
  SessionListItem,
} from "./protocol";

export type AppView = "chat" | "history" | "settings";
/** Sections inside the redesigned Settings page. */
export type SettingsSection = "models" | "behaviour" | "autoApprove" | "indexing" | "about";

/** Live agent execution phase, derived only from backend runtime events. */
export type AgentPhase = "idle" | "submitting" | "streaming" | "toolRunning" | "completed" | "failed" | "cancelled";

/** Lifecycle of one tool/command execution box. */
export type ExecStatus = "running" | "completed" | "failed";

export interface ChatLine {
  role: "user" | "agent" | "thinking" | "error" | "system" | "tool";
  text: string;
  /**
   * Stable id for messages the user can act on (Copy/Delete). Assistant ids
   * come from the backend transcript entry; user ids are generated on send and
   * recorded with the prompt, so Delete reaches conversation persistence.
   */
  messageId?: string;
  streaming?: boolean;
  permission?: {
    requestId: string;
    command?: string;
    pending: boolean;
    destructive?: boolean;
  };
  command?: {
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    running?: boolean;
    toolCallId?: string;
  };
  /** Tool execution box lifecycle (tool_requested → running → completed/failed). */
  tool?: {
    toolCallId: string;
    toolName: string;
    status: ExecStatus;
    detail?: string;
    error?: string;
  };
  /** Artifact card: a meaningful file change produced by the agent. */
  artifact?: FileChangeView;
  fileChange?: FileChangeView;
}

export interface AppState {
  view: AppView;
  provider: RuntimeProvider;
  localProvider: LocalProvider;
  selectedModelId?: string;
  selectedModelName?: string;
  localModels: LocalModel[];
  localLoading: boolean;
  openRouterModels: ModelInfo[];
  openRouterLoading: boolean;
  openRouterModelFilter: string;
  runtimeConnected: boolean;
  runtimeError?: string;
  authStatus: AuthStatus;
  hasKey: boolean;
  authError?: string;
  authMessage?: string;
  connecting: boolean;
  running: boolean;
  /** Agent execution phase (backend events are the source of truth). */
  phase: AgentPhase;
  sessions: SessionListItem[];
  activeSessionId?: string;
  /**
   * True between clicking "New" and the host confirming the active
   * conversation, so a typed message can never attach to the previous one.
   */
  pendingNewConversation: boolean;
  messages: ChatLine[];
  lastPrompt?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number };
  modelCapabilities?: { streaming: boolean; toolCalling: boolean; reasoning?: boolean };
  /** Composer shield state (backend authoritative; GUI mirrors it). */
  autoApproveEnabled: boolean;
  autoApproveScope: "conversation" | "runtime";
  permissionRules: Partial<Record<PermissionRuleCategory, PermissionRule>>;
  permissionRulesLoaded: boolean;
  extensionInfo?: ExtensionInfoView;
  /** Currently open section of the redesigned Settings page. */
  settingsSection: SettingsSection;
}

export function createInitialState(): AppState {
  return {
    view: "chat",
    provider: "cursor",
    localProvider: "ollama",
    localModels: [],
    localLoading: false,
    openRouterModels: [],
    openRouterLoading: false,
    openRouterModelFilter: "",
    runtimeConnected: false,
    authStatus: "disconnected",
    hasKey: false,
    connecting: false,
    running: false,
    phase: "idle",
    sessions: [],
    pendingNewConversation: false,
    messages: [],
    autoApproveEnabled: false,
    autoApproveScope: "conversation",
    permissionRules: {},
    permissionRulesLoaded: false,
    settingsSection: "models",
  };
}

/** Maps backend AGENT_STATE values onto the UI phase machine. */
export function phaseFromAgentState(state: string): AgentPhase {
  switch (state) {
    case "starting":
    case "ready":
      return "submitting";
    case "running":
      return "streaming";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
}
