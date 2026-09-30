import * as path from "node:path";

/**
 * Where `list_symbols` / `go_to_definition` / `find_references` get their data.
 *
 * The tools depend on this interface, not on VS Code, so they are fully
 * testable outside the extension host (mirrors the `DiagnosticsSource` and
 * `EditorContextSource` patterns). No language-specific parsing happens here:
 * symbol resolution is delegated to whatever the editor's language providers
 * already know (TypeScript server, Python extension, …), and `vscode` is
 * imported lazily so importing this module from a non-VS Code host never fails.
 *
 * Every query is workspace-bound: absolute paths are the caller's concern (the
 * tool layer validates them); this source returns normalized, serializable
 * plain data — never vscode.Uri / Position / Range / SymbolInformation objects.
 */
export interface SymbolEntry {
  readonly name: string;
  readonly kind: string;
  /** Workspace-relative POSIX path of the file containing the symbol. */
  readonly path: string;
  /** Zero-based, VS Code-native positions. */
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly detail?: string;
  readonly children?: readonly SymbolEntry[];
}

export interface DocumentSymbolsQuery {
  /** Absolute path on disk (pre-validated by the tool layer). */
  readonly absolutePath: string;
  readonly signal?: AbortSignal;
}

export interface WorkspaceSymbolsQuery {
  readonly query: string;
  readonly workspacePath: string;
  readonly max: number;
  readonly signal?: AbortSignal;
}

export interface LocationEntry {
  /** Workspace-relative POSIX path; empty-string path results are dropped. */
  readonly path: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface DefinitionQuery {
  readonly absolutePath: string;
  readonly line: number;
  readonly character: number;
  readonly workspacePath: string;
  readonly max: number;
  readonly signal?: AbortSignal;
}

export interface ReferencesQuery {
  readonly absolutePath: string;
  readonly line: number;
  readonly character: number;
  readonly workspacePath: string;
  readonly max: number;
  readonly includeDeclaration: boolean;
  readonly signal?: AbortSignal;
}

export interface LanguageSource {
  documentSymbols(query: DocumentSymbolsQuery): Promise<readonly SymbolEntry[]>;
  workspaceSymbols(query: WorkspaceSymbolsQuery): Promise<readonly SymbolEntry[]>;
  definitions(query: DefinitionQuery): Promise<readonly LocationEntry[]>;
  references(query: ReferencesQuery): Promise<readonly LocationEntry[]>;
}

/** Creates the VS Code-backed source. Lazily imports `vscode`. */
export function createVSCodeLanguageSource(): LanguageSource {
  return {
    async documentSymbols(query) {
      const vscodeApi = await import("vscode");
      const uri = vscodeApi.Uri.file(query.absolutePath);
      const symbols = await withTimeout(vscodeApi.commands.executeCommand<unknown>("vscode.executeDocumentSymbolProvider", uri), query.signal);
      if (!Array.isArray(symbols)) {
        return [];
      }
      return symbols
        .map((symbol) => flattenDocumentSymbol(symbol, query.absolutePath, 0))
        .filter((symbol): symbol is SymbolEntry => symbol !== undefined);
    },

    async workspaceSymbols(query) {
      const vscodeApi = await import("vscode");
      const raw = await withTimeout(
        vscodeApi.commands.executeCommand<unknown>("vscode.executeWorkspaceSymbolProvider", query.query),
        query.signal,
      );
      if (!Array.isArray(raw)) {
        return [];
      }
      const entries: SymbolEntry[] = [];
      for (const item of raw) {
        if (entries.length >= query.max) {
          break;
        }
        const entry = toWorkspaceSymbol(item, query.workspacePath);
        if (entry && entry.path.length > 0) {
          entries.push(entry);
        }
      }
      return entries;
    },

    async definitions(query) {
      const vscodeApi = await import("vscode");
      const uri = vscodeApi.Uri.file(query.absolutePath);
      const position = new vscodeApi.Position(query.line, query.character);
      const raw = await withTimeout(
        vscodeApi.commands.executeCommand<unknown>("vscode.executeDefinitionProvider", uri, position),
        query.signal,
      );
      return toLocationEntries(raw, query.workspacePath, query.max);
    },

    async references(query) {
      const vscodeApi = await import("vscode");
      const uri = vscodeApi.Uri.file(query.absolutePath);
      const position = new vscodeApi.Position(query.line, query.character);
      const raw = await withTimeout(
        vscodeApi.commands.executeCommand<unknown>("vscode.executeReferenceProvider", uri, position, {
          includeDeclaration: query.includeDeclaration,
        }),
        query.signal,
      );
      return toLocationEntries(raw, query.workspacePath, query.max);
    },
  };
}

/** Bounded LSP wait: providers can hang on a slow language server. */
const PROVIDER_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: PromiseLike<T> | undefined, signal?: AbortSignal): Promise<T | undefined> {
  if (!promise) {
    return undefined;
  }
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return await new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => resolve(undefined)), PROVIDER_TIMEOUT_MS);
    const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    function finish(action: () => void): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // vscode commands return Thenable, not Promise — normalize first.
    Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

type SymbolKind = { kind: string; detail?: string };

/** Maps vscode.SymbolKind (numeric enum) onto a stable, serializable name. */
export function symbolKindName(kind: unknown): string {
  const names: Record<number, string> = {
    0: "file", 1: "module", 2: "namespace", 3: "package", 4: "class",
    5: "method", 6: "property", 7: "field", 8: "constructor", 9: "enum",
    10: "interface", 11: "function", 12: "variable", 13: "constant",
    14: "string", 15: "number", 16: "boolean", 17: "array", 18: "object",
    19: "key", 20: "null", 21: "enum-member", 22: "struct", 23: "event",
    24: "operator", 25: "type-parameter",
  };
  return typeof kind === "number" ? (names[kind] ?? "unknown") : "unknown";
}

function flattenDocumentSymbol(symbol: unknown, absolutePath: string, depth: number): SymbolEntry | undefined {
  if (typeof symbol !== "object" || symbol === null) {
    return undefined;
  }
  const record = symbol as {
    name?: unknown; kind?: unknown; detail?: unknown; range?: unknown;
    selectionRange?: unknown; children?: unknown;
  };
  if (typeof record.name !== "string" || typeof record.range !== "object" || record.range === null) {
    return undefined;
  }
  const range = toRange(record.range);
  if (!range) {
    return undefined;
  }
  const meta: SymbolKind = { kind: symbolKindName(record.kind) };
  if (typeof record.detail === "string" && record.detail.length > 0) {
    meta.detail = record.detail.slice(0, 200);
  }
  const entry: { name: string; kind: string; path: string; range: typeof range; detail?: string; children?: SymbolEntry[] } = {
    name: record.name.slice(0, 300),
    kind: meta.kind,
    path: absolutePath,
    range,
    ...(meta.detail ? { detail: meta.detail } : {}),
  };
  if (depth < 8 && Array.isArray(record.children) && record.children.length > 0) {
    entry.children = record.children
      .map((child) => flattenDocumentSymbol(child, absolutePath, depth + 1))
      .filter((child): child is SymbolEntry => child !== undefined);
  }
  return entry;
}

function toWorkspaceSymbol(item: unknown, workspacePath: string): SymbolEntry | undefined {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  const record = item as { name?: unknown; kind?: unknown; location?: unknown };
  if (typeof record.name !== "string" || typeof record.location !== "object" || record.location === null) {
    return undefined;
  }
  const location = record.location as { uri?: unknown; range?: unknown };
  const fsPath = typeof location.uri === "object" && location.uri !== null ? (location.uri as { fsPath?: unknown }).fsPath : undefined;
  if (typeof fsPath !== "string" || fsPath.length === 0) {
    return undefined;
  }
  const range = toRange(location.range) ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  return {
    name: record.name.slice(0, 300),
    kind: symbolKindName(record.kind),
    path: relativePosix(workspacePath, fsPath),
    range,
  };
}

function toLocationEntries(raw: unknown, workspacePath: string, max: number): LocationEntry[] {
  const locations = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
  const entries: LocationEntry[] = [];
  for (const item of locations) {
    if (entries.length >= max) {
      break;
    }
    const entry = toLocationEntry(item, workspacePath);
    if (entry && entry.path.length > 0) {
      entries.push(entry);
    }
  }
  return entries;
}

function toLocationEntry(item: unknown, workspacePath: string): LocationEntry | undefined {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  // A Location is `{ uri, range }`; a LocationLink is `{ targetUri, targetRange }`.
  const location = item as { uri?: unknown; range?: unknown; targetUri?: unknown; targetRange?: unknown };
  const uri = location.uri ?? location.targetUri;
  const range = location.range ?? location.targetRange;
  const fsPath = typeof uri === "object" && uri !== null ? (uri as { fsPath?: unknown }).fsPath : undefined;
  if (typeof fsPath !== "string" || fsPath.length === 0) {
    return undefined;
  }
  return {
    path: relativePosix(workspacePath, fsPath),
    range: toRange(range) ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  };
}

function toRange(range: unknown): LocationEntry["range"] | undefined {
  if (typeof range !== "object" || range === null) {
    return undefined;
  }
  const record = range as { start?: unknown; end?: unknown };
  const start = toPosition(record.start);
  const end = toPosition(record.end);
  if (!start || !end) {
    return undefined;
  }
  return { start, end };
}

function toPosition(position: unknown): { line: number; character: number } | undefined {
  if (typeof position !== "object" || position === null) {
    return undefined;
  }
  const record = position as { line?: unknown; character?: unknown };
  if (typeof record.line !== "number" || typeof record.character !== "number") {
    return undefined;
  }
  return { line: record.line, character: record.character };
}

function relativePosix(root: string, target: string): string {
  return path.relative(path.resolve(root), path.resolve(target)).replaceAll("\\", "/");
}
