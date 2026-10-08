import type { PersistedProviderConfig } from "../../session/providerConfigStore";
import type {
  AgentRuntime,
  ResolvedRuntimeConfig,
  RuntimeProvider,
  RuntimeProviderConfig,
} from "../runtimeTypes";

export class ProviderUnavailableError extends Error {
  readonly provider: RuntimeProvider;
  readonly model?: string;
  readonly reason: string;

  constructor(provider: RuntimeProvider, model: string | undefined, reason: string) {
    super(`Provider "${provider}" is unavailable: ${reason}`);
    this.name = "ProviderUnavailableError";
    this.provider = provider;
    this.model = model;
    this.reason = reason;
  }
}

export class ProviderConfigurationMismatchError extends Error {
  readonly configuredProvider: string;
  readonly runtimeProvider: string;
  readonly configuredModel?: string;
  readonly runtimeModel?: string;

  constructor(details: {
    configuredProvider: string;
    runtimeProvider: string;
    configuredModel?: string;
    runtimeModel?: string;
  }) {
    super(
      `Provider configuration mismatch: configured provider is "${details.configuredProvider}" (model: ${details.configuredModel ?? "default"}), but runtime execution client is "${details.runtimeProvider}" (model: ${details.runtimeModel ?? "default"}). Refusing to execute request with mismatched provider.`
    );
    this.name = "ProviderConfigurationMismatchError";
    this.configuredProvider = details.configuredProvider;
    this.runtimeProvider = details.runtimeProvider;
    this.configuredModel = details.configuredModel;
    this.runtimeModel = details.runtimeModel;
  }
}

export interface ModelResolutionLog {
  readonly event: "model.resolve" | "model.request";
  readonly runId?: string;
  readonly sessionId?: string;
  readonly providerRequested?: string;
  readonly providerResolved?: string;
  readonly modelRequested?: string;
  readonly modelResolved?: string;
  readonly clientProvider?: string;
  readonly clientModel?: string;
  readonly configurationSource?: "activeConfig" | "persistedStore" | "sessionMetadata" | "default";
  readonly timestamp: number;
}

export interface ResolvedRuntimeModelConfig {
  readonly provider: RuntimeProvider;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly profileId?: string;
  readonly source: "activeConfig" | "persistedStore" | "sessionMetadata" | "default";
}

export interface ResolveRuntimeModelConfigOptions {
  activeConfig?: ResolvedRuntimeConfig | RuntimeProviderConfig;
  sessionConfig?: { provider?: RuntimeProvider; modelId?: string };
  persistedConfig?: PersistedProviderConfig;
  restoredCheckpoint?: { previousProvider?: string; previousModelId?: string };
  defaultProvider?: RuntimeProvider;
  defaultModelId?: string;
}

/**
 * Single authoritative configuration resolver enforcing Microsoft-style agent architecture.
 *
 * Precedence hierarchy:
 * 1. Explicit current user selection (`activeConfig`). Stale session/checkpoint metadata cannot override this.
 * 2. Persisted application configuration (`persistedConfig`) from the profile store.
 * 3. Session runtime configuration (`sessionConfig`), if valid and no higher precedence config exists.
 * 4. Safe default (`defaultProvider`, defaults to "ollama").
 */
export function resolveRuntimeModelConfig(
  optionsOrActive?: ResolveRuntimeModelConfigOptions | ResolvedRuntimeConfig | RuntimeProviderConfig,
  checkpointFallback?: { previousProvider?: string; previousModelId?: string }
): ResolvedRuntimeModelConfig {
  let options: ResolveRuntimeModelConfigOptions;
  if (
    optionsOrActive &&
    (
      "activeConfig" in optionsOrActive ||
      "sessionConfig" in optionsOrActive ||
      "persistedConfig" in optionsOrActive ||
      "restoredCheckpoint" in optionsOrActive ||
      "defaultProvider" in optionsOrActive
    )
  ) {
    options = optionsOrActive as ResolveRuntimeModelConfigOptions;
  } else {
    options = {
      activeConfig: optionsOrActive as (ResolvedRuntimeConfig | RuntimeProviderConfig | undefined),
      restoredCheckpoint: checkpointFallback,
    };
  }

  const {
    activeConfig,
    sessionConfig,
    persistedConfig,
    restoredCheckpoint,
    defaultProvider = "ollama",
    defaultModelId,
  } = options;

  // 1. Explicit current active configuration (User selected in Settings UI or runtime manager)
  if (activeConfig && activeConfig.provider) {
    return {
      provider: activeConfig.provider,
      modelId: "modelId" in activeConfig ? activeConfig.modelId : undefined,
      baseUrl: "baseUrl" in activeConfig ? activeConfig.baseUrl : undefined,
      apiKey: "apiKey" in activeConfig ? activeConfig.apiKey : undefined,
      profileId: "profileId" in activeConfig ? activeConfig.profileId : undefined,
      source: "activeConfig",
    };
  }

  // 2. Persisted application configuration (Saved profile from disk)
  if (persistedConfig && persistedConfig.provider) {
    return {
      provider: persistedConfig.provider,
      modelId: persistedConfig.modelId,
      baseUrl: persistedConfig.baseUrl,
      profileId: persistedConfig.profileId,
      source: "persistedStore",
    };
  }

  // 3. Current session runtime configuration (only if no active or persisted config exists)
  if (sessionConfig && sessionConfig.provider) {
    return {
      provider: sessionConfig.provider,
      modelId: sessionConfig.modelId,
      source: "sessionMetadata",
    };
  }

  // Historical checkpoint metadata is audit/diagnostic info only. If no other config exists at all:
  if (restoredCheckpoint && restoredCheckpoint.previousProvider) {
    return {
      provider: restoredCheckpoint.previousProvider as RuntimeProvider,
      modelId: restoredCheckpoint.previousModelId,
      source: "sessionMetadata",
    };
  }

  // 4. Safe default
  return {
    provider: defaultProvider,
    modelId: defaultModelId,
    source: "default",
  };
}

export interface ModelProvider {
  readonly id: RuntimeProvider;
  createClient(config: ResolvedRuntimeModelConfig): AgentRuntime;
  validateConfiguration(config: ResolvedRuntimeModelConfig): Promise<{ valid: boolean; error?: string }>;
}

export class ModelProviderFactory {
  private readonly providers = new Map<RuntimeProvider, ModelProvider>();
  private readonly runtimes = new Map<RuntimeProvider, AgentRuntime>();

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.provider, runtime);
  }

  getRuntime(providerId: RuntimeProvider): AgentRuntime | undefined {
    return this.runtimes.get(providerId);
  }

  createModelClient(config: ResolvedRuntimeModelConfig): AgentRuntime {
    const providerId = config.provider;

    // Check custom provider if registered
    const customProvider = this.providers.get(providerId);
    if (customProvider) {
      const client = customProvider.createClient(config);
      if (client.provider !== providerId) {
        throw new ProviderConfigurationMismatchError({
          configuredProvider: providerId,
          runtimeProvider: client.provider,
          configuredModel: config.modelId,
        });
      }
      return client;
    }

    // Check registered runtimes
    const runtime = this.runtimes.get(providerId);
    if (!runtime) {
      throw new ProviderUnavailableError(
        providerId,
        config.modelId,
        `No runtime adapter registered for provider "${providerId}".`
      );
    }

    // Critical invariant: NEVER allow silent fallback to another provider
    if (runtime.provider !== providerId) {
      throw new ProviderConfigurationMismatchError({
        configuredProvider: providerId,
        runtimeProvider: runtime.provider,
        configuredModel: config.modelId,
      });
    }

    return runtime;
  }

  async validateConfiguration(config: ResolvedRuntimeModelConfig): Promise<{ valid: boolean; error?: string }> {
    if (config.provider === "openrouter") {
      if (!config.apiKey || config.apiKey.trim().length === 0) {
        return {
          valid: false,
          error: "OpenRouter API key is missing. Connect an OpenRouter API key in Settings.",
        };
      }
      return { valid: true };
    }
    if (config.provider === "ollama") {
      return { valid: true };
    }
    return { valid: true };
  }

  invalidateClient(provider: RuntimeProvider): void {
    void provider;
  }

  invalidateAll(): void {
    // Clear any cached instances if needed
  }
}

export function assertProviderRuntimeMatch(
  resolvedConfig: ResolvedRuntimeModelConfig,
  runtime: AgentRuntime,
  sessionModelId?: string
): void {
  if (runtime.provider !== resolvedConfig.provider) {
    throw new ProviderConfigurationMismatchError({
      configuredProvider: resolvedConfig.provider,
      runtimeProvider: runtime.provider,
      configuredModel: resolvedConfig.modelId,
      runtimeModel: sessionModelId,
    });
  }
}

export function logModelResolution(
  logger: { info: (msg: string, ctx?: Record<string, unknown>) => void; debug?: (msg: string, ctx?: Record<string, unknown>) => void } | undefined,
  resolved: ResolvedRuntimeModelConfig,
  runtime: AgentRuntime,
  options: {
    runId?: string;
    sessionId?: string;
    requestedProvider?: string;
    requestedModel?: string;
  }
): void {
  if (!logger) {
    return;
  }

  const resolveLog: ModelResolutionLog = {
    event: "model.resolve",
    runId: options.runId,
    sessionId: options.sessionId,
    providerRequested: options.requestedProvider ?? resolved.provider,
    providerResolved: resolved.provider,
    modelRequested: options.requestedModel ?? resolved.modelId,
    modelResolved: resolved.modelId,
    clientProvider: runtime.provider,
    clientModel: resolved.modelId,
    configurationSource: resolved.source,
    timestamp: Date.now(),
  };

  logger.info(`Model resolved: ${resolved.provider} (${resolved.modelId ?? "default"})`, {
    operation: "model.resolve",
    sessionId: options.sessionId,
    outcome: JSON.stringify(resolveLog),
  });

  logger.info(`Model request: ${resolved.provider}`, {
    operation: "model.request",
    sessionId: options.sessionId,
    outcome: `provider=${resolved.provider}, model=${resolved.modelId ?? "default"}`,
  });
}
