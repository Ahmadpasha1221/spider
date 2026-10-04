import * as path from "node:path";
import { ExecutionContext, ExecutionContextError } from "./executionTypes";

/**
 * Translates a validated host workspace path into a path that is valid *inside
 * the execution environment*. This is deliberately an interface, not string
 * replacement: every implementation is anchored to the real workspace root, so
 * container/remote/FTP-style mappings can be added without touching the
 * ExecutionManager.
 */
export interface WorkspacePathTranslator {
  readonly backend: "local" | "wsl";
  /**
   * @param workspacePath  the workspace root as VS Code reports it on the host
   * @param hostAbsolutePath a validated absolute path under the workspace root
   * @param context the resolved execution context
   */
  toExecutionCwd(workspacePath: string, hostAbsolutePath: string, context: ExecutionContext): string;
}

/** The host and the execution environment share one path space. */
export const localPathTranslator: WorkspacePathTranslator = {
  backend: "local",
  toExecutionCwd(_workspacePath, hostAbsolutePath) {
    return hostAbsolutePath;
  },
};

/**
 * A Windows host reading a WSL workspace through a UNC path. The
 * workspace-relative portion is re-rooted on the Linux side; anything that
 * would escape the workspace is rejected rather than translated.
 */
export const wslUncPathTranslator: WorkspacePathTranslator = {
  backend: "wsl",
  toExecutionCwd(workspacePath, hostAbsolutePath, context) {
    const relative = path.win32.relative(path.win32.normalize(workspacePath), path.win32.normalize(hostAbsolutePath));
    if (relative.length === 0 || relative === ".") {
      return context.cwd;
    }
    if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
      throw new ExecutionContextError(
        `Path is outside the workspace execution environment: ${hostAbsolutePath}`,
      );
    }
    const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
    return posixJoin(context.cwd, segments);
  },
};

/** Selects the translator for a resolved context. */
export function translatorFor(context: ExecutionContext): WorkspacePathTranslator {
  return context.backend === "wsl" ? wslUncPathTranslator : localPathTranslator;
}

function posixJoin(root: string, segments: readonly string[]): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  const suffix = segments.join("/");
  return suffix.length === 0 ? base : `${base}/${suffix}`;
}
