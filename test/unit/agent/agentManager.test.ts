import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../../src/agent/agentManager";
import { CursorClient } from "../../../src/auth/cursorClient";
import { SessionStore } from "../../../src/session/sessionStore";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";

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
  CancellationToken: class {
    isCancellationRequested = false;
  },
}));

vi.mock("../../../../src/auth/cursorClient", () => ({
  CursorClient: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
});

function createStore(sessions: unknown[] = []) {
  const workspaceState = {
    get: vi.fn((key: string) => key === "spider.sessions" ? sessions : undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const store = new SessionStore(workspaceState as unknown as vscode.Memento);
  return { store, workspaceState };
}

function makePermissionManager(
  options: { isWorkspaceTrusted?: () => boolean; autoAllowRead?: boolean; autoAllowExternal?: boolean; defaultTimeoutMs?: number } = {},
): PermissionManager {
  return new PermissionManager(
    createDefaultPermissionPolicy({
      isWorkspaceTrusted: () => true,
      autoAllowRead: true,
      autoAllowExternal: false,
      ...options,
    }),
  );
}

function deferredRun(): { run: unknown; resolve: (value: unknown) => void; promise: Promise<unknown> } {
  let resolve: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { run: { id: "run-1", agentId: "agent-1" }, resolve: resolve!, promise };
}

function toolCallMessage(
  toolName: string,
  args: Record<string, unknown> = {},
  status: "running" | "completed" | "error" = "running",
): unknown {
  return {
    kind: "tool_call",
    message: {
      type: "tool_call",
      name: toolName,
      args,
      status,
      call_id: "call-1",
      agent_id: "agent-1",
      run_id: "run-1",
    },
  };
}

function makeCursorClient(
  runPromise?: Promise<unknown>,
  messages: unknown[] = [],
): CursorClient {
  const waitPromise = runPromise ?? Promise.resolve({ status: "finished" });
  return {
    hasApiKey: vi.fn().mockReturnValue(true),
    setApiKey: vi.fn(),
    createAgent: vi.fn().mockResolvedValue({ agentId: "agent-1", close: vi.fn() }),
    sendMessage: vi.fn().mockResolvedValue({
      id: "run-1",
      agentId: "agent-1",
      cancel: vi.fn(),
      wait: vi.fn().mockResolvedValue({ status: "finished" }),
      stream: vi.fn(async function* () {}),
    }),
    cancelRun: vi.fn(),
    streamRunEvents: vi.fn(async function* () {}),
    streamRunMessages: vi.fn(async function* () {
      for (const message of messages) {
        yield message;
      }
    }),
    waitRun: vi.fn().mockReturnValue(waitPromise),
  } as unknown as CursorClient;
}

describe("AgentManager", () => {
  it("createSession returns a session in IDLE state", () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");

    expect(session.workspacePath).toBe("/workspace");
    expect(session.status).toBe("IDLE");
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
  });

  it("getSession returns the created session", () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");

    expect(manager.getSession(session.sessionId)).toBe(session);
    expect(manager.getSession("missing")).toBeUndefined();
  });

  it("listSessions returns sessions sorted by updatedAt", () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const s1 = manager.createSession("/workspace1");
    const s2 = manager.createSession("/workspace2");

    const sessions = manager.listSessions();

    expect(sessions).toHaveLength(2);
    const ids = new Set(sessions.map((s) => s.sessionId));
    expect(ids.has(s1.sessionId)).toBe(true);
    expect(ids.has(s2.sessionId)).toBe(true);
  });

  it("selectSession returns true for existing session", () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");

    expect(manager.selectSession(session.sessionId)).toBe(true);
    expect(manager.activeSession?.sessionId).toBe(session.sessionId);
  });

  it("selectSession returns false for missing session", () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());

    expect(manager.selectSession("missing")).toBe(false);
    expect(manager.activeSession).toBeUndefined();
  });

  it("deleteSession removes session and clears active", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");
    manager.selectSession(session.sessionId);
    await manager.deleteSession(session.sessionId);

    expect(manager.getSession(session.sessionId)).toBeUndefined();
    expect(manager.activeSession).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("restoreSessions marks non-terminal sessions as DISCONNECTED", async () => {
    const stored = [
      {
        sessionId: "session-running",
        workspacePath: "/workspace",
        status: "RUNNING",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sessionId: "session-completed",
        workspacePath: "/workspace2",
        status: "COMPLETED",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const { store, workspaceState } = createStore(stored);
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());

    await manager.restoreSessions();

    const running = manager.getSession("session-running");
    const completed = manager.getSession("session-completed");

    expect(running?.status).toBe("DISCONNECTED");
    expect(completed?.status).toBe("COMPLETED");
    expect(workspaceState.update).toHaveBeenCalled();
  });

  it("restoreSessions restores the persisted active session", async () => {
    const stored = [
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        status: "COMPLETED",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sessionId: "session-2",
        workspacePath: "/workspace",
        status: "COMPLETED",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const workspaceState = {
      get: vi.fn((key: string) => key === "spider.sessions" ? stored : "session-1"),
      update: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore(workspaceState as unknown as vscode.Memento);
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());

    await manager.restoreSessions();

    expect(manager.activeSession?.sessionId).toBe("session-1");
    expect(workspaceState.update).toHaveBeenCalledWith("spider.activeSession", "session-1");
  });

  it("restoreSessions publishes a disconnected event for interrupted sessions", async () => {
    const stored = [
      {
        sessionId: "session-running",
        workspacePath: "/workspace",
        status: "RUNNING",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const { store } = createStore(stored);
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const events: unknown[] = [];
    manager.onDidPublishEvent((event) => events.push(event));

    await manager.restoreSessions();

    expect(events).toEqual([
      expect.objectContaining({ type: "agent_disconnected", sessionId: "session-running" }),
    ]);
  });

  it("selectSession persists the active session", async () => {
    const { store, workspaceState } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");

    manager.selectSession(session.sessionId);
    await Promise.resolve();

    expect(workspaceState.update).toHaveBeenCalledWith("spider.activeSession", session.sessionId);
  });

  it("startTask transitions through states and publishes events", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");
    const events: unknown[] = [];
    manager.onDidPublishEvent((event) => events.push(event));

    await manager.startTask(session.sessionId, "Create hello.txt");

    expect(session.status).toBe("COMPLETED");
    expect(cursorClient.createAgent).toHaveBeenCalledWith({
      name: "session-" + session.sessionId,
      workspacePath: "/workspace",
      disallowedTools: ["delete", "applyAgentDiff", "mcp", "webFetch", "webSearch", "semSearch"],
    });
    expect(events.some((e) => (e as { type: string }).type === "agent_started")).toBe(true);
    expect(events.some((e) => (e as { type: string }).type === "agent_completed")).toBe(true);
  });

  it("cancelTask transitions to CANCELLED", async () => {
    const run = deferredRun();
    const { store } = createStore();
    const cursorClient = makeCursorClient(run.promise);
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");
    const startPromise = manager.startTask(session.sessionId, "Create hello.txt");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await manager.cancelTask(session.sessionId);
    run.resolve({ status: "cancelled" });
    await startPromise;

    expect(session.status).toBe("CANCELLED");
    expect(cursorClient.cancelRun).toHaveBeenCalled();
  });

  it("startTask throws when already running", async () => {
    const run = deferredRun();
    const { store } = createStore();
    const cursorClient = makeCursorClient(run.promise);
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const first = manager.startTask(session.sessionId, "First");

    await expect(manager.startTask(session.sessionId, "Second")).rejects.toThrow("already running");
    run.resolve({ status: "finished" });
    await first;
  });

  it("auto-allowed READ tool calls continue without cancelling the run", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("read", { file_path: "/workspace/file.txt" }),
    ]);
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const events: unknown[] = [];
    manager.onDidPublishEvent((event) => events.push(event));

    await manager.startTask(session.sessionId, "Read the file");

    expect(session.status).toBe("COMPLETED");
    expect(cursorClient.cancelRun).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_permission" }));
  });

  it("allows an EXECUTE tool call after PermissionManager resolves ALLOW", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("shell", { command: "npm test" }),
    ]);
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const requestPromise = new Promise<string>((resolve) => {
      permissionManager.onDidRequest((event) => {
        const typed = event as { type: string; request?: { requestId: string } };
        if (typed.type === "permission_requested" && typed.request) {
          resolve(typed.request.requestId);
        }
      });
    });
    const startPromise = manager.startTask(session.sessionId, "Run tests");
    const requestId = await requestPromise;

    permissionManager.resolveDecision({ requestId, decision: "ALLOW" });
    await startPromise;

    expect(session.status).toBe("COMPLETED");
    expect(cursorClient.cancelRun).not.toHaveBeenCalled();
    expect(permissionManager.pendingCount).toBe(0);
  });

  it("cancels the run when an EXECUTE permission is denied", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("shell", { command: "npm test" }),
    ]);
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const requestPromise = new Promise<string>((resolve) => {
      permissionManager.onDidRequest((event) => {
        const typed = event as { type: string; request?: { requestId: string } };
        if (typed.type === "permission_requested" && typed.request) {
          resolve(typed.request.requestId);
        }
      });
    });
    const startPromise = manager.startTask(session.sessionId, "Run tests");
    const requestId = await requestPromise;

    permissionManager.resolveDecision({ requestId, decision: "DENY" });
    await startPromise;

    expect(session.status).toBe("CANCELLED");
    expect(cursorClient.cancelRun).toHaveBeenCalled();
  });

  it("cancels the run when a permission times out", async () => {
    vi.useFakeTimers();
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("shell", { command: "npm test" }),
    ]);
    const permissionManager = makePermissionManager({ defaultTimeoutMs: 10 });
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const requestPromise = new Promise<string>((resolve) => {
      permissionManager.onDidRequest((event) => {
        const typed = event as { type: string; request?: { requestId: string } };
        if (typed.type === "permission_requested" && typed.request) {
          resolve(typed.request.requestId);
        }
      });
    });
    const startPromise = manager.startTask(session.sessionId, "Run tests");
    await requestPromise;

    await vi.advanceTimersByTimeAsync(10);
    await startPromise;

    expect(session.status).toBe("CANCELLED");
    expect(cursorClient.cancelRun).toHaveBeenCalled();
    expect(permissionManager.pendingCount).toBe(0);
  });

  it("cancels the run for a non-READ operation in an untrusted workspace", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("shell", { command: "npm test" }),
    ]);
    const permissionManager = makePermissionManager({ isWorkspaceTrusted: () => false });
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");

    await manager.startTask(session.sessionId, "Run tests");

    expect(session.status).toBe("CANCELLED");
    expect(cursorClient.cancelRun).toHaveBeenCalled();
    expect(permissionManager.pendingCount).toBe(0);
  });

  it("cleans up pending permission requests when the run is cancelled", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("shell", { command: "npm test" }),
    ]);
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const requestPromise = new Promise<string>((resolve) => {
      permissionManager.onDidRequest((event) => {
        const typed = event as { type: string; request?: { requestId: string } };
        if (typed.type === "permission_requested" && typed.request) {
          resolve(typed.request.requestId);
        }
      });
    });
    const startPromise = manager.startTask(session.sessionId, "Run tests");
    await requestPromise;

    await manager.cancelTask(session.sessionId);
    await startPromise;

    expect(permissionManager.pendingCount).toBe(0);
    expect(session.status).toBe("CANCELLED");
  });

  it("does not include API-key fields in permission events", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      toolCallMessage("read", { file_path: "/workspace/file.txt" }),
    ]);
    const permissionManager = makePermissionManager();
    const manager = new AgentManager(cursorClient, store, permissionManager);
    const session = manager.createSession("/workspace");
    const events: unknown[] = [];
    manager.onDidPublishEvent((event) => events.push(event));

    await manager.startTask(session.sessionId, "Read the file");

    const permissionEvent = events.find((event) => (event as { type?: string }).type === "agent_permission");
    expect(JSON.stringify(permissionEvent)).not.toContain("apiKey");
    expect(JSON.stringify(permissionEvent)).not.toContain("token");
  });

  it("publishes assistant stream text", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient(undefined, [
      {
        kind: "assistant",
        message: { type: "assistant", text: "Hello from Cursor" },
      },
    ]);
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");
    const events: unknown[] = [];
    manager.onDidPublishEvent((event) => events.push(event));

    await manager.startTask(session.sessionId, "Hi");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assistant_message", message: "Hello from Cursor" }),
      ]),
    );
  });

  it("rejects startTask when no API key is configured", async () => {
    const { store } = createStore();
    const cursorClient = makeCursorClient();
    vi.mocked(cursorClient.hasApiKey).mockReturnValue(false);
    const manager = new AgentManager(cursorClient, store, makePermissionManager());
    const session = manager.createSession("/workspace");

    await expect(manager.startTask(session.sessionId, "Hi")).rejects.toThrow("Connect a Cursor API key");
  });
});
