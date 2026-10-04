import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "../execution/executionTypes";
import { buildArgvInvocation } from "../execution/executionManager";

/**
 * Managed background processes.
 *
 * Design goals:
 * - **argv, never a shell string.** `spawn(command, args, { shell: false })`
 *   means a command like `pnpm` + `["run", "dev"]` can never be concatenated
 *   with `&& rm -rf ...` by a model that only supplies argv entries.
 * - **The tool request and the process lifetime are separate.** Cancelling an
 *   agent run (or the startup wait) never kills a process that already
 *   started. Only `stop()` and `dispose()`/`shutdown()` end processes.
 * - **In memory only.** No PIDs are persisted, so a restarted extension never
 *   assumes a previous process exists and never kills an unrelated OS process.
 * - **Bounded output.** Each stream keeps a rolling tail plus a total counter;
 *   reads are capped again. Output can never grow without bound.
 *
 * Phase 3 tools (`get_command_output`, `kill_command`) can be layered directly
 * on `output()` / `stop()` / `list()` without changing this class.
 */
export type BackgroundProcessStatus = "starting" | "running" | "exited" | "failed" | "killed" | "cancelled";

export interface BackgroundProcessInfo {
  readonly processId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly startedAt: number;
  readonly status: BackgroundProcessStatus;
  readonly pid?: number;
  readonly exitCode?: number | null;
  /** Human-readable reason for a `failed` status. Never contains output. */
  readonly error?: string;
}

export interface BackgroundProcessOutput {
  readonly processId: string;
  readonly status: BackgroundProcessStatus;
  readonly stdout: string;
  readonly stderr: string;
  /** The returned (or retained) text is shorter than what the process wrote. */
  readonly truncated: boolean;
  /** Total characters the process has written, including dropped ones. */
  readonly stdoutTotal: number;
  readonly stderrTotal: number;
}

export interface BackgroundProcessStartRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly startupTimeoutMs?: number;
  /**
   * Tool-request signal only. Aborting stops *waiting* for startup; it never
   * terminates a process that already spawned.
   */
  readonly signal?: AbortSignal;
  /**
   * Resolved execution context. When present, the process is launched through
   * the context's backend (local shell environment or the WSL bridge) instead
   * of the extension host's default environment.
   */
  readonly context?: ExecutionContext;
}

export interface BackgroundProcessStartResult extends BackgroundProcessInfo {
  /** Bounded stdout, present only once the process is no longer running. */
  readonly stdout?: string;
  readonly stderr?: string;
  readonly outputTruncated?: true;
  /** The startup wait was cancelled; the process may still be running. */
  readonly cancelled?: true;
  readonly message?: string;
}

export interface BackgroundProcessManagerOptions {
  /** Injectable for tests and alternative hosts. */
  readonly spawnFn?: typeof spawn;
  readonly idFactory?: () => string;
  readonly now?: () => number;
  /** Rolling per-stream buffer size. */
  readonly maxBufferChars?: number;
  /** Default per-stream read cap for `output()`. */
  readonly maxReadChars?: number;
  readonly startupTimeoutMs?: number;
  readonly killGraceMs?: number;
  readonly immediateExitGraceMs?: number;
  readonly maxRetainedProcesses?: number;
}

export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const MIN_STARTUP_TIMEOUT_MS = 250;
export const MAX_STARTUP_TIMEOUT_MS = 60_000;
export const MAX_PROCESS_BUFFER_CHARS = 64_000;
export const MAX_PROCESS_READ_CHARS = 8_000;
export const MAX_STARTUP_OUTPUT_CHARS = 4_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;
export const IMMEDIATE_EXIT_GRACE_MS = 50;
export const MAX_RETAINED_PROCESSES = 50;

interface ManagedProcess {
  info: BackgroundProcessInfo;
  child?: ChildProcess;
  readonly stdout: BoundedBuffer;
  readonly stderr: BoundedBuffer;
  readonly closed: Promise<void>;
  readonly markClosed: () => void;
  closedSettled: boolean;
}

export class BackgroundProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly spawnFn: typeof spawn;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly maxBufferChars: number;
  private readonly maxReadChars: number;
  private readonly startupTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly immediateExitGraceMs: number;
  private readonly maxRetainedProcesses: number;

  constructor(options: BackgroundProcessManagerOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => Date.now());
    this.maxBufferChars = positive(options.maxBufferChars, MAX_PROCESS_BUFFER_CHARS);
    this.maxReadChars = positive(options.maxReadChars, MAX_PROCESS_READ_CHARS);
    this.startupTimeoutMs = clamp(
      positive(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
      MIN_STARTUP_TIMEOUT_MS,
      MAX_STARTUP_TIMEOUT_MS,
    );
    this.killGraceMs = positive(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.immediateExitGraceMs = Math.max(0, options.immediateExitGraceMs ?? IMMEDIATE_EXIT_GRACE_MS);
    this.maxRetainedProcesses = Math.max(1, options.maxRetainedProcesses ?? MAX_RETAINED_PROCESSES);
  }

  /**
   * Starts a process and returns as soon as it is confirmed running, it has
   * already exited, spawn failed, the startup timeout elapsed, or the request
   * was cancelled. The process lifetime is unlimited and independent.
   */
  async start(request: BackgroundProcessStartRequest): Promise<BackgroundProcessStartResult> {
    const processId = this.uniqueId();
    const args = [...(request.args ?? [])];
    const startedAt = this.now();
    const stdout = new BoundedBuffer(this.maxBufferChars);
    const stderr = new BoundedBuffer(this.maxBufferChars);

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const record: ManagedProcess = {
      info: { processId, command: request.command, args, cwd: request.cwd, startedAt, status: "starting" },
      stdout,
      stderr,
      closed,
      // Idempotent, and the single place `closedSettled` flips, so pruning and
      // every wait helper always agree that the child is gone.
      markClosed: () => {
        if (record.closedSettled) {
          return;
        }
        record.closedSettled = true;
        resolveClosed();
      },
      closedSettled: false,
    };
    this.remember(record);

    if (request.signal?.aborted) {
      this.setStatus(record, "cancelled");
      return this.toStartResult(record, { cancelled: true });
    }

    // The ExecutionManager decides WHERE the process runs. With a context the
    // launch is backend-aware (e.g. bridged into a WSL distro); the record still
    // reports the caller's command/args, so output identity is unchanged.
    const invocation = request.context
      ? buildArgvInvocation(request.context, request.command, args, request.cwd)
      : { file: request.command, args, cwd: request.cwd as string | undefined, env: undefined };

    let child: ChildProcess;
    try {
      child = this.spawnFn(invocation.file, [...invocation.args], {
        ...(invocation.cwd !== undefined ? { cwd: invocation.cwd } : {}),
        ...(invocation.env !== undefined ? { env: invocation.env } : {}),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      record.markClosed();
      this.setStatus(record, "failed", { error: errorMessage(error) });
      return this.toStartResult(record);
    }
    record.child = child;
    if (child.pid !== undefined) {
      record.info = { ...record.info, pid: child.pid };
    }

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    // Persistent error handler: the startup wait removes its own listeners once
    // it resolves, so a late child error (a stream error after spawn, for
    // example) would otherwise surface as an unhandled 'error' event.
    child.on("error", (error: Error) => {
      record.markClosed();
      if (!isTerminal(record.info.status)) {
        this.setStatus(record, "failed", { error: errorMessage(error) });
      }
    });
    child.once("close", (code) => this.settle(record, code ?? null));
    child.once("exit", (code) => {
      if (!record.closedSettled) {
        record.markClosed();
      }
      void code;
    });

    const timeoutMs = clamp(
      positive(request.startupTimeoutMs, this.startupTimeoutMs),
      MIN_STARTUP_TIMEOUT_MS,
      MAX_STARTUP_TIMEOUT_MS,
    );

    const event = await this.waitForStartup(child, timeoutMs, request.signal);
    switch (event.kind) {
      case "error":
        this.setStatus(record, "failed", { error: event.message });
        return this.toStartResult(record);
      case "exit":
        this.settle(record, event.code ?? null);
        return this.toStartResult(record);
      case "abort":
        return this.toStartResult(record, {
          cancelled: true,
          message: "Startup wait cancelled; the process was left running.",
        });
      case "spawn":
      case "timeout":
        break;
      default:
        break;
    }

    if (await this.waitForImmediateExit(record)) {
      return this.toStartResult(record);
    }
    this.setStatus(record, "running");
    return this.toStartResult(record);
  }

  get(processId: string): BackgroundProcessInfo | undefined {
    const record = this.processes.get(processId);
    return record ? { ...record.info } : undefined;
  }

  list(): BackgroundProcessInfo[] {
    return Array.from(this.processes.values(), (record) => ({ ...record.info }));
  }

  /**
   * Bounded recent output (a rolling tail, never the whole lifetime). callers
   * may cap by characters, bytes and/or lines; the effective character budget
   * is the smallest of the requested caps. `get_command_output` layers on this
   * without ever touching the process registry directly.
   */
  output(
    processId: string,
    options: { maxChars?: number; maxBytes?: number; maxLines?: number } = {},
  ): BackgroundProcessOutput | undefined {
    const record = this.processes.get(processId);
    if (!record) {
      return undefined;
    }
    const maxChars = positive(options.maxChars, this.maxReadChars);
    const maxBytes = positive(options.maxBytes, maxChars);
    const maxLines = options.maxLines === undefined ? undefined : Math.max(1, Math.floor(options.maxLines));
    return this.readOutput(record, Math.min(maxChars, maxBytes), maxLines);
  }

  /** True when this manager created the process with the given id. */
  has(processId: string): boolean {
    return this.processes.has(processId);
  }

  /**
   * Resolves once the process is no longer running (exited, failed, killed,
   * or cancelled), with the terminal info. Bounded by `timeoutMs` when given:
   * on timeout the process is terminated and `timedOut` is reported. Used by
   * `run_tests` to await completion without inventing a second process
   * registry — the manager stays the single lifecycle owner.
   */
  async whenClosed(
    processId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ info: BackgroundProcessInfo; timedOut: boolean } | undefined> {
    const record = this.processes.get(processId);
    if (!record) {
      return undefined;
    }
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
    const signal = options.signal;

    const waitForAbort = (): Promise<void> | undefined => {
      if (!signal) {
        return undefined;
      }
      if (signal.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };

    const waitForTimeout = (): Promise<void> | undefined => {
      if (!timeoutMs) {
        return undefined;
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
    };

    const abortPromise = waitForAbort();
    const timeoutPromise = waitForTimeout();

    const raced = await Promise.race([
      record.closed.then(() => "closed" as const),
      ...(abortPromise ? [abortPromise.then(() => "abort" as const)] : []),
      ...(timeoutPromise ? [timeoutPromise.then(() => "timeout" as const)] : []),
    ]);

    if (raced === "timeout" && !isTerminal(record.info.status)) {
      this.terminate(record, true);
      await this.waitForClose(record, this.killGraceMs);
    }
    if (raced === "abort" && !isTerminal(record.info.status)) {
      void this.stop(processId, { force: true });
    }

    // A terminal status is normally set by close/stop; the abort path races a
    // fire-and-forget stop, so settle the status explicitly if needed.
    if (!isTerminal(record.info.status)) {
      record.info = { ...record.info, status: raced === "timeout" ? "failed" : "killed" };
    }
    return { info: { ...record.info }, timedOut: raced === "timeout" };
  }

  /**
   * Terminates one managed process. Never touches a process Spider did not
   * start. Graceful by default, with a forced escalation after the grace
   * window; `{ force: true }` escalates immediately.
   */
  async stop(processId: string, options: { force?: boolean } = {}): Promise<BackgroundProcessInfo | undefined> {
    const record = this.processes.get(processId);
    if (!record) {
      return undefined;
    }
    if (isTerminal(record.info.status)) {
      return { ...record.info };
    }

    this.setStatus(record, "killed");
    this.terminate(record, options.force === true);

    if (options.force === true) {
      await this.waitForClose(record, this.killGraceMs);
    } else {
      void this.waitForClose(record, this.killGraceMs).then((closed) => {
        if (!closed) {
          this.terminate(record, true);
        }
      });
    }
    return { ...record.info };
  }

  /** Fire-and-forget cleanup for `context.subscriptions` / extension deactivate. */
  dispose(): void {
    void this.shutdown();
  }

  /** Graceful cleanup of every Spider-created process, then drop all state. */
  async shutdown(): Promise<void> {
    const ids = Array.from(this.processes.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
    this.processes.clear();
  }

  private async waitForStartup(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<StartupEvent> {
    return new Promise<StartupEvent>((resolve) => {
      let settled = false;
      const finish = (event: StartupEvent): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        resolve(event);
      };

      const onSpawn = (): void => finish({ kind: "spawn" });
      const onError = (error: Error): void => finish({ kind: "error", message: error.message });
      const onExit = (code: number | null): void => finish({ kind: "exit", code: code ?? null });
      const onAbort = (): void => finish({ kind: "abort" });

      const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        finish({ kind: "abort" });
      }
    });
  }

  /** True when the process died inside the immediate-exit grace window. */
  private async waitForImmediateExit(record: ManagedProcess): Promise<boolean> {
    if (record.closedSettled) {
      return true;
    }
    if (this.immediateExitGraceMs === 0) {
      return false;
    }
    const closed = await Promise.race([
      record.closed.then(() => true),
      delay(this.immediateExitGraceMs).then(() => false),
    ]);
    return closed;
  }

  private async waitForClose(record: ManagedProcess, timeoutMs: number): Promise<boolean> {
    if (record.closedSettled) {
      return true;
    }
    return Promise.race([
      record.closed.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
  }

  /** Records the child's exit, unless a terminal status was already set. */
  private settle(record: ManagedProcess, code: number | null): void {
    record.markClosed();
    if (record.info.status === "starting" || record.info.status === "running") {
      record.info = { ...record.info, status: code === 0 ? "exited" : "failed", exitCode: code };
    } else if (record.info.exitCode === undefined) {
      record.info = { ...record.info, exitCode: code };
    }
    this.prune();
  }

  private setStatus(
    record: ManagedProcess,
    status: BackgroundProcessStatus,
    extra: { error?: string } = {},
  ): void {
    record.info = { ...record.info, status, ...(extra.error ? { error: extra.error } : {}) };
    if (isTerminal(status)) {
      this.prune();
    }
  }

  private terminate(record: ManagedProcess, force: boolean): void {
    const child = record.child;
    if (!child || child.pid === undefined) {
      return;
    }
    if (process.platform === "win32") {
      try {
        this.spawnFn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        // Killing is best effort; dispose() is the backstop.
      }
      return;
    }
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // Killing is best effort.
    }
  }

  private toStartResult(
    record: ManagedProcess,
    extra: { cancelled?: true; message?: string } = {},
  ): BackgroundProcessStartResult {
    const base: BackgroundProcessStartResult = {
      ...record.info,
      ...(extra.cancelled ? { cancelled: true as const } : {}),
      ...(extra.message ? { message: extra.message } : {}),
    };
    if (record.info.status === "starting" || record.info.status === "running") {
      return base;
    }
    const out = this.readOutput(record, MAX_STARTUP_OUTPUT_CHARS);
    return {
      ...base,
      stdout: out.stdout,
      stderr: out.stderr,
      ...(out.truncated ? { outputTruncated: true as const } : {}),
    };
  }

  private readOutput(record: ManagedProcess, maxChars: number, maxLines?: number): BackgroundProcessOutput {
    const stdout = this.readStream(record.stdout, maxChars, maxLines);
    const stderr = this.readStream(record.stderr, maxChars, maxLines);
    return {
      processId: record.info.processId,
      status: record.info.status,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      stdoutTotal: record.stdout.total,
      stderrTotal: record.stderr.total,
    };
  }

  /** One stream: char/byte tail first, then an optional line tail. */
  private readStream(buffer: BoundedBuffer, maxChars: number, maxLines?: number): { text: string; truncated: boolean } {
    const read = buffer.read(maxChars);
    if (maxLines === undefined) {
      return read;
    }
    const lines = read.text.split("\n");
    if (lines.length <= maxLines) {
      return read;
    }
    // Keep the most recent lines; the dropped ones are reported as truncation.
    return { text: lines.slice(lines.length - maxLines).join("\n"), truncated: true };
  }

  private uniqueId(): string {
    const base = this.idFactory();
    if (!this.processes.has(base)) {
      return base;
    }
    let counter = 2;
    while (this.processes.has(`${base}-${counter}`)) {
      counter += 1;
    }
    return `${base}-${counter}`;
  }

  private remember(record: ManagedProcess): void {
    this.processes.set(record.info.processId, record);
    this.prune();
  }

  /** Keeps retained finished processes bounded so memory cannot grow forever. */
  private prune(): void {
    if (this.processes.size <= this.maxRetainedProcesses) {
      return;
    }
    for (const [id, record] of this.processes) {
      if (isTerminal(record.info.status) && record.closedSettled) {
        this.processes.delete(id);
        if (this.processes.size <= this.maxRetainedProcesses) {
          return;
        }
      }
    }
  }
}

interface StartupEvent {
  readonly kind: "spawn" | "error" | "exit" | "timeout" | "abort";
  readonly message?: string;
  readonly code?: number | null;
}

export function isTerminal(status: BackgroundProcessStatus): boolean {
  return status === "exited" || status === "failed" || status === "killed" || status === "cancelled";
}

/**
 * Rolling tail buffer: keeps at most `maxChars` and remembers how much was
 * dropped, so truncation is always reportable and memory is always bounded.
 */
class BoundedBuffer {
  private value = "";
  private dropped = 0;

  constructor(private readonly maxChars: number) {}

  push(chunk: string): void {
    this.value += chunk;
    if (this.value.length > this.maxChars) {
      const overflow = this.value.length - this.maxChars;
      this.dropped += overflow;
      this.value = this.value.slice(overflow);
    }
  }

  get total(): number {
    return this.dropped + this.value.length;
  }

  read(maxChars: number): { text: string; truncated: boolean } {
    const text = maxChars < this.value.length ? this.value.slice(-maxChars) : this.value;
    return { text, truncated: this.dropped > 0 || text.length < this.value.length };
  }
}

/**
 * The manager needs `closedSettled` for pruning; `ManagedProcess` now carries
 * it directly so the stored records always satisfy the interface.
 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
