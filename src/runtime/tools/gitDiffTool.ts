import {
  type GitCommandRunner,
  type GitFileStatusName,
  isNotARepository,
} from "./gitStatusTool";
import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";

/**
 * `git_diff`: READ ONLY inspection of changes in the workspace repository.
 *
 * Safety properties (shared with `git_status`):
 * - everything is passed as an argv array to `git` with `shell: false`, so no
 *   model-supplied text is ever parsed by a shell and no arbitrary git flag can
 *   be injected: the model chooses a *scope*, Spider chooses the flags,
 * - `--no-ext-diff` and `--no-textconv` stop external diff drivers and textconv
 *   filters from running (a diff must never execute a process),
 * - the pathspec is workspace-validated before it reaches git,
 * - the diff is capped and truncation is reported, never silent.
 */
export type GitDiffScope = "working_tree" | "staged" | "file";

export type GitDiffFileStatus = GitFileStatusName | "binary";

export interface GitDiffFile {
  readonly path: string;
  readonly status: GitDiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitDiffResult {
  readonly repository: boolean;
  readonly scope: GitDiffScope;
  readonly path?: string;
  readonly files: readonly GitDiffFile[];
  readonly diff: string;
  readonly truncated: boolean;
  readonly reason?: "max_output_size";
  readonly cancelled?: true;
  readonly message?: string;
}

export interface GitDiffToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

/** Hard cap on the diff text handed back to the model. */
export const MAX_DIFF_CHARS = 200_000;
const GIT_TIMEOUT_MS = 15_000;

export async function gitDiff(
  input: Record<string, unknown>,
  context: GitDiffToolContext,
  runner: GitCommandRunner,
): Promise<GitDiffResult> {
  const scope = parseDiffScope(input.scope);
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : undefined;
  if (scope === "file" && !requestedPath) {
    throw new ToolExecutionError("invalid_input", 'scope "file" requires a path argument.');
  }
  if (requestedPath && (input.path as string).startsWith("-")) {
    // A pathspec can never be mistaken for an option: git receives it after --,
    // but rejecting option-shaped input keeps the contract unambiguous.
    throw new ToolExecutionError("invalid_input", "path must not start with '-'.");
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const relativePath = requestedPath
    ? toWorkspaceRelativePath(context.workspacePath, await resolveWorkspacePathSafe(context.workspacePath, requestedPath))
    : undefined;

  const runOnce = (args: string[]) =>
    runner.run(args, {
      cwd: context.workspacePath,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    });

  let result = await runOnce(buildDiffArgs(scope, relativePath));
  // A repository with no commits yet has no HEAD; fall back to the index diff
  // for `file` scope instead of failing on an unborn branch.
  if (
    scope === "file" &&
    result.exitCode !== 0 &&
    /ambiguous argument 'HEAD'|unknown revision|bad revision|not a valid object name/i.test(result.stderr)
  ) {
    result = await runOnce(buildDiffArgs("working_tree", relativePath));
  }

  if (result.cancelled) {
    return emptyResult(scope, { cancelled: true, ...(requestedPath ? { path: requestedPath } : {}) });
  }
  if (result.failedToStart) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Git is not installed or not available on PATH; the git_diff tool cannot be used.",
    );
  }
  if (result.timedOut) {
    throw new ToolExecutionError("timeout", "git diff timed out.");
  }
  if (isNotARepository(result)) {
    return emptyResult(scope, {
      ...(requestedPath ? { path: requestedPath } : {}),
      message: "This workspace is not a Git repository.",
    });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.split(/\r?\n/, 1)[0] ?? "").trim();
    throw new ToolExecutionError(
      "internal_error",
      detail.length > 0 ? `git diff failed: ${detail}` : "git diff failed.",
    );
  }

  const truncated = result.stdout.length > MAX_DIFF_CHARS;
  const diff = truncated ? result.stdout.slice(0, MAX_DIFF_CHARS) : result.stdout;

  return {
    repository: true,
    scope,
    ...(requestedPath ? { path: requestedPath } : {}),
    files: parseUnifiedDiff(diff),
    diff,
    truncated,
    ...(truncated ? { reason: "max_output_size" as const } : {}),
  };
}

export function parseDiffScope(value: unknown): GitDiffScope {
  if (value === undefined || value === null || value === "") {
    return "working_tree";
  }
  if (value === "working_tree" || value === "staged" || value === "file") {
    return value;
  }
  throw new ToolExecutionError(
    "invalid_input",
    `Invalid scope: ${String(value)}. Use "working_tree", "staged" or "file".`,
  );
}

function buildDiffArgs(scope: GitDiffScope, relativePath: string | undefined): string[] {
  const args = [
    "--no-optional-locks",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    "--find-renames",
  ];
  if (scope === "staged") {
    args.push("--cached");
  }
  if (scope === "file") {
    args.push("HEAD");
  }
  if (relativePath && relativePath.length > 0) {
    args.push("--", relativePath);
  }
  return args;
}

/**
 * Parses a unified diff into per-file metadata. Only the fixed, Spider-chosen
 * diff format is understood; anything unexpected is ignored rather than
 * guessed at.
 */
export function parseUnifiedDiff(diff: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  let current: { path: string; status: GitDiffFileStatus; additions: number; deletions: number } | undefined;

  const flush = (): void => {
    if (current && current.path.length > 0) {
      files.push({ ...current });
    }
    current = undefined;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { path: parseDiffHeader(line) ?? "", status: "modified", additions: 0, deletions: 0 };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
    } else if (line.startsWith("copy from ")) {
      current.status = "copied";
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      const target = unquotePath(line.slice(line.indexOf(" to ") + 4).trim());
      if (target.length > 0) {
        current.path = stripDiffPrefix(target);
      }
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target !== "/dev/null") {
        current.path = stripDiffPrefix(unquotePath(target));
      }
    } else if (line.startsWith("--- ")) {
      const source = line.slice(4).trim();
      if (source !== "/dev/null" && current.path.length === 0) {
        current.path = stripDiffPrefix(unquotePath(source));
      }
    } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.status = "binary";
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
    }
  }
  flush();

  return files;
}

function parseDiffHeader(line: string): string | undefined {
  const rest = line.slice("diff --git ".length).trimEnd();
  if (rest.startsWith('"')) {
    const quoted = /^"(.*?)" "(.*?)"$/.exec(rest);
    if (!quoted || !quoted[2]) {
      return undefined;
    }
    return stripDiffPrefix(unquotePath(quoted[2]));
  }
  const separator = rest.lastIndexOf(" b/");
  if (separator < 0) {
    return undefined;
  }
  return stripDiffPrefix(rest.slice(separator + 1));
}

export function stripDiffPrefix(value: string): string {
  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  return value;
}

function unquotePath(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function emptyResult(scope: GitDiffScope, extra: Partial<GitDiffResult>): GitDiffResult {
  return {
    repository: false,
    scope,
    files: [],
    diff: "",
    truncated: false,
    ...extra,
  };
}
