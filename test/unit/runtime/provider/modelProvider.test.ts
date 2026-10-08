import { describe, expect, it, vi } from "vitest";
import {
  assertProviderRuntimeMatch,
  logModelResolution,
  ModelProviderFactory,
  ProviderConfigurationMismatchError,
  ProviderUnavailableError,
  resolveRuntimeModelConfig,
} from "../../../../src/runtime/provider/modelProvider";
import type { AgentRuntime } from "../../../../src/runtime/runtimeTypes";

function createMockRuntime(provider: "openrouter" | "ollama" | "mock"): AgentRuntime {
  return {
    provider,
    family: "inference",
    configure: vi.fn().mockResolvedValue(undefined),
    checkAvailability: vi.fn().mockResolvedValue({ available: true, status: "connected" }),
    discoverModels: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ providerSessionId: `${provider}-session-1` }),
    resumeSession: vi.fn().mockResolvedValue({ providerSessionId: `${provider}-session-1` }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

describe("modelProvider Architecture", () => {
  describe("resolveRuntimeModelConfig", () => {
    it("satisfies the primary architectural requirement: active OpenRouter overrides restored Ollama checkpoint", () => {
      const currentConfig = {
        provider: "openrouter" as const,
        modelId: "inclusionAI/ling-3.0-flash-sante:free",
        apiKey: "sk-or-test-key",
      };

      const restoredCheckpoint = {
        previousProvider: "ollama",
        previousModelId: "llama3",
      };

      const runtimeConfig = resolveRuntimeModelConfig(currentConfig, restoredCheckpoint);

      expect(runtimeConfig.provider).toBe("openrouter");
      expect(runtimeConfig.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");
      expect(runtimeConfig.source).toBe("activeConfig");
    });

    it("prefers activeConfig over stale session metadata and persisted config", () => {
      const runtimeConfig = resolveRuntimeModelConfig({
        activeConfig: {
          provider: "openrouter",
          modelId: "inclusionAI/ling-3.0-flash-sante:free",
        },
        sessionConfig: {
          provider: "ollama",
          modelId: "llama3",
        },
        persistedConfig: {
          provider: "mock",
          modelId: "mock-model",
        },
      });

      expect(runtimeConfig.provider).toBe("openrouter");
      expect(runtimeConfig.modelId).toBe("inclusionAI/ling-3.0-flash-sante:free");
      expect(runtimeConfig.source).toBe("activeConfig");
    });

    it("prefers persisted application config over stale session metadata when activeConfig is absent", () => {
      const runtimeConfig = resolveRuntimeModelConfig({
        sessionConfig: {
          provider: "ollama",
          modelId: "llama3",
        },
        persistedConfig: {
          provider: "openrouter",
          modelId: "anthropic/claude-3.5-sonnet",
        },
      });

      expect(runtimeConfig.provider).toBe("openrouter");
      expect(runtimeConfig.modelId).toBe("anthropic/claude-3.5-sonnet");
      expect(runtimeConfig.source).toBe("persistedStore");
    });

    it("uses session metadata only when neither active nor persisted config exists", () => {
      const runtimeConfig = resolveRuntimeModelConfig({
        sessionConfig: {
          provider: "ollama",
          modelId: "qwen2.5",
        },
      });

      expect(runtimeConfig.provider).toBe("ollama");
      expect(runtimeConfig.modelId).toBe("qwen2.5");
      expect(runtimeConfig.source).toBe("sessionMetadata");
    });

    it("falls back to defaultProvider when all configurations are empty", () => {
      const runtimeConfig = resolveRuntimeModelConfig({
        defaultProvider: "ollama",
        defaultModelId: "default-model",
      });

      expect(runtimeConfig.provider).toBe("ollama");
      expect(runtimeConfig.modelId).toBe("default-model");
      expect(runtimeConfig.source).toBe("default");
    });
  });

  describe("ModelProviderFactory", () => {
    it("creates OpenRouter client when OpenRouter is selected", () => {
      const factory = new ModelProviderFactory();
      const openRouterRuntime = createMockRuntime("openrouter");
      const ollamaRuntime = createMockRuntime("ollama");

      factory.registerRuntime(openRouterRuntime);
      factory.registerRuntime(ollamaRuntime);

      const client = factory.createModelClient({
        provider: "openrouter",
        modelId: "inclusionAI/ling-3.0-flash-sante:free",
        source: "activeConfig",
      });

      expect(client).toBe(openRouterRuntime);
      expect(client.provider).toBe("openrouter");
    });

    it("creates Ollama client when Ollama is selected", () => {
      const factory = new ModelProviderFactory();
      const openRouterRuntime = createMockRuntime("openrouter");
      const ollamaRuntime = createMockRuntime("ollama");

      factory.registerRuntime(openRouterRuntime);
      factory.registerRuntime(ollamaRuntime);

      const client = factory.createModelClient({
        provider: "ollama",
        modelId: "llama3",
        source: "activeConfig",
      });

      expect(client).toBe(ollamaRuntime);
      expect(client.provider).toBe("ollama");
    });

    it("NEVER creates or returns an Ollama client when OpenRouter is selected", () => {
      const factory = new ModelProviderFactory();
      const openRouterRuntime = createMockRuntime("openrouter");
      const ollamaRuntime = createMockRuntime("ollama");

      factory.registerRuntime(openRouterRuntime);
      factory.registerRuntime(ollamaRuntime);

      const client = factory.createModelClient({
        provider: "openrouter",
        modelId: "inclusionAI/ling-3.0-flash-sante:free",
        source: "activeConfig",
      });

      expect(client).not.toBe(ollamaRuntime);
      expect(client.provider).not.toBe("ollama");
    });

    it("throws ProviderUnavailableError without silent fallback when provider is missing", () => {
      const factory = new ModelProviderFactory();
      const ollamaRuntime = createMockRuntime("ollama");
      factory.registerRuntime(ollamaRuntime);

      // openrouter requested but not registered; must NEVER fall back to ollama!
      expect(() =>
        factory.createModelClient({
          provider: "openrouter",
          modelId: "inclusionAI/ling-3.0-flash-sante:free",
          source: "activeConfig",
        }),
      ).toThrow(ProviderUnavailableError);
    });

    it("throws ProviderConfigurationMismatchError when runtime provider does not match config", () => {
      const factory = new ModelProviderFactory();
      // Malformed runtime whose provider property does not match its registration
      const fakeRuntime: AgentRuntime = {
        ...createMockRuntime("ollama"),
        provider: "ollama",
      };
      factory.registerRuntime(fakeRuntime);

      expect(() =>
        assertProviderRuntimeMatch(
          { provider: "openrouter", source: "activeConfig" },
          fakeRuntime,
          "test-model",
        ),
      ).toThrow(ProviderConfigurationMismatchError);
    });

    it("validates OpenRouter configuration and requires an API key", async () => {
      const factory = new ModelProviderFactory();

      const invalid = await factory.validateConfiguration({
        provider: "openrouter",
        modelId: "test-model",
        apiKey: "",
        source: "activeConfig",
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toContain("API key is missing");

      const valid = await factory.validateConfiguration({
        provider: "openrouter",
        modelId: "test-model",
        apiKey: "sk-or-v1-secret",
        source: "activeConfig",
      });
      expect(valid.valid).toBe(true);
    });
  });

  describe("Observability & Invariants", () => {
    it("assertProviderRuntimeMatch passes when provider matches", () => {
      const runtime = createMockRuntime("openrouter");
      expect(() =>
        assertProviderRuntimeMatch(
          { provider: "openrouter", modelId: "test-model", source: "activeConfig" },
          runtime,
        ),
      ).not.toThrow();
    });

    it("assertProviderRuntimeMatch throws descriptive error on mismatch", () => {
      const runtime = createMockRuntime("ollama");
      expect(() =>
        assertProviderRuntimeMatch(
          { provider: "openrouter", modelId: "inclusionAI/ling-3.0-flash-sante:free", source: "activeConfig" },
          runtime,
          "llama3",
        ),
      ).toThrow(
        /Provider configuration mismatch: configured provider is "openrouter".*but runtime execution client is "ollama"/,
      );
    });

    it("logModelResolution logs structured info without exposing secrets", () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const runtime = createMockRuntime("openrouter");

      logModelResolution(
        logger,
        {
          provider: "openrouter",
          modelId: "inclusionAI/ling-3.0-flash-sante:free",
          apiKey: "sk-secret-key-12345",
          source: "activeConfig",
        },
        runtime,
        {
          runId: "run-1",
          sessionId: "session-1",
          requestedProvider: "openrouter",
          requestedModel: "inclusionAI/ling-3.0-flash-sante:free",
        },
      );

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Model resolved: openrouter"),
        expect.objectContaining({
          operation: "model.resolve",
          outcome: expect.stringContaining('"event":"model.resolve"'),
        }),
      );

      // Verify no API key leaked in logged JSON
      const loggedJson = JSON.stringify(logger.info.mock.calls);
      expect(loggedJson).not.toContain("sk-secret-key-12345");
    });
  });
});
