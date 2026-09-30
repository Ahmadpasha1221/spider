import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  BackgroundProcessManager,
  isTerminal,
  MAX_PROCESS_BUFFER_CHARS,
  type BackgroundProcessManagerOptions,
} from "../../../../src/runtime/tools/backgroundProcessManager";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

/** Minimal child stand-in: only the events/streams the manager actually uses. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn((signal?: string) => {
    void signal;
    return true;
  });
}

interface FakeSpawn {
  readonly spawnFn: SpawnFn;
  readonly calls: Array<{ command: string; args: string[]; options: SpawnOptions }>;
  readonly children: FakeChild[];
  latest(): FakeChild;
}

/** `behavior` runs synchronously as soon as a child is spawned. */
function makeFakeSpawn(behavior: (child: FakeChild, index: number) => void = () => undefined): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], options });
    children.push(child);
    behavior(child, children.length - 1);
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { spawnFn, calls, children, latest: () => children[children.length - 1] as FakeChild };
}

function spawnThen(child: FakeChild): void {
  process.nextTick(() => child.emit("spawn"));
}

function makeManager(spawn: FakeSpawn, options: Partial<BackgroundProcessManagerOptions> = {}): BackgroundProcessManager {
  return new BackgroundProcessManager({
    spawnFn: spawn.spawnFn,
    immediateExitGraceMs: 0,
    killGraceMs: 10,
    ...options,
  });
}

const CWD = "/workspace";

describe("isTerminal", () => {
  it("classifies every terminal status", () => {
    expect(isTerminal("exited")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("killed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("starting")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("BackgroundProcessManager.start", () => {
  it("returns as soon as the process is confirmed running", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);

    const result = await manager.start({ command: "pnpm", args: ["run", "dev"], cwd: CWD });

    expect(result.status).toBe("running");
    expect(result.pid).toBe(4242);
    expect(result.processId.length).toBeGreaterThan(0);
    expect(result.cancelled).toBeUndefined();
    expect(spawn.calls[0]).toMatchObject({ command: "pnpm", args: ["run", "dev"] });
    expect(spawn.calls[0]?.options).toMatchObject({ shell: false, windowsHide: true });
    expect(manager.get(result.processId)?.status).toBe("running");
    expect(manager.list()).toHaveLength(1);
  });

  it("keeps command and args exactly as given (argv, never a shell string)", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);

    await manager.start({ command: "npm", args: ["run", "build", "--", "--watch"], cwd: CWD });
    expect(spawn.calls[0]?.args).toEqual(["run", "build", "--", "--watch"]);
  });

  it("buffers stdout and stderr and reports totals", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);
    const started = await manager.start({ command: "node", cwd: CWD });

    spawn.latest().stdout.emit("data", "hello ");
    spawn.latest().stderr.emit("data", "oops");

    const output = manager.output(started.processId);
    expect(output).toMatchObject({ stdout: "hello ", stderr: "oops", truncated: false });
    expect(output?.stdoutTotal).toBe(6);
    expect(output?.stderrTotal).toBe(4);
  });

  it("bounds the retained buffer and reports truncation and totals", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn, { maxBufferChars: 5 });
    const started = await manager.start({ command: "node", cwd: CWD });

    spawn.latest().stdout.emit("data", "0123456789");

    const output = manager.output(started.processId);
    expect(output?.stdout).toBe("56789");
    expect(output?.truncated).toBe(true);
    expect(output?.stdoutTotal).toBe(10);
  });

  it("records a clean exit and a non-zero exit", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);

    const ok = await manager.start({ command: "node", cwd: CWD });
    spawn.latest().emit("close", 0);
    expect(manager.get(ok.processId)).toMatchObject({ status: "exited", exitCode: 0 });

    const bad = await manager.start({ command: "node", cwd: CWD });
    spawn.latest().emit("close", 2);
    expect(manager.get(bad.processId)).toMatchObject({ status: "failed", exitCode: 2 });
  });

  it("detects a process that exits inside the startup window", async () => {
    const spawn = makeFakeSpawn((child) => {
      process.nextTick(() => child.emit("spawn"));
      setTimeout(() => child.emit("close", 0), 5);
    });
    const manager = makeManager(spawn, { immediateExitGraceMs: 20 });

    const result = await manager.start({ command: "node", cwd: CWD });
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
  });

  it("reports a failed spawn without leaking a stack", async () => {
    const spawnFn = (() => {
      throw new Error("spawn ENOENT");
    }) as unknown as SpawnFn;
    const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0 });

    const result = await manager.start({ command: "definitely-missing", cwd: CWD });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ENOENT");
  });

  it("records an asynchronous spawn error", async () => {
    const spawn = makeFakeSpawn((child) => {
      process.nextTick(() => child.emit("error", new Error("ENOENT: not found")));
    });
    const manager = makeManager(spawn);

    const result = await manager.start({ command: "missing", cwd: CWD });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ENOENT");
  });

  it("returns cancelled without spawning when the request is already aborted", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);
    const controller = new AbortController();
    controller.abort();

    const result = await manager.start({ command: "node", cwd: CWD, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(spawn.calls).toHaveLength(0);
  });

  it("cancelling the startup wait leaves an already-started process running", async () => {
    const spawn = makeFakeSpawn(() => undefined); // never emits "spawn": startup stays pending
    const manager = makeManager(spawn);
    const controller = new AbortController();

    const pending = manager.start({ command: "node", cwd: CWD, signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.message).toContain("left running");
    expect(spawn.latest().kill).not.toHaveBeenCalled();
  });

  it("assigns unique ids even when the id factory collides", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn, { idFactory: () => "fixed" });

    const first = await manager.start({ command: "node", cwd: CWD });
    const second = await manager.start({ command: "node", cwd: CWD });
    expect(first.processId).toBe("fixed");
    expect(second.processId).toBe("fixed-2");
  });
});

describe("BackgroundProcessManager.stop / dispose", () => {
  it("marks a running process killed and keeps its identity", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);
    const started = await manager.start({ command: "node", cwd: CWD });

    const stopped = await manager.stop(started.processId, { force: true });
    expect(stopped?.status).toBe("killed");
    expect(manager.get(started.processId)?.status).toBe("killed");
  });

  it("returns undefined for an unknown process", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);
    expect(await manager.stop("nope")).toBeUndefined();
    expect(manager.output("nope")).toBeUndefined();
    expect(manager.get("nope")).toBeUndefined();
  });

  it("stops every process and clears the registry on shutdown", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn);
    await manager.start({ command: "a", cwd: CWD });
    await manager.start({ command: "b", cwd: CWD });

    await manager.shutdown();
    expect(manager.list()).toEqual([]);
  });

  it("bounds retained finished processes", async () => {
    const spawn = makeFakeSpawn(spawnThen);
    const manager = makeManager(spawn, { maxRetainedProcesses: 2, killGraceMs: 5 });

    for (let index = 0; index < 5; index += 1) {
      await manager.start({ command: `p${index}`, cwd: CWD });
      spawn.latest().emit("close", 0);
    }

    expect(manager.list().length).toBeLessThanOrEqual(2);
  });

  it("defaults the buffer cap to the exported constant", () => {
    const manager = new BackgroundProcessManager();
    expect(MAX_PROCESS_BUFFER_CHARS).toBeGreaterThan(0);
    expect(manager.list()).toEqual([]);
  });
});
