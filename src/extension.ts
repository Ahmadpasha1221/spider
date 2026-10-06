import * as vscode from "vscode";
import { CHAT_PERMISSION_COMMANDS, COMMANDS, EXTENSION_NAME } from "./shared/constants";
import { SECRET_KEYS, STORAGE_KEYS, readState } from "./shared/storageKeys";
import { registerSpiderChatParticipant } from "./chat/chatParticipant";
import { Logger } from "./utils/logger";
import { CursorAuthProvider } from "./auth/cursorAuthProvider";
import { VSCodeSecretStorageAdapter } from "./auth/secretStorage";
import { createProviderCredentialStore } from "./auth/providerCredentials";
import { CursorClient } from "./auth/cursorClient";
import { CursorConnectionService } from "./auth/cursorConnection";
import { AgentManager } from "./agent/agentManager";
import { SessionStore } from "./session/sessionStore";
import { ProviderConfigStore, profileIdFor } from "./session/providerConfigStore";
import { TranscriptStore } from "./session/transcriptStore";
import { MessageRouter } from "./webview/messageRouter";
import { AgentWebviewHost } from "./webview/agentWebviewHost";
import { AgentViewProvider } from "./webview/agentViewProvider";
import { AgentEditorPanel } from "./webview/agentEditorPanel";
import { PermissionManager } from "./permissions/permissionManager";
import { createDefaultPermissionPolicy } from "./permissions/permissionPolicy";
import { RuntimeManager } from "./runtime/runtimeManager";
import { MockRuntime } from "./runtime/mock/mockRuntime";
import { OllamaRuntime } from "./runtime/ollama/ollamaRuntime";
import { OpenAICompatibleRuntime } from "./runtime/openaiCompatible/openaiCompatibleRuntime";
import { OpenRouterRuntime } from "./runtime/openrouter/openRouterRuntime";
import { WorkspaceToolExecutor } from "./runtime/tools/workspaceToolExecutor";
import { ExecutionManager } from "./runtime/execution/executionManager";
import { WorkspaceRulesService } from "./agent/workspaceRulesService";
import type { ExecutionEnvironment, ExecutionShell } from "./runtime/execution/executionTypes";
import { createVSCodeDiagnosticsSource } from "./runtime/diagnostics/diagnosticsSource";
import { createVSCodeEditorContextSource } from "./runtime/editor/editorContextSource";
import { createVSCodeLanguageSource } from "./runtime/lsp/languageSource";
import { BackgroundProcessManager } from "./runtime/tools/backgroundProcessManager";
import { createStoredWebSearchProvider } from "./runtime/net/webSearchProvider";
import { DiffViewService } from "./runtime/review/diffView";

const logger = new Logger(EXTENSION_NAME, "INFO");

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.info("Extension activating", { operation: "activate" });

  const secretStorage = new VSCodeSecretStorageAdapter(context.secrets);
  const cursorClient = new CursorClient(undefined);
  const authProvider = new CursorAuthProvider(secretStorage);
  const getWorkspacePath = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ".";
  const connection = new CursorConnectionService(secretStorage, cursorClient, getWorkspacePath);

  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      "spider",
      "Spider",
      authProvider,
      { supportsMultipleAccounts: false },
    ),
  );

  const permissionManager = new PermissionManager(
    createDefaultPermissionPolicy({
      isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    }),
    {
      load: () => {
        const raw = readState<unknown>(context.workspaceState, STORAGE_KEYS.permissionRules);
        return Array.isArray(raw) ? (raw as ReadonlyArray<{ category: string; rule: string }>) : [];
      },
      save: (snapshot) => {
        void context.workspaceState.update(
          STORAGE_KEYS.permissionRules.current,
          Object.entries(snapshot.rules).map(([category, rule]) => ({ category, rule })),
        );
      },
    },
  );

  // Provider profiles hold non-secret configuration; the matching credential
  // for each profile lives in SecretStorage under a key derived from its id.
  // The legacy single OpenRouter key is the migration source for the default
  // OpenRouter profile.
  const providerCredentials = createProviderCredentialStore(secretStorage, {
    legacySecretKeys: { [profileIdFor("openrouter")]: SECRET_KEYS.openRouterApiKey.legacy },
  });

  const sessionStore = new SessionStore(context.workspaceState);
  const providerConfigStore = new ProviderConfigStore(context.workspaceState);
  const transcriptStore = new TranscriptStore(context.globalStorageUri);
  const agentManager = new AgentManager(cursorClient, sessionStore, permissionManager, transcriptStore);
  const diffView = new DiffViewService();
  // One background-process manager owns every background_command process: the
  // executor starts them, RuntimeManager disposes them on deactivate.
  const backgroundProcesses = new BackgroundProcessManager();
  // search_web resolves its provider credential from SecretStorage lazily, so
  // no key is read (or held) until the tool is actually used.
  const webSearch = createStoredWebSearchProvider({
    secretStorage,
    secretKey: SECRET_KEYS.webSearchApiKey.current,
    legacySecretKey: SECRET_KEYS.webSearchApiKey.legacy,
  });
  // Authoritative command-execution environment. Captured from VS Code (never
  // from shell probing) so run_command runs in the same environment as the
  // workspace's integrated terminal, including WSL and remote workspaces.
  const createExecutionEnvironment = (): ExecutionEnvironment => {
    const config = vscode.workspace.getConfiguration("spider");
    const configuredShell = executionShellOverride(config.get<string>("execution.shell"));
    const configuredWslDistro = nonEmpty(config.get<string>("execution.wslDistro"));
    return {
      hostPlatform: process.platform,
      ...(vscode.env.remoteName ? { remoteName: vscode.env.remoteName } : {}),
      terminalShellPath: vscode.env.shell,
      env: process.env,
      ...(configuredShell ? { configuredShell } : {}),
      ...(configuredWslDistro ? { configuredWslDistro } : {}),
    };
  };
  const executionManager = new ExecutionManager({
    environment: createExecutionEnvironment(),
    logger: { info: (message, logContext) => logger.info(message, logContext ?? {}) },
  });
  // Workspace rules (.spiderrules): watched for live reload and
  // injected into the agent system prompt by the runtime.
  const workspaceRulesService = new WorkspaceRulesService();
  context.subscriptions.push(workspaceRulesService);
  const toolExecutor = new WorkspaceToolExecutor({
    diagnostics: createVSCodeDiagnosticsSource(),
    editor: createVSCodeEditorContextSource(),
    language: createVSCodeLanguageSource(),
    backgroundProcesses,
    webSearch,
    executionManager,
  });
  const runtimeManager = new RuntimeManager({
    sessionStore,
    permissionManager,
    runtimes: [new OllamaRuntime(), new OpenAICompatibleRuntime(), new OpenRouterRuntime(), new MockRuntime()],
    logger,
    toolExecutor,
    backgroundProcesses,
    defaultWorkspacePath: getWorkspacePath(),
    transcriptStore,
    diffView,
    providerConfigStore,
    executionManager,
    rulesLoader: (workspacePath) => workspaceRulesService.getRulesContext(workspacePath),
  });
  // The runtime orchestrates subagents (it owns runtimes, tool routing and
  // permissions); the executor was built first, so inject it after construction.
  toolExecutor.setSubagentRunner(runtimeManager);

  // The execution context is cached per workspace; drop it when the workspace
  // folders or the terminal shell configuration change so no stale environment
  // is ever reused.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => executionManager.invalidate()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("terminal.integrated") || event.affectsConfiguration("spider.execution")) {
        executionManager.updateEnvironment(createExecutionEnvironment());
      }
    }),
  );
  const messageRouter = new MessageRouter(
    agentManager,
    getWorkspacePath(),
    connection,
    cursorClient,
    runtimeManager,
    secretStorage,
    { permissionManager },
  );
  // One host bridges the runtime to every Spider surface: the
  // sidebar Agent view and the editor-area Spider tab.
  const agentWebviewHost = new AgentWebviewHost(
    context.extensionUri,
    agentManager,
    messageRouter,
    connection,
    runtimeManager,
    permissionManager,
  );
  const agentViewProvider = new AgentViewProvider(agentWebviewHost);

  // --- Register everything VS Code can invoke BEFORE any async work. If a
  // provider fails to initialize later, commands and the Agent view must
  // still exist (a failed activation is what surfaced as
  // "command 'spider.openAgent' not found" in packaged installs).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("spider.agent", agentViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Spider's primary surface is an editor-area tab (the Codex /
  // Cline / Kilo style editor view). The sidebar stays available
  // from the activity bar; both show the same conversation.
  const openAgentCommand = vscode.commands.registerCommand(COMMANDS.openAgent, async () => {
    logger.info("Open agent command invoked", { operation: "openAgent" });
    AgentEditorPanel.createOrShow(context.extensionUri, agentWebviewHost);
  });

  // Explicit editor-tab command (palette + clickable Spider logo).
  const openAgentEditorCommand = vscode.commands.registerCommand(COMMANDS.openAgentEditor, async () => {
    logger.info("Open agent editor command invoked", { operation: "openAgentEditor" });
    AgentEditorPanel.createOrShow(context.extensionUri, agentWebviewHost);
  });

  const openSettingsCommand = vscode.commands.registerCommand(COMMANDS.openSettings, async () => {
    logger.info("Open settings command invoked", { operation: "openSettings" });
    AgentEditorPanel.createOrShow(context.extensionUri, agentWebviewHost);
    agentWebviewHost.showSettings();
  });

  const openHistoryCommand = vscode.commands.registerCommand(COMMANDS.openHistory, async () => {
    logger.info("Open history command invoked", { operation: "openHistory" });
    agentWebviewHost.openHistory();
  });

  context.subscriptions.push(
    openAgentCommand,
    openAgentEditorCommand,
    openSettingsCommand,
    openHistoryCommand,
  );

  // Clickable Spider logo: one click opens the Spider editor tab.
  const spiderStatusItem = vscode.window.createStatusBarItem(
    "spider.agent",
    vscode.StatusBarAlignment.Left,
    50,
  );
  spiderStatusItem.name = "Spider Agent";
  spiderStatusItem.text = "🕷️ Spider";
  spiderStatusItem.tooltip = "Open the Spider agent in an editor tab";
  spiderStatusItem.command = COMMANDS.openAgentEditor;
  spiderStatusItem.show();
  context.subscriptions.push(spiderStatusItem);

  // VS Code Chat (@spider): same RuntimeManager as the sidebar, dedicated
  // session per chat lifetime. Registered at activation so
  // onChatParticipant:spider.spider can resolve it.
  context.subscriptions.push(
    registerSpiderChatParticipant({
      extensionUri: context.extensionUri,
      runtimeManager,
      permissionManager,
      defaultWorkspacePath: getWorkspacePath(),
    }),
  );

  // Allow/Deny buttons the chat participant renders for destructive tools.
  const resolveChatPermission = (decision: "ALLOW" | "DENY") => (requestId: unknown) => {
    if (typeof requestId !== "string" || requestId.length === 0) {
      return;
    }
    permissionManager.resolveDecision({
      requestId,
      decision,
      confirmation: decision === "ALLOW",
    });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(CHAT_PERMISSION_COMMANDS.allow, resolveChatPermission("ALLOW")),
    vscode.commands.registerCommand(CHAT_PERMISSION_COMMANDS.deny, resolveChatPermission("DENY")),
  );

  // Shield toggles flow through the same event bridge as runtime events so
  // every webview re-syncs to the authoritative backend state.
  context.subscriptions.push(
    permissionManager.onDidRequest((event) => {
      if (event.type === "runtime_auto_approve_changed") {
        agentViewProvider.postMessage(messageRouter.toAutoApproveStateMessage(event.state));
      }
    }),
  );

  context.subscriptions.push(permissionManager, agentManager, runtimeManager, diffView, agentViewProvider);

  // --- Optional heavyweight restoration runs after registration and must
  // never break activation: a provider that cannot initialize only degrades
  // that provider — the UI and all commands stay available.
  try {
    await agentManager.restoreSessions();
    await runtimeManager.restoreSessions();

    // Hydrate the previously selected provider profile so the user is not asked
    // to configure the provider again. Non-secret configuration is restored from
    // the profile store; the credential is resolved from SecretStorage by profile
    // id — the host owns credentials, the webview only ever sees sanitized state.
    const restoredProvider = await runtimeManager.restoreProviderConfig();
    if (restoredProvider && !restoredProvider.applied) {
      const { config } = restoredProvider;
      const credential = await providerCredentials.get(config.profileId ?? profileIdFor(config.provider));
      if (credential) {
        await runtimeManager.completeRestore(config, credential);
        if (runtimeManager.listSessions().length === 0) {
          runtimeManager.createSession(getWorkspacePath());
        }
      } else {
        logger.info("Saved provider profile has no stored credential; skipping restore", { operation: "activate" });
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Optional startup restoration failed; Spider UI remains available: ${detail}`, {
      operation: "activate",
    });
  }

  logger.info("Extension activated", { operation: "activate" });
}

function executionShellOverride(value: string | undefined): ExecutionShell | undefined {
  switch (value) {
    case "powershell":
    case "cmd":
    case "bash":
    case "zsh":
    case "sh":
      return value;
    default:
      return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function deactivate(): void {
  logger.info("Extension deactivating", { operation: "deactivate" });
}
