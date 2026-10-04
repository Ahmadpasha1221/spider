import * as path from "node:path";
import {
  ExecutionContext,
  ExecutionContextError,
  ExecutionEnvironment,
  ExecutionPlatform,
  ExecutionShell,
  ExecutionType,
} from "./executionTypes";

/**
 * Pure execution-context resolution.
 *
 * Every function here is deterministic and side-effect free: given the
 * host facts captured from VS Code, it derives the environment a command must
 * run in. Nothing probes the shell (`wsl --list`, `which`, `find`, `pwd`).
 */

/** A WSL workspace reached from a Windows host through a UNC path. */
export interface WslUncPath {
  /** Distro name taken from the path, e.g. "Ubuntu". */
  readonly distro: string;
  /** The leading `\\wsl.localhost\Ubuntu` portion. */
  readonly hostRoot: string;
}

// `\\wsl.localhost\Ubuntu\...` (Windows 11+) or `\\wsl$\Ubuntu\...` (legacy).
const WSL_UNC_PATTERN = /^([\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+))(?:[\\/](.*))?$/i;

/** Detects a Windows UNC path that points into a WSL distro. */
export function matchWslUncPath(workspacePath: string): WslUncPath | undefined {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    return undefined;
  }
  const match = WSL_UNC_PATTERN.exec(workspacePath);
  if (!match) {
    return undefined;
  }
  const hostRoot = match[1] ?? "";
  const distro = match[2] ?? "";
  if (hostRoot.length === 0 || distro.length === 0) {
    return undefined;
  }
  return { distro, hostRoot };
}

/**
 * Translates a Windows WSL UNC path into its Linux representation.
 * `\\wsl.localhost\Ubuntu\home\user\proj` -> `/home/user/proj`.
 */
export function wslUncToLinuxPath(workspacePath: string): string {
  const match = WSL_UNC_PATTERN.exec(workspacePath);
  if (!match) {
    return workspacePath;
  }
  const rest = match[3];
  const segments = (rest ?? "").split(/[\\/]+/).filter((segment) => segment.length > 0);
  return `/${segments.join("/")}`;
}

/** Maps a `process.platform` value onto an execution platform. */
export function platformFromHost(hostPlatform: NodeJS.Platform): ExecutionPlatform {
  switch (hostPlatform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      throw new ExecutionContextError(
        `Unable to determine the workspace execution environment: unsupported host platform "${hostPlatform}".`,
      );
  }
}

/** Extracts the shell identity from a shell executable path. */
export function shellFromPath(shellPath: string | undefined): ExecutionShell | undefined {
  if (typeof shellPath !== "string" || shellPath.trim().length === 0) {
    return undefined;
  }
  const base = path.basename(shellPath.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
  switch (base) {
    case "pwsh":
    case "powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "sh":
    case "dash":
    case "ksh":
      return "sh";
    default:
      return undefined;
  }
}

/** The default shell for a platform when nothing authoritative is available. */
export function defaultShellForPlatform(platform: ExecutionPlatform): ExecutionShell {
  switch (platform) {
    case "windows":
      return "cmd";
    case "macos":
      return "zsh";
    case "linux":
    case "wsl":
      return "bash";
    default:
      return "sh";
  }
}

/**
 * Resolves the shell. For a locally executing host the integrated-terminal
 * shell is authoritative (`vscode.env.shell`). When bridging into WSL from a
 * Windows host (`backend === "wsl"`) the Windows shell is irrelevant and a
 * POSIX shell inside the distro is used instead.
 */
export function resolveShell(
  environment: ExecutionEnvironment,
  platform: ExecutionPlatform,
  backend: "local" | "wsl",
): { shell: ExecutionShell; shellPath?: string } {
  const configured = environment.configuredShell;
  if (configured) {
    return {
      shell: configured,
      ...(environment.terminalShellPath && shellFromPath(environment.terminalShellPath) === configured
        ? { shellPath: environment.terminalShellPath }
        : {}),
    };
  }

  if (backend === "local") {
    const fromTerminal = shellFromPath(environment.terminalShellPath);
    if (fromTerminal) {
      return { shell: fromTerminal, shellPath: environment.terminalShellPath };
    }
  }

  return { shell: defaultShellForPlatform(platform) };
}

/** Copies defined string environment values only (never leaks undefined). */
export function sanitizeEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!env) {
    return result;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolves the authoritative execution context for one workspace path.
 *
 * Precedence:
 * 1. VS Code connected through WSL (`remoteName === "wsl"`): the extension host
 *    already runs inside the distro, so commands execute locally there.
 * 2. Windows host whose workspace is a WSL UNC path: bridge through `wsl.exe`.
 * 3. Any other remote authority: execute in the remote extension host (local).
 * 4. Otherwise: local execution on the host platform.
 */
export function resolveExecutionContext(
  environment: ExecutionEnvironment,
  workspacePath: string,
): ExecutionContext {
  if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
    throw new ExecutionContextError(
      "Unable to determine the workspace execution environment: no workspace folder is open.",
    );
  }

  const env = sanitizeEnvironment(environment.env);
  const remoteName = environment.remoteName;

  if (remoteName && remoteName.toLowerCase() === "wsl") {
    const distro = environment.configuredWslDistro ?? env.WSL_DISTRO_NAME;
    const { shell, shellPath } = resolveShell(environment, "wsl", "local");
    return {
      executionType: "wsl",
      platform: "wsl",
      shell,
      backend: "local",
      cwd: workspacePath,
      ...(shellPath ? { shellPath } : {}),
      env,
      ...(distro ? { wslDistro: distro } : {}),
      remoteAuthority: remoteName,
    };
  }

  const wslUnc = matchWslUncPath(workspacePath);
  if (!remoteName && environment.hostPlatform === "win32" && wslUnc) {
    const distro = environment.configuredWslDistro ?? wslUnc.distro;
    const { shell } = resolveShell(environment, "wsl", "wsl");
    return {
      executionType: "wsl",
      platform: "wsl",
      shell,
      backend: "wsl",
      cwd: wslUncToLinuxPath(workspacePath),
      env,
      wslDistro: distro,
    };
  }

  const platform = platformFromHost(environment.hostPlatform);

  if (remoteName) {
    const { shell, shellPath } = resolveShell(environment, platform, "local");
    return {
      executionType: "remote",
      platform,
      shell,
      backend: "local",
      cwd: workspacePath,
      ...(shellPath ? { shellPath } : {}),
      env,
      remoteAuthority: remoteName,
    };
  }

  const { shell, shellPath } = resolveShell(environment, platform, "local");
  const executionType: ExecutionType = "local";
  return {
    executionType,
    platform,
    shell,
    backend: "local",
    cwd: workspacePath,
    ...(shellPath ? { shellPath } : {}),
    env,
  };
}

/** Human-readable, secret-free one-line summary of a resolved context. */
export function describeExecutionContext(context: ExecutionContext): string {
  const parts: string[] = [`type: ${context.executionType}`, `platform: ${context.platform}`, `shell: ${context.shell}`];
  if (context.wslDistro) {
    parts.push(`distro: ${context.wslDistro}`);
  }
  if (context.remoteAuthority) {
    parts.push(`remote: ${context.remoteAuthority}`);
  }
  parts.push(`cwd: ${context.cwd}`);
  return parts.join("; ");
}
