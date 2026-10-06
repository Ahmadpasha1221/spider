import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeLineDiff, diffStats } from "./lineDiff";
import type { FileChangeSummary } from "../runtimeTypes";

export interface ChangeSnapshot {
  readonly changeId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: "write_file" | "edit_file";
  readonly path: string;
  readonly beforeExists: boolean;
  readonly beforeContent?: string;
  readonly afterContent: string;
  readonly status: "APPLIED" | "REVERTED" | "MISSING";
}

export interface CapturedFileChange {
  readonly changeId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: "write_file" | "edit_file";
  readonly path: string;
  readonly beforeExists: boolean;
  readonly beforeContent?: string;
  readonly afterContent: string;
}

interface StoredFileChange extends CapturedFileChange {
  readonly status: "APPLIED" | "REVERTED" | "MISSING";
  readonly additions: number;
  readonly deletions: number;
  readonly appliedAt: number;
}

const MAX_CHANGES_PER_SESSION = 100;
const MAX_REVERT_BYTES = 2_000_000;

/**
 * Records every workspace mutation made through write_file / edit_file so the
 * user can inspect the diff and revert it with one click.
 */
export class FileChangeReviewManager {
  private readonly changes = new Map<string, StoredFileChange[]>();
  private readonly pendingBefore = new Map<string, { sessionId: string; toolCallId: string; toolName: "write_file" | "edit_file"; absolutePath: string; before: { exists: boolean; content?: string } }>();

  /**
   * Phase 1: snapshot the file BEFORE the tool mutates it. The snapshot is
   * keyed by tool call id and consumed by endCapture after execution.
   */
  async beginCapture(
    sessionId: string,
    toolCallId: string,
    toolName: "write_file" | "edit_file",
    absolutePath: string,
  ): Promise<void> {
    const before = await readIfExists(absolutePath);
    this.pendingBefore.set(toolCallId, { sessionId, toolCallId, toolName, absolutePath, before });
  }

  /** Phase 2: record the change with the after content once the tool succeeded. */
  async endCapture(toolCallId: string, afterContent: string): Promise<CapturedFileChange | undefined> {
    const pending = this.pendingBefore.get(toolCallId);
    this.pendingBefore.delete(toolCallId);
    if (!pending) {
      return undefined;
    }
    const change: CapturedFileChange = {
      changeId: crypto.randomUUID(),
      sessionId: pending.sessionId,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      path: pending.absolutePath,
      beforeExists: pending.before.exists,
      ...(pending.before.exists ? { beforeContent: pending.before.content } : {}),
      afterContent,
    };
    this.record(change);
    return change;
  }

  async capture(
    sessionId: string,
    toolCallId: string,
    toolName: "write_file" | "edit_file",
    absolutePath: string,
    afterContent: string,
  ): Promise<CapturedFileChange> {
    await this.beginCapture(sessionId, toolCallId, toolName, absolutePath);
    const captured = await this.endCapture(toolCallId, afterContent);
    if (!captured) {
      throw new Error("File change capture failed.");
    }
    return captured;
  }

  record(change: CapturedFileChange): void {
    const list = this.changes.get(change.sessionId) ?? [];
    list.push(this.toStored(change));
    if (list.length > MAX_CHANGES_PER_SESSION) {
      list.shift();
    }
    this.changes.set(change.sessionId, list);
  }

  listChanges(sessionId: string): FileChangeSummary[] {
    return (this.changes.get(sessionId) ?? []).map((change) => this.toSummary(change));
  }

  getChange(changeId: string): FileChangeSummary | undefined {
    for (const list of this.changes.values()) {
      const found = list.find((change) => change.changeId === changeId);
      if (found) {
        return this.toSummary(found);
      }
    }
    return undefined;
  }

  /**
   * Raw before/after snapshot for a change (A4). The interactive diff review
   * needs the original bytes to compute per-hunk reverts against the live
   * document; the summary only carries display data.
   */
  getSnapshot(changeId: string): ChangeSnapshot | undefined {
    const stored = this.findStored(changeId);
    if (!stored) {
      return undefined;
    }
    return {
      changeId: stored.changeId,
      sessionId: stored.sessionId,
      toolCallId: stored.toolCallId,
      toolName: stored.toolName,
      path: stored.path,
      beforeExists: stored.beforeExists,
      ...(stored.beforeContent !== undefined ? { beforeContent: stored.beforeContent } : {}),
      afterContent: stored.afterContent,
      status: stored.status,
    };
  }

  clearSession(sessionId: string): void {
    this.changes.delete(sessionId);
  }

  /**
   * Restores the file to its pre-change content. A file created by the agent is
   * deleted again; an edited file is rewritten with its original bytes.
   */
  async revert(changeId: string, _workspacePath: string): Promise<FileChangeSummary> {
    const stored = this.findStored(changeId);
    if (!stored) {
      throw new Error(`Unknown file change: ${changeId}`);
    }
    if (stored.status === "REVERTED") {
      return this.toSummary(stored);
    }

    if (!stored.beforeExists) {
      if (await pathExists(stored.path)) {
        await fs.unlink(stored.path);
      }
    } else {
      const current = await readIfExists(stored.path);
      if (current.exists && current.content !== stored.beforeContent) {
        await fs.writeFile(stored.path, stored.beforeContent ?? "", "utf8");
      }
    }

    const reverted: StoredFileChange = { ...stored, status: "REVERTED" };
    this.replaceStored(reverted);
    return this.toSummary(reverted);
  }

  private findStored(changeId: string): StoredFileChange | undefined {
    for (const list of this.changes.values()) {
      const found = list.find((change) => change.changeId === changeId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private replaceStored(updated: StoredFileChange): void {
    const list = this.changes.get(updated.sessionId);
    if (!list) {
      return;
    }
    const index = list.findIndex((change) => change.changeId === updated.changeId);
    if (index >= 0) {
      list[index] = updated;
    }
  }

  private toStored(change: CapturedFileChange): StoredFileChange {
    const diff = computeLineDiff(change.beforeContent ?? "", change.afterContent);
    const stats = diffStats(diff);
    return {
      ...change,
      status: "APPLIED",
      additions: stats.additions,
      deletions: stats.deletions,
      appliedAt: Date.now(),
    };
  }

  private toSummary(change: StoredFileChange): FileChangeSummary {
    return {
      changeId: change.changeId,
      sessionId: change.sessionId,
      toolCallId: change.toolCallId,
      toolName: change.toolName,
      path: toWorkspaceRelative(change.path),
      status: change.status,
      beforeExists: change.beforeExists,
      afterExists: true,
      additions: change.additions,
      deletions: change.deletions,
      hunks: computeLineDiff(change.beforeContent ?? "", change.afterContent).map((hunk) => ({
        header: hunk.header,
        lines: hunk.lines.map((line) => ({ ...line })),
      })),
      appliedAt: change.appliedAt,
    };
  }
}

async function readIfExists(absolutePath: string): Promise<{ exists: boolean; content?: string }> {
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return { exists: true, content };
  } catch (error) {
    if (isMissingEntryError(error)) {
      return { exists: false };
    }
    // Binary or unreadable files: treat as created-new so Reject deletes them.
    return { exists: false };
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}

function toWorkspaceRelative(absolutePath: string): string {
  return absolutePath.replaceAll("\\", "/");
}

export function assertRevertSize(beforeContent: string | undefined): void {
  if (beforeContent !== undefined && beforeContent.length > MAX_REVERT_BYTES) {
    throw new Error("File too large to revert automatically.");
  }
}

export function joinWorkspacePath(workspacePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(workspacePath, relativePath);
}
