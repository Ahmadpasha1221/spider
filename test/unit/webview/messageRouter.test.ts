import { describe, expect, it, vi } from "vitest";
import { MessageRouter } from "../../../src/webview/messageRouter";
import { AgentManager } from "../../../src/agent/agentManager";

describe("MessageRouter", () => {
  it("routes SEND_PROMPT to AgentManager", async () => {
    const agentManager = {
      startTask: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockReturnValue({ sessionId: "session-1" }),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    const result = await router.handleMessage({ type: "SEND_PROMPT", prompt: "Hello", sessionId: "session-1" });

    expect(result).toEqual({ success: true });
    expect(agentManager.startTask).toHaveBeenCalledWith("session-1", "Hello");
  });

  it("routes CANCEL_RUN to AgentManager", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    await router.handleMessage({ type: "CANCEL_RUN", sessionId: "session-1" });

    expect(agentManager.cancelTask).toHaveBeenCalledWith("session-1");
  });

  it("creates a session for NEW_SESSION", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn().mockReturnValue({ sessionId: "session-2" }),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    const result = await router.handleMessage({ type: "NEW_SESSION", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(agentManager.createSession).toHaveBeenCalledWith("/workspace");
  });

  it("uses the default workspace for NEW_SESSION", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn().mockReturnValue({ sessionId: "session-2" }),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager, "/default/workspace");
    await router.handleMessage({ type: "NEW_SESSION" });

    expect(agentManager.createSession).toHaveBeenCalledWith("/default/workspace");
  });

  it("selects an existing session", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
      selectSession: vi.fn().mockReturnValue(true),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    const result = await router.handleMessage({ type: "SELECT_SESSION", sessionId: "session-1" });

    expect(result).toEqual({ success: true, selected: true });
    expect(agentManager.selectSession).toHaveBeenCalledWith("session-1");
  });

  it("lists sessions", async () => {
    const sessions = [{ sessionId: "session-1" }];
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
      listSessions: vi.fn().mockReturnValue(sessions),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    const result = await router.handleMessage({ type: "LIST_SESSIONS" });

    expect(result).toEqual({ success: true, sessions });
  });

  it("throws on invalid message shape", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    await expect(router.handleMessage(null)).rejects.toThrow("Invalid message shape");
  });

  it("throws on unknown message type", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    await expect(router.handleMessage({ type: "UNKNOWN" })).rejects.toThrow("Unknown message type");
  });

  it("connects through the Cursor connection service", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;
    const connection = {
      connect: vi.fn().mockResolvedValue({ type: "AUTH_STATUS", status: "connected", hasKey: true, message: "pong" }),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
      restore: vi.fn(),
    };

    const router = new MessageRouter(agentManager, ".", connection);
    const result = await router.handleMessage({ type: "CONNECT_CURSOR", apiKey: "cursor_test" });

    expect(connection.connect).toHaveBeenCalledWith("cursor_test");
    expect(result).toEqual({ type: "AUTH_STATUS", status: "connected", hasKey: true, message: "pong" });
    expect(JSON.stringify(result)).not.toContain("cursor_test");
  });

  it("maps assistant events to AGENT_MESSAGE", () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;
    const router = new MessageRouter(agentManager);
    const message = router.toExtensionMessage({
      type: "assistant_message",
      sessionId: "session-1",
      message: "pong",
      timestamp: 1,
    });
    expect(message).toEqual({ type: "AGENT_MESSAGE", message: "pong" });
  });

  it("discovers Ollama models through the runtime manager", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;
    const runtimeManager = {
      setProvider: vi.fn().mockResolvedValue(undefined),
      discoverModels: vi.fn().mockResolvedValue([{ id: "qwen2.5:0.5b-instruct", name: "qwen2.5:0.5b-instruct", provider: "ollama" }]),
      listSessions: vi.fn().mockReturnValue([]),
      createSession: vi.fn().mockReturnValue({ sessionId: "local-1" }),
      provider: "ollama",
    };

    const router = new MessageRouter(agentManager, ".", undefined, undefined, runtimeManager as never);
    const result = await router.handleMessage({ type: "DISCOVER_LOCAL_MODELS", provider: "ollama" });

    expect(result).toEqual({
      type: "LOCAL_MODELS",
      provider: "ollama",
      models: [{ id: "qwen2.5:0.5b-instruct", name: "qwen2.5:0.5b-instruct", provider: "ollama" }],
    });
  });

  it("routes permission decisions to the runtime manager", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;
    const runtimeManager = {
      resolvePermission: vi.fn(),
      retryTask: vi.fn().mockResolvedValue(undefined),
      provider: "ollama",
    };

    const router = new MessageRouter(agentManager, ".", undefined, undefined, runtimeManager as never);
    await router.handleMessage({ type: "APPROVE_PERMISSION", requestId: "req-1" });
    await router.handleMessage({ type: "DENY_PERMISSION", requestId: "req-1" });
    await router.handleMessage({ type: "TRY_AGAIN", sessionId: "session-1" });

    expect(runtimeManager.resolvePermission).toHaveBeenCalledWith("req-1", "ALLOW");
    expect(runtimeManager.resolvePermission).toHaveBeenCalledWith("req-1", "DENY");
    expect(runtimeManager.retryTask).toHaveBeenCalledWith("session-1");
  });

  it("accepts OPEN_AGENT_EDITOR as a documented no-op (the host owns the editor tab)", async () => {
    const agentManager = {
      startTask: vi.fn(),
      createSession: vi.fn(),
      cancelTask: vi.fn(),
    } as unknown as AgentManager;

    const router = new MessageRouter(agentManager);
    const result = await router.handleMessage({ type: "OPEN_AGENT_EDITOR" });

    expect(result).toEqual({ success: true });
  });

  it("routes GET_CHECKPOINTS to runtimeManager.listCheckpoints", async () => {
    const agentManager = {} as unknown as AgentManager;
    const runtimeManager = {
      listCheckpoints: vi.fn().mockReturnValue([
        { id: "cp-1", label: "Initial state", timestamp: 1000, changeCount: 0 },
      ]),
    };

    const router = new MessageRouter(agentManager, ".", undefined, undefined, runtimeManager as never);
    const result = await router.handleMessage({ type: "GET_CHECKPOINTS", sessionId: "session-1" });

    expect(runtimeManager.listCheckpoints).toHaveBeenCalledWith("session-1");
    expect(result).toEqual({
      type: "CHECKPOINTS",
      sessionId: "session-1",
      items: [{ id: "cp-1", label: "Initial state", timestamp: 1000, changeCount: 0 }],
    });
  });

  it("routes RESTORE_CHECKPOINT to runtimeManager.restoreCheckpoint", async () => {
    const agentManager = {} as unknown as AgentManager;
    const runtimeManager = {
      restoreCheckpoint: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        items: [{ id: "cp-1", label: "Initial state", timestamp: 1000, changeCount: 0 }],
      }),
    };

    const router = new MessageRouter(agentManager, ".", undefined, undefined, runtimeManager as never);
    const result = await router.handleMessage({ type: "RESTORE_CHECKPOINT", checkpointId: "cp-1" });

    expect(runtimeManager.restoreCheckpoint).toHaveBeenCalledWith("cp-1");
    expect(result).toEqual({
      type: "CHECKPOINTS",
      sessionId: "session-1",
      items: [{ id: "cp-1", label: "Initial state", timestamp: 1000, changeCount: 0 }],
    });
  });

  it("routes CHECKPOINT_NOW to runtimeManager.createCheckpoint", async () => {
    const agentManager = {} as unknown as AgentManager;
    const items = [{ id: "cp-2", label: "Manual checkpoint", timestamp: 2000, changeCount: 1 }];
    const runtimeManager = {
      createCheckpoint: vi.fn().mockResolvedValue(items),
    };

    const router = new MessageRouter(agentManager, ".", undefined, undefined, runtimeManager as never);
    const result = await router.handleMessage({ type: "CHECKPOINT_NOW", sessionId: "session-1", label: "halfway" });

    expect(runtimeManager.createCheckpoint).toHaveBeenCalledWith("session-1", "halfway");
    expect(result).toEqual({ type: "CHECKPOINTS", sessionId: "session-1", items });
  });

  it("rejects malformed GET_CHECKPOINTS and RESTORE_CHECKPOINT messages", async () => {
    const router = new MessageRouter({} as unknown as AgentManager);

    await expect(router.handleMessage({ type: "GET_CHECKPOINTS" })).rejects.toThrow("Invalid GET_CHECKPOINTS message");
    await expect(router.handleMessage({ type: "GET_CHECKPOINTS", sessionId: 123 })).rejects.toThrow("Invalid GET_CHECKPOINTS message");
    await expect(router.handleMessage({ type: "RESTORE_CHECKPOINT" })).rejects.toThrow("Invalid RESTORE_CHECKPOINT message");
    await expect(router.handleMessage({ type: "RESTORE_CHECKPOINT", checkpointId: null })).rejects.toThrow("Invalid RESTORE_CHECKPOINT message");
    await expect(router.handleMessage({ type: "CHECKPOINT_NOW" })).rejects.toThrow("Invalid CHECKPOINT_NOW message");
    await expect(router.handleMessage({ type: "CHECKPOINT_NOW", sessionId: 123 })).rejects.toThrow("Invalid CHECKPOINT_NOW message");
  });

  it("validates and accepts OPEN_HISTORY and DELETE_SESSION", async () => {
    const agentManager = {
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager;
    const router = new MessageRouter(agentManager);

    const historyResult = await router.handleMessage({ type: "OPEN_HISTORY" });
    expect(historyResult).toEqual({ success: true });

    const deleteResult = await router.handleMessage({ type: "DELETE_SESSION", sessionId: "session-1" });
    expect(deleteResult).toEqual({ success: true });
    expect(agentManager.deleteSession).toHaveBeenCalledWith("session-1");

    await expect(router.handleMessage({ type: "DELETE_SESSION" })).rejects.toThrow("Invalid DELETE_SESSION message");
  });
});

