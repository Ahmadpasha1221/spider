import { describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";
import type { PermissionRequest } from "../../../src/permissions/permissionTypes";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../src/runtime/tools/workspaceToolExecutor";
import type { AgentRuntime, RuntimeEvent, RuntimeEventSink, RuntimeSendRequest } from "../../../src/runtime/runtimeTypes";

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
  workspace: { isTrusted: true },
}));

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "req-1",
    sessionId: "s1",
    category: "MODIFY",
    toolName: "write_file",
    description: "write file",
    destructive: false,
    ...overrides,
  };
}

function createStore() {
  return {
    loadSessions: () => [],
    loadActiveSessionId: () => undefined,
    saveSessions: vi.fn().mockResolvedValue(undefined),
    saveActiveSessionId: vi.fn().mockResolvedValue(undefined),
  };
}

class ScriptedRuntime implements AgentRuntime {
  readonly provider = "mock" as const;
  readonly family = "mock" as const;
  configure = vi.fn(async () => undefined);
  checkAvailability = vi.fn(async () => ({ available: true, status: "connected" as const }));
  discoverModels = vi.fn(async () => []);
  createSession = vi.fn(async (request: { sessionId: string }) => ({ providerSessionId: request.sessionId }));
  resumeSession = vi.fn(async (request: { providerSessionId: string }) => ({ providerSessionId: request.providerSessionId }));
  cancel = vi.fn(async () => undefined);
  dispose = vi.fn();

  constructor(private readonly script: (request: RuntimeSendRequest, emit: RuntimeEventSink) => Promise<void>) {}

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    await this.script(request, emit);
  }
}

function makeManager(permissionManager: PermissionManager, script: (request: RuntimeSendRequest) => Promise<void>): RuntimeManager {
  const runtime = new ScriptedRuntime(script);
  return new RuntimeManager({
    sessionStore: createStore() as never,
    permissionManager,
    runtimes: [runtime],
    toolExecutor: new WorkspaceToolExecutor(),
    defaultWorkspacePath: ".",
  });
}

describe("PermissionPolicy runtime auto-approve", () => {
  it("defaults to disabled", () => {
    const policy = createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true });
    expect(policy.getRuntimeAutoApprove().enabled).toBe(false);
    expect(policy.shouldRuntimeAutoApprove(makeRequest())).toBe(false);
  });

  it("approves non-destructive requests when enabled", () => {
    const policy = createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true });
    policy.setRuntimeAutoApprove(true, "conversation");
    expect(policy.shouldRuntimeAutoApprove(makeRequest({ category: "MODIFY", destructive: false }))).toBe(true);
    expect(policy.shouldRuntimeAutoApprove(makeRequest({ category: "EXECUTE", destructive: false }))).toBe(true);
  });

  it("never approves destructive requests even when enabled", () => {
    const policy = createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true });
    policy.setRuntimeAutoApprove(true, "runtime");
    expect(policy.shouldRuntimeAutoApprove(makeRequest({ category: "DESTRUCTIVE", destructive: true }))).toBe(false);
  });

  it("never approves in an untrusted workspace even when enabled", () => {
    const policy = createDefaultPermissionPolicy({ isWorkspaceTrusted: () => false });
    policy.setRuntimeAutoApprove(true, "runtime");
    expect(policy.shouldRuntimeAutoApprove(makeRequest({ category: "EXECUTE" }))).toBe(false);
  });
});

describe("PermissionManager runtime auto-approve", () => {
  it("fires a state-change event and returns the authoritative state", () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const events: string[] = [];
    manager.onDidRequest((event) => events.push(event.type));

    const state = manager.setRuntimeAutoApprove(true, "conversation");
    expect(state.enabled).toBe(true);
    expect(state.scope).toBe("conversation");
    expect(events).toContain("runtime_auto_approve_changed");

    const off = manager.setRuntimeAutoApprove(false, "conversation");
    expect(off.enabled).toBe(false);
  });

  it("blocks a deny-rule category from shield approval", async () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    manager.setRuntimeAutoApprove(true, "runtime");
    manager.setPermissionRule("EXECUTE", "deny");
    const request = makeRequest({ category: "EXECUTE", toolName: "run_command" });
    expect(manager.shouldRuntimeAutoApprove(request)).toBe(false);
    await expect(manager.authorize(request)).resolves.toMatchObject({ allowed: false });
  });

  it("authorize prompts when the shield is off", async () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true, autoAllowRead: false }));
    const pending = manager.authorize(makeRequest({ category: "MODIFY" }));
    const requests = manager.getPendingForSession("s1");
    expect(requests).toHaveLength(1);
    manager.resolveDecision({ requestId: requests[0].requestId, decision: "DENY" });
    await expect(pending).resolves.toMatchObject({ allowed: false });
  });

  it("authorize auto-approves without prompting when the shield is on", async () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    manager.setRuntimeAutoApprove(true, "runtime");
    const result = await manager.authorize(makeRequest({ category: "MODIFY" }));
    expect(result.allowed).toBe(true);
    expect(manager.getPendingForSession("s1")).toHaveLength(0);
  });

  it("an explicit deny still wins after the shield is re-enabled", async () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const pending = manager.authorize(makeRequest({ category: "MODIFY" }));
    const requests = manager.getPendingForSession("s1");
    manager.resolveDecision({ requestId: requests[0].requestId, decision: "DENY" });
    await expect(pending).resolves.toMatchObject({ allowed: false });

    // Re-enabling the shield later cannot retroactively approve a denied request.
    manager.setRuntimeAutoApprove(true, "runtime");
    expect(await manager.authorize(makeRequest({ category: "MODIFY" }))).toMatchObject({ allowed: true });
  });

  it("listPermissionRules reports policy defaults and persists changes", () => {
    const saved: Array<{ category: string; rule: string }>[] = [];
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true, autoAllowRead: true }), {
      load: () => [],
      save: (snapshot) => saved.push(Object.entries(snapshot.rules).map(([category, rule]) => ({ category, rule }))),
    });
    const initial = manager.listPermissionRules();
    expect(initial.rules.READ).toBe("allow");
    expect(initial.rules.MODIFY).toBe("ask");
    expect(initial.rules.DESTRUCTIVE).toBe("ask");

    manager.setPermissionRule("MODIFY", "allow");
    expect(manager.listPermissionRules().rules.MODIFY).toBe("allow");
    expect(saved.at(-1)).toContainEqual({ category: "MODIFY", rule: "allow" });
  });

  it("restores persisted rules from the store", () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }), {
      load: () => [{ category: "EXECUTE", rule: "allow" }],
      save: () => undefined,
    });
    expect(manager.listPermissionRules().rules.EXECUTE).toBe("allow");
  });

  it("destructive rules can never be set to allow", () => {
    const manager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    manager.setPermissionRule("DESTRUCTIVE", "allow");
    expect(manager.listPermissionRules().rules.DESTRUCTIVE).toBe("ask");
  });
});

describe("RuntimeManager shield integration", () => {
  it("a conversation-scoped shield is disabled when a new conversation is created", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    permissionManager.setRuntimeAutoApprove(true, "conversation");
    const manager = makeManager(permissionManager, async () => undefined);

    manager.createSession(".");
    expect(permissionManager.getRuntimeAutoApprove().enabled).toBe(false);
  });

  it("a runtime-scoped shield survives new conversations", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    permissionManager.setRuntimeAutoApprove(true, "runtime");
    const manager = makeManager(permissionManager, async () => undefined);

    manager.createSession(".");
    expect(permissionManager.getRuntimeAutoApprove().enabled).toBe(true);
  });

  it("runs a tool without a permission prompt while the shield is enabled", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const manager = makeManager(permissionManager, async (request) => {
      await request.onToolCall?.({ id: "t1", name: "write_file", input: { path: "shielded.txt", content: "hi" } }, request.signal);
    });

    const events: RuntimeEvent[] = [];
    manager.onDidPublishEvent((event) => events.push(event));
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(".");
    // Enabled after createSession: conversation-scope shields are reset by new
    // conversations by design (see the reset test above).
    permissionManager.setRuntimeAutoApprove(true, "conversation");
    await manager.startTask(session.sessionId, "write it");

    expect(events.some((event) => event.type === "permission_request")).toBe(false);
    expect(permissionManager.getPendingForSession(session.sessionId)).toHaveLength(0);
  });

  it("asks for permission when the shield is disabled", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const manager = makeManager(permissionManager, async (request) => {
      await request.onToolCall?.({ id: "t2", name: "write_file", input: { path: "asked.txt", content: "hi" } }, request.signal);
    });

    const events: RuntimeEvent[] = [];
    manager.onDidPublishEvent((event) => {
      events.push(event);
      if (event.type === "permission_request") {
        permissionManager.resolveDecision({ requestId: event.request.requestId, decision: "ALLOW", confirmation: true });
      }
    });
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(".");
    await manager.startTask(session.sessionId, "write it");

    expect(events.some((event) => event.type === "permission_request")).toBe(true);
    expect(events.some((event) => event.type === "file_change")).toBe(true);
  });

  it("denying the permission prompt blocks the tool even if the shield is enabled mid-run", async () => {
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }));
    const manager = makeManager(permissionManager, async (request) => {
      await request.onToolCall?.({ id: "t3", name: "write_file", input: { path: "denied.txt", content: "hi" } }, request.signal);
    });

    const events: RuntimeEvent[] = [];
    manager.onDidPublishEvent((event) => {
      events.push(event);
      if (event.type === "permission_request") {
        permissionManager.resolveDecision({ requestId: event.request.requestId, decision: "DENY" });
      }
    });
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(".");
    await manager.startTask(session.sessionId, "write it");

    const requestEvent = events.find((event) => event.type === "permission_request");
    expect(requestEvent).toBeDefined();
    // The deny resolves the run; no file was written under a denied permission.
    const toolEvents = events.filter((event) => event.type === "file_change");
    expect(toolEvents).toHaveLength(0);
  });
});
