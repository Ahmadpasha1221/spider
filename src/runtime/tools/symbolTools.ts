import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";
import type { LanguageSource, SymbolEntry } from "../lsp/languageSource";

/**
 * `list_symbols`: structural view of source code through the editor's own
 * symbol providers (`vscode.executeDocumentSymbolProvider` /
 * `vscode.executeWorkspaceSymbolProvider`). No language parsing happens here —
 * whatever the TypeScript/Python/etc. extension already knows is authoritative.
 * Output is a normalized, bounded, serializable tree; paths are
 * workspace-relative.
 */
export const MAX_SYMBOLS = 200;

export type SymbolScope = "document" | "workspace";

export interface ListSymbolsResult {
  readonly scope: SymbolScope;
  readonly path?: string;
  readonly symbols: readonly SymbolEntry[];
  readonly truncated: boolean;
  readonly cancelled?: true;
  readonly reason?: "max_symbols";
  readonly message?: string;
}

export interface SymbolToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface SymbolToolDeps {
  readonly language?: LanguageSource;
}

export async function listSymbols(
  input: Record<string, unknown>,
  context: SymbolToolContext,
  deps: SymbolToolDeps,
): Promise<ListSymbolsResult> {
  const scope = parseScope(input.scope);
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : undefined;
  if (scope === "document" && !requestedPath) {
    throw new ToolExecutionError("invalid_input", "scope \"document\" requires a path argument.");
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }
  if (!deps.language) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Symbol information is only available inside the VS Code extension host.",
    );
  }

  if (scope === "workspace") {
    const query = typeof input.query === "string" && input.query.trim().length > 0 ? input.query.trim() : "";
    const collected = await deps.language.workspaceSymbols({
      query,
      workspacePath: context.workspacePath,
      max: MAX_SYMBOLS + 1,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const truncated = collected.length > MAX_SYMBOLS;
    return {
      scope,
      ...(query.length > 0 ? { message: `Workspace symbols matching "${query}".` } : {}),
      symbols: truncated ? collected.slice(0, MAX_SYMBOLS) : collected,
      truncated,
      ...(context.signal?.aborted ? { cancelled: true as const } : {}),
      ...(truncated ? { reason: "max_symbols" as const } : {}),
    };
  }

  const absolutePath = await resolveWorkspacePathSafe(context.workspacePath, requestedPath!);
  const collected = await deps.language.documentSymbols({
    absolutePath,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const flat = collected.length > 0 ? collected : [];
  const truncated = countSymbols(flat) > MAX_SYMBOLS;
  return {
    scope,
    path: toWorkspaceRelativePath(context.workspacePath, absolutePath),
    symbols: truncated ? trimToBudget(flat, MAX_SYMBOLS) : flat,
    truncated,
    ...(context.signal?.aborted ? { cancelled: true as const } : {}),
    ...(truncated ? { reason: "max_symbols" as const } : {}),
  };
}

export function parseScope(value: unknown): SymbolScope {
  if (value === undefined || value === null || value === "") {
    return "document";
  }
  if (value === "document" || value === "workspace") {
    return value;
  }
  throw new ToolExecutionError("invalid_input", `Invalid scope: ${String(value)}. Use "document" or "workspace".`);
}

/** Deterministic order: by path, then start position, then name. */
export function sortSymbolEntries(symbols: readonly SymbolEntry[]): SymbolEntry[] {
  return [...symbols].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) {
      return byPath;
    }
    const byLine = left.range.start.line - right.range.start.line;
    if (byLine !== 0) {
      return byLine;
    }
    const byCharacter = left.range.start.character - right.range.start.character;
    if (byCharacter !== 0) {
      return byCharacter;
    }
    return left.name.localeCompare(right.name);
  });
}

function countSymbols(symbols: readonly SymbolEntry[]): number {
  let count = 0;
  for (const symbol of symbols) {
    count += 1;
    if (symbol.children) {
      count += countSymbols(symbol.children);
    }
  }
  return count;
}

/** Keeps the first `budget` symbols in document order (parents before children). */
function trimToBudget(symbols: readonly SymbolEntry[], budget: number): SymbolEntry[] {
  const result: SymbolEntry[] = [];
  let remaining = budget;
  for (const symbol of symbols) {
    if (remaining <= 0) {
      break;
    }
    remaining -= 1;
    if (symbol.children && symbol.children.length > 0) {
      const children = trimToBudget(symbol.children, remaining);
      remaining -= children.length;
      result.push({ ...symbol, children });
    } else {
      result.push(symbol);
    }
  }
  return result;
}
