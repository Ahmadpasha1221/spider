import type {
  AgentRuntime,
  MockRuntimeConfig,
  ResolvedRuntimeConfig,
  RuntimeAvailability,
  RuntimeErrorCode,
  RuntimeEventSink,
  RuntimeModel,
  RuntimeProvider,
  RuntimeProviderFamily,
  RuntimeSendRequest,
  RuntimeSessionRequest,
  RuntimeSessionStatus,
  RuntimeToolCall,
  RuntimeCancelRequest,
  RuntimeResumeRequest,
} from "../runtimeTypes";
import { RuntimeError } from "../runtimeTypes";
import type { PermissionRequest } from "../../permissions/permissionTypes";

interface MockSession {
  sessionId: string;
  providerSessionId: string;
  status: RuntimeSessionStatus;
  workspacePath: string;
  modelId?: string;
  createdAt: Date;
  updatedAt: Date;
  currentTask?: string;
  error?: { message: string; category: string };
}

function createRuntimeError(code: RuntimeErrorCode, message: string, retryable = false): RuntimeError {
  return new RuntimeError(code, message, { retryable });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createRuntimeError("cancelled", "Operation cancelled"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(createRuntimeError("cancelled", "Operation cancelled"));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

function streamText(
  text: string,
  emit: RuntimeEventSink,
  sessionId: string,
  signal?: AbortSignal,
  chunkDelay = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks = text.split("");
    const processChunks = async () => {
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (signal?.aborted) {
            reject(createRuntimeError("cancelled", "Streaming cancelled"));
            return;
          }
          await delay(chunkDelay, signal);
          if (signal?.aborted) {
            reject(createRuntimeError("cancelled", "Streaming cancelled"));
            return;
          }
          await emit({ type: "text_delta", sessionId, text: chunks[i], timestamp: Date.now() });
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    processChunks();
  });
}

export class MockRuntime implements AgentRuntime {
  readonly provider: RuntimeProvider = "mock";
  readonly family: RuntimeProviderFamily = "mock";

  private config: ResolvedRuntimeConfig = {
    provider: "mock",
    scenario: "default",
    delayMs: 50,
  };
  private sessions = new Map<string, MockSession>();

  async configure(config: MockRuntimeConfig): Promise<void> {
    this.config = {
      provider: "mock",
      scenario: config.scenario ?? "default",
      delayMs: config.delayMs ?? 50,
    };
  }

  async checkAvailability(signal?: AbortSignal): Promise<RuntimeAvailability> {
    await delay(this.config.delayMs ?? 50, signal);

    const scenario = this.config.scenario ?? "default";
    if (scenario === "provider-unavailable") {
      return {
        available: false,
        status: "error",
        message: "Mock provider unavailable (simulated)",
      };
    }

    return {
      available: true,
      status: "connected",
    };
  }

  async discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    await delay(this.config.delayMs ?? 50, signal);

    const scenario = this.config.scenario ?? "default";
    if (scenario === "model-unavailable") {
      return [];
    }

    return [
      {
        id: "mock-model-1",
        name: "Mock Model 1",
        provider: "mock",
        contextWindow: 4096,
        capabilities: {
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          codeEditing: true,
          reasoning: false,
        },
      },
      {
        id: "mock-model-2",
        name: "Mock Model 2",
        provider: "mock",
        contextWindow: 8192,
        capabilities: {
          streaming: true,
          toolCalling: true,
          structuredOutput: true,
          codeEditing: true,
          reasoning: true,
        },
      },
    ];
  }

  async createSession(request: RuntimeSessionRequest): Promise<{ providerSessionId?: string }> {
    await delay(this.config.delayMs ?? 50);

    const providerSessionId = `mock-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: MockSession = {
      sessionId: request.sessionId,
      providerSessionId,
      status: "READY",
      workspacePath: request.workspacePath,
      modelId: request.modelId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(request.sessionId, session);
    return { providerSessionId };
  }

  async resumeSession(request: RuntimeResumeRequest): Promise<{ providerSessionId?: string }> {
    await delay(this.config.delayMs ?? 50);

    const session: MockSession = {
      sessionId: request.sessionId,
      providerSessionId: request.providerSessionId,
      status: "READY",
      workspacePath: request.workspacePath,
      modelId: request.modelId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(request.sessionId, session);
    return { providerSessionId: request.providerSessionId };
  }

  async sendMessage(request: RuntimeSendRequest, emit: RuntimeEventSink): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      throw createRuntimeError("session_not_found", `Conversation ${request.sessionId} not found`);
    }

    const scenario = this.config.scenario ?? "default";
    const baseDelay = this.config.delayMs ?? 50;
    const signal = request.signal;

    session.status = "RUNNING";
    session.updatedAt = new Date();
    session.currentTask = request.prompt.slice(0, 100);

    await emit({ type: "status", sessionId: request.sessionId, status: "RUNNING", timestamp: Date.now() });

    try {
      switch (scenario) {
        case "streaming": {
          await streamText(
            "This is a streaming response from the mock runtime. ",
            emit,
            request.sessionId,
            signal,
            5,
          );
          await streamText(
            "It demonstrates how text deltas are emitted over time. ",
            emit,
            request.sessionId,
            signal,
            5,
          );
          await streamText(
            "The final message will be emitted as assistant_message.",
            emit,
            request.sessionId,
            signal,
            5,
          );
          await emit({
            type: "assistant_message",
            sessionId: request.sessionId,
            message:
              "This is a streaming response from the mock runtime. It demonstrates how text deltas are emitted over time. The final message will be emitted as assistant_message.",
            timestamp: Date.now(),
          });
          break;
        }

        case "tool-calls": {
          const toolCall: RuntimeToolCall = {
            id: `tool-${Date.now()}`,
            name: "read_file",
            input: { path: "src/example.ts" },
          };
          await emit({ type: "tool_call", sessionId: request.sessionId, toolCall, timestamp: Date.now() });

          const response = await request.onToolCall?.(toolCall, signal);
          const toolResult = {
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: response?.allowed ? "File content here" : "Tool call denied",
            error: response?.allowed ? undefined : response?.error,
          };
          await emit({ type: "tool_result", sessionId: request.sessionId, toolResult, timestamp: Date.now() });

          await emit({
            type: "assistant_message",
            sessionId: request.sessionId,
            message: "Tool call completed successfully.",
            timestamp: Date.now(),
          });
          break;
        }

        case "error": {
          throw createRuntimeError("unknown", "Simulated error from mock runtime", true);
        }

        case "cancellation": {
          await delay(200, signal);
          await emit({
            type: "assistant_message",
            sessionId: request.sessionId,
            message: "Response before cancellation",
            timestamp: Date.now(),
          });
          break;
        }

        case "long-running": {
          await emit({ type: "thinking", sessionId: request.sessionId, message: "Starting long task...", timestamp: Date.now() });
          for (let i = 0; i < 5; i++) {
            await delay(100, signal);
            await emit({ type: "thinking", sessionId: request.sessionId, message: `Progress: ${(i + 1) * 20}%`, timestamp: Date.now() });
          }
          await emit({
            type: "assistant_message",
            sessionId: request.sessionId,
            message: "Long-running task completed.",
            timestamp: Date.now(),
          });
          break;
        }

        case "permission": {
          await emit({
            type: "permission_request",
            sessionId: request.sessionId,
            request: {
              requestId: `perm-${Date.now()}`,
              sessionId: request.sessionId,
              category: "MODIFY",
              toolName: "write_file",
              path: "test.txt",
              description: "Write to file",
              destructive: true,
            } satisfies PermissionRequest,
            timestamp: Date.now(),
          });
          break;
        }

        case "provider-unavailable": {
          throw createRuntimeError("provider_unavailable", "Provider unavailable (simulated)");
        }

        case "model-unavailable": {
          throw createRuntimeError("model_unavailable", "Model unavailable (simulated)");
        }

        default: {
          await delay(baseDelay, signal);
          await emit({
            type: "assistant_message",
            sessionId: request.sessionId,
            message: `Mock response to: ${request.prompt}`,
            timestamp: Date.now(),
          });
        }
      }

      session.status = "COMPLETED";
      session.updatedAt = new Date();
      await emit({ type: "completed", sessionId: request.sessionId, timestamp: Date.now() });
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "cancelled") {
        session.status = "CANCELLED";
        session.updatedAt = new Date();
        await emit({ type: "cancelled", sessionId: request.sessionId, timestamp: Date.now() });
        throw error;
      }
      session.status = "FAILED";
      session.updatedAt = new Date();
      session.error = { message: error instanceof Error ? error.message : "Unknown error", category: "runtime" };
      await emit({ type: "error", sessionId: request.sessionId, error: error as RuntimeError, timestamp: Date.now() });
      throw error;
    }
  }

  async cancel(request: RuntimeCancelRequest): Promise<void> {
    const session = this.sessions.get(request.sessionId);
    if (!session) {
      return;
    }

    session.status = "CANCELLING";
    session.updatedAt = new Date();

    if (request.signal?.aborted) {
      session.status = "CANCELLED";
      session.updatedAt = new Date();
      return;
    }

    await delay(10, request.signal);

    session.status = "CANCELLED";
    session.updatedAt = new Date();
  }

  dispose(): void {
    this.sessions.clear();
  }
}