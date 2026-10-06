import { describe, expect, it, vi } from "vitest";
import { ExecutionManager } from "../../../../src/runtime/execution/executionManager";
import type { ExecutionEnvironment } from "../../../../src/runtime/execution/executionTypes";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { ToolRouter } from "../../../../src/runtime/tools/toolRouter";
import type { CommandRunResult, RunCommandOptions } from "../../../../src/runtime/tools/commandRunner";
import { makeContext } from "../tools/toolTestUtils";

const UNC_WSL_WORKSPACE = "\\\\wsl.localhost\\Ubuntu\\home\\lenovo\\frappe15-new-bench";

function result(options: RunCommandOptions): CommandRunResult {
  return {
    command: options.command,
    cwd: options.cwd,
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    cancelled: false,
    timedOut: false,
  };
}

describe("run_command end-to-end chain", () => {
  it("routes ToolRouter -> executor -> resolved WSL context -> runner", async () => {
    const environment: ExecutionEnvironment = { hostPlatform: "win32" };
    const executionManager = new ExecutionManager({ environment });
    const runCommand = vi.fn(async (options: RunCommandOptions) => result(options));
    const executor = new WorkspaceToolExecutor({ executionManager, runCommand });
    const router = new ToolRouter(executor);
    const authorize = vi.fn(async () => ({ allowed: true }));

    const response = await router.route(
      { id: "1", name: "run_command", input: { command: "bench migrate", cwd: "sites/app" } },
      makeContext(UNC_WSL_WORKSPACE),
      authorize,
    );

    // Permission still runs first, on the way to execution.
    expect(authorize).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();

    const passed = runCommand.mock.calls[0]?.[0];
    expect(passed?.command).toBe("bench migrate");
    // The runner received the context-resolved environment, not a guessed one.
    expect(passed?.cwd).toBe("/home/lenovo/frappe15-new-bench/sites/app");
    expect(passed?.context).toMatchObject({
      executionType: "wsl",
      platform: "wsl",
      shell: "bash",
      backend: "wsl",
      wslDistro: "Ubuntu",
    });
    expect(response.allowed).toBe(true);
    expect(response.result).toMatchObject({ success: true, tool: "run_command" });
    // The chain imports the whole runtime graph and resolves instantly with a
    // mocked runner (57ms alone); under full-suite contention on Windows it
    // can exceed the 5s default, so give it headroom. No assertion is relaxed.
  }, 20_000);
});
