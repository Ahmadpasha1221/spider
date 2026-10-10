/**
 * Git-backed workspace snapshots for checkpoints (Risk 1).
 *
 * Checkpoints primarily revert tracked file edits via `FileChangeReviewManager`.
 * This module adds a best-effort git layer:
 *
 * - before an agent run (or manual checkpoint), `createGitSnapshot` runs
 *   `git stash push -m "spider: <label>" --include-untracked` in the workspace.
 * - on restore, `restoreGitSnapshot` finds that stash by its unique message and
 *   runs `git stash apply` so tracked + untracked pre-run state can be
 *   re-applied even for files the review manager never saw.
 *
 * All operations are graceful:
 * - not a git repo, git missing, or "No local changes" -> `{ supported: false }`
 *   or `{ empty: true }`, never throws;
 * - restore of a missing/expired stash entry is a no-op that reports
 *   `{ applied: false }`.
 *
 * Shell side-effects are NOT revertible: `run_command`, background processes,
 * network calls, and anything outside the working tree cannot be undone by a
 * file revert or a stash apply. Callers must surface that limit to users.
 */

export interface GitSnapshotResult {
  readonly supported: boolean;
  /** True when git ran but there was nothing to stash. */
  readonly empty?: boolean;
  /** Unique stash message (`spider: ...`) used to locate the entry on restore. */
  readonly message?: string;
  /** Best-effort ref observed right after push (usually `stash@{0}`). */
  readonly ref?: string;
}

export interface GitRestoreResult {
  readonly applied: boolean;
  readonly reason?: string;
}

export type GitExecFn = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const STASH_LABEL_PREFIX = "spider: ";

export function stashMessageFor(label: string, checkpointId: string): string {
  const clean = label.replace(/\s+/g, " ").trim().slice(0, 60) || "Run";
  return `${STASH_LABEL_PREFIX}${clean} [${checkpointId}]`;
}

export async function createGitSnapshot(
  workspacePath: string,
  label: string,
  checkpointId: string,
  exec: GitExecFn = defaultGitExec,
): Promise<GitSnapshotResult> {
  const message = stashMessageFor(label, checkpointId);
  try {
    const repo = await exec("git", ["rev-parse", "--is-inside-work-tree"], workspacePath);
    if (repo.exitCode !== 0 || !repo.stdout.includes("true")) {
      return { supported: false };
    }
    const push = await exec("git", ["stash", "push", "-m", message, "--include-untracked"], workspacePath);
    const combined = `${push.stdout}\n${push.stderr}`.toLowerCase();
    if (push.exitCode !== 0) {
      if (combined.includes("not a git repository") || combined.includes("no git repository")) {
        return { supported: false };
      }
      if (combined.includes("no local changes")) {
        return { supported: true, empty: true, message };
      }
      return { supported: false };
    }
    if (combined.includes("no local changes")) {
      return { supported: true, empty: true, message };
    }
    // `stash push` cleans the tree; immediately re-apply so the agent starts
    // from the same dirty state while the stash entry remains as the snapshot.
    try {
      await exec("git", ["stash", "apply", "stash@{0}"], workspacePath);
    } catch {
      // Best-effort: the snapshot still exists even if re-apply failed.
    }
    return { supported: true, message, ref: "stash@{0}" };
  } catch {
    return { supported: false };
  }
}

export async function restoreGitSnapshot(
  workspacePath: string,
  message: string,
  exec: GitExecFn = defaultGitExec,
): Promise<GitRestoreResult> {
  if (!message || !message.startsWith(STASH_LABEL_PREFIX)) {
    return { applied: false, reason: "no-git-snapshot" };
  }
  try {
    const repo = await exec("git", ["rev-parse", "--is-inside-work-tree"], workspacePath);
    if (repo.exitCode !== 0) {
      return { applied: false, reason: "not-a-repo" };
    }
    const list = await exec("git", ["stash", "list", "--format=%gd:%gs"], workspacePath);
    if (list.exitCode !== 0) {
      return { applied: false, reason: "stash-list-failed" };
    }
    const ref = findStashRef(list.stdout, message);
    if (!ref) {
      return { applied: false, reason: "stash-not-found" };
    }
    const applied = await exec("git", ["stash", "apply", ref], workspacePath);
    if (applied.exitCode !== 0) {
      return { applied: false, reason: "stash-apply-failed" };
    }
    return { applied: true };
  } catch {
    return { applied: false, reason: "git-unavailable" };
  }
}

export function findStashRef(stashListOutput: string, message: string): string | undefined {
  for (const line of stashListOutput.split("\n")) {
    // Format: `stash@{0}: On main: spider: label [id]`
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const ref = line.slice(0, separator).trim();
    const subject = line.slice(separator + 1);
    if (/^stash@\{\d+\}$/.test(ref) && subject.includes(message)) {
      return ref;
    }
  }
  return undefined;
}

async function defaultGitExec(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd, timeout: 15000 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ stdout: "", stderr: "git not found", exitCode: 127 });
        return;
      }
      const exitCode = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error
          ? 1
          : 0;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), exitCode });
    });
  });
}
