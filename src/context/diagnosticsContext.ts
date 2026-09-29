import type * as vscode from "vscode";
import type {
  DiagnosticContext,
  DiagnosticSeverity,
  WorkspaceFolderContext,
} from "./contextTypes";
import {
  createContextRange,
  isSensitiveFilePath,
  redactSensitiveText,
  truncateText,
} from "./contextTypes";

export interface DiagnosticsContextOptions {
  readonly maxDiagnostics?: number;
  readonly maxDiagnosticMessageLength?: number;
  readonly workspaceFolders?: readonly WorkspaceFolderContext[];
  readonly activeFilePath?: string;
  readonly workspacePath?: string;
}

type DiagnosticEntry = readonly [vscode.Uri, readonly vscode.Diagnostic[]];

const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

export function collectDiagnosticsContext(
  entries: readonly DiagnosticEntry[],
  options: DiagnosticsContextOptions = {},
): DiagnosticContext[] {
  const maxDiagnostics = Math.max(0, Math.floor(options.maxDiagnostics ?? 50));
  if (maxDiagnostics === 0) {
    return [];
  }

  const activeFilePath = normalizePath(options.activeFilePath ?? "");
  const requestedRoot = normalizePath(options.workspacePath ?? "");
  const configuredRoots = (options.workspaceFolders ?? []).map((folder) => normalizePath(folder.path));
  const roots = resolveRoots(configuredRoots, requestedRoot);
  const hasRoots = roots.length > 0;

  const diagnostics = entries
    .flatMap(([uri, diagnosticsForFile]) => diagnosticsForFile.map((diagnostic) => ({ uri, diagnostic })))
    .filter(({ uri }) => {
      const filePath = normalizePath(getUriPath(uri));
      if (!filePath || isSensitiveFilePath(filePath)) {
        return false;
      }

      if (!hasRoots) {
        return activeFilePath.length > 0 && samePath(filePath, activeFilePath);
      }

      return roots.some((root) => isPathWithin(filePath, root)) ||
        (activeFilePath.length > 0 && samePath(filePath, activeFilePath));
    })
    .map(({ uri, diagnostic }) => toDiagnosticContext(uri, diagnostic, options.maxDiagnosticMessageLength ?? 500))
    .sort(compareDiagnostics)
    .slice(0, maxDiagnostics);

  return diagnostics;
}

function resolveRoots(configuredRoots: readonly string[], requestedRoot: string): string[] {
  if (requestedRoot.length === 0) {
    return [...configuredRoots];
  }

  const matchingRoots = configuredRoots.filter((root) =>
    samePath(root, requestedRoot) ||
    isPathWithin(root, requestedRoot) ||
    isPathWithin(requestedRoot, root),
  );

  return matchingRoots.length > 0 ? [...matchingRoots] : [requestedRoot];
}

function toDiagnosticContext(
  uri: vscode.Uri,
  diagnostic: vscode.Diagnostic,
  maxMessageLength: number,
): DiagnosticContext {
  const severity = toDiagnosticSeverity(diagnostic.severity);
  const code = toDiagnosticCode(diagnostic.code);
  return {
    severity,
    message: truncateText(redactSensitiveText(diagnostic.message), maxMessageLength),
    source: diagnostic.source?.trim() || undefined,
    ...(code ? { code } : {}),
    filePath: getUriPath(uri),
    range: createContextRange(diagnostic.range.start, diagnostic.range.end),
  };
}

/** VS Code reports codes as string | number | { value: string | number }. */
function toDiagnosticCode(code: vscode.Diagnostic["code"]): string | undefined {
  if (code === undefined || code === null) {
    return undefined;
  }
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  const value = (code as { value?: unknown }).value;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function toDiagnosticSeverity(severity: vscode.DiagnosticSeverity): DiagnosticSeverity {
  switch (severity) {
    case 0:
      return "error";
    case 1:
      return "warning";
    case 2:
      return "information";
    case 3:
      return "hint";
    default:
      return "information";
  }
}

function compareDiagnostics(left: DiagnosticContext, right: DiagnosticContext): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    left.filePath.localeCompare(right.filePath) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.message.localeCompare(right.message);
}

function getUriPath(uri: vscode.Uri): string {
  return uri.fsPath || uri.toString();
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function samePath(left: string, right: string): boolean {
  return comparePath(left, right) === 0;
}

function isPathWithin(filePath: string, root: string): boolean {
  if (root.length === 0) {
    return false;
  }

  const normalizedFile = normalizePath(filePath);
  const normalizedRoot = normalizePath(root);
  const comparison = comparePath(normalizedFile, normalizedRoot);
  if (comparison === 0) {
    return true;
  }

  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return comparePath(normalizedFile.slice(0, prefix.length), prefix) === 0;
}

function comparePath(left: string, right: string): number {
  const leftComparable = isCaseInsensitivePath(left, right) ? left.toLowerCase() : left;
  const rightComparable = isCaseInsensitivePath(left, right) ? right.toLowerCase() : right;
  return leftComparable.localeCompare(rightComparable);
}

function isCaseInsensitivePath(left: string, right: string): boolean {
  return /^[a-zA-Z]:\//.test(left) || /^[a-zA-Z]:\//.test(right);
}
