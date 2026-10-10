import { describe, expect, it, vi } from "vitest";
import { CheckpointManager } from "../../../../src/runtime/checkpoints/checkpointManager";
import { createGitSnapshot, findStashRef, restoreGitSnapshot, stashMessageFor } from "../../../../src/runtime/checkpoints/gitCheckpoint";

describe("CheckpointManager (A2)", () => {
  it("creates checkpoints in order with the recorded change boundary", () => {
    const manager = new CheckpointManager();
    const first = manager.create("s1", "first run", 0);
    const second = manager.create("s1", "second run", 3);
    expect(first.changeCount).toBe(0);
    expect(second.changeCount).toBe(3);
    expect(manager.list("s1").map((cp) => cp.id)).toEqual([first.id, second.id]);
    expect(manager.get(second.id)?.label).toBe("second run");
  });

  it("keeps sessions independent", () => {
    const manager = new CheckpointManager();
    manager.create("s1", "a", 0);
    manager.create("s2", "b", 0);
    expect(manager.list("s1")).toHaveLength(1);
    expect(manager.list("s2")).toHaveLength(1);
    expect(manager.list("missing")).toEqual([]);
  });

  it("truncates the checkpoint and every later one", () => {
    const manager = new CheckpointManager();
    const first = manager.create("s1", "one", 0);
    const second = manager.create("s1", "two", 1);
    const third = manager.create("s1", "three", 2);
    const removed = manager.truncateFrom(second.id);
    expect(removed.map((cp) => cp.id)).toEqual([second.id, third.id]);
    expect(manager.list("s1").map((cp) => cp.id)).toEqual([first.id]);
    // A removed checkpoint is no longer resolvable.
    expect(manager.get(third.id)).toBeUndefined();
  });

  it("truncating an unknown checkpoint is a no-op", () => {
    const manager = new CheckpointManager();
    manager.create("s1", "one", 0);
    expect(manager.truncateFrom("nope")).toEqual([]);
    expect(manager.list("s1")).toHaveLength(1);
  });

  it("clears a session timeline", () => {
    const manager = new CheckpointManager();
    const first = manager.create("s1", "one", 0);
    manager.clearSession("s1");
    expect(manager.list("s1")).toEqual([]);
    expect(manager.get(first.id)).toBeUndefined();
  });

  it("normalizes labels and falls back to a default", () => {
    const manager = new CheckpointManager();
    expect(manager.create("s1", "   ", 0).label).toBe("Run");
    expect(manager.create("s1", "  lots\n of   spaces ", 0).label).toBe("lots of spaces");
    const long = manager.create("s1", "x".repeat(200), 0).label;
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("round-trips the timeline through serialize/restore", () => {
    const manager = new CheckpointManager();
    const first = manager.create("s1", "one", 0, { message: "spider: one [id-1]", ref: "stash@{0}" });
    manager.create("s1", "two", 2);
    const snapshot = manager.serialize();

    const restored = new CheckpointManager();
    restored.restore(snapshot);
    expect(restored.list("s1").map((cp) => cp.id)).toEqual(manager.list("s1").map((cp) => cp.id));
    expect(restored.get(first.id)?.gitStashMessage).toBe("spider: one [id-1]");
    expect(restored.list("missing")).toEqual([]);
  });

  it("ignores corrupt persisted checkpoint records", () => {
    const restored = new CheckpointManager();
    restored.restore({
      s1: [{ id: "", label: 42 }, { id: "ok", label: "ok", timestamp: 1, changeCount: 0 }],
      s2: "not-a-list",
    } as unknown as Record<string, unknown>);
    expect(restored.list("s1").map((cp) => cp.id)).toEqual(["ok"]);
    expect(restored.list("s2")).toEqual([]);
  });
});

describe("gitCheckpoint (Risk 1)", () => {
  function execFor(responses: Array<{ stdout?: string; stderr?: string; exitCode?: number }>) {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const exec = vi.fn(async (command: string, args: readonly string[], cwd: string) => {
      calls.push({ command, args, cwd });
      const next = responses[calls.length - 1] ?? { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", exitCode: next.exitCode ?? 0 };
    });
    return { exec, calls };
  }

  it("builds a stable spider-labelled stash message", () => {
    expect(stashMessageFor("  do things  ", "cp-1")).toBe("spider: do things [cp-1]");
    expect(stashMessageFor("", "cp-2")).toBe("spider: Run [cp-2]");
  });

  it("captures a snapshot via stash push and re-applies the tree", async () => {
    const { exec, calls } = execFor([
      { stdout: "true\n", exitCode: 0 },
      { stdout: "Saved working directory", exitCode: 0 },
      { stdout: "", exitCode: 0 },
    ]);
    const result = await createGitSnapshot("/repo", "run label", "cp-1", exec);
    expect(result).toMatchObject({ supported: true, ref: "stash@{0}" });
    expect(result.message).toContain("spider:");
    expect(calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual([
      "rev-parse --is-inside-work-tree",
      "stash push",
      "stash apply",
    ]);
    expect(calls[1].args).toContain("--include-untracked");
  });

  it("is graceful when not a repo or the tree is clean", async () => {
    const notRepo = execFor([{ stdout: "false\n", exitCode: 128 }]);
    expect(await createGitSnapshot("/plain", "label", "cp", notRepo.exec)).toEqual({ supported: false });

    const clean = execFor([
      { stdout: "true\n", exitCode: 0 },
      { stdout: "No local changes to save", exitCode: 0 },
    ]);
    expect(await createGitSnapshot("/repo", "label", "cp", clean.exec)).toMatchObject({
      supported: true,
      empty: true,
    });

    const failing = execFor([]);
    failing.exec.mockRejectedValueOnce(new Error("git missing"));
    expect(await createGitSnapshot("/repo", "label", "cp", failing.exec)).toEqual({ supported: false });
  });

  it("finds the matching stash ref and applies it on restore", async () => {
    const message = stashMessageFor("run label", "cp-1");
    expect(findStashRef(`stash@{0}: On main: ${message}\nstash@{1}: On main: other`, message)).toBe("stash@{0}");
    expect(findStashRef("stash@{0}: On main: unrelated", message)).toBeUndefined();

    const { exec, calls } = execFor([
      { stdout: "true\n", exitCode: 0 },
      { stdout: `stash@{1}: On main: ${message}\n`, exitCode: 0 },
      { stdout: "", exitCode: 0 },
    ]);
    const restored = await restoreGitSnapshot("/repo", message, exec);
    expect(restored).toEqual({ applied: true });
    expect(calls.at(-1)?.args).toEqual(["stash", "apply", "stash@{1}"]);
  });

  it("restore is a no-op for missing snapshots or non-repos", async () => {
    expect(await restoreGitSnapshot("/repo", "")).toEqual({ applied: false, reason: "no-git-snapshot" });
    const { exec } = execFor([
      { stdout: "true\n", exitCode: 0 },
      { stdout: "stash@{0}: On main: something else\n", exitCode: 0 },
    ]);
    expect(await restoreGitSnapshot("/repo", stashMessageFor("x", "missing"), exec)).toEqual({
      applied: false,
      reason: "stash-not-found",
    });
  });
});
