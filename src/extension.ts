import * as vscode from "vscode";
import { COMMANDS, EXTENSION_NAME, OPENROUTER_API_KEY_SECRET_KEY } from "./shared/constants";
import { Logger } from "./utils/logger";
import { CursorAuthProvider } from "./auth/cursorAuthProvider";
import { VSCodeSecretStorageAdapter } from "./auth/secretStorage";
import { CursorClient } from "./auth/cursorClient";
import { CursorConnectionService } from "./auth/cursorConnection";
import { AgentManager } from "./agent/agentManager";
import { SessionStore } from "./session/sessionStore";
import { ProviderConfigStore } from "./session/providerConfigStore";
import { TranscriptStore } from "./session/transcriptStore";
import { MessageRouter } from "./webview/messageRouter";
import { AgentViewProvider } from "./webview/agentViewProvider";
import { PermissionManager } from "./permissions/permissionManager";
import { createDefaultPermissionPolicy } from "./permissions/permissionPolicy";
import { RuntimeManager } from "./runtime/runtimeManager";
import { MockRuntime } from "./runtime/mock/mockRuntime";
import { OllamaRuntime } from "./runtime/ollama/ollamaRuntime";
import { OpenAICompatibleRuntime } from "./runtime/openaiCompatible/openaiCompatibleRuntime";
import { OpenRouterRuntime } from "./runtime/openrouter/openRouterRuntime";
import { WorkspaceToolExecutor } from "./runtime/tools/workspaceToolExecutor";
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
      "codeviaCursor",
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
        const raw = context.workspaceState.get<unknown>("codeviaCursor.permissionRules");
        return Array.isArray(raw) ? (raw as ReadonlyArray<{ category: string; rule: string }>) : [];
      },
      save: (snapshot) => {
        void context.workspaceState.update(
          "codeviaCursor.permissionRules",
          Object.entries(snapshot.rules).map(([category, rule]) => ({ category, rule })),
        );
      },
    },
  );

  const sessionStore = new SessionStore(context.workspaceState);
  const providerConfigStore = new ProviderConfigStore(context.workspaceState);
  const transcriptStore = new TranscriptStore(context.globalStorageUri);
  const agentManager = new AgentManager(cursorClient, sessionStore, permissionManager, transcriptStore);
  const diffView = new DiffViewService();
  const runtimeManager = new RuntimeManager({
    sessionStore,
    permissionManager,
    runtimes: [new OllamaRuntime(), new OpenAICompatibleRuntime(), new OpenRouterRuntime(), new MockRuntime()],
    logger,
    toolExecutor: new WorkspaceToolExecutor(),
    defaultWorkspacePath: getWorkspacePath(),
    transcriptStore,
    diffView,
    providerConfigStore,
  });
  const messageRouter = new MessageRouter(
    agentManager,
    getWorkspacePath(),
    connection,
    cursorClient,
    runtimeManager,
    secretStorage,
    { permissionManager },
  );
  const agentViewProvider = new AgentViewProvider(
    context.extensionUri,
    agentManager,
    messageRouter,
    connection,
    runtimeManager,
    permissionManager,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codeviaCursor.agent", agentViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
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

  await agentManager.restoreSessions();
  await runtimeManager.restoreSessions();

  // Restore the previously saved provider/model so the user is not asked to
  // configure the provider again. Secrets are never persisted: the OpenRouter
  // key is re-attached from VS Code SecretStorage when present.
  const savedProviderConfig = await runtimeManager.restoreProviderConfig();
  if (savedProviderConfig?.provider === "openrouter") {
    const apiKey = await secretStorage.get(OPENROUTER_API_KEY_SECRET_KEY);
    if (apiKey) {
      await runtimeManager.setProvider({
        provider: "openrouter",
        apiKey,
        ...(savedProviderConfig.modelId ? { modelId: savedProviderConfig.modelId } : {}),
      });
      if (runtimeManager.listSessions().length === 0) {
        runtimeManager.createSession(getWorkspacePath());
      }
    } else {
      logger.info("Saved OpenRouter provider found without a stored API key", { operation: "activate" });
    }
  }

  const openAgentCommand = vscode.commands.registerCommand(COMMANDS.openAgent, async () => {
    logger.info("Open agent command invoked", { operation: "openAgent" });
    await vscode.commands.executeCommand("workbench.view.extension.codeviaCursor.agent");
  });

  const openSettingsCommand = vscode.commands.registerCommand(COMMANDS.openSettings, async () => {
    logger.info("Open settings command invoked", { operation: "openSettings" });
    await vscode.commands.executeCommand("workbench.view.extension.codeviaCursor.agent");
    agentViewProvider.showSettings();
  });

  context.subscriptions.push(openAgentCommand, openSettingsCommand);

  logger.info("Extension activated", { operation: "activate" });
}

export function deactivate(): void {
  logger.info("Extension deactivating", { operation: "deactivate" });
}
