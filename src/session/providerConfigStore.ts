import * as vscode from "vscode";
import type { RuntimeProviderConfig } from "../runtime/runtimeTypes";

/**
 * Legacy single-slot key: still read (migration source) and still written (the
 * active profile is projected into it) so nothing downstream breaks.
 */
const LEGACY_PROVIDER_CONFIG_STORAGE_KEY = "codeviaCursor.providerConfig";
/** Profile list. Non-secret data only — credentials live in SecretStorage. */
const PROVIDER_PROFILES_STORAGE_KEY = "codeviaCursor.providerProfiles";

/**
 * A provider profile is the non-secret half of a connection: which provider,
 * which model, which endpoint. Its `id` is the ONLY thing needed to locate the
 * matching credential in SecretStorage, which is what keeps credential handling
 * generic (no per-provider branching anywhere in the host).
 */
export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly provider: RuntimeProviderConfig["provider"];
  readonly modelId?: string;
  readonly baseUrl?: string;
  /** Free-form non-secret provider settings (temperature, headers, …). */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ProviderProfileState {
  readonly profiles: readonly ProviderProfile[];
  readonly activeProfileId?: string;
}

/** Provider settings that persist across restarts. The API key never lands here. */
export interface PersistedProviderConfig {
  /** Identity of the active profile; keys its credential slot in SecretStorage. */
  readonly profileId?: string;
  readonly provider: RuntimeProviderConfig["provider"];
  readonly modelId?: string;
  readonly baseUrl?: string;
}

const PROVIDER_LABELS: Record<RuntimeProviderConfig["provider"], string> = {
  cursor: "Cursor",
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible",
  openrouter: "OpenRouter",
  mock: "Mock",
};

/**
 * Stable, provider-agnostic profile id. One profile per provider by default,
 * plus one per distinct endpoint so two self-hosted endpoints can each hold
 * their own credential.
 */
export function profileIdFor(provider: RuntimeProviderConfig["provider"], baseUrl?: string): string {
  const trimmed = baseUrl?.trim() ?? "";
  return `${provider}-${trimmed.length > 0 ? slug(trimmed) : "default"}`;
}

function slug(value: string): string {
  const slugged = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slugged.length > 0 ? slugged.slice(0, 48) : "default";
}

function profileNameFor(provider: RuntimeProviderConfig["provider"], baseUrl?: string): string {
  const label = PROVIDER_LABELS[provider] ?? provider;
  const trimmed = baseUrl?.trim() ?? "";
  return trimmed.length > 0 ? `${label} · ${trimmed}` : label;
}

/**
 * Persistence for provider profiles, stored in the extension's existing
 * workspace state (the same Memento used by SessionStore) so there is exactly
 * one settings store. Secrets stay out of this file entirely: they live in VS
 * Code SecretStorage, keyed per profile id (see `auth/providerCredentials.ts`).
 *
 * Backward compatibility: a pre-profile install only has the legacy
 * `codeviaCursor.providerConfig` record. `loadProfiles()` upgrades it in memory
 * into a single active profile, and every write keeps the legacy record in sync.
 */
export class ProviderConfigStore {
  constructor(private readonly workspaceState: vscode.Memento) {}

  /** Active profile projected into the legacy shape (with its profile id). */
  load(): PersistedProviderConfig | undefined {
    const state = this.loadProfiles();
    const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
    if (active) {
      return {
        profileId: active.id,
        provider: active.provider,
        ...(active.modelId ? { modelId: active.modelId } : {}),
        ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
      };
    }
    return this.loadLegacy();
  }

  /** All profiles plus the active one, migrating the legacy record on first read. */
  loadProfiles(): ProviderProfileState {
    const raw = this.workspaceState.get<unknown>(PROVIDER_PROFILES_STORAGE_KEY);
    if (isRecord(raw) && Array.isArray(raw.profiles)) {
      const profiles = raw.profiles.map(toProviderProfile).filter((profile): profile is ProviderProfile => profile !== undefined);
      if (profiles.length > 0) {
        const requested = typeof raw.activeProfileId === "string" ? raw.activeProfileId : undefined;
        const activeProfileId = requested && profiles.some((profile) => profile.id === requested)
          ? requested
          : profiles[0]?.id;
        return { profiles, ...(activeProfileId ? { activeProfileId } : {}) };
      }
    }

    const legacy = this.loadLegacy();
    if (!legacy) {
      return { profiles: [] };
    }
    const migrated = profileFromLegacy(legacy);
    return { profiles: [migrated], activeProfileId: migrated.id };
  }

  /**
   * Single write path for provider selection: upserts the profile the selection
   * resolves to (creating it if needed) and makes it active.
   */
  async save(config: RuntimeProviderConfig): Promise<ProviderProfile> {
    const selection: PersistedProviderConfig = {
      provider: config.provider,
      ...("modelId" in config && typeof config.modelId === "string" && config.modelId.length > 0
        ? { modelId: config.modelId }
        : {}),
      ...("baseUrl" in config && typeof config.baseUrl === "string" && config.baseUrl.length > 0
        ? { baseUrl: config.baseUrl }
        : {}),
    };
    return this.activate(selection);
  }

  /** Creates/updates the profile derived from a selection and marks it active. */
  async activate(selection: PersistedProviderConfig): Promise<ProviderProfile> {
    const state = this.loadProfiles();
    const id = selection.profileId ?? profileIdFor(selection.provider, selection.baseUrl);
    const existing = state.profiles.find((profile) => profile.id === id);
    const baseUrl = selection.baseUrl ?? existing?.baseUrl;
    const profile: ProviderProfile = {
      id,
      name: existing?.name ?? profileNameFor(selection.provider, baseUrl),
      provider: selection.provider,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(existing?.metadata ? { metadata: existing.metadata } : {}),
    };
    const profiles = existing
      ? state.profiles.map((candidate) => (candidate.id === id ? profile : candidate))
      : [...state.profiles, profile];
    await this.saveProfiles({ profiles, activeProfileId: id });
    return profile;
  }

  /** Persists the profile list and keeps the legacy projection in sync. */
  async saveProfiles(state: ProviderProfileState): Promise<void> {
    await this.workspaceState.update(PROVIDER_PROFILES_STORAGE_KEY, {
      profiles: state.profiles.map(toPlainProfile),
      ...(state.activeProfileId ? { activeProfileId: state.activeProfileId } : {}),
    });

    const active = state.profiles.find((profile) => profile.id === state.activeProfileId);
    if (!active) {
      return;
    }
    await this.workspaceState.update(LEGACY_PROVIDER_CONFIG_STORAGE_KEY, {
      provider: active.provider,
      ...(active.modelId ? { modelId: active.modelId } : {}),
      ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
    });
  }

  async setActiveProfile(profileId: string): Promise<boolean> {
    const state = this.loadProfiles();
    if (!state.profiles.some((profile) => profile.id === profileId)) {
      return false;
    }
    await this.saveProfiles({ profiles: state.profiles, activeProfileId: profileId });
    return true;
  }

  async removeProfile(profileId: string): Promise<boolean> {
    const state = this.loadProfiles();
    const profiles = state.profiles.filter((profile) => profile.id !== profileId);
    if (profiles.length === state.profiles.length) {
      return false;
    }
    const activeProfileId = state.activeProfileId === profileId ? profiles[0]?.id : state.activeProfileId;
    await this.saveProfiles({ profiles, ...(activeProfileId ? { activeProfileId } : {}) });
    return true;
  }

  private loadLegacy(): PersistedProviderConfig | undefined {
    const raw = this.workspaceState.get<unknown>(LEGACY_PROVIDER_CONFIG_STORAGE_KEY);
    if (!isRecord(raw) || typeof raw.provider !== "string" || raw.provider.length === 0) {
      return undefined;
    }
    return {
      provider: raw.provider as RuntimeProviderConfig["provider"],
      ...(typeof raw.modelId === "string" && raw.modelId.length > 0 ? { modelId: raw.modelId } : {}),
      ...(typeof raw.baseUrl === "string" && raw.baseUrl.length > 0 ? { baseUrl: raw.baseUrl } : {}),
    };
  }
}

function profileFromLegacy(config: PersistedProviderConfig): ProviderProfile {
  return {
    id: profileIdFor(config.provider, config.baseUrl),
    name: profileNameFor(config.provider, config.baseUrl),
    provider: config.provider,
    ...(config.modelId ? { modelId: config.modelId } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

function toProviderProfile(value: unknown): ProviderProfile | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  if (typeof value.provider !== "string" || value.provider.length === 0) {
    return undefined;
  }
  const metadata = isRecord(value.metadata)
    ? Object.fromEntries(
        Object.entries(value.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;
  return {
    id: value.id,
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : profileNameFor(value.provider as RuntimeProviderConfig["provider"]),
    provider: value.provider as RuntimeProviderConfig["provider"],
    ...(typeof value.modelId === "string" && value.modelId.length > 0 ? { modelId: value.modelId } : {}),
    ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** Plain, JSON-safe projection (drops `undefined` fields Memento cannot store). */
function toPlainProfile(profile: ProviderProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    ...(profile.modelId ? { modelId: profile.modelId } : {}),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.metadata ? { metadata: profile.metadata } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
