# Spider — AI Project Context

> **Internal engineering context for AI coding agents.** Read this file before
> making any change to this repository. It is not a user-facing README — it is
> the persistent technical memory of the project. Update it whenever you make a
> meaningful architectural or behavioral change (see §18 for maintenance rules).

---

## 1. Project Overview

- **What it is:** Spider (package id `codevia-cursor`, VS Code publisher
  `codevia`) is a VS Code extension providing an AI coding-agent experience
  inside the sidebar as a webview view (`codeviaCursor.agent`).
- **Primary purpose:** a coding agent that chats, calls workspace tools
  (read/write/edit/list/search/move/delete files, run commands), and streams
  its progress — modeled on Continue / Roo Code / Cline UX.
- **Providers:** Cursor (legacy SDK path), Ollama (local), OpenAI-compatible
  local servers (LM Studio etc.), OpenRouter (cloud, live catalog), Mock (UI
  testing). All inference providers run through one shared agent loop.
- **Current development stage:** working end-to-end on Ollama, OpenRouter and
  Mock. Recent work: OpenAI-compatible tool-call-id lifecycle fix, provider
  config persistence, dedicated History page, "Spider" rebrand, streaming UI
  rework (in-place updates, rAF batching), optimistic new-conversation reset,
  **real SSE token streaming (OpenAI-compatible + OpenRouter), runtime
  auto-approve shield, composer model selector, artifact cards, redesigned
  Settings IA (sidebar sections), Spider watermark empty state** (2026-09-27),
  **chat-UI redesign: Copy/Delete message actions with stable transcript ids,
  collapsible tool/command output, live command stdout/stderr streaming**
  (2026-09-28).
- **Identity note:** internal identifiers (`codeviaCursor`, `CodeviaSession`,
  storage keys `codeviaCursor.*`, package name `codevia-cursor`) intentionally
  keep the old name. Only user-facing strings say "Spider". Do NOT rename
  internal identifiers (see §14).

## 2. Core Architecture

Actual implemented flow (verified against source):

```
User (webview GUI, gui/src/main.ts)
  ↓  GuiToHost messages (bridge.ts postMessage)
AgentViewProvider (src/webview/agentViewProvider.ts)
  ↓
MessageRouter (src/webview/messageRouter.ts)      ← validates every message shape
  ↓
RuntimeManager (src/runtime/runtimeManager.ts)    ← sessions, permissions, events
  ↓
AgentRuntime.sendMessage (per provider runtime)
  ↓
runInferenceAgentLoop (src/runtime/tools/inferenceAgentLoop.ts)
  ↓                                              ↺ loop up to MAX_TOOL_ITERATIONS
Model call (completeChat) → parsed tool calls
  ↓
ToolRouter.route (src/runtime/tools/toolRouter.ts)
  ↓  permission check via PermissionManager
RegisteredTool.execute → RuntimeToolExecutor (WorkspaceToolExecutor)
  ↓
Tool result → ChatTurn history (role "tool", tool_call_id)
  ↓
Model observes result → next tool call OR final answer
  ↓
RuntimeEvent stream (RuntimeManager emitter)
  ↓
MessageRouter.toRuntimeExtensionMessage → ExtensionMessage
  ↓
GUI handleHostMessage (gui/src/main.ts) → DOM updates
```

Key points:

- The **GUI never executes tools** and never talks to providers. It only sends
  `GuiToHost` messages and renders `HostToGui` messages.
- `MessageRouter` is the **only** gateway between webview and extension host.
- `RuntimeManager` owns sessions, permission prompts, usage accumulation, the
  event bus, and provider config persistence.
- The agent loop is **provider-independent**: `openaiCompatible`,
  `openrouter`, and `ollama` all call `runInferenceAgentLoop` with their own
  `completeChat` implementation.

## 3. Runtime Architecture

### File
`src/runtime/runtimeTypes.ts`

### Responsibility
All shared runtime types: `AgentRuntime` interface, `CodeviaSession`,
`RuntimeEvent` union, `RuntimeToolCall`, `RuntimeToolResult`, provider config
tagged unions (`OpenRouterRuntimeConfig`, `OpenAICompatibleRuntimeConfig`,
`OllamaRuntimeConfig`, `MockRuntimeConfig`, `CursorRuntimeConfig`),
`RuntimeError` with typed codes.

### Why it exists
Single contract between RuntimeManager and every provider runtime. Adding a
provider means implementing `AgentRuntime`, nothing else.

### Modification rules
Changing `RuntimeEvent`/`RuntimeSendRequest` shapes requires updating
`MessageRouter.toRuntimeExtensionMessage` and the GUI protocol in lockstep.
`command_output` events carry `toolCallId` — keep it.

### RuntimeManager
`src/runtime/runtimeManager.ts` — owns:

- session map + active session id, persisted via `SessionStore` (Memento)
- `setProvider(config)`: cancels active runs, configures the runtime, saves
  the provider config (without secrets) via `ProviderConfigStore`
- `restoreProviderConfig()`: applies saved local-provider configs directly;
  returns OpenRouter configs unapplied so `extension.ts` can re-attach the
  API key from SecretStorage (deferred-apply pattern)
- `startTask`/`retryTask`/`cancelTask` orchestrate runs; `handleToolCall`
  routes through ToolRouter with permission authorization and file-change
  review capture
- event emitter → MessageRouter → GUI; usage accumulation per session
- `listFileChanges`, `resolveFileChange`, `showFileChangeDiff`,
  `openFile` for the write-review flow
- `deleteTranscriptEntry(sessionId, entryId)` (chat UI Delete → durable
  removal) and live command-output coalescing (`pushCommandStream` → partial
  `command_output` events every ~120ms, cleared by the final event)
- agent mode is NOT user-selectable: every run uses `DEFAULT_AGENT_MODE`
  (full registered tool set). See rule 21.
- `recordTranscriptEvent` returns the event to publish, augmented with
  `messageId` for assistant replies (ids are generated host-side so the GUI
  and the persisted entry share one identity)

### Provider abstraction
- `OpenAICompatibleRuntime` (`src/runtime/openaiCompatible/`): generic
  `/chat/completions` client; OpenRouter **composes** it for inference.
- `OpenRouterRuntime` (`src/runtime/openrouter/`): own catalog discovery
  (`/models` with capability/pricing metadata), delegates chat to the
  OpenAI-compatible base (fixed base URL, `baseUrlEditable: false`).
- `OllamaRuntime` (`src/runtime/ollama/`): native Ollama HTTP API
  (`/api/tags`, `/api/chat` with NDJSON streaming), independent of the
  OpenAI-compatible path.
- `MockRuntime` (`src/runtime/mock/`): scripted scenarios for tests/UI.
- `Cursor` path: `AgentManager` + `@cursor/sdk`, legacy, only restored for
  `provider === "cursor"` sessions.

### Shared vs provider-specific
| Concern | Shared | Provider-specific |
|---|---|---|
| Agent loop, tool routing, permissions, history shape | yes (`inferenceAgentLoop`, `toolRouter`) | — |
| Wire serialization | `toOpenAiMessages` (OpenAI-compatible only) | Ollama NDJSON |
| Model discovery | — | catalog mapping per provider |
| Capability source | `RuntimeModel.capabilities` | how it is obtained |
| Auth | — | OpenRouter: SecretStorage key; Ollama: none |

### Configuration persistence
`src/session/providerConfigStore.ts` — `ProviderConfigStore` stores
`{ provider, modelId?, baseUrl? }` under Memento key
`codeviaCursor.providerConfig`. **Secrets never go here.** Wired in
`extension.ts` activation: restore → re-attach OpenRouter key from
SecretStorage → create a session if none exists.

## 4. Agent Architecture

### File
`src/runtime/tools/inferenceAgentLoop.ts`

### Responsibility
`runInferenceAgentLoop(request, history, completeChat, emit, options)` — the
whole decide→execute→observe cycle. `ChatTurn` is the internal conversation
shape; `ChatCompletion` is what `completeChat` returns.

### Important behavior
- `MAX_TOOL_ITERATIONS = 20`, `MAX_INVALID_TOOL_RETRIES = 2`.
- Native tools vs fallback: `options.nativeTools` decides whether tool calls
  come from `parseNativeToolOutput` (provider `tool_calls`) or from
  `parseFallbackToolOutput` (JSON in assistant text). The fallback contract
  prompt (`buildFallbackToolContract`) is generated from the registry.
- Assistant tool-call turn is pushed with `tool_calls[]` where
  `function.arguments` is a **JSON string** (OpenAI wire format).
- Tool result turn: `{ role: "tool", tool_call_id: call.id, content: <JSON> }`
  — `tool_call_id` **must** equal the assistant call id. Missing/empty id →
  typed `RuntimeError` (never send an invalid conversation).
- Invalid/unavailable tool selection → structured feedback user-turn listing
  the available set; bounded retries; never leaks raw tool JSON as chat.
- `finish` tool (`response.finished`) is terminal: final assistant summary is
  emitted, loop returns, no further model calls.
- `prepareHistory` drops a trailing bare tool-call turn (retry) and
  `ensureSystemPrompt` refreshes the system prompt each run.
- Assistant replies are stamped with a transcript entry id (`messageId` on
  the `assistant_message` event) so the chat UI can Copy/Delete exactly the
  persisted message. User prompts carry a GUI-generated id through
  `SEND_PROMPT` → `startTask(..., messageId)` into the same transcript.
- Streaming: `onStreamDelta` hook; Ollama gates streamed text through
  `createStreamGate` so partial tool JSON never reaches the UI. The
  OpenAI-compatible base and OpenRouter now stream for real: when a delta
  hook is present they send `stream: true` and consume SSE via
  `consumeOpenAiSseStream` (`src/runtime/openaiCompatible/sseStream.ts`),
  which merges tool-call fragments by index, preserves provider ids, and
  releases only gate-safe text. `stream: false` remains for non-streaming
  calls (capability `streaming` is still honored).
- The stream gate lives in `src/runtime/ollama/streamGate.ts` (shared by
  Ollama NDJSON and the SSE consumer; re-exported from `ollamaRuntime.ts`).

### Why it works this way
One loop = one place for lifecycle, safety (classification gates, thinking
safety), and history correctness. Provider differences stay in `completeChat`.

### Modification rules
- Never add provider-specific branches here.
- Never break the assistant-tool-call → tool-result id relationship.
- Any new turn shape must keep `toOpenAiMessages` and tests in sync.

## 5. Tool System

### File
`src/runtime/tools/toolRegistry.ts`

### Responsibility
**Single source of truth** for tools: names, descriptions, JSON schemas,
permission classes, example arguments, native chat tool schemas, and the
fallback contract. `isLocalToolName` is the membership test.

### Registered tools (all execute in the extension host via
`WorkspaceToolExecutor` unless noted)

| Tool | Purpose | Parameters | Permission | Result |
|---|---|---|---|---|
| `list_files` | list a directory | `path?` (default `.`) | safe | `{ path, entries[] }` (max 200) |
| `read_file` | read a text file | `path` (required) | safe | `{ path, content }` |
| `search_files` | filename+content search | `query` (required), `path?` | safe | `{ query, matches[] }` (max 50) |
| `write_file` | create/overwrite file | `path`, `content` | modify | `{ path, written, bytes }`; captured for review |
| `edit_file` | exact-string replace | `path`, `old_string`, `new_string` | modify | replaced count; captured for review |
| `create_directory` | mkdir -p | `path` | modify | `{ path, created }` |
| `move_file` | move/rename | `from`, `to` | modify | `{ from, to }` |
| `delete_file` | delete file/empty dir | `path` | **destructive** | `{ path, deleted }` |
| `run_command` | shell command in workspace | `command`, `cwd?`, `timeoutMs?` | execute | `{ command, stdout, stderr, exitCode, cwd? }` |
| `finish` | end the task | `summary` | safe | executed inline in the registry (no executor); sets `finished: true` |

### ToolRouter
`src/runtime/tools/toolRouter.ts` — `route(call, context, authorize, {mode})`:
availability check (mode-based) → registry validation → permission authorize
callback → execute → wraps result as `{ success, tool, message, ...details }`.
Unknown/unavailable tools produce **structured failures back to the model**
(listing the available set) — never exceptions to the user, never execution.
`finish` sets `finished: true` on the response.

### Availability
`src/runtime/tools/toolAvailability.ts` — `AgentMode` (`agent`/`ask`/`plan`)
maps to tool sets. Not an intent router; never inspects user text.

### Permission handling
`src/permissions/permissionManager.ts` + `permissionPolicy.ts`: trust checks,
auto-allow rules, destructive confirmations, request/resolve lifecycle with
timeout. RuntimeManager bridges events to the GUI (Allow/Deny buttons).

**Authorization pipeline (single definition, `PermissionManager.authorize`):**
workspace trust gate → explicit deny (category rule) → policy auto-allow →
runtime shield → prompt. Every caller must go through this order.

**Runtime auto-approve (the composer shield):** a temporary toggle stored in
`PermissionPolicy` (`setRuntimeAutoApprove`), scope `conversation` (reset when
RuntimeManager creates a new conversation) or `runtime`. The shield NEVER
overrides: destructive requests, DESTRUCTIVE category, untrusted-workspace
blocks, explicit user denies, or `deny` category rules. Backend is
authoritative — the GUI toggles optimistically and re-syncs from the
`AUTO_APPROVE_STATE` message the manager echoes.

**Persistent per-category rules (Settings → Auto Approve):**
`PermissionManager` holds `PermissionRule` (allow/ask/deny) per category
(READ/MODIFY/EXECUTE/EXTERNAL/DESTRUCTIVE), persisted through the
`PermissionRulesStore` interface (Memento key `codeviaCursor.permissionRules`
in `extension.ts`). DESTRUCTIVE can never be `allow`. Shape lives in
`src/webview/permissionRules.ts`.

### Modification rules
- **The AI agent must never invent tool names.** To add a tool: add an entry
  to `TOOLS` in `toolRegistry.ts`; schemas/prompts/availability follow
  automatically. Then add executor dispatch + tests.
- Never bypass the registry or router (e.g., no direct `fs` calls from a
  runtime).

## 6. Workspace/File System Architecture

- `src/runtime/tools/workspacePath.ts` — `resolveWorkspacePath`: cleans the
  requested path, resolves against the session workspace root, and **throws
  if the target escapes the workspace** (`isInsideWorkspace`). This is the
  security boundary for every file tool.
- `src/runtime/tools/workspaceToolExecutor.ts` — the actual fs operations.
  Limits: search 50 matches, list 200 entries, skips `.git`, `node_modules`,
  `dist`, `out`, `.vscode`. `run_command` delegates to
  `commandRunner.ts` (workspace cwd, timeout, abort support).
- `src/runtime/review/fileChangeReviewManager.ts` + `diffView.ts` —
  write/edit mutations are captured (before/after), published as
  `file_change` events, and can be diffed/kept/reverted from the GUI.
- Error handling: tool errors are returned as structured results
  (`success: false, error`) to the model, not thrown to the GUI.

## 7. Provider Architecture

To add a provider without breaking existing ones:

1. Add the provider id to `RuntimeProvider` and a config type in
   `runtimeTypes.ts` (extend the tagged union + `RuntimeProviderConfig`).
2. Implement `AgentRuntime`; for OpenAI-compatible APIs, compose or extend
   `OpenAICompatibleRuntime` and reuse `toOpenAiMessages` for the wire body.
3. Register the runtime in `extension.ts` (`RuntimeManager` `routines` array)
   and add a GUI path in `MessageRouter` + `gui/src/protocol.ts` if user
   selectable.
4. Wire capability-driven tool calling from `RuntimeModel.capabilities`
   (never model-name checks — see `OpenRouterRuntime.capabilitiesFor`).
5. Persist user-selectable non-secret config via `ProviderConfigStore`
   (extend `toRuntimeProviderConfig` in RuntimeManager if the config has new
   fields).
6. Add tests mirroring `test/unit/runtime/openrouter/openRouterRuntime.test.ts`.

Credential flow: GUI → MessageRouter → SecretStorage adapter
(`src/auth/secretStorage.ts`) → runtime `configure({ apiKey })`. Keys are only
sent as `Authorization: Bearer` headers — never URLs, never logs.

## 8. OpenRouter

- Base URL: `https://openrouter.ai/api/v1` (`OPENROUTER_BASE_URL`), fixed
  (`baseUrlEditable: false` in the composed inference runtime).
- Auth: `Authorization: Bearer <key>`; key stored in VS Code SecretStorage
  under `codeviaCursor.openrouter.key` (constant
  `OPENROUTER_API_KEY_SECRET_KEY`). A test asserts the key never appears in
  URLs or status messages.
- Model discovery: live `/models` catalog → `RuntimeModel[]` with
  `contextWindow`, `capabilities` (streaming/toolCalling/structuredOutput/
  vision from `architecture.input_modalities` + `supported_parameters`),
  pricing per million tokens. Always fresh for "Refresh models"; a 5-min
  cache serves capability lookups during inference.
- Inference: delegated to `OpenAICompatibleRuntime` (same histories map, so
  `OpenRouterRuntime.historyFor` == inference history). Wire bodies go
  through `toOpenAiMessages` (`src/runtime/openaiCompatible/openAiMessages.ts`).
- **tool_call_id handling (critical, was a real bug):** provider tool-call
  ids are preserved end-to-end: `normalizeNativeCall` keeps `entry.id`,
  `classifyObject` only synthesizes `call_<uuid>` when the model gave none,
  the loop stores assistant `tool_calls[].id` and sends each tool result with
  the **same** `tool_call_id`, and `toOpenAiMessages` throws if a tool turn
  has an empty id. Parallel calls keep their own ids (tests:
  `call_123` round-trip, `call_1`/`call_2` mapping, post-tool "hi" message).
- Streaming: `stream: false` today for chat completions (deltas come from the
  mock/Ollama paths); capability `streaming` is still honored.
- Errors: 401/403 → `authentication_failed`; 429 → retryable
  `provider_unavailable`; 404 → `model_unavailable`; 5xx → retryable.
- Tests: `test/unit/runtime/openrouter/openRouterRuntime.test.ts`,
  `test/unit/runtime/openaiCompatible/openAiMessages.test.ts`,
  `test/unit/webview/messageRouter.openrouter.test.ts`.

**Lesson:** OpenAI-compatible providers reject conversations where a tool
message lacks `tool_call_id` or ids don't match the assistant turn — and the
malformed turn then poisons every later request in the session. Never strip
or regenerate tool-call ids.

## 9. Ollama

- `src/runtime/ollama/ollamaRuntime.ts` — independent implementation using
  Ollama's native API: `/api/tags` for availability + models, `/api/chat`
  with `stream: true` and NDJSON parsing.
- Native tool calling only when `modelSupportsNativeTools(modelId)`
  (`src/runtime/tools/textToolFallback.ts` — small text-only models fall back
  to the JSON-in-text contract; the parser is shared).
- `createStreamGate` buffers possible tool-protocol fragments during
  streaming so partial JSON never reaches the UI.
- **Do NOT modify, replace, or refactor Ollama behavior** when working on
  OpenRouter or other providers unless the task explicitly requires it. It is
  the proven local path (tests: `test/unit/runtime/ollama/ollamaRuntime.test.ts`).

## 10. GUI Architecture

Plain TypeScript DOM (no framework). Built by `esbuild.js` into
`dist/gui/main.js`; CSP-protected webview.

### File
`gui/src/main.ts`

### Responsibility
Single controller: owns `AppState`, handles every `HostToGui` message, renders
views, batches UI syncs (`scheduleUiSync` → one rAF per event burst).

### Components (all built once, updated in place)
- `components/messageList.ts` — the most performance-sensitive file. Appends
  lines; **streaming text mutates one text node** (`upsertStreamingLine`,
  rAF-coalesced); tool/command boxes are upserted in place by `toolCallId`
  (`upsertToolLine`, `upsertCommandLine`, `completeCommandLine`);
  sticky-bottom scroll batched per frame; `clear()` for new conversations;
  `replaceAll` only for real conversation switches.
- `components/composer.ts` — Send/Cancel/Try Again; never rebuilt while
  typing (a rebuild once ate clicks between mousedown/mouseup).
- `components/sessionBar.ts` — History dropdown + New button.
- `components/historyList.ts` — dedicated History page list.
- `components/providerSettings.ts` + `views/settingsView.ts` — provider
  cards (Cursor, Local, OpenRouter, Mock).
- `state.ts` — `AppState`, `ChatLine` (roles incl. `tool`), `AgentPhase`
  state machine (`idle → submitting → streaming ⇄ toolRunning → completed/
  failed/cancelled`), `phaseFromAgentState`.
- `protocol.ts` — `GuiToHost` / `HostToGui` mirrors of `src/webview/types.ts`
  (keep both in sync).
- `bridge.ts` — `postToHost` / `onHostMessage` over `acquireVsCodeApi`.

### GUI ↔ backend communication
`GuiToHost` messages (SEND_PROMPT, NEW_SESSION, SELECT_SESSION,
GET_TRANSCRIPT, CONNECT_*, SELECT_*_MODEL, APPROVE/DENY_PERMISSION,
SET_RUNTIME_AUTO_APPROVE, GET/SET_PERMISSION_RULE, GET_EXTENSION_INFO, ...)
→ `AgentViewProvider.onDidReceiveMessage` → `MessageRouter.handleMessage`
(result forwarded back if `shouldForwardResult`). Runtime events flow
continuously: `RuntimeManager.onDidPublishEvent` → `toRuntimeExtensionMessage`
→ `webview.postMessage`.

### Execution UI
Tool/command lifecycle rendered as exec boxes: `tool_requested → running →
completed/failed`; commands show progressively updated output. Backend events
are the source of truth for `phase`; the UI never infers state from text.

### Message actions & collapsible output (2026-09-28)
- **Stable message ids:** every assistant reply carries the transcript entry
  id (from `AGENT_MESSAGE.messageId`); user prompts carry a GUI-generated id
  echoed through `SEND_PROMPT`. `TRANSCRIPT` entries include `id`, so
  restored messages stay actionable.
- **Copy / Delete:** `messageList` attaches a `message-actions` bar to
  user/assistant messages that have an id. It is CSS-hidden until hover or
  keyboard focus (touch shows it always) and mutates in place — never a
  rebuild. Copy uses `navigator.clipboard` with a textarea fallback. Delete
  removes the row, drops the line from `AppState.messages`, and posts
  `DELETE_MESSAGE` so the transcript entry is erased too.
- **Collapsible exec output:** tool/command boxes toggle
  `data-expanded` (one attribute write, CSS-driven show/hide). Running boxes
  stay open; finished long command output collapses behind a `Details`
  button. Manual toggles set `data-userToggled` so the automatic settle never
  fights the user.

### Text streaming UX (2026-09-27)
Full path: provider chunks (Ollama NDJSON / OpenAI-compatible + OpenRouter
SSE) → stream gate → `onStreamDelta` → `text_delta` runtime event →
`AGENT_TEXT_DELTA` → **delta coalescer (~110ms cadence, `main.ts`)** →
`messageList.upsertStreamingLine` (accumulates into one text node) → paint +
sticky-bottom scroll on the same frame. Tool-call events are separate
activity blocks and never merge into the text stream. The streaming line
keeps the caret (`.streaming-line::after`) while active; finalization
(`AGENT_MESSAGE`/terminal `AGENT_STATE`) flushes, then replaces the text with
the finalized model message exactly once. Cancellation and error paths flush
partially streamed text before appending their error line, then reset the
coalescer so stale deltas cannot leak into the next run.

### Agent activity blocks & artifacts (2026-09-27)
- **Thinking block:** `AGENT_THINKING` upserts one live status element
  (`message-thinking-block`, state `active`/`settled`). It settles — not
  disappears — when the next tool/response arrives. It represents safe status
  only, never hidden reasoning (classification gates in the loop).
- **Artifact cards:** `FILE_CHANGE` / `FILE_CHANGE_REVERTED` render as
  artifact cards (path, +N −N, Created/Updated/Reverted, Open/View changes/
  Keep/Revert) via `messageList.upsertArtifact`, matched by `changeId`.
  Artifacts are derived ONLY from real file_change events — none are invented.
- **Empty-state watermark:** `assets/spider-icon.png` is copied to
  `dist/gui/` by esbuild, its webview URI injected as `<meta name="spider-logo">
  by AgentViewProvider, and rendered (pointer-events: none, ~7-9% opacity,
  theme-aware, reduced-motion safe) only while the conversation is empty.
- **Composer toolbar:** model selector + shield live in the composer
  (`createComposer`), built once, updated in place. The model options derive
  from the SAME provider state as Settings (no second catalog); changing the
  model posts the same SELECT_*_MODEL messages Settings uses. The shield
  toggles optimistically and syncs from the authoritative AUTO_APPROVE_STATE.
- **Live command output:** `run_command` streams stdout/stderr through
  `RuntimeToolExecutorContext.onOutput` → `commandRunner.onOutput` →
  RuntimeManager partial `command_output` events (coalesced ~120ms). The
  agent loop's final `command_output` event keeps the authoritative exit
  code and clears the buffer.

### Settings information architecture (2026-09-27)
`views/settingsView.ts` renders a two-column layout: fixed-width sticky
sidebar (Models / Agent Behaviour / Auto Approve / Indexing / About Spider) +
responsive content column (`settings-layout` flex, not grid — sidebar cannot
compress content). Section state: `AppState.settingsSection`.
- **Models** — the existing provider cards (single provider config store).
- **Agent Behaviour** — documentation of code-fixed behavior only
  (MAX_TOOL_ITERATIONS, mode, thinking display, zero-token restore); no fake
  controls for unsupported settings.
- **Auto Approve** — per-category Allow/Ask/Deny (persistent rules, see §5)
  plus the temporary shield state. Destructive is pinned to Ask.
- **Indexing** — no indexing system exists (src/context is editor context
  only); the section is explicitly marked "Not implemented yet" — no fake
  progress.
- **About Spider** — logo, version/publisher/license/provider from
  `EXTENSION_INFO` (populated at webview resolve from `EXTENSION_VERSION`).

## 11. Session & History Architecture

- `CodeviaSession` (`runtimeTypes.ts`) is the runtime conversation record:
  `sessionId`, provider, modelId, workspacePath, providerSessionId/agentId,
  status, timestamps, currentTask, error.
- Persistence: `src/session/sessionStore.ts` (Memento keys
  `codeviaCursor.sessions`, `codeviaCursor.activeSession`) +
  `src/session/transcriptStore.ts` (one append-only JSONL per session in
  extension global storage; torn tails discarded on read). Entries may carry
  an `id` (stable message identity); `removeEntry(sessionId, entryId)`
  rewrites the JSONL without that entry, serialized behind the append queue
  (chat UI Delete must be durable, not just a UI removal).
- **Transcripts are display-only:** restoring history never re-sends it to
  the model (zero tokens). The in-runtime model history
  (`histories: Map<sessionId, ChatTurn[]>` in each inference runtime) is
  separate and lives only for the extension-host lifetime.
- Creating a new conversation: GUI `startNewConversation()` resets state
  optimistically (clears messages, `pendingNewConversation` guards the
  composer) and posts `NEW_SESSION`; `MessageRouter` **reuses the active
  session while its transcript is still empty** (dedupe against New-click
  spam), else `createSession`.
- Loading history: History page → `SELECT_SESSION` + `GET_TRANSCRIPT` →
  `TRANSCRIPT` message → `replaceAll`. Stale-guard
  (`loadedTranscriptSessionId`) prevents an old transcript from overwriting
  the active view; the optimistic reset re-points the guard *before*
  requesting.
- Concepts kept separate: active conversation state (GUI), provider/session
  runtime state (RuntimeManager), historical records (SessionStore +
  TranscriptStore). Do not merge them.

## 12. Authentication & Configuration

- `src/auth/secretStorage.ts` — `SecretStorage` interface +
  `VSCodeSecretStorageAdapter`.
- `src/auth/cursorAuthProvider.ts` / `cursorClient.ts` / `cursorConnection.ts`
  — Cursor path (auth provider id `codeviaCursor`); legacy but maintained.
- OpenRouter key: SecretStorage key `codeviaCursor.openrouter.key`; stored on
  CONNECT_OPENROUTER, deleted on DISCONNECT; re-attached at activation by
  `extension.ts` when a saved OpenRouter provider config exists.
- Provider config (non-secret): `ProviderConfigStore` (see §3).
- **Never** expose secrets to the GUI, logs, URLs, or error messages (tests
  assert this for OpenRouter). Never persist API keys in Memento/globalState.

## 13. Testing

- Runner: Vitest (`vitest.config.ts`), unit tests in `test/unit/**` (node
  env, globals). Integration smoke: `test/integration/extension.test.ts`
  (`pnpm run test:integration`, needs VS Code).
- Layout mirrors `src/`: `runtime/tools/*` (loop, parsing, registry, router,
  executor, availability, thinking safety, calculator scenario),
  `runtime/openrouter/*`, `runtime/openaiCompatible/*`, `runtime/ollama/*`,
  `runtime/review/*`, `runtime/runtimeManager.*` (tools/transcript/usage),
  `webview/messageRouter.*` (openrouter/transcript/newSession),
  `session/*` (sessionStore/transcriptStore/providerConfigStore),
  `agent/*`, `auth/*`, `permissions/*`, `shared/*`.
- vscode is mocked where needed (EventEmitter stub, see
  `runtimeManager.usage.test.ts`); filesystem tests use `fs.mkdtemp`.
- Shield/auto-approve → `permissions/runtimeAutoApprove.test.ts` (policy
  precedence, deny-wins, conversation reset, RuntimeManager integration) and
  `webview/messageRouter.autoApprove.test.ts` (authoritative echo, rules,
  validation).
- SSE streaming → `runtime/openaiCompatible/sseStream.test.ts` (delta
  assembly, tool-fragment merging + id preservation, tool-JSON never in
  deltas, stream:true/false gating, OpenRouter round-trip).
- Streaming UX coalescing → `gui/streamCoalescer.test.ts` (cadence batching,
  immediate first paint, idle rescheduling, single final flush, cancellation),
  using a fake scheduler — no real timers in tests.
- Message actions → `runtime/runtimeManager.messageActions.test.ts`
  (assistant id stamping, user id from composer, durable delete, plus the
  guard that every run uses agent mode and the default tool set contains every
  registered tool) and `webview/messageRouter.messageActions.test.ts`
  (DELETE_MESSAGE validation; SET_AGENT_MODE is rejected as an unknown
  message). Persistence → `session/transcriptStore.removeEntry.test.ts`
  (targeted removal, no resurrection after restart, no-op guards).
- Agent tool flow (the regression guard) →
  `runtime/openrouter/openRouterToolFlow.test.ts` (streamed native `write_file`
  executes with its provider id preserved; the write_file/read_file/edit_file
  schemas are sent; pins that a mode excluding a registry-known tool produces
  the "Unknown tool" message) and
  `runtime/openrouter/openRouterAgentFlow.integration.test.ts` (the exact
  reported request creates a real file through the real ToolRouter +
  WorkspaceToolExecutor, plus multi-step read_file → edit_file → finish and
  assistant `tool_calls[].id` == `tool_call_id` integrity).
- Live command output → `runtime/tools/commandRunner.output.test.ts`
  (chunk hook + unchanged non-streaming result) and
  `runtime/runtimeManager.commandStream.test.ts` (partial events while a
  command runs).
- **What to test when touching a subsystem:**
  - agent loop → `inferenceAgentLoop.test.ts` + `thinkingSafety` +
    `invalidToolRecovery` (add tool-id lifecycle cases there or in
    `openAiMessages.test.ts`)
  - OpenAI-compatible wire format → `openAiMessages.test.ts` (tool_call_id
    round-trip, parallel calls, missing-id rejection)
  - MessageRouter changes → `messageRouter.*.test.ts`
  - session/history → `sessionStore`, `transcriptStore`,
    `providerConfigStore` tests
- Commands: `pnpm run typecheck` (both tsconfigs), `pnpm run lint`
  (`--max-warnings 0`), `pnpm run test`, `pnpm run compile`.

## 14. Important Architectural Rules

1. Do not bypass the Agent Loop; all model turns go through
   `runInferenceAgentLoop`.
2. Do not execute tools directly from the GUI or a runtime; always
   ToolRouter → registry → executor.
3. Do not create provider-specific logic inside the generic agent loop.
4. Do not duplicate provider configuration storage (one `ProviderConfigStore`;
   secrets only in SecretStorage).
5. Do not hardcode model names when capability metadata can be used
   (exception: the deliberate small-model fallback list in
   `textToolFallback.ts`).
6. Do not invent tool names; the registry is the source of truth.
7. Do not break Ollama while adding OpenRouter/provider functionality.
8. Do not expose private chain-of-thought; only safe progress/status lines
   reach the Thinking UI (enforced by classification gates + tests).
9. Do not silently fall back from agent/tool mode to plain chat.
10. Preserve `tool_call_id` relationships; never strip/regenerate ids.
11. Do not rename internal identifiers (`codeviaCursor*`, `CodeviaSession`,
    package name, storage keys) — display name only is "Spider".
12. Prefer existing abstractions over parallel architectures; no second
    session/history/provider store.
13. Keep GUI rendering in-place: never rebuild the message list per event
    (this caused real unclickable-button bugs).
14. `gui/src/protocol.ts` and `src/webview/types.ts` must stay in sync.
15. The shield is convenience, never a bypass: trust, destructive requests,
    deny rules, and explicit user denies always win over runtime
    auto-approve. Conversation-scope shields reset on new conversations.
16. Artifacts come only from real file_change events; never synthesize them
    in the GUI.
17. User-facing chat UI never says "Session" for a conversation (internal ids
    keep the name).
18. Message Delete must be durable: removing a message always erases its
    transcript entry (id-based `removeEntry`), never just the DOM row.
19. Assistant replies and user prompts must keep one stable id across the UI
    and the persisted transcript; never regenerate ids when restoring.
20. Command output is streamed but coalesced host-side (~120ms); partial
    `command_output` events are never written to the transcript — only the
    final event is.
21. Agent mode is an INTERNAL runtime concern. Never expose it as a user
    choice and never let a UI control restrict the tool set: a registered tool
    outside the current available set is reported to the model as an unknown
    tool, which silently breaks autonomous tool use (real regression,
    2026-09-28). Every shipped run uses `DEFAULT_AGENT_MODE`.
22. The model chooses tools from the registered schemas it is sent. Never
    require the user to pick a tool or a mode; the agent loop, not the UI,
    decides what set the model may choose from.

## 15. Known Bugs / Limitations

### Fixed
- **Registered tools reported as "Unknown tool" (autonomous tool use broken):**
  a composer Code/Ask/Plan selector made `DEFAULT_AGENT_MODE`
  user-controllable, so a read-only selection removed `write_file`,
  `edit_file`, `run_command` etc. from `availableToolNames(mode)` and the
  agent loop told the model `Unknown tool "write_file". Choosing from the
  available tools…` — the model then could not create a file even though the
  user never asked it to choose a tool. Fixed by reverting the selector and
  the `SET_AGENT_MODE` protocol entirely; `RuntimeManager.startTask` again
  hardcodes `DEFAULT_AGENT_MODE`. Regression tests in
  `openRouterToolFlow.test.ts` + `openRouterAgentFlow.integration.test.ts`
  (2026-09-28).
- **OpenAI-compatible tool history (OpenRouter 400
  `tool messages must include a non-empty string tool_call_id`):** tool
  results were serialized without `tool_call_id` and the parser dropped
  provider call ids. Fixed in `inferenceAgentLoop.ts` + `parseToolCalls.ts` +
  new `toOpenAiMessages` serializer; regression tests added. (2026-09-26)
- **Provider settings not restored on restart:** added
  `ProviderConfigStore` + `restoreProviderConfig` + OpenRouter key
  re-attach from SecretStorage.
- **Intermittently unclickable UI:** per-token `replaceAll` rebuilt DOM
  under the pointer. Fixed with in-place streaming/upserts + rAF batching.
- **"New" conversation only appeared after first message:** stale-transcript
  guard discarded the new session's empty transcript. Fixed with optimistic
  reset (`pendingNewConversation`) + guard re-pointing + host-side
  empty-session dedupe.

### Active / Limitations
- Chat completions now stream (`stream: true` + SSE) on OpenAI-compatible and
  OpenRouter whenever a delta hook is present; Ollama and Mock stream via
  their own paths. Non-streaming JSON calls remain for capability checks and
  tests.
- In-runtime model history is memory-only; after a VS Code restart a session
  continues with an empty model history (transcript display is preserved).
- Cursor SDK path is legacy; restored sessions skip non-cursor providers in
  RuntimeManager (`restoreSessions` filters `provider === "cursor"` the other
  way around in AgentManager — each manager owns its provider).
- History entries show the first task text as the title; no per-conversation
  titles yet.

### Architectural Risks
- `gui/src/protocol.ts` and `src/webview/types.ts` can drift (manual sync).
- `ChatTurn` shape changes must update both runtimes and the serializer —
  TypeScript catches most, but runtime id semantics are only test-enforced.
- The dedupe-on-empty New behavior depends on transcript emptiness; a
  session with only system entries counts as non-empty.

## 16. Important Historical Decisions

- **OpenRouter composes OpenAICompatibleRuntime** — one wire-format
  implementation, catalog logic stays separate; avoids a second chat client.
- **One shared provider-independent agent loop** — lifecycle/safety fixed in
  one place; providers differ only in `completeChat`.
- **Tool execution centralized in ToolRouter + registry** — permission,
  validation, availability, and structured unknown-tool recovery cannot be
  bypassed by any provider.
- **Registry-generated prompts/schemas** — system-prompt fallback contract
  and native tool schemas are generated from the registry so they can never
  drift from execution.
- **Capability-driven tool calling** (from catalog metadata, not model-name
  checks) — new models work without code changes.
- **Transcript restore costs zero tokens** — display-only persistence keeps
  the model history and the user-visible history decoupled.
- **In-place GUI updates** — the message list mutates instead of rebuilding;
  fixes both click reliability and streaming performance.
- **Two-layer streaming coalescing (2026-09-27)** — deltas are never painted
  per token or per event. The GUI controller coalesces host deltas on a
  ~110ms cadence (`gui/src/streamCoalescer.ts`, injectable scheduler for
  deterministic tests), and the message list accumulates chunks into ONE text
  node (append + repaint, never rebuild). The first chunk paints immediately
  (no start latency); idle gaps cancel the timer; `close()` flushes the tail
  exactly once, so finalization cannot duplicate text.
- **Turn boundaries reset the stream segment** — thinking blocks, tool calls,
  and command blocks call `endStreamingTurn()` (flush + fresh accumulator),
  so assistant text before/after a tool block are separate lines and tool
  events stay visually independent from text streaming.
- **One authorization pipeline (2026-09-27)** — trust → deny → auto-allow →
  shield → prompt is defined once in `PermissionManager.authorize` so the
  shield can never be wired around the hard gates.
- **Shield state is backend-authoritative** — the GUI flips optimistically
  and re-syncs from the `AUTO_APPROVE_STATE` echo; a conversation-scope
  shield resets when a new conversation is created.
- **SSE streaming reuses the same classification downstream (2026-09-27)** —
  streamed tool-call fragments are merged then parsed by
  `parseNativeToolCalls` exactly like non-streamed output, and delta text
  passes through the same stream gate as Ollama, so no second safety path
  exists.
- **Stable message identity lives in the transcript (2026-09-28)** — ids are
  minted host-side (assistant) or supplied by the GUI and echoed back (user),
  so Copy/Delete target exactly one persisted entry and History restore keeps
  working. The alternative (GUI-only ids) would leave deletion unable to
  reach persistence.
- **Command output is coalesced at the host, not the UI (2026-09-28)** — a
  chatty build would otherwise flood the webview with IPC messages. The final
  `command_output` event stays authoritative so coalescing can never lose the
  exit code or truncate the result.
- **Agent mode stays an internal constant (2026-09-28)** — a composer
  Code/Ask selector was tried and reverted: making `DEFAULT_AGENT_MODE`
  user-controllable let a read-only selection filter `write_file`/`edit_file`
  out of the available set, and the loop then told the model those tools were
  unknown. Tool availability must never be reachable from the UI.
- **Secrets stay in SecretStorage; config persistence holds no credentials** —
  restore re-attaches the OpenRouter key at activation.

## 17. Current Development Status

- **Completed (2026-09-25/26):** OpenAI-compatible tool-call id lifecycle +
  regression tests; provider config persistence (+ restore at activation);
  dedicated History page + "History" terminology; Spider rebrand (display
  only); exec-box agent UI (thinking/tool/command lifecycle); streaming
  rework (in-place updates, rAF batching, sticky scroll, reduced-motion);
  optimistic New-conversation reset + host-side dedupe (+ tests).
- **Completed (2026-09-27, UI/agent experience redesign):** real SSE token
  streaming for OpenAI-compatible + OpenRouter (shared `sseStream.ts` +
  `streamGate.ts`, tool-fragment assembly, id preservation, + tests);
  runtime auto-approve shield (policy + manager + RuntimeManager pipeline,
  backend-authoritative echo, conversation-scope reset, deny/destructive/trust
  precedence, + tests); persistent per-category permission rules
  (Settings → Auto Approve, + tests); composer model selector + shield
  toolbar; Thinking status block (active/settled); artifact cards from
  file_change events; Spider watermark empty state; Settings sidebar IA
  (Models / Agent Behaviour / Auto Approve / Indexing / About Spider);
  `AUTO_APPROVE_STATE` / `PERMISSION_RULES` / `EXTENSION_INFO` protocol
  messages; session-terminology sweep in chat UI.
- **Completed (2026-09-28, chat UI redesign):** Copy/Delete message actions
  with stable ids (composer-generated user ids, host-generated assistant ids)
  and durable transcript deletion; collapsible tool/command output; composer
  live command stdout/stderr streaming (coalesced host-side); new tests for
  all of the above. A composer agent-mode selector was added and then reverted
  (see §15 Fixed) because it gated registered tools out of the model's
  available set.
- **Current:** documentation/context (this file). All checks green:
  typecheck, lint (0 warnings), 332 unit tests, compile.
- **Next planned:** per-conversation titles; collapsible exec boxes;
  workspace indexing (reserved Settings section exists, honestly marked);
  agent behaviour settings if/when the backend supports them.
- **Blockers:** none known.

## 18. AI Agent Instructions

### Instructions for Future AI Agents

1. Read this file first; it reflects the source as of its last update.
2. Inspect the relevant source files before modifying anything — do not
   assume architecture from filenames alone.
3. Follow existing abstractions (AgentRuntime, ToolRouter, MessageRouter);
   do not create parallel ones.
4. Search for usages before changing public interfaces
   (`code_search` on the symbol).
5. Run `pnpm run typecheck && pnpm run lint && pnpm run test` before and
   after changes; keep all green.
6. Change only what the task requires; no unrelated refactors.
7. Do not rewrite working provider implementations (especially Ollama)
   unnecessarily.
8. Explain architectural impact before large changes; get user agreement on
   non-obvious decisions.
9. Keep `gui/src/protocol.ts` and `src/webview/types.ts` in sync.
10. Never log, display, or persist API keys outside SecretStorage.

### Maintenance Rule

Whenever you make a meaningful architectural or behavioral change:

1. Update **only the affected sections** of this file — never rewrite it wholesale.
2. Update the file/module description if responsibilities changed.
3. Update architecture/data-flow sections if flows changed.
4. Add fixed bugs to §15 (Fixed) and new risks/limitations to §15 (Active).
5. Record new decisions with rationale in §16.
6. Update §17 (status) with dates.
7. Keep historical context unless demonstrably obsolete.
8. Keep the document accurate to the actual source code — verify claims
   against the code when in doubt.
