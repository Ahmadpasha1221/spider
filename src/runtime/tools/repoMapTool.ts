import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolExecutionError } from "./toolError";
import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { MAX_GITIGNORE_BYTES, isIgnoredDirectoryName, toPosixRelative } from "./workspaceSearch";
import { isIgnoredByGitignore, parseGitignore, type GitignoreRule } from "./gitignore";

/**
 * `repo_map`: a compact structural view of the repository.
 *
 * It reuses the shared ignore rules (`isIgnoredDirectoryName`) so generated and
 * vendored directories are never traversed, validates the requested root through
 * the shared workspace path safety, and is bounded by depth + entry count with
 * an explicit `truncated` flag. No persistent cache or filesystem watcher is
 * introduced for it.
 */
export const REPO_MAP_LIMITS = {
  defaultDepth: 3,
  maxDepth: 6,
  maxEntries: 2000,
} as const;

export interface RepoMapNode {
  readonly name: string;
  readonly type: "directory" | "file";
  readonly children?: readonly RepoMapNode[];
}

export interface RepoMapResult {
  readonly root: string;
  readonly tree: readonly RepoMapNode[];
  readonly entries: number;
  readonly truncated: boolean;
  readonly cancelled?: true;
  readonly message?: string;
}

export interface RepoMapToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

/** Overridable traversal bound (tests / alternative hosts). */
export interface RepoMapDeps {
  readonly maxEntries?: number;
}

export async function repoMap(
  input: Record<string, unknown>,
  context: RepoMapToolContext,
  deps: RepoMapDeps = {},
): Promise<RepoMapResult> {
  const depth = clampInt(input.depth, REPO_MAP_LIMITS.defaultDepth, REPO_MAP_LIMITS.maxDepth);
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : ".";
  if (requestedPath.startsWith("-")) {
    throw new ToolExecutionError("invalid_input", "path must not start with '-'.");
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const root = await resolveWorkspacePathSafe(context.workspacePath, requestedPath);
  const includeIgnored = input.includeIgnored === true;
  const state: BuildState = {
    entries: 0,
    truncated: false,
    cancelled: false,
    maxEntries: Math.max(1, deps.maxEntries ?? REPO_MAP_LIMITS.maxEntries),
    ignoreRules: [],
    workspaceRoot: path.resolve(context.workspacePath),
    includeIgnored,
  };

  // Ancestor ignore files govern a narrowed root too: load the workspace
  // root (and intermediate) files outermost-first before descending.
  const rootRel = toPosixRelative(state.workspaceRoot, root);
  if (rootRel !== "." && !rootRel.startsWith("..")) {
    const segments = rootRel.split("/");
    let current = state.workspaceRoot;
    for (let index = 0; index < segments.length - 1; index += 1) {
      current = path.join(current, segments[index] ?? "");
      await loadIgnoreFile(state, current);
    }
  }

  const tree = await buildTree(root, depth, state, context.signal);
  return {
    root: toWorkspaceRelativePath(context.workspacePath, root) || ".",
    tree,
    entries: state.entries,
    truncated: state.truncated,
    ...(state.cancelled ? { cancelled: true as const } : {}),
  };
}

interface BuildState {
  entries: number;
  truncated: boolean;
  cancelled: boolean;
  readonly maxEntries: number;
  readonly ignoreRules: GitignoreRule[];
  readonly workspaceRoot: string;
  readonly includeIgnored: boolean;
}

async function buildTree(
  directory: string,
  depth: number,
  state: BuildState,
  signal?: AbortSignal,
): Promise<RepoMapNode[]> {
  if (signal?.aborted) {
    state.cancelled = true;
    return [];
  }
  if (depth <= 0 || state.entries >= state.maxEntries) {
    if (state.entries >= state.maxEntries) {
      state.truncated = true;
    }
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  await loadIgnoreFile(state, directory);

  const directories: RepoMapNode[] = [];
  const files: RepoMapNode[] = [];

  for (const entry of entries) {
    if (signal?.aborted) {
      state.cancelled = true;
      break;
    }
    if (state.entries >= state.maxEntries) {
      state.truncated = true;
      break;
    }
    state.entries += 1;

    const relativePath = toPosixRelative(state.workspaceRoot, path.join(directory, entry.name));
    if (entry.isDirectory()) {
      if (isIgnoredDirectoryName(entry.name) || isIgnoredByState(state, relativePath, true)) {
        continue;
      }
      const children = await buildTree(path.join(directory, entry.name), depth - 1, state, signal);
      directories.push({ name: entry.name, type: "directory", children });
      continue;
    }
    // Symbolic links and special files are reported as plain files without
    // following them, so the map never escapes the workspace.
    if (isIgnoredByState(state, relativePath, false)) {
      continue;
    }
    files.push({ name: entry.name, type: "file" });
  }

  return [...directories, ...files];
}

function isIgnoredByState(state: BuildState, relativePath: string, isDirectory: boolean): boolean {
  if (state.includeIgnored || state.ignoreRules.length === 0) {
    return false;
  }
  return isIgnoredByGitignore(state.ignoreRules, relativePath, isDirectory);
}

async function loadIgnoreFile(state: BuildState, absoluteDir: string): Promise<void> {
  if (state.includeIgnored) {
    return;
  }
  const scope = toPosixRelative(state.workspaceRoot, absoluteDir);
  if (scope.startsWith("..")) {
    return;
  }
  try {
    const stats = await fs.stat(path.join(absoluteDir, ".gitignore"));
    if (!stats.isFile() || stats.size > MAX_GITIGNORE_BYTES) {
      return;
    }
    const content = await fs.readFile(path.join(absoluteDir, ".gitignore"), "utf8");
    state.ignoreRules.push(...parseGitignore(content, scope === "." ? "" : scope));
  } catch {
    // No ignore file: nothing to honor.
  }
}

function clampInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}
