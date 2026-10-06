import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../src/runtime/tools/workspaceToolExecutor";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";
import type { AgentRuntime, RuntimeEventSink, RuntimeSendRequest } from "../../../src/runtime/runtimeTypes";

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
    workspaceState: { get: vi.fn(() => []), update: vi.fn().mockResolvedValue(undefined) },
  };
}

class ScriptedRuntime implements AgentRuntime {
  readonly provider = "mock" as const;
  readonly family = "mock" as const;
  calls: RuntimeSendRequest[] = [];
  disposeHistory = vi.fn();
  configure = vi.fn(async () => undefined);
  checkAvailability = vi.fn(async () => ({ available: true, status: "connected" as const }));
  discoverModels = vi.fn(async () => []);
  createSession = vi.fn(async (request: { sessionId: string }) => ({ providerSessionId: request.sessionId }));
  resumeSession = vi.fn(async (request: { providerSessionId: string }) => ({ providerSessionId: request.providerSessionId }));
  cancel = vi.fn(async () => undefined);
  dispose = vi.fn();

  constructor(private readonly script: (request: RuntimeSendRequest, emit: RuntimeEventSink) => Promise<void>) {}

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    this.calls.push(request);
    await this.script(request, emit);
  }
}

async function createManager(script: (request: RuntimeSendRequest, emit: RuntimeEventSink) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spider-subagent-"));
  const runtime = new ScriptedRuntime(script);
  const manager = new RuntimeManager({
    sessionStore: createStore() as never,
    permissionManager: new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true })),
    runtimes: [runtime],
    toolExecutor: new WorkspaceToolExecutor(),
    defaultWorkspacePath: root,
  });
  await manager.setProvider({ provider: "mock" });
  const session = manager.createSession(root);
  return { manager, runtime, session, root };
}

describe("RuntimeManager subagents (A7)", () => {
  it("runs the subagent in an isolated session with the subagent mode and prompt", async () => {
    const { manager, runtime, session, root } = await createManager(async (request, emit) => {
      await emit({
        type: "assistant_message",
        sessionId: request.sessionId,
        message: "Streaming state lives in runtimeManager.commandStreams.",
        timestamp: Date.now(),
      });
    });

    const result = await manager.runSubagent(
      { task: "Find where streaming state is managed", description: "Trace streaming" },
      { session },
    );

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("commandStreams");
    expect(runtime.calls).toHaveLength(1);
    const request = runtime.calls[0]!;
    expect(request.sessionId).not.toBe(session.sessionId);
    expect(request.sessionId.startsWith("subagent-")).toBe(true);
    expect(request.mode).toBe("subagent");
    expect(request.systemPrompt).toContain("read-only research subagent");
    expect(request.systemPrompt).toContain("Find where streaming state is managed");
    expect(runtime.disposeHistory).toHaveBeenCalledWith(request.sessionId);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("enforces read-only through the normal tool pipeline (no permission bypass)", async () => {
    const { manager, runtime, session, root } = await createManager(async (request, emit) => {
      const write = await request.onToolCall?.(
        { id: "w", name: "write_file", input: { path: "hacked.txt", content: "x" } },
        request.signal,
      );
      const nested = await request.onToolCall?.(
        { id: "n", name: "run_subagent", input: { task: "again" } },
        request.signal,
      );
      const read = await request.onToolCall?.(
        { id: "r", name: "list_files", input: { path: "." } },
        request.signal,
      );
      await emit({
        type: "assistant_message",
        sessionId: request.sessionId,
        message: JSON.stringify({ write: write?.allowed, nested: nested?.allowed, read: read?.allowed }),
        timestamp: Date.now(),
      });
    });

    const result = await manager.runSubagent({ task: "check tools" }, { session });
    const captured = JSON.parse(result.summary) as { write: boolean; nested: boolean; read: boolean };
    expect(captured.write).toBe(false);
    expect(captured.nested).toBe(false);
    expect(captured.read).toBe(true);
    expect(runtime.calls).toHaveLength(1);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses nested subagents (depth is capped at 1)", async () => {
    const { manager, runtime, session, root } = await createManager(async (request, emit) => {
      const nested = await manager.runSubagent({ task: "nested" }, { session });
      await emit({
        type: "assistant_message",
        sessionId: request.sessionId,
        message: JSON.stringify({ nested: nested.status }),
        timestamp: Date.now(),
      });
    });

    const result = await manager.runSubagent({ task: "outer" }, { session });
    expect(result.status).toBe("completed");
    expect((JSON.parse(result.summary) as { nested: string }).nested).toBe("limit");
    // Only the outer run reached the model.
    expect(runtime.calls).toHaveLength(1);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("records the subagent's usage against the parent conversation", async () => {
    const { manager, session, root } = await createManager(async (request, emit) => {
      request.usageSink?.({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      await emit({
        type: "assistant_message",
        sessionId: request.sessionId,
        message: "report",
        timestamp: Date.now(),
      });
    });

    await manager.runSubagent({ task: "count tokens" }, { session });
    expect(manager.getUsage(session.sessionId).totalTokens).toBe(15);

    await fs.rm(root, { recursive: true, force: true });
  });
});
