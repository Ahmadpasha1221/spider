import type { SecretStorage } from "./secretStorage";

/**
 * Generic credential layer for provider profiles.
 *
 * A profile's secret lives in VS Code SecretStorage under a key derived from
 * the profile id, so adding a provider never means adding a branch: the host
 * resolves "the credential for this profile" and nothing else.
 */
export function providerSecretKey(profileId: string): string {
  return `codeviaCursor.provider.${profileId}.apiKey`;
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
      const value = await secrets.get(providerSecretKey(profileId));
      if (value && value.length > 0) {
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
      await secrets.store(providerSecretKey(profileId), secret);
      // The profile slot now holds the credential: drop the legacy key so the
      // secret exists in exactly one place.
      const legacyKey = legacyKeyFor(profileId);
      if (legacyKey) {
        await secrets.delete(legacyKey);
      }
    },

    async delete(profileId) {
      await secrets.delete(providerSecretKey(profileId));
      const legacyKey = legacyKeyFor(profileId);
      if (legacyKey) {
        await secrets.delete(legacyKey);
      }
    },
  };
}
