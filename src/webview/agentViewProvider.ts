import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentManager } from "../agent/agentManager";
import { AgentEvent } from "../agent/agentEvents";
import type { CursorConnection } from "../auth/cursorConnection";
import { RuntimeManager } from "../runtime/runtimeManager";
import type { RuntimeEvent } from "../runtime/runtimeTypes";
import { MessageRouter } from "./messageRouter";
import { ExtensionMessage, isExtensionMessage, SessionListItem } from "./types";
import { EXTENSION_VERSION } from "../shared/constants";
import type { PermissionManager } from "../permissions/permissionManager";

export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private messageSubscription?: vscode.Disposable;
  private eventSubscription?: vscode.Disposable;
  private runtimeSubscription?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentManager: AgentManager,
    private readonly messageRouter: MessageRouter,
    private readonly connection?: CursorConnection,
    private readonly runtimeManager?: RuntimeManager,
    private readonly permissionManager?: PermissionManager,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.disposeSubscriptions();
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "gui")],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    this.messageSubscription = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      this.messageRouter.handleMessage(message).then(
        (result) => {
          if (isExtensionMessage(result) && shouldForwardResult(result.type)) {
            this.postMessage(result);
          }
          this.postSessionList();
        },
        (error) => {
          this.postMessage({ type: "AGENT_ERROR", error: String(error) });
        },
      );
    });

    this.eventSubscription = this.agentManager.onDidPublishEvent((event: AgentEvent) => {
      const extensionMessage = this.messageRouter.toExtensionMessage(event);
      if (extensionMessage) {
        this.postMessage(extensionMessage);
      }
      this.postSessionList();
    });

    this.runtimeSubscription = this.runtimeManager?.onDidPublishEvent((event: RuntimeEvent) => {
      const extensionMessage = this.messageRouter.toRuntimeExtensionMessage(event);
      if (extensionMessage) {
        this.postMessage(extensionMessage);
      }
      this.postSessionList();
    });

    this.postSessionList();
    this.postMessage(this.messageRouter.toAutoApproveStateMessage(
      this.permissionManager?.getRuntimeAutoApprove() ?? { enabled: false, scope: "conversation", updatedAt: 0 },
    ));
    this.postMessage({
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
    });
    void this.bootstrapAuth();
  }

  showSettings(): void {
    this.postMessage({ type: "SHOW_SETTINGS" });
  }

  showHistory(): void {
    this.postMessage({ type: "SHOW_HISTORY" });
  }

  postMessage(message: ExtensionMessage): void {
    const promise = this.view?.webview.postMessage(message);
    if (promise) {
      promise.then(() => { }, () => { });
    }
  }

  dispose(): void {
    this.disposeSubscriptions();
    this.view = undefined;
  }

  private async bootstrapAuth(): Promise<void> {
    if (!this.connection) {
      this.postMessage({ type: "AUTH_STATUS", status: "disconnected", hasKey: false });
      this.postMessage(this.messageRouter.runtimeStatus());
      return;
    }

    this.postMessage({ type: "AUTH_STATUS", status: "connecting", hasKey: false });
    const status = await this.connection.restore();
    this.postMessage(status);
    this.postMessage(this.messageRouter.runtimeStatus());
  }

  private postSessionList(): void {
    const source = this.messageRouter.usesManagedRuntime() && this.runtimeManager
      ? this.runtimeManager.listSessions()
      : this.agentManager.listSessions();
    const sessions: SessionListItem[] = source.map((session) => ({
      sessionId: session.sessionId,
      status: session.status,
      workspacePath: session.workspacePath,
      currentTask: session.currentTask,
      updatedAt: session.updatedAt instanceof Date ? session.updatedAt.getTime() : undefined,
    }));

    this.postMessage({
      type: "SESSION_UPDATED",
      sessions,
      activeSessionId: this.messageRouter.usesManagedRuntime()
        ? this.runtimeManager?.activeSession?.sessionId
        : this.agentManager.activeSession?.sessionId,
    });
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const guiRoot = path.join(this.extensionUri.fsPath, "dist", "gui");
    const htmlPath = path.join(guiRoot, "index.html");
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "gui", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "gui", "main.css"));

    let html = fs.readFileSync(htmlPath, "utf8");
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "gui", "spider-icon.png"));
    html = html
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{scriptUri}}", scriptUri.toString())
      .replaceAll("{{styleUri}}", styleUri.toString())
      .replaceAll("{{logoUri}}", logoUri.toString());
    return html;
  }

  private disposeSubscriptions(): void {
    this.messageSubscription?.dispose();
    this.eventSubscription?.dispose();
    this.runtimeSubscription?.dispose();
    this.messageSubscription = undefined;
    this.eventSubscription = undefined;
    this.runtimeSubscription = undefined;
  }
}

function shouldForwardResult(type: ExtensionMessage["type"]): boolean {
  return (
    type === "AUTH_STATUS"
    || type === "RUNTIME_STATUS"
    || type === "LOCAL_MODELS"
    || type === "OPENROUTER_MODELS"
    || type === "SHOW_HISTORY"
    || type === "TRANSCRIPT"
  );
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
