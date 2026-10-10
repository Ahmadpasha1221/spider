import { spawn } from "node:child_process";
import { ExecutionContextError, type ExecutionContext } from "../execution/executionTypes";
import { buildCommandInvocation, buildArgvInvocation, type SpawnInvocation } from "../execution/executionManager";

export interface CommandRunResult {
  readonly command: string;
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

export interface RunCommandOptions {
  readonly command: string;
  /** Working directory *in the execution environment*. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Streamed output hook: fired per stdout/stderr chunk so the UI can show
   * progress while the command runs. The resolved result still carries the
   * complete (capped) output.
   */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Resolved execution context. REQUIRED.
   *
   * Every command execution must carry a validated ExecutionContext produced by
   * ExecutionManager.resolve(). This ensures that:
   *   - The command is launched through the correct backend (local / WSL / remote).
   *   - Process creation is always argv-only (shell: false), never a shell string.
   *   - No missing-context path can silently downgrade to shell: true.
   *
   * Security invariant: if context is absent, execution FAILS CLOSED with an
   * ExecutionContextError. A missing context is treated as a security failure,
   * not as a reason to use a legacy shell fallback.
   */
  readonly context: ExecutionContext;
  /** Injectable spawn (tests / alternative hosts). */
  readonly spawnFn?: typeof spawn;
}

export interface RunArgvCommandOptions {
  readonly executable: string;
  readonly args: readonly string[];
  /** Working directory *in the execution environment*. */
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  readonly context: ExecutionContext;
  readonly spawnFn?: typeof spawn;
  /**
   * Explicit execution environment overrides (e.g. sanitized environment for skill scripts).
   * When provided, this replaces the context's environment completely for defense-in-depth.
   */
  readonly env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;

export function runWorkspaceCommand(options: RunCommandOptions): Promise<CommandRunResult> {
  // Security invariant: context must be a valid ExecutionContext object.
  if (!options.context || typeof options.context !== "object") {
    throw new ExecutionContextError(
      "Execution context is required before running commands. " +
      "A missing or invalid ExecutionContext is treated as a security failure — " +
      "Spider will not fall back to shell: true.",
    );
  }

  const invocation = buildCommandInvocation(options.context, options.command, options.cwd);
  return executeSpawnedProcess(
    options.spawnFn ?? spawn,
    invocation,
    options.command,
    options.cwd,
    options.timeoutMs,
    options.signal,
    options.onOutput,
  );
}

/**
 * Executes an argv command directly (with shell: false and no shell interpretation).
 * Used by run_skill_script to prevent command injection through shell metacharacters.
 */
export function runWorkspaceArgvCommand(options: RunArgvCommandOptions): Promise<CommandRunResult> {
  // Security invariant: context must be a valid ExecutionContext object.
  if (!options.context || typeof options.context !== "object") {
    throw new ExecutionContextError(
      "Execution context is required before running argv commands. " +
      "A missing or invalid ExecutionContext is treated as a security failure — " +
      "Spider will not fall back to uncontrolled shell execution.",
    );
  }

  if (typeof options.executable !== "string" || options.executable.trim().length === 0) {
    throw new ExecutionContextError("Executable must be a non-empty string for argv command execution.");
  }

  if (options.executable.startsWith("-")) {
    throw new ExecutionContextError("Executable must not start with a hyphen flag.");
  }

  const effectiveContext = options.env
    ? { ...options.context, env: { ...options.env } }
    : options.context;

  const invocation = buildArgvInvocation(
    effectiveContext,
    options.executable,
    options.args,
    options.cwd,
  );

  const commandDisplay = `${options.executable}${options.args.length > 0 ? " " + options.args.join(" ") : ""}`;

  return executeSpawnedProcess(
    options.spawnFn ?? spawn,
    invocation,
    commandDisplay,
    options.cwd,
    options.timeoutMs,
    options.signal,
    options.onOutput,
  );
}

function executeSpawnedProcess(
  spawnFn: typeof spawn,
  invocation: SpawnInvocation,
  commandDisplay: string,
  cwdDisplay: string,
  timeoutMsInput?: number,
  signal?: AbortSignal,
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<CommandRunResult> {
  const timeoutMs = timeoutMsInput && timeoutMsInput > 0 ? timeoutMsInput : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(cancelledResult(commandDisplay, cwdDisplay));
      return;
    }

    const child = spawnFn(invocation.file, [...invocation.args], {
      ...(invocation.cwd !== undefined ? { cwd: invocation.cwd } : {}),
      env: invocation.env,
      shell: invocation.shell,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcess(child);
    }, timeoutMs);

    const onAbort = () => {
      killProcess(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout = appendCapped(stdout, text);
      onOutput?.("stdout", text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr = appendCapped(stderr, text);
      onOutput?.("stderr", text);
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({
          command: commandDisplay,
          cwd: cwdDisplay,
          stdout,
          stderr,
          exitCode: timedOut || signal?.aborted ? null : code,
          cancelled: signal?.aborted === true && !timedOut,
          timedOut,
        });
      });
    });

    function finish(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    }
  });
}

function cancelledResult(command: string, cwd: string): CommandRunResult {
  return {
    command,
    cwd,
    stdout: "",
    stderr: "",
    exitCode: null,
    cancelled: true,
    timedOut: false,
  };
}

function appendCapped(existing: string, next: string): string {
  const combined = existing + next;
  if (combined.length <= MAX_OUTPUT_BYTES) {
    return combined;
  }
  return combined.slice(0, MAX_OUTPUT_BYTES) + "\n...[output truncated]";
}

function killProcess(child: ReturnType<typeof spawn>): void {
  if (child.killed) {
    return;
  }
  child.kill();
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
  }
}
