import { AgentManager } from "../agent/agentManager";
import { AgentEvent } from "../agent/agentEvents";
import { CursorAuthError } from "../auth/cursorAuthError";
import type { CursorConnection } from "../auth/cursorConnection";
import { CursorClient } from "../auth/cursorClient";
import { RuntimeManager } from "../runtime/runtimeManager";
import type { FileChangeSummary, RuntimeEvent, RuntimeModel, RuntimeProviderConfig } from "../runtime/runtimeTypes";
import { DEFAULT_OLLAMA_BASE_URL } from "../runtime/ollama/ollamaRuntime";
import type { SecretStorage } from "../auth/secretStorage";
import type { PermissionManager } from "../permissions/permissionManager";
import { isPermissionRule, isPermissionRuleCategory } from "./permissionRules";
import { EXTENSION_VERSION, OPENROUTER_API_KEY_SECRET_KEY } from "../shared/constants";
import {
  AgentState,
  ExtensionMessage,
  FileChangeView,
  GuiRuntimeProvider,
  LocalProvider,
  ModelOption,
  WebviewMessage,
} from "./types";

export class MessageRouter {
  /** Optional late-bound permission manager (tests, non-extension contexts). */
  private permissionManager?: PermissionManager;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly defaultWorkspacePath = ".",
    private readonly connection?: CursorConnection,
    private readonly cursorClient?: CursorClient,
    private readonly runtimeManager?: RuntimeManager,
    private readonly openRouterSecrets?: SecretStorage,
    dependencies?: { permissionManager?: PermissionManager },
  ) {
    this.permissionManager = dependencies?.permissionManager;
  }

  setPermissionManager(permissionManager: PermissionManager): void {
    this.permissionManager = permissionManager;
  }

  usesManagedRuntime(): boolean {
    const provider = this.runtimeManager?.provider;
    return (
      provider === "ollama"
      || provider === "openai-compatible"
      || provider === "openrouter"
      || provider === "mock"
    );
  }

  async handleMessage(message: unknown): Promise<unknown> {
    const typed = this.validate(message);

    switch (typed.type) {
      case "SEND_PROMPT": {
        if (this.usesManagedRuntime() && this.runtimeManager) {
          await this.runtimeManager.startTask(typed.sessionId, typed.prompt);
          return { success: true };
        }
        if (this.cursorClient && !this.cursorClient.hasApiKey()) {
          throw new CursorAuthError("Connect a Cursor API key before sending a prompt.", 401);
        }
        await this.agentManager.startTask(typed.sessionId, typed.prompt);
        return { success: true };
      }
      case "TRY_AGAIN": {
        if (this.usesManagedRuntime() && this.runtimeManager) {
          await this.runtimeManager.retryTask(typed.sessionId);
          return { success: true };
        }
        return { success: true };
      }
      case "CANCEL_RUN":
      case "STOP_AGENT": {
        if (this.usesManagedRuntime() && this.runtimeManager) {
          await this.runtimeManager.cancelTask(typed.sessionId);
          return { success: true };
        }
        await this.agentManager.cancelTask(typed.sessionId);
        return { success: true };
      }
      case "NEW_SESSION": {
        const workspacePath = typed.workspacePath ?? this.defaultWorkspacePath;
        if (this.usesManagedRuntime() && this.runtimeManager) {
          // Reuse the active conversation while it is still empty so repeated
          // "New" clicks do not pile up blank sessions.
          const active = this.runtimeManager.activeSession;
          if (active && (await this.runtimeManager.loadTranscript(active.sessionId)).length === 0) {
            return { success: true, session: active };
          }
          const session = this.runtimeManager.createSession(workspacePath);
          return { success: true, session };
        }
        const activeAgent = this.agentManager.activeSession;
        if (activeAgent && (await this.agentManager.loadTranscript(activeAgent.sessionId)).length === 0) {
          return { success: true, session: activeAgent };
        }
        const session = this.agentManager.createSession(workspacePath);
        return { success: true, session };
      }
      case "SELECT_SESSION": {
        if (this.usesManagedRuntime() && this.runtimeManager) {
          return { success: true, selected: this.runtimeManager.selectSession(typed.sessionId) };
        }
        const selected = this.agentManager.selectSession(typed.sessionId);
        return { success: true, selected };
      }
      case "LIST_SESSIONS": {
        if (this.usesManagedRuntime() && this.runtimeManager) {
          return { success: true, sessions: this.runtimeManager.listSessions() };
        }
        return { success: true, sessions: this.agentManager.listSessions() };
      }
      case "GET_TRANSCRIPT": {
        if (this.usesManagedRuntime() && this.runtimeManager) {
          const entries = await this.runtimeManager.loadTranscript(typed.sessionId);
          return { type: "TRANSCRIPT", sessionId: typed.sessionId, entries };
        }
        const entries = await this.agentManager.loadTranscript(typed.sessionId);
        return { type: "TRANSCRIPT", sessionId: typed.sessionId, entries };
      }
      case "OPEN_FILE":
        if (this.runtimeManager) {
          await this.runtimeManager.openFile(typed.path);
        }
        return { success: true };
      case "OPEN_DIFF":
        if (this.runtimeManager) {
          await this.runtimeManager.showFileChangeDiff(typed.changeId);
        }
        return { success: true };
      case "RESOLVE_FILE_CHANGE": {
        if (this.runtimeManager) {
          const resolved = await this.runtimeManager.resolveFileChange(typed.changeId, typed.decision);
          if (resolved) {
            return {
              type: typed.decision === "REJECT" ? "FILE_CHANGE_REVERTED" : "FILE_CHANGE",
              change: toFileChangeView(resolved),
            };
          }
        }
        return { success: true };
      }
      case "APPROVE_PERMISSION":
      case "DENY_PERMISSION": {
        if (this.runtimeManager) {
          this.runtimeManager.resolvePermission(typed.requestId, typed.type === "APPROVE_PERMISSION" ? "ALLOW" : "DENY");
        }
        return { success: true };
      }
      case "SET_RUNTIME_AUTO_APPROVE": {
        if (!this.permissionManager) {
          return { type: "AUTO_APPROVE_STATE", enabled: false, scope: "conversation" };
        }
        // The manager is authoritative: it clamps scope and echoes the
        // effective state back, which the GUI synchronizes to.
        const scope = typed.scope === "runtime" ? "runtime" : "conversation";
        const state = this.permissionManager.setRuntimeAutoApprove(typed.enabled, scope);
        return { type: "AUTO_APPROVE_STATE", enabled: state.enabled, scope: state.scope };
      }
      case "GET_PERMISSION_RULES": {
        if (!this.permissionManager) {
          return { type: "PERMISSION_RULES", rules: emptyRules() };
        }
        return { type: "PERMISSION_RULES", rules: { ...this.permissionManager.listPermissionRules().rules } };
      }
      case "SET_PERMISSION_RULE": {
        if (!this.permissionManager) {
          return { type: "PERMISSION_RULES", rules: emptyRules() };
        }
        if (!isPermissionRuleCategory(typed.category) || !isPermissionRule(typed.rule)) {
          throw new Error("Invalid SET_PERMISSION_RULE message");
        }
        const snapshot = this.permissionManager.setPermissionRule(typed.category, typed.rule);
        return { type: "PERMISSION_RULES", rules: { ...snapshot.rules } };
      }
      case "GET_EXTENSION_INFO":
        return {
          type: "EXTENSION_INFO",
          info: {
            displayName: "Spider",
            version: EXTENSION_VERSION,
            publisher: "codevia",
            license: "MIT",
            repositoryUrl: "https://github.com/codevia/codevia-cursor",
            activeProvider: this.runtimeManager?.provider,
            ...(this.runtimeManager?.getProviderConfig()?.modelId
              ? { activeModelId: this.runtimeManager.getProviderConfig()?.modelId }
              : {}),
          },
        } as ExtensionMessage;
      case "CONNECT_CURSOR": {
        if (!this.connection) {
          return { success: true };
        }
        return this.connection.connect(typed.apiKey);
      }
      case "CONNECT_OPENROUTER": {
        if (!this.runtimeManager || !this.openRouterSecrets) {
          return { type: "RUNTIME_STATUS", provider: "openrouter", connected: false, error: "OpenRouter is not configured." } as ExtensionMessage;
        }
        const apiKey = typed.apiKey.trim();
        if (apiKey.length === 0) {
          return { type: "RUNTIME_STATUS", provider: "openrouter", connected: false, error: "Enter an OpenRouter API key first." } as ExtensionMessage;
        }
        await this.openRouterSecrets.store(OPENROUTER_API_KEY_SECRET_KEY, apiKey);
        await this.connectOpenRouter(apiKey);
        return this.openRouterStatus();
      }
      case "DISCONNECT_OPENROUTER": {
        if (this.openRouterSecrets) {
          await this.openRouterSecrets.delete(OPENROUTER_API_KEY_SECRET_KEY);
        }
        return this.openRouterStatus();
      }
      case "DISCONNECT_CURSOR": {
        if (!this.connection) {
          return { success: true };
        }
        return this.connection.disconnect();
      }
      case "GET_AUTH_STATUS": {
        if (!this.connection) {
          return { type: "AUTH_STATUS", status: "disconnected", hasKey: false };
        }
        return this.connection.getStatus();
      }
      case "GET_RUNTIME_STATUS":
        return this.runtimeStatus();
      case "SELECT_RUNTIME":
        return this.selectGuiRuntime(typed.provider, typed.modelId);
      case "DISCOVER_OPENROUTER_MODELS":
        return this.discoverOpenRouterModels();
      case "SELECT_OPENROUTER_MODEL":
        return this.selectOpenRouterModel(typed.modelId);
      case "DISCOVER_LOCAL_MODELS":
        return this.discoverLocalModels(typed.provider ?? "ollama");
      case "CONNECT_LOCAL":
        return this.connectLocal(typed.provider, typed.baseUrl, typed.apiKey, typed.modelId);
      case "SELECT_LOCAL_MODEL":
        return this.selectLocalModel(typed.modelId);
      case "USE_MOCK_RUNTIME":
        return this.useMockRuntime();
      default: {
        const _exhaustive: never = typed;
        return _exhaustive;
      }
    }
  }

  toExtensionMessage(event: AgentEvent): ExtensionMessage | undefined {
    switch (event.type) {
      case "agent_started":
        return { type: "AGENT_STATE", state: "starting" };
      case "agent_thinking":
        return { type: "AGENT_THINKING", message: event.message };
      case "assistant_message":
        return { type: "AGENT_MESSAGE", message: event.message };
      case "tool_started":
        return { type: "AGENT_TOOL_CALL", toolCall: { toolName: event.toolName } };
      case "tool_finished":
        return { type: "AGENT_TOOL_RESULT", result: { toolName: event.toolName } };
      case "file_changed":
        return { type: "AGENT_MESSAGE", message: `File changed: ${event.path}` };
      case "command_started":
        return { type: "AGENT_MESSAGE", message: `Command started: ${event.command}` };
      case "command_finished":
        return { type: "AGENT_MESSAGE", message: `Command finished: ${event.command}` };
      case "permission_required":
        return { type: "PERMISSION_REQUEST", requestId: event.requestId, message: event.message };
      case "agent_permission":
        return {
          type: "PERMISSION_REQUEST",
          requestId: event.request.requestId,
          message: event.request.description,
        };
      case "agent_completed":
        return { type: "AGENT_STATE", state: "completed" };
      case "agent_disconnected":
        return { type: "AGENT_STATE", state: "disconnected" };
      case "agent_cancelled":
        return { type: "AGENT_STATE", state: "cancelled" };
      case "agent_error":
        return { type: "AGENT_ERROR", error: event.error };
      default:
        return undefined;
    }
  }

  toRuntimeExtensionMessage(event: RuntimeEvent): ExtensionMessage | undefined {
    switch (event.type) {
      case "status":
        return { type: "AGENT_STATE", state: toAgentState(event.status) };
      case "thinking":
        return { type: "AGENT_THINKING", message: event.message };
      case "assistant_message":
        return { type: "AGENT_MESSAGE", message: event.message };
      case "text_delta":
        return { type: "AGENT_TEXT_DELTA", sessionId: event.sessionId, text: event.text };
      case "usage":
        return {
          type: "AGENT_USAGE",
          promptTokens: event.usage.promptTokens,
          completionTokens: event.usage.completionTokens,
          totalTokens: event.usage.totalTokens,
          ...(event.usage.costUsd !== undefined ? { costUsd: event.usage.costUsd } : {}),
        };
      case "file_change":
        return { type: "FILE_CHANGE", change: toFileChangeView(event.change) };
      case "file_change_reverted":
        return { type: "FILE_CHANGE_REVERTED", change: toFileChangeView(event.change) };
      case "tool_call":
        return {
          type: "AGENT_TOOL_CALL",
          toolCall: {
            toolCallId: event.toolCall.id,
            toolName: event.toolCall.name,
            command: commandFromInput(event.toolCall.input),
            path: pathFromInput(event.toolCall.input),
          },
        };
      case "tool_running":
        return undefined;
      case "tool_result":
        return {
          type: "AGENT_TOOL_RESULT",
          result: {
            toolCallId: event.toolResult.toolCallId,
            toolName: event.toolResult.name,
            error: event.toolResult.error,
          },
        };
      case "command_output":
        return {
          type: "AGENT_COMMAND_OUTPUT",
          command: event.command,
          toolCallId: event.toolCallId,
          cwd: event.cwd,
          stdout: event.stdout,
          stderr: event.stderr,
          exitCode: event.exitCode,
        };
      case "permission_request":
        return {
          type: "PERMISSION_REQUEST",
          requestId: event.request.requestId,
          message: "Permission required",
          command: event.request.command ?? event.request.toolName,
          category: event.request.category,
          destructive: event.request.destructive,
        };
      case "error":
        return { type: "AGENT_ERROR", error: event.error.message };
      case "completed":
        return { type: "AGENT_STATE", state: "completed" };
      case "cancelled":
        return { type: "AGENT_STATE", state: "cancelled" };
      default:
        return undefined;
    }
  }

  /**
   * Maps permission-layer events (shield toggles) onto webview messages. The
   * RuntimeManager event bus only carries RuntimeEvent values, so shield
   * state changes travel through the same emitter via a typed wrapper.
   */
  toAutoApproveStateMessage(state: { enabled: boolean; scope: "conversation" | "runtime" }): ExtensionMessage {
    return { type: "AUTO_APPROVE_STATE", enabled: state.enabled, scope: state.scope };
  }

  runtimeStatus(error?: string): ExtensionMessage {
    const provider = this.runtimeManager?.provider;
    const config = this.runtimeManager?.getProviderConfig();
    if (provider === "openrouter") {
      return this.openRouterStatus(error);
    }
    if (provider === "ollama" || provider === "openai-compatible") {
      return {
        type: "RUNTIME_STATUS",
        provider: "local",
        connected: !error,
        modelId: config?.modelId,
        modelName: config?.modelId,
        localProvider: provider,
        ...(error ? { error } : {}),
      };
    }
    if (provider === "mock") {
      return {
        type: "RUNTIME_STATUS",
        provider: "mock",
        connected: !error,
        ...(error ? { error } : {}),
      };
    }
    return {
      type: "RUNTIME_STATUS",
      provider: "cursor",
      connected: this.cursorClient?.hasApiKey() ?? false,
      ...(error ? { error } : {}),
    };
  }

  /** Connects the OpenRouter runtime using the stored API key. */
  private async connectOpenRouter(apiKey: string): Promise<void> {
    if (!this.runtimeManager) {
      return;
    }
    const storedModelId = await this.loadSavedOpenRouterModelId();
    await this.runtimeManager.setProvider({ provider: "openrouter", apiKey, ...(storedModelId ? { modelId: storedModelId } : {}) });
    if (this.runtimeManager.listSessions().length === 0) {
      this.runtimeManager.createSession(this.defaultWorkspacePath);
    }
  }

  private async loadSavedOpenRouterModelId(): Promise<string | undefined> {
    const config = this.runtimeManager?.getProviderConfig();
    return config?.provider === "openrouter" ? config.modelId : undefined;
  }

  private async discoverOpenRouterModels(): Promise<ExtensionMessage> {
    if (!this.runtimeManager) {
      return { type: "OPENROUTER_MODELS", models: [], error: "OpenRouter runtime is not configured." };
    }
    const apiKey = await this.resolveOpenRouterApiKey();
    if (!apiKey) {
      return { type: "OPENROUTER_MODELS", models: [], error: "Connect OpenRouter with an API key first." };
    }
    try {
      // Switch the active runtime so discovery goes through RuntimeManager.
      await this.runtimeManager.setProvider({ provider: "openrouter", apiKey, ...(await this.modelIdFor()) });
      const models = await this.runtimeManager.discoverModels();
      return { type: "OPENROUTER_MODELS", models: models.map(toModelOption) };
    } catch (error) {
      return {
        type: "OPENROUTER_MODELS",
        models: [],
        error: error instanceof Error ? error.message : "Could not list OpenRouter models.",
      };
    }
  }

  private async modelIdFor(): Promise<{ modelId: string } | Record<string, never>> {
    const config = this.runtimeManager?.getProviderConfig();
    if (config?.provider === "openrouter" && config.modelId) {
      return { modelId: config.modelId };
    }
    return {};
  }

  private async selectOpenRouterModel(modelId: string): Promise<ExtensionMessage> {
    if (!this.runtimeManager) {
      return this.runtimeStatus("OpenRouter runtime is not configured.");
    }
    if (this.runtimeManager.provider !== "openrouter") {
      const apiKey = await this.resolveOpenRouterApiKey();
      if (!apiKey) {
        return { type: "RUNTIME_STATUS", provider: "openrouter", connected: false, error: "Connect OpenRouter with an API key first." };
      }
      await this.runtimeManager.setProvider({ provider: "openrouter", apiKey, modelId });
    } else {
      await this.runtimeManager.setProvider({ provider: "openrouter", modelId, ...(await this.apiKeyForRuntime()) });
    }
    if (this.runtimeManager.listSessions().length === 0) {
      this.runtimeManager.createSession(this.defaultWorkspacePath);
    }
    return this.runtimeStatus();
  }

  private async apiKeyForRuntime(): Promise<{ apiKey: string } | Record<string, never>> {
    const config = this.runtimeManager?.getProviderConfig();
    if (config?.provider === "openrouter" && config.apiKey) {
      return { apiKey: config.apiKey };
    }
    return {};
  }

  private async resolveOpenRouterApiKey(): Promise<string | undefined> {
    const config = this.runtimeManager?.getProviderConfig();
    if (config?.provider === "openrouter" && config.apiKey) {
      return config.apiKey;
    }
    return this.openRouterSecrets?.get(OPENROUTER_API_KEY_SECRET_KEY);
  }

  private openRouterStatus(error?: string): ExtensionMessage {
    const config = this.runtimeManager?.getProviderConfig();
    const connected = this.runtimeManager?.provider === "openrouter" && !error;
    return {
      type: "RUNTIME_STATUS",
      provider: "openrouter",
      connected,
      modelId: config?.provider === "openrouter" ? config.modelId : undefined,
      modelName: config?.provider === "openrouter" ? config.modelId : undefined,
      ...(error ? { error } : {}),
    };
  }

  private async discoverLocalModels(provider: LocalProvider): Promise<ExtensionMessage> {
    if (!this.runtimeManager) {
      return { type: "LOCAL_MODELS", provider, models: [], error: "Local runtime is not configured." };
    }

    try {
      await this.runtimeManager.setProvider(localConfig(provider));
      const models = await this.runtimeManager.discoverModels();
      if (models[0] && provider === "ollama") {
        await this.runtimeManager.setProvider(localConfig(provider, undefined, undefined, models[0].id));
        if (this.runtimeManager.listSessions().length === 0) {
          this.runtimeManager.createSession(this.defaultWorkspacePath);
        }
      }
      return {
        type: "LOCAL_MODELS",
        provider,
        models: models.map(toLocalModel),
      };
    } catch (error) {
      return {
        type: "LOCAL_MODELS",
        provider,
        models: [],
        error: error instanceof Error ? error.message : "Could not list local models.",
      };
    }
  }

  private async connectLocal(
    provider: LocalProvider,
    baseUrl?: string,
    apiKey?: string,
    modelId?: string,
  ): Promise<ExtensionMessage> {
    if (!this.runtimeManager) {
      return this.runtimeStatus("Local runtime is not configured.");
    }

    try {
      await this.runtimeManager.setProvider(localConfig(provider, baseUrl, apiKey, modelId));
      const availability = await this.runtimeManager.checkAvailability();
      if (!availability.available) {
        return this.runtimeStatus(availability.message ?? "Local AI is not available.");
      }
      if (this.runtimeManager.listSessions().length === 0) {
        this.runtimeManager.createSession(this.defaultWorkspacePath);
      }
      return this.runtimeStatus();
    } catch (error) {
      return this.runtimeStatus(error instanceof Error ? error.message : "Could not connect to the local model.");
    }
  }

  private async selectLocalModel(modelId: string): Promise<ExtensionMessage> {
    const provider = this.runtimeManager?.provider;
    if (provider !== "ollama" && provider !== "openai-compatible") {
      return this.runtimeStatus("Select a local provider first.");
    }
    return this.connectLocal(provider, undefined, undefined, modelId);
  }

  private async useMockRuntime(): Promise<ExtensionMessage> {
    if (!this.runtimeManager) {
      return this.runtimeStatus("Mock runtime is not configured.");
    }
    await this.runtimeManager.setProvider({ provider: "mock" });
    if (this.runtimeManager.listSessions().length === 0) {
      this.runtimeManager.createSession(this.defaultWorkspacePath);
    }
    return this.runtimeStatus();
  }

  private async selectGuiRuntime(provider: GuiRuntimeProvider, modelId?: string): Promise<ExtensionMessage> {
    if (provider === "mock") {
      return this.useMockRuntime();
    }
    if (provider === "local") {
      return this.discoverLocalModels("ollama");
    }
    if (provider === "openrouter") {
      const apiKey = await this.resolveOpenRouterApiKey();
      if (!apiKey) {
        return {
          type: "RUNTIME_STATUS",
          provider: "openrouter",
          connected: false,
          error: "Connect OpenRouter with an API key first.",
        };
      }
      await this.connectOpenRouter(apiKey);
      return this.openRouterStatus();
    }
    void modelId;
    return {
      type: "RUNTIME_STATUS",
      provider: "cursor",
      connected: this.cursorClient?.hasApiKey() ?? false,
    };
  }

  private validate(message: unknown): WebviewMessage {
    if (typeof message !== "object" || message === null) {
      throw new Error("Invalid message shape");
    }

    const typed = message as Record<string, unknown>;
    const type = typed.type;

    if (typeof type !== "string") {
      throw new Error("Missing message type");
    }

    switch (type) {
      case "SEND_PROMPT":
        if (typeof typed.prompt !== "string" || typeof typed.sessionId !== "string") {
          throw new Error("Invalid SEND_PROMPT message");
        }
        return message as WebviewMessage;
      case "CANCEL_RUN":
      case "STOP_AGENT":
      case "SELECT_SESSION":
      case "TRY_AGAIN":
        if (typeof typed.sessionId !== "string") {
          throw new Error(`Invalid ${type} message`);
        }
        return message as WebviewMessage;
      case "LIST_SESSIONS":
      case "GET_AUTH_STATUS":
      case "GET_RUNTIME_STATUS":
      case "USE_MOCK_RUNTIME":
        return message as WebviewMessage;
      case "GET_TRANSCRIPT":
        if (typeof typed.sessionId !== "string") {
          throw new Error("Invalid GET_TRANSCRIPT message");
        }
        return message as WebviewMessage;
      case "NEW_SESSION":
        if (typed.workspacePath !== undefined && typeof typed.workspacePath !== "string") {
          throw new Error("Invalid NEW_SESSION message");
        }
        return message as WebviewMessage;
      case "OPEN_FILE":
        if (typeof typed.path !== "string") {
          throw new Error("Invalid OPEN_FILE message");
        }
        return message as WebviewMessage;
      case "OPEN_DIFF":
        if (typeof typed.changeId !== "string") {
          throw new Error("Invalid OPEN_DIFF message");
        }
        return message as WebviewMessage;
      case "RESOLVE_FILE_CHANGE":
        if (
          typeof typed.changeId !== "string"
          || (typed.decision !== "ACCEPT" && typed.decision !== "REJECT")
        ) {
          throw new Error("Invalid RESOLVE_FILE_CHANGE message");
        }
        return message as WebviewMessage;
      case "APPROVE_PERMISSION":
      case "DENY_PERMISSION":
        if (typeof typed.requestId !== "string") {
          throw new Error(`Invalid ${type} message`);
        }
        return message as WebviewMessage;
      case "SET_RUNTIME_AUTO_APPROVE":
        if (typeof typed.enabled !== "boolean") {
          throw new Error("Invalid SET_RUNTIME_AUTO_APPROVE message");
        }
        if (typed.scope !== undefined && typed.scope !== "conversation" && typed.scope !== "runtime") {
          throw new Error("Invalid SET_RUNTIME_AUTO_APPROVE message");
        }
        return message as WebviewMessage;
      case "GET_PERMISSION_RULES":
        return message as WebviewMessage;
      case "SET_PERMISSION_RULE":
        if (!isPermissionRuleCategory(typed.category) || !isPermissionRule(typed.rule)) {
          throw new Error("Invalid SET_PERMISSION_RULE message");
        }
        return message as WebviewMessage;
      case "GET_EXTENSION_INFO":
        return message as WebviewMessage;
      case "CONNECT_CURSOR":
        if (typed.apiKey !== undefined && typeof typed.apiKey !== "string") {
          throw new Error("Invalid CONNECT_CURSOR message");
        }
        return message as WebviewMessage;
      case "DISCONNECT_CURSOR":
        return message as WebviewMessage;
      case "CONNECT_OPENROUTER":
        if (typeof typed.apiKey !== "string") {
          throw new Error("Invalid CONNECT_OPENROUTER message");
        }
        return message as WebviewMessage;
      case "DISCONNECT_OPENROUTER":
        return message as WebviewMessage;
      case "DISCOVER_OPENROUTER_MODELS":
        return message as WebviewMessage;
      case "SELECT_OPENROUTER_MODEL":
        if (typeof typed.modelId !== "string" || (typed.modelId as string).trim().length === 0) {
          throw new Error("Invalid SELECT_OPENROUTER_MODEL message");
        }
        return message as WebviewMessage;
      case "SELECT_RUNTIME":
        if (typed.provider !== "cursor" && typed.provider !== "local" && typed.provider !== "mock" && typed.provider !== "openrouter") {
          throw new Error("Invalid SELECT_RUNTIME message");
        }
        return message as WebviewMessage;
      case "DISCOVER_LOCAL_MODELS":
        if (typed.provider !== undefined && typed.provider !== "ollama" && typed.provider !== "openai-compatible") {
          throw new Error("Invalid DISCOVER_LOCAL_MODELS message");
        }
        return message as WebviewMessage;
      case "CONNECT_LOCAL":
        if (typed.provider !== "ollama" && typed.provider !== "openai-compatible") {
          throw new Error("Invalid CONNECT_LOCAL message");
        }
        return message as WebviewMessage;
      case "SELECT_LOCAL_MODEL":
        if (typeof typed.modelId !== "string") {
          throw new Error("Invalid SELECT_LOCAL_MODEL message");
        }
        return message as WebviewMessage;
      default: {
        throw new Error(`Unknown message type: ${type}`);
      }
    }
  }
}

function emptyRules() {
  return {
    READ: "ask",
    MODIFY: "ask",
    EXECUTE: "ask",
    EXTERNAL: "ask",
    DESTRUCTIVE: "ask",
  } as Record<import("./types").PermissionRuleCategory, import("./types").PermissionRule>;
}

function localConfig(
  provider: LocalProvider,
  baseUrl?: string,
  apiKey?: string,
  modelId?: string,
): RuntimeProviderConfig {
  if (provider === "openai-compatible") {
    return {
      provider,
      baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : "http://127.0.0.1:1234/v1",
      modelId: modelId && modelId.length > 0 ? modelId : "local-model",
      ...(apiKey ? { apiKey } : {}),
    };
  }
  return {
    provider: "ollama",
    baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : DEFAULT_OLLAMA_BASE_URL,
    ...(modelId ? { modelId } : {}),
  };
}

/** Maps a discovered RuntimeModel to the dropdown option shape sent to the GUI. */
function toModelOption(model: RuntimeModel): ModelOption {
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.capabilities?.toolCalling !== undefined ? { toolCalling: model.capabilities.toolCalling } : {}),
    ...(model.capabilities?.vision !== undefined ? { vision: model.capabilities.vision } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {}),
  };
}

function toLocalModel(model: RuntimeModel): { id: string; name: string; provider: LocalProvider } {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider === "openai-compatible" ? "openai-compatible" : "ollama",
  };
}

function toFileChangeView(change: FileChangeSummary): FileChangeView {
  return {
    changeId: change.changeId,
    toolName: change.toolName,
    path: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    isNewFile: !change.beforeExists,
  };
}

function toAgentState(status: string): AgentState {
  switch (status) {
    case "STARTING":
      return "starting";
    case "READY":
      return "ready";
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "completed";
    case "CANCELLED":
    case "CANCELLING":
      return "cancelled";
    case "FAILED":
      return "failed";
    case "DISCONNECTED":
      return "disconnected";
    default:
      return "idle";
  }
}

function commandFromInput(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "command" in input && typeof (input as { command: unknown }).command === "string") {
    return (input as { command: string }).command;
  }
  return undefined;
}

function pathFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.path === "string") {
    return record.path;
  }
  if (typeof record.file_path === "string") {
    return record.file_path;
  }
  return undefined;
}
