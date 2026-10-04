/**
 * Execution environment types.
 *
 * The central principle of this module:
 *
 *   WORKSPACE LOCATION !== COMMAND EXECUTION ENVIRONMENT
 *
 * A VS Code workspace path alone never tells us how a command should run. The
 * host may be Windows, the workspace may live inside WSL, and VS Code may be
 * connected through a remote authority. `ExecutionContext` is the single
 * resolved answer to "where, in which environment, does this command run?".
 */

/** Where the command actually executes. */
export type ExecutionType = "local" | "wsl" | "remote";

/** The operating system semantics of the execution environment. */
export type ExecutionPlatform = "windows" | "linux" | "macos" | "wsl";

/** The shell used to interpret a `run_command` command string. */
export type ExecutionShell = "powershell" | "cmd" | "bash" | "sh" | "zsh";

/**
 * The mechanism used to reach the execution environment.
 * - `local`: spawn the process directly in the extension host environment.
 * - `wsl`: the extension host is on Windows but the workspace lives in a WSL
 *   distro, so commands are bridged through `wsl.exe`.
 *
 * Remote execution currently runs through `local`, because for a remote
 * (SSH/container/WSL) workspace the extension host process already executes
 * inside the remote environment. A future `remote` backend can be added without
 * touching `CommandRunner`.
 */
export type ExecutionBackendKind = "local" | "wsl";

/**
 * Authoritative, host-provided facts used to resolve an execution context.
 * Captured from VS Code (`vscode.env`, `process`) — never from shell probing.
 */
export interface ExecutionEnvironment {
  /** `process.platform` of the extension host. */
  readonly hostPlatform: NodeJS.Platform;
  /** `vscode.env.remoteName` (e.g. "wsl", "ssh-remote", "dev-container"). */
  readonly remoteName?: string;
  /** `vscode.env.shell`: the integrated-terminal default shell for this host. */
  readonly terminalShellPath?: string;
  /** Optional explicit user override for the shell. */
  readonly configuredShell?: ExecutionShell;
  /** Optional explicit user override for the WSL distro. */
  readonly configuredWslDistro?: string;
  /** Environment available to the extension host. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The resolved execution context for one workspace. */
export interface ExecutionContext {
  readonly executionType: ExecutionType;
  readonly platform: ExecutionPlatform;
  readonly shell: ExecutionShell;
  readonly backend: ExecutionBackendKind;
  /**
   * Absolute working directory *in the execution environment* (a Linux path for
   * WSL, a native Windows path for a local Windows workspace).
   */
  readonly cwd: string;
  /** Absolute shell executable to invoke, when one was authoritatively known. */
  readonly shellPath?: string;
  /** Environment variables for the executed process (host environment). */
  readonly env: Readonly<Record<string, string>>;
  /** WSL distro name when the workspace runs inside WSL. */
  readonly wslDistro?: string;
  /** Remote name/authority when VS Code is connected remotely. */
  readonly remoteAuthority?: string;
}

/**
 * Raised when no valid execution context can be resolved. The caller maps this
 * to a structured tool error so the agent never falls back to a random shell.
 */
export class ExecutionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionContextError";
  }
}
