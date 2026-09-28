import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Graft-style transcript persistence.
 *
 * Chat history is stored as one append-only JSONL file per session inside VS
 * Code's extension-scoped storage. Writes are cheap, incremental appends; reads
 * happen once, on demand, when a session is opened. Nothing is replayed to the
 * model, so restoring history costs zero tokens. A partial line (a crash mid-
 * append) is discarded on read instead of corrupting the whole transcript.
 */

export type TranscriptEntryKind = "user" | "assistant" | "thinking" | "tool" | "command" | "error" | "system";

export interface TranscriptEntry {
  /**
   * Stable message id. Present on entries the chat UI can act on (assistant
   * replies and user prompts) so Copy/Delete can target the exact persisted
   * entry. Older transcripts without ids load fine (id stays undefined).
   */
  readonly id?: string;
  readonly kind: TranscriptEntryKind;
  readonly text: string;
  readonly timestamp: number;
  readonly toolName?: string;
  readonly command?: string;
  readonly path?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly error?: string;
}

export class TranscriptStore {
  private readonly root: string;
  /** Serializes appends per session so entries land in event order. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(globalStorageUri: vscode.Uri) {
    this.root = path.join(globalStorageUri.fsPath, "transcripts");
  }

  append(sessionId: string, entry: TranscriptEntry): Promise<void> {
    if (!isValidSessionId(sessionId) || !isValidEntry(entry)) {
      return Promise.resolve();
    }
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await fs.mkdir(this.root, { recursive: true });
        await fs.appendFile(this.fileFor(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
      })
      .catch(() => {
        // A failed append must not break the queue for later entries.
      });
    this.queues.set(sessionId, next);
    return next;
  }

  async load(sessionId: string): Promise<TranscriptEntry[]> {
    if (!isValidSessionId(sessionId)) {
      return [];
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.fileFor(sessionId), "utf8");
    } catch {
      return [];
    }

    const entries: TranscriptEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = parseEntry(JSON.parse(line));
        if (parsed) {
          entries.push(parsed);
        }
      } catch {
        // Torn tail from a crash mid-append: keep the rest of the file.
      }
    }
    return entries;
  }

  async delete(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) {
      return;
    }
    try {
      await fs.unlink(this.fileFor(sessionId));
    } catch {
      // Already gone; deletion is best-effort.
    }
  }

  /**
   * Removes one entry by id (message Delete). The JSONL file is rewritten
   * without that entry, serialized behind the append queue so a concurrent
   * append can never be dropped. Unparseable lines (torn tail) are discarded,
   * matching `load()`.
   */
  removeEntry(sessionId: string, entryId: string): Promise<void> {
    if (!isValidSessionId(sessionId) || typeof entryId !== "string" || entryId.length === 0) {
      return Promise.resolve();
    }
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        let raw: string;
        try {
          raw = await fs.readFile(this.fileFor(sessionId), "utf8");
        } catch {
          return;
        }
        const kept: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.trim().length === 0) {
            continue;
          }
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line) as Record<string, unknown>;
          } catch {
            // Torn tail: drop it (load() would ignore it anyway).
            continue;
          }
          if (record && typeof record === "object" && record.id === entryId) {
            continue;
          }
          kept.push(line);
        }
        await fs.mkdir(this.root, { recursive: true });
        await fs.writeFile(this.fileFor(sessionId), kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
      })
      .catch(() => {
        // Deletion is best-effort; it must never break a run.
      });
    this.queues.set(sessionId, next);
    return next;
  }

  private fileFor(sessionId: string): string {
    return path.join(this.root, `${sessionId}.jsonl`);
  }
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "thinking",
  "tool",
  "command",
  "error",
  "system",
]);

function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) && sessionId.length <= 128;
}

function isValidEntry(entry: TranscriptEntry): boolean {
  return typeof entry.text === "string" && VALID_KINDS.has(entry.kind);
}

function parseEntry(value: unknown): TranscriptEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || typeof record.kind !== "string" || !VALID_KINDS.has(record.kind)) {
    return undefined;
  }
  return {
    ...(typeof record.id === "string" && record.id.length > 0 ? { id: record.id } : {}),
    kind: record.kind as TranscriptEntryKind,
    text: record.text,
    timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.stdout === "string" ? { stdout: record.stdout } : {}),
    ...(typeof record.stderr === "string" ? { stderr: record.stderr } : {}),
    ...(typeof record.exitCode === "number" || record.exitCode === null ? { exitCode: record.exitCode } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}
