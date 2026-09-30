import { isNotARepository, type GitCommandRunner } from "./gitStatusTool";
import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";

/**
 * `git_blame`: READ ONLY per-line attribution for a bounded range.
 *
 * Reuses the shared Git runner (argv only, `shell: false`) and validates the
 * file through the shared workspace path safety. The line range is always
 * bounded before git is invoked, so a request for an enormous range is a
 * controlled validation error rather than a huge result.
 */
export interface GitBlameLine {
  readonly line: number;
  readonly commit: string;
  readonly shortCommit: string;
  readonly author: string;
  readonly date: string;
  readonly summary: string;
}

export interface GitBlameResult {
  readonly repository: boolean;
  readonly path?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly GitBlameLine[];
  readonly truncated?: true;
  readonly reason?: "max_lines";
  readonly cancelled?: true;
  readonly message?: string;
}

export interface GitBlameToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export const MAX_BLAME_LINES = 200;
export const DEFAULT_BLAME_LINES = 50;
const GIT_TIMEOUT_MS = 15_000;

export async function gitBlame(
  input: Record<string, unknown>,
  context: GitBlameToolContext,
  runner: GitCommandRunner,
): Promise<GitBlameResult> {
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : undefined;
  if (!requestedPath) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: path.");
  }
  if (requestedPath.startsWith("-")) {
    throw new ToolExecutionError("invalid_input", "path must not start with '-'.");
  }
  const startLine = parsePositiveInt(input.startLine, "startLine", 1);
  const endLine = parsePositiveInt(input.endLine, "endLine", startLine + DEFAULT_BLAME_LINES - 1);
  if (endLine < startLine) {
    throw new ToolExecutionError("invalid_input", "endLine must be greater than or equal to startLine.");
  }
  if (endLine - startLine + 1 > MAX_BLAME_LINES) {
    throw new ToolExecutionError(
      "invalid_input",
      `The requested range exceeds the maximum of ${MAX_BLAME_LINES} lines.`,
    );
  }
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const target = await resolveWorkspacePathSafe(context.workspacePath, requestedPath);
  const relativePath = toWorkspaceRelativePath(context.workspacePath, target);
  if (relativePath.length === 0) {
    throw new ToolExecutionError("invalid_input", "path must reference a file, not the workspace root.");
  }

  const result = await runner.run(
    [
      "--no-optional-locks",
      "-c",
      "color.ui=false",
      "blame",
      "--line-porcelain",
      "-L",
      `${startLine},${endLine}`,
      "--",
      relativePath,
    ],
    {
      cwd: context.workspacePath,
      timeoutMs: GIT_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    },
  );

  if (result.failedToStart) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Git is not installed or not available on PATH; the git_blame tool cannot be used.",
    );
  }
  if (result.cancelled) {
    return emptyResult(startLine, endLine, { path: requestedPath, cancelled: true });
  }
  if (result.timedOut) {
    throw new ToolExecutionError("timeout", "git blame timed out.");
  }
  if (isNotARepository(result)) {
    return emptyResult(startLine, endLine, { path: requestedPath, message: "This workspace is not a Git repository." });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.split(/\r?\n/, 1)[0] ?? "").trim();
    if (/has only \d+ lines?|has only/i.test(detail)) {
      throw new ToolExecutionError("invalid_input", "The requested line range is outside the file.");
    }
    if (/no such path|not in this repository|unknown revision|bad revision|does not exist/i.test(detail)) {
      throw new ToolExecutionError("not_found", detail.length > 0 ? detail : `Could not blame ${requestedPath}.`);
    }
    throw new ToolExecutionError("internal_error", detail.length > 0 ? `git blame failed: ${detail}` : "git blame failed.");
  }

  const parsed = parseBlamePorcelain(result.stdout);
  const truncated = parsed.length > MAX_BLAME_LINES;
  return {
    repository: true,
    path: requestedPath,
    startLine,
    endLine,
    lines: truncated ? parsed.slice(0, MAX_BLAME_LINES) : parsed,
    ...(truncated ? { truncated: true as const, reason: "max_lines" as const } : {}),
  };
}

/** Parses `git blame --line-porcelain` output into one entry per line. */
export function parseBlamePorcelain(stdout: string): GitBlameLine[] {
  const lines = stdout.split(/\r?\n/);
  const result: GitBlameLine[] = [];
  const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

  let index = 0;
  while (index < lines.length) {
    const match = header.exec(lines[index] ?? "");
    if (!match || !match[1]) {
      index += 1;
      continue;
    }
    const commit = match[1];
    const finalLine = Number(match[2] ?? 0);
    index += 1;

    let author = "";
    let epoch = 0;
    let summary = "";
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.startsWith("\t")) {
        index += 1;
        break;
      }
      if (header.test(line)) {
        break;
      }
      if (line.startsWith("author ")) {
        author = line.slice("author ".length).trim();
      } else if (line.startsWith("author-time ")) {
        const value = Number(line.slice("author-time ".length).trim());
        epoch = Number.isFinite(value) ? value : 0;
      } else if (line.startsWith("summary ")) {
        summary = line.slice("summary ".length).trim();
      }
      index += 1;
    }

    result.push({
      line: finalLine,
      commit,
      shortCommit: commit.slice(0, 7),
      author,
      date: epoch > 0 ? new Date(epoch * 1000).toISOString() : "",
      summary,
    });
  }

  return result.sort((left, right) => left.line - right.line);
}

function parsePositiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_input", `${field} must be a number.`);
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    throw new ToolExecutionError("invalid_input", `${field} must be at least 1.`);
  }
  return floored;
}

function emptyResult(startLine: number, endLine: number, extra: Partial<GitBlameResult>): GitBlameResult {
  return {
    repository: false,
    startLine,
    endLine,
    lines: [],
    ...extra,
  };
}
