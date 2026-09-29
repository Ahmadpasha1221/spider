import {
  DEFAULT_MAX_SELECTED_TEXT_LENGTH,
  isSensitiveFilePath,
  redactSensitiveText,
} from "../../context/contextTypes";
import type { EditorContextSource } from "../editor/editorContextSource";
import { ToolExecutionError } from "./toolError";

/**
 * `get_active_file` / `get_selection`: read-only VS Code context.
 *
 * Responsibility split (deliberate):
 * - `get_active_file` answers "what is the developer working on?" — identity,
 *   language, size, dirty state. It never returns file contents,
 * - `get_selection` answers "what did the developer select?" — ranges plus the
 *   selected text only, never the surrounding file,
 * - `read_file` / `read_multiple_files` remain the only tools that return file
 *   content.
 *
 * Security: selection text is redacted and capped, sensitive file names yield
 * no text at all, and nothing here is ever logged or persisted by Spider (tool
 * results are not part of the transcript).
 */
export const MAX_SELECTION_CHARS = DEFAULT_MAX_SELECTED_TEXT_LENGTH;
export const MAX_SELECTION_CHARS_LIMIT = 20_000;

export interface ActiveFileView {
  /** Workspace-relative POSIX path; absent for untitled/outside documents. */
  readonly path?: string;
  readonly name: string;
  readonly languageId: string;
  readonly lineCount: number;
  readonly isDirty: boolean;
  readonly version: number;
  readonly untitled?: true;
  readonly outsideWorkspace?: true;
  readonly workspaceFolder?: string;
}

export interface GetActiveFileResult {
  readonly file: ActiveFileView | null;
  readonly workspaceFolders?: readonly string[];
  readonly message?: string;
}

export interface SelectionView {
  readonly path?: string;
  readonly name: string;
  readonly untitled?: true;
  readonly outsideWorkspace?: true;
  /** Zero-based, VS Code-native; "column" mirrors the documented tool schema. */
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
  readonly text: string;
  readonly truncated?: true;
  /** The file looks like a secret-bearing file, so no text is returned. */
  readonly redacted?: true;
}

export interface GetSelectionResult {
  readonly selection?: SelectionView | null;
  readonly selections?: readonly SelectionView[];
  readonly truncated?: true;
  readonly message?: string;
}

export interface EditorToolDeps {
  readonly editor?: EditorContextSource;
}

export async function getActiveFile(
  input: Record<string, unknown>,
  deps: EditorToolDeps,
): Promise<GetActiveFileResult> {
  const source = requireEditor(deps);
  const snapshot = await source.getActiveEditor();
  if (!snapshot) {
    return { file: null, message: "No active editor is open." };
  }

  const file: ActiveFileView = {
    ...(snapshot.relativePath ? { path: snapshot.relativePath } : {}),
    name: snapshot.name,
    languageId: snapshot.languageId,
    lineCount: snapshot.lineCount,
    isDirty: snapshot.isDirty,
    version: snapshot.version,
    ...(snapshot.untitled ? { untitled: true as const } : {}),
    ...(snapshot.outsideWorkspace ? { outsideWorkspace: true as const } : {}),
    ...(snapshot.workspaceFolder ? { workspaceFolder: snapshot.workspaceFolder } : {}),
  };

  return {
    file,
    ...(input.includeWorkspaceFolders === true ? { workspaceFolders: snapshot.workspaceFolders } : {}),
  };
}

export async function getSelection(
  input: Record<string, unknown>,
  deps: EditorToolDeps,
): Promise<GetSelectionResult> {
  const source = requireEditor(deps);
  const maxChars = parseMaxChars(input.maxChars);
  const snapshot = await source.getActiveEditor();
  if (!snapshot) {
    return { selection: null, message: "No active editor is open." };
  }

  const sensitive = isSensitiveFilePath(snapshot.relativePath ?? snapshot.name);
  let anyTruncated = false;

  const views: SelectionView[] = snapshot.selections.map((selection) => {
    const raw = sensitive ? "" : redactSensitiveText(selection.text);
    const truncated = raw.length > maxChars;
    if (truncated) {
      anyTruncated = true;
    }
    return {
      ...(snapshot.relativePath ? { path: snapshot.relativePath } : {}),
      name: snapshot.name,
      ...(snapshot.untitled ? { untitled: true as const } : {}),
      ...(snapshot.outsideWorkspace ? { outsideWorkspace: true as const } : {}),
      start: { line: selection.start.line, column: selection.start.character },
      end: { line: selection.end.line, column: selection.end.character },
      text: truncated ? raw.slice(0, maxChars) : raw,
      ...(truncated ? { truncated: true as const } : {}),
      ...(sensitive && selection.text.length > 0 ? { redacted: true as const } : {}),
    };
  });

  // A single selection keeps the documented `{ selection: {...} }` shape; two
  // or more use `{ selections: [...] }` and preserve editor ordering.
  if (views.length <= 1) {
    return {
      selection: views[0] ?? null,
      ...(anyTruncated ? { truncated: true as const } : {}),
    };
  }
  return {
    selections: views,
    ...(anyTruncated ? { truncated: true as const } : {}),
  };
}

function requireEditor(deps: EditorToolDeps): EditorContextSource {
  if (!deps.editor) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Editor context is only available inside the VS Code extension host.",
    );
  }
  return deps.editor;
}

export function parseMaxChars(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return MAX_SELECTION_CHARS;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_input", "maxChars must be a number.");
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    throw new ToolExecutionError("invalid_input", "maxChars must be at least 1.");
  }
  return Math.min(floored, MAX_SELECTION_CHARS_LIMIT);
}
