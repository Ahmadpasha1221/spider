import * as vscode from "vscode";
import { buildHunkLenses, revertHunk } from "./hunkReview";

/**
 * Shows "agent change vs. current disk" in VS Code's native diff editor using
 * virtual documents, so no temp files are needed. The left side is the snapshot
 * from before the agent touched the file; the right side is the file as it is
 * on disk right now (or the agent's content if the file was created).
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = "codevia-diff";

  private readonly contents = new Map<string, string>();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.registerTextDocumentContentProvider(DiffContentProvider.scheme, this);
  }

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
  }

  clear(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.disposable.dispose();
    this.contents.clear();
  }
}

/**
 * An open review for one file: the pre-change bytes plus a callback used by the
 * "Revert all changes" lens. "Accept" is implicit because the agent's edit is
 * already on disk; only rejection mutates the file.
 */
interface ReviewSession {
  readonly changeId: string;
  readonly beforeContent: string;
  readonly onRevertAll: () => Promise<void>;
  /** Hunk keys (start line + header) the user explicitly kept (A4). */
  readonly accepted: Set<string>;
}

/**
 * Renders the diff and, when a raw snapshot is available, attaches per-hunk
 * Accept/Reject lenses to the modified document (A4). Rejecting one hunk
 * rewrites only that hunk back to the pre-change content and leaves the rest
 * of the agent's edit in place; lens positions are recomputed from the live
 * document every time, so they stay correct while the user reviews.
 */
export class DiffViewService implements vscode.Disposable {
  private readonly provider = new DiffContentProvider();
  private counter = 0;
  private readonly sessions = new Map<string, ReviewSession>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    try {
      this.disposables.push(
        vscode.languages.registerCodeLensProvider(
          { scheme: "file" },
          {
            provideCodeLenses: (document) => this.provideCodeLenses(document),
            onDidChangeCodeLenses: this.lensesChanged.event,
          },
        ),
        vscode.commands.registerCommand("spider.review.keepHunk", (uri: vscode.Uri, index: number) =>
          this.keepHunk(uri, index),
        ),
        vscode.commands.registerCommand("spider.review.rejectHunk", (uri: vscode.Uri, index: number) =>
          this.rejectHunk(uri, index),
        ),
        vscode.commands.registerCommand("spider.review.keepAll", (uri: vscode.Uri) => this.endSession(uri)),
        vscode.commands.registerCommand("spider.review.revertAll", (uri: vscode.Uri) => this.revertAll(uri)),
      );
    } catch {
      // Command/language registration is unavailable in some hosts (tests):
      // the diff still opens, just without interactive lenses.
    }
  }

  async showDiff(options: {
    readonly title: string;
    readonly beforeContent?: string;
    readonly beforeExists: boolean;
    readonly afterPath: string;
    /** Enables the interactive per-hunk review when a snapshot is available. */
    readonly changeId?: string;
    readonly onRevertAll?: () => Promise<void>;
  }): Promise<void> {
    const beforeUri = this.virtualUri("before", options.beforeExists ? options.beforeContent ?? "" : "");
    const afterUri = vscode.Uri.file(options.afterPath);

    if (options.changeId && options.beforeContent !== undefined && options.onRevertAll) {
      this.sessions.set(afterUri.toString(), {
        changeId: options.changeId,
        beforeContent: options.beforeContent,
        onRevertAll: options.onRevertAll,
        accepted: new Set(),
      });
      this.lensesChanged.fire();
    } else {
      this.sessions.delete(afterUri.toString());
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      afterUri,
      options.title,
      { preview: true },
    );
  }

  async showContent(options: {
    readonly title: string;
    readonly content: string;
    readonly fileName: string;
  }): Promise<void> {
    const uri = this.virtualUri("content", options.content);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.sessions.get(document.uri.toString());
    if (!session) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, {
        title: "✓ Keep all changes",
        command: "spider.review.keepAll",
        arguments: [document.uri],
      }),
      new vscode.CodeLens(top, {
        title: "↩ Revert all changes",
        command: "spider.review.revertAll",
        arguments: [document.uri],
      }),
    );
    for (const hunk of buildHunkLenses(session.beforeContent, document.getText())) {
      if (session.accepted.has(hunkKey(hunk.startLine, hunk.header))) {
        continue;
      }
      const range = new vscode.Range(hunk.startLine - 1, 0, hunk.startLine - 1, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `✓ Keep hunk (${hunk.header})`,
          command: "spider.review.keepHunk",
          arguments: [document.uri, hunk.index],
        }),
        new vscode.CodeLens(range, {
          title: "↩ Reject hunk",
          command: "spider.review.rejectHunk",
          arguments: [document.uri, hunk.index],
        }),
      );
    }
    return lenses;
  }

  private keepHunk(uri: vscode.Uri, index: number): void {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      return;
    }
    const hunk = this.currentHunk(uri, index);
    if (hunk) {
      session.accepted.add(hunkKey(hunk.startLine, hunk.header));
      this.lensesChanged.fire();
    }
  }

  private async rejectHunk(uri: vscode.Uri, index: number): Promise<void> {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      return;
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }
    const current = document.getText();
    const updated = revertHunk(session.beforeContent, current, index);
    if (updated === current) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(current.length)), updated);
    await vscode.workspace.applyEdit(edit);
    // Rejecting shifts later hunk line numbers, so previously "kept" markers
    // no longer map to the same hunk; drop them and re-derive from the file.
    session.accepted.clear();
    this.lensesChanged.fire();
  }

  private async revertAll(uri: vscode.Uri): Promise<void> {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      return;
    }
    this.sessions.delete(uri.toString());
    this.lensesChanged.fire();
    await session.onRevertAll();
  }

  private endSession(uri: vscode.Uri): void {
    if (this.sessions.delete(uri.toString())) {
      this.lensesChanged.fire();
    }
  }

  private currentHunk(uri: vscode.Uri, index: number): { startLine: number; header: string } | undefined {
    const session = this.sessions.get(uri.toString());
    if (!session) {
      return undefined;
    }
    const doc = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    if (!doc) {
      return undefined;
    }
    const hunk = buildHunkLenses(session.beforeContent, doc.getText()).find((candidate) => candidate.index === index);
    return hunk ? { startLine: hunk.startLine, header: hunk.header } : undefined;
  }

  private virtualUri(kind: "before" | "content", content: string): vscode.Uri {
    this.counter += 1;
    const uri = vscode.Uri.parse(`${DiffContentProvider.scheme}:/${kind}-${this.counter}.txt`);
    this.provider.setContent(uri, content);
    return uri;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.sessions.clear();
    this.lensesChanged.dispose();
    this.provider.dispose();
  }
}

function hunkKey(startLine: number, header: string): string {
  return `${startLine}:${header}`;
}

export function diffTitle(toolName: string, relativePath: string, status: string): string {
  const badge = status === "REVERTED" ? "reverted" : status === "MISSING" ? "missing" : "applied";
  return `${toolName}: ${relativePath} (${badge}) — Original ⇄ Current`;
}
