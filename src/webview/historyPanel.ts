import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "../shared/constants";
import type { TranscriptEntry } from "../session/transcriptStore";
import type { ExtensionMessage, SessionListItem } from "./types";

/**
 * Everything the History panel needs from the sidebar host. Keeping this an
 * interface (rather than reaching into AgentViewProvider) means the panel is
 * testable and the sidebar owns exactly two responsibilities: report the
 * conversation list and switch the active conversation.
 */
export interface HistoryPanelHost {
  listSessions(): { sessions: SessionListItem[]; activeSessionId?: string };
  /** Switches the sidebar to this conversation and reveals the Agent view. */
  selectSession(sessionId: string): Promise<void>;
  /** Permanently removes the conversation and its persisted transcript. */
  deleteSession(sessionId: string): Promise<void>;
  /** Read-only transcript for the preview pane. */
  getTranscript(sessionId: string): Promise<readonly TranscriptEntry[]>;
}

/**
 * Conversation History as a real editor tab (a `WebviewPanel`), not a sidebar
 * dropdown: VS Code keeps it open beside the editor, survives sidebar switches,
 * and the user can move it to any column. Selecting a conversation delegates to
 * the sidebar host, which focuses the Agent view and loads the transcript there
 * — history itself stays read-only.
 */
export class HistoryPanel implements vscode.Disposable {
  private static current?: HistoryPanel;

  static createOrShow(extensionUri: vscode.Uri, host: HistoryPanelHost): HistoryPanel {
    if (HistoryPanel.current) {
      HistoryPanel.current.panel.reveal();
      HistoryPanel.current.postSessions();
      return HistoryPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "spider.history",
      `${EXTENSION_NAME}: History`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "gui")],
      },
    );
    HistoryPanel.current = new HistoryPanel(panel, extensionUri, host);
    return HistoryPanel.current;
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly host: HistoryPanelHost,
  ) {
    this.panel.webview.html = this.render(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    this.postSessions();
  }

  dispose(): void {
    if (HistoryPanel.current === this) {
      HistoryPanel.current = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  /** Re-broadcasts the conversation list (kept live as sessions change). */
  postSessions(): void {
    const { sessions, activeSessionId } = this.host.listSessions();
    void this.panel.webview.postMessage({
      type: "SESSION_UPDATED",
      sessions,
      activeSessionId,
    } satisfies ExtensionMessage);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "LIST_SESSIONS":
        this.postSessions();
        return;
      case "SELECT_SESSION": {
        if (!isSessionId(message.sessionId)) {
          return;
        }
        await this.host.selectSession(message.sessionId);
        this.postSessions();
        return;
      }
      case "DELETE_SESSION": {
        if (!isSessionId(message.sessionId)) {
          return;
        }
        await this.host.deleteSession(message.sessionId);
        this.postSessions();
        return;
      }
      case "GET_TRANSCRIPT": {
        if (!isSessionId(message.sessionId)) {
          return;
        }
        const entries = await this.host.getTranscript(message.sessionId);
        void this.panel.webview.postMessage({
          type: "TRANSCRIPT",
          sessionId: message.sessionId,
          // The host returns a readonly view; the wire message is a plain array.
          entries: [...entries],
        } satisfies ExtensionMessage);
        return;
      }
      default:
        return;
    }
  }

  private render(webview: vscode.Webview): string {
    const guiRoot = path.join(this.extensionUri.fsPath, "dist", "gui");
    const htmlPath = path.join(guiRoot, "history.html");
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "gui", "history.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "gui", "main.css"),
    );

    return fs
      .readFileSync(htmlPath, "utf8")
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{scriptUri}}", scriptUri.toString())
      .replaceAll("{{styleUri}}", styleUri.toString());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
