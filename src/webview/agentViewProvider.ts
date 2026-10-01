import * as vscode from "vscode";
import { AgentWebviewHost } from "./agentWebviewHost";
import { ExtensionMessage } from "./types";

/**
 * Sidebar Agent view. All webview logic (message routing, runtime
 * events, session broadcasts, the GUI markup) lives in the shared
 * AgentWebviewHost so the sidebar and the editor-area Spider tab
 * behave identically; this provider only attaches the view's
 * webview to that host.
 */
export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  constructor(private readonly host: AgentWebviewHost) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.host.attach(webviewView.webview);
    webviewView.onDidDispose(() => this.host.detach(webviewView.webview));
  }

  /** Opens (or reveals) the History editor tab. */
  openHistory(): void {
    this.host.openHistory();
  }

  /** Pushes the current conversation list to every surface. */
  refreshSessions(): void {
    this.host.refreshSessions();
  }

  showSettings(): void {
    this.host.showSettings();
  }

  postMessage(message: ExtensionMessage): void {
    this.host.postMessage(message);
  }

  dispose(): void {
    this.host.dispose();
  }
}
