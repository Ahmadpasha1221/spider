import { describe, expect, it } from "vitest";
import { ExecutionManager, buildCommandInvocation, buildArgvInvocation } from "../../../../src/runtime/execution/executionManager";

const TRICKY_LOCAL_ROOTS = [
  "C:\\projects\\my app",
  "C:\\projects\\a&b|c;d(e)$f",
  "C:\\projects\\Ünïcødé\\项目",
  "C:\\projects\\quote's \"double\"",
  "/home/user/my project",
  "/home/user/Ünïcødé/项目/$(whoami)",
];

const TRICKY_WSL_SEGMENTS = ["my project", "a&b|c;d(e)$f", "quote's \"double\"", "Ünïcødé/项目"];

describe("path translation is anchored and injection-free", () => {
  it("keeps local paths identical and out of the command argv", () => {
    for (const hostPlatform of ["win32", "linux", "darwin"] as const) {
      const manager = new ExecutionManager({ environment: { hostPlatform } });
      for (const workspace of TRICKY_LOCAL_ROOTS) {
        const context = manager.resolve(workspace);
        // Local translation is the identity on the workspace root.
        expect(context.cwd).toBe(workspace);

        const nested = `${workspace}${hostPlatform === "win32" ? "\\" : "/"}src`;
        const cwd = manager.resolveCwd(workspace, nested);
        expect(cwd).toBe(nested);

        const invocation = buildCommandInvocation(context, "echo ok", cwd);
        expect(invocation.cwd).toBe(cwd);
        // The command is the final argv entry; the path is never concatenated in.
        expect(invocation.args[invocation.args.length - 1]).toBe("echo ok");
        expect(invocation.args.join(" ")).not.toContain(cwd);
      }
    }
  });

  it("keeps a tricky WSL path as exactly one argv entry, never inside the command", () => {
    const manager = new ExecutionManager({ environment: { hostPlatform: "win32" } });
    for (const segment of TRICKY_WSL_SEGMENTS) {
      const workspace = `\\\\wsl.localhost\\Ubuntu\\home\\user\\${segment.replaceAll("/", "\\")}`;
      const context = manager.resolve(workspace);

      const shellInvocation = buildCommandInvocation(context, "echo ok", context.cwd);
      expect(shellInvocation.args.filter((arg) => arg === context.cwd)).toHaveLength(1);
      expect(shellInvocation.args[shellInvocation.args.length - 1]).toBe("echo ok");
      expect(shellInvocation.args[1]).toBe("Ubuntu");

      // An argv command keeps both the executable and every argument separate.
      const argvInvocation = buildArgvInvocation(context, "pnpm", ["run", "test"], context.cwd);
      expect(argvInvocation.args).toEqual([
        "-d",
        "Ubuntu",
        "--cd",
        context.cwd,
        "--",
        "pnpm",
        "run",
        "test",
      ]);
    }
  });

  it("rejects paths that escape the workspace instead of translating them", () => {
    const manager = new ExecutionManager({ environment: { hostPlatform: "win32" } });
    const workspace = "\\\\wsl.localhost\\Ubuntu\\home\\user\\proj";
    expect(() =>
      manager.resolveCwd(workspace, "\\\\wsl.localhost\\Ubuntu\\home\\user\\other"),
    ).toThrow(/outside the workspace execution environment/);
  });
});
