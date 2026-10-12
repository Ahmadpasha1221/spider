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
    id: "meta/llama-3.3-70b-instruct",
    name: "meta/llama-3.3-70b-instruct",
    provider: "nvidia",
    capabilities: { streaming: true, toolCalling: false, structuredOutput: false },
  },
];

describe("MessageRouter NVIDIA", () => {
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
        getProviderConfig: () => ({ provider: "nvidia", modelId: undefined }),
        checkAvailability: vi.fn(async () => ({ available: true, status: "connected" })),
        listSessions: () => [],
        createSession: vi.fn(),
        provider: "nvidia",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "CONNECT_NVIDIA", apiKey: "nvapi-test" }) as {
      type: string;
      provider: string;
      connected: boolean;
      error?: string;
    };

    expect(result.type).toBe("RUNTIME_STATUS");
    expect(result.provider).toBe("nvidia");
    expect(result.connected).toBe(true);
    expect(JSON.stringify(result)).not.toContain("nvapi-test");
    expect(secrets.store).toHaveBeenCalledWith("spider.provider.nvidia-default.apiKey", "nvapi-test");
    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "nvidia" }));
  });

  it("rejects connecting without an API key", async () => {
    const secrets = memorySecrets();
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "nvidia", getProviderConfig: () => ({ provider: "nvidia" }) } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "CONNECT_NVIDIA", apiKey: "   " }) as { error?: string };
    expect(result.error).toContain("Enter an NVIDIA API key");
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("discovers models through the runtime manager", async () => {
    const secrets = memorySecrets("nvapi-stored");
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "nvidia", modelId: "meta/llama-3.3-70b-instruct" }),
        discoverModels: vi.fn(async () => MODELS),
        provider: "nvidia",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "DISCOVER_NVIDIA_MODELS" }) as {
      type: string;
      models: Array<{ id: string; name: string; toolCalling?: boolean }>;
      error?: string;
    };

    expect(result.type).toBe("NVIDIA_MODELS");
    expect(result.error).toBeUndefined();
    expect(result.models[0]).toMatchObject({ id: "meta/llama-3.3-70b-instruct", name: "meta/llama-3.3-70b-instruct" });
    expect(result.models[0]?.toolCalling).toBe(false);
    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "nvidia" }));
  });

  it("returns an error when discovering models without a key", async () => {
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "nvidia", getProviderConfig: () => ({ provider: "nvidia" }) } as never,
      memorySecrets(undefined),
    );

    const result = await router.handleMessage({ type: "DISCOVER_NVIDIA_MODELS" }) as {
      models: unknown[];
      error?: string;
    };
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain("Connect NVIDIA");
  });

  it("selects a model and persists it", async () => {
    const secrets = memorySecrets("nvapi-stored");
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "nvidia", modelId: "meta/llama-3.3-70b-instruct", apiKey: "nvapi-stored" }),
        listSessions: () => [{ sessionId: "s1" }],
        provider: "nvidia",
      } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "SELECT_NVIDIA_MODEL", modelId: "qwen/qwen2.5-coder-32b-instruct" }) as {
      type: string;
      provider: string;
      connected: boolean;
    };

    expect(result.type).toBe("RUNTIME_STATUS");
    expect(result.connected).toBe(true);
    expect(setProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "nvidia", modelId: "qwen/qwen2.5-coder-32b-instruct" }),
    );
  });

  it("deletes only the NVIDIA credential on disconnect (Gemini isolation)", async () => {
    const secrets = memorySecrets("nvapi-stored");
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "nvidia", getProviderConfig: () => ({ provider: "nvidia" }) } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "DISCONNECT_NVIDIA" }) as { provider: string; connected: boolean };
    expect(secrets.delete).toHaveBeenCalledWith("spider.provider.nvidia-default.apiKey");
    expect(secrets.delete).not.toHaveBeenCalledWith("spider.provider.gemini-default.apiKey");
    expect(secrets.delete).not.toHaveBeenCalledWith("spider.provider.openrouter-default.apiKey");
    expect(result.connected).toBe(false);
  });

  it("does not reuse a Gemini credential when connecting NVIDIA with an empty key", async () => {
    // Key-aware SecretStorage: only the Gemini profile slot holds a value.
    const values: Record<string, string> = {
      "spider.provider.gemini-default.apiKey": "AIza-gemini-key",
    };
    const secrets = {
      get: vi.fn(async (key: string) => values[key]),
      store: vi.fn(async (key: string, value: string) => {
        values[key] = value;
      }),
      delete: vi.fn(async (key: string) => {
        delete values[key];
      }),
    } as unknown as SecretStorage;
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "gemini", getProviderConfig: () => ({ provider: "gemini" }), setProvider } as never,
      secrets,
    );

    const result = await router.handleMessage({ type: "DISCOVER_NVIDIA_MODELS" }) as { error?: string };
    // The NVIDIA profile has no credential; the Gemini key must not be used.
    expect(result.error).toContain("Connect NVIDIA");
    expect(setProvider).not.toHaveBeenCalled();
  });

  it("rejects malformed NVIDIA messages", async () => {
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      undefined,
      memorySecrets(),
    );

    await expect(router.handleMessage({ type: "CONNECT_NVIDIA" })).rejects.toThrow("Invalid CONNECT_NVIDIA");
    await expect(router.handleMessage({ type: "SELECT_NVIDIA_MODEL", modelId: 42 })).rejects.toThrow(
      "Invalid SELECT_NVIDIA_MODEL",
    );
  });
});
