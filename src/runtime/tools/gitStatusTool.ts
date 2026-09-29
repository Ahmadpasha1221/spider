import { spawn } from "node:child_process";
import { resolveWorkspacePathSafe, toWorkspaceRelativePath } from "./workspacePath";
import { ToolExecutionError } from "./toolError";

/**
 * `git_status`: READ ONLY inspection of the working tree.
 *
 * Safety properties:
 * - arguments are passed as an argv array to `git` with `shell: false`, so no
 *   model-supplied text is ever parsed by a shell,
 * - the working directory is always the resolved workspace root (or a verified
 *   subdirectory of it),
 * - `--no-optional-locks` keeps git from writing index locks while we read,
 * - results are capped and the repository is never modified.
 */
export const MAX_GIT_FILES = 500;
const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;

export type GitFileStatusName =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface GitFileStatus {
  readonly path: string;
  readonly status: GitFileStatusName;
  /** True when the change is in the index (X side of the porcelain XY code). */
  readonly staged: boolean;
  readonly originalPath?: string;
}

export interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the process could not be started (git missing). */
  readonly failedToStart: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface GitCommandRunner {
  run(
    args: readonly string[],
    options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<GitCommandResult>;
}

export interface GitStatusToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface GitStatusResult {
  readonly repository: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly clean: boolean;
  readonly files: readonly GitFileStatus[];
  readonly total: number;
  readonly cancelled?: true;
  readonly truncated?: true;
  readonly reason?: "max_files";
  readonly message?: string;
}

/**
 * Spawns `git` without a shell. Arguments are never interpolated into a
 * command string, so model input cannot change the command being run.
 */
export function createGitCommandRunner(): GitCommandRunner {
  return {
    async run(args, options) {
      const first = await runGitProcess("git", args, options);
      if (first.failedToStart && process.platform === "win32") {
        // On Windows the executable is normally `git.exe`; CreateProcess does
        // not always resolve the bare name from a non-shell spawn.
        return runGitProcess("git.exe", args, options);
      }
      return first;
    },
  };
}

export async function gitStatus(
  input: Record<string, unknown>,
  context: GitStatusToolContext,
  runner: GitCommandRunner,
): Promise<GitStatusResult> {
  const requestedPath = typeof input.path === "string" && input.path.trim().length > 0 ? input.path.trim() : ".";
  const includeIgnored = input.includeIgnored === true;

  // The path is validated even though it only narrows the pathspec: it must
  // stay inside the workspace.
  const target = await resolveWorkspacePathSafe(context.workspacePath, requestedPath);
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const args = [
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=all",
    ...(includeIgnored ? ["--ignored=traditional"] : []),
  ];
  const relativePath = toWorkspaceRelativePath(context.workspacePath, target);
  if (relativePath.length > 0) {
    args.push("--", relativePath);
  }

  const result = await runner.run(args, {
    cwd: context.workspacePath,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(context.signal ? { signal: context.signal } : {}),
  });

  if (result.cancelled) {
    return emptyResult({ cancelled: true });
  }
  if (result.failedToStart) {
    throw new ToolExecutionError(
      "dependency_unavailable",
      "Git is not installed or not available on PATH; the git_status tool cannot be used.",
    );
  }
  if (result.timedOut) {
    throw new ToolExecutionError("timeout", "git status timed out.");
  }
  if (isNotARepository(result)) {
    return emptyResult({ message: "This workspace is not a Git repository." });
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.split(/\r?\n/, 1)[0] ?? "").trim();
    throw new ToolExecutionError(
      "internal_error",
      detail.length > 0 ? `git status failed: ${detail}` : "git status failed.",
    );
  }

  return parsePorcelainV2(result.stdout);
}

export function parsePorcelainV2(stdout: string): GitStatusResult {
  const files: GitFileStatus[] = [];
  let branch: string | null = null;
  let detached = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let truncated = false;

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      detached = head === "(detached)";
      branch = head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1] ?? 0);
        behind = Number(match[2] ?? 0);
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }

    if (files.length >= MAX_GIT_FILES) {
      truncated = true;
      continue;
    }

    const parsed = parseEntry(line);
    if (parsed) {
      files.push(parsed);
    }
  }

  return {
    repository: true,
    branch,
    detached,
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    clean: files.length === 0,
    files,
    total: files.length,
    ...(truncated ? { truncated: true as const, reason: "max_files" as const } : {}),
  };
}

function parseEntry(line: string): GitFileStatus | undefined {
  if (line.startsWith("? ")) {
    return { path: normalizeGitPath(line.slice(2)), status: "untracked", staged: false };
  }
  if (line.startsWith("! ")) {
    return { path: normalizeGitPath(line.slice(2)), status: "ignored", staged: false };
  }
  if (line.startsWith("u ")) {
    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    const fields = line.split(" ");
    const path = fields.slice(10).join(" ");
    return { path: normalizeGitPath(path), status: "conflicted", staged: false };
  }
  if (line.startsWith("1 ")) {
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    const fields = line.split(" ");
    const code = fields[1] ?? "..";
    const path = fields.slice(8).join(" ");
    return { path: normalizeGitPath(path), status: statusFromCode(code), staged: code[0] !== "." };
  }
  if (line.startsWith("2 ")) {
    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
    const fields = line.split(" ");
    const code = fields[1] ?? "..";
    const rest = fields.slice(9).join(" ");
    const [path, originalPath] = rest.split("\t");
    return {
      path: normalizeGitPath(path ?? ""),
      status: statusFromCode(code),
      staged: code[0] !== ".",
      ...(originalPath ? { originalPath: normalizeGitPath(originalPath) } : {}),
    };
  }
  return undefined;
}

function statusFromCode(code: string): GitFileStatusName {
  const index = code[0] ?? ".";
  const worktree = code[1] ?? ".";
  if (index === "U" || worktree === "U") {
    return "conflicted";
  }
  if (index === "R") {
    return "renamed";
  }
  if (index === "C") {
    return "copied";
  }
  if (index === "A") {
    return "added";
  }
  if (index === "D" || worktree === "D") {
    return "deleted";
  }
  return "modified";
}

function normalizeGitPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/** Shared by every git tool: a non-repository workspace is a structured result. */
export function isNotARepository(result: GitCommandResult): boolean {
  return result.exitCode !== 0 && /not a git repository/i.test(result.stderr);
}

function emptyResult(extra: Partial<GitStatusResult>): GitStatusResult {
  return {
    repository: false,
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
    total: 0,
    ...extra,
  };
}

function runGitProcess(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "", failedToStart: false, timedOut: false, cancelled: true });
      return;
    }

    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let failedToStart = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);

    const onAbort = () => {
      child.kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendCapped(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendCapped(stderr, String(chunk));
    });
    child.on("error", () => {
      failedToStart = true;
      finish(() => resolve({ exitCode: null, stdout, stderr, failedToStart: true, timedOut: false, cancelled: false }));
    });
    child.on("close", (code) => {
      finish(() =>
        resolve({
          exitCode: code,
          stdout,
          stderr,
          failedToStart,
          timedOut,
          cancelled: options.signal?.aborted === true && !timedOut,
        }),
      );
    });

    function finish(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    }
  });
}

function appendCapped(existing: string, next: string): string {
  const combined = existing + next;
  return combined.length <= MAX_GIT_OUTPUT_BYTES ? combined : combined.slice(0, MAX_GIT_OUTPUT_BYTES);
}
