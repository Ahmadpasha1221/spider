import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../../../src/webview/messageRouter";
import type { SecretStorage } from "../../../src/auth/secretStorage";
import type { RuntimeModel } from "../../../src/runtime/runtimeTypes";

function memorySecrets(initial?: string): SecretStorage {
  let value = initial;
  return {
    get: vi.fn(async () => value),
    store: vi.fn(async (_key: string, next: string) => {
      value = next;
    }),
    delete: vi.fn(async () => {
      value = undefined;
    }),
  };
}

const MODELS: RuntimeModel[] = [
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "openrouter",
    contextWindow: 200000,
    capabilities: { streaming: true, toolCalling: true, structuredOutput: true, vision: true },
    pricing: { promptUsdPerMillion: 3, completionUsdPerMillion: 15 },
  },
];

describe("MessageRouter OpenRouter", () => {
  it("connects with the API key, stores it as a secret, and reports status without echoing it", async () => {
    const secrets = memorySecrets();
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider: vi.fn(async () => undefined),
        getProviderConfig: () => ({ provider: "openrouter", modelId: undefined }),
        checkAvailability: vi.fn(async () => ({ available: true, status: "connected" })),
        listSessions: () => [],
        createSession: vi.fn(),
        provider: "openrouter",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "CONNECT_OPENROUTER", apiKey: "sk-or-test" }) as {
      type: string;
      connected: boolean;
      error?: string;
    };

    expect(result.type).toBe("RUNTIME_STATUS");
    expect(result.connected).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sk-or-test");
    // Credentials are keyed by profile id; the legacy single key is migrated
    // away on the first write (see messageRouter.providerProfiles.test.ts).
    expect(secrets.store).toHaveBeenCalledWith("codeviaCursor.provider.openrouter-default.apiKey", "sk-or-test");
    expect(secrets.delete).toHaveBeenCalledWith("codeviaCursor.openrouter.key");
  });

  it("rejects connecting without an API key", async () => {
    const secrets = memorySecrets();
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "openrouter", getProviderConfig: () => ({ provider: "openrouter" }) } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "CONNECT_OPENROUTER", apiKey: "   " }) as { error?: string };
    expect(result.error).toContain("Enter an OpenRouter API key");
  });

  it("discovers models through the runtime manager and returns dropdown options", async () => {
    const secrets = memorySecrets("sk-or-stored");
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }),
        discoverModels: vi.fn(async () => MODELS),
        provider: "openrouter",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "DISCOVER_OPENROUTER_MODELS" }) as {
      type: string;
      models: Array<{ id: string; name: string; contextWindow?: number }>;
      error?: string;
    };

    expect(result.type).toBe("OPENROUTER_MODELS");
    expect(result.error).toBeUndefined();
    expect(result.models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      contextWindow: 200000,
    });
    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter" }));
  });

  it("returns an error when discovering models without a key", async () => {
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "openrouter", getProviderConfig: () => ({ provider: "openrouter" }) } as never,
      memorySecrets(undefined),
    );

    const result = await router.handleMessage({ type: "DISCOVER_OPENROUTER_MODELS" }) as {
      models: unknown[];
      error?: string;
    };
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain("Connect OpenRouter");
  });

  it("selects a model and persists it as the active configuration", async () => {
    const secrets = memorySecrets("sk-or-stored");
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4", apiKey: "sk-or-stored" }),
        listSessions: () => [{ sessionId: "s1" }],
        provider: "openrouter",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "SELECT_OPENROUTER_MODEL", modelId: "vendor/model" }) as {
      type: string;
      connected: boolean;
      modelId?: string;
    };

    expect(result.type).toBe("RUNTIME_STATUS");
    expect(result.connected).toBe(true);
    expect(result.modelId).toBe("anthropic/claude-sonnet-4");
    expect(setProvider).toHaveBeenCalled();
  });

  it("removes the stored key on disconnect", async () => {
    const secrets = memorySecrets("sk-or-stored");
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "openrouter", getProviderConfig: () => ({ provider: "openrouter" }) } as never,
      secrets,
    );

    await router.handleMessage({ type: "DISCONNECT_OPENROUTER" });
    expect(secrets.delete).toHaveBeenCalledWith("codeviaCursor.openrouter.key");
  });

  it("rejects malformed OpenRouter messages", async () => {
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      undefined,
      memorySecrets(),
    );

    await expect(router.handleMessage({ type: "CONNECT_OPENROUTER" })).rejects.toThrow("Invalid CONNECT_OPENROUTER");
    await expect(router.handleMessage({ type: "SELECT_OPENROUTER_MODEL", modelId: 42 })).rejects.toThrow("Invalid SELECT_OPENROUTER_MODEL");
  });
});
