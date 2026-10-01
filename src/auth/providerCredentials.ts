import type { SecretStorage } from "./secretStorage";
import { deleteSecret, providerSecretKeyPair, readSecret } from "../shared/storageKeys";

/**
 * Generic credential layer for provider profiles.
 *
 * A profile's secret lives in VS Code SecretStorage under a key derived from
 * the profile id, so adding a provider never means adding a branch: the host
 * resolves "the credential for this profile" and nothing else.
 */
export function providerSecretKey(profileId: string): string {
  return providerSecretKeyPair(profileId).current;
}

export interface ProviderCredentialStore {
  get(profileId: string): Promise<string | undefined>;
  store(profileId: string, secret: string): Promise<void>;
  delete(profileId: string): Promise<void>;
}

export interface ProviderCredentialStoreOptions {
  /**
   * profile id → legacy SecretStorage key. Used only for backward
   * compatibility with pre-profile builds (e.g. the single OpenRouter key):
   * `get` falls back to it and `store`/`delete` migrate it away.
   */
  readonly legacySecretKeys?: Readonly<Record<string, string>>;
}

export function createProviderCredentialStore(
  secrets: SecretStorage,
  options?: ProviderCredentialStoreOptions,
): ProviderCredentialStore {
  const legacyKeyFor = (profileId: string): string | undefined => options?.legacySecretKeys?.[profileId];

  return {
    async get(profileId) {
      // New (`spider.provider.<id>`), then pre-rename
      // (`codeviaCursor.provider.<id>`), then any shape-mismatched legacy key.
      const value = await readSecret(secrets, providerSecretKeyPair(profileId));
      if (value !== undefined) {
        return value;
      }
      const legacyKey = legacyKeyFor(profileId);
      if (!legacyKey) {
        return undefined;
      }
      const legacy = await secrets.get(legacyKey);
      return legacy && legacy.length > 0 ? legacy : undefined;
    },

    async store(profileId, secret) {
      await secrets.store(providerSecretKeyPair(profileId).current, secret);
      // The profile slot now holds the credential: drop the pre-rename slot and
      // any shape-mismatched legacy key so the secret exists in exactly one place.
      await secrets.delete(providerSecretKeyPair(profileId).legacy);
      const legacyKey = legacyKeyFor(profileId);
      if (legacyKey) {
        await secrets.delete(legacyKey);
      }
    },

    async delete(profileId) {
      await deleteSecret(secrets, providerSecretKeyPair(profileId));
      const legacyKey = legacyKeyFor(profileId);
      if (legacyKey) {
        await secrets.delete(legacyKey);
      }
    },
  };
}
