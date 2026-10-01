import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderConfigStore, profileIdFor } from "../../../src/session/providerConfigStore";
import { RuntimeManager } from "../../../src/runtime/runtimeManager";
import { WorkspaceToolExecutor } from "../../../src/runtime/tools/workspaceToolExecutor";
import { PermissionManager } from "../../../src/permissions/permissionManager";
import { createDefaultPermissionPolicy } from "../../../src/permissions/permissionPolicy";
import type { RuntimeProviderConfig } from "../../../src/runtime/runtimeTypes";

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

function createMemento(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string) => values[key]),
    update: vi.fn(async (key: string, value: unknown) => {
      values[key] = value;
    }),
  };
}

/** Pre-rename key: migration source, read through the storage fallback. */
const LEGACY_KEY = "codeviaCursor.providerConfig";
/** Current key the active profile is projected into. */
const PROJECTION_KEY = "spider.providerConfig";

describe("ProviderConfigStore", () => {
  it("returns undefined when nothing is saved", () => {
    const store = new ProviderConfigStore(createMemento() as never);
    expect(store.load()).toBeUndefined();
    expect(store.loadProfiles()).toEqual({ profiles: [] });
  });

  it("saves provider, model, and baseUrl but never secrets", async () => {
    const values: Record<string, unknown> = {};
    const store = new ProviderConfigStore(createMemento(values) as never);
    const config: RuntimeProviderConfig = {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "gpt-4o-mini",
      apiKey: "sk-super-secret",
    };

    await store.save(config);

    // The single-slot projection is written under the current key; the
    // pre-rename key is only read as a fallback.
    const persisted = values[PROJECTION_KEY] as Record<string, unknown>;
    expect(persisted).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "gpt-4o-mini",
    });
    expect(JSON.stringify(values)).not.toContain("sk-super-secret");

    const profileId = profileIdFor("openai-compatible", "http://127.0.0.1:1234/v1");
    expect(store.load()).toEqual({
      profileId,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "gpt-4o-mini",
    });
    expect(store.loadProfiles()).toEqual({
      profiles: [
        {
          id: profileId,
          name: "OpenAI-compatible · http://127.0.0.1:1234/v1",
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:1234/v1",
          modelId: "gpt-4o-mini",
        },
      ],
      activeProfileId: profileId,
    });
  });

  it("migrates a legacy single-slot config into one active profile", () => {
    const values: Record<string, unknown> = {
      [LEGACY_KEY]: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    };
    const store = new ProviderConfigStore(createMemento(values) as never);

    const state = store.loadProfiles();
    expect(state.activeProfileId).toBe("openrouter-default");
    expect(state.profiles).toEqual([
      {
        id: "openrouter-default",
        name: "OpenRouter",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
      },
    ]);
    expect(store.load()).toEqual({
      profileId: "openrouter-default",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
  });

  it("keeps one profile per endpoint and switches the active profile", async () => {
    const values: Record<string, unknown> = {};
    const store = new ProviderConfigStore(createMemento(values) as never);

    await store.save({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", modelId: "qwen2.5" });
    await store.save({ provider: "ollama", baseUrl: "http://127.0.0.1:9999", modelId: "llama3" });
    await store.save({ provider: "openrouter", modelId: "vendor/model" });

    const state = store.loadProfiles();
    expect(state.profiles.map((profile) => profile.id)).toEqual([
      "ollama-http-127-0-0-1-11434",
      "ollama-http-127-0-0-1-9999",
      "openrouter-default",
    ]);
    expect(state.activeProfileId).toBe("openrouter-default");

    expect(await store.setActiveProfile("ollama-http-127-0-0-1-9999")).toBe(true);
    expect(store.load()).toMatchObject({ provider: "ollama", baseUrl: "http://127.0.0.1:9999", modelId: "llama3" });
    expect(await store.setActiveProfile("missing-profile")).toBe(false);
  });

  it("removes a profile and falls back to another active profile", async () => {
    const values: Record<string, unknown> = {};
    const store = new ProviderConfigStore(createMemento(values) as never);
    await store.save({ provider: "ollama", modelId: "qwen2.5" });
    await store.save({ provider: "openrouter", modelId: "vendor/model" });

    expect(await store.removeProfile("openrouter-default")).toBe(true);
    const state = store.loadProfiles();
    expect(state.profiles.map((profile) => profile.id)).toEqual(["ollama-default"]);
    expect(state.activeProfileId).toBe("ollama-default");
    expect(await store.removeProfile("openrouter-default")).toBe(false);
  });

  it("round-trips non-secret profile metadata", async () => {
    const values: Record<string, unknown> = {};
    const store = new ProviderConfigStore(createMemento(values) as never);
    await store.saveProfiles({
      profiles: [
        {
          id: "openrouter-default",
          name: "OpenRouter",
          provider: "openrouter",
          modelId: "vendor/model",
          metadata: { temperature: "0.2" },
        },
      ],
      activeProfileId: "openrouter-default",
    });

    expect(store.loadProfiles().profiles[0]?.metadata).toEqual({ temperature: "0.2" });
  });
});

function createStore() {
  return {
    loadSessions: () => [],
    loadActiveSessionId: () => undefined,
    saveSessions: vi.fn().mockResolvedValue(undefined),
    saveActiveSessionId: vi.fn().mockResolvedValue(undefined),
  };
}

describe("RuntimeManager provider restore", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codevia-provider-"));
  });

  function makeManager(memento: Record<string, unknown>): RuntimeManager {
    const configure = vi.fn(async () => undefined);
    return new RuntimeManager({
      sessionStore: createStore() as never,
      permissionManager: new PermissionManager(createDefaultPermissionPolicy({ isWorkspaceTrusted: () => true })),
      runtimes: [
        {
          provider: "ollama",
          family: "inference",
          configure: vi.fn(async () => undefined),
          checkAvailability: vi.fn(async () => ({ available: true, status: "connected" as const })),
          discoverModels: vi.fn(async () => []),
          createSession: vi.fn(async () => ({})),
          resumeSession: vi.fn(async () => ({})),
          sendMessage: vi.fn(async () => undefined),
          cancel: vi.fn(async () => undefined),
          dispose: vi.fn(),
        },
        {
          provider: "openrouter",
          family: "inference",
          configure,
          checkAvailability: vi.fn(async () => ({ available: true, status: "connected" as const })),
          discoverModels: vi.fn(async () => []),
          createSession: vi.fn(async () => ({})),
          resumeSession: vi.fn(async () => ({})),
          sendMessage: vi.fn(async () => undefined),
          cancel: vi.fn(async () => undefined),
          dispose: vi.fn(),
        },
      ],
      toolExecutor: new WorkspaceToolExecutor(),
      defaultWorkspacePath: root,
      providerConfigStore: new ProviderConfigStore(createMemento(memento) as never),
    });
  }

  it("defers the saved openrouter config to the caller so the secret can be re-attached", async () => {
    const memento: Record<string, unknown> = {
      [LEGACY_KEY]: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    };
    const manager = makeManager(memento);

    const restored = await manager.restoreProviderConfig();

    // Returned for the caller (extension.ts resolves the profile credential
    // from SecretStorage and then calls completeRestore), not applied here.
    expect(restored).toEqual({
      applied: false,
      config: {
        profileId: "openrouter-default",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4",
      },
    });
    expect(manager.provider).toBeUndefined();
  });

  it("applies a saved local provider config directly", async () => {
    const memento: Record<string, unknown> = {
      [LEGACY_KEY]: { provider: "ollama", modelId: "qwen2.5:0.5b-instruct", baseUrl: "http://127.0.0.1:11434" },
    };
    const manager = makeManager(memento);

    const restored = await manager.restoreProviderConfig();

    expect(restored).toEqual({
      applied: true,
      config: {
        profileId: "ollama-http-127-0-0-1-11434",
        provider: "ollama",
        modelId: "qwen2.5:0.5b-instruct",
        baseUrl: "http://127.0.0.1:11434",
      },
    });
    expect(manager.provider).toBe("ollama");
  });

  it("completes a credential-backed restore with the resolved secret only", async () => {
    const memento: Record<string, unknown> = {
      [LEGACY_KEY]: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    };
    const manager = makeManager(memento);
    const restored = await manager.restoreProviderConfig();

    await manager.completeRestore(restored!.config, "sk-or-restored");

    expect(manager.provider).toBe("openrouter");
    expect(manager.getProviderConfig()).toMatchObject({
      provider: "openrouter",
      profileId: "openrouter-default",
      modelId: "anthropic/claude-sonnet-4",
      apiKey: "sk-or-restored",
    });
    // The secret is only ever in memory / SecretStorage, never in the Memento.
    expect(JSON.stringify(memento)).not.toContain("sk-or-restored");
  });

  it("returns undefined when no provider was saved", async () => {
    const manager = makeManager({});
    expect(await manager.restoreProviderConfig()).toBeUndefined();
  });
});
