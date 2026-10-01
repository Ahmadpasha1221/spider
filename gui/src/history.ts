import { onHostMessage, postToHost } from "./bridge";
import type { SessionListItem } from "./protocol";

/**
 * History editor tab client.
 *
 * Read-only over host-authoritative state: it renders the conversation list,
 * asks the host to switch the active conversation (which loads the transcript
 * in the sidebar Agent view), previews that transcript here, and can delete a
 * conversation. Deletion is durable on the host — the row disappears only
 * because the host re-broadcasts the list without it.
 */

type TranscriptEntry = {
  id?: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "command" | "error" | "system";
  text: string;
  timestamp: number;
  toolName?: string;
  command?: string;
  path?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: string;
};

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "DISCONNECTED"]);
/** Per-entry cap so a pathological transcript cannot build a huge DOM. */
const MAX_ENTRY_CHARS = 2000;

const listRoot = mustEl("history-list");
const emptyState = mustEl("history-empty");
const previewBody = mustEl("history-preview-body");
const previewEmpty = mustEl("history-preview-empty");

let activeSessionId: string | undefined;
/** Conversation whose transcript is shown in the preview pane. */
let previewSessionId: string | undefined;
const statusBySession = new Map<string, string>();

function render(sessions: readonly SessionListItem[]): void {
  const sorted = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  // The previewed conversation may have been deleted (here or elsewhere).
  if (previewSessionId && !sorted.some((session) => session.sessionId === previewSessionId)) {
    previewSessionId = undefined;
    renderPreview(undefined, []);
  }

  const rows = sorted.map(renderRow);
  listRoot.replaceChildren(...rows);
  emptyState.hidden = rows.length > 0;
}

function renderRow(session: SessionListItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "history-row";
  row.setAttribute("role", "listitem");
  row.dataset.sessionId = session.sessionId;
  row.classList.toggle("is-active", session.sessionId === activeSessionId);
  row.classList.toggle("is-previewing", session.sessionId === previewSessionId);

  const main = document.createElement("button");
  main.type = "button";
  main.className = "history-row-main";
  main.setAttribute("aria-label", `Open conversation: ${session.currentTask ?? session.sessionId}`);

  const title = document.createElement("span");
  title.className = "history-row-title";
  title.textContent = session.currentTask?.trim() || "Untitled conversation";

  const meta = document.createElement("span");
  meta.className = "history-row-meta";
  const workspace = basename(session.workspacePath);
  const updated = formatUpdated(session.updatedAt);
  meta.textContent = [workspace, updated].filter(Boolean).join(" · ");

  const status = document.createElement("span");
  status.className = "history-row-status";
  status.dataset.status = session.status;
  status.textContent = session.status.toLowerCase();

  main.append(title, meta, status);
  main.addEventListener("click", () => openConversation(session.sessionId));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "history-row-delete";
  remove.textContent = "Delete";
  remove.title = "Delete this conversation and its transcript";
  remove.setAttribute("aria-label", `Delete conversation: ${session.currentTask ?? session.sessionId}`);
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteConversation(session.sessionId);
  });

  row.append(main, remove);
  return row;
}

/** Open in the sidebar and preview here (one click does both). */
function openConversation(sessionId: string): void {
  previewSessionId = sessionId;
  postToHost({ type: "SELECT_SESSION", sessionId });
  requestTranscript(sessionId);
  markPreviewedRow();
}

function deleteConversation(sessionId: string): void {
  if (previewSessionId === sessionId) {
    previewSessionId = undefined;
    renderPreview(undefined, []);
  }
  postToHost({ type: "DELETE_SESSION", sessionId });
}

function requestTranscript(sessionId: string): void {
  renderPreview(sessionId, []);
  postToHost({ type: "GET_TRANSCRIPT", sessionId });
}

function renderPreview(sessionId: string | undefined, entries: readonly TranscriptEntry[]): void {
  const showEmpty = sessionId === undefined || entries.length === 0;
  previewEmpty.hidden = !showEmpty;
  previewEmpty.textContent = sessionId === undefined
    ? "Select a conversation to preview it."
    : "This conversation has no messages yet.";
  previewBody.replaceChildren(...(showEmpty ? [] : entries.map(renderEntry)));
}

function renderEntry(entry: TranscriptEntry): HTMLElement {
  const el = document.createElement("div");
  el.className = `preview-entry preview-${entry.kind}`;

  const label = document.createElement("span");
  label.className = "preview-entry-label";
  label.textContent = entryLabel(entry);
  el.appendChild(label);

  const body = document.createElement("span");
  body.className = "preview-entry-text";
  body.textContent = truncate(entryText(entry));
  el.appendChild(body);
  return el;
}

function entryLabel(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user":
      return "You";
    case "assistant":
      return "Spider";
    case "thinking":
      return "Thinking";
    case "tool":
      return entry.toolName ?? "Tool";
    case "command":
      return "Command";
    case "error":
      return "Error";
    default:
      return "System";
  }
}

function entryText(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "command": {
      const output = [entry.stdout, entry.stderr].filter((part) => Boolean(part?.trim())).join("\n");
      const exit = entry.exitCode === undefined || entry.exitCode === null ? "" : ` (exit ${entry.exitCode})`;
      return `${entry.command ?? ""}${exit}${output ? `\n${output}` : ""}`;
    }
    case "tool": {
      const target = entry.path ? ` ${entry.path}` : "";
      return entry.error ? `${entry.error}` : `${entry.text || `Used ${entry.toolName ?? "tool"}`}${target}`;
    }
    default:
      return entry.text;
  }
}

function truncate(text: string): string {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…` : text;
}

function markPreviewedRow(): void {
  for (const row of Array.from(listRoot.querySelectorAll<HTMLElement>(".history-row"))) {
    row.classList.toggle("is-previewing", row.dataset.sessionId === previewSessionId);
  }
}

function basename(fsPath: string): string {
  const parts = fsPath.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? fsPath;
}

function formatUpdated(updatedAt: number | undefined): string {
  if (updatedAt === undefined) {
    return "";
  }
  const diffMs = Date.now() - updatedAt;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(updatedAt).toLocaleDateString();
}

onHostMessage((message) => {
  switch (message.type) {
    case "SESSION_UPDATED": {
      const previous = new Map(statusBySession);
      statusBySession.clear();
      for (const session of message.sessions) {
        statusBySession.set(session.sessionId, session.status);
      }
      // A run that just finished changed the transcript: refresh the preview.
      // (Streaming updates are ignored — the sidebar already shows those live.)
      if (previewSessionId) {
        const before = previous.get(previewSessionId);
        const now = statusBySession.get(previewSessionId);
        if (now && before && before !== now && TERMINAL_STATUSES.has(now)) {
          postToHost({ type: "GET_TRANSCRIPT", sessionId: previewSessionId });
        }
      }
      activeSessionId = message.activeSessionId;
      render(message.sessions);
      break;
    }
    case "TRANSCRIPT":
      if (message.sessionId === previewSessionId) {
        renderPreview(message.sessionId, message.entries);
      }
      break;
    default:
      break;
  }
});

postToHost({ type: "LIST_SESSIONS" });

function mustEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}
