import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../src/runtime/tools/workspaceToolExecutor";
import { ExecutionManager } from "../../../src/runtime/execution/executionManager";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeSendRequest,
} from "../../../src/runtime/runtimeTypes";

vi.mock("vscode", () => ({
  EventEmitter: class {
    private listeners: ((event: unknown) => void)[] = [];
    event: (listener: (event: unknown) => void) => void;
    constructor() {
      this.event = (listener: (event: unknown) => void) => {
        this.listeners.push(listener);
      };
    }
    fire(event: unknown): void {
      this.listeners.forEach((listener) => listener(event));
    }
    dispose(): void {
      this.listeners = [];
    }
  },
}));

function createStore() {
  return {
    loadSessions: () => [],
    loadActiveSessionId: () => undefined,
    saveSessions: vi.fn().mockResolvedValue(undefined),
    saveActiveSessionId: vi.fn().mockResolvedValue(undefined),
  };
}

class ToolCallingRuntime implements AgentRuntime {
  readonly provider = "mock" as const;
  readonly family = "mock" as const;
  configure = vi.fn(async () => undefined);
  checkAvailability = vi.fn(async () => ({ available: true, status: "connected" as const }));
  discoverModels = vi.fn(async () => []);
  createSession = vi.fn(async (request: { sessionId: string }) => ({ providerSessionId: request.sessionId }));
  resumeSession = vi.fn(async (request: { providerSessionId: string }) => ({ providerSessionId: request.providerSessionId }));
  cancel = vi.fn(async () => undefined);
  dispose = vi.fn();

  async sendMessage(request: RuntimeSendRequest, _emit: RuntimeEventSink): Promise<void> {
    await request.onToolCall?.(
      { id: "cmd-1", name: "run_command", input: { command: this.command } },
      request.signal,
    );
  }

  constructor(private readonly command: string) {}
}

describe("RuntimeManager live command output", () => {
  it("publishes partial command_output while the command is still running", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-stream-"));

    const permissionManager = new PermissionManager(
      createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }),
    );
    const executionManager = new ExecutionManager({
      environment: {
        hostPlatform: process.platform,
        terminalShellPath: process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh"),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>,
      },
    });

    // Use a stub runCommand that fires onOutput synchronously, then waits
    // 300ms before completing. This lets the 120ms streaming timer fire
    // at least once before the command is "done", without relying on
    // OS-level subprocess stdout buffering behaviour (which varies on Windows).
    const stubRunCommand = vi.fn(async (options: import("../../../src/runtime/tools/commandRunner").RunCommandOptions) => {
      // Fire the streaming hook immediately so the partial timer starts.
      options.onOutput?.("stdout", "first");
      // Await enough time for the 120ms partial timer to fire.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      options.onOutput?.("stdout", "second");
      return {
        command: options.command,
        cwd: options.cwd,
        stdout: "firstsecond",
        stderr: "",
        exitCode: 0,
        cancelled: false,
        timedOut: false,
      };
    });

    const manager = new RuntimeManager({
      sessionStore: createStore() as never,
      permissionManager,
      runtimes: [new ToolCallingRuntime("echo streaming-test")],
      toolExecutor: new WorkspaceToolExecutor({ executionManager, runCommand: stubRunCommand }),
      defaultWorkspacePath: root,
    });
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(root);
    permissionManager.setRuntimeAutoApprove(true, "conversation");

    const partials: RuntimeEvent[] = [];
    manager.onDidPublishEvent((event) => {
      if (event.type === "command_output" && event.partial) {
        partials.push(event);
      }
    });

    await manager.startTask(session.sessionId, "run the slow script");

    expect(partials.length).toBeGreaterThan(0);
    const first = partials[0];
    expect(first.type).toBe("command_output");
    if (first.type === "command_output") {
      expect(first.toolCallId).toBe("cmd-1");
      expect(first.stdout).toContain("first");
      expect(first.exitCode).toBeNull();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
});
