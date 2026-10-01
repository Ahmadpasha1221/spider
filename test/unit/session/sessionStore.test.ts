import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../../src/agent/agentSession";
import { SessionStore } from "../../../src/session/sessionStore";

const SESSIONS_KEY = "spider.sessions";
const ACTIVE_SESSION_KEY = "spider.activeSession";

function createMemento(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string) => values[key]),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as vscode.Memento;
}

describe("SessionStore", () => {
  it("returns an empty list when no sessions are stored", () => {
    const workspaceState = createMemento();
    const store = new SessionStore(workspaceState);

    expect(store.loadSessions()).toEqual([]);
    expect(workspaceState.get).toHaveBeenCalledWith(SESSIONS_KEY);
  });

  it("deserializes stored sessions and dates", () => {
    const now = new Date();
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        {
          sessionId: "session-1",
          workspacePath: "/workspace",
          status: "COMPLETED",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          currentTask: "Finish the task",
        },
      ],
    });
    const store = new SessionStore(workspaceState);

    const sessions = store.loadSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-1",
      workspacePath: "/workspace",
      status: "COMPLETED",
      currentTask: "Finish the task",
    });
    expect(sessions[0].createdAt).toBeInstanceOf(Date);
    expect(sessions[0].updatedAt).toBeInstanceOf(Date);
  });

  it("ignores malformed persisted sessions", () => {
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        { sessionId: "valid", workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { sessionId: "invalid-status", workspacePath: "/workspace", status: "UNKNOWN", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { sessionId: "invalid-date", workspacePath: "/workspace", status: "IDLE", createdAt: "not-a-date", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const store = new SessionStore(workspaceState);

    expect(store.loadSessions().map((session) => session.sessionId)).toEqual(["valid"]);
  });

  it("serializes and stores sessions", async () => {
    const workspaceState = createMemento();
    const store = new SessionStore(workspaceState);
    const sessions: AgentSession[] = [
      {
        sessionId: "session-1",
        provider: "cursor",
        workspacePath: "/workspace",
        status: "IDLE",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    await store.saveSessions(sessions);

    expect(workspaceState.update).toHaveBeenCalledWith(SESSIONS_KEY, [
      {
        sessionId: "session-1",
        provider: "cursor",
        workspacePath: "/workspace",
        status: "IDLE",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("persists the active session id", async () => {
    const workspaceState = createMemento({ [ACTIVE_SESSION_KEY]: "session-1" });
    const store = new SessionStore(workspaceState);

    expect(store.loadActiveSessionId()).toBe("session-1");

    await store.saveActiveSessionId("session-2");

    expect(workspaceState.update).toHaveBeenCalledWith(ACTIVE_SESSION_KEY, "session-2");
  });

  it("clears sessions and active session id", async () => {
    const workspaceState = createMemento();
    const store = new SessionStore(workspaceState);

    await store.clearSessions();

    expect(workspaceState.update).toHaveBeenCalledWith(SESSIONS_KEY, undefined);
    expect(workspaceState.update).toHaveBeenCalledWith(ACTIVE_SESSION_KEY, undefined);
  });

  it("normalizes legacy records with default provider cursor", () => {
    const now = new Date();
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        {
          sessionId: "legacy-session",
          workspacePath: "/workspace",
          status: "IDLE",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    });
    const store = new SessionStore(workspaceState);

    const sessions = store.loadSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe("cursor");
    expect(sessions[0].modelId).toBeUndefined();
    expect(sessions[0].providerSessionId).toBeUndefined();
  });

  it("deserializes sessions with provider, modelId, and providerSessionId", () => {
    const now = new Date();
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        {
          sessionId: "session-1",
          provider: "ollama",
          modelId: "llama3",
          providerSessionId: "prov-sess-1",
          agentId: "agent-1",
          runId: "run-1",
          workspacePath: "/workspace",
          status: "RUNNING",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    });
    const store = new SessionStore(workspaceState);

    const sessions = store.loadSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe("ollama");
    expect(sessions[0].modelId).toBe("llama3");
    expect(sessions[0].providerSessionId).toBe("prov-sess-1");
    expect(sessions[0].agentId).toBe("agent-1");
    expect(sessions[0].runId).toBe("run-1");
  });

  it("ignores records with invalid provider", () => {
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        { sessionId: "valid", workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { sessionId: "invalid-provider", provider: "unknown", workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const store = new SessionStore(workspaceState);

    expect(store.loadSessions().map((s) => s.sessionId)).toEqual(["valid"]);
  });

  it("ignores records with non-string modelId", () => {
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        { sessionId: "valid", workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { sessionId: "invalid-model", provider: "cursor", modelId: 42, workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const store = new SessionStore(workspaceState);

    expect(store.loadSessions().map((s) => s.sessionId)).toEqual(["valid"]);
  });

  it("ignores records with non-string providerSessionId", () => {
    const workspaceState = createMemento({
      [SESSIONS_KEY]: [
        { sessionId: "valid", workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        { sessionId: "invalid-prov-sess", provider: "cursor", providerSessionId: 123, workspacePath: "/workspace", status: "IDLE", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const store = new SessionStore(workspaceState);

    expect(store.loadSessions().map((s) => s.sessionId)).toEqual(["valid"]);
  });

  it("serializes sessions with provider and optional fields", async () => {
    const workspaceState = createMemento();
    const store = new SessionStore(workspaceState);
    const sessions: AgentSession[] = [
      {
        sessionId: "session-1",
        provider: "ollama",
        modelId: "llama3",
        providerSessionId: "prov-1",
        agentId: "agent-1",
        runId: "run-1",
        workspacePath: "/workspace",
        status: "READY",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];

    await store.saveSessions(sessions);

    expect(workspaceState.update).toHaveBeenCalledWith(SESSIONS_KEY, [
      {
        sessionId: "session-1",
        provider: "ollama",
        modelId: "llama3",
        providerSessionId: "prov-1",
        agentId: "agent-1",
        runId: "run-1",
        workspacePath: "/workspace",
        status: "READY",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});
