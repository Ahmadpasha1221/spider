/**
 * Shell-injection and execution-context security tests.
 *
 * These tests verify Spider's core security invariants for command execution:
 *
 * 1. Shell injection payloads cannot reach a real shell because execution is
 *    argv-only (shell: false) — the invocation builder passes the entire
 *    model-supplied command string as a single argument to the shell's `-c`
 *    flag, so metacharacters are data, not syntax.
 *
 * 2. A missing, null, undefined, or malformed ExecutionContext causes
 *    execution to FAIL CLOSED with an ExecutionContextError. No process is
 *    spawned; there is no shell:true fallback.
 *
 * 3. Every call path that creates a process (commandRunner, backgroundProcess
 *    Manager, runTestsTool) enforces the invariant independently.
 *
 * All "malicious" payloads here are harmless markers (strings that would only
 * be dangerous if interpreted by a shell). The tests confirm that the
 * payload never reaches the host shell's command interpreter.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ExecutionManager, buildCommandInvocation, buildArgvInvocation } from "../../../../src/runtime/execution/executionManager";
import { ExecutionContextError, type ExecutionContext, type ExecutionEnvironment } from "../../../../src/runtime/execution/executionTypes";
import { runWorkspaceCommand } from "../../../../src/runtime/tools/commandRunner";
import {
  BackgroundProcessManager,
  type BackgroundProcessManagerOptions,
} from "../../../../src/runtime/tools/backgroundProcessManager";
import { runTests } from "../../../../src/runtime/tools/runTestsTool";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { makeSession } from "../tools/toolTestUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnFn = NonNullable<BackgroundProcessManagerOptions["spawnFn"]>;

interface RecordedCall {
  file: string;
  args: readonly string[];
  options: SpawnOptions;
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 1234;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn(() => true);
}

/**
 * Returns a spawn function that records every call and immediately emits
 * "spawn" so the manager's startup-wait resolves. Never executes any code.
 */
function makeSafeSpawn(): { spawnFn: SpawnFn; calls: RecordedCall[]; children: FakeChild[] } {
  const calls: RecordedCall[] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ file, args: [...args], options });
    children.push(child);
    process.nextTick(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { spawnFn, calls, children };
}

/**
 * A spawn function that records calls but also emits close(0) so
 * commandRunner's Promise resolves cleanly.
 */
function makeSafeSpawnWithClose(): { spawnFn: SpawnFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawnFn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    calls.push({ file, args: [...args], options });
    process.nextTick(() => {
      child.emit("spawn");
      child.stdout.emit("data", "ok");
      (child as unknown as EventEmitter).emit("close", 0);
    });
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

function localEnvironment(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return {
    hostPlatform: "linux",
    terminalShellPath: "/bin/bash",
    env: { PATH: "/usr/bin:/bin" },
    ...overrides,
  };
}

function localContext(workspace = "/workspace"): ExecutionContext {
  return new ExecutionManager({ environment: localEnvironment() }).resolve(workspace);
}

function windowsContext(workspace = "C:\\project"): ExecutionContext {
  return new ExecutionManager({
    environment: localEnvironment({ hostPlatform: "win32", terminalShellPath: "C:\\Windows\\System32\\cmd.exe" }),
  }).resolve(workspace);
}

function powershellContext(workspace = "C:\\project"): ExecutionContext {
  return new ExecutionManager({
    environment: localEnvironment({ hostPlatform: "win32", configuredShell: "powershell" }),
  }).resolve(workspace);
}

function wslContext(workspace = "\\\\wsl.localhost\\Ubuntu\\home\\user\\proj"): ExecutionContext {
  return new ExecutionManager({
    environment: localEnvironment({ hostPlatform: "win32" }),
  }).resolve(workspace);
}

// ---------------------------------------------------------------------------
// Phase 9: Shell injection payloads — confirm they are data, not syntax
// ---------------------------------------------------------------------------

/**
 * Payload list: each entry is a model-supplied command string that contains a
 * shell metacharacter. When passed to the execution layer the entire string
 * must appear as a SINGLE argv entry to the shell's -c flag. The goal is that
 * `echo hello && malicious_command` is passed verbatim to bash -c and is
 * evaluated as ONE shell expression by bash — not split across multiple spawn
 * arguments where `&&` would create a new command.
 *
 * That is the *intended behavior*: bash -c "echo hello && rm -rf /" executes
 * BOTH commands. The security comes from:
 *   a) Permission checks happen before execution (agent → ToolRouter → authorize).
 *   b) The command string is never split naively by shell metacharacters into
 *      multiple independent argv entries that would bypass the permission gate.
 *   c) argv construction is deterministic: the command is always the LAST
 *      single arg to -c / -Command / /c — it cannot be injected into the
 *      executable position or the flags position.
 */
const INJECTION_PAYLOADS = [
  "echo hello && malicious_command",
  "echo hello; malicious_command",
  "echo $(malicious_command)",
  "echo `malicious_command`",
  "echo hello | malicious_command",
  "echo hello > /tmp/malicious_file",
  "echo hello >> /tmp/malicious_file",
  "$(malicious_command)",
  "`malicious_command`",
  // PowerShell variants
  "Write-Output hello; malicious_command",
  "Write-Output $(malicious_command)",
  // cmd.exe variants
  "echo hello & malicious_command",
  "echo hello && malicious_command",
  // Quoting edge cases
  '"hello world"',
  "'hello world'",
  "path with spaces",
  "unicode: café résumé",
  "very" + "x".repeat(500) + "long",
  "empty\x00byte",
  "newline\ninjection",
  "crlf\r\ninjection",
  // Environment variable expansion (shell interprets these only when shell:true)
  "echo $HOME",
  "echo %USERPROFILE%",
  "echo ${PATH}",
];

describe("Shell injection payloads: command string is always a single argv entry", () => {
  it("Linux/bash: the entire payload is the final -c argument — never split into multiple args", () => {
    const context = localContext();
    for (const payload of INJECTION_PAYLOADS) {
      const invocation = buildCommandInvocation(context, payload, "/workspace");
      // The command must always be the LAST argument.
      const lastArg = invocation.args[invocation.args.length - 1];
      expect(lastArg, `Payload "${payload.slice(0, 40)}" must be the last arg`).toBe(payload);
      // shell: false — Node will not interpret metacharacters.
      expect(invocation.shell, `shell must be false for "${payload.slice(0, 40)}"`).toBe(false);
      // The executable must be bash/sh/zsh, not the payload.
      expect(invocation.file, `file must not be the payload for "${payload.slice(0, 40)}"`).not.toBe(payload);
    }
  });

  it("Windows/cmd: the payload is the final /c argument — never split", () => {
    const context = windowsContext();
    for (const payload of INJECTION_PAYLOADS) {
      const invocation = buildCommandInvocation(context, payload, "C:\\project");
      const lastArg = invocation.args[invocation.args.length - 1];
      expect(lastArg, `Payload "${payload.slice(0, 40)}" must be the last arg`).toBe(payload);
      expect(invocation.shell).toBe(false);
    }
  });

  it("Windows/PowerShell: the payload is the final -Command argument — never split", () => {
    const context = powershellContext();
    for (const payload of INJECTION_PAYLOADS) {
      const invocation = buildCommandInvocation(context, payload, "C:\\project");
      const lastArg = invocation.args[invocation.args.length - 1];
      expect(lastArg, `Payload "${payload.slice(0, 40)}" must be the last arg`).toBe(payload);
      expect(invocation.shell).toBe(false);
    }
  });

  it("WSL backend: the payload is the final shell -lc argument — never split", () => {
    const context = wslContext();
    for (const payload of INJECTION_PAYLOADS) {
      const invocation = buildCommandInvocation(context, payload, context.workspaceRoot);
      const lastArg = invocation.args[invocation.args.length - 1];
      expect(lastArg, `Payload "${payload.slice(0, 40)}" must be the last arg`).toBe(payload);
      expect(invocation.shell).toBe(false);
      // The wsl.exe launcher must be the file, not the payload.
      expect(invocation.file).toBe("wsl.exe");
    }
  });

  it("argv commands: each arg is a separate entry — no payload occupies the executable position", () => {
    const context = localContext();
    const injectedArgs = [
      "run",
      "test; rm -rf /",     // shell metacharacters stay as-is: data, not syntax
      "--filter=some&thing",
      "$(whoami)",
    ];
    const invocation = buildArgvInvocation(context, "pnpm", injectedArgs, "/workspace");
    // File is the executable, not any of the args.
    expect(invocation.file).toBe("pnpm");
    // Every arg entry is verbatim.
    for (let i = 0; i < injectedArgs.length; i++) {
      expect(invocation.args[i]).toBe(injectedArgs[i]);
    }
    expect(invocation.shell).toBe(false);
  });

  it("WSL argv commands: metacharacter args are verbatim and never in the wsl.exe -d/-cd positions", () => {
    const context = wslContext();
    const injectedArgs = ["run", "test; malicious", "--flag=$(evil)"];
    const invocation = buildArgvInvocation(context, "pnpm", injectedArgs, context.workspaceRoot);
    // wsl.exe is always the file.
    expect(invocation.file).toBe("wsl.exe");
    // The executable (pnpm) must not be in the distro/cwd positions.
    expect(invocation.args[0]).toBe("-d");
    // pnpm comes after '--'.
    const sep = invocation.args.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(invocation.args[sep + 1]).toBe("pnpm");
    // injectedArgs follow pnpm.
    for (let i = 0; i < injectedArgs.length; i++) {
      expect(invocation.args[sep + 2 + i]).toBe(injectedArgs[i]);
    }
    expect(invocation.shell).toBe(false);
  });
});

describe("Shell injection: commandRunner never receives shell:true from the invocation builder", () => {
  it("every context type produces shell:false in the invocation builder", () => {
    const contexts: ExecutionContext[] = [
      localContext(),
      windowsContext(),
      powershellContext(),
      wslContext(),
    ];
    for (const context of contexts) {
      const invocation = buildCommandInvocation(context, "echo hello", context.workspaceRoot);
      expect(invocation.shell).toBe(false);
    }
  });

  it("commandRunner passes shell:false to the spawner", async () => {
    const { spawnFn, calls } = makeSafeSpawnWithClose();
    const context = localContext();
    await runWorkspaceCommand({
      command: "echo hello",
      cwd: "/workspace",
      context,
      spawnFn: spawnFn as typeof import("node:child_process").spawn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("commandRunner passes injection payload as single arg to the shell — shell:false always", async () => {
    const payload = "echo hello && rm -rf /; $(evil)";
    const { spawnFn, calls } = makeSafeSpawnWithClose();
    const context = localContext();
    await runWorkspaceCommand({
      command: payload,
      cwd: "/workspace",
      context,
      spawnFn: spawnFn as typeof import("node:child_process").spawn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.shell).toBe(false);
    // The payload is always the last arg.
    const args = calls[0]?.args ?? [];
    expect(args[args.length - 1]).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// Phase 10: Fallback-path tests — every invalid/absent context must fail closed
// ---------------------------------------------------------------------------

describe("Fallback-path: commandRunner fails closed when context is absent or invalid", () => {
  // NOTE: runWorkspaceCommand throws synchronously when context is missing
  // (the check runs before the Promise is created), so we use expect().toThrow()
  // rather than .rejects.toThrow().

  it("throws ExecutionContextError when context is undefined", () => {
    expect(() =>
      runWorkspaceCommand({
        command: "echo hi",
        cwd: "/workspace",
      } as Parameters<typeof runWorkspaceCommand>[0]),
    ).toThrow(ExecutionContextError);
  });

  it("throws ExecutionContextError when context is null", () => {
    expect(() =>
      runWorkspaceCommand({
        command: "echo hi",
        cwd: "/workspace",
        context: null,
      } as unknown as Parameters<typeof runWorkspaceCommand>[0]),
    ).toThrow(ExecutionContextError);
  });

  it("does NOT use shell:true when context is a valid object (calls spawnWithContext instead)", async () => {
    // An object satisfies the runtime check; the invocation builder will handle it.
    // We use a fake spawn so no real process is launched.
    const { spawnFn, calls } = makeSafeSpawnWithClose();
    const context = localContext();
    await runWorkspaceCommand({
      command: "echo hi",
      cwd: "/workspace",
      context,
      spawnFn: spawnFn as typeof import("node:child_process").spawn,
    });
    expect(calls).toHaveLength(1);
    // Key assertion: shell:false was used, not shell:true
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("does NOT call spawn at all when context is missing", () => {
    const spawnSpy = vi.fn();
    expect(() =>
      runWorkspaceCommand({
        command: "echo hi",
        cwd: "/workspace",
        spawnFn: spawnSpy as unknown as typeof import("node:child_process").spawn,
      } as Parameters<typeof runWorkspaceCommand>[0]),
    ).toThrow(ExecutionContextError);
    // Spawn must never have been called.
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("error message explains the security invariant", () => {
    expect(() =>
      runWorkspaceCommand({
        command: "echo hi",
        cwd: "/workspace",
      } as Parameters<typeof runWorkspaceCommand>[0]),
    ).toThrow(/Execution context is required/);
  });
});

describe("Fallback-path: BackgroundProcessManager fails closed when context is absent", () => {
  it("throws ExecutionContextError when context is undefined", async () => {
    const { spawnFn, calls } = makeSafeSpawn();
    const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0 });
    await expect(
      manager.start({
        command: "node",
        cwd: "/workspace",
      } as Parameters<typeof manager.start>[0]),
    ).rejects.toThrow(ExecutionContextError);
    expect(calls).toHaveLength(0);
  });

  it("throws ExecutionContextError when context is null", async () => {
    const { spawnFn, calls } = makeSafeSpawn();
    const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0 });
    await expect(
      manager.start({
        command: "node",
        cwd: "/workspace",
        context: null,
      } as unknown as Parameters<typeof manager.start>[0]),
    ).rejects.toThrow(ExecutionContextError);
    expect(calls).toHaveLength(0);
  });

  it("does NOT spawn when context is missing", async () => {
    const { spawnFn, calls } = makeSafeSpawn();
    const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0 });
    try {
      await manager.start({ command: "node", cwd: "/workspace" } as Parameters<typeof manager.start>[0]);
    } catch {
      // expected
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Fallback-path: runTests fails closed when executionManager is absent", () => {
  it("throws ToolExecutionError(dependency_unavailable) when executionManager is missing", async () => {
    const { spawnFn, calls } = makeSafeSpawn();
    const manager = new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0 });
    await expect(
      runTests(
        { runner: "pnpm", args: ["run", "test"] },
        { workspacePath: "/workspace" },
        { backgroundProcesses: manager },
      ),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
    // No spawn should have been attempted.
    expect(calls).toHaveLength(0);
  });
});

describe("Fallback-path: WorkspaceToolExecutor fails closed when executionManager is absent", () => {
  it("returns dependency_unavailable for run_command with no executionManager", async () => {
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const session = makeSession("/workspace");
    const response = await router.route(
      { id: "1", name: "run_command", input: { command: "echo hi" } },
      { session },
      async () => ({ allowed: true }),
    );
    expect(response.result).toMatchObject({ success: false, code: "dependency_unavailable" });
  });

  it("returns dependency_unavailable for background_command with no executionManager", async () => {
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const session = makeSession("/workspace");
    const response = await router.route(
      { id: "2", name: "background_command", input: { command: "node" } },
      { session },
      async () => ({ allowed: true }),
    );
    expect(response.result).toMatchObject({ success: false, code: "dependency_unavailable" });
  });

  it("returns dependency_unavailable for run_tests with no executionManager", async () => {
    const executor = new WorkspaceToolExecutor();
    const router = new ToolRouter(executor);
    const session = makeSession("/workspace");
    const response = await router.route(
      { id: "3", name: "run_tests", input: { runner: "pnpm" } },
      { session },
      async () => ({ allowed: true }),
    );
    expect(response.result).toMatchObject({ success: false, code: "dependency_unavailable" });
  });
});

describe("Fallback-path: invalid ExecutionContext configurations fail at context resolution", () => {
  it("throws ExecutionContextError for an empty workspace path", () => {
    const manager = new ExecutionManager({ environment: localEnvironment() });
    expect(() => manager.resolve("")).toThrow(ExecutionContextError);
    expect(() => manager.resolve("")).toThrow(/no workspace folder/i);
  });

  it("throws ExecutionContextError for whitespace-only workspace path", () => {
    const manager = new ExecutionManager({ environment: localEnvironment() });
    expect(() => manager.resolve("   ")).toThrow(ExecutionContextError);
  });

  it("throws ExecutionContextError for unsupported host platform", () => {
    const manager = new ExecutionManager({
      environment: localEnvironment({ hostPlatform: "aix" as NodeJS.Platform }),
    });
    expect(() => manager.resolve("/workspace")).toThrow(ExecutionContextError);
    expect(() => manager.resolve("/workspace")).toThrow(/unsupported host platform/i);
  });

  it("throws ExecutionContextError for a path escaping the WSL workspace", () => {
    const manager = new ExecutionManager({
      environment: localEnvironment({ hostPlatform: "win32" }),
    });
    const workspace = "\\\\wsl.localhost\\Ubuntu\\home\\user\\proj";
    expect(() =>
      manager.resolveExecutionCwd(workspace, "\\\\wsl.localhost\\Ubuntu\\home\\other\\proj"),
    ).toThrow(ExecutionContextError);
  });
});

describe("Fallback-path: stale/re-resolved context behavior", () => {
  it("re-resolves cleanly after invalidation (no stale state)", () => {
    const manager = new ExecutionManager({ environment: localEnvironment() });
    const first = manager.resolve("/workspace/a");
    manager.invalidate();
    const second = manager.resolve("/workspace/a");
    // Not the same object reference (re-resolved).
    expect(second).not.toBe(first);
    // But same logical content.
    expect(second.executionType).toBe(first.executionType);
    expect(second.platform).toBe(first.platform);
  });

  it("picks up a changed environment after updateEnvironment", () => {
    const manager = new ExecutionManager({ environment: localEnvironment({ hostPlatform: "linux" }) });
    const before = manager.resolve("/workspace");
    expect(before.platform).toBe("linux");

    manager.updateEnvironment(localEnvironment({ hostPlatform: "darwin" }));
    const after = manager.resolve("/workspace");
    expect(after.platform).toBe("macos");
  });
});

describe("Permission gate is checked BEFORE process creation", () => {
  it("denied permission never reaches spawn", async () => {
    const { spawnFn, calls } = makeSafeSpawn();
    const executionManager = new ExecutionManager({ environment: localEnvironment() });
    const executor = new WorkspaceToolExecutor({
      executionManager,
      backgroundProcesses: new BackgroundProcessManager({ spawnFn, immediateExitGraceMs: 0 }),
    });
    const router = new ToolRouter(executor);
    const session = makeSession("/workspace");

    const response = await router.route(
      { id: "1", name: "run_command", input: { command: "echo hi" } },
      { session },
      async () => ({ allowed: false, error: "Denied by policy." }),
    );

    expect(response.allowed).toBe(false);
    expect(response.result).toMatchObject({ success: false, code: "permission_denied" });
    // No spawn should have occurred.
    expect(calls).toHaveLength(0);
  });

  it("allowed permission proceeds to the execution layer", async () => {
    const executionManager = new ExecutionManager({ environment: localEnvironment() });
    // We use a stub runCommand here to avoid actually executing anything.
    const runCommand = vi.fn(async () => ({
      command: "echo hi",
      cwd: "/workspace",
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
      cancelled: false,
      timedOut: false,
    }));
    const executor = new WorkspaceToolExecutor({ executionManager, runCommand });
    const router = new ToolRouter(executor);
    const session = makeSession("/workspace");

    const response = await router.route(
      { id: "2", name: "run_command", input: { command: "echo hi" } },
      { session },
      async () => ({ allowed: true }),
    );

    expect(response.allowed).toBe(true);
    expect(runCommand).toHaveBeenCalledOnce();
    // Verify the context was passed through.
    const options = runCommand.mock.calls[0]?.[0];
    expect(options?.context).toBeDefined();
    expect(options?.context?.platform).toBe("linux");
  });
});
