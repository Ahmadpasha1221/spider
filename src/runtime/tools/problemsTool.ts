import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";
import type { DiagnosticsSource } from "../diagnostics/diagnosticsSource";
import type { DiagnosticContext } from "../../context/contextTypes";

/**
 * `get_problems`: the verification read after an edit.
 *
 * It reports the diagnostics VS Code *currently holds* (`languages.getDiagnostics`)
 * for the workspace or one file. It never runs a compiler and never triggers a
 * build: if a language server has not caught up yet, the result reports what is
 * available now (with a `note` so the model understands diagnostics may lag an
 * edit). Normalization (severity, secret redaction, ordering) is reused from
 * the existing diagnostics context collector — there is exactly one normalizer.
 */
export const MAX_PROBLEMS = 500;

export type ProblemScope = "workspace" | "file";

export interface ProblemEntryView {
  readonly path: string;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface GetProblemsResult {
  readonly scope: ProblemScope;
  readonly path?: string;
  readonly problems: readonly ProblemEntryView[];
  readonly summary: Readonly<Record<ProblemEntryView["severity"], number>>;
  readonly truncated: boolean;
  readonly reason?: "max_diagnostics";
  readonly note?: string;
}

export interface ProblemsToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface ProblemsToolDeps {
  readonly diagnostics?: DiagnosticsSource;
}

export async function getProblems(
  input: Record<string, unknown>,
  context: ProblemsToolContext,
  deps: ProblemsToolDeps,
): Promise<GetProblemsResult> {
  const scope = parseProblemScope(input.scope);
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
    max: MAX_PROBLEMS + 1,
  });

  const truncated = collected.length > MAX_PROBLEMS;
  const limited = truncated ? collected.slice(0, MAX_PROBLEMS) : collected;
  const problems = limited.map((entry) => toProblemEntry(entry, context.workspacePath));

  return {
    scope,
    ...(requestedPath ? { path: requestedPath } : {}),
    problems,
    summary: summarizeProblems(problems),
    truncated,
    ...(truncated ? { reason: "max_diagnostics" as const } : {}),
    note: "Reports diagnostics currently known to the editor; language servers may lag a recent edit.",
  };
}

export function parseProblemScope(value: unknown): ProblemScope {
  if (value === undefined || value === null || value === "") {
    return "workspace";
  }
  if (value === "workspace" || value === "file") {
    return value;
  }
  throw new ToolExecutionError("invalid_input", `Invalid scope: ${String(value)}. Use "workspace" or "file".`);
}

/** Deterministic order: severity rank, then path, then position. */
const SEVERITY_RANK: Record<ProblemEntryView["severity"], number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

export function sortProblemEntries(problems: readonly ProblemEntryView[]): ProblemEntryView[] {
  return [...problems].sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) {
      return byPath;
    }
    const byLine = left.range.start.line - right.range.start.line;
    if (byLine !== 0) {
      return byLine;
    }
    return left.range.start.character - right.range.start.character;
  });
}

function toProblemEntry(entry: DiagnosticContext, workspacePath: string): ProblemEntryView {
  return {
    path: toWorkspaceRelativePath(workspacePath, entry.filePath),
    severity: entry.severity,
    message: entry.message,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.code ? { code: entry.code } : {}),
    range: {
      start: { line: entry.range.start.line, character: entry.range.start.character },
      end: { line: entry.range.end.line, character: entry.range.end.character },
    },
  };
}

function summarizeProblems(problems: readonly ProblemEntryView[]): Record<ProblemEntryView["severity"], number> {
  const summary: Record<ProblemEntryView["severity"], number> = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0,
  };
  for (const problem of problems) {
    summary[problem.severity] += 1;
  }
  return summary;
}
