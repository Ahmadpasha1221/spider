/**
 * Workspace checkpoints (A2).
 *
 * A checkpoint is a marker in the per-session file-change timeline, not a copy
 * of the workspace: `changeCount` records how many recorded changes existed
 * when the run started. Restoring a checkpoint reverts every recorded change
 * applied after it (using the before/after snapshots the review manager already
 * keeps), then drops the later checkpoints. This gives the user a "roll the
 * workspace back to before the agent ran" guarantee without a git dependency,
 * so it works for arbitrary folders — including workspaces with no repository.
 *
 * The manager is pure (no `vscode`, no filesystem): the runtime orchestrates
 * the actual reverts, so the timeline rules are unit-testable.
 */

export interface WorkspaceCheckpoint {
  readonly id: string;
  readonly sessionId: string;
  /** Human label (usually the prompt that started the run). */
  readonly label: string;
  readonly timestamp: number;
  /** Recorded changes that existed when the checkpoint was created. */
  readonly changeCount: number;
}

/** Wire-safe projection of a checkpoint (no internal-only fields). */
export interface CheckpointSummary {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly changeCount: number;
}

export function toCheckpointSummary(checkpoint: WorkspaceCheckpoint): CheckpointSummary {
  return {
    id: checkpoint.id,
    label: checkpoint.label,
    timestamp: checkpoint.timestamp,
    changeCount: checkpoint.changeCount,
  };
}

export class CheckpointManager {
  private readonly bySession = new Map<string, WorkspaceCheckpoint[]>();
  private readonly index = new Map<string, WorkspaceCheckpoint>();

  create(sessionId: string, label: string, changeCount: number): WorkspaceCheckpoint {
    const checkpoint: WorkspaceCheckpoint = {
      id: crypto.randomUUID(),
      sessionId,
      label: normalizeLabel(label),
      timestamp: Date.now(),
      changeCount,
    };
    const list = this.bySession.get(sessionId) ?? [];
    list.push(checkpoint);
    this.bySession.set(sessionId, list);
    this.index.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  /** Oldest first — the order the runs happened in. */
  list(sessionId: string): WorkspaceCheckpoint[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  get(checkpointId: string): WorkspaceCheckpoint | undefined {
    return this.index.get(checkpointId);
  }

  /**
   * Drops the checkpoint and every later one for its session, returning what
   * was removed (so a restore can report what it consumed).
   */
  truncateFrom(checkpointId: string): WorkspaceCheckpoint[] {
    const checkpoint = this.index.get(checkpointId);
    if (!checkpoint) {
      return [];
    }
    const list = this.bySession.get(checkpoint.sessionId) ?? [];
    const index = list.findIndex((candidate) => candidate.id === checkpointId);
    if (index < 0) {
      return [];
    }
    const removed = list.splice(index);
    for (const entry of removed) {
      this.index.delete(entry.id);
    }
    return removed;
  }

  clearSession(sessionId: string): void {
    for (const checkpoint of this.bySession.get(sessionId) ?? []) {
      this.index.delete(checkpoint.id);
    }
    this.bySession.delete(sessionId);
  }
}

function normalizeLabel(label: string): string {
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) {
    return "Run";
  }
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}
