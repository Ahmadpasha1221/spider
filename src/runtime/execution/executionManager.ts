import * as path from "node:path";
import {
  describeExecutionContext,
  resolveExecutionContext,
} from "./executionContext";
import {
  ExecutionContext,
  ExecutionEnvironment,
  ExecutionContextError,
} from "./executionTypes";

/**
 * The single authoritative place that resolves "where and in what environment
 * should this command execute?".
 *
 * No other component may guess the environment: `CommandRunner` executes,
 * `WorkspaceToolExecutor` routes, and individual tools never inspect the host.
 * The manager caches the resolved context per workspace and re-resolves when the
 * environment changes (`updateEnvironment`/`invalidate`).
 */
export interface ExecutionManagerLogger {
  info(message: string, context?: Record<string, unknown>): void;
}

export interface ExecutionManagerOptions {
  readonly environment: ExecutionEnvironment;
  readonly logger?: ExecutionManagerLogger;
}

/** A concrete process launch derived from an execution context. */
export interface SpawnInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell: boolean;
  /** `undefined` when the backend sets the working directory itself (WSL). */
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
}

export class ExecutionManager {
  private environment: ExecutionEnvironment;
  private readonly logger?: ExecutionManagerLogger;
  private readonly cache = new Map<string, ExecutionContext>();

  constructor(options: ExecutionManagerOptions) {
    this.environment = options.environment;
    this.logger = options.logger;
  }

  /** Current host facts (read-only copy). */
  getEnvironment(): ExecutionEnvironment {
    return this.environment;
  }

  /**
   * Replaces the host facts (workspace/remote/shell change) and drops every
   * cached context so the next resolution is fresh.
   */
  updateEnvironment(environment: ExecutionEnvironment): void {
    this.environment = environment;
    this.invalidate();
  }

  /** Drops cached contexts (workspace folder or remote authority changed). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Resolves (and caches) the execution context for one workspace. */
  resolve(workspacePath: string): ExecutionContext {
    const cached = this.cache.get(workspacePath);
    if (cached) {
      return cached;
    }
    const context = resolveExecutionContext(this.environment, workspacePath);
    this.cache.set(workspacePath, context);
    // Safe metadata only: never log the environment map or its values.
    this.logger?.info("Execution context resolved", {
      operation: "resolveExecutionContext",
      executionType: context.executionType,
      platform: context.platform,
      shell: context.shell,
      backend: context.backend,
      cwd: context.cwd,
      ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
      ...(context.remoteAuthority ? { remoteAuthority: context.remoteAuthority } : {}),
    });
    return context;
  }

  /**
   * Translates a validated absolute host path into the execution environment's
   * working directory. For local/remote hosts the path is already correct; for
   * a WSL-UNC workspace the workspace-relative portion is re-rooted on the Linux
   * side. This is a deliberate abstraction, not string replacement: the mapping
   * is anchored to the real workspace root.
   */
  resolveCwd(workspacePath: string, hostAbsolutePath: string): string {
    const context = this.resolve(workspacePath);
    if (context.backend !== "wsl") {
      return hostAbsolutePath;
    }
    const relative = path.win32.relative(path.win32.normalize(workspacePath), path.win32.normalize(hostAbsolutePath));
    if (relative.length === 0 || relative === ".") {
      return context.cwd;
    }
    if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
      throw new ExecutionContextError(
        `Path is outside the workspace execution environment: ${hostAbsolutePath}`,
      );
    }
    return posixJoin(context.cwd, relative.split(/[\\/]+/).filter((segment) => segment.length > 0));
  }

  /** Safe, secret-free summary for logs and the agent prompt. */
  describe(workspacePath: string): string | undefined {
    try {
      return describeExecutionContext(this.resolve(workspacePath));
    } catch {
      return undefined;
    }
  }
}

function posixJoin(root: string, segments: readonly string[]): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const suffix = segments.join("/");
  return suffix.length === 0 ? base : `${base}/${suffix}`;
}

/**
 * Builds the process launch for a resolved context. Argument arrays are used
 * everywhere; no untrusted value is concatenated into a nested shell string.
 * The model-supplied `command` is passed as a single argument to the shell's
 * `-c`/`-Command` flag, exactly as the previous `shell: true` behavior did.
 */
export function buildCommandInvocation(
  context: ExecutionContext,
  command: string,
  cwd: string,
): SpawnInvocation {
  if (context.backend === "wsl") {
    const distroArgs = context.wslDistro ? ["-d", context.wslDistro] : [];
    const posixShell = context.shell === "zsh" ? "zsh" : context.shell === "bash" ? "bash" : "sh";
    return {
      file: "wsl.exe",
      args: [...distroArgs, "--cd", cwd, "--", posixShell, "-lc", command],
      shell: false,
      cwd: undefined,
      env: context.env,
    };
  }

  if (context.platform === "windows") {
    if (context.shell === "powershell") {
      return {
        file: context.shellPath ?? "powershell.exe",
        args: ["-NoProfile", "-Command", command],
        shell: false,
        cwd,
        env: context.env,
      };
    }
    // cmd.exe: mirrors Node's own `shell: true` argument shape on Windows.
    return {
      file: context.shellPath ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
      shell: false,
      cwd,
      env: context.env,
    };
  }

  const posixShell =
    context.shellPath ?? (context.shell === "zsh" ? "zsh" : context.shell === "bash" ? "bash" : "sh");
  return {
    file: posixShell,
    args: ["-c", command],
    shell: false,
    cwd,
    env: context.env,
  };
}
