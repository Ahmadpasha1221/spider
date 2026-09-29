import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../../../src/webview/messageRouter";
import type { SecretStorage } from "../../../src/auth/secretStorage";
import { providerSecretKey } from "../../../src/auth/providerCredentials";

const OPENROUTER_PROFILE = "openrouter-default";
const LEGACY_OPENROUTER_KEY = "codeviaCursor.openrouter.key";

function keyedSecrets(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const storage = {
    get: vi.fn(async (key: string) => values[key]),
    store: vi.fn(async (key: string, value: string) => {
      values[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
  return { store: storage as unknown as SecretStorage, values };
}

describe("MessageRouter provider profiles", () => {
  it("stores the OpenRouter key under the profile-scoped secret key and clears the legacy one", async () => {
    const secrets = keyedSecrets();
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider: vi.fn(async () => undefined),
        getProviderConfig: () => ({ provider: "openrouter", profileId: OPENROUTER_PROFILE }),
        listSessions: () => [],
        createSession: vi.fn(),
        provider: "openrouter",
      } as never,
      secrets.store,
    );

    const result = await router.handleMessage({ type: "CONNECT_OPENROUTER", apiKey: "sk-or-test" }) as {
      type: string;
      connected: boolean;
    };

    expect(result.connected).toBe(true);
    expect(secrets.values).toEqual({ [providerSecretKey(OPENROUTER_PROFILE)]: "sk-or-test" });
    expect(secrets.values[LEGACY_OPENROUTER_KEY]).toBeUndefined();
  });

  it("re-hydrates the credential after a restart without the GUI ever seeing it", async () => {
    // A fresh router (new extension-host lifetime) with no in-memory provider
    // config: discovery must resolve the profile credential from SecretStorage.
    const secrets = keyedSecrets({ [providerSecretKey(OPENROUTER_PROFILE)]: "sk-or-restored" });
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "openrouter", profileId: OPENROUTER_PROFILE }),
        discoverModels: vi.fn(async () => []),
        provider: "openrouter",
      } as never,
      secrets.store,
    );

    const result = await router.handleMessage({ type: "DISCOVER_OPENROUTER_MODELS" });

    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter", apiKey: "sk-or-restored" }));
    expect(JSON.stringify(result)).not.toContain("sk-or-restored");
  });

  it("still honours a legacy-only key so existing installs keep working", async () => {
    const secrets = keyedSecrets({ [LEGACY_OPENROUTER_KEY]: "sk-or-legacy" });
    const setProvider = vi.fn(async () => undefined);
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      {
        setProvider,
        getProviderConfig: () => ({ provider: "openrouter", profileId: OPENROUTER_PROFILE }),
        discoverModels: vi.fn(async () => []),
        provider: "openrouter",
      } as never,
      secrets.store,
    );

    await router.handleMessage({ type: "DISCOVER_OPENROUTER_MODELS" });

    expect(setProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-or-legacy" }));
  });

  it("deletes both the profile credential and the legacy key on disconnect", async () => {
    const secrets = keyedSecrets({
      [providerSecretKey(OPENROUTER_PROFILE)]: "sk-or",
      [LEGACY_OPENROUTER_KEY]: "sk-or-legacy",
    });
    const router = new MessageRouter(
      {} as never,
      ".",
      undefined,
      undefined,
      { provider: "openrouter", getProviderConfig: () => ({ provider: "openrouter", profileId: OPENROUTER_PROFILE }) } as never,
      secrets.store,
    );

    await router.handleMessage({ type: "DISCONNECT_OPENROUTER" });

    expect(secrets.values).toEqual({});
  });
});
