import * as fs from "node:fs/promises";
import { resolveWorkspacePathSafe } from "./workspacePath";
import {
  SEARCH_LIMITS,
  compileGlob,
  compileTextPattern,
  isProbablyBinary,
  walkWorkspace,
  type GlobMatcher,
} from "./workspaceSearch";
import { ToolExecutionError } from "./toolError";

/**
 * The two read-only search tools:
 *
 *   grep_search — searches CONTENT (plain text or regex) and returns matches
 *   glob_search — searches FILE PATHS via glob patterns
 *
 * They share the walker, ignore rules and limits, but answer different
 * questions and never delegate to each other.
 */

export interface SearchToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface GrepSearchResult {
  readonly query: string;
  readonly path: string;
  readonly isRegex: boolean;
  readonly caseSensitive: boolean;
  readonly matches: readonly GrepMatch[];
  readonly scannedFiles: number;
  readonly cancelled?: true;
  readonly truncated?: true;
  readonly reason?: "max_results" | "max_scanned_files";
}

export interface GlobSearchResult {
  readonly pattern: string;
  readonly path: string;
  readonly files: readonly string[];
  readonly scannedFiles: number;
  readonly cancelled?: true;
  readonly truncated?: true;
  readonly reason?: "max_results" | "max_scanned_files";
}

/**
 * Content search with hard result/scan/byte limits. Never shells out: the
 * model's query is compiled into a RegExp in-process, invalid patterns become
 * typed errors, and binary or oversized files are skipped rather than parsed.
 */
export async function grepSearch(
  input: Record<string, unknown>,
  context: SearchToolContext,
): Promise<GrepSearchResult> {
  const query = requiredString(input, "query");
  const requestedPath = optionalString(input, "path") ?? ".";
  const isRegex = optionalBoolean(input, "isRegex") ?? false;
  const caseSensitive = optionalBoolean(input, "caseSensitive") ?? false;
  const maxResults = clampLimit(input.maxResults, SEARCH_LIMITS.grepDefaultResults, SEARCH_LIMITS.grepMaxResults);

  const pattern = compileTextPattern({ query, isRegex, caseSensitive });
  const fileFilter = optionalString(input, "fileGlob");
  const glob: GlobMatcher | undefined = fileFilter ? compileGlob(fileFilter) : undefined;

  const root = await resolveExistingDirectory(context.workspacePath, requestedPath);

  let truncated = false;
  let reason: GrepSearchResult["reason"];
  const matches: GrepMatch[] = [];

  const walk = await walkWorkspace(root, async (entry) => {
    if (matches.length >= maxResults) {
      truncated = true;
      reason = "max_results";
      return false;
    }
    if (glob && !glob.matches(entry.relativePath)) {
      return true;
    }

    let stats;
    try {
      stats = await fs.stat(entry.absolutePath);
    } catch {
      return true;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > SEARCH_LIMITS.grepMaxFileBytes) {
      return true;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(entry.absolutePath);
    } catch {
      return true;
    }
    if (isProbablyBinary(buffer)) {
      return true;
    }

    scanLines(buffer.toString("utf8"), entry.relativePath, pattern, matches, maxResults);
    if (matches.length >= maxResults) {
      truncated = true;
      reason = "max_results";
      return false;
    }
    return true;
  }, {
    ...(context.signal ? { signal: context.signal } : {}),
    maxEntries: SEARCH_LIMITS.globMaxScannedEntries,
    relativeTo: context.workspacePath,
  });

  if (walk.truncated && !truncated) {
    truncated = true;
    reason = "max_scanned_files";
  }

  return {
    query,
    path: requestedPath,
    isRegex,
    caseSensitive,
    matches,
    scannedFiles: walk.scannedFiles,
    ...(walk.cancelled ? { cancelled: true as const } : {}),
    ...(truncated ? { truncated: true as const, reason: reason ?? "max_results" } : {}),
  };
}

/** Path search: glob patterns matched against workspace-relative paths. */
export async function globSearch(
  input: Record<string, unknown>,
  context: SearchToolContext,
): Promise<GlobSearchResult> {
  const patternText = requiredString(input, "pattern");
  const requestedPath = optionalString(input, "path") ?? ".";
  const maxResults = clampLimit(input.maxResults, SEARCH_LIMITS.globDefaultResults, SEARCH_LIMITS.globMaxResults);

  const matcher = compileGlob(patternText);
  const root = await resolveExistingDirectory(context.workspacePath, requestedPath);

  const files: string[] = [];
  let truncated = false;
  let reason: GlobSearchResult["reason"];

  const walk = await walkWorkspace(root, (entry) => {
    if (files.length >= maxResults) {
      truncated = true;
      reason = "max_results";
      return false;
    }
    if (matcher.matches(entry.relativePath)) {
      files.push(entry.relativePath);
    }
    return true;
  }, {
    ...(context.signal ? { signal: context.signal } : {}),
    maxEntries: SEARCH_LIMITS.globMaxScannedEntries,
    relativeTo: context.workspacePath,
  });

  if (walk.truncated && !truncated) {
    truncated = true;
    reason = "max_scanned_files";
  }

  return {
    pattern: patternText,
    path: requestedPath,
    files,
    scannedFiles: walk.scannedFiles,
    ...(walk.cancelled ? { cancelled: true as const } : {}),
    ...(truncated ? { truncated: true as const, reason: reason ?? "max_results" } : {}),
  };
}

function scanLines(
  content: string,
  relativePath: string,
  pattern: RegExp,
  matches: GrepMatch[],
  maxResults: number,
): void {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (matches.length >= maxResults) {
      return;
    }
    const rawLine = lines[index] ?? "";
    // Very long lines (minified assets, data URIs) are skipped for regex
    // scanning: they add payload weight and are the main backtracking risk.
    if (rawLine.length > SEARCH_LIMITS.grepMaxLineLength) {
      continue;
    }
    // Case sensitivity is already baked into the compiled pattern.
    const found = rawLine.match(pattern);
    if (!found || found.index === undefined) {
      continue;
    }
    matches.push({
      path: relativePath,
      // 1-based for humans and for ripgrep-compatible muscle memory.
      line: index + 1,
      column: found.index + 1,
      text: rawLine.trim().slice(0, SEARCH_LIMITS.grepMaxLineLength),
    });
  }
}

async function resolveExistingDirectory(workspacePath: string, requestedPath: string): Promise<string> {
  const target = await resolveWorkspacePathSafe(workspacePath, requestedPath);
  let stats;
  try {
    stats = await fs.stat(target);
  } catch {
    throw new ToolExecutionError("not_found", `Path not found: ${requestedPath}`);
  }
  if (!stats.isDirectory()) {
    throw new ToolExecutionError("invalid_input", `Path is not a directory: ${requestedPath}`);
  }
  return target;
}

function clampLimit(value: unknown, fallback: number, hardMax: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(1, Math.floor(value)), hardMax);
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (!value) {
    throw new ToolExecutionError("invalid_input", `Missing required argument: ${key}`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}
