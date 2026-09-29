export interface ContextPosition {
  readonly line: number;
  readonly character: number;
}

export interface ContextRange {
  readonly start: ContextPosition;
  readonly end: ContextPosition;
}

export function createContextPosition(line: number, character: number): ContextPosition {
  return { line, character };
}

export function createContextRange(
  start: { readonly line: number; readonly character: number },
  end: { readonly line: number; readonly character: number },
): ContextRange {
  return {
    start: createContextPosition(start.line, start.character),
    end: createContextPosition(end.line, end.character),
  };
}

export interface WorkspaceFolderContext {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceContext {
  readonly folders: readonly WorkspaceFolderContext[];
  readonly rootPath?: string;
  readonly isTrusted: boolean;
  readonly foldersTruncated: boolean;
}

export interface EditorContext {
  readonly filePath: string;
  readonly languageId: string;
  readonly cursorPosition: ContextPosition;
  readonly selection: ContextRange;
  readonly selectedText?: string;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface DiagnosticContext {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: string;
  /** Provider code (TypeScript 2345, eslint rule id, …) when one exists. */
  readonly code?: string;
  readonly filePath: string;
  readonly range: ContextRange;
}

export interface ContextSnapshot {
  readonly workspace: WorkspaceContext;
  readonly editor?: EditorContext;
  readonly diagnostics: readonly DiagnosticContext[];
}

export interface ContextManagerOptions {
  readonly maxWorkspaceFolders?: number;
  readonly maxDiagnostics?: number;
  readonly maxSelectedTextLength?: number;
  readonly maxDiagnosticMessageLength?: number;
}

export const DEFAULT_MAX_WORKSPACE_FOLDERS = 10;
export const DEFAULT_MAX_DIAGNOSTICS = 50;
export const DEFAULT_MAX_SELECTED_TEXT_LENGTH = 4000;
export const DEFAULT_MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;

export function truncateText(value: string, maxLength: number): string {
  const limit = Math.max(0, Math.floor(maxLength));
  if (limit === 0 || value.length <= limit) {
    return limit === 0 ? "" : value;
  }

  const marker = "\n...[truncated]";
  const contentLength = Math.max(0, limit - marker.length);
  return `${value.slice(0, contentLength)}${marker}`;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b((?:api[_-]?key|apikey|password|passwd|secret|token|access[_-]?token|private[_-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]");
}

export function isSensitiveFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const pathParts = normalized.split("/");
  const fileName = pathParts[pathParts.length - 1] ?? "";

  if (fileName === ".env" || fileName.startsWith(".env.")) {
    return true;
  }

  return /\.(?:pem|key|p12|pfx)$/i.test(fileName) ||
    fileName === "id_rsa" ||
    fileName === "id_ed25519" ||
    /(?:^|[-_.])(?:credentials?|secrets?|private[-_.]?keys?|api[-_.]?keys?)(?:$|[-_.])/i.test(fileName);
}
