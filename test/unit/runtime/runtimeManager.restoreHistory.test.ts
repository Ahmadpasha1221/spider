import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";
import type {
  AgentRuntime,
  RestoredHistoryTurn,
  RuntimeEventSink,
  RuntimeSendRequest,
} from "../../../src/runtime/runtimeTypes";
import type { TranscriptEntry } from "../../../src/session/transcriptStore";

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

class SeedingRuntime implements AgentRuntime {
  readonly provider = "mock" as const;
  readonly family = "mock" as const;
  seeded: RestoredHistoryTurn[][] = [];
  configure = vi.fn(async () => undefined);
  checkAvailability = vi.fn(async () => ({ available: true, status: "connected" as const }));
  discoverModels = vi.fn(async () => []);
  createSession = vi.fn(async (request: { sessionId: string }) => ({ providerSessionId: request.sessionId }));
  resumeSession = vi.fn(async (request: { providerSessionId: string }) => ({ providerSessionId: request.providerSessionId }));
  cancel = vi.fn(async () => undefined);
  dispose = vi.fn();

  restoreHistory = vi.fn((_sessionId: string, turns: readonly RestoredHistoryTurn[]): boolean => {
    this.seeded.push([...turns]);
    return true;
  });

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    await emit({ type: "assistant_message", sessionId: request.sessionId, message: "ok", timestamp: Date.now() });
  }
}

const cannedTranscript: TranscriptEntry[] = [
  { kind: "user", text: "explain streaming", timestamp: 1 },
  { kind: "thinking", text: "Using read_file…", timestamp: 2 },
  { kind: "tool", text: "Used read_file src/a.ts", toolName: "read_file", timestamp: 3 },
  { kind: "assistant", text: "streaming works like this", timestamp: 4 },
];

describe("RuntimeManager history restoration", () => {
  it("seeds an empty provider history from the transcript once per session", async () => {
    const runtime = new SeedingRuntime();
    const transcriptStore = {
      load: vi.fn(async () => cannedTranscript),
      append: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    };
    const manager = new RuntimeManager({
      sessionStore: createStore() as never,
      permissionManager: new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true })),
      runtimes: [runtime],
      transcriptStore: transcriptStore as never,
      defaultWorkspacePath: ".",
    });
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(".");

    await manager.startTask(session.sessionId, "continue");
    expect(runtime.restoreHistory).toHaveBeenCalledTimes(1);
    // Text-only: tool/thinking entries never replay.
    expect(runtime.seeded[0]).toEqual([
      { role: "user", content: "explain streaming" },
      { role: "assistant", content: "streaming works like this" },
    ]);

    // Second run in the same lifetime does not re-seed.
    await manager.startTask(session.sessionId, "again");
    expect(runtime.restoreHistory).toHaveBeenCalledTimes(1);
  });

  it("emits partial usage for display without accumulating it", async () => {
    const runtime = new SeedingRuntime();
    const seen: string[] = [];
    const manager = new RuntimeManager({
      sessionStore: createStore() as never,
      permissionManager: new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true })),
      runtimes: [runtime],
      transcriptStore: { load: async () => [], append: async () => undefined, flush: async () => undefined } as never,
      defaultWorkspacePath: ".",
    });
    manager.onDidPublishEvent((event) => {
      if (event.type === "usage") {
        seen.push(event.partial ? `partial:${event.usage.totalTokens}` : `final:${event.usage.totalTokens}`);
      }
    });
    await manager.setProvider({ provider: "mock" });
    const session = manager.createSession(".");
    await manager.startTask(session.sessionId, "hi");
    // No usage flowed in this scripted run; totals stay zero and no crash.
    expect(manager.getUsage(session.sessionId).totalTokens).toBe(0);
    expect(seen).toEqual([]);
  });
});
