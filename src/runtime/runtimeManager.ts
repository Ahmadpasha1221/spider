import * as vscode from "vscode";
import * as path from "node:path";
import type { PermissionManager } from "../permissions/permissionManager";
import type { SessionStore } from "../session/sessionStore";
import { profileIdFor, type PersistedProviderConfig, type ProviderConfigStore } from "../session/providerConfigStore";
import type { TranscriptEntry, TranscriptStore } from "../session/transcriptStore";
import type { Logger } from "../utils/logger";
import { ToolRouter } from "./tools/toolRouter";
import { DEFAULT_AGENT_MODE, type AgentMode } from "./tools/toolAvailability";
import { FileChangeReviewManager, joinWorkspacePath } from "./review/fileChangeReviewManager";
import type { DiffViewService } from "./review/diffView";
import type { RuntimeUsage } from "./runtimeTypes";
import {
  AgentRuntime,
  CodeviaSession,
  FileChangeSummary,
  ResolvedRuntimeConfig,
  RuntimeError,
  RuntimeEvent,
  RuntimeModel,
  RuntimeProviderConfig,
  RuntimeSessionStatus,
  RuntimeToolCall,
  RuntimeToolCallResponse,
  RuntimeToolExecutor,
  RuntimeToolExecutorContext,
} from "./runtimeTypes";
import { BackgroundProcessManager } from "./tools/backgroundProcessManager";
import type { ExecutionManager } from "./execution/executionManager";
import { UserQuestionBroker } from "./userInteraction/userQuestionBroker";
import { TaskPlanStore } from "./state/taskPlan";
import { compactChatTurns } from "./tools/contextManager";
import { restoreChatTurns } from "./tools/contextRestore";

export interface RuntimeManagerOptions {
  readonly sessionStore: SessionStore;
  readonly permissionManager: PermissionManager;
  readonly runtimes: readonly AgentRuntime[];
  readonly logger?: Pick<Logger, "info" | "warn" | "error">;
  readonly toolExecutor?: RuntimeToolExecutor;
  readonly defaultWorkspacePath?: string;
  readonly transcriptStore?: TranscriptStore;
  readonly diffView?: DiffViewService;
  /** Persists the selected provider config so restarts restore it. */
  readonly providerConfigStore?: ProviderConfigStore;
  /** Injected background-process manager; disposed with the runtime. */
  readonly backgroundProcesses?: import("./tools/backgroundProcessManager").BackgroundProcessManager;
  /**
   * Authoritative execution-context resolver. When present, its safe summary is
   * injected into the agent prompt so the model knows where commands run.
   */
  readonly executionManager?: ExecutionManager;
  /**
   * Workspace-rules loader (`.spiderrules`). Injected by the extension
   * host (it owns the VS Code setting + file watcher); returns the
   * formatted rules context for a workspace, or undefined when none
   * apply. Best-effort: a failing loader never blocks a run.
   */
  readonly rulesLoader?: (workspacePath: string) => Promise<string | undefined>;
}

interface ActiveRun {
  readonly controller: AbortController;
  providerSessionId?: string;
}

/**
 * Providers whose runtime cannot be configured from persisted data alone: the
 * caller must re-attach a credential from SecretStorage first. Everything else
 * is applied during `restoreProviderConfig()`.
 */
const CREDENTIAL_PROVIDERS: ReadonlySet<RuntimeProviderConfig["provider"]> = new Set(["openrouter"]);

/** Attaches a credential to a config whose runtime declares an apiKey slot. */
function withApiKey(config: RuntimeProviderConfig, credential: string): RuntimeProviderConfig {
  if (config.provider === "openrouter") {
    return { ...config, apiKey: credential };
  }
  if (config.provider === "openai-compatible") {
    return { ...config, apiKey: credential };
  }
  return config;
}

/** Result of a provider restore attempt. */
export interface ProviderRestoreResult {
  readonly config: PersistedProviderConfig;
  /** True when the runtime was configured during the restore. */
  readonly applied: boolean;
}

/** Live command-output flush cadence: ~8 updates/second, not per chunk. */
const COMMAND_STREAM_INTERVAL_MS = 120;

function commandTextFromCall(call: RuntimeToolCall): string {
  return isRecord(call.input) && typeof call.input.command === "string" ? call.input.command : "";
}

/**
 * Best-effort path shown in a permission request. Multi-path tools report how
 * many targets they touch so the prompt is still informative.
 */
function describePermissionTarget(input: Record<string, unknown>): string | undefined {
  if (Array.isArray(input.files)) {
    const count = input.files.length;
    return count === 1 && typeof input.files[0] === "string"
      ? input.files[0]
      : `${count} files`;
  }
  if (typeof input.file_path === "string") {
    return input.file_path;
  }
  if (typeof input.path === "string") {
    return input.path;
  }
  if (typeof input.url === "string") {
    return input.url;
  }
  if (typeof input.query === "string") {
    return input.query;
  }
  // The position tools (go_to_definition / find_references) identify their
  // target as path:line:character; show it compactly in permission prompts.
  if (typeof input.path === "string" && typeof input.line === "number") {
    const line = Number.isFinite(input.line) ? Math.max(0, Math.floor(input.line)) : 0;
    const character = typeof input.character === "number" && Number.isFinite(input.character) ? Math.max(0, Math.floor(input.character)) : 0;
    return `${input.path}:${line + 1}:${character + 1}`;
  }
  return typeof input.from === "string" ? input.from : undefined;
}

/** Serialized result size for logs; never the content itself. */
function resultSize(result: unknown): number {
  if (result === undefined) {
    return 0;
  }
  try {
    return JSON.stringify(result)?.length ?? 0;
  } catch {
    return 0;
  }
}

export class RuntimeManager implements vscode.Disposable {
  private readonly runtimes = new Map<AgentRuntime["provider"], AgentRuntime>();
  private readonly sessions = new Map<string, CodeviaSession>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly emitter = new vscode.EventEmitter<RuntimeEvent>();
  private readonly persistenceQueue: Promise<void>;
  private activeProvider?: RuntimeProviderConfig["provider"];
  private activeConfig?: RuntimeProviderConfig;
  /** Profile id of the active provider selection; keys its stored credential. */
  private activeProfileId?: string;
  private activeSessionId?: string;
  private readonly lastPrompts = new Map<string, string>();
  private readonly toolRouter: ToolRouter;
  private readonly reviewManager = new FileChangeReviewManager();
  private readonly usageBySession = new Map<string, RuntimeUsage>();
  /**
   * Sessions whose provider history was already seeded from the persisted
   * transcript (once per session lifetime). Providers only accept the seed
   * into an empty history, so this is just a read-saving guard.
   */
  private readonly restoredHistories = new Set<string>();
  /**
   * Managed background processes started by `background_command`. Disposed with
   * the runtime so long-running processes are not orphaned when the extension
   * deactivates; never persisted across restarts.
   */
  private readonly backgroundProcesses: import("./tools/backgroundProcessManager").BackgroundProcessManager;
  /** Pending `ask_user` questions, correlated by request id. */
  private readonly userQuestions = new UserQuestionBroker();
  /** Per-conversation task plan (structured agent state, never the transcript). */
  private readonly taskPlans = new TaskPlanStore();

  /**
   * Live command-output buffers, keyed by toolCallId. Chunks are coalesced and
   * flushed on a short interval so a chatty command cannot flood the webview;
   * the agent loop's final command_output event remains authoritative.
   */
  private readonly commandStreams = new Map<
    string,
    { sessionId: string; stdout: string; stderr: string; timer?: ReturnType<typeof setTimeout> }
  >();

  readonly onDidPublishEvent = this.emitter.event;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.persistenceQueue = Promise.resolve();
    this.toolRouter = new ToolRouter(options.toolExecutor);
    this.backgroundProcesses = options.backgroundProcesses ?? new BackgroundProcessManager();
    for (const runtime of options.runtimes) {
      this.runtimes.set(runtime.provider, runtime);
    }
    // Bridge question lifecycle onto the runtime event bus the webview watches.
    this.userQuestions.onEvent((event) => {
      if (event.type === "asked") {
        this.publishEvent({
          type: "user_question",
          sessionId: event.request.sessionId,
          request: event.request,
          timestamp: Date.now(),
        });
      } else {
        this.publishEvent({
          type: "user_question_resolved",
          sessionId: event.sessionId,
          requestId: event.requestId,
          timestamp: Date.now(),
        });
      }
    });
  }

  /** Resolves a pending `ask_user` question. Returns false for a stale id. */
  resolveUserQuestion(requestId: string, answer: string): boolean {
    return this.userQuestions.answer(requestId, answer);
  }

  /** Dismisses a pending `ask_user` question. Returns false for a stale id. */
  cancelUserQuestion(requestId: string): boolean {
    return this.userQuestions.cancel(requestId);
  }

  /** Cancels every pending question (webview disposal / extension deactivate). */
  cancelPendingUserQuestions(): void {
    this.userQuestions.cancelAll("cancelled");
  }

  /** Current task plan for a conversation (sanitized snapshot or undefined). */
  getTaskPlan(sessionId: string): ReturnType<TaskPlanStore["get"]> {
    return this.taskPlans.get(sessionId);
  }

  getUsage(sessionId: string): RuntimeUsage {
    return this.usageBySession.get(sessionId) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  listFileChanges(sessionId: string): FileChangeSummary[] {
    return this.reviewManager.listChanges(sessionId);
  }

  async resolveFileChange(changeId: string, decision: "ACCEPT" | "REJECT" | "VIEW_DIFF"): Promise<FileChangeSummary | undefined> {
    const change = this.reviewManager.getChange(changeId);
    if (!change) {
      return undefined;
    }
    if (decision === "VIEW_DIFF") {
      await this.showFileChangeDiff(changeId);
      return change;
    }
    if (decision === "REJECT") {
      const workspacePath = this.sessions.get(change.sessionId)?.workspacePath ?? this.options.defaultWorkspacePath ?? ".";
      const reverted = await this.reviewManager.revert(changeId, workspacePath);
      this.publishEvent({ type: "file_change_reverted", sessionId: change.sessionId, change: reverted, timestamp: Date.now() });
      this.recordTranscript(change.sessionId, {
        kind: "system",
        text: `Reverted ${reverted.path}`,
        timestamp: Date.now(),
        toolName: reverted.toolName,
        path: reverted.path,
      });
      return reverted;
    }
    return this.reviewManager.getChange(changeId);
  }

  async showFileChangeDiff(changeId: string): Promise<void> {
    const change = this.reviewManager.getChange(changeId);
    if (!change) {
      return;
    }
    if (this.options.diffView) {
      await this.options.diffView.showDiff({
        title: `Agent change: ${change.path}`,
        beforeExists: change.beforeExists,
        afterPath: this.absolutePathFor(change.sessionId, change.path),
      });
      return;
    }
    await this.openFile(change.path);
  }

  async openFile(relativePath: string): Promise<void> {
    const sessionId = this.activeSessionId;
    const absolute = sessionId
      ? this.absolutePathFor(sessionId, relativePath)
      : path.resolve(this.options.defaultWorkspacePath ?? ".", relativePath);
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.options.logger?.warn("Could not open file", { operation: "openFile" });
      throw new RuntimeError("unknown", `Could not open ${relativePath}.`, { cause: error });
    }
  }

  private absolutePathFor(sessionId: string, relativePath: string): string {
    const workspacePath = this.sessions.get(sessionId)?.workspacePath ?? this.options.defaultWorkspacePath ?? ".";
    return joinWorkspacePath(workspacePath, relativePath);
  }

  get activeSession(): CodeviaSession | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
  }

  get provider(): RuntimeProviderConfig["provider"] | undefined {
    return this.activeProvider;
  }

  registerRuntime(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.provider, runtime);
    if (!this.activeProvider) {
      this.activeProvider = runtime.provider;
    }
  }

  async setProvider(config: RuntimeProviderConfig): Promise<void> {
    for (const sessionId of Array.from(this.activeRuns.keys())) {
      await this.cancelTask(sessionId);
    }
    const runtime = this.getRequiredRuntime(config.provider);
    await runtime.configure(config);
    this.activeProvider = config.provider;
    this.activeConfig = config;
    // Deterministic and identical to what the store derives, so the credential
    // slot can be resolved without waiting for persistence.
    this.activeProfileId = profileIdFor(config.provider, "baseUrl" in config ? config.baseUrl : undefined);
    // Remember the selection (never secrets) so the next start restores it.
    void this.options.providerConfigStore?.save(config).catch(() => {
      // Persistence is best-effort; the runtime is already usable.
    });
    if (this.activeSessionId && "modelId" in config) {
      this.updateSession(this.activeSessionId, { modelId: config.modelId, status: "IDLE", currentTask: undefined });
    }
    this.options.logger?.info("Runtime provider selected", {
      operation: "setProvider",
      sessionId: this.activeSessionId,
    });
    this.publishEvent({
      type: "status",
      sessionId: this.activeSessionId ?? "runtime",
      status: "IDLE",
      timestamp: Date.now(),
    });
  }

  getProviderConfig(): ResolvedRuntimeConfig | undefined {
    if (!this.activeConfig) {
      return undefined;
    }

    const config = this.activeConfig;
    const identity = this.activeProfileId ? { profileId: this.activeProfileId } : {};
    if (config.provider === "openai-compatible") {
      return {
        ...identity,
        provider: config.provider,
        baseUrl: config.baseUrl,
        modelId: config.modelId,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      };
    }
    if (config.provider === "openrouter") {
      return {
        ...identity,
        provider: config.provider,
        modelId: config.modelId,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      };
    }
    if (config.provider === "ollama") {
      return { ...identity, provider: config.provider, baseUrl: config.baseUrl, modelId: config.modelId };
    }
    if (config.provider === "mock") {
      return {
        ...identity,
        provider: config.provider,
        scenario: config.scenario,
        delayMs: config.delayMs,
      };
    }
    return { ...identity, provider: config.provider, modelId: config.modelId };
  }

  async checkAvailability(signal?: AbortSignal): Promise<ReturnType<AgentRuntime["checkAvailability"]>> {
    const runtime = this.getCurrentRuntime();
    try {
      const availability = await runtime.checkAvailability(signal);
      this.options.logger?.info("Runtime availability checked", {
        operation: "checkAvailability",
        sessionId: this.activeSessionId,
      });
      return availability;
    } catch (error) {
      const runtimeError = this.toRuntimeError(error, "availability");
      this.options.logger?.warn("Runtime availability check failed", {
        operation: "checkAvailability",
        sessionId: this.activeSessionId,
      });
      throw runtimeError;
    }
  }

  async discoverModels(signal?: AbortSignal): Promise<RuntimeModel[]> {
    const runtime = this.getCurrentRuntime();
    try {
      const models = await runtime.discoverModels(signal);
      this.options.logger?.info("Runtime models discovered", {
        operation: "discoverModels",
        sessionId: this.activeSessionId,
      });
      return models;
    } catch (error) {
      throw this.toRuntimeError(error, "discoverModels");
    }
  }

  async loadTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    return this.options.transcriptStore?.load(sessionId) ?? [];
  }

  createSession(workspacePath = this.options.defaultWorkspacePath ?? "."): CodeviaSession {
    const provider = this.activeProvider ?? this.runtimes.keys().next().value;
    if (!provider) {
      throw new RuntimeError("invalid_configuration", "No runtime provider is configured.");
    }

    // A conversation-scoped shield does not survive a new conversation.
    this.resetConversationScopedAutoApprove();

    const now = new Date();
    const modelId = this.activeConfig && "modelId" in this.activeConfig ? this.activeConfig.modelId : undefined;
    const session: CodeviaSession = {
      sessionId: crypto.randomUUID(),
      provider,
      ...(modelId ? { modelId } : {}),
      workspacePath,
      status: "IDLE",
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.sessionId, session);
    this.activeSessionId = session.sessionId;
    this.enqueuePersistence();
    this.options.logger?.info("Spider session created", {
      operation: "createSession",
      sessionId: session.sessionId,
    });
    return session;
  }

  getSession(sessionId: string): CodeviaSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): CodeviaSession[] {
    return Array.from(this.sessions.values()).sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
  }

  selectSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) {
      return false;
    }
    this.activeSessionId = sessionId;
    this.enqueuePersistence();
    return true;
  }

  /**
   * Removes one message from a conversation's persisted transcript (chat UI
   * Delete). UI removal is optimistic; this makes deletion durable so a
   * History restore cannot resurrect the message.
   */
  async deleteTranscriptEntry(sessionId: string, entryId: string): Promise<void> {
    try {
      await this.options.transcriptStore?.removeEntry(sessionId, entryId);
    } catch {
      // Deletion is best-effort and must never break the UI.
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.cancelTask(sessionId);
    this.sessions.delete(sessionId);
    this.activeRuns.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.getMostRecentSessionId();
    }
    this.options.permissionManager.cancelSessionRequests(sessionId);
    this.userQuestions.cancelSession(sessionId);
    this.taskPlans.clear(sessionId);
    this.restoredHistories.delete(sessionId);
    try {
      await this.options.transcriptStore?.delete(sessionId);
    } catch {
      // Transcript cleanup is best-effort.
    }
    this.enqueuePersistence();
  }

  /**
   * Restores the persisted provider selection (never secrets). Providers whose
   * runtime needs no credential are applied immediately (`applied: true`);
   * credential-backed providers come back unapplied so the caller resolves the
   * profile's secret from SecretStorage and calls `completeRestore` — or skips
   * the restore entirely when no credential is stored.
   */
  async restoreProviderConfig(): Promise<ProviderRestoreResult | undefined> {
    const saved = this.options.providerConfigStore?.load();
    if (!saved) {
      return undefined;
    }
    if (CREDENTIAL_PROVIDERS.has(saved.provider)) {
      return { config: saved, applied: false };
    }
    const runtime = this.runtimes.get(saved.provider);
    if (!runtime) {
      return undefined;
    }
    const config = this.toRuntimeProviderConfig(saved);
    if (!config) {
      return undefined;
    }
    try {
      await runtime.configure(config);
      this.activeProvider = saved.provider;
      this.activeConfig = config;
      this.activeProfileId = saved.profileId ?? profileIdFor(saved.provider, saved.baseUrl);
    } catch {
      // A stale saved config must not break activation; start unconfigured.
      return undefined;
    }
    return { config: saved, applied: true };
  }

  /**
   * Finishes a restore that was waiting for a credential: applies the saved
   * selection with the resolved secret. Provider-agnostic — the credential is
   * attached only when the runtime config declares an `apiKey` slot.
   */
  async completeRestore(saved: PersistedProviderConfig, credential?: string): Promise<boolean> {
    const config = this.toRuntimeProviderConfig(saved);
    if (!config) {
      return false;
    }
    await this.setProvider(credential ? withApiKey(config, credential) : config);
    return true;
  }

  async restoreSessions(): Promise<void> {
    const loaded = this.options.sessionStore.loadSessions();
    const now = Date.now();
    this.sessions.clear();
    this.activeSessionId = undefined;

    for (const session of loaded) {
      if (session.provider === "cursor") {
        continue;
      }
      const restored: CodeviaSession = {
        ...session,
        status: this.isNonTerminal(session.status) ? "DISCONNECTED" : session.status,
        updatedAt: this.isNonTerminal(session.status) ? new Date(now) : session.updatedAt,
        ...(this.isNonTerminal(session.status) ? { runId: undefined } : {}),
      };
      this.sessions.set(restored.sessionId, restored);
    }

    const persistedActiveSessionId = this.options.sessionStore.loadActiveSessionId();
    this.activeSessionId = persistedActiveSessionId && this.sessions.has(persistedActiveSessionId)
      ? persistedActiveSessionId
      : this.getMostRecentSessionId();

    await Promise.all([
      this.options.sessionStore.saveSessions(Array.from(this.sessions.values())),
      this.options.sessionStore.saveActiveSessionId(this.activeSessionId),
    ]);

    for (const session of this.sessions.values()) {
      if (session.status === "DISCONNECTED") {
        this.publishEvent({ type: "status", sessionId: session.sessionId, status: "DISCONNECTED", timestamp: now });
      }
    }
  }

  async startTask(
    sessionId: string,
    prompt: string,
    cancellationToken?: vscode.CancellationToken,
    retry = false,
    messageId?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RuntimeError("session_not_found", `Session not found: ${sessionId}`);
    }
    if (session.status === "RUNNING" || session.status === "STARTING") {
      if (!retry) {
        throw new RuntimeError("invalid_configuration", `Session is already running: ${sessionId}`);
      }
      await this.cancelTask(sessionId);
    }

    this.lastPrompts.set(sessionId, prompt);
    await this.recordTranscript(sessionId, {
      ...(messageId ? { id: messageId } : {}),
      kind: "user",
      text: prompt,
      timestamp: Date.now(),
    });

    // Agent mode is an internal runtime concern, never a user choice: the
    // shipped path always runs with the full registered tool set so the model
    // can autonomously pick any tool (write_file, edit_file, run_command…).
    const mode: AgentMode = DEFAULT_AGENT_MODE;
    const runtime = this.getRequiredRuntime(session.provider);
    const controller = new AbortController();
    const cancellationSubscription = cancellationToken?.onCancellationRequested(() => {
      controller.abort();
    });
    this.activeRuns.set(sessionId, {
      controller,
      providerSessionId: session.providerSessionId ?? session.agentId,
    });

    this.updateSession(sessionId, { status: "STARTING", currentTask: prompt, error: undefined });
    this.publishEvent({ type: "status", sessionId, status: "STARTING", timestamp: Date.now() });

    try {
      const providerSessionId = await this.ensureProviderSession(session, runtime, controller.signal);
      await this.restoreModelHistory(session.sessionId, runtime);
      this.updateSession(sessionId, {
        providerSessionId,
        agentId: providerSessionId,
        status: "READY",
      });
      this.publishEvent({ type: "status", sessionId, status: "READY", timestamp: Date.now() });

      if (controller.signal.aborted) {
        await this.cancelTask(sessionId);
        return;
      }

      const executionContextSummary = this.options.executionManager?.describe(session.workspacePath);
      // Rules are context only: a load failure must never fail the run.
      let rulesContext: string | undefined;
      try {
        rulesContext = await this.options.rulesLoader?.(session.workspacePath);
      } catch {
        rulesContext = undefined;
      }
      await runtime.sendMessage(
        {
          sessionId,
          providerSessionId,
          workspacePath: session.workspacePath,
          modelId: session.modelId ?? this.getModelId(session.provider),
          prompt,
          retry,
          mode,
          ...(executionContextSummary ? { executionContextSummary } : {}),
          ...(rulesContext ? { rulesContext } : {}),
          signal: controller.signal,
          onToolCall: (call, signal) => this.handleToolCall(sessionId, call, signal, mode),
          onStreamDelta: (text) => {
            this.handleRuntimeEvent(sessionId, { type: "text_delta", sessionId, text, timestamp: Date.now() });
          },
          usageSink: (usage) => {
            this.handleRuntimeEvent(sessionId, { type: "usage", sessionId, usage, timestamp: Date.now() });
          },
          // Live cumulative snapshots while streaming. Published as partial
          // usage (display-only): only the final usageSink call accumulates.
          usageDeltaSink: (usage) => {
            this.handleRuntimeEvent(sessionId, { type: "usage", sessionId, usage, partial: true, timestamp: Date.now() });
          },
        },
        (event) => this.handleRuntimeEvent(sessionId, event),
      );

      if (!controller.signal.aborted) {
        const currentSession = this.sessions.get(sessionId);
        if (currentSession && !["COMPLETED", "CANCELLED", "FAILED", "DISCONNECTED"].includes(currentSession.status)) {
          this.updateSession(sessionId, { status: "COMPLETED", currentTask: undefined });
          this.publishEvent({ type: "completed", sessionId, timestamp: Date.now() });
        }
      }
    } catch (error) {
      const runtimeError = this.toRuntimeError(error, "run");
      if (runtimeError.code === "cancelled") {
        const currentSession = this.sessions.get(sessionId);
        if (currentSession && currentSession.status !== "CANCELLED") {
          this.updateSession(sessionId, { status: "CANCELLED", currentTask: undefined });
          this.publishEvent({ type: "cancelled", sessionId, timestamp: Date.now() });
        }
        return;
      }
      this.updateSession(sessionId, {
        status: "FAILED",
        error: { message: runtimeError.message, category: runtimeError.code },
      });
      this.publishEvent({ type: "error", sessionId, error: runtimeError, timestamp: Date.now() });
      throw runtimeError;
    } finally {
      cancellationSubscription?.dispose();
      this.activeRuns.delete(sessionId);
      this.clearSessionCommandStreams(sessionId);
      this.options.permissionManager.cancelSessionRequests(sessionId);
      // A question the user never answered must not keep a promise (or a
      // future run) alive once the run is over.
      this.userQuestions.cancelSession(sessionId);
      // Transcript appends are queued, not awaited, per event (a run must not
      // block on disk). Flushing here means the run is durable by the time the
      // caller sees it finish, so a restore can never miss the last entries.
      await this.flushTranscript(sessionId);
    }
  }

  private async flushTranscript(sessionId: string): Promise<void> {
    try {
      await this.options.transcriptStore?.flush(sessionId);
    } catch {
      // Persistence is best-effort and must never fail a run.
    }
  }

  async retryTask(sessionId: string, cancellationToken?: vscode.CancellationToken): Promise<void> {
    const prompt = this.lastPrompts.get(sessionId) ?? this.sessions.get(sessionId)?.currentTask;
    if (!prompt) {
      throw new RuntimeError("invalid_configuration", "There is no previous prompt to retry.");
    }
    await this.startTask(sessionId, prompt, cancellationToken, true);
  }

  /**
   * Safe, secret-free execution-environment summary for the active workspace.
   * Used by the agent prompt and by Settings → About (read-only).
   */
  describeExecution(workspacePath?: string): string | undefined {
    const target = workspacePath ?? this.options.defaultWorkspacePath ?? ".";
    return this.options.executionManager?.describe(target);
  }

  resolvePermission(requestId: string, decision: "ALLOW" | "DENY"): void {
    this.options.permissionManager.resolveDecision({
      requestId,
      decision,
      confirmation: decision === "ALLOW",
    });
  }

  async cancelTask(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const activeRun = this.activeRuns.get(sessionId);
    if (!session || !activeRun) {
      return;
    }

    this.updateSession(sessionId, { status: "CANCELLING" });
    this.options.permissionManager.cancelSessionRequests(sessionId);
    this.userQuestions.cancelSession(sessionId);
    activeRun.controller.abort();
    const runtime = this.getRequiredRuntime(session.provider);
    await runtime.cancel({
      sessionId,
      providerSessionId: activeRun.providerSessionId,
      runId: session.runId,
      signal: activeRun.controller.signal,
    });
    this.updateSession(sessionId, { status: "CANCELLED" });
    this.publishEvent({ type: "cancelled", sessionId, timestamp: Date.now() });
  }

  dispose(): void {
    for (const sessionId of Array.from(this.activeRuns.keys())) {
      void this.cancelTask(sessionId).catch(() => undefined);
    }
    for (const runtime of this.runtimes.values()) {
      runtime.dispose();
    }
    void this.backgroundProcesses.dispose();
    this.userQuestions.dispose();
    this.taskPlans.dispose();
    this.emitter.dispose();
  }

  private async ensureProviderSession(
    session: CodeviaSession,
    runtime: AgentRuntime,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const existingId = session.providerSessionId ?? session.agentId;
    if (!existingId) {
      const created = await runtime.createSession({
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        modelId: session.modelId ?? this.getModelId(session.provider),
      });
      return created.providerSessionId;
    }

    try {
      const resumed = await runtime.resumeSession({
        sessionId: session.sessionId,
        providerSessionId: existingId,
        workspacePath: session.workspacePath,
        modelId: session.modelId ?? this.getModelId(session.provider),
      });
      return resumed.providerSessionId ?? existingId;
    } catch (error) {
      const runtimeError = this.toRuntimeError(error, "resume");
      if (runtimeError.code !== "agent_not_found" || signal.aborted) {
        throw runtimeError;
      }
      this.options.logger?.warn("Provider session was not found; creating a replacement", {
        operation: "resumeSession",
        sessionId: session.sessionId,
      });
      this.updateSession(session.sessionId, { providerSessionId: undefined, agentId: undefined });
      const created = await runtime.createSession({
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        modelId: session.modelId ?? this.getModelId(session.provider),
      });
      return created.providerSessionId;
    }
  }

  private async recordTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    try {
      await this.options.transcriptStore?.append(sessionId, entry);
    } catch {
      // Transcript persistence must never break an agent run.
    }
  }

  /**
   * Seeds a restarted session's empty provider history from the persisted
   * transcript (B3). Text-only turns (user/assistant) are restored and capped
   * through the context budget; tool/command entries are never replayed
   * because the transcript carries no tool_call_ids to pair them with.
   * Runs at most once per session; providers additionally refuse to seed a
   * non-empty history. Best-effort: restoration must never break a run.
   */
  private async restoreModelHistory(sessionId: string, runtime: AgentRuntime): Promise<void> {
    if (this.restoredHistories.has(sessionId) || !runtime.restoreHistory) {
      return;
    }
    this.restoredHistories.add(sessionId);
    try {
      const entries = await this.options.transcriptStore?.load(sessionId);
      if (!entries || entries.length === 0) {
        return;
      }
      const restored = restoreChatTurns(entries);
      if (restored.length === 0) {
        return;
      }
      const { turns } = compactChatTurns(restored);
      runtime.restoreHistory(sessionId, turns);
    } catch {
      // Restoration is best-effort and must never fail a run.
    }
  }

  private async handleToolCall(
    sessionId: string,
    call: RuntimeToolCall,
    signal?: AbortSignal,
    mode?: AgentMode,
  ): Promise<RuntimeToolCallResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { allowed: false, error: `Session not found: ${sessionId}`, result: { success: false, tool: call.name, error: "Session not found." } };
    }

    await this.captureFileChange(sessionId, call, "begin");
    const context: RuntimeToolExecutorContext = {
      session,
      signal,
      // Long-running commands stream output to the UI while they run; the
      // agent loop's final command_output event still carries the exit code.
      ...(call.name === "run_command"
        ? {
            onOutput: (stream: "stdout" | "stderr", chunk: string) =>
              this.pushCommandStream(sessionId, call, stream, chunk),
          }
        : {}),
      // Human-in-the-loop + agent state gateways: the tools stay thin and the
      // runtime stays the single owner of pending questions and task plans.
      askUser: (request) => this.userQuestions.ask({ ...request, sessionId }),
      taskPlan: {
        update: (items) => {
          const plan = this.taskPlans.update(sessionId, items);
          this.publishEvent({ type: "todo_updated", sessionId, plan, timestamp: Date.now() });
          return plan;
        },
      },
    };
    const startedAt = Date.now();
    const response = await this.toolRouter.route(
      call,
      context,
      (toolCall, toolSignal) => this.authorizeTool(sessionId, toolCall, toolSignal),
      { mode },
    );
    this.logToolExecution(sessionId, call, response, Date.now() - startedAt);
    await this.captureFileChange(sessionId, call, "end", response);
    return response;
  }

  /**
   * Structured tool observability. Never logs file contents, arguments, or
   * credentials — only the tool name, duration, outcome, cancellation and the
   * serialized result size.
   */
  private logToolExecution(
    sessionId: string,
    call: RuntimeToolCall,
    response: RuntimeToolCallResponse,
    durationMs: number,
  ): void {
    this.options.logger?.info("Tool execution finished", {
      operation: "toolExecution",
      sessionId,
      toolName: call.name,
      durationMs,
      resultBytes: resultSize(response.result),
      outcome: response.error
        ? /cancel/i.test(response.error)
          ? "cancelled"
          : "failed"
        : "succeeded",
    });
  }

  /**
   * Coalesces a live command-output chunk and flushes the running total on a
   * short interval, so a chatty command yields at most ~8 UI updates/second
   * instead of one per data chunk.
   */
  private pushCommandStream(
    sessionId: string,
    call: RuntimeToolCall,
    stream: "stdout" | "stderr",
    chunk: string,
  ): void {
    const existing = this.commandStreams.get(call.id) ?? { sessionId, stdout: "", stderr: "" };
    if (stream === "stdout") {
      existing.stdout += chunk;
    } else {
      existing.stderr += chunk;
    }
    if (!existing.timer) {
      existing.timer = setTimeout(() => {
        existing.timer = undefined;
        this.publishEvent({
          type: "command_output",
          sessionId,
          command: commandTextFromCall(call),
          toolCallId: call.id,
          stdout: existing.stdout,
          stderr: existing.stderr,
          exitCode: null,
          partial: true,
          timestamp: Date.now(),
        });
      }, COMMAND_STREAM_INTERVAL_MS);
    }
    this.commandStreams.set(call.id, existing);
  }

  private clearCommandStream(toolCallId: string): void {
    const stream = this.commandStreams.get(toolCallId);
    if (stream?.timer) {
      clearTimeout(stream.timer);
    }
    this.commandStreams.delete(toolCallId);
  }

  private clearSessionCommandStreams(sessionId: string): void {
    for (const [toolCallId, stream] of this.commandStreams) {
      if (stream.sessionId !== sessionId) {
        continue;
      }
      if (stream.timer) {
        clearTimeout(stream.timer);
      }
      this.commandStreams.delete(toolCallId);
    }
  }

  /** Records write_file / edit_file mutations for review and revert. */
  private async captureFileChange(
    sessionId: string,
    call: RuntimeToolCall,
    phase: "begin" | "end",
    response?: RuntimeToolCallResponse,
  ): Promise<void> {
    if (call.name !== "write_file" && call.name !== "edit_file") {
      return;
    }
    if (phase === "end" && (!response || !response.allowed || response.error)) {
      return;
    }
    const input = isRecord(call.input) ? call.input : {};
    const relativePath = typeof input.path === "string" ? input.path : undefined;
    if (!relativePath) {
      return;
    }

    try {
      const absolutePath = this.absolutePathFor(sessionId, relativePath);
      if (phase === "begin") {
        await this.reviewManager.beginCapture(sessionId, call.id, call.name, absolutePath);
        return;
      }
      const fs = await import("node:fs/promises");
      const after = await fs.readFile(absolutePath, "utf8");
      const captured = await this.reviewManager.endCapture(call.id, after);
      if (captured) {
        const summary = this.reviewManager.getChange(captured.changeId);
        if (summary) {
          this.publishEvent({ type: "file_change", sessionId, change: summary, timestamp: Date.now() });
        }
      }
    } catch {
      // Review capture is best-effort and must never fail the tool call.
    }
  }

  private accumulateUsage(sessionId: string, usage: RuntimeUsage, partial?: boolean): void {
    // Live snapshots are display-only: only final per-completion usage counts
    // toward session totals, or streaming runs would double-count.
    if (partial) {
      return;
    }
    const current = this.usageBySession.get(sessionId) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.usageBySession.set(sessionId, {
      promptTokens: current.promptTokens + usage.promptTokens,
      completionTokens: current.completionTokens + usage.completionTokens,
      totalTokens: current.totalTokens + usage.totalTokens,
      ...(usage.costUsd !== undefined || current.costUsd !== undefined
        ? { costUsd: (current.costUsd ?? 0) + (usage.costUsd ?? 0) }
        : {}),
    });
  }

  private async authorizeTool(
    sessionId: string,
    call: RuntimeToolCall,
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { allowed: false, error: `Session not found: ${sessionId}` };
    }

    const input = isRecord(call.input) ? call.input : {};
    const command = typeof input.command === "string" ? input.command : undefined;
    const path = describePermissionTarget(input);
    const request = this.options.permissionManager.buildRequest(
      session.sessionId,
      call.name,
      command,
      path,
    );

    // Hard gate 1: workspace trust. Not even the runtime shield may bypass it.
    if (this.options.permissionManager.isBlockedByTrust(request)) {
      return { allowed: false, error: "The workspace trust policy blocked this tool." };
    }

    // Hard gate 2: policy auto-allow (persistent rules).
    if (this.options.permissionManager.shouldAutoAllow(request)) {
      return { allowed: true };
    }

    // Convenience layer: runtime shield (composer toggle). Evaluated after
    // every hard gate; destructive requests and untrusted workspaces are
    // excluded inside shouldRuntimeAutoApprove, and an explicit user deny is
    // a resolution of a prompt that only exists when the shield is off, so a
    // deny can never be overridden here.
    if (this.options.permissionManager.shouldRuntimeAutoApprove(request)) {
      return { allowed: true };
    }

    const pending = this.options.permissionManager.requestPermission(request, signal);
    this.publishEvent({ type: "permission_request", sessionId: session.sessionId, request, timestamp: Date.now() });
    const resolution = await pending;
    if (resolution.status !== "allowed") {
      return { allowed: false, error: `Permission ${resolution.status}.` };
    }

    return { allowed: true };
  }

  private handleRuntimeEvent(sessionId: string, event: RuntimeEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // The final command output is authoritative: drop the coalescing buffer
    // for that tool call so no late partial flush can follow it.
    if (event.type === "command_output" && !event.partial) {
      this.clearCommandStream(event.toolCallId);
    }

    const published = this.recordTranscriptEvent(sessionId, event);

    if (published.type === "usage") {
      this.accumulateUsage(sessionId, published.usage, published.partial);
    }

    if (published.type === "status") {
      const status = this.normalizeRuntimeStatus(published.status);
      this.updateSession(sessionId, { status });
    } else if (published.type === "completed") {
      this.updateSession(sessionId, { status: "COMPLETED" });
    } else if (published.type === "cancelled") {
      this.updateSession(sessionId, { status: "CANCELLED" });
    } else if (published.type === "error") {
      this.updateSession(sessionId, {
        status: "FAILED",
        error: { message: published.error.message, category: published.error.code },
      });
    }

    this.publishEvent(published);
  }

  /**
   * Persists the transcript entry for an event and returns the event to
   * publish. Assistant replies get a stable transcript id (returned as
   * `messageId`) so the chat UI can Copy/Delete the exact stored entry;
   * partial command chunks are streamed to the UI but never persisted.
   */
  private recordTranscriptEvent(sessionId: string, event: RuntimeEvent): RuntimeEvent {
    if (event.type === "command_output" && event.partial) {
      return event;
    }
    const entry = transcriptEntryFromEvent(event);
    if (!entry) {
      return event;
    }
    const id = event.type === "assistant_message" ? crypto.randomUUID() : undefined;
    void this.recordTranscript(sessionId, id ? { ...entry, id } : entry);
    return id && event.type === "assistant_message" ? { ...event, messageId: id } : event;
  }

  private normalizeRuntimeStatus(status: RuntimeSessionStatus): RuntimeSessionStatus {
    return status;
  }

  /** Conversation-scoped shields are cleared when a new conversation starts. */
  private resetConversationScopedAutoApprove(): void {
    const state = this.options.permissionManager.getRuntimeAutoApprove();
    if (state.enabled && state.scope === "conversation") {
      this.options.permissionManager.setRuntimeAutoApprove(false, state.scope);
    }
  }

  private getCurrentRuntime(): AgentRuntime {
    const provider = this.activeProvider ?? this.runtimes.keys().next().value;
    if (!provider) {
      throw new RuntimeError("invalid_configuration", "No runtime provider is configured.");
    }
    return this.getRequiredRuntime(provider);
  }

  private getRequiredRuntime(provider: RuntimeProviderConfig["provider"]): AgentRuntime {
    const runtime = this.runtimes.get(provider);
    if (!runtime) {
      throw new RuntimeError("invalid_configuration", `Runtime provider is not registered: ${provider}`);
    }
    return runtime;
  }

  private getModelId(provider: RuntimeProviderConfig["provider"]): string | undefined {
    if (this.activeConfig?.provider !== provider) {
      return undefined;
    }
    return "modelId" in this.activeConfig ? this.activeConfig.modelId : undefined;
  }

  private toRuntimeError(error: unknown, operation: string): RuntimeError {
    if (error instanceof RuntimeError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if ((error instanceof Error && error.name === "AbortError") || /cancelled/i.test(normalized)) {
      return new RuntimeError("cancelled", "The runtime run was cancelled.", { cause: error });
    }
    if (/not found|agent.*not.*found|unknown agent/i.test(normalized)) {
      return new RuntimeError("agent_not_found", "The provider agent no longer exists. A new provider session will be created.", {
        retryable: true,
        cause: error,
      });
    }
    if (/no (cursor )?api key|unauthor|401|403|invalid api key/i.test(normalized)) {
      return new RuntimeError("authentication_failed", "Authentication failed. Connect a valid provider credential.", {
        cause: error,
      });
    }
    if (/fetch failed|network|timeout|connect.*refused|offline/i.test(normalized)) {
      return new RuntimeError("network_error", "The runtime provider is unreachable. Check its connection and try again.", {
        retryable: true,
        cause: error,
      });
    }
    if (/no model|model.*unavailable|model.*not found/i.test(normalized)) {
      return new RuntimeError("model_unavailable", "The selected model is unavailable. Choose a discovered model.", {
        cause: error,
      });
    }
    this.options.logger?.error("Runtime operation failed", {
      operation,
      sessionId: this.activeSessionId,
    });
    return new RuntimeError("unknown", "The runtime provider failed. Check the extension logs for details.", {
      cause: error,
    });
  }

  private isNonTerminal(status: RuntimeSessionStatus): boolean {
    return ["IDLE", "STARTING", "READY", "RUNNING", "CANCELLING"].includes(status);
  }

  private getMostRecentSessionId(): string | undefined {
    return this.listSessions()[0]?.sessionId;
  }

  /** Rehydrates a persisted provider config into the tagged union. */
  private toRuntimeProviderConfig(saved: PersistedProviderConfig): RuntimeProviderConfig | undefined {
    switch (saved.provider) {
      case "openai-compatible":
        return {
          provider: saved.provider,
          baseUrl: saved.baseUrl ?? "http://127.0.0.1:1234/v1",
          modelId: saved.modelId ?? "local-model",
        };
      case "ollama":
        return {
          provider: saved.provider,
          ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
          ...(saved.modelId ? { modelId: saved.modelId } : {}),
        };
      case "openrouter":
        return {
          provider: saved.provider,
          ...(saved.modelId ? { modelId: saved.modelId } : {}),
        };
      case "mock":
        return { provider: saved.provider };
      default:
        return undefined;
    }
  }

  private updateSession(sessionId: string, patch: Partial<CodeviaSession>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    Object.assign(session, patch, { updatedAt: new Date() });
    this.enqueuePersistence();
  }

  private enqueuePersistence(): void {
    void this.persistenceQueue
      .then(() => this.saveSessions())
      .catch(() => {
        this.options.logger?.error("Failed to persist runtime sessions", {
          operation: "persistSessions",
          sessionId: this.activeSessionId,
        });
      });
  }

  private async saveSessions(): Promise<void> {
    await Promise.all([
      this.options.sessionStore.saveSessions(Array.from(this.sessions.values())),
      this.options.sessionStore.saveActiveSessionId(this.activeSessionId),
    ]);
  }

  private publishEvent(event: RuntimeEvent): void {
    this.emitter.fire(event);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function transcriptEntryFromEvent(event: RuntimeEvent): TranscriptEntry | undefined {
  const timestamp = event.timestamp;
  switch (event.type) {
    case "assistant_message":
      return { kind: "assistant", text: event.message, timestamp };
    case "thinking":
      return { kind: "thinking", text: event.message, timestamp };
    case "tool_call":
      return {
        kind: "tool",
        text: `Using ${event.toolCall.name}`,
        timestamp,
        toolName: event.toolCall.name,
        ...(isRecord(event.toolCall.input)
          ? {
              ...(typeof event.toolCall.input.command === "string" ? { command: event.toolCall.input.command } : {}),
              ...(typeof event.toolCall.input.path === "string"
                ? { path: event.toolCall.input.path }
                : typeof event.toolCall.input.file_path === "string"
                  ? { path: event.toolCall.input.file_path }
                  : {}),
            }
          : {}),
      };
    case "tool_result":
      return event.toolResult.error
        ? { kind: "tool", text: `${event.toolResult.name} failed`, timestamp, toolName: event.toolResult.name, error: event.toolResult.error }
        : undefined;
    case "command_output":
      return {
        kind: "command",
        text: `$ ${event.command}`,
        timestamp,
        command: event.command,
        stdout: event.stdout,
        stderr: event.stderr,
        exitCode: event.exitCode,
      };
    case "permission_request":
      return {
        kind: "system",
        text: event.request.description,
        timestamp,
        toolName: event.request.toolName,
        ...(event.request.command ? { command: event.request.command } : {}),
        ...(event.request.path ? { path: event.request.path } : {}),
        error: event.request.destructive ? "destructive" : undefined,
      };
    case "error":
      return { kind: "error", text: event.error.message, timestamp };
    default:
      return undefined;
  }
}

export type { RuntimeToolExecutor } from "./runtimeTypes";
