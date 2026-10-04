import { spawn } from "node:child_process";
import { ExecutionContextError, type ExecutionContext } from "../execution/executionTypes";
import { buildCommandInvocation } from "../execution/executionManager";

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

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;

export function runWorkspaceCommand(options: RunCommandOptions): Promise<CommandRunResult> {
  // Security invariant: context must be a valid ExecutionContext object.
  // We validate this at runtime in addition to the TypeScript type, because
  // callers can arrive through JavaScript, tests with cast types, or
  // configuration paths that bypass strict checking.
  if (!options.context || typeof options.context !== "object") {
    throw new ExecutionContextError(
      "Execution context is required before running commands. " +
      "A missing or invalid ExecutionContext is treated as a security failure — " +
      "Spider will not fall back to shell: true.",
    );
  }

  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve(cancelledResult(options.command, options.cwd));
      return;
    }

    const spawnFn = options.spawnFn ?? spawn;
    const child = spawnWithContext(spawnFn, options.context, options.command, options.cwd);

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
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout = appendCapped(stdout, text);
      options.onOutput?.("stdout", text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr = appendCapped(stderr, text);
      options.onOutput?.("stderr", text);
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({
          command: options.command,
          cwd: options.cwd,
          stdout,
          stderr,
          exitCode: timedOut || options.signal?.aborted ? null : code,
          cancelled: options.signal?.aborted === true && !timedOut,
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
      options.signal?.removeEventListener("abort", onAbort);
      action();
    }
  });
}

function spawnWithContext(
  spawnFn: typeof spawn,
  context: ExecutionContext,
  command: string,
  executionCwd: string,
): ReturnType<typeof spawn> {
  const invocation = buildCommandInvocation(context, command, executionCwd);
  return spawnFn(invocation.file, [...invocation.args], {
    ...(invocation.cwd !== undefined ? { cwd: invocation.cwd } : {}),
    env: invocation.env,
    shell: invocation.shell,
    windowsHide: true,
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
