import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runWorkspaceCommand } from "../../../../src/runtime/tools/commandRunner";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";

function makeContext(cwd: string) {
  // Resolve a real local execution context for the current platform.
  const manager = new ExecutionManager({
    environment: {
      hostPlatform: process.platform,
      terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>,
    },
  });
  return manager.resolve(cwd);
}

describe("runWorkspaceCommand output streaming", () => {
  it("streams stdout chunks through onOutput and still returns the full output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-cmd-"));
    const chunks: string[] = [];
    const context = makeContext(root);

    const result = await runWorkspaceCommand({
      command: "echo streamed-line",
      cwd: root,
      context,
      onOutput: (stream, chunk) => {
        expect(stream).toBe("stdout");
        chunks.push(chunk);
      },
    });

    expect(result.stdout).toContain("streamed-line");
    expect(chunks.join("")).toContain("streamed-line");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("works without an onOutput hook (non-streaming callers unchanged)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-cmd-"));
    const context = makeContext(root);
    const result = await runWorkspaceCommand({ command: "echo plain", cwd: root, context });
    expect(result.stdout).toContain("plain");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("throws ExecutionContextError when context is missing (fail-closed security invariant)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-cmd-"));
    try {
      // Cast to bypass TypeScript — simulates a JavaScript/runtime caller omitting context.
      expect(
        () => runWorkspaceCommand({ command: "echo hi", cwd: root } as Parameters<typeof runWorkspaceCommand>[0]),
      ).toThrow(/Execution context is required/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
