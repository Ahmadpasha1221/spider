import { isTerminal, type BackgroundProcessManager, type BackgroundProcessStatus } from "./backgroundProcessManager";
import { ToolExecutionError } from "./toolError";

/**
 * `get_command_output` / `kill_command`: thin adapters over
 * `BackgroundProcessManager`. They own **no** process state, buffers, or
 * lifecycle logic — the manager stays the single source of truth, so these
 * tools cannot drift from `background_command`.
 *
 * `kill_command` can only ever affect a process Spider itself created: the id
 * is the manager's opaque handle, never an OS pid, and the manager refuses ids
 * it does not know. Cancelling an agent run therefore never kills background
 * processes; termination is explicit.
 */
export const OUTPUT_LIMITS = {
  defaultBytes: 16_000,
  maxBytes: 64_000,
  defaultLines: 200,
  maxLines: 2_000,
} as const;

export interface GetCommandOutputResult {
  readonly processId: string;
  readonly status: BackgroundProcessStatus;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly stdoutTotal: number;
  readonly stderrTotal: number;
}

export interface KillCommandResult {
  readonly processId: string;
  readonly status: BackgroundProcessStatus;
  readonly message?: string;
}

export function getCommandOutput(
  input: Record<string, unknown>,
  manager: BackgroundProcessManager,
): GetCommandOutputResult {
  const processId = requiredId(input, "processId");
  if (!manager.has(processId)) {
    throw new ToolExecutionError("not_found", `No background process with id "${processId}".`);
  }
  const maxBytes = clamp(input.maxBytes, OUTPUT_LIMITS.defaultBytes, OUTPUT_LIMITS.maxBytes);
  const maxLines = clamp(input.maxLines, OUTPUT_LIMITS.defaultLines, OUTPUT_LIMITS.maxLines);

  const output = manager.output(processId, { maxBytes, maxLines });
  if (!output) {
    // Raced with pruning: the process is gone.
    throw new ToolExecutionError("not_found", `No background process with id "${processId}".`);
  }
  return {
    processId,
    status: output.status,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated,
    stdoutTotal: output.stdoutTotal,
    stderrTotal: output.stderrTotal,
  };
}

export async function killCommand(
  input: Record<string, unknown>,
  manager: BackgroundProcessManager,
): Promise<KillCommandResult> {
  const processId = requiredId(input, "processId");
  const info = manager.get(processId);
  if (!info) {
    throw new ToolExecutionError("not_found", `No background process with id "${processId}".`);
  }
  if (isTerminal(info.status)) {
    return { processId, status: info.status, message: "The process has already exited." };
  }

  const force = input.force === true;
  const stopped = await manager.stop(processId, { force });
  const status = stopped?.status ?? "killed";
  return {
    processId,
    status,
    ...(force ? { message: "The process was force-terminated." } : {}),
  };
}

function requiredId(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_input", `Missing required argument: ${key}.`);
  }
  return value.trim();
}

function clamp(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}
