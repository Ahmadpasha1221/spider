import * as vscode from "vscode";
import type { AgentWebviewHost } from "./agentWebviewHost";

/**
 * The Spider agent as an editor-area tab (the Codex / Cline /
 * Kilo style editor view). It hosts the same GUI as the sidebar
 * through the shared AgentWebviewHost, so the tab and the sidebar
 * always show the same conversation and can be used side by side.
 */
export class AgentEditorPanel implements vscode.Disposable {
  private static current?: AgentEditorPanel;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel) {}

  /** Opens the Spider editor tab (or reveals it when already open). */
  static createOrShow(extensionUri: vscode.Uri, host: AgentWebviewHost): AgentEditorPanel {
    if (AgentEditorPanel.current) {
      AgentEditorPanel.current.panel.reveal(vscode.ViewColumn.One);
      return AgentEditorPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "spider.agentEditor",
      "Spider Agent",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "gui")],
        retainContextWhenHidden: true,
      },
    );
    // Spider mark in the tab header.
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "assets", "spider-icon.png");

    const instance = new AgentEditorPanel(panel);
    instance.disposables.push(
      panel.onDidDispose(() => {
        host.detach(panel.webview);
        AgentEditorPanel.current = undefined;
      }),
    );
    host.attach(panel.webview);
    AgentEditorPanel.current = instance;
    return instance;
  }

  /** Reveals the open tab; false when no editor tab is open. */
  static reveal(): boolean {
    if (!AgentEditorPanel.current) {
      return false;
    }
    AgentEditorPanel.current.panel.reveal(vscode.ViewColumn.One);
    return true;
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.panel.dispose();
  }
}
