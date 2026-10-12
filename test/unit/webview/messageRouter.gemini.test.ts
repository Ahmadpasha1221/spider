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
    id: "gemini-3.8-flash",
    name: "gemini-3.8-flash",
    provider: "gemini",
    capabilities: { streaming: true, toolCalling: true, structuredOutput: true },
  },
];

describe("MessageRouter Gemini", () => {
  it("connects, stores the key as a secret, and reports status without echoing it", async () => {
    const secrets = memorySecrets();
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "gemini", modelId: undefined }),
        checkAvailability: vi.fn(async () => ({ available: true, status: "connected" })),
        listSessions: () => [],
        createSession: vi.fn(),
        provider: "gemini",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "CONNECT_GEMINI", apiKey: "AIza-test" }) as {
      type: string;
      provider: string;
      connected: boolean;
      error?: string;
    };

    expect(result.type).toBe("RUNTIME_STATUS");
    expect(result.provider).toBe("gemini");
    expect(result.connected).toBe(true);
    expect(JSON.stringify(result)).not.toContain("AIza-test");
    expect(secrets.store).toHaveBeenCalledWith("spider.provider.gemini-default.apiKey", "AIza-test");
    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini" }));
  });

  it("rejects connecting without an API key", async () => {
    const secrets = memorySecrets();
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "gemini", getProviderConfig: () => ({ provider: "gemini" }) } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "CONNECT_GEMINI", apiKey: "   " }) as { error?: string };
    expect(result.error).toContain("Enter a Gemini API key");
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("discovers models through the runtime manager", async () => {
    const secrets = memorySecrets("AIza-stored");
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "gemini", modelId: "gemini-3.8-flash" }),
        discoverModels: vi.fn(async () => MODELS),
        provider: "gemini",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "DISCOVER_GEMINI_MODELS" }) as {
      type: string;
      models: Array<{ id: string; name: string }>;
      error?: string;
    };

    expect(result.type).toBe("GEMINI_MODELS");
    expect(result.error).toBeUndefined();
    expect(result.models[0]).toMatchObject({ id: "gemini-3.8-flash", name: "gemini-3.8-flash" });
    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini" }));
  });

  it("returns an error when discovering models without a key", async () => {
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "gemini", getProviderConfig: () => ({ provider: "gemini" }) } as never,
      memorySecrets(undefined),
    );

    const result = await router.handleMessage({ type: "DISCOVER_GEMINI_MODELS" }) as {
      models: unknown[];
      error?: string;
    };
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain("Connect Gemini");
  });

  it("selects a model and persists it", async () => {
    const secrets = memorySecrets("AIza-stored");
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "gemini", modelId: "gemini-3.8-flash", apiKey: "AIza-stored" }),
        listSessions: () => [{ sessionId: "s1" }],
        provider: "gemini",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "SELECT_GEMINI_MODEL", modelId: "gemini-2.5-pro" }) as {
      type: string;
      provider: string;
      connected: boolean;
    };

    expect(result.type).toBe("RUNTIME_STATUS");
    expect(result.connected).toBe(true);
    // The selection is applied through the runtime manager with the chosen id.
    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "gemini", modelId: "gemini-2.5-pro" }));
  });

  it("deletes only the Gemini credential on disconnect", async () => {
    const secrets = memorySecrets("AIza-stored");
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "gemini", getProviderConfig: () => ({ provider: "gemini" }) } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "DISCONNECT_GEMINI" }) as { provider: string; connected: boolean };
    expect(secrets.delete).toHaveBeenCalledWith("spider.provider.gemini-default.apiKey");
    expect(secrets.delete).not.toHaveBeenCalledWith("spider.provider.openrouter-default.apiKey");
    expect(result.connected).toBe(false);
  });

  it("rejects malformed Gemini messages", async () => {
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      undefined,
      memorySecrets(),
    );

    await expect(router.handleMessage({ type: "CONNECT_GEMINI" })).rejects.toThrow("Invalid CONNECT_GEMINI");
    await expect(router.handleMessage({ type: "SELECT_GEMINI_MODEL", modelId: 42 })).rejects.toThrow(
      "Invalid SELECT_GEMINI_MODEL",
    );
  });
});
