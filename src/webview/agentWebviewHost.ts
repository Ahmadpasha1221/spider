import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentManager } from "../agent/agentManager";
import { AgentEvent } from "../agent/agentEvents";
import type { CursorConnection } from "../auth/cursorConnection";
import { RuntimeManager } from "../runtime/runtimeManager";
import type { RuntimeEvent } from "../runtime/runtimeTypes";
import { MessageRouter } from "./messageRouter";
import { HistoryPanel } from "./historyPanel";
import { AgentEditorPanel } from "./agentEditorPanel";
import { ExtensionMessage, isExtensionMessage, SessionListItem } from "./types";
import { shouldForwardResult } from "./resultForwarding";
import { EXTENSION_NAME, EXTENSION_VERSION } from "../shared/constants";
import { Logger } from "../utils/logger";
import type { PermissionManager } from "../permissions/permissionManager";
import type { TranscriptEntry } from "../session/transcriptStore";

/**
 * Bridges the agent runtime to every Spider webview surface (the
 * sidebar Agent view and the editor-area Spider tab). Surfaces
 * attach their webview; messages, runtime events and session
 * updates broadcast to all of them, so sidebar and editor always
 * show the same conversation and can be used side by side.
 */
export class AgentWebviewHost implements vscode.Disposable {
  private static readonly logger = new Logger(EXTENSION_NAME, "INFO");
  /** Attached webviews (sidebar view, editor tab) and their subscriptions. */
  private readonly attached = new Map<vscode.Webview, vscode.Disposable[]>();
  private eventSubscription?: vscode.Disposable;
  private runtimeSubscription?: vscode.Disposable;
  private bootstrapped = false;
  private pendingShowSettings = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agentManager: AgentManager,
    private readonly messageRouter: MessageRouter,
    private readonly connection?: CursorConnection,
    private readonly runtimeManager?: RuntimeManager,
    private readonly permissionManager?: PermissionManager,
  ) {
    // Runtime events broadcast to every attached surface.
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
  }

  /** Attaches a webview surface (sidebar view or editor tab). */
  attach(webview: vscode.Webview): void {
    if (this.attached.has(webview)) {
      return;
    }
    AgentWebviewHost.logger.info("Agent webview resolved", { operation: "attach" });

    // openSettings can run before any surface exists. The flag is
    // carried in the HTML (not a postMessage) so a freshly created
    // webview reliably opens in Settings even before its script loads.
    const showSettings = this.pendingShowSettings;
    this.pendingShowSettings = false;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "gui")],
    };

    webview.html = this.getWebviewContent(webview, showSettings);

    const subscriptions: vscode.Disposable[] = [
      webview.onDidReceiveMessage((message: unknown) => {
        if (isOpenHistoryMessage(message)) {
          this.openHistory();
          return;
        }
        if (isOpenAgentEditorMessage(message)) {
          // Clicking the Spider logo (sidebar or editor tab):
          // open or focus the editor-area Spider tab.
          AgentEditorPanel.createOrShow(this.extensionUri, this);
          return;
        }
        if (isOpenUrlMessage(message)) {
          // Markdown link click: only http(s) leaves the
          // extension; everything else is ignored. The webview
          // itself never navigates.
          this.openExternalUrl(message.url);
          return;
        }
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
      }),
    ];
    this.attached.set(webview, subscriptions);

    if (!this.bootstrapped) {
      this.bootstrapped = true;
      void this.bootstrapAuth();
    }
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
  }

  /** Detaches a disposed surface. */
  detach(webview: vscode.Webview): void {
    const subscriptions = this.attached.get(webview);
    if (!subscriptions) {
      return;
    }
    subscriptions.forEach((subscription) => subscription.dispose());
    this.attached.delete(webview);
    // A disposed webview can never answer a pending `ask_user`
    // question; with several surfaces, only cancel once the last
    // one is gone (another surface may still answer).
    if (this.attached.size === 0) {
      this.runtimeManager?.cancelPendingUserQuestions();
    }
  }

  /** Opens (or reveals) the History editor tab. */
  openHistory(): void {    HistoryPanel.createOrShow(this.extensionUri, {
      listSessions: () => ({
        sessions: this.collectSessions(),
        activeSessionId: this.activeSessionId(),
      }),
      selectSession: async (sessionId) => {
        await this.messageRouter.handleMessage({ type: "SELECT_SESSION", sessionId });
        // Reveal the Spider editor tab when it is open; otherwise
        // focus the sidebar container. The GUI loads the new
        // transcript as soon as it sees a different activeSessionId.
        if (!AgentEditorPanel.reveal()) {
          await vscode.commands.executeCommand("workbench.view.extension.spider");
        }
        this.refreshSessions();
      },
      deleteSession: async (sessionId) => {
        await this.messageRouter.handleMessage({ type: "DELETE_SESSION", sessionId });
        this.refreshSessions();
      },
      getTranscript: async (sessionId) => {
        const result = await this.messageRouter.handleMessage({ type: "GET_TRANSCRIPT", sessionId });
        return isTranscriptMessage(result) ? result.entries : [];
      },
    });
  }

  /** Opens an http(s) URL in the user's default browser. */
  openExternalUrl(url: string): void {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      // Only plain web links leave the extension. `javascript:`,
      // `data:`, `vscode-file://` etc. never reach the OS browser.
      return;
    }
    void vscode.env.openExternal(vscode.Uri.parse(trimmed)).then(
      () => undefined,
      (error: unknown) => {
        AgentWebviewHost.logger.warn("Failed to open external URL", {
          operation: "openExternalUrl",
          outcome: `error: ${String(error)}`,
        });
      },
    );
  }

  /** Pushes the current conversation list to every surface. */
  refreshSessions(): void {
    this.postSessionList();
  }

  showSettings(): void {
    if (this.attached.size > 0) {
      this.postMessage({ type: "SHOW_SETTINGS" });
    } else {
      // No surface resolved yet; remember it until attach() runs.
      this.pendingShowSettings = true;
    }
  }

  postMessage(message: ExtensionMessage): void {
    for (const webview of this.attached.keys()) {
      const promise = webview.postMessage(message);
      if (promise) {
        promise.then(() => { }, () => { });
      }
    }
  }

  dispose(): void {
    this.eventSubscription?.dispose();
    this.runtimeSubscription?.dispose();
    for (const webview of [...this.attached.keys()]) {
      this.detach(webview);
    }
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
    this.postMessage({
      type: "SESSION_UPDATED",
      sessions: this.collectSessions(),
      activeSessionId: this.activeSessionId(),
    });
  }

  /** Single source of truth for the conversation list (all surfaces). */
  private collectSessions(): SessionListItem[] {
    const source = this.messageRouter.usesManagedRuntime() && this.runtimeManager
      ? this.runtimeManager.listSessions()
      : this.agentManager.listSessions();
    return source.map((session) => ({
      sessionId: session.sessionId,
      status: session.status,
      workspacePath: session.workspacePath,
      currentTask: session.currentTask,
      updatedAt: session.updatedAt instanceof Date ? session.updatedAt.getTime() : undefined,
    }));
  }

  private activeSessionId(): string | undefined {
    return this.messageRouter.usesManagedRuntime()
      ? this.runtimeManager?.activeSession?.sessionId
      : this.agentManager.activeSession?.sessionId;
  }

  private getWebviewContent(webview: vscode.Webview, showSettings: boolean): string {
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
      .replaceAll("{{logoUri}}", logoUri.toString())
      .replaceAll("{{showSettings}}", showSettings ? "1" : "0");
    return html;
  }
}

function isTranscriptMessage(
  value: unknown,
): value is { type: "TRANSCRIPT"; entries: readonly TranscriptEntry[] } {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "TRANSCRIPT"
    && Array.isArray((value as { entries?: unknown }).entries)
  );
}

function isOpenHistoryMessage(value: unknown): value is { type: "OPEN_HISTORY" } {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "OPEN_HISTORY"
  );
}

function isOpenAgentEditorMessage(value: unknown): value is { type: "OPEN_AGENT_EDITOR" } {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "OPEN_AGENT_EDITOR"
  );
}

function isOpenUrlMessage(value: unknown): value is { type: "OPEN_URL"; url: string } {
  return (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "OPEN_URL"
    && typeof (value as { url?: unknown }).url === "string"
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
