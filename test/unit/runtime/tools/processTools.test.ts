import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { BackgroundProcessManager, type BackgroundProcessManagerOptions } from "../../../../src/runtime/tools/backgroundProcessManager";
import { getCommandOutput, killCommand, OUTPUT_LIMITS } from "../../../../src/runtime/tools/processTools";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

class FakeChild extends EventEmitter {
  pid: number | undefined = 777;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

function makeManager(): { manager: BackgroundProcessManager; latest: () => FakeChild } {
  const children: FakeChild[] = [];
  const spawnFn = ((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    process.nextTick(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0, killGraceMs: 10 });
  return { manager, latest: () => children[children.length - 1] as FakeChild };
}

async function startRunning(manager: BackgroundProcessManager, latest: () => FakeChild) {
  const started = await manager.start({ command: "npm", args: ["run", "dev"], cwd: "/w" });
  return { started, child: latest() };
}

describe("get_command_output", () => {
  it("rejects a missing id and an unknown process", async () => {
    const { manager } = makeManager();
    expect(() => getCommandOutput({}, manager)).toThrowError(/processId/);
    expect(() => getCommandOutput({ processId: "nope" }, manager)).toThrowError(/No background process/);
    try {
      getCommandOutput({ processId: "nope" }, manager);
    } catch (error) {
      expect(error).toMatchObject({ code: "not_found" });
    }
  });

  it("returns the recent output of a running process", async () => {
    const { manager, latest } = makeManager();
    const { started, child } = await startRunning(manager, latest);
    child.stdout.emit("data", "booting\n");
    child.stderr.emit("data", "warn\n");

    const result = getCommandOutput({ processId: started.processId }, manager);
    expect(result).toMatchObject({ processId: started.processId, status: "running", stdout: "booting\n", stderr: "warn\n", truncated: false });
  });

  it("bounds output by lines and marks truncation", async () => {
    const { manager, latest } = makeManager();
    const { started, child } = await startRunning(manager, latest);
    child.stdout.emit("data", Array.from({ length: 50 }, (_v, i) => `line ${i}`).join("\n"));

    const result = getCommandOutput({ processId: started.processId, maxLines: 5 }, manager);
    expect(result.truncated).toBe(true);
    expect(result.stdout.split("\n")).toHaveLength(5);
    expect(result.stdout).toContain("line 49");
    expect(result.stdout).not.toContain("line 0\n");
    expect(result.stdoutTotal).toBeGreaterThan(0);
  });

  it("bounds output by bytes and marks truncation", async () => {
    const { manager, latest } = makeManager();
    const { started, child } = await startRunning(manager, latest);
    child.stdout.emit("data", "0123456789ABCDEFGHIJ");

    const result = getCommandOutput({ processId: started.processId, maxBytes: 6 }, manager);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("EFGHIJ"); // rolling tail: last 6 characters
    expect(result.stdout.length).toBeLessThanOrEqual(6);
    expect(OUTPUT_LIMITS.maxBytes).toBeGreaterThan(0);
  });

  it("reports an exited process and its output", async () => {
    const { manager, latest } = makeManager();
    const { started, child } = await startRunning(manager, latest);
    child.stdout.emit("data", "done");
    child.emit("close", 0);

    const result = getCommandOutput({ processId: started.processId }, manager);
    expect(result.status).toBe("exited");
    expect(result.stdout).toBe("done");
  });
});

describe("kill_command", () => {
  it("rejects a missing id and an unknown process", async () => {
    const { manager } = makeManager();
    await expect(killCommand({}, manager)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(killCommand({ processId: "nope" }, manager)).rejects.toMatchObject({ code: "not_found" });
  });

  it("cannot target an arbitrary OS pid (ownership is the manager handle)", async () => {
    const { manager } = makeManager();
    // A raw pid is not a manager process id, so it is never killable.
    await expect(killCommand({ processId: "4242" }, manager)).rejects.toMatchObject({ code: "not_found" });
  });

  it("kills a running process and reports the terminal status", async () => {
    const { manager, latest } = makeManager();
    const { started } = await startRunning(manager, latest);

    const result = await killCommand({ processId: started.processId }, manager);
    expect(result.processId).toBe(started.processId);
    expect(result.status).toBe("killed");
    expect(manager.get(started.processId)?.status).toBe("killed");
  });

  it("is a no-op for a process that already exited", async () => {
    const { manager, latest } = makeManager();
    const { started, child } = await startRunning(manager, latest);
    child.emit("close", 0);

    const result = await killCommand({ processId: started.processId }, manager);
    expect(result.status).toBe("exited");
    expect(result.message).toContain("already exited");
  });

  it("forces termination when asked", async () => {
    const { manager, latest } = makeManager();
    const { started } = await startRunning(manager, latest);
    const result = await killCommand({ processId: started.processId, force: true }, manager);
    expect(result.status).toBe("killed");
    expect(result.message).toContain("force-terminated");
  });
});
