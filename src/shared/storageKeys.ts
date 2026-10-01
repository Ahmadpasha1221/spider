import type * as vscode from "vscode";
import type { SecretStorage } from "../auth/secretStorage";

/**
 * Persistence keys were renamed from the old `codeviaCursor.*` prefix to
 * `spider.*` when the extension was renamed. Every entry pairs the new
 * (`current`) key with the pre-rename (`legacy`) one:
 *
 * - reads try `current` first, then fall back to `legacy`, so sessions,
 *   profiles and credentials created before the rename still load;
 * - writes always target `current`, so new state lands under the new prefix.
 *
 * Legacy values are intentionally left in place: they are harmless, bounded by
 * the number of pre-rename installs, and keeping them makes the fallback
 * idempotent across reloads.
 */
export interface KeyPair {
  readonly current: string;
  readonly legacy: string;
}

function pair(current: string, legacy: string): KeyPair {
  return { current, legacy };
}

/** WorkspaceState / Memento keys. */
export const STORAGE_KEYS = {
  permissionRules: pair("spider.permissionRules", "codeviaCursor.permissionRules"),
  sessions: pair("spider.sessions", "codeviaCursor.sessions"),
  activeSession: pair("spider.activeSession", "codeviaCursor.activeSession"),
  providerProfiles: pair("spider.providerProfiles", "codeviaCursor.providerProfiles"),
  providerConfig: pair("spider.providerConfig", "codeviaCursor.providerConfig"),
} as const;

/** SecretStorage keys. */
export const SECRET_KEYS = {
  cursorApiKey: pair("spider.token", "codeviaCursor.token"),
  cursorSession: pair("spider.session", "codeviaCursor.session"),
  openRouterApiKey: pair("spider.openrouter.key", "codeviaCursor.openrouter.key"),
  webSearchApiKey: pair("spider.webSearch.apiKey", "codeviaCursor.webSearch.apiKey"),
} as const;

/** Per-profile credential slot, mirroring the old `provider.<id>` key. */
export function providerSecretKeyPair(profileId: string): KeyPair {
  return pair(`spider.provider.${profileId}.apiKey`, `codeviaCursor.provider.${profileId}.apiKey`);
}

/** Reads `current`, falling back to `legacy` for pre-rename installs. */
export function readState<T>(
  memento: vscode.Memento,
  key: KeyPair,
  defaultValue?: T,
): T | undefined {
  const current = memento.get<T>(key.current);
  if (current !== undefined) {
    return current;
  }
  const legacy = memento.get<T>(key.legacy);
  return legacy !== undefined ? legacy : defaultValue;
}

/** Reads `current`, falling back to `legacy`; empty values count as absent. */
export async function readSecret(
  secrets: SecretStorage,
  key: KeyPair,
): Promise<string | undefined> {
  const current = await secrets.get(key.current);
  if (current && current.length > 0) {
    return current;
  }
  const legacy = await secrets.get(key.legacy);
  return legacy && legacy.length > 0 ? legacy : undefined;
}

/** Deletes both the current and legacy slot in one call. */
export async function deleteSecret(secrets: SecretStorage, key: KeyPair): Promise<void> {
  await secrets.delete(key.current);
  await secrets.delete(key.legacy);
}
