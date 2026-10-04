import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { ExecutionManager, buildCommandInvocation } from "../../../../src/runtime/execution/executionManager";
import {
  ExecutionContextError,
  type ExecutionEnvironment,
} from "../../../../src/runtime/execution/executionTypes";
import { resolveExecutionContext } from "../../../../src/runtime/execution/executionContext";
import { runWorkspaceCommand } from "../../../../src/runtime/tools/commandRunner";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import { makeContext } from "../tools/toolTestUtils";

function environment(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return {
    hostPlatform: "linux",
    terminalShellPath: "/bin/bash",
    env: { PATH: "/usr/bin:/bin", HOME: "/home/user", SECRET_TOKEN: "super-secret" },
    ...overrides,
  };
}

describe("resolveExecutionContext", () => {
  it("resolves a local Windows workspace", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32", terminalShellPath: "C:\\WINDOWS\\System32\\cmd.exe" }),
      "C:\\projects\\app",
    );
    expect(context).toMatchObject({
      executionType: "local",
      platform: "windows",
      shell: "cmd",
      backend: "local",
      cwd: "C:\\projects\\app",
    });
  });

  it("resolves a local Linux workspace", () => {
    const context = resolveExecutionContext(environment(), "/home/user/project");
    expect(context).toMatchObject({
      executionType: "local",
      platform: "linux",
      shell: "bash",
      backend: "local",
      cwd: "/home/user/project",
    });
  });

  it("resolves a macOS workspace and defaults to zsh", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "darwin", terminalShellPath: undefined }),
      "/Users/me/project",
    );
    expect(context).toMatchObject({ executionType: "local", platform: "macos", shell: "zsh" });
  });

  it("resolves a WSL remote workspace (extension host inside the distro)", () => {
    const context = resolveExecutionContext(
      environment({
        hostPlatform: "linux",
        remoteName: "wsl",
        terminalShellPath: "/bin/bash",
        env: { PATH: "/usr/bin", HOME: "/home/lenovo", WSL_DISTRO_NAME: "Ubuntu" },
      }),
      "/home/lenovo/frappe15-new-bench",
    );
    expect(context).toMatchObject({
      executionType: "wsl",
      platform: "wsl",
      shell: "bash",
      backend: "local",
      cwd: "/home/lenovo/frappe15-new-bench",
      wslDistro: "Ubuntu",
    });
  });

  it("bridges a WSL UNC workspace from a Windows host through wsl.exe", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32", terminalShellPath: "C:\\...\\powershell.exe" }),
      "\\\\wsl.localhost\\Ubuntu\\home\\lenovo\\frappe15-new-bench",
    );
    expect(context).toMatchObject({
      executionType: "wsl",
      platform: "wsl",
      shell: "bash",
      backend: "wsl",
      cwd: "/home/lenovo/frappe15-new-bench",
      wslDistro: "Ubuntu",
    });
  });

  it("supports the legacy \\\\wsl$ UNC form", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32" }),
      "\\\\wsl$\\Ubuntu\\home\\user\\proj",
    );
    expect(context.backend).toBe("wsl");
    expect(context.cwd).toBe("/home/user/proj");
    expect(context.wslDistro).toBe("Ubuntu");
  });

  it("resolves a non-WSL remote workspace in place", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "linux", remoteName: "ssh-remote" }),
      "/srv/app",
    );
    expect(context).toMatchObject({
      executionType: "remote",
      platform: "linux",
      backend: "local",
      cwd: "/srv/app",
      remoteAuthority: "ssh-remote",
    });
  });

  it("propagates the host environment without leaking undefined values", () => {
    const context = resolveExecutionContext(
      environment({ env: { PATH: "/usr/bin", EMPTY: undefined } }),
      "/home/user/project",
    );
    expect(context.env.PATH).toBe("/usr/bin");
    expect("EMPTY" in context.env).toBe(false);
  });

  it("honors an explicit configured shell", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32", configuredShell: "powershell", terminalShellPath: "C:\\...\\cmd.exe" }),
      "C:\\projects\\app",
    );
    expect(context.shell).toBe("powershell");
  });

  it("throws a structured error when there is no workspace", () => {
    expect(() => resolveExecutionContext(environment(), "")).toThrow(ExecutionContextError);
  });

  it("throws a structured error for an unsupported host platform", () => {
    expect(() =>
      resolveExecutionContext(environment({ hostPlatform: "aix" as NodeJS.Platform }), "/x"),
    ).toThrow(/unsupported host platform/);
  });
});

describe("ExecutionManager", () => {
  it("caches per workspace and invalidates on demand", () => {
    const manager = new ExecutionManager({ environment: environment() });
    const first = manager.resolve("/home/user/a");
    expect(manager.resolve("/home/user/a")).toBe(first);
    expect(manager.resolve("/home/user/b")).not.toBe(first);
    manager.invalidate();
    expect(manager.resolve("/home/user/a")).not.toBe(first);
  });

  it("re-resolves after updateEnvironment (context refresh)", () => {
    const manager = new ExecutionManager({ environment: environment() });
    expect(manager.resolve("/home/lenovo/bench").executionType).toBe("local");
    manager.updateEnvironment(
      environment({ remoteName: "wsl", env: { WSL_DISTRO_NAME: "Ubuntu" } }),
    );
    expect(manager.resolve("/home/lenovo/bench")).toMatchObject({
      executionType: "wsl",
      wslDistro: "Ubuntu",
    });
  });

  it("resolves the workspace cwd for a nested directory", () => {
    const manager = new ExecutionManager({
      environment: environment({ hostPlatform: "win32" }),
    });
    const workspace = "\\\\wsl.localhost\\Ubuntu\\home\\lenovo\\frappe15-new-bench";
    expect(manager.resolveCwd(workspace, `${workspace}\\sites\\app`)).toBe(
      "/home/lenovo/frappe15-new-bench/sites/app",
    );
  });

  it("keeps local cwd unchanged", () => {
    const manager = new ExecutionManager({ environment: environment() });
    expect(manager.resolveCwd("/home/user/project", "/home/user/project/src")).toBe(
      "/home/user/project/src",
    );
  });

  it("exposes a secret-free context summary", () => {
    const manager = new ExecutionManager({
      environment: environment({ env: { PATH: "/usr/bin", API_KEY: "leak-me" } }),
    });
    const summary = manager.describe("/home/user/project");
    expect(summary).toContain("type: local");
    expect(summary).toContain("cwd: /home/user/project");
    expect(summary).not.toContain("leak-me");
    expect(summary).not.toContain("API_KEY");
  });
});

describe("buildCommandInvocation", () => {
  it("builds a local bash invocation", () => {
    const context = resolveExecutionContext(environment(), "/home/user/project");
    expect(buildCommandInvocation(context, "bench migrate", "/home/user/project")).toMatchObject({
      file: "/bin/bash",
      args: ["-c", "bench migrate"],
      shell: false,
      cwd: "/home/user/project",
    });
  });

  it("builds a Windows cmd invocation matching Node's shell shape", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32", terminalShellPath: "C:\\Windows\\System32\\cmd.exe" }),
      "C:\\project",
    );
    expect(buildCommandInvocation(context, "echo hello", "C:\\project")).toMatchObject({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo hello"],
      shell: false,
    });
  });

  it("builds a PowerShell invocation without shell nesting", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32", configuredShell: "powershell" }),
      "C:\\project",
    );
    const invocation = buildCommandInvocation(context, "Get-ChildItem", "C:\\project");
    expect(invocation.file).toBe("powershell.exe");
    expect(invocation.args).toEqual(["-NoProfile", "-Command", "Get-ChildItem"]);
    expect(invocation.shell).toBe(false);
  });

  it("bridges a WSL workspace through an argv-only wsl.exe call", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32" }),
      "\\\\wsl.localhost\\Ubuntu\\home\\lenovo\\frappe15-new-bench",
    );
    expect(
      buildCommandInvocation(context, "bench migrate", "/home/lenovo/frappe15-new-bench"),
    ).toMatchObject({
      file: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/lenovo/frappe15-new-bench",
        "--",
        "bash",
        "-lc",
        "bench migrate",
      ],
      shell: false,
      cwd: undefined,
    });
  });

  it("never concatenates paths with spaces or special characters into the shell", () => {
    const context = resolveExecutionContext(
      environment({ hostPlatform: "win32" }),
      "\\\\wsl.localhost\\Ubuntu\\home\\user\\my project & (bench) $HOME",
    );
    const invocation = buildCommandInvocation(context, "echo ok", context.cwd);
    // The cwd stays a single argv entry; it is never interpolated into `command`.
    expect(invocation.args).toContain(context.cwd);
    expect(invocation.args[invocation.args.length - 1]).toBe("echo ok");
  });
});

interface RecordedSpawn {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

function fakeSpawn(recorded: RecordedSpawn[]) {
  return (file: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      pid: number;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.pid = 4242;
    child.kill = () => {
      child.killed = true;
    };
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
    recorded.push({ file, args, options: options as Record<string, unknown> });
    setImmediate(() => {
      child.stdout.emit("data", "streamed\n");
      child.emit("close", 0);
    });
    return child;
  };
}

describe("CommandRunner execution-context path", () => {
  it("launches through the WSL backend and still streams output", async () => {
    const recorded: RecordedSpawn[] = [];
    const manager = new ExecutionManager({ environment: environment({ hostPlatform: "win32" }) });
    const workspace = "\\\\wsl.localhost\\Ubuntu\\home\\lenovo\\frappe15-new-bench";
    const context = manager.resolve(workspace);
    const chunks: string[] = [];

    const result = await runWorkspaceCommand({
      command: "bench migrate",
      cwd: context.cwd,
      context,
      spawnFn: fakeSpawn(recorded) as unknown as typeof spawn,
      onOutput: (_stream, chunk) => chunks.push(chunk),
    });

    expect(recorded[0]?.file).toBe("wsl.exe");
    expect(recorded[0]?.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/lenovo/frappe15-new-bench",
      "--",
      "bash",
      "-lc",
      "bench migrate",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("streamed");
    expect(chunks.join("")).toContain("streamed");
  });
});

describe("run_command tool wiring", () => {
  it("maps an unresolvable execution context to a structured tool error", async () => {
    const manager = new ExecutionManager({ environment: environment() });
    expect(() => manager.resolve("")).toThrow(ExecutionContextError);

    const executor = new WorkspaceToolExecutor({ executionManager: manager });
    await expect(
      executor.execute(
        { id: "1", name: "run_command", input: { command: "echo hi" } },
        makeContext(""),
      ),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("still routes run_command through the permission gate", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const router = new ToolRouter({ execute });
    const authorize = vi.fn(async () => ({ allowed: false, error: "Denied by policy." }));

    const response = await router.route(
      { id: "1", name: "run_command", input: { command: "bench migrate" } },
      makeContext("/home/user/project"),
      authorize,
    );

    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(response.allowed).toBe(false);
    expect(response.result).toMatchObject({ success: false, code: "permission_denied" });
  });
});
