import {
  type GitCommandRunner,
  isNotARepository,
} from "./gitStatusTool";
import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";

/**
 * `git_log`: READ ONLY history inspection.
 *
 * The model supplies a bounded `limit` and an optional workspace-relative path;
 * it can never supply a git flag. Spider builds the argv itself with
 * `shell: false`, so the command is fixed and deterministic (newest commit
 * first, no `--all`, no custom formatting from the caller).
 */
export interface GitCommit {
  readonly hash: string;
  readonly shortHash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface GitLogResult {
  readonly repository: boolean;
  readonly limit: number;
  readonly path?: string;
  readonly commits: readonly GitCommit[];
  readonly truncated: boolean;
  readonly reason?: "max_results";
  readonly cancelled?: true;
  readonly message?: string;
}

export interface GitLogToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export const DEFAULT_LOG_LIMIT = 20;
export const MAX_LOG_LIMIT = 100;
export const MAX_LOG_SUBJECT_LENGTH = 200;
const GIT_TIMEOUT_MS = 15_000;

/** Record/field separators that cannot collide with a normal commit message. */
const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

export async function gitLog(
  input: Record<string, unknown>,
  context: GitLogToolContext,
  runner: GitCommandRunner,
): Promise<GitLogResult> {
  const limit = parseLogLimit(input.limit);
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

  const args = [
    "--no-optional-locks",
    "log",
    `--max-count=${limit + 1}`,
    "--no-color",
    "--no-decorate",
    "--no-notes",
    "--no-show-signature",
    `--pretty=format:%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
  ];
  if (relativePath && relativePath.length > 0) {
    args.push("--", relativePath);
  }

  const result = await runner.run(args, {
    cwd: context.workspacePath,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });

  if (result.cancelled) {
    return emptyResult(limit, { cancelled: true, ...(requestedPath ? { path: requestedPath } : {}) });
  }
  if (result.failedToStart) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Git is not installed or not available on PATH; the git_log tool cannot be used.",
    );
  }
  if (result.timedOut) {
    throw new ToolExecutionError("timeout", "git log timed out.");
  }
  if (isNotARepository(result)) {
    return emptyResult(limit, {
      ...(requestedPath ? { path: requestedPath } : {}),
      message: "This workspace is not a Git repository.",
    });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.split(/\r?\n/, 1)[0] ?? "").trim();
    throw new ToolExecutionError(
      "internal_error",
      detail.length > 0 ? `git log failed: ${detail}` : "git log failed.",
    );
  }

  const parsed = parseGitLog(result.stdout);
  const truncated = parsed.length > limit;
  return {
    repository: true,
    limit,
    ...(requestedPath ? { path: requestedPath } : {}),
    commits: truncated ? parsed.slice(0, limit) : parsed,
    truncated,
    ...(truncated ? { reason: "max_results" as const } : {}),
  };
}

export function parseLogLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LOG_LIMIT;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_input", "limit must be a number.");
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    throw new ToolExecutionError("invalid_input", "limit must be at least 1.");
  }
  return Math.min(floored, MAX_LOG_LIMIT);
}

export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\r?\n/, "");
    if (trimmed.trim().length === 0) {
      continue;
    }
    const fields = trimmed.split(FIELD_SEPARATOR);
    const [hash, shortHash, author, date, subject] = fields;
    // Reject anything that does not look like a commit record: a crafted
    // subject containing the separators cannot inject fake entries.
    if (!hash || !/^[0-9a-f]{7,40}$/.test(hash)) {
      continue;
    }
    commits.push({
      hash,
      shortHash: shortHash && /^[0-9a-f]{4,40}$/.test(shortHash) ? shortHash : hash.slice(0, 7),
      author: author ?? "",
      date: date ?? "",
      subject: truncateSubject(subject ?? ""),
    });
  }
  return commits;
}

function truncateSubject(subject: string): string {
  const single = subject.replace(/[\r\n]+/g, " ").trim();
  return single.length > MAX_LOG_SUBJECT_LENGTH ? `${single.slice(0, MAX_LOG_SUBJECT_LENGTH)}…` : single;
}

function emptyResult(limit: number, extra: Partial<GitLogResult>): GitLogResult {
  return {
    repository: false,
    limit,
    commits: [],
    truncated: false,
    ...extra,
  };
}
