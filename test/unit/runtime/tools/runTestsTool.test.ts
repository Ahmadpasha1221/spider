import { afterEach, describe, expect, it } from "vitest";
import {
  runTests,
  parseArgs,
  parseCwd,
  parseRunner,
  parseTimeout,
  TEST_RUN_LIMITS,
  APPROVED_TEST_RUNNERS,
} from "../../../../src/runtime/tools/runTestsTool";
import { BackgroundProcessManager, type BackgroundProcessManagerOptions } from "../../../../src/runtime/tools/backgroundProcessManager";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";
import { makeWorkspace, type TestWorkspace } from "./toolTestUtils";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

/**
 * Builds a minimal ExecutionManager for the current host platform.
 * Tests that only verify output/timeout/cancellation logic do not need a real
 * workspace: the fake spawn never touches the filesystem.
 */
function makeExecutionManager(_workspacePath: string): ExecutionManager {
  return new ExecutionManager({
    environment: {
      hostPlatform: process.platform,
      terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>,
    },
  });
}

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

interface FakeOptions {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Never emits close until kill(). */
  readonly hang?: boolean;
  readonly failSpawn?: boolean;
}

function makeManager(options: FakeOptions = {}): { manager: BackgroundProcessManager; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const killCalls: string[] = [];
  const spawnFn = ((_command: string, args: readonly string[], _options: SpawnOptions) => {
    // The manager terminates hanging children via taskkill on win32.
    if (process.platform === "win32" && _command === "taskkill") {
      killCalls.push(args.join(" "));
      const target = children.find((candidate) => String(candidate.pid) === args[1]);
      target?.kill();
      return new EventEmitter() as unknown as ChildProcess;
    }
    if (options.failSpawn) {
      throw new Error("spawn pnpm ENOENT");
    }
    const child = new FakeChild(options);
    children.push(child);
    process.nextTick(() => {
      child.emit("spawn");
      if (options.stdout) {
        child.stdout.emit("data", options.stdout);
      }
      if (options.stderr) {
        child.stderr.emit("data", options.stderr);
      }
      if (!options.hang) {
        child.emit("exit", options.exitCode ?? 0);
        child.emit("close", options.exitCode ?? 0);
      }
    });
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0, killGraceMs: 10 });
  return { manager, children, killCalls };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    process.nextTick(() => {
      this.emit("exit", null);
      this.emit("close", null);
    });
    return true;
  }
}

describe("run_tests argument validation", () => {
  it("accepts approved runners and rejects everything else", () => {
    expect(parseRunner("pnpm")).toBe("pnpm");
    expect(parseRunner(" npm ")).toBe("npm");
    for (const bad of ["bash", "python -c", "./pnpm", "node", "cmd", ""]) {
      expect(() => parseRunner(bad)).toThrowError(/runner|Approved/i);
    }
    expect(() => parseRunner("src/scripts/run.js")).toThrowError(/bare executable/);
    expect(APPROVED_TEST_RUNNERS.has("cargo")).toBe(true);
  });

  it("rejects shell-shaped arguments", () => {
    expect(parseArgs(["run", "test"])).toEqual(["run", "test"]);
    expect(parseArgs(undefined)).toEqual([]);
    expect(() => parseArgs("run test")).toThrowError(/array/);
    expect(() => parseArgs(["a; b"])).not.toThrow();
    // Injection is structurally impossible: every entry is a single argv value.
    expect(Array.isArray(parseArgs(["run", "test; rm -rf /"]))).toBe(true);
    expect(() => parseArgs([42])).toThrowError(/strings/);
    expect(() => parseArgs(Array.from({ length: 33 }, () => "x"))).toThrowError(/32/);
  });

  it("validates timeout bounds", () => {
    expect(parseTimeout(undefined)).toBe(TEST_RUN_LIMITS.defaultTimeoutMs);
    expect(parseTimeout(5_000)).toBe(5_000);
    expect(parseTimeout(999_999)).toBe(TEST_RUN_LIMITS.maxTimeoutMs);
    expect(() => parseTimeout(50)).toThrowError(/1000/);
    expect(() => parseTimeout("x")).toThrowError(/number/);
  });

  it("rejects a cwd outside the workspace", async () => {
    const created = await makeWorkspace({ "src/a.ts": "x\n" });
    expect(await parseCwd(undefined, created.root)).toBe(created.root);
    expect(await parseCwd(".", created.root)).toBe(created.root);
    await expect(parseCwd("../../etc", created.root)).rejects.toMatchObject({ code: "workspace_violation" });
    await expect(parseCwd("missing-dir", created.root)).rejects.toMatchObject({ code: "not_found" });
    await created.cleanup();
  });
});

describe("run_tests execution", () => {
  const workspaces: TestWorkspace[] = [];
  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("runs a successful test command and reports pass", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const { manager } = makeManager({ exitCode: 0, stdout: "all 10 tests passed\n" });
    const result = await runTests({ runner: "pnpm", args: ["run", "test"] }, { workspacePath: created.root }, { backgroundProcesses: manager, executionManager: makeExecutionManager(created.root) });
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.stdout).toContain("10 tests passed");
    expect(result.command).toBe("pnpm run test");
    expect(result.cwd).toBe(".");
    expect(result.status).toBe("exited");
  });

  it("reports a non-zero exit as a failed run without throwing", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const { manager } = makeManager({ exitCode: 1, stderr: "2 tests failed\n" });
    const result = await runTests({ runner: "npm", args: ["test"] }, { workspacePath: created.root }, { backgroundProcesses: manager, executionManager: makeExecutionManager(created.root) });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("2 tests failed");
  });

  it("times out and cleans the process up", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const { manager, children, killCalls } = makeManager({ hang: true });
    const pending = runTests({ runner: "pnpm", args: ["test"], timeoutMs: 1_000 }, { workspacePath: created.root }, { backgroundProcesses: manager, executionManager: makeExecutionManager(created.root) });
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(children[0]?.killed).toBe(true);
    expect(killCalls.length).toBeGreaterThanOrEqual(process.platform === "win32" ? 1 : 0);
  });

  it("stops the process when the run is cancelled", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const { manager, children } = makeManager({ hang: true });
    const controller = new AbortController();
    const pending = runTests(
      { runner: "pnpm", args: ["test"] },
      { workspacePath: created.root, signal: controller.signal },
      { backgroundProcesses: manager, executionManager: makeExecutionManager(created.root) },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.passed).toBe(false);
    expect(children[0]?.killed).toBe(true);
  });

  it("bounds stdout and stderr", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const huge = "x".repeat(TEST_RUN_LIMITS.maxOutputChars + 1000);
    const { manager } = makeManager({ exitCode: 0, stdout: huge, stderr: huge });
    const result = await runTests({ runner: "pnpm", args: ["test"] }, { workspacePath: created.root }, { backgroundProcesses: manager, executionManager: makeExecutionManager(created.root) });
    expect(result.stdout.length).toBeLessThanOrEqual(TEST_RUN_LIMITS.maxOutputChars + 20);
    expect(result.truncated).toBe(true);
  });

  it("maps a spawn failure to dependency_unavailable and pre-aborted to cancelled", async () => {
    const created = await makeWorkspace({});
    workspaces.push(created);
    const failing = makeManager({ failSpawn: true });
    await expect(
      runTests({ runner: "pnpm" }, { workspacePath: created.root }, { backgroundProcesses: failing.manager, executionManager: makeExecutionManager(created.root) }),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });

    const controller = new AbortController();
    controller.abort();
    const idle = makeManager({});
    await expect(
      runTests({ runner: "pnpm" }, { workspacePath: created.root, signal: controller.signal }, { backgroundProcesses: idle.manager, executionManager: makeExecutionManager(created.root) }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(idle.children).toHaveLength(0);
  });
});
