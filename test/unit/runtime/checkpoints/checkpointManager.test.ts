import { describe, expect, it } from "vitest";
import { CheckpointManager } from "../../../../src/runtime/checkpoints/checkpointManager";

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
});
