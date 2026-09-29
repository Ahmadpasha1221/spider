import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ToolExecutionError } from "./toolError";

/**
 * Lexical workspace boundary check. Model-supplied paths are never trusted:
 * every filesystem tool funnels through here (or `resolveWorkspacePathSafe`,
 * which additionally verifies symlinks) before touching the disk.
 */
export function resolveWorkspacePath(workspacePath: string, requestedPath = "."): string {
  const root = path.resolve(workspacePath);
  const cleaned = requestedPath.trim().replace(/^['"]|['"]$/g, "");
  const normalized = path.normalize(cleaned.length > 0 ? cleaned : ".");
  const target = path.isAbsolute(normalized) ? normalized : path.resolve(root, normalized);
  if (!isInsideWorkspace(root, target)) {
    throw new ToolExecutionError("workspace_violation", `Path is outside the workspace: ${requestedPath}`);
  }
  return target;
}

/**
 * Lexical check plus a symlink check: the target (or its closest existing
 * ancestor, for paths that do not exist yet) is resolved with `fs.realpath` and
 * must still live inside the real workspace root. This closes the
 * "symlink inside the workspace pointing outside it" escape without breaking
 * legitimate workspaces whose own root is reached through a link.
 *
 * If neither path can be resolved on disk the lexical decision stands: the
 * filesystem call itself will fail with a normal, mapped error.
 */
export async function resolveWorkspacePathSafe(workspacePath: string, requestedPath = "."): Promise<string> {
  const target = resolveWorkspacePath(workspacePath, requestedPath);
  const [rootReal, targetReal] = await Promise.all([
    realpathOfExisting(workspacePath),
    realpathOfExisting(target),
  ]);
  if (rootReal && targetReal && !isInsideWorkspace(rootReal, targetReal)) {
    throw new ToolExecutionError(
      "workspace_violation",
      `Path escapes the workspace through a link: ${requestedPath}`,
    );
  }
  return target;
}

export function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const root = path.resolve(workspacePath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Workspace-relative POSIX path (stable, model-facing, never absolute). */
export function toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(absolutePath));
  return relative.replaceAll("\\", "/");
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the real path of `target`, or of its closest existing ancestor when
 * `target` itself does not exist yet. Returns undefined when nothing on the
 * path can be resolved.
 */
async function realpathOfExisting(target: string): Promise<string | undefined> {
  let current = path.resolve(target);
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
  return undefined;
}
