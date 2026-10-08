import * as vscode from "vscode";
import { RuntimeProvider } from "../runtime/runtimeTypes";
import { AgentErrorInfo, AgentSession, AgentStatus } from "../agent/agentSession";
import { STORAGE_KEYS, readState } from "../shared/storageKeys";

const SESSIONS_STORAGE_KEY = STORAGE_KEYS.sessions.current;
const ACTIVE_SESSION_STORAGE_KEY = STORAGE_KEYS.activeSession.current;
const TASK_PLANS_STORAGE_KEY = STORAGE_KEYS.taskPlans.current;

const AGENT_STATUSES: readonly AgentStatus[] = [
  "IDLE",
  "STARTING",
  "READY",
  "RUNNING",
  "CANCELLING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "DISCONNECTED",
];

const RUNTIME_PROVIDERS: readonly RuntimeProvider[] = [
  "cursor",
  "ollama",
  "openai-compatible",
  "openrouter",
  "mock",
];

export class SessionStore {
  constructor(private readonly workspaceState: vscode.Memento) {}

  loadSessions(): AgentSession[] {
    const raw = readState<unknown>(this.workspaceState, STORAGE_KEYS.sessions, []);
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .filter(isRawSession)
      .map(deserializeSession)
      .filter((session): session is AgentSession => session !== undefined);
  }

  loadActiveSessionId(): string | undefined {
    const sessionId = readState<unknown>(this.workspaceState, STORAGE_KEYS.activeSession);
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  }

  async saveSessions(sessions: readonly AgentSession[]): Promise<void> {
    const existing = this.loadSessions();
    const incomingProviders = new Set(sessions.map((session) => session.provider));
    const retained = existing.filter((session) => !incomingProviders.has(session.provider));
    const raw = [...retained, ...sessions].map(serializeSession);
    await this.workspaceState.update(SESSIONS_STORAGE_KEY, raw);
  }

  async saveActiveSessionId(sessionId: string | undefined): Promise<void> {
    await this.workspaceState.update(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  }

  async clearSessions(): Promise<void> {
    await Promise.all([
      this.workspaceState.update(SESSIONS_STORAGE_KEY, undefined),
      this.workspaceState.update(ACTIVE_SESSION_STORAGE_KEY, undefined),
      this.workspaceState.update(TASK_PLANS_STORAGE_KEY, undefined),
    ]);
  }

  loadTaskPlans(): Record<string, unknown> {
    const raw = readState<Record<string, unknown>>(this.workspaceState, STORAGE_KEYS.taskPlans, {});
    return typeof raw === "object" && raw !== null ? raw : {};
  }

  async saveTaskPlans(plans: Record<string, unknown>): Promise<void> {
    await this.workspaceState.update(TASK_PLANS_STORAGE_KEY, plans);
  }
}

interface RawSession {
  sessionId: string;
  provider?: RuntimeProvider;
  modelId?: string;
  providerSessionId?: string;
  agentId?: string;
  runId?: string;
  workspacePath: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  currentTask?: string;
  error?: AgentErrorInfo;
}

function serializeSession(session: AgentSession): RawSession {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    modelId: session.modelId,
    providerSessionId: session.providerSessionId,
    agentId: session.agentId,
    runId: session.runId,
    workspacePath: session.workspacePath,
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    currentTask: session.currentTask,
    error: session.error,
  };
}

function deserializeSession(raw: RawSession): AgentSession | undefined {
  const createdAt = new Date(raw.createdAt);
  const updatedAt = new Date(raw.updatedAt);

  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    return undefined;
  }

  return {
    sessionId: raw.sessionId,
    provider: raw.provider ?? "cursor",
    modelId: raw.modelId,
    providerSessionId: raw.providerSessionId,
    agentId: raw.agentId,
    runId: raw.runId,
    workspacePath: raw.workspacePath,
    status: raw.status,
    createdAt,
    updatedAt,
    currentTask: raw.currentTask,
    error: raw.error,
  };
}

function isRawSession(value: unknown): value is RawSession {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.sessionId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isAgentStatus(value.status)
  ) {
    return false;
  }

  if (value.provider !== undefined && !isRuntimeProvider(value.provider)) {
    return false;
  }

  if (value.modelId !== undefined && typeof value.modelId !== "string") {
    return false;
  }

  if (value.providerSessionId !== undefined && typeof value.providerSessionId !== "string") {
    return false;
  }

  if (value.agentId !== undefined && typeof value.agentId !== "string") {
    return false;
  }

  if (value.runId !== undefined && typeof value.runId !== "string") {
    return false;
  }

  if (value.currentTask !== undefined && typeof value.currentTask !== "string") {
    return false;
  }

  if (value.error !== undefined && !isAgentError(value.error)) {
    return false;
  }

  return true;
}

function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return typeof value === "string" && RUNTIME_PROVIDERS.includes(value as RuntimeProvider);
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && AGENT_STATUSES.includes(value as AgentStatus);
}

function isAgentError(value: unknown): value is AgentErrorInfo {
  return isRecord(value) && typeof value.message === "string" && typeof value.category === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
