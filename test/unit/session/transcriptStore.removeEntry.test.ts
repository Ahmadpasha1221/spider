import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { TranscriptStore } from "../../../src/session/transcriptStore";

function toGlobalStorageUri(root: string): vscode.Uri {
  return { fsPath: root } as unknown as vscode.Uri;
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codevia-transcript-"));
}

describe("TranscriptStore.removeEntry", () => {
  it("removes only the targeted entry and keeps the rest in order", async () => {
    const root = await tempRoot();
    const store = new TranscriptStore(toGlobalStorageUri(root));

    await store.append("session-1", { id: "m1", kind: "user", text: "hello", timestamp: 1 });
    await store.append("session-1", { id: "m2", kind: "assistant", text: "hi there", timestamp: 2 });
    await store.append("session-1", { id: "m3", kind: "user", text: "again", timestamp: 3 });

    await store.removeEntry("session-1", "m2");

    const entries = await store.load("session-1");
    expect(entries.map((entry) => entry.text)).toEqual(["hello", "again"]);
    expect(entries.every((entry) => entry.id !== "m2")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not resurrect a deleted message after a fresh store reads the file", async () => {
    const root = await tempRoot();
    const store = new TranscriptStore(toGlobalStorageUri(root));
    await store.append("session-1", { id: "keep", kind: "user", text: "keep me", timestamp: 1 });
    await store.append("session-1", { id: "drop", kind: "assistant", text: "delete me", timestamp: 2 });

    await store.removeEntry("session-1", "drop");

    // Simulates an extension reload: a brand-new store instance reads the file.
    const restarted = new TranscriptStore(toGlobalStorageUri(root));
    const entries = await restarted.load("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "keep", text: "keep me" });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is a no-op for unknown ids, empty ids, and unknown sessions", async () => {
    const root = await tempRoot();
    const store = new TranscriptStore(toGlobalStorageUri(root));
    await store.append("session-1", { id: "m1", kind: "user", text: "one", timestamp: 1 });

    await store.removeEntry("session-1", "missing");
    await store.removeEntry("session-1", "");
    await store.removeEntry("unknown-session", "m1");

    expect(await store.load("session-1")).toHaveLength(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("round-trips ids so restored messages keep a stable identity", async () => {
    const root = await tempRoot();
    const store = new TranscriptStore(toGlobalStorageUri(root));
    await store.append("session-1", { id: "assistant-42", kind: "assistant", text: "done", timestamp: 5 });

    const entries = await store.load("session-1");
    expect(entries[0]?.id).toBe("assistant-42");
    await fs.rm(root, { recursive: true, force: true });
  });
});
