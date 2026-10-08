import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeManager } from "../../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../../src/runtime/tools/workspaceToolExecutor";
import { PermissionManager } from "../../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../../src/permissions/permissionPolicy";
import type {
  AgentRuntime,
  RuntimeEventSink,
  RuntimeProvider,
  RuntimeSendRequest,
} from "../../../../src/runtime/runtimeTypes";
import type { PersistedProviderConfig } from "../../../../src/session/providerConfigStore";

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
  workspace: {
    openTextDocument: vi.fn(),
  },
  window: {
    showTextDocument: vi.fn(),
  },
}));

class TrackedRuntime implements AgentRuntime {
  readonly family = "inference" as const;
  configure = vi.fn().mockResolvedValue(undefined);
  checkAvailability = vi.fn().mockResolvedValue({ available: true, status: "connected" as const });
  discoverModels = vi.fn().mockResolvedValue([]);
  createSession = vi.fn().mockImplementation(async (req: { sessionId: string }) => ({
    providerSessionId: `${this.provider}-${req.sessionId}`,
  }));
  resumeSession = vi.fn().mockImplementation(async (req: { providerSessionId: string }) => ({
    providerSessionId: req.providerSessionId,
  }));
  cancel = vi.fn().mockResolvedValue(undefined);
  dispose = vi.fn();
  sendMessage = vi.fn().mockImplementation(async (req: RuntimeSendRequest, emit: RuntimeEventSink) => {
    emit({ type: "assistant_message", sessionId: req.sessionId, message: `Response from ${this.provider}`, timestamp: Date.now() });
    emit({ type: "agent_completed", sessionId: req.sessionId, timestamp: Date.now() });
  });

  constructor(readonly provider: RuntimeProvider) {}
}

function createSessionStore(initialSessions: unknown[] = [], activeId?: string) {
  let stored = [...initialSessions];
  let active = activeId;
  return {
    loadSessions: () => stored,
    loadActiveSessionId: () => active,
    saveSessions: vi.fn().mockImplementation(async (sessions: unknown[]) => {
      stored = [...sessions];
    }),
    saveActiveSessionId: vi.fn().mockImplementation(async (id?: string) => {
      active = id;
    }),
  };
}

function createConfigStore(initialConfig?: PersistedProviderConfig) {
  let saved = initialConfig;
  return {
    load: () => saved,
    save: vi.fn().mockImplementation(async (cfg: PersistedProviderConfig) => {
      saved = cfg;
    }),
  };
}

describe("Provider Architecture & Runtime State Integration", () => {
  async function createFixture(options?: {
    initialSessions?: unknown[];
    activeSessionId?: string;
    persistedConfig?: PersistedProviderConfig;
  }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "spider-provider-arch-"));
    const ollamaRuntime = new TrackedRuntime("ollama");
    const openRouterRuntime = new TrackedRuntime("openrouter");
    const mockRuntime = new TrackedRuntime("mock");

    const sessionStore = createSessionStore(options?.initialSessions, options?.activeSessionId);
    const providerConfigStore = createConfigStore(options?.persistedConfig);
    const permissionManager = new PermissionManager(createDefaultPermissionPolicy());
    const toolExecutor = new WorkspaceToolExecutor();

    const runtimeManager = new RuntimeManager({
      sessionStore: sessionStore as never,
      permissionManager,
      runtimes: [ollamaRuntime, openRouterRuntime, mockRuntime],
      toolExecutor,
      defaultWorkspacePath: root,
      providerConfigStore: providerConfigStore as never,
    });

    return {
      root,
      runtimeManager,
      ollamaRuntime,
      openRouterRuntime,
      mockRuntime,
      sessionStore,
      providerConfigStore,
    };
  }

  it("1 & 3. OpenRouter selected -> OpenRouter client executed; Ollama client is NEVER executed", async () => {
    const { runtimeManager, openRouterRuntime, ollamaRuntime } = await createFixture();

    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-test-key",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });

    const session = runtimeManager.createSession();
    await runtimeManager.startTask(session.sessionId, "hi");

    // OpenRouter MUST be called
    expect(openRouterRuntime.sendMessage).toHaveBeenCalled();
    const sendCall = openRouterRuntime.sendMessage.mock.calls[0][0];
    expect(sendCall.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");

    // Ollama MUST NEVER be called
    expect(ollamaRuntime.sendMessage).not.toHaveBeenCalled();
    expect(ollamaRuntime.createSession).not.toHaveBeenCalled();
  });

  it("2. Ollama selected -> Ollama client executed", async () => {
    const { runtimeManager, openRouterRuntime, ollamaRuntime } = await createFixture();

    await runtimeManager.setProvider({
      provider: "ollama",
      modelId: "llama3",
    });

    const session = runtimeManager.createSession();
    await runtimeManager.startTask(session.sessionId, "hi");

    expect(ollamaRuntime.sendMessage).toHaveBeenCalled();
    expect(openRouterRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("4. Switching Ollama -> OpenRouter updates runtime client and existing sessions", async () => {
    const { runtimeManager, openRouterRuntime, ollamaRuntime } = await createFixture();

    // Start with Ollama
    await runtimeManager.setProvider({ provider: "ollama", modelId: "llama3" });
    const session = runtimeManager.createSession();
    expect(session.provider).toBe("ollama");

    // Switch to OpenRouter without restarting
    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-valid-key",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });

    // Existing session MUST now be synchronized to OpenRouter
    const updatedSession = runtimeManager.getSession(session.sessionId);
    expect(updatedSession?.provider).toBe("openrouter");
    expect(updatedSession?.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");

    // Sending a prompt on the existing session MUST run through OpenRouter
    await runtimeManager.startTask(session.sessionId, "hi");
    expect(openRouterRuntime.sendMessage).toHaveBeenCalledTimes(1);
    expect(ollamaRuntime.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("5. Switching OpenRouter -> Ollama updates runtime client and existing sessions", async () => {
    const { runtimeManager, openRouterRuntime, ollamaRuntime } = await createFixture();

    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-key",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });
    const session = runtimeManager.createSession();

    await runtimeManager.setProvider({ provider: "ollama", modelId: "qwen2.5" });

    const updatedSession = runtimeManager.getSession(session.sessionId);
    expect(updatedSession?.provider).toBe("ollama");
    expect(updatedSession?.modelId).toBe("qwen2.5");

    await runtimeManager.startTask(session.sessionId, "hi");
    expect(ollamaRuntime.sendMessage).toHaveBeenCalledTimes(1);
    expect(openRouterRuntime.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("6. Restoring an old checkpoint while current provider is OpenRouter does NOT switch runtime back to Ollama", async () => {
    const { runtimeManager, openRouterRuntime, ollamaRuntime } = await createFixture();

    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-valid-key",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });
    const session = runtimeManager.createSession();

    // Execute first prompt
    await runtimeManager.startTask(session.sessionId, "hi");
    expect(openRouterRuntime.sendMessage).toHaveBeenCalledTimes(1);

    // List checkpoints created for "hi"
    const checkpoints = runtimeManager.listCheckpoints(session.sessionId);
    expect(checkpoints.length).toBeGreaterThan(0);

    // Restore checkpoint
    await runtimeManager.restoreCheckpoint(checkpoints[0].id);

    // Active provider MUST still be openrouter
    expect(runtimeManager.provider).toBe("openrouter");
    expect(runtimeManager.getProviderConfig()?.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");

    // Subsequent prompt MUST still run on OpenRouter, NEVER Ollama
    await runtimeManager.startTask(session.sessionId, "how are you");
    expect(openRouterRuntime.sendMessage).toHaveBeenCalledTimes(2);
    expect(ollamaRuntime.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("9. No silent provider fallback: missing OpenRouter API key throws error instead of falling back to Ollama", async () => {
    const { runtimeManager, ollamaRuntime } = await createFixture();

    // Set OpenRouter without an API key
    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });
    const session = runtimeManager.createSession();

    // startTask must fail with provider_unavailable indicating OpenRouter, NEVER silently execute Ollama
    await expect(runtimeManager.startTask(session.sessionId, "hi")).rejects.toThrow(
      /OpenRouter API key is missing/,
    );
    expect(ollamaRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("10. UI provider and runtime provider remain consistent", async () => {
    const { runtimeManager } = await createFixture();

    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-valid",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });

    const uiProvider = runtimeManager.provider;
    const uiConfig = runtimeManager.getProviderConfig();

    expect(uiProvider).toBe("openrouter");
    expect(uiConfig?.provider).toBe("openrouter");
    expect(uiConfig?.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");

    const session = runtimeManager.createSession();
    expect(session.provider).toBe("openrouter");
    expect(session.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");
  });

  it("11. Model switching works without application restart", async () => {
    const { runtimeManager, openRouterRuntime } = await createFixture();

    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-valid",
      modelId: "model-A",
    });
    const session = runtimeManager.createSession();
    await runtimeManager.startTask(session.sessionId, "prompt 1");
    expect(openRouterRuntime.sendMessage.mock.calls[0][0].modelId).toBe("model-A");

    // Switch model to model-B
    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-valid",
      modelId: "model-B",
    });
    await runtimeManager.startTask(session.sessionId, "prompt 2");
    expect(openRouterRuntime.sendMessage.mock.calls[1][0].modelId).toBe("model-B");
  });

  it("12. Session restoration preserves conversation state without overriding current runtime provider configuration", async () => {
    const oldSessionSavedUnderOllama = {
      sessionId: "session-from-yesterday",
      provider: "ollama",
      modelId: "old-llama-model",
      workspacePath: "/some/path",
      status: "IDLE",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const persistedOpenRouterConfig: PersistedProviderConfig = {
      provider: "openrouter",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    };

    const { runtimeManager, openRouterRuntime, ollamaRuntime } = await createFixture({
      initialSessions: [oldSessionSavedUnderOllama],
      activeSessionId: "session-from-yesterday",
      persistedConfig: persistedOpenRouterConfig,
    });

    // Configure OpenRouter as the active provider with API key
    await runtimeManager.setProvider({
      provider: "openrouter",
      apiKey: "sk-or-valid",
      modelId: "inclusionAI/ling-3.0-flash-sante:free",
    });

    // Restore sessions from store
    await runtimeManager.restoreSessions();

    const restoredSession = runtimeManager.getSession("session-from-yesterday");
    expect(restoredSession).toBeDefined();
    // Must be bound to OpenRouter, NOT the stale Ollama provider from yesterday
    expect(restoredSession?.provider).toBe("openrouter");
    expect(restoredSession?.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");

    // Execute run on the restored session: MUST execute via OpenRouter, NEVER Ollama
    await runtimeManager.startTask("session-from-yesterday", "hi");
    expect(openRouterRuntime.sendMessage).toHaveBeenCalledTimes(1);
    expect(ollamaRuntime.sendMessage).toHaveBeenCalledTimes(0);
  });
});
