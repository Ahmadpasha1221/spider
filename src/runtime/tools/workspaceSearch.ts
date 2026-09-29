import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isInsideWorkspace } from "./workspacePath";
import { ToolExecutionError } from "./toolError";

/**
 * ONE workspace search/scoping implementation shared by every read-only search
 * tool (`search_files`, `grep_search`, `glob_search`, and the multi-file
 * reader). Keeping the ignore rules, traversal limits, binary detection and
 * pattern compilation here means the tools cannot drift apart and no tool
 * grows its own private walker.
 */

/** Generated/vendored directories that are never worth scanning. */
export const WORKSPACE_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".idea",
  ".gradle",
  ".parcel-cache",
]);

export const SEARCH_LIMITS = {
  /** Default and hard cap for text match results. */
  grepDefaultResults: 100,
  grepMaxResults: 500,
  /** Files examined before a grep gives up (truncated: max_scanned_files). */
  grepMaxScannedFiles: 2000,
  /** Per-file byte cap for content scanning. */
  grepMaxFileBytes: 512_000,
  /** Lines longer than this are cut for regex scanning safety + payload size. */
  grepMaxLineLength: 2_000,
  /** Default and hard cap for glob path results. */
  globDefaultResults: 200,
  globMaxResults: 2_000,
  /** Entries examined before a glob gives up. */
  globMaxScannedEntries: 20_000,
  /** Depth guard so a pathological tree cannot blow the stack. */
  maxDepth: 32,
} as const;

/** First-NUL-byte heuristic: the standard cheap binary-file test. */
export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_000);
  return sample.includes(0);
}

export function isIgnoredDirectoryName(name: string): boolean {
  return WORKSPACE_IGNORED_DIRECTORIES.has(name);
}

export interface WorkspaceWalkEntry {
  /** Absolute path on disk. */
  readonly absolutePath: string;
  /** Workspace-relative POSIX path (what the model should see). */
  readonly relativePath: string;
}

export interface WalkWorkspaceOptions {
  readonly signal?: AbortSignal;
  /** Stop after this many visited entries (directories + files). */
  readonly maxEntries?: number;
  /** Do not descend below this depth (walk root = 0). */
  readonly maxDepth?: number;
  /**
   * Root used for the reported `relativePath` values. Defaults to the walk
   * root; search tools pass the workspace root so results are always
   * workspace-relative, even when the search is narrowed to a subdirectory.
   */
  readonly relativeTo?: string;
}

export interface WalkWorkspaceResult {
  readonly scannedFiles: number;
  readonly scannedEntries: number;
  /** True when `maxEntries` stopped the walk. */
  readonly truncated: boolean;
  readonly cancelled: boolean;
}

/**
 * Depth-first, deterministic (sorted) workspace walk.
 *
 * - ignored directories are never descended into,
 * - symlinks are only followed when their real path stays inside the workspace,
 * - `onFile` returning false (or an abort) stops the walk immediately,
 * - traversal limits are reported instead of silently hiding a partial result.
 */
export async function walkWorkspace(
  workspacePath: string,
  onFile: (entry: WorkspaceWalkEntry) => Promise<boolean> | boolean,
  options: WalkWorkspaceOptions = {},
): Promise<WalkWorkspaceResult> {
  const root = path.resolve(workspacePath);
  const relativeRoot = path.resolve(options.relativeTo ?? workspacePath);
  const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
  const maxDepth = options.maxDepth ?? SEARCH_LIMITS.maxDepth;
  let scannedFiles = 0;
  let scannedEntries = 0;
  let truncated = false;
  let cancelled = false;

  async function walk(current: string, depth: number): Promise<boolean> {
    if (options.signal?.aborted) {
      cancelled = true;
      return false;
    }
    if (depth > maxDepth) {
      return true;
    }

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it, never fail the whole search.
      return true;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (options.signal?.aborted) {
        cancelled = true;
        return false;
      }
      if (scannedEntries >= maxEntries) {
        truncated = true;
        return false;
      }
      scannedEntries += 1;

      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosixRelative(relativeRoot, absolutePath);

      if (entry.isDirectory()) {
        if (isIgnoredDirectoryName(entry.name)) {
          continue;
        }
        if (!(await walk(absolutePath, depth + 1))) {
          return false;
        }
        continue;
      }

      if (entry.isSymbolicLink()) {
        // A link may point outside the workspace: verify the real target.
        const real = await safeRealpath(absolutePath);
        if (!real || !isInsideWorkspace(root, real)) {
          continue;
        }
        const stats = await safeStat(real);
        if (stats?.isDirectory()) {
          if (!isIgnoredDirectoryName(entry.name) && !(await walk(real, depth + 1))) {
            return false;
          }
        } else if (stats?.isFile()) {
          scannedFiles += 1;
          if (!(await onFile({ absolutePath, relativePath }))) {
            return false;
          }
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      scannedFiles += 1;
      if (!(await onFile({ absolutePath, relativePath }))) {
        return false;
      }
    }
    return true;
  }

  await walk(root, 0);
  return { scannedFiles, scannedEntries, truncated, cancelled };
}

/** Workspace-relative POSIX path for a file discovered while walking. */
export function toPosixRelative(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath).replaceAll("\\", "/");
}

export interface TextPatternOptions {
  readonly query: string;
  readonly isRegex?: boolean;
  readonly caseSensitive?: boolean;
}

/** Longest pattern accepted, so a pathological regex cannot be submitted. */
const MAX_PATTERN_LENGTH = 500;

/**
 * Compiles a model-supplied search pattern. Invalid regexes become a typed
 * `invalid_input` error (never an unhandled throw) and the pattern is length
 * capped; no model input is ever handed to a shell.
 */
export function compileTextPattern(options: TextPatternOptions): RegExp {
  const query = options.query;
  if (query.length === 0) {
    throw new ToolExecutionError("invalid_input", "The search query must not be empty.");
  }
  if (query.length > MAX_PATTERN_LENGTH) {
    throw new ToolExecutionError(
      "invalid_input",
      `The search query is too long (limit ${MAX_PATTERN_LENGTH} characters).`,
    );
  }
  const flags = options.caseSensitive ? "" : "i";
  const source = options.isRegex ? query : escapeRegExp(query);
  try {
    return new RegExp(source, flags);
  } catch {
    throw new ToolExecutionError("invalid_input", `Invalid regular expression: ${query}`);
  }
}

export interface GlobMatcher {
  readonly pattern: string;
  /** True when the pattern matches either the basename or the full path. */
  matches(relativePath: string): boolean;
}

/**
 * Compiles a glob pattern.
 *
 * Semantics (documented, deterministic):
 * - `**` matches any number of path segments (a trailing `/` after `**` may
 *   match nothing, so `**\/foo` also matches a top-level `foo`),
 * - `*` and `?` never cross a `/` separator,
 * - `{a,b}` is an alternation, `[abc]` is a character class (`[!abc]` negates),
 * - a pattern without any `/` is matched against the file name, so `*.ts`
 *   finds `src/a.ts`; a pattern with a `/` is matched against the whole
 *   workspace-relative path.
 */
export function compileGlob(pattern: string): GlobMatcher {
  const raw = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (raw.length === 0) {
    throw new ToolExecutionError("invalid_input", "The glob pattern must not be empty.");
  }
  if (raw.length > MAX_PATTERN_LENGTH) {
    throw new ToolExecutionError(
      "invalid_input",
      `The glob pattern is too long (limit ${MAX_PATTERN_LENGTH} characters).`,
    );
  }

  const normalized = raw.replace(/^\/+/, "");
  const matcher = new RegExp(`^${globToRegExpSource(normalized)}$`);
  const matchesName = !normalized.includes("/");

  return {
    pattern,
    matches(relativePath) {
      const value = relativePath.replaceAll("\\", "/");
      if (matcher.test(value)) {
        return true;
      }
      if (!matchesName) {
        return false;
      }
      const name = value.slice(value.lastIndexOf("/") + 1);
      return matcher.test(name);
    },
  };
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          // "**/x" must also match a top-level "x".
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      const body = pattern.slice(index + 1, end).replace(/^!/, "^");
      source += `[${body.replaceAll("\\", "\\\\")}]`;
      index = end;
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end === -1) {
        source += "\\{";
        continue;
      }
      const alternatives = pattern.slice(index + 1, end).split(",");
      source += `(?:${alternatives.map((alternative) => escapeRegExp(alternative)).join("|")})`;
      index = end;
      continue;
    }
    source += escapeRegExp(char);
  }
  return source;
}

async function safeRealpath(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

async function safeStat(target: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch {
    return undefined;
  }
}
