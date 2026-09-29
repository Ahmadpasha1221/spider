import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";
import type { DiagnosticsSource } from "../diagnostics/diagnosticsSource";
import type { DiagnosticContext } from "../../context/contextTypes";

/**
 * `get_diagnostics`: read-only VS Code integration.
 *
 * It reports the diagnostics the editor currently holds (workspace or a single
 * file) and never triggers a build, so the agent can check its own edits
 * without side effects. Raw VS Code objects never reach the model: output is a
 * plain, normalized, redacted, bounded list.
 */
export const MAX_DIAGNOSTICS = 200;

export type DiagnosticScope = "workspace" | "file";

export interface DiagnosticEntryView {
  readonly path: string;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
  /** Zero-based, VS Code-native, matching Spider's ContextRange everywhere. */
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface GetDiagnosticsResult {
  readonly scope: DiagnosticScope;
  readonly path?: string;
  readonly diagnostics: readonly DiagnosticEntryView[];
  readonly total: number;
  readonly counts: Readonly<Record<DiagnosticEntryView["severity"], number>>;
  readonly cancelled?: true;
  readonly truncated?: true;
  readonly reason?: "max_diagnostics";
}

export interface DiagnosticsToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface DiagnosticsToolDeps {
  readonly diagnostics?: DiagnosticsSource;
}

export async function getDiagnostics(
  input: Record<string, unknown>,
  context: DiagnosticsToolContext,
  deps: DiagnosticsToolDeps,
): Promise<GetDiagnosticsResult> {
  const scope = parseScope(input.scope);
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : undefined;
  if (scope === "file" && !requestedPath) {
    throw new ToolExecutionError("invalid_input", "scope \"file\" requires a path argument.");
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }
  if (!deps.diagnostics) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Diagnostics are only available inside the VS Code extension host.",
    );
  }

  const filePath = scope === "file" && requestedPath
    ? await resolveWorkspacePathSafe(context.workspacePath, requestedPath)
    : undefined;

  const collected = await deps.diagnostics.list({
    workspacePath: context.workspacePath,
    ...(filePath ? { filePath } : {}),
    max: MAX_DIAGNOSTICS + 1,
  });

  const truncated = collected.length > MAX_DIAGNOSTICS;
  const limited = truncated ? collected.slice(0, MAX_DIAGNOSTICS) : collected;
  const diagnostics = limited.map((entry) => toDiagnosticEntryView(entry, context.workspacePath));

  return {
    scope,
    ...(requestedPath ? { path: requestedPath } : {}),
    diagnostics,
    total: diagnostics.length,
    counts: countSeverities(diagnostics),
    ...(context.signal?.aborted ? { cancelled: true as const } : {}),
    ...(truncated ? { truncated: true as const, reason: "max_diagnostics" as const } : {}),
  };
}

export function parseScope(value: unknown): DiagnosticScope {
  if (value === undefined || value === null || value === "") {
    return "workspace";
  }
  if (value === "workspace" || value === "file") {
    return value;
  }
  throw new ToolExecutionError("invalid_input", `Invalid scope: ${String(value)}. Use "workspace" or "file".`);
}

function toDiagnosticEntryView(entry: DiagnosticContext, workspacePath: string): DiagnosticEntryView {
  return {
    path: toWorkspaceRelativePath(workspacePath, entry.filePath),
    severity: entry.severity,
    message: entry.message,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.code ? { code: entry.code } : {}),
    start: { line: entry.range.start.line, character: entry.range.start.character },
    end: { line: entry.range.end.line, character: entry.range.end.character },
  };
}

function countSeverities(
  diagnostics: readonly DiagnosticEntryView[],
): Record<DiagnosticEntryView["severity"], number> {
  const counts: Record<DiagnosticEntryView["severity"], number> = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0,
  };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
}
