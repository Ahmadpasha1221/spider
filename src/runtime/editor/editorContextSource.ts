import * as path from "node:path";

/**
 * Where `get_active_file` / `get_selection` get their data.
 *
 * The tools depend on this interface, not on VS Code, so they are fully
 * testable outside the extension host (mirrors the `DiagnosticsSource`
 * pattern). `vscode` is imported lazily, so importing this module from tests or
 * from a non-VS Code host never fails.
 *
 * Privacy properties:
 * - the absolute path is never part of the model-facing shape: only a
 *   workspace-relative path, a bare file name, or a workspace folder name,
 * - selection *text* is raw here on purpose; redaction/truncation happen in the
 *   tool layer so there is exactly one place that decides what the model sees,
 * - this is context only. It never reads a whole file; `text` comes from the
 *   editor's selection ranges.
 */
export interface EditorSelectionSnapshot {
  /** Zero-based line, VS Code-native (matches Spider's ContextRange). */
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
  readonly text: string;
}

export interface ActiveEditorSnapshot {
  readonly languageId: string;
  readonly lineCount: number;
  readonly isDirty: boolean;
  readonly version: number;
  /** Untitled (never-saved) document: has no path on disk. */
  readonly untitled: boolean;
  /** Document lives outside every workspace folder (or uses a virtual scheme). */
  readonly outsideWorkspace: boolean;
  /** Workspace-relative POSIX path; absent for untitled/outside documents. */
  readonly relativePath?: string;
  /** File name without directories: the only identity for untitled/outside docs. */
  readonly name: string;
  /** Workspace folder the document belongs to (multi-root identity). */
  readonly workspaceFolder?: string;
  readonly workspaceFolders: readonly string[];
  /** Document-order selections. */
  readonly selections: readonly EditorSelectionSnapshot[];
}

export interface EditorContextSource {
  getActiveEditor(): Promise<ActiveEditorSnapshot | undefined>;
}

export function createVSCodeEditorContextSource(): EditorContextSource {
  return {
    async getActiveEditor() {
      const vscodeApi = await import("vscode");
      const editor = vscodeApi.window.activeTextEditor;
      if (!editor) {
        return undefined;
      }

      const document = editor.document;
      const uri = document.uri;
      const untitled = uri.scheme === "untitled";
      const workspaceFolders = (vscodeApi.workspace.workspaceFolders ?? []).map((folder) => folder.name);
      const folder = vscodeApi.workspace.getWorkspaceFolder(uri);

      let relativePath: string | undefined;
      let outsideWorkspace = false;
      if (!untitled) {
        if (uri.scheme !== "file" || !folder) {
          outsideWorkspace = true;
        } else {
          relativePath = toPosixRelative(folder.uri.fsPath, uri.fsPath);
        }
      }

      return {
        languageId: document.languageId,
        lineCount: document.lineCount,
        isDirty: document.isDirty,
        version: document.version,
        untitled,
        outsideWorkspace,
        ...(relativePath !== undefined ? { relativePath } : {}),
        name: fileIdentity(uri.fsPath, uri.path),
        ...(folder?.name ? { workspaceFolder: folder.name } : {}),
        workspaceFolders,
        selections: editor.selections.map((selection) => ({
          start: { line: selection.start.line, character: selection.start.character },
          end: { line: selection.end.line, character: selection.end.character },
          text: selection.isEmpty ? "" : document.getText(selection),
        })),
      };
    },
  };
}

function toPosixRelative(root: string, target: string): string {
  return path.relative(path.resolve(root), path.resolve(target)).replaceAll("\\", "/");
}

/**
 * File name only. `fsPath` is preferred but is not meaningful for every
 * scheme, so the URI path is used as a fallback. Directories are deliberately
 * dropped: a name is enough identity for the model and never leaks the machine
 * layout.
 */
function fileIdentity(fsPath: string, uriPath: string): string {
  const candidate = typeof fsPath === "string" && fsPath.length > 0 ? fsPath : uriPath;
  const normalized = candidate.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? normalized;
}
