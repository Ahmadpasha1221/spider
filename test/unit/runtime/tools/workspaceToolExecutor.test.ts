import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeviaSession } from "../../../../src/runtime/runtimeTypes";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";

describe("WorkspaceToolExecutor", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function workspace(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-tools-"));
    dirs.push(dir);
    return dir;
  }

  function makeExecutor(_workspacePath: string): WorkspaceToolExecutor {
    // Real ExecutionManager so run_command can resolve an execution context.
    const executionManager = new ExecutionManager({
      environment: {
        hostPlatform: process.platform,
        terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>,
      },
    });
    return new WorkspaceToolExecutor({ executionManager });
  }

  function session(workspacePath: string): CodeviaSession {
    const now = new Date();
    return {
      sessionId: "s1",
      provider: "ollama",
      workspacePath,
      status: "RUNNING",
      createdAt: now,
      updatedAt: now,
    };
  }

  it("write_file creates a file and read_file returns it", async () => {
    const root = await workspace();
    const executor = makeExecutor(root);
    await executor.execute(
      { id: "1", name: "write_file", input: { path: "test.py", content: "print(1+2)\n" } },
      { session: session(root) },
    );
    const result = await executor.execute(
      { id: "2", name: "read_file", input: { path: "test.py" } },
      { session: session(root) },
    );
    expect(await fs.readFile(path.join(root, "test.py"), "utf8")).toBe("print(1+2)\n");
    expect(result).toEqual({ path: "test.py", content: "print(1+2)\n" });
  });

  it("run_command executes in the workspace", async () => {
    const root = await workspace();
    const executor = makeExecutor(root);
    // Use a cross-platform command: 'echo' works on Windows (cmd), Linux (bash), and macOS (zsh).
    const result = await executor.execute(
      { id: "3", name: "run_command", input: { command: "echo run_command_ok" } },
      { session: session(root) },
    ) as { stdout: string; exitCode: number | null; cwd: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("run_command_ok");
    expect(result.cwd).toBe(path.resolve(root));
  });

  it("rejects paths outside the workspace", async () => {
    const root = await workspace();
    const executor = makeExecutor(root);
    await expect(
      executor.execute(
        { id: "4", name: "read_file", input: { path: "../outside.txt" } },
        { session: session(root) },
      ),
    ).rejects.toThrow("outside the workspace");
  });

  it("resolves relative write_file paths with path utilities", async () => {
    const root = await workspace();
    const executor = makeExecutor(root);
    await executor.execute(
      { id: "6", name: "write_file", input: { path: "simple.py", content: "print('Hello, World!')\n" } },
      { session: session(root) },
    );
    expect(await fs.readFile(path.join(root, "simple.py"), "utf8")).toBe("print('Hello, World!')\n");
  });

  it("rejects parent-directory escapes", async () => {
    const root = await workspace();
    const executor = makeExecutor(root);
    await expect(
      executor.execute(
        { id: "7", name: "write_file", input: { path: "..\\..\\secret.txt", content: "nope" } },
        { session: session(root) },
      ),
    ).rejects.toThrow("outside the workspace");
  });
});
