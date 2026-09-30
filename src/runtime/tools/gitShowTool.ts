import {
  isNotARepository,
  type GitCommandResult,
  type GitCommandRunner,
} from "./gitStatusTool";
import { parseGitLog, type GitCommit } from "./gitLogTool";
import { MAX_DIFF_CHARS, parseUnifiedDiff, type GitDiffFile } from "./gitDiffTool";
import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";

/**
 * `git_show`: READ ONLY inspection of a single commit.
 *
 * Reuses the shared Git runner (argv only, `shell: false`) and the existing
 * log/diff parsers, so it cannot drift from `git_log`/`git_diff`. The model
 * supplies only a commit identifier and an optional workspace pathspec; every
 * git flag is chosen by Spider and no model text reaches a shell.
 */
export interface GitShowResult {
  readonly repository: boolean;
  readonly commit?: GitCommit;
  readonly path?: string;
  readonly files: readonly GitDiffFile[];
  readonly diff: string;
  readonly truncated: boolean;
  readonly reason?: "max_output_size" | "max_files";
  readonly cancelled?: true;
  readonly message?: string;
}

export interface GitShowToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export const MAX_SHOW_FILES = 200;
const GIT_TIMEOUT_MS = 15_000;
const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

export async function gitShow(
  input: Record<string, unknown>,
  context: GitShowToolContext,
  runner: GitCommandRunner,
): Promise<GitShowResult> {
  const ref = parseCommitRef(input.commit);
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : undefined;
  if (requestedPath && requestedPath.startsWith("-")) {
    throw new ToolExecutionError("invalid_input", "path must not start with '-'.");
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const relativePath = requestedPath
    ? toWorkspaceRelativePath(context.workspacePath, await resolveWorkspacePathSafe(context.workspacePath, requestedPath))
    : undefined;

  const run = (args: string[]): Promise<GitCommandResult> =>
    runner.run(args, {
      cwd: context.workspacePath,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    });

  const meta = await run([
    "--no-optional-locks",
    "log",
    "-1",
    "--no-color",
    "--no-decorate",
    "--no-notes",
    "--no-show-signature",
    `--pretty=format:%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
    ref,
  ]);
  const metaFailure = classify(meta, "git show");
  if (metaFailure.kind === "unavailable") {
    throw new ToolExecutionError("dependency_unavailable", "Git is not installed or not available on PATH; the git_show tool cannot be used.");
  }
  if (metaFailure.kind === "not_repository") {
    return emptyResult({ ...(requestedPath ? { path: requestedPath } : {}), message: "This workspace is not a Git repository." });
  }
  if (metaFailure.kind === "cancelled") {
    return emptyResult({ cancelled: true, ...(requestedPath ? { path: requestedPath } : {}) });
  }
  if (metaFailure.kind === "timeout") {
    throw new ToolExecutionError("timeout", "git show timed out.");
  }
  if (metaFailure.kind === "bad_ref") {
    throw new ToolExecutionError("not_found", `Unknown commit: ${ref}.`);
  }
  if (metaFailure.kind === "error") {
    throw new ToolExecutionError("internal_error", metaFailure.message ?? "git show failed.");
  }

  const commit = parseGitLog(meta.stdout)[0];
  if (!commit) {
    throw new ToolExecutionError("not_found", `Could not read commit ${ref}.`);
  }

  const diffArgs = [
    "--no-optional-locks",
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--unified=3",
    "--no-notes",
    "--no-show-signature",
    "--format=",
    ref,
  ];
  if (relativePath && relativePath.length > 0) {
    diffArgs.push("--", relativePath);
  }
  const diffResult = await run(diffArgs);
  const diffFailure = classify(diffResult, "git show");
  if (diffFailure.kind === "unavailable") {
    throw new ToolExecutionError("dependency_unavailable", "Git is not available on PATH; the git_show tool cannot be used.");
  }
  if (diffFailure.kind === "not_repository") {
    return emptyResult({ ...(requestedPath ? { path: requestedPath } : {}), message: "This workspace is not a Git repository." });
  }
  if (diffFailure.kind === "cancelled") {
    return { ...emptyResult({ ...(requestedPath ? { path: requestedPath } : {}) }), commit, cancelled: true };
  }
  if (diffFailure.kind === "timeout") {
    throw new ToolExecutionError("timeout", "git show timed out.");
  }
  if (diffFailure.kind === "bad_ref") {
    throw new ToolExecutionError("not_found", `Unknown commit: ${ref}.`);
  }
  if (diffFailure.kind === "error") {
    throw new ToolExecutionError("internal_error", diffFailure.message ?? "git show failed.");
  }

  const truncatedBySize = diffResult.stdout.length > MAX_DIFF_CHARS;
  const diff = truncatedBySize ? diffResult.stdout.slice(0, MAX_DIFF_CHARS) : diffResult.stdout;
  const parsedFiles = parseUnifiedDiff(diff);
  const truncatedByFiles = parsedFiles.length > MAX_SHOW_FILES;

  return {
    repository: true,
    commit,
    ...(requestedPath ? { path: requestedPath } : {}),
    files: truncatedByFiles ? parsedFiles.slice(0, MAX_SHOW_FILES) : parsedFiles,
    diff,
    truncated: truncatedBySize || truncatedByFiles,
    ...(truncatedBySize
      ? { reason: "max_output_size" as const }
      : truncatedByFiles
        ? { reason: "max_files" as const }
        : {}),
  };
}

/**
 * Validates a commit identifier: a hash or a simple ref, never a range and
 * never something that could be mistaken for a git option. This is the single
 * guard that keeps model input out of git's option namespace.
 */
export function parseCommitRef(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: commit.");
  }
  const ref = value.trim();
  if (ref.length > 200) {
    throw new ToolExecutionError("invalid_input", "commit is too long.");
  }
  if (ref.startsWith("-")) {
    throw new ToolExecutionError("invalid_input", "commit must not start with '-'.");
  }
  if (ref.includes("..")) {
    throw new ToolExecutionError("invalid_input", "commit must reference a single commit (ranges are not supported).");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._/~^-]*$/.test(ref)) {
    throw new ToolExecutionError("invalid_input", "commit contains unsupported characters.");
  }
  return ref;
}

type FailureKind = "unavailable" | "not_repository" | "cancelled" | "timeout" | "bad_ref" | "error" | "ok";

function classify(result: GitCommandResult, label: string): { kind: FailureKind; message?: string } {
  if (result.failedToStart) return { kind: "unavailable" };
  if (result.cancelled) return { kind: "cancelled" };
  if (result.timedOut) return { kind: "timeout" };
  if (isNotARepository(result)) return { kind: "not_repository" };
  if (result.exitCode !== 0) {
    const detail = (result.stderr.split(/\r?\n/, 1)[0] ?? "").trim();
    if (/unknown revision|bad revision|ambiguous argument|bad object|not a valid object name|unknown commit/i.test(detail)) {
      return { kind: "bad_ref" };
    }
    return { kind: "error", message: detail.length > 0 ? `${label} failed: ${detail}` : `${label} failed.` };
  }
  return { kind: "ok" };
}

function emptyResult(extra: Partial<GitShowResult>): GitShowResult {
  return {
    repository: false,
    files: [],
    diff: "",
    truncated: false,
    ...extra,
  };
}
