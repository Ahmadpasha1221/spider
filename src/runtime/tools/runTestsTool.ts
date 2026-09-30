import * as path from "node:path";
import { pathExists, resolveWorkspacePathSafe } from "./workspacePath";
import { ToolExecutionError } from "./toolError";
import {
  isTerminal,
  type BackgroundProcessInfo,
  type BackgroundProcessManager,
} from "./backgroundProcessManager";

/**
 * `run_tests`: bounded verification through the project's own test runner.
 *
 * Deliberately NOT a generic command tool (that is `run_command`, with its own
 * execute permission): the runner executable comes from a fixed allow-list, the
 * arguments are argv-only (`shell: false` — there is no shell to inject into),
 * and the process lifecycle is owned by the existing
 * `BackgroundProcessManager` via `whenClosed()`, so timeout/cancellation reuse
 * the Phase 2/3 kill machinery instead of a second registry.
 */
export const TEST_RUN_LIMITS = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 300_000,
  maxOutputChars: 32_000,
} as const;

/** Only these executables may ever be started by run_tests. */
export const APPROVED_TEST_RUNNERS: ReadonlySet<string> = new Set([
  "pnpm",
  "npm",
  "yarn",
  "pytest",
  "python",
  "python3",
  "cargo",
  "go",
]);

export interface RunTestsResult {
  readonly runner: string;
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled?: true;
  readonly truncated: boolean;
  readonly status: BackgroundProcessInfo["status"];
}

export interface RunTestsToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

export interface RunTestsToolDeps {
  readonly backgroundProcesses: BackgroundProcessManager;
}

export async function runTests(
  input: Record<string, unknown>,
  context: RunTestsToolContext,
  deps: RunTestsToolDeps,
): Promise<RunTestsResult> {
  const startedAt = Date.now();
  const runner = parseRunner(input.runner);
  const args = parseArgs(input.args);
  const cwd = await parseCwd(input.cwd, context.workspacePath);
  const timeoutMs = parseTimeout(input.timeoutMs);
  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const started = await deps.backgroundProcesses.start({
    command: runner,
    args,
    cwd,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const processId = started.processId;

  // run_tests is a foreground verification tool: unlike background_command,
  // the tool request waits for completion. Cancelling the run stops the test
  // process (nothing outlives its request here) via the manager's kill path.
  if (started.cancelled) {
    throw new ToolExecutionError("cancelled", "Test run was cancelled before it started.");
  }
  if (started.status === "failed" && started.exitCode === undefined && started.error) {
    throw new ToolExecutionError("dependency_unavailable", `Could not start ${runner}: ${started.error}`);
  }

  const wait = await deps.backgroundProcesses.whenClosed(processId, {
    timeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const info = wait?.info ?? deps.backgroundProcesses.get(processId) ?? started;
  const output = deps.backgroundProcesses.output(processId, { maxChars: TEST_RUN_LIMITS.maxOutputChars });

  const cancelled = context.signal?.aborted === true || isTerminal(info.status) === false;
  const timedOut = wait?.timedOut === true;
  const exitCode = info.exitCode ?? null;
  const { text: stdout, truncated: stdoutCapped } = capOutput(output?.stdout ?? "");
  const { text: stderr, truncated: stderrCapped } = capOutput(output?.stderr ?? "");

  return {
    runner,
    args,
    command: [runner, ...args].join(" "),
    cwd: toWorkspaceRelativeCwd(context.workspacePath, cwd),
    passed: !timedOut && !cancelled && exitCode === 0,
    exitCode,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
    timedOut,
    ...(cancelled ? { cancelled: true as const } : {}),
    truncated: (output?.truncated ?? false) || stdoutCapped || stderrCapped,
    status: info.status,
  };
}

export function parseRunner(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: runner.");
  }
  const runner = value.trim();
  const basename = path.win32.basename(path.posix.basename(runner)).toLowerCase();
  if (runner.includes("/") || runner.includes("\\") || runner.includes("..")) {
    throw new ToolExecutionError("invalid_input", "runner must be a bare executable name, not a path.");
  }
  if (!APPROVED_TEST_RUNNERS.has(basename)) {
    throw new ToolExecutionError(
      "invalid_input",
      `Unsupported test runner: ${runner}. Approved runners: ${[...APPROVED_TEST_RUNNERS].sort().join(", ")}.`,
    );
  }
  return runner;
}

export function parseArgs(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_input", "args must be an array of strings.");
  }
  if (value.length > 32) {
    throw new ToolExecutionError("invalid_input", "args accepts at most 32 entries.");
  }
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ToolExecutionError("invalid_input", "args must contain only strings.");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length > 200) {
      throw new ToolExecutionError("invalid_input", "each argument must be at most 200 characters.");
    }
    args.push(trimmed);
  }
  return args;
}

export async function parseCwd(value: unknown, workspacePath: string): Promise<string> {
  if (value === undefined || value === null || value === "" || value === ".") {
    return path.resolve(workspacePath);
  }
  if (typeof value !== "string") {
    throw new ToolExecutionError("invalid_input", "cwd must be a workspace-relative path.");
  }
  const resolved = await resolveWorkspacePathSafe(workspacePath, value);
  if (!(await pathExists(resolved))) {
    throw new ToolExecutionError("not_found", `cwd does not exist: ${value}`);
  }
  return resolved;
}

export function parseTimeout(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return TEST_RUN_LIMITS.defaultTimeoutMs;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_input", "timeoutMs must be a number.");
  }
  const floored = Math.floor(value);
  if (floored < 1_000) {
    throw new ToolExecutionError("invalid_input", "timeoutMs must be at least 1000.");
  }
  return Math.min(floored, TEST_RUN_LIMITS.maxTimeoutMs);
}

function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEST_RUN_LIMITS.maxOutputChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, TEST_RUN_LIMITS.maxOutputChars)}\n...[truncated]`, truncated: true };
}

function toWorkspaceRelativeCwd(workspacePath: string, cwd: string): string {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(cwd)).replaceAll("\\", "/");
  return relative.length === 0 ? "." : relative;
}
