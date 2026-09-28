import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../src/runtime/tools/workspaceToolExecutor";
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
    // A portable two-stage command: writes immediately, then again after 250ms.
    const script = path.join(root, "slow.js");
    await fs.writeFile(
      script,
      "process.stdout.write('first');setTimeout(() => process.stdout.write('second'), 250);",
      "utf8",
    );

    const permissionManager = new PermissionManager(
      createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }),
    );
    const manager = new RuntimeManager({
      sessionStore: createStore() as never,
      permissionManager,
      runtimes: [new ToolCallingRuntime(`node "${script}"`)],
      toolExecutor: new WorkspaceToolExecutor(),
      defaultWorkspacePath: root,
    });
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(root);
    // Non-destructive execute: the runtime shield approves it without a prompt.
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
