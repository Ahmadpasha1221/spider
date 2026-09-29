import { onHostMessage, postToHost } from "./bridge";
import type { HostToGui, RuntimeProvider, SessionListItem, PermissionRule, PermissionRuleCategory } from "./protocol";
import { AppState, ChatLine, createInitialState, phaseFromAgentState, type SettingsSection } from "./state";
import { createComposer } from "./components/composer";
import { createMessageList } from "./components/messageList";
import { createSessionBar } from "./components/sessionBar";
import { renderChatView } from "./views/chatView";
import { renderSettingsView } from "./views/settingsView";

const state: AppState = createInitialState();

/**
 * Assistant text deltas are forwarded straight to the message list, which owns
 * the single streaming accumulator and batches paints to animation frames.
 * There is deliberately no second coalescer here: two schedulers buffering the
 * same stream was what made the reveal look chunky.
 */

/**
 * Transcript staleness guard. A transcript reply is only applied when it is
 * for the session the user actually asked to load (or is actively using).
 * Optimistically starting a new conversation re-points this id immediately,
 * so stale replies for the old conversation can never overwrite empty state.
 */
let loadedTranscriptSessionId: string | undefined;

function isStaleTranscript(sessionId: string): boolean {
  return loadedTranscriptSessionId !== sessionId;
}

const runtimePill = mustEl("runtime-pill");
const settingsBtn = mustEl("settings-btn") as HTMLButtonElement;
const settingsBack = mustEl("settings-back") as HTMLButtonElement;
const setupBanner = mustEl("setup-banner");
const settingsView = mustEl("settings-view");
const chatView = mustEl("chat-view");
const providerSettings = mustEl("provider-settings");
const authFeedback = mustEl("auth-feedback");
const messageListRoot = mustEl("message-list");
const composerRoot = mustEl("composer");
const sessionBarRoot = mustEl("session-bar");

const messageList = createMessageList(messageListRoot, {
  onAllowPermission: (requestId) => resolvePermission(requestId, "ALLOW"),
  onDenyPermission: (requestId) => resolvePermission(requestId, "DENY"),
  onViewDiff: (changeId) => postToHost({ type: "OPEN_DIFF", changeId }),
  onAcceptChange: (changeId) => postToHost({ type: "RESOLVE_FILE_CHANGE", changeId, decision: "ACCEPT" }),
  onRejectChange: (changeId) => postToHost({ type: "RESOLVE_FILE_CHANGE", changeId, decision: "REJECT" }),
  onOpenArtifact: (path) => postToHost({ type: "OPEN_FILE", path }),
  onDeleteMessage: deleteMessage,
});
const composer = createComposer(composerRoot, {
  onSend: handleSend,
  onCancel: cancelRun,
  onRetry: retryLastPrompt,
  onModelSelect: selectModelFromComposer,
  onToggleAutoApprove: toggleAutoApprove,
});
const sessionBar = createSessionBar(sessionBarRoot, {
  onCreate: () => startNewConversation(),
});

settingsBtn.addEventListener("click", () => {
  state.view = state.view === "settings" ? "chat" : "settings";
  render();
});
settingsBack.addEventListener("click", () => {
  state.view = "chat";
  render();
});

onHostMessage(handleHostMessage);
postToHost({ type: "GET_AUTH_STATUS" });
postToHost({ type: "GET_RUNTIME_STATUS" });
postToHost({ type: "LIST_SESSIONS" });
postToHost({ type: "GET_PERMISSION_RULES" });
postToHost({ type: "GET_EXTENSION_INFO" });
render();

/**
 * New conversation lifecycle: reset the active conversation state immediately
 * (empty chat, fresh active id semantics) and ask the host for a session.
 * The host replies with SESSION_UPDATED for the new id; until then
 * pendingNewConversation keeps the composer from sending into the old
 * conversation. Repeated clicks are safe: when the active session is already
 * an empty conversation, NEW_SESSION is not sent again (host-side dedupe too).
 */
function startNewConversation(): void {
  if (state.pendingNewConversation) {
    return;
  }
  const currentMessages = state.messages;
  const activeIsEmpty = currentMessages.length === 0;
  if (activeIsEmpty) {
    // Already an empty active conversation: nothing to reset.
    state.pendingNewConversation = false;
    return;
  }
  state.pendingNewConversation = true;
  state.activeSessionId = undefined;
  loadedTranscriptSessionId = undefined;
  state.messages = [];
  state.lastPrompt = undefined;
  state.running = false;
  state.phase = "idle";
  messageList.clear();
  postToHost({ type: "NEW_SESSION" });
}

function handleSend(prompt: string): void {
  sendPrompt(prompt);
}

function handleHostMessage(message: HostToGui): void {
  let chatLineChanged = false;

  switch (message.type) {
    case "AUTH_STATUS":
      state.authStatus = message.status;
      state.hasKey = message.hasKey;
      state.authError = message.error;
      state.authMessage = message.message;
      state.connecting = message.status === "connecting";
      if (message.status === "connected" && state.provider === "cursor") {
        state.runtimeConnected = true;
      }
      break;
    case "RUNTIME_STATUS":
      state.provider = message.provider;
      state.runtimeConnected = message.connected;
      state.selectedModelId = message.modelId;
      state.selectedModelName = message.modelName;
      state.localProvider = message.localProvider ?? state.localProvider;
      state.runtimeError = message.error;
      if (message.provider === "openrouter" && message.connected && state.openRouterModels.length === 0 && !state.openRouterLoading) {
        discoverOpenRouterModels();
      }
      break;
    case "LOCAL_MODELS":
      state.localLoading = false;
      state.localProvider = message.provider;
      state.localModels = message.models;
      state.runtimeError = message.error;
      if (message.models.length > 0 && !message.error) {
        state.provider = "local";
        state.runtimeConnected = true;
        if (!state.selectedModelId && message.models[0]) {
          state.selectedModelId = message.models[0].id;
          state.selectedModelName = message.models[0].name;
        }
        ensureSession();
      }
      break;
    case "OPENROUTER_MODELS":
      state.openRouterLoading = false;
      state.openRouterModels = message.models;
      state.runtimeError = message.error;
      if (message.models.length > 0 && !message.error) {
        state.provider = "openrouter";
        state.runtimeConnected = true;
        if (!state.selectedModelId && message.models[0]) {
          state.selectedModelId = message.models[0].id;
          state.selectedModelName = message.models[0].name;
        }
        ensureSession();
      }
      break;
    case "SHOW_SETTINGS":
      state.view = "settings";
      break;
    case "SESSION_UPDATED":
      applySessionUpdate(message.sessions, message.activeSessionId);
      break;
    case "AUTO_APPROVE_STATE":
      // Backend is authoritative: the GUI mirrors whatever it confirms.
      state.autoApproveEnabled = message.enabled;
      state.autoApproveScope = message.scope;
      break;
    case "PERMISSION_RULES":
      state.permissionRules = message.rules;
      state.permissionRulesLoaded = true;
      break;
    case "EXTENSION_INFO":
      state.extensionInfo = message.info;
      break;
    case "TRANSCRIPT": {
      if (isStaleTranscript(message.sessionId)) {
        break;
      }
      // A conversation switch discards any in-flight streaming state.
      loadedTranscriptSessionId = message.sessionId;
      state.messages = message.entries.map(toChatLine);
      messageList.replaceAll(state.messages);
      render();
      break;
    }
    case "AGENT_STATE":
      applyAgentState(message.state);
      break;
    case "AGENT_MESSAGE": {
      // Finalizing closes the streaming accumulator first, so the final text
      // replaces exactly the text that was already painted (one source of
      // truth, no duplication possible).
      const text = sanitizeAgentMessage(message.message);
      if (text.length === 0) {
        messageList.finishStreamingLine("");
        break;
      }
      messageList.finishStreamingLine(text, message.messageId);
      chatLineChanged = true;
      break;
    }
    case "AGENT_TEXT_DELTA": {
      if (message.sessionId !== state.activeSessionId) {
        break;
      }
      let text = message.text;
      if (looksLikeRawToolJson(text)) {
        // The model leaked a raw tool object into the stream; never show it.
        text = "";
      }
      if (text.length === 0) {
        break;
      }
      state.phase = "streaming";
      // The message list owns the accumulator and paints at most once per
      // animation frame; close()/endStreamingTurn() flush the remainder.
      messageList.upsertStreamingLine(text);
      chatLineChanged = true;
      break;
    }
    case "AGENT_USAGE":
      state.usage = {
        promptTokens: message.promptTokens,
        completionTokens: message.completionTokens,
        totalTokens: message.totalTokens,
        ...(message.costUsd !== undefined ? { costUsd: message.costUsd } : {}),
      };
      break;
    case "FILE_CHANGE":
    case "FILE_CHANGE_REVERTED": {
      // Artifacts: meaningful agent-produced file changes rendered as cards.
      const line: ChatLine = {
        role: "system",
        text: "",
        artifact: message.change,
      };
      state.messages.push(line);
      messageList.upsertArtifact(message.change, message.type === "FILE_CHANGE_REVERTED");
      chatLineChanged = true;
      break;
    }
    case "AGENT_THINKING": {
      // Safe status text only (classification gates run in the agent loop).
      messageList.upsertThinkingBlock(message.message, "active");
      state.phase = "submitting";
      chatLineChanged = true;
      break;
    }
    case "AGENT_TOOL_CALL": {
      // tool_requested: create the execution box; later events update it in place.
      // Turn boundary: the upsert below flushes and settles any streamed
      // assistant text before the tool block.
      const toolCall = message.toolCall;
      if (toolCall.toolName === "run_command" && toolCall.command) {
        messageList.upsertCommandLine({ command: toolCall.command, running: true, toolCallId: toolCall.toolCallId });
      } else {
        messageList.upsertToolLine({
          toolCallId: toolCall.toolCallId ?? `tool:${toolCall.toolName}`,
          toolName: toolCall.toolName ?? "tool",
          status: "running",
          detail: toolCall.path,
        });
      }
      state.phase = "toolRunning";
      chatLineChanged = true;
      break;
    }
    case "AGENT_TOOL_RESULT": {
      const key = message.result.toolCallId ?? `tool:${message.result.toolName}`;
      const isCommand = message.result.toolName === "run_command";
      if (isCommand) {
        // The command box already exists from AGENT_TOOL_CALL; flip its state
        // in place. AGENT_COMMAND_OUTPUT (which arrives first, with the exit
        // code and streamed output) already finalized the status chip.
        messageList.completeCommandLine(message.result.toolCallId, message.result.error ? 1 : 0);
      } else {
        messageList.upsertToolLine({
          toolCallId: key,
          toolName: message.result.toolName ?? "tool",
          status: message.result.error ? "failed" : "completed",
          ...(message.result.error ? { error: message.result.error } : {}),
        });
      }
      state.phase = "streaming";
      chatLineChanged = true;
      break;
    }
    case "AGENT_COMMAND_OUTPUT": {
      // Partial chunks arrive while the command runs (running: true); the
      // final event carries the authoritative exit code.
      messageList.upsertCommandLine({
        command: message.command,
        running: message.partial === true,
        stdout: message.stdout,
        stderr: message.stderr,
        exitCode: message.exitCode,
        toolCallId: message.toolCallId,
      });
      chatLineChanged = true;
      break;
    }
    case "AGENT_ERROR": {
      state.running = false;
      state.phase = "failed";
      // Preserve whatever was already streamed; only the empty placeholder is
      // dropped, then the error line is appended.
      messageList.finishStreamingLine("");
      const errorLine: ChatLine = { role: "error", text: message.error };
      state.messages.push(errorLine);
      messageList.append([errorLine]);
      chatLineChanged = true;
      break;
    }
    case "PERMISSION_REQUEST": {
      const line: ChatLine = {
        role: "system",
        text: message.message,
        permission: {
          requestId: message.requestId,
          command: message.command,
          pending: true,
          destructive: message.destructive,
        },
      };
      state.messages.push(line);
      messageList.append([line]);
      chatLineChanged = true;
      break;
    }
  }

  const known = pushesChatLine(message);
  if (known && !chatLineChanged) {
    // Fallback for any chat-line message not handled above.
    messageList.append(state.messages.slice(-1));
  }
  scheduleUiSync();
}

/** Session list arrived: adopt the host's active id and resolve pending New. */
function applySessionUpdate(sessions: SessionListItem[], activeSessionId?: string): void {
  state.sessions = sessions;
  const hostActive = activeSessionId ?? sessions[0]?.sessionId;
  if (state.pendingNewConversation) {
    if (hostActive && hostActive !== state.activeSessionId) {
      // The new conversation is confirmed: it is now active and empty.
      state.activeSessionId = hostActive;
      loadedTranscriptSessionId = hostActive;
      state.messages = [];
      messageList.clear();
    }
    // Stay pending until the host confirms a session we did not have before.
    if (hostActive) {
      state.pendingNewConversation = false;
    }
    return;
  }
  state.activeSessionId = hostActive;
  if (state.activeSessionId && loadedTranscriptSessionId !== state.activeSessionId) {
    postToHost({ type: "GET_TRANSCRIPT", sessionId: state.activeSessionId });
  }
}

/** Backend AGENT_STATE is the source of truth for the phase machine. */
function applyAgentState(agentState: string): void {
  state.phase = phaseFromAgentState(agentState);
  state.running = agentState === "starting" || agentState === "ready" || agentState === "running";
  if (["completed", "cancelled", "failed", "disconnected", "idle"].includes(agentState)) {
    state.running = false;
    // Cancellation/error/interrupt path: finalize the partial text cleanly
    // (finishStreamingLine also flushes and resets the accumulator).
    messageList.finishStreamingLine("");
  }
  if (agentState === "starting") {
    // A new run begins: settle the previous segment so no stale text is
    // concatenated onto the upcoming stream.
    messageList.endStreamingTurn();
  }
}

const CHAT_LINE_MESSAGE_TYPES: ReadonlySet<HostToGui["type"]> = new Set([
  "AGENT_MESSAGE",
  "AGENT_THINKING",
  "AGENT_TOOL_CALL",
  "AGENT_TOOL_RESULT",
  "AGENT_COMMAND_OUTPUT",
  "AGENT_ERROR",
  "PERMISSION_REQUEST",
]);

function pushesChatLine(message: HostToGui): boolean {
  return CHAT_LINE_MESSAGE_TYPES.has(message.type);
}

/**
 * Single batched UI sync per event burst. Cheap state reads
 * (textContent/hidden) stay synchronous; anything layout-affecting or
 * burst-prone (streaming text, scroll) is already rAF-batched inside the
 * message list.
 */
let uiSyncScheduled = false;
function scheduleUiSync(): void {
  if (uiSyncScheduled) {
    return;
  }
  uiSyncScheduled = true;
  requestAnimationFrame(() => {
    uiSyncScheduled = false;
    render();
  });
}

function render(): void {
  runtimePill.textContent = runtimeLabel();
  settingsBtn.textContent = state.view === "settings" ? "Chat" : "Settings";
  const showSettings = state.view === "settings";
  settingsView.hidden = !showSettings;
  chatView.hidden = showSettings;

  if (!showSettings) {
    renderSetupBanner();
    sessionBar.update(state.running);
    renderChatView(
      { composer },
      state,
      {},
    );
  } else {
    renderSettingsView(providerSettings, authFeedback, state, {
      onProvider: selectProvider,
      onCursorConnect: (apiKey) => {
        state.connecting = true;
        state.authError = undefined;
        postToHost(apiKey ? { type: "CONNECT_CURSOR", apiKey } : { type: "CONNECT_CURSOR" });
        render();
      },
      onCursorDisconnect: () => postToHost({ type: "DISCONNECT_CURSOR" }),
      onOpenRouterConnect: (apiKey) => {
        state.openRouterLoading = true;
        state.runtimeError = undefined;
        postToHost({ type: "CONNECT_OPENROUTER", apiKey });
        render();
      },
      onOpenRouterDisconnect: () => {
        state.runtimeConnected = false;
        state.openRouterModels = [];
        postToHost({ type: "DISCONNECT_OPENROUTER" });
        render();
      },
      onRefreshOpenRouter: discoverOpenRouterModels,
      onOpenRouterModel: (modelId) => {
        selectModel(modelId);
      },
      onOpenRouterSearch: (query) => {
        state.openRouterModelFilter = query;
        render();
      },
      onLocalProvider: (provider) => {
        state.localProvider = provider;
        discoverLocalModels();
        render();
      },
      onRefreshLocal: discoverLocalModels,
      onLocalConnect: (baseUrl, apiKey, modelId) => {
        state.runtimeError = undefined;
        postToHost({ type: "CONNECT_LOCAL", provider: state.localProvider, baseUrl, apiKey, modelId });
        state.view = "chat";
        ensureSession();
      },
      onLocalModel: (modelId) => {
        selectModel(modelId);
      },
      onMock: () => {
        state.provider = "mock";
        state.runtimeConnected = true;
        postToHost({ type: "USE_MOCK_RUNTIME" });
        state.view = "chat";
        ensureSession();
        render();
      },
      onSelectSection: (section: SettingsSection) => {
        state.settingsSection = section;
        render();
      },
      onToggleAutoApprove: toggleAutoApprove,
      onSetPermissionRule: setPermissionRule,
    });
  }
}

/** Composer fast path: change the active model without opening Settings. */
function selectModelFromComposer(modelId: string): void {
  selectModel(modelId);
  render();
}

/** One path for model changes: optimistic update + host message. */
function selectModel(modelId: string): void {
  if (state.provider === "openrouter") {
    state.selectedModelId = modelId;
    state.selectedModelName = state.openRouterModels.find((model) => model.id === modelId)?.name ?? modelId;
    postToHost({ type: "SELECT_OPENROUTER_MODEL", modelId });
  } else if (state.provider === "local") {
    state.selectedModelId = modelId;
    state.selectedModelName = state.localModels.find((model) => model.id === modelId)?.name ?? modelId;
    state.lastPrompt = undefined;
    postToHost({ type: "SELECT_LOCAL_MODEL", modelId });
  }
  render();
}

/**
 * Shield toggle: optimistic UI flip, then the backend echo (AUTO_APPROVE_STATE)
 * is authoritative and corrects the state if the host rejected it.
 */
function toggleAutoApprove(enabled: boolean): void {
  state.autoApproveEnabled = enabled;
  postToHost({ type: "SET_RUNTIME_AUTO_APPROVE", enabled, scope: "conversation" });
  render();
}

/** Random id with a fallback for webview hosts without crypto.randomUUID. */
function newMessageId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Message Delete: the message list already removed the row; this drops the
 * message from view state and asks the host to erase the transcript entry so
 * a History restore cannot bring it back.
 */
function deleteMessage(messageId: string): void {
  state.messages = state.messages.filter((line) => line.messageId !== messageId);
  if (state.activeSessionId) {
    postToHost({ type: "DELETE_MESSAGE", sessionId: state.activeSessionId, messageId });
  }
  scheduleUiSync();
}


function setPermissionRule(category: PermissionRuleCategory, rule: PermissionRule): void {
  state.permissionRules = { ...state.permissionRules, [category]: rule };
  postToHost({ type: "SET_PERMISSION_RULE", category, rule });
  render();
}

function selectProvider(provider: RuntimeProvider): void {
  state.provider = provider;
  state.runtimeError = undefined;
  if (provider === "local") {
    discoverLocalModels();
  } else if (provider === "openrouter") {
    postToHost({ type: "SELECT_RUNTIME", provider });
    if (state.hasKey) {
      discoverOpenRouterModels();
    }
  } else if (provider === "mock") {
    state.runtimeConnected = true;
    postToHost({ type: "USE_MOCK_RUNTIME" });
    ensureSession();
  } else {
    state.runtimeConnected = state.authStatus === "connected";
    postToHost({ type: "SELECT_RUNTIME", provider });
  }
  render();
}

function discoverLocalModels(): void {
  state.localLoading = true;
  postToHost({ type: "DISCOVER_LOCAL_MODELS", provider: state.localProvider });
  render();
}

function discoverOpenRouterModels(): void {
  state.openRouterLoading = true;
  state.runtimeError = undefined;
  postToHost({ type: "DISCOVER_OPENROUTER_MODELS" });
  render();
}

function ensureSession(): void {
  if (state.sessions.length === 0 && !state.pendingNewConversation) postToHost({ type: "NEW_SESSION" });
}

function renderSetupBanner(): void {
  const ready =
    state.runtimeConnected
    || state.provider === "mock"
    || (state.provider === "local" && Boolean(state.selectedModelId || state.selectedModelName) && !state.runtimeError)
    || (state.provider === "openrouter" && Boolean(state.selectedModelId) && !state.runtimeError);
  setupBanner.hidden = ready;
  if (ready) return;
  setupBanner.replaceChildren();

  const title = document.createElement("strong");
  title.textContent = "Connect an AI provider to start";
  const text = document.createElement("span");
  text.textContent = state.provider === "local"
    ? "Select an installed local model or configure a local endpoint."
    : "Use Cursor with an API key, choose Local AI, or use Mock mode for testing.";
  const button = document.createElement("button");
  button.className = "btn";
  button.textContent = "Choose provider";
  button.onclick = () => { state.view = "settings"; render(); };
  setupBanner.append(title, text, button);
}

function sendPrompt(prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed || state.running || state.pendingNewConversation) return;
  if (!state.activeSessionId) {
    // No active conversation: create one and queue nothing; the composer
    // stays usable and the user can send again once the session exists.
    startNewConversation();
    return;
  }
  loadedTranscriptSessionId = state.activeSessionId;
  state.lastPrompt = trimmed;
  state.running = true;
  state.phase = "submitting";
  // The id is generated here and echoed back with the prompt, so the message
  // has one stable identity in both the UI and the persisted transcript.
  const messageId = newMessageId();
  const line: ChatLine = { role: "user", text: trimmed, messageId };
  state.messages.push(line);
  messageList.append([line]);
  postToHost({ type: "SEND_PROMPT", prompt: trimmed, sessionId: state.activeSessionId, messageId });
  scheduleUiSync();
}

function retryLastPrompt(): void {
  if (!state.lastPrompt || !state.activeSessionId || state.running || state.pendingNewConversation) return;
  loadedTranscriptSessionId = state.activeSessionId;
  state.running = true;
  state.phase = "submitting";
  postToHost({ type: "TRY_AGAIN", sessionId: state.activeSessionId });
  scheduleUiSync();
}

function cancelRun(): void {
  if (state.activeSessionId) postToHost({ type: "CANCEL_RUN", sessionId: state.activeSessionId });
}

function resolvePermission(requestId: string, decision: "ALLOW" | "DENY"): void {
  const line = [...state.messages].reverse().find((message) => message.permission?.requestId === requestId);
  if (line?.permission) {
    line.permission.pending = false;
  }
  messageList.resolvePermission(requestId, decision);
  postToHost(decision === "ALLOW" ? { type: "APPROVE_PERMISSION", requestId } : { type: "DENY_PERMISSION", requestId });
}

function toChatLine(entry: {
  id?: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "command" | "error" | "system";
  text: string;
  toolName?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}): ChatLine {
  switch (entry.kind) {
    case "user":
      return { role: "user", text: entry.text, ...(entry.id ? { messageId: entry.id } : {}) };
    case "assistant":
      return { role: "agent", text: entry.text, ...(entry.id ? { messageId: entry.id } : {}) };
    case "thinking":
      return { role: "thinking", text: entry.text };
    case "error":
      return { role: "error", text: entry.text };
    case "command":
      return { role: "system", text: "", command: { command: entry.command ?? "", stdout: entry.stdout, stderr: entry.stderr, exitCode: entry.exitCode, running: false } };
    case "tool":
      return { role: "system", text: toolTranscriptText(entry) };
    case "system":
      return { role: "system", text: entry.text };
  }
}

function toolTranscriptText(entry: {
  text: string;
  toolName?: string;
  path?: string;
  error?: string;
}): string {
  if (entry.error === "destructive") {
    return `Permission required: ${entry.text}`;
  }
  if (entry.error) {
    return `${entry.toolName ?? "tool"} failed: ${entry.error}`;
  }
  const target = entry.path ? ` ${entry.path}` : "";
  return `Used ${entry.toolName ?? "tool"}${target}`;
}

function runtimeLabel(): string {
  const usage = state.usage && state.usage.totalTokens > 0 ? ` · ${formatUsage(state.usage)}` : "";
  if (state.provider === "openrouter") {
    const model = state.selectedModelName ?? state.selectedModelId ?? "OpenRouter";
    return `OpenRouter · ${model}${usage}`;
  }
  if (state.provider === "local") {
    const model = state.selectedModelName ? `${state.selectedModelName}` : state.localProvider;
    const caps = capabilityBadge();
    return `Local · ${model}${caps}${usage}`;
  }
  if (state.provider === "mock") return `Mock · Test${usage}`;
  return `Cursor${usage}`;
}

function capabilityBadge(): string {
  const caps = state.modelCapabilities;
  if (!caps) return "";
  const flags: string[] = [];
  if (caps.toolCalling) flags.push("tools");
  if (caps.reasoning) flags.push("reasoning");
  return flags.length > 0 ? ` [${flags.join(", ")}]` : "";
}

function formatUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd?: number }): string {
  const tokens = `${usage.totalTokens.toLocaleString()} tok`;
  return usage.costUsd !== undefined ? `${tokens} · $${usage.costUsd.toFixed(4)}` : tokens;
}

/** Raw tool JSON must never appear as the assistant's answer. */
function looksLikeRawToolJson(text: string): boolean {
  const trimmed = text.trim();
  return /^\{\s*"name"\s*:/.test(trimmed) && /"arguments"\s*:/.test(trimmed);
}

function sanitizeAgentMessage(text: string): string {
  if (looksLikeRawToolJson(text)) {
    return "";
  }
  return text;
}

function mustEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}
