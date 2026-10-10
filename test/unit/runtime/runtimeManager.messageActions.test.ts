import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../src/runtime/tools/workspaceToolExecutor";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";
import { availableToolNames } from "../../../src/runtime/tools/toolAvailability";
import { LOCAL_TOOL_NAMES } from "../../../src/runtime/tools/toolRegistry";
import { TranscriptStore } from "../../../src/session/transcriptStore";
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
    loadTaskPlans: () => ({}),
    saveTaskPlans: vi.fn().mockResolvedValue(undefined),
    loadCheckpoints: () => ({}),
    saveCheckpoints: vi.fn().mockResolvedValue(undefined),
  };
}

class ScriptedRuntime implements AgentRuntime {
  readonly provider = "mock" as const;
  readonly family = "mock" as const;
  calls: RuntimeSendRequest[] = [];
  configure = vi.fn(async () => undefined);
  checkAvailability = vi.fn(async () => ({ available: true, status: "connected" as const }));
  discoverModels = vi.fn(async () => []);
  createSession = vi.fn(async (request: { sessionId: string }) => ({ providerSessionId: request.sessionId }));
  resumeSession = vi.fn(async (request: { providerSessionId: string }) => ({ providerSessionId: request.providerSessionId }));
  cancel = vi.fn(async () => undefined);
  dispose = vi.fn();

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    this.calls.push(request);
    await emit({ type: "assistant_message", sessionId: request.sessionId, message: "All done", timestamp: Date.now() });
  }
}

async function makeManager() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-msgactions-"));
  const transcriptStore = new TranscriptStore({ fsPath: root } as never);
  const permissionManager = new PermissionManager(
    createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }),
  );
  const runtime = new ScriptedRuntime();
  const manager = new RuntimeManager({
    sessionStore: createStore() as never,
    permissionManager,
    runtimes: [runtime],
    toolExecutor: new WorkspaceToolExecutor(),
    defaultWorkspacePath: root,
    transcriptStore,
  });
  await manager.setProvider({ provider: "mock" });
  const session = manager.createSession(root);
  return { manager, runtime, session, root };
}

describe("RuntimeManager message actions", () => {
  it("stamps assistant replies with a transcript id and publishes it", async () => {
    const { manager, session, root } = await makeManager();
    const published: RuntimeEvent[] = [];
    manager.onDidPublishEvent((event) => published.push(event));

    await manager.startTask(session.sessionId, "hello");

    const assistantEvent = published.find((event) => event.type === "assistant_message");
    expect(assistantEvent?.type).toBe("assistant_message");
    const messageId = assistantEvent && assistantEvent.type === "assistant_message" ? assistantEvent.messageId : undefined;
    expect(typeof messageId).toBe("string");

    const entries = await manager.loadTranscript(session.sessionId);
    const assistantEntry = entries.find((entry) => entry.kind === "assistant");
    expect(assistantEntry?.id).toBe(messageId);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("records the composer-provided user message id", async () => {
    const { manager, session, root } = await makeManager();

    await manager.startTask(session.sessionId, "typed by the user", undefined, false, "user-msg-1");

    const entries = await manager.loadTranscript(session.sessionId);
    expect(entries[0]).toMatchObject({ kind: "user", text: "typed by the user", id: "user-msg-1" });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("deleteTranscriptEntry removes one message without touching the others", async () => {
    const { manager, session, root } = await makeManager();
    await manager.startTask(session.sessionId, "hello", undefined, false, "user-msg-1");

    const before = await manager.loadTranscript(session.sessionId);
    const assistantEntry = before.find((entry) => entry.kind === "assistant");
    expect(assistantEntry?.id).toBeTruthy();

    await manager.deleteTranscriptEntry(session.sessionId, assistantEntry!.id!);

    const after = await manager.loadTranscript(session.sessionId);
    expect(after.some((entry) => entry.kind === "assistant")).toBe(false);
    expect(after.some((entry) => entry.id === "user-msg-1")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("createCheckpoint snapshots the timeline without a repo (manual CHECKPOINT_NOW path)", async () => {
    const { manager, session, root } = await makeManager();
    const gitCalls: unknown[] = [];
    (manager as unknown as { options: { gitExec: unknown } }).options = {
      ...(manager as unknown as { options: Record<string, unknown> }).options,
      gitExec: async () => {
        gitCalls.push(1);
        return { stdout: "", stderr: "not a git repo", exitCode: 128 };
      },
    };

    const items = await manager.createCheckpoint(session.sessionId, "before risky edit");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: "before risky edit", changeCount: 0 });
    expect(items[0].gitSnapshot).toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("createCheckpoint records the git snapshot when one is captured", async () => {
    const { manager, session, root } = await makeManager();
    (manager as unknown as { options: { gitExec: unknown } }).options = {
      ...(manager as unknown as { options: Record<string, unknown> }).options,
      gitExec: async (_command: string, args: readonly string[]) => {
        if (args[0] === "rev-parse") {
          return { stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "stash" && args[1] === "push") {
          return { stdout: "Saved working directory", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const items = await manager.createCheckpoint(session.sessionId, "git backed");
    expect(items[0]).toMatchObject({ label: "git backed", gitSnapshot: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("persists the checkpoint timeline and restores it on a fresh manager", async () => {
    const saved: Record<string, unknown> = {};
    const store = {
      loadSessions: () => [],
      loadActiveSessionId: () => undefined,
      saveSessions: vi.fn().mockResolvedValue(undefined),
      saveActiveSessionId: vi.fn().mockResolvedValue(undefined),
      loadTaskPlans: () => ({}),
      saveTaskPlans: vi.fn().mockResolvedValue(undefined),
      loadCheckpoints: () => saved,
      saveCheckpoints: vi.fn(async (value: Record<string, unknown>) => {
        for (const key of Object.keys(saved)) {
          delete saved[key];
        }
        Object.assign(saved, value);
      }),
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-checkpoint-persist-"));
    const transcriptStore = new TranscriptStore({ fsPath: root } as never);
    const permissionManager = new PermissionManager(
      createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true }),
    );
    const runtime = new ScriptedRuntime();
    const first = new RuntimeManager({
      sessionStore: store as never,
      permissionManager,
      runtimes: [runtime],
      toolExecutor: new WorkspaceToolExecutor(),
      defaultWorkspacePath: root,
      transcriptStore,
      gitExec: async () => ({ stdout: "", stderr: "not a repo", exitCode: 128 }),
    });
    await first.setProvider({ provider: "mock" });
    const session = first.createSession(root);
    await first.createCheckpoint(session.sessionId, "survives restart");

    const second = new RuntimeManager({
      sessionStore: {
        ...store,
        loadSessions: () => [
          {
            sessionId: session.sessionId,
            provider: "mock",
            workspacePath: root,
            status: "IDLE",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      } as never,
      permissionManager,
      runtimes: [runtime],
      toolExecutor: new WorkspaceToolExecutor(),
      defaultWorkspacePath: root,
      transcriptStore,
    });
    await second.restoreSessions();
    expect(second.listCheckpoints(session.sessionId).map((item) => item.label)).toEqual(["survives restart"]);
    await fs.rm(root, { recursive: true, force: true });
  });
});

/**
 * Regression guard: agent mode is an internal runtime concern. The shipped
 * path must always run with the full registered tool set, because a restricted
 * set makes the loop report registry-known tools (write_file, edit_file…) as
 * "Unknown tool", which breaks autonomous tool use.
 */
describe("RuntimeManager default tool availability", () => {
  it("runs every task in agent mode with the full registered tool set", async () => {
    const { manager, runtime, session, root } = await makeManager();

    await manager.startTask(session.sessionId, "create a python file");

    expect(runtime.calls.at(-1)?.mode).toBe("agent");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exposes every registered tool in the default mode", () => {
    const available = availableToolNames();
    for (const name of LOCAL_TOOL_NAMES) {
      expect(available).toContain(name);
    }
    expect(available).toContain("write_file");
    expect(available).toContain("edit_file");
    expect(available).toContain("read_file");
    expect(available).toContain("finish");
  });
});
