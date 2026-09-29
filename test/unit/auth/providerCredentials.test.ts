import { describe, expect, it, vi } from "vitest";
import { createProviderCredentialStore, providerSecretKey } from "../../../src/auth/providerCredentials";
import type { SecretStorage } from "../../../src/auth/secretStorage";
import { profileIdFor } from "../../../src/session/providerConfigStore";

const OPENROUTER_PROFILE = profileIdFor("openrouter");
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
  return { store: storage as unknown as SecretStorage, values, storage };
}

function makeStore(initial: Record<string, string> = {}) {
  const secrets = keyedSecrets(initial);
  return {
    ...secrets,
    credentials: createProviderCredentialStore(secrets.store, {
      legacySecretKeys: { [OPENROUTER_PROFILE]: LEGACY_OPENROUTER_KEY },
    }),
  };
}

describe("providerCredentials", () => {
  it("namespaces the secret key by profile id", () => {
    expect(providerSecretKey("openrouter-default")).toBe("codeviaCursor.provider.openrouter-default.apiKey");
    expect(providerSecretKey("ollama-default")).not.toBe(providerSecretKey("openrouter-default"));
  });

  it("keeps credentials isolated per profile", async () => {
    const { credentials, values } = makeStore();
    await credentials.store("openrouter-default", "sk-or");
    await credentials.store("ollama-http-127-0-0-1-11434", "local-token");

    expect(await credentials.get("openrouter-default")).toBe("sk-or");
    expect(await credentials.get("ollama-http-127-0-0-1-11434")).toBe("local-token");
    expect(await credentials.get("other-profile")).toBeUndefined();
    expect(Object.keys(values).sort()).toEqual([
      "codeviaCursor.provider.ollama-http-127-0-0-1-11434.apiKey",
      "codeviaCursor.provider.openrouter-default.apiKey",
    ]);
  });

  it("falls back to the legacy pre-profile key for the migrated profile", async () => {
    const { credentials } = makeStore({ [LEGACY_OPENROUTER_KEY]: "sk-legacy" });
    expect(await credentials.get(OPENROUTER_PROFILE)).toBe("sk-legacy");
  });

  it("prefers the profile slot over the legacy key", async () => {
    const { credentials } = makeStore({
      [LEGACY_OPENROUTER_KEY]: "sk-legacy",
      [providerSecretKey(OPENROUTER_PROFILE)]: "sk-profile",
    });
    expect(await credentials.get(OPENROUTER_PROFILE)).toBe("sk-profile");
  });

  it("migrates away from the legacy key on the first write", async () => {
    const { credentials, values } = makeStore({ [LEGACY_OPENROUTER_KEY]: "sk-legacy" });

    await credentials.store(OPENROUTER_PROFILE, "sk-new");

    expect(values[providerSecretKey(OPENROUTER_PROFILE)]).toBe("sk-new");
    expect(values[LEGACY_OPENROUTER_KEY]).toBeUndefined();
    expect(await credentials.get(OPENROUTER_PROFILE)).toBe("sk-new");
  });

  it("delete removes both the profile slot and the legacy key", async () => {
    const { credentials, values, storage } = makeStore({
      [LEGACY_OPENROUTER_KEY]: "sk-legacy",
      [providerSecretKey(OPENROUTER_PROFILE)]: "sk-profile",
    });

    await credentials.delete(OPENROUTER_PROFILE);

    expect(values).toEqual({});
    expect(storage.delete).toHaveBeenCalledWith(providerSecretKey(OPENROUTER_PROFILE));
    expect(storage.delete).toHaveBeenCalledWith(LEGACY_OPENROUTER_KEY);
  });

  it("treats empty stored values as absent", async () => {
    const { credentials } = makeStore({ [providerSecretKey(OPENROUTER_PROFILE)]: "" });
    expect(await credentials.get(OPENROUTER_PROFILE)).toBeUndefined();
  });
});
