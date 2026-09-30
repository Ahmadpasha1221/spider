import { resolveWorkspacePathSafe } from "./workspacePath";
import { ToolExecutionError } from "./toolError";
import type { LanguageSource } from "../lsp/languageSource";

/**
 * `go_to_definition` / `find_references`: navigation through the editor's
 * definition/reference providers (`vscode.executeDefinitionProvider` /
 * `vscode.executeReferenceProvider`). No language-specific resolution is
 * implemented here; results are normalized, workspace-relative and bounded,
 * and "nothing found" is a normal empty result — never an error.
 */
export const MAX_DEFINITIONS = 20;
export const MAX_REFERENCES = 500;

export interface LocationView {
  readonly path: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface NavigationToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface NavigationToolDeps {
  readonly language?: LanguageSource;
}

export interface GoToDefinitionResult {
  readonly path: string;
  readonly definitions: readonly LocationView[];
  readonly truncated?: true;
  readonly reason?: "max_definitions";
  readonly message?: string;
}

export interface FindReferencesResult {
  readonly path: string;
  readonly includeDeclaration: boolean;
  readonly references: readonly LocationView[];
  readonly truncated: boolean;
  readonly reason?: "max_references";
  readonly cancelled?: true;
}

interface Position {
  readonly line: number;
  readonly character: number;
}

export async function goToDefinition(
  input: Record<string, unknown>,
  context: NavigationToolContext,
  deps: NavigationToolDeps,
): Promise<GoToDefinitionResult> {
  const { absolutePath, requestedPath, position } = await resolveTarget(input, context);
  if (!deps.language) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Go-to-definition is only available inside the VS Code extension host.",
    );
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const locations = await deps.language.definitions({
    absolutePath,
    line: position.line,
    character: position.character,
    workspacePath: context.workspacePath,
    max: MAX_DEFINITIONS + 1,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const truncated = locations.length > MAX_DEFINITIONS;
  const definitions = truncated ? locations.slice(0, MAX_DEFINITIONS) : locations;
  return {
    path: requestedPath,
    definitions,
    ...(truncated ? { truncated: true as const, reason: "max_definitions" as const } : {}),
    ...(definitions.length === 0 ? { message: "No definition found for this location." } : {}),
  };
}

export async function findReferences(
  input: Record<string, unknown>,
  context: NavigationToolContext,
  deps: NavigationToolDeps,
): Promise<FindReferencesResult> {
  const includeDeclaration = input.includeDeclaration !== false;
  const { absolutePath, requestedPath, position } = await resolveTarget(input, context);
  if (!deps.language) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Find-references is only available inside the VS Code extension host.",
    );
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const locations = await deps.language.references({
    absolutePath,
    line: position.line,
    character: position.character,
    workspacePath: context.workspacePath,
    max: MAX_REFERENCES + 1,
    includeDeclaration,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const truncated = locations.length > MAX_REFERENCES;
  return {
    path: requestedPath,
    includeDeclaration,
    references: truncated ? locations.slice(0, MAX_REFERENCES) : locations,
    truncated,
    ...(truncated ? { reason: "max_references" as const } : {}),
    ...(context.signal?.aborted ? { cancelled: true as const } : {}),
  };
}

/** Shared path/position validation for both navigation tools. */
async function resolveTarget(
  input: Record<string, unknown>,
  context: NavigationToolContext,
): Promise<{ absolutePath: string; requestedPath: string; position: Position }> {
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : undefined;
  if (!requestedPath) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: path.");
  }
  if (requestedPath.startsWith("-")) {
    throw new ToolExecutionError("invalid_input", "path must not start with '-'.");
  }
  const position = parsePosition(input);
  const absolutePath = await resolveWorkspacePathSafe(context.workspacePath, requestedPath);
  return { absolutePath, requestedPath, position };
}

export function parsePosition(input: Record<string, unknown>): Position {
  const line = parseCoordinate(input.line, "line");
  const character = parseCoordinate(input.character, "character");
  return { line, character };
}

function parseCoordinate(value: unknown, field: "line" | "character"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_input", `${field} must be a number.`);
  }
  const floored = Math.floor(value);
  if (floored < 0) {
    throw new ToolExecutionError("invalid_input", `${field} must be at least 0 (zero-based).`);
  }
  return floored;
}

/** Deterministic reference order: by path, then position. */
export function sortLocationEntries(entries: readonly LocationView[]): LocationView[] {
  return [...entries].sort((left, right) => {
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
