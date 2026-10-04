import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";
import type { ExecutionEnvironment } from "../../../../src/runtime/execution/executionTypes";
import {
  BackgroundProcessManager,
  type BackgroundProcessManagerOptions,
} from "../../../../src/runtime/tools/backgroundProcessManager";
import { runTests } from "../../../../src/runtime/tools/runTestsTool";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = (): boolean => true;
}

interface Recorded {
  readonly command: string;
  readonly args: string[];
  readonly options: SpawnOptions;
}

function makeSpawn(behave: (child: FakeChild) => void = (child) => process.nextTick(() => child.emit("spawn"))) {
  const calls: Recorded[] = [];
  const spawnFn = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], options });
    behave(child);
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

function manager(environment: ExecutionEnvironment) {
  return new ExecutionManager({ environment });
}

const UNC_WSL_WORKSPACE = "\\\\wsl.localhost\\Ubuntu\\home\\lenovo\\frappe15-new-bench";

describe("background processes follow the execution context", () => {
  it("bridges a WSL workspace through argv-only wsl.exe", async () => {
    const spawn = makeSpawn();
    const processes = new BackgroundProcessManager({ spawnFn: spawn.spawnFn, immediateExitGraceMs: 0 });
    const exec = manager({ hostPlatform: "win32", terminalShellPath: "C:\\Windows\\System32\\cmd.exe" });
    const context = exec.resolve(UNC_WSL_WORKSPACE);
    const cwd = exec.resolveExecutionCwd(UNC_WSL_WORKSPACE, `${UNC_WSL_WORKSPACE}\\sites\\app`);

    const started = await processes.start({
      command: "pnpm",
      args: ["run", "dev"],
      cwd,
      context,
    });

    expect(spawn.calls[0]?.command).toBe("wsl.exe");
    expect(spawn.calls[0]?.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/lenovo/frappe15-new-bench/sites/app",
      "--",
      "pnpm",
      "run",
      "dev",
    ]);
    expect(spawn.calls[0]?.options).toMatchObject({ shell: false, windowsHide: true });
    expect(spawn.calls[0]?.options.cwd).toBeUndefined();
    // The record keeps the caller's identity, not the transport.
    expect(started.command).toBe("pnpm");
    expect(started.args).toEqual(["run", "dev"]);
  });

  it("runs a local context directly with the resolved environment", async () => {
    const spawn = makeSpawn();
    const processes = new BackgroundProcessManager({ spawnFn: spawn.spawnFn, immediateExitGraceMs: 0 });
    const exec = manager({ hostPlatform: "linux", terminalShellPath: "/bin/bash", env: { PATH: "/usr/bin" } });
    const context = exec.resolve("/home/user/project");

    await processes.start({ command: "node", args: ["server.js"], cwd: "/home/user/project", context });

    expect(spawn.calls[0]?.command).toBe("node");
    expect(spawn.calls[0]?.args).toEqual(["server.js"]);
    expect(spawn.calls[0]?.options.cwd).toBe("/home/user/project");
    expect(spawn.calls[0]?.options.env).toMatchObject({ PATH: "/usr/bin" });
  });
});

describe("run_tests follows the execution context", () => {
  it("starts the approved runner through the WSL backend", async () => {
    const spawn = makeSpawn((child) => {
      process.nextTick(() => child.emit("spawn"));
      process.nextTick(() => child.emit("close", 0));
    });
    const processes = new BackgroundProcessManager({
      spawnFn: spawn.spawnFn,
      immediateExitGraceMs: 0,
      killGraceMs: 5,
    });
    const exec = manager({ hostPlatform: "win32" });
    // A real directory is not required: run_tests resolves cwd skip-free only
    // when a context exists, and the fake spawn never touches the filesystem.
    const result = await runTests(
      { runner: "pnpm", args: ["run", "test"] },
      { workspacePath: UNC_WSL_WORKSPACE },
      { backgroundProcesses: processes, executionManager: exec },
    );

    expect(spawn.calls[0]?.command).toBe("wsl.exe");
    expect(spawn.calls[0]?.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/lenovo/frappe15-new-bench",
      "--",
      "pnpm",
      "run",
      "test",
    ]);
    expect(result.runner).toBe("pnpm");
    expect(result.passed).toBe(true);
    expect(result.cwd).toBe(".");
  });
});