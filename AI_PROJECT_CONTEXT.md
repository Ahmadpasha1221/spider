# Spider — AI Project Context

> **Internal engineering context for AI coding agents.** Read this file before
> making any change to this repository. It is not a user-facing README — it is
> the persistent technical memory of the project. Update it whenever you make a
> meaningful architectural or behavioral change (see §18 for maintenance rules).

---

## 1. Project Overview

- **What it is:** Spider (package id `codevia-cursor`, VS Code publisher
  `codevia`) is a VS Code extension providing an AI coding-agent experience
  as an **editor-area tab** (Codex / Cline / Kilo style, `spider.openAgent`
  / `spider.openAgentEditor`) plus the same agent in the activity-bar
  sidebar webview view (`codeviaCursor.agent`).
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
  (2026-09-28), **editor-area Spider tab (Codex/Cline/Kilo style) sharing
  one AgentWebviewHost with the sidebar, clickable Spider logo header
  button + status-bar item that opens/focuses the tab, History as a real
  editor tab** (2026-09-29).
- **Identity note:** internal identifiers (`codeviaCursor`, `CodeviaSession`,
  storage keys `codeviaCursor.*`, package name `codevia-cursor`) intentionally
  keep the old name. Only user-facing strings say "Spider". Do NOT rename
  internal identifiers (see §14).

## 2. Core Architecture

Actual implemented flow (verified against source):

```
User (webview GUI, gui/src/main.ts — sidebar view OR editor tab)
  ↓  GuiToHost messages (bridge.ts postMessage)
AgentWebviewHost (src/webview/agentWebviewHost.ts) ← every surface; OPEN_HISTORY /
  OPEN_AGENT_EDITOR (clickable Spider logo) handled here
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
| Auth | `ProviderCredentialStore` keyed by profile id | which provider accepts a credential |

### Configuration persistence (provider profiles, 2026-09-29)
`src/session/providerConfigStore.ts` — `ProviderConfigStore` holds **provider
profiles**: `ProviderProfile { id, name, provider, modelId?, baseUrl?,
metadata? }` plus `activeProfileId`, under Memento key
`codeviaCursor.providerProfiles`. `profileIdFor(provider, baseUrl)` derives a
stable id (`openrouter-default`, `ollama-http-127-0-0-1-11434`, …) — one
profile per provider, plus one per distinct local endpoint.

Backward compatibility: the legacy single-slot key
`codeviaCursor.providerConfig` is still **read** (migrated in memory into one
active profile on first load) and still **written** (the active profile is
projected into it), so older builds and existing consumers keep working.
`load()` returns the active profile in the legacy shape plus its `profileId`.

**Secrets never go here.** Credentials live in SecretStorage, keyed per profile
by `src/auth/providerCredentials.ts`
(`codeviaCursor.provider.<profileId>.apiKey`). Wired in `extension.ts`
activation: restore selection → resolve the profile's credential →
`RuntimeManager.completeRestore` → create a session if none exists.

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
| `search_files` | filename+content search | `query` (required), `path?`, `includeIgnored?` | safe | `{ query, matches[] }` (max 50) |
| `write_file` | create/overwrite file | `path`, `content` | modify | `{ path, written, bytes }`; captured for review |
| `edit_file` | exact-string replace | `path`, `old_string`, `new_string` | modify | replaced count; captured for review |
| `create_directory` | mkdir -p | `path` | modify | `{ path, created }` |
| `move_file` | move/rename | `from`, `to` | modify | `{ from, to }` |
| `delete_file` | delete file/empty dir | `path` | **destructive** | `{ path, deleted }` |
| `run_command` | shell command in workspace | `command`, `cwd?`, `timeoutMs?` | execute | `{ command, stdout, stderr, exitCode, cwd? }` |
| `read_multiple_files` | read up to 20 known files in one call | `files` (array, required) | safe | `{ files[{path,content,size}], errors[], requested, returned, totalBytes, truncated? }` |
| `grep_search` | content search (text or regex) | `query` (required), `path?`, `isRegex?`, `caseSensitive?`, `fileGlob?`, `maxResults?` | safe | `{ query, path, matches[{path,line,column,text}], scannedFiles, truncated?, reason? }` |
| `glob_search` | file-path search by glob | `pattern` (required), `path?`, `maxResults?` | safe | `{ pattern, path, files[...], scannedFiles, truncated?, reason? }` |
| `get_diagnostics` | current VS Code diagnostics | `scope?` (`workspace`/`file`), `path?` | safe | `{ scope, diagnostics[{path,severity,message,source?,code?,start,end}], counts, truncated? }` |
| `git_status` | read-only Git working tree | `path?`, `includeIgnored?` | safe | `{ repository, branch, detached, ahead, behind, clean, files[{path,status,staged,originalPath?}], truncated? }` |
| `git_diff` | read-only Git diff (working tree / staged / one file) | `scope?` (`working_tree`/`staged`/`file`), `path?` (required for `file`) | safe | `{ repository, scope, path?, files[{path,status,additions,deletions}], diff, truncated?, reason? }` |
| `git_log` | read-only Git history | `limit?` (default 20, max 100), `path?` | safe | `{ repository, limit, path?, commits[{hash,shortHash,author,date,subject}], truncated?, reason? }` |
| `get_active_file` | identity of the file the developer is editing | `includeWorkspaceFolders?` | safe | `{ file: {path?,name,languageId,lineCount,isDirty,version,untitled?,outsideWorkspace?,workspaceFolder?} \| null, workspaceFolders?, message? }` (never contents) |
| `get_selection` | current editor selection(s) + selected text | `maxChars?` (default 4000, max 20000) | safe | `{ selection \| selections[], truncated? }`; ranges as `{line,column}`, text redacted/truncated, empty for sensitive files |
| `background_command` | start a long-running process without blocking the agent | `command` (required), `args?`, `cwd?`, `startupTimeoutMs?` | execute | `{ processId, command, args, cwd, status, pid?, exitCode?, error?, stdout?, stderr?, outputTruncated?, cancelled?, message? }` |
| `get_command_output` | read recent output of a `background_command` process | `processId` (required), `maxBytes?`, `maxLines?` | safe | `{ processId, status, stdout, stderr, truncated, stdoutTotal, stderrTotal }` |
| `kill_command` | stop a Spider-started process | `processId` (required), `force?` | execute | `{ processId, status, message? }` |
| `ask_user` | ask the user a clarifying question and wait | `question` (required), `options?`, `defaultOption?`, `context?` | safe | `{ requestId, answer, cancelled?, message? }` |
| `update_todo` | replace the task plan for the current conversation | `items` (required, max 50) | safe | `{ sessionId, items[], updatedAt, counts, inProgressId? }` |
| `fetch_url` | retrieve one specific URL (https, http loopback) | `url` (required), `maxBytes?`, `timeoutMs?` | **external** | `{ url, status, contentType, content, truncated?, unsupported?, redirects?, bytes?, reason?, message? }` |
| `search_web` | search the public web for links + snippets (not a page fetcher) | `query` (required, max 400), `maxResults?` (default 5, max 20), `recencyDays?` | **external** | `{ query, results[{title,url,snippet,source?}], provider?, truncated?, reason?, message? }` |
| `codebase_search` | intent-oriented repository search over code regions | `query` (required), `maxResults?` (default 8, max 20) | safe | `{ query, results[{path,startLine,endLine,score,matchedTerms[],reason}], scannedFiles, truncated?, reason? }` |
| `repo_map` | compact structural tree of the repository | `depth?` (default 3, max 6), `path?` | safe | `{ root, tree[], entries, truncated, cancelled? }` |
| `git_show` | read-only metadata + bounded diff for one commit | `commit` (required), `path?` | safe | `{ repository, commit{hash,shortHash,author,date,subject}, path?, files[], diff, truncated, reason? }` |
| `git_blame` | read-only per-line attribution for a bounded range | `path` (required), `startLine?`, `endLine?` (max 200 lines) | safe | `{ repository, path, startLine, endLine, lines[{line,commit,shortCommit,author,date,summary}], truncated?, reason? }` |
| `list_symbols` | code symbols from one file or the workspace (no parsing) | `scope?` (`document` default / `workspace`), `path?` (required for document), `query?` | safe | `{ scope, path?, symbols[{name,kind,path,range,detail?,children?}], truncated, reason? }` (max 200) |
| `go_to_definition` | resolve the symbol at a position to its definition(s) | `path`, `line`, `character` (all required, zero-based) | safe | `{ path, definitions[{path,range}], truncated?, reason? }` (max 20); empty list + message when none |
| `find_references` | usages of the symbol at a position | `path`, `line`, `character`, `includeDeclaration?` (default true) | safe | `{ path, includeDeclaration, references[{path,range}], truncated, reason? }` (max 500) |
| `get_problems` | diagnostics VS Code currently reports | `scope?` (`workspace` default / `file`), `path?` (required for file) | safe | `{ scope, path?, problems[{path,severity,message,source?,code?,range}], summary, truncated, reason?, note? }` (max 500) |
| `run_tests` | run the project's test suite with an approved runner | `runner` (required, allow-list), `args?` (argv) XOR `path?`+`filter?` (target contract), `cwd?`, `timeoutMs?` (default 120000, max 300000) | **execute** | `{ runner, args, command, cwd, path?, filter?, passed, exitCode, durationMs, stdout, stderr, timedOut, cancelled?, truncated, status }` |
| `finish` | end the task | `summary` | safe | executed inline in the registry (no executor); sets `finished: true` |

### Shared tool building blocks (Phase 1, 2026-09-29)
- `toolError.ts` — the ONE error vocabulary (`invalid_input`, `permission_denied`,
  `not_found`, `workspace_violation`, `timeout`, `cancelled`,
  `dependency_unavailable`, `too_large`, `budget_exceeded`, `internal_error`),
  `ToolExecutionError`, and `toToolErrorInfo` (maps Node error codes; never
  surfaces a stack).
- `workspacePath.ts` — lexical boundary check (`resolveWorkspacePath`) plus
  `resolveWorkspacePathSafe`, which re-verifies the real path so a symlink
  cannot escape the workspace. Every filesystem tool resolves through these.
- `workspaceSearch.ts` — ONE walker (sorted, depth-limited, symlink-verified),
  the shared ignore set (`.git`, `node_modules`, `dist`, `out`, `build`,
  `coverage`, `.next`, `__pycache__`, `.venv`, …), binary detection, glob
  compilation and the search limits. `search_files`, `grep_search`,
  `glob_search` and `read_multiple_files` all sit on it.
- `filesystemTools.ts` — `readWorkspaceTextFile` (shared by `read_file` and
  `read_multiple_files`) + the multi-file reader and its caps
  (20 files / 60 KB each / 120 KB total).
- `gitStatusTool.ts` — argv-only `git` runner (`shell: false`,
  `--no-optional-locks`, 15 s timeout, output capped, read only), the
  porcelain v2 parser, and the shared `isNotARepository` predicate reused by
  every git tool.
- `gitDiffTool.ts` / `gitLogTool.ts` (Phase 2) — read-only git inspection. The
  model supplies only a *scope / limit / pathspec*; Spider builds the fixed
  argv (`--no-ext-diff`, `--no-textconv`, `--unified=3`, `--find-renames`,
  `--max-count`). The unified-diff and commit-record parsers reject anything
  that does not look like real git output (no injected records); diffs are
  capped at 200 KB and history at 100 commits with `{truncated:true, reason}`.
- `../editor/editorContextSource.ts` + `editorTools.ts` (Phase 2) — injectable
  editor context mirroring `diagnosticsSource` (`vscode` imported lazily). The
  tools depend on the interface, not VS Code, so they are testable outside the
  extension host. `get_active_file` returns identity only; `get_selection`
  returns ranges plus redacted, capped text (empty for sensitive files).
- `backgroundProcessManager.ts` (Phase 2) — the managed background-process
  registry (in-memory only, bounded rolling per-stream buffers, retained-
  process cap). `background_command` starts an argv-only process
  (`shell: false`, `windowsHide: true`); when a resolved `context` is passed the
  launch is backend-aware (WSL bridge) while the record keeps the caller's
  command/args; **the tool request is decoupled from
  the process lifetime** — cancelling an agent run stops waiting for startup
  but never kills a process that already started. Only `stop()`/`dispose()`/
  `shutdown()` end processes, and a persistent `error` listener records late
  child errors instead of letting them go unhandled.
- `../diagnostics/diagnosticsSource.ts` — injectable diagnostics source;
  normalization (severity, secret redaction, truncation, ordering) is reused
  from the existing `src/context/diagnosticsContext.ts`.
- `processTools.ts` (Phase 3) — `get_command_output` / `kill_command` are thin
  adapters over `BackgroundProcessManager.output()` / `stop()`. They own no
  process state, so they cannot drift from `background_command`; the id is the
  manager's opaque handle (never an OS pid), so an arbitrary pid is unkillable.
- `../userInteraction/userQuestionBroker.ts` (Phase 3) — pending `ask_user`
  questions correlated by `requestId`, with multi-pending safety, cancel by
  id/session, and dispose. No `vscode` import, so it is host-independent.
- `../state/taskPlan.ts` (Phase 3) — the authoritative per-conversation plan
  (`TaskPlanStore`), separate from the transcript and never persisted to
  credentials/config/logs. Sanitized snapshots ship to the webview only.
- `../net/urlSecurity.ts` + `fetchUrlTool.ts` + `htmlText.ts` (Phase 3, extended
  2026-10-04) — SSRF policy (https public; http(s) loopback under
  `LocalNetworkPolicy`, which `fetch_url` passes; private/metadata blocked on
  the original URL and every redirect, with DNS resolution) plus a bounded,
  script-free fetch that extracts readable text from HTML.
- `../net/webSearchProvider.ts` + `searchWebTool.ts` (Phase 4) — the ONE search
  provider abstraction (`WebSearchProvider`; `createStoredWebSearchProvider`
  reads its key lazily from SecretStorage with a Brave-compatible default
  endpoint) plus a provider-agnostic, bounded, deduplicating tool. The tool
  holds no provider-specific details, so swapping providers is an
  implementation of the interface. Results are data only, never instructions.
- `codebaseSearchTool.ts` (Phase 4) — intent-oriented retrieval that reuses
  `workspaceSearch.ts` (same walker, ignore set, binary detection and
  `SEARCH_LIMITS`) and `isSensitiveFilePath`; scores fixed-size line chunks by
  query-term coverage and trims deterministically (score, then path, then
  line). No vector database or embedding service was introduced.
- `repoMapTool.ts` (Phase 4) — compact structural tree from the same walker and
  ignore set (directories before files, sorted, symlinks not followed,
  depth/entry caps).
- `gitShowTool.ts` / `gitBlameTool.ts` (Phase 4) — read-only git inspection on
  the shared argv-only runner and the existing log/diff parsers. `commit` and
  `path` are validated (no ranges, no leading `-`, workspace-relative), git
  flags are chosen by Spider, and the blame range is bounded *before* git runs.
- `../lsp/languageSource.ts` (Phase 5) — the ONE language-intelligence source
  (`LanguageSource`: documentSymbols / workspaceSymbols / definitions /
  references), mirroring `DiagnosticsSource` and `EditorContextSource`. VS Code
  is imported lazily; `vscode.executeDocumentSymbolProvider`,
  `executeWorkspaceSymbolProvider`, `executeDefinitionProvider` and
  `executeReferenceProvider` are the only language capabilities used — no
  custom parser for any language. Every provider result is normalized into
  plain serializable data (workspace-relative POSIX paths, zero-based
  positions) and every call is wrapped in a bounded provider timeout (10 s)
  with signal-based cancellation. No vscode.Uri / Position / Range /
  SymbolInformation / Location object ever reaches the model.
- `symbolTools.ts` (Phase 5) — `list_symbols` over `LanguageSource`: document
  tree (parents before children) or bounded workspace symbols, capped at 200
  with explicit truncation.
- `navigationTools.ts` (Phase 5) — `go_to_definition` / `find_references`:
  position-validated (zero-based, finite, non-negative), workspace-bound, cap
  20 definitions / 500 references; "nothing found" is a normal empty result.
- `problemsTool.ts` (Phase 5) — `get_problems` reuses `DiagnosticsSource` and
  the existing diagnostics normalizer (severity, redaction, ordering) — one
  normalizer for both `get_diagnostics` and `get_problems`. It reports what
  the editor currently knows and never runs a build; a `note` tells the model
  diagnostics may lag a fresh edit. Capped at 500 with a severity summary.
- `runTestsTool.ts` (Phase 5, extended 2026-10-04) — `run_tests`: a fixed allow-list of runner
  executables (`pnpm`, `npm`, `yarn`, `pytest`, `python`, `python3`, `cargo`,
  `go`), argv-only args (no shell string can exist), workspace-validated cwd,
  bounded timeout (default 120 s, max 300 s) and bounded stdout/stderr. The
  `path`/`filter` target contract translates to runner-native argv
  (`buildTargetArgs`: pytest `-k`, js `-t`, go `-run`, cargo positional) and
  is mutually exclusive with raw `args`. The
  process is started and awaited through `BackgroundProcessManager.start()`
  plus the `whenClosed()` completion wait, so timeout/cancellation reuse the
  existing kill machinery (graceful-then-forced) — no second process registry.
  It is a *foreground verification* tool: unlike `background_command`, the
  request waits, and cancelling the run stops the test process.
- `editorTools.ts` (Phase 2) and `askUserTool.ts` / `todoTool.ts` / `fetchUrlTool.ts`
  (Phase 3) stay thin: the runtime injects the ask_user gateway and task-plan
  sink through the tool context, and `WorkspaceToolExecutor` injects the git /
  editor / process-manager / network dependencies.
- `inferenceAgentLoop.ts` has NO per-tool branches: progress copy comes from
  `RegisteredTool.summarize`, execution from the executor, routing from the
  registry.

### Execution environment architecture (2026-10-04)
The central rule: **workspace location ≠ command execution environment.** A
workspace path never tells us which OS/shell/environment commands run in.
`src/runtime/execution/` is the ONE authoritative resolver:
- `executionTypes.ts` — `ExecutionContext` (`executionType: local|wsl|remote`,
  `platform: windows|linux|macos|wsl`, `shell`, `backend`, execution-side `cwd`,
  `env`, `wslDistro?`, `remoteAuthority?`), `ExecutionEnvironment` (host facts),
  and `ExecutionContextError`.
- `executionContext.ts` — pure resolvers: platform mapping, shell identity from
  `vscode.env.shell`, WSL UNC detection/translation
  (`\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` → `/...`), environment
  sanitization (defined strings only), and `describeExecutionContext` (a
  secret-free summary).
- `executionManager.ts` — `ExecutionManager`: resolves + caches the context per
  workspace, `invalidate()`/`updateEnvironment()` on workspace or shell change,
  `resolveCwd(workspace, hostPath)` path translation (delegated to a
  `WorkspacePathTranslator`), `describe(workspace)` for the agent prompt,
  `buildCommandInvocation(context, command, cwd)` for shell-string commands and
  `buildArgvInvocation(context, command, args, cwd)` for argv commands — both
  produce an **argv-only** launch (`shell: false`) for each backend.
- `pathTranslator.ts` — the `WorkspacePathTranslator` seam (`localPathTranslator`
  identity, `wslUncPathTranslator` re-roots a UNC path onto the Linux side and
  rejects escapes). Container/remote mappings can be added here without
  touching the manager.

Resolution precedence (VS Code facts only — never `wsl --list`, `which`,
`find`, `pwd` probing):
1. `vscode.env.remoteName === "wsl"` → extension host is inside the distro;
   `executionType: wsl`, `backend: local`, direct spawn (streaming/cancel stay
   native). Distro from `WSL_DISTRO_NAME`.
2. Windows host + WSL UNC workspace path → `executionType: wsl`,
   `backend: wsl`; commands run through
   `wsl.exe -d <distro> --cd <linuxCwd> -- bash -lc <command>` (argv array, the
   cwd is never interpolated).
3. Any other remote authority (`ssh-remote`, `dev-container`, …) →
   `executionType: remote`, executed in the remote extension host (`backend:
   local`). `RemoteExecutionBackend` is the designed extension point; it is not
   needed while the extension host already is the remote environment.
4. Otherwise → `executionType: local` on the host platform.

Shell selection is context-aware: the terminal shell (`vscode.env.shell`) is
authoritative for a local/remote host; a WSL bridge ignores the Windows shell
and uses `bash` inside the distro; platform defaults are cmd (Windows), zsh
(macOS), bash (Linux/WSL). Windows cmd uses Node's own `/d /s /c` shape and
PowerShell uses `-NoProfile -Command`; POSIX uses `<shell> -c`.
`run_command` stays generic: the model expresses WHAT (`run_command({command:
"bench migrate"})`), Spider decides WHERE/HOW. The safe context summary
(`type; platform; shell; distro; cwd`) is injected into the system prompt via
`RuntimeSendRequest.executionContextSummary` so the model never probes the
environment or prefixes `wsl.exe`/`cmd.exe`/`bash.exe`.
An unresolvable context throws `ExecutionContextError`, mapped by the executor
to `dependency_unavailable` — never a silent fallback to another shell.
`background_command` and `run_tests` resolve through the same manager
(`BackgroundProcessStartRequest.context`): their argv launches are bridged with
`buildArgvInvocation` (e.g. `wsl.exe -d <distro> --cd <cwd> -- <exe> <args>`)
while the process record still reports the caller's command/args.
Optional explicit overrides `spider.execution.shell` and
`spider.execution.wslDistro` (VS Code settings) populate
`ExecutionEnvironment.configuredShell`/`configuredWslDistro`; a read-only
summary appears in Settings → About (`ExtensionInfoView.executionContext`).
The 120 ms `command_output` coalescing, permissions, cancellation, timeouts and
stdout/stderr streaming are unchanged: only the resolved launch is new.

### ToolRouter
`src/runtime/tools/toolRouter.ts` — `route(call, context, authorize, {mode})`:
availability check (mode-based) → registry validation → permission authorize
callback → execute → wraps result as `{ success, tool, message, ...details }`.
Failures are structured `{ success: false, tool, code, error }` where `code`
comes from the shared error vocabulary; unknown/unavailable tools list the
available set. No failure ever throws to the user. `finish` sets
`finished: true` on the response.

### Resource limits & observability
Every new tool is capped (files, bytes, results, scanned entries, diagnostics,
Git files, symbols, definitions, references, problems, test output) and
reports `{ truncated: true, reason }` instead of silently cutting results. `RuntimeManager.logToolExecution` logs one structured line per
tool call (name, duration, outcome, result size, cancellation) and never logs
arguments, file contents, or credentials.

### Availability
`src/runtime/tools/toolAvailability.ts` — `AgentMode` (`agent`/`ask`/`plan`)
maps to tool sets. Not an intent router; never inspects user text. The
read-only modes (`ask`/`plan`) are **derived from the registry**: every tool
whose `permission` is `safe` and whose `category` is not `terminal`. The new
safe git/editor/repository tools therefore join ask/plan automatically, while
`background_command` (execute/terminal) and the `external` network tools
(`fetch_url`, `search_web`) stay out.

### Permission handling
`src/permissions/permissionManager.ts` + `permissionPolicy.ts`: trust checks,
auto-allow rules, destructive confirmations, request/resolve lifecycle with
timeout. RuntimeManager bridges events to the GUI (Allow/Deny buttons).
Categories are derived from registry permission metadata (`READ`/`MODIFY`/
`EXECUTE`/`DESTRUCTIVE`, plus `EXTERNAL` for tools registered with the
`external` permission such as `fetch_url`); auto-allow for `EXTERNAL` is
off by default and the runtime shield never covers it destructively.

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
  `dist`, `out`, `.vscode`. `run_command` resolves the host cwd through
  `resolveWorkspacePathSafe`, asks the injected `ExecutionManager` for the
  context and the execution-side cwd, then delegates to `commandRunner.ts`
  (timeout, abort, streaming preserved). `commandRunner.ts` only executes the
  backend-aware argv launch; it never discovers the environment itself.
- `src/runtime/execution/` — see "Execution environment architecture" in §5.
  Local Windows/Linux/macOS, WSL (remote and UNC-bridged) and other remotes
  all share the single `ExecutionManager` resolution path.
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
- Streaming: `stream: true` with `stream_options.include_usage` whenever a
  delta hook is present (live cumulative usage via `usageDeltaSink` as
  partial events; terminal usage stays authoritative); capability `streaming`
  is still honored.
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
  typing (a rebuild once ate clicks between mousedown/mouseup). Structural
  `composer-input` wrapper (`position: relative`) with the action row
  absolutely anchored inside the input area (no negative margins, textarea
  bottom padding reserves the space); toolbar (model picker + shield) below.
- `components/sessionBar.ts` — "New conversation" button only. History
  navigation was removed from the chat UI (2026-09-29): no dropdown, no
  History page, no `SHOW_HISTORY` — persistence is untouched.
- `components/historyList.ts` — **deleted** with the History page.
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
→ `AgentWebviewHost.attach` (sidebar view or editor tab) →
`MessageRouter.handleMessage` (result forwarded back if
`shouldForwardResult`). Runtime events flow continuously:
`RuntimeManager.onDidPublishEvent` → `toRuntimeExtensionMessage` →
`AgentWebviewHost.postMessage` → **every attached surface** (sidebar and
editor tab stay in sync, side by side).

**Editor-area tab (2026-09-29):** `AgentEditorPanel` is a
`WebviewPanel` (`spider.agentEditor`, tab title "Spider Agent",
`panel.iconPath` = the spider mark) hosting the SAME GUI through the
shared host. The clickable Spider logo in the webview header
(`brand-btn` → `OPEN_AGENT_EDITOR`) and the status-bar Spider item both
call `AgentEditorPanel.createOrShow` (singleton; reveals when open).
`AgentViewProvider` (sidebar) only attaches its webview to the same
host — it owns no webview logic. History is a second `WebviewPanel`
(`HistoryPanel`); picking a conversation loads the transcript in the
editor tab (or focuses the sidebar when no tab is open).

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

### Text streaming UX (single accumulator, 2026-09-29)
Full path: provider raw chunks (Ollama NDJSON / OpenAI-compatible + OpenRouter
SSE) → stream gate → `onStreamDelta` → `text_delta` runtime event →
`AGENT_TEXT_DELTA` → **`messageList.upsertStreamingLine` (the ONE
accumulator)** → frame-batched paint → DOM.

There is exactly **one** UI buffer and **one** scheduler:
`streamText` is the source of truth in `messageList`, and
`gui/src/streamCoalescer.ts` releases the accumulated chunks at most once per
animation frame (`push` schedules a frame, `close()` cancels it and flushes
synchronously, `reset()` discards without painting). The previous design had
TWO independent ~110ms timer coalescers (one in `main.ts`, one in
`messageList`), which is what made the reveal chunky and jumpy; the timer
layer was removed, not shortened.

Correctness rules: chunks are appended in arrival order and can never be
dropped or duplicated (buffer cleared on paint); finalization closes the
accumulator and then replaces the painted text with the finalized model
message exactly once; terminal `AGENT_STATE` / `AGENT_ERROR` flush the partial
text so cancellation and errors preserve output; conversation switches use
`reset()` so stale text cannot be painted into a cleared/replaced list; turn
boundaries (thinking, tool call, command) call `endStreamingTurn()` (flush +
fresh segment); `AGENT_TEXT_DELTA` is dropped when its `sessionId` is not the
active conversation, so a stream cannot leak across conversations.

No sequence numbers are needed: `RuntimeManager.publishEvent` is a synchronous
emitter and `webview.postMessage` is ordered, so per-run deltas cannot
reorder.

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
- Loading history: `GET_TRANSCRIPT` → `TRANSCRIPT` message → `replaceAll`
  (sent for the active conversation after a restart / session adoption).
  Stale-guard (`loadedTranscriptSessionId`) prevents an old transcript from
  overwriting  the active view; the optimistic reset re-points the guard *before*
  requesting.
- **History UI removed (2026-09-29):** the chat UI no longer exposes history
  navigation (header button, History page, session dropdown, `SHOW_HISTORY`
  message, `showHistory()` are all gone). `SessionStore`, `TranscriptStore`,
  session restore, transcript persistence and delete-message persistence are
  untouched — the backend keeps every conversation; only the UI surface was
  removed. The `SELECT_SESSION` protocol message is still handled host-side.
- Concepts kept separate: active conversation state (GUI), provider/session
  runtime state (RuntimeManager), historical records (SessionStore +
  TranscriptStore). Do not merge them.

## 12. Authentication & Configuration

- `src/auth/secretStorage.ts` — `SecretStorage` interface +
  `VSCodeSecretStorageAdapter`.
- `src/auth/cursorAuthProvider.ts` / `cursorClient.ts` / `cursorConnection.ts`
  — Cursor path (auth provider id `codeviaCursor`); legacy but maintained.
- **Provider credentials (2026-09-29):** `src/auth/providerCredentials.ts` —
  `createProviderCredentialStore(secrets, { legacySecretKeys })` resolves a
  secret per **profile id** under
  `codeviaCursor.provider.<profileId>.apiKey`. Nothing in the host branches on
  provider when handling credentials; the profile id is the only key.
- Legacy `codeviaCursor.openrouter.key` is the migration source for the
  `openrouter-default` profile: `get` falls back to it, and the first
  `store`/`delete` migrates it away (dual handling lives in the legacy map
  passed at construction, not in provider-specific code).
- CONNECT_OPENROUTER stores into the active OpenRouter profile; DISCONNECT
  deletes the profile slot and the legacy key.
- Provider profiles (non-secret): `ProviderConfigStore` (see §3).
- Startup hydration order: profile store → credential resolution →
  `RuntimeManager.completeRestore` → sanitized `RUNTIME_STATUS` to the webview.
  The webview never loads or receives a secret.
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
- Streaming UX batching → `gui/streamCoalescer.test.ts` (one paint per frame,
  arrival order preserved, no dropped/duplicated text, `close()` cancels the
  pending frame and flushes once, `reset()` discards without painting), using
  fake animation frames — no real timers in tests.
- Provider profiles / credentials → `session/providerConfigStore.test.ts`
  (profile save/activate/remove, legacy single-slot migration, non-secret
  metadata round-trip, credential-backed restore), `auth/providerCredentials.test.ts`
  (namespaced keys, per-profile isolation, legacy fallback + migration on
  write, delete removes both, empty values treated as absent) and
  `webview/messageRouter.providerProfiles.test.ts` (connect writes the
  profile-scoped key and clears the legacy one, credential re-hydration after
  a restart, legacy-only key still works, disconnect removes both, no secret
  in any HostToGui payload).
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
- Tool system (Phase 1, 2026-09-29) → `test/unit/runtime/tools/`:
  `pathSafety.test.ts` (traversal, symlink escape, safe fallback),
  `readMultipleFiles.test.ts` (ordering, partial failure, file/byte caps,
  binary, cancellation, malformed input), `grepSearch.test.ts` (plain/regex,
  case, invalid regex, result cap, binary + ignored dirs, glob filter,
  traversal, no shell), `globSearch.test.ts` (basic/nested glob, braces,
  classes, caps, ignores, escapes), `diagnosticsTool.test.ts` (scopes, caps,
  normalization + redaction through the shared collector,
  dependency_unavailable), `gitStatusTool.test.ts` (porcelain parsing, real
  repo states, missing git, not-a-repo, timeout, cancellation) and
  `toolRegistry.extended.test.ts` (registry invariants, duplicate guard,
  generated schemas, progress copy, structured router errors, cancellation).
- Tool system (Phase 2, 2026-09-30) → `test/unit/runtime/tools/`:
  `gitDiffTool.test.ts` (scope parsing, unified-diff parsing, safety args,
  staged/file scope, unborn-HEAD fallback, truncation, typed failures, real
  repo), `gitLogTool.test.ts` (limit parsing/capping, record parsing + injected-
  record rejection, subject collapsing, truncation, real repo),
  `editorTools.test.ts` (fake `EditorContextSource`: identity-only active file,
  untitled/outside, single/multi selection order, redaction, sensitive-file
  blanking, truncation, `dependency_unavailable`, `parseMaxChars`),
  `backgroundProcessManager.test.ts` (fake `spawn`: running/exit/failure/
  spawn-error, bounded buffers + totals, cancellation never kills a started
  process, stop/shutdown, retained-process cap, id collision) and
  `phase2Tools.integration.test.ts` (the actual workflows through the real
  registry + ToolRouter + WorkspaceToolExecutor: active-file→selection→read,
  git_status→git_diff, active-file→diagnostics→read→edit→diagnostics,
  background_command then continued work, option-style args, cancelled request
  never spawns, plus the registry permission/availability contract).
- Tool system (Phase 3, 2026-09-30) →
  `runtime/net/urlSecurity.test.ts` (scheme/host/address policy, private +
  mapped IPv6 ranges, DNS-based block), `tools/fetchUrlTool.test.ts`
  (JSON/HTML/plain text, invalid scheme, blocked targets, redirect to private,
  redirect loop, HTTP error, unsupported content, byte/limit truncation,
  timeout, network failure, cancellation), `tools/processTools.test.ts`
  (`get_command_output` bounded lines/bytes + exited process; `kill_command`
  unknown/ownership/no-op/force), `userInteraction/userQuestionBroker.test.ts`
  (correlation, multiple pending, stale ids, cancel, session cancel, dispose,
  id collisions), `tools/askUserTodoTools.test.ts` (ask_user validation +
  cancellation; update_todo create/update/cancel/clear, duplicate ids, invalid
  status, item/title caps, per-conversation isolation) and
  `tools/phase3Tools.integration.test.ts` (background→output→kill, ask_user→
  response, run-end cancellation, update_todo, fetch_url success + SSRF block,
  registry/permission contract, and the RuntimeEvent → webview message map).
- Tool system (Phase 4, 2026-09-30) →
  `runtime/net/webSearchProvider.test.ts` (stored-provider credential handling,
  missing key, request building, response parsing/trimming, host label,
  provider error codes), `tools/searchWebTool.test.ts` (no provider →
  `dependency_unavailable`, query validation, result cap + truncation, dedupe,
  clamping, provider-failure mapping, cancellation),
  `tools/codebaseSearchTool.test.ts` (`tokenize` stopwords, most-relevant-first
  ranking, no results, ignored dirs + sensitive files never scanned,
  deterministic cap, validation + cancellation), `tools/repoMapTool.test.ts`
  (deterministic directory-before-file tree, nested dirs, ignored dirs, depth
  limit, entry budget truncation, empty workspace, workspace escape),
  `tools/gitShowTool.test.ts` (commit-ref validation, metadata + files + diff,
  file-limited show, unavailable/not-a-repo/cancel/timeout, unknown revision →
  `not_found`, oversized diff, path validation, real repository),
  `tools/gitBlameTool.test.ts` (`parseBlamePorcelain` ordering, defaulted and
  bounded ranges, reversed/oversized range → controlled error before git,
  workspace path validation, unavailable/cancel/timeout, outside-file range,
  missing path, internal failure, pre-aborted signal, real repository) and
  `tools/phase4Tools.integration.test.ts` (search_web discovery, codebase_search
  region, repo_map filtered tree, git_show + git_blame on one runner, typed
  executor failures, plus the registry permission/availability/validation
  contract).
- Tool system (Phase 5, 2026-09-30) →
  `tools/symbolTools.test.ts` (document symbols, empty result, scope defaults
  and validation, workspace cap + truncation, workspace escape,
  `dependency_unavailable`, pre-aborted signal), `tools/navigationTools.test.ts`
  (definition at position, multiple/none, definitions cap, path/position
  validation, workspace escape, cancellation, `includeDeclaration` propagation,
  references cap, strict position parsing), `tools/problemsTool.test.ts`
  (workspace + per-file queries, summary, severity normalization, cap,
  scope/path validation, workspace escape, dependency availability),
  `tools/runTestsTool.test.ts` (runner allow-list, argv validation, timeout
  bounds, cwd escape rejection, pass/fail runs, timeout kills the child,
  cancellation stops the process, bounded output, spawn failure →
  `dependency_unavailable`, pre-aborted → cancelled) and
  `tools/phase5Tools.integration.test.ts` (all five tools through the real
  registry/router/executor, host-only behavior without providers,
  `run_tests` end-to-end and runner rejection, registry
  permission/availability/validation contract, 35-tool count).
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
23. There is exactly ONE UI streaming buffer and ONE scheduler
    (`messageList.streamText` + the rAF frame batcher in
    `gui/src/streamCoalescer.ts`). Never add a second coalescer/accumulator in
    `main.ts` or anywhere upstream — two buffering layers is what made
    streaming look chunky. Rendering must never be driven by fixed timers.
24. Credentials are addressed by provider **profile id**, never by provider
    name: no `if (provider === "x") store the secret here`. New providers get a
    profile (via `profileIdFor`) and their secret automatically lives at
    `codeviaCursor.provider.<profileId>.apiKey` in SecretStorage.
25. The chat UI exposes no history navigation (no History page/button, no
    session dropdown, no `SHOW_HISTORY`). Do not delete `SessionStore`,
    `TranscriptStore`, session restore, transcript persistence or durable
    message deletion to "clean up" after that removal — persistence is a
    backend concern and stays.
26. Adding a tool means adding ONE registry entry (contract + `summarize` +
    validation) plus one executor branch — never a branch in
    `inferenceAgentLoop`. Tools throw `ToolExecutionError` with a code from
    `toolError.ts` instead of raw errors, resolve every path through
    `workspacePath.ts`, and a bounded tool reports `{ truncated: true,
    reason }` rather than silently dropping results.
27. Inspection tools stay read-only: `git_status`, `git_diff`, `git_log`,
    `get_diagnostics`, `get_active_file` and `get_selection` must never modify
    the repository, the editor, or trigger a build; their output is
    normalized/redacted before it reaches the model, and git/editor context is
    always workspace-relative (never an absolute machine path).
28. A managed background process outlives its tool request on purpose:
    `background_command` spawns an argv-only process and returns once it is
    running; cancelling the agent run (or the startup wait) must NOT kill it.
    Termination is explicit (`BackgroundProcessManager.stop`/`dispose`).
    Background processes are never persisted, so a restart never touches a
    stale PID.
29. Network access is limited to `fetch_url` and `search_web`. `fetch_url`
    stays SSRF-safe: https for the public web plus http(s) loopback for local
    dev servers (`localhost`, `127.0.0.0/8`, `::1`) under the local-network
    policy; private/LAN/link-local/cloud-metadata blocked (by literal and by
    resolved address) on the original URL *and* every redirect, bounded size,
    redirect count and timeout, script-free HTML extraction, and no cache.
    Loopback allowance is approvable (not auto-approved): the tool still
    requires the `external` permission. `search_web` discovers URLs through the
    `WebSearchProvider` abstraction, reading its credential lazily from
    SecretStorage (never webview state, transcripts, or workspace files) and
    returning only bounded title/url/snippet data; it never fetches a page.
    Web content, including snippets, is untrusted data for the model and can
    never modify permissions, tool definitions, credentials, or agent
    configuration.
30. A task plan is structured agent state, not chat: `update_todo` state lives
    in `TaskPlanStore` (extension host, per conversation, in memory) and is
    never written to the transcript, provider config, credentials, or logs.
    The webview only receives sanitized snapshots.
31. `ask_user` is clarification, not authorization: it must never approve a
    tool or command (the permission manager stays authoritative), pending
    questions are correlated by `requestId`, and a run ending or the webview
    disposing resolves them as cancelled so no promise is left hanging.
32. `run_tests` is the only process tool with a hard-coded allow-list: the
    runner executable must be one of the approved names (never a path, never a
    shell), args are argv entries (`shell: false`, so injection is structurally
    impossible), cwd is workspace-validated, and timeout is capped at 300 s.
    Targeted runs use the `path`/`filter` contract (translated per runner:
    pytest `-k`, js `-t`, go `-run`, cargo positional), which is mutually
    exclusive with raw `args` so flag ordering can never silently reselect.
    It must never widen into a generic `run_command` replacement.
33. VS Code language intelligence (`list_symbols`, `go_to_definition`,
    `find_references`, `get_problems`) is read-only, host-only, and normalized:
    the tools talk to `LanguageSource` / `DiagnosticsSource`, never to `vscode`
    directly, and no vscode URI/Position/Range/Diagnostic/Symbol object is ever
    serialized into a tool result. Results are plain workspace-relative data.
34. `get_problems` reports the editor's current diagnostics only. It never
    runs a compiler/build inside the tool and never invents diagnostics; if a
    language server has not caught up after an edit, the result says so (`note`).

## 15. Known Bugs / Limitations

### Fixed
- **Transcript writes were not durable at the end of a run:** appends are
  queued per event and were never awaited, so a transcript read immediately
  after `startTask` could observe a half-persisted run (flaky tests, and a
  real risk of losing the last entries on shutdown). Fixed by adding
  `TranscriptStore.flush(sessionId)` and awaiting it in `startTask`'s
  `finally` (2026-09-29).
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
  re-attach from SecretStorage (2026-09-26); generalized into profiles +
  per-profile credentials on 2026-09-29 (see §12).
- **Chunky/jumpy streaming text:** two independent ~110ms timer coalescers
  buffered the same stream (one in `main.ts`, one in `messageList`). Fixed by
  removing the upstream coalescer entirely and making the remaining one an
  animation-frame batcher over a single accumulator (2026-09-29).
- **Stale stream text resurrected into a cleared list:** `clear()`/`replaceAll`
  reset the stream by flushing, which painted pending text into the
  already-emptied list. Fixed with a non-flushing `reset()` (2026-09-29).
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
  tests. Streams request `stream_options.include_usage` so terminal usage
  arrives over SSE; live cumulative snapshots flow as partial `usage` events
  (display-only, never accumulated — only final per-completion usage counts).
- In-runtime model history is memory-only, but since 2026-10-04 a restart
  deterministically seeds it from the transcript: text-only user/assistant
  turns (capped, budget-compacted) via `AgentRuntime.restoreHistory`, once per
  session, only into empty histories. Tool history is intentionally NOT
  restored (no ids to pair) — the model continues from readable conversation.
- Provider usage `costUsd` is plumbed end-to-end but no provider computes it
  yet (OpenRouter pricing is catalog-only).
- Cursor SDK path is legacy; restored sessions skip non-cursor providers in
  RuntimeManager (`restoreSessions` filters `provider === "cursor"` the other
  way around in AgentManager — each manager owns its provider).
- History entries show the first task text as the title; no per-conversation
  titles yet.

### Architectural Risks
- Tool search runs in-process (no ripgrep/native backend yet) but now honors
  `.gitignore` (root + per-directory, with `includeIgnored` escape hatch) on
  top of the built-in denylist. A native backend remains the top search
  candidate; it needs execution-environment routing (WSL/remote), which is a
  separate design.
- `background_command` output is kept in bounded in-memory buffers;
  `get_command_output`/`kill_command` (Phase 3) layer on the existing
  `BackgroundProcessManager.output()`/`stop()`/`list()` and never persist
  output across restarts.
- `fetch_url` performs direct bounded requests (no cache/ETag/Last-Modified).
  Since 2026-10-04 it allows http(s) loopback (`localhost`, `127/8`, `::1`)
  under the local-network policy (still `external`-permission gated); LAN,
  metadata and non-loopback http stay blocked, and DNS-rebind TOCTOU is a
  documented limitation.
- `search_web` needs a provider credential
  (`WEB_SEARCH_API_KEY_SECRET_KEY`). Without one it fails as
  `dependency_unavailable` and the agent can fall back to `fetch_url` on a
  known URL; it returns snippets only, never page bodies.
- `codebase_search` ranks lexically (query-term coverage over fixed line
  chunks) — deterministic and dependency-free, not a semantic/embedding model.
  A native index can be added later behind the same tool signature without
  changing the registry or the loop.
- `git_show`/`git_blame` read the local Git runner only; there is no remote or
  GitHub API path (no PR/issue context yet).
- Language tools depend on the *editor's* providers: without a language
  extension (or outside the extension host) `list_symbols`/
  `go_to_definition`/`find_references` fail as `dependency_unavailable`, and
  `get_problems` sees only what the language servers have reported so far.
- `run_tests` timeout is capped at 300 s; longer suites need
  `background_command` + `get_command_output`. Targeted runs use the formal
  `path`/`filter` → argv contract (mutually exclusive with raw `args`).
- `gui/src/protocol.ts` and `src/webview/types.ts` can drift (manual sync).
- `ChatTurn` shape changes must update both runtimes and the serializer —
  TypeScript catches most, but runtime id semantics are only test-enforced.
- The dedupe-on-empty New behavior depends on transcript emptiness; a
  session with only system entries counts as non-empty.

## 16. Important Historical Decisions

- **Provider profiles, not provider branches (2026-09-29)** — Roo Code and
  Continue were studied as references (profiles + an active profile id;
  non-secret config separated from credential resolution; secrets only in the
  OS/editor secret store; state hydrated by the host). Spider adopted the
  *principles* and kept its own architecture: the existing
  `ProviderConfigStore` grew profile support instead of a second store, a
  generic `ProviderCredentialStore` keys secrets by profile id so no code
  branches on provider, and React/esbuild/config-file formats were
  deliberately NOT adopted. Legacy keys are migrated, never dropped.
- **No sequence numbers for stream ordering (2026-09-29)** — inspection showed
  a single synchronous `RuntimeManager.publishEvent` emitter plus ordered
  `postMessage`, so deltas cannot reorder. Adding ordering machinery would be
  speculative; this decision should be revisited only if an async event source
  is introduced.
- **OpenRouter composes OpenAICompatibleRuntime** — one wire-format
  implementation, catalog logic stays separate; avoids a second chat client.
- **One shared provider-independent agent loop** — lifecycle/safety fixed in
  one place; providers differ only in `completeChat`.
- **Tool execution centralized in ToolRouter + registry** — permission,
  validation, availability, and structured unknown-tool recovery cannot be
  bypassed by any provider.
- **Workspace location ≠ command execution environment** — exactly one
  `ExecutionManager` resolves the environment for `run_command`; the
  `CommandRunner` executes and never discovers/guesses the environment, and no
  tool inspects the host. Local Windows/Linux, macOS, and WSL (both remote and
  Windows-UNC-bridged) are supported with argv-only launches.
- **Registry-generated prompts/schemas** — system-prompt fallback contract
  and native tool schemas are generated from the registry so they can never
  drift from execution.
- **Capability-driven tool calling** (from catalog metadata, not model-name
  checks) — new models work without code changes.
- **Transcript restore costs zero tokens** — display-only persistence keeps
  the model history and the user-visible history decoupled.
- **In-place GUI updates** — the message list mutates instead of rebuilding;
  fixes both click reliability and streaming performance.
- **One streaming accumulator, frame-batched (2026-09-29)** — deltas are
  never painted per token or per event, and there is only one buffer
  (`messageList.streamText`) and one scheduler
  (`gui/src/streamCoalescer.ts`, an rAF frame batcher with an injectable
  scheduler for deterministic tests). Chunks are appended in order and painted
  at most once per animation frame; `close()` cancels the pending frame and
  flushes the tail exactly once (finalization cannot duplicate text);
  `reset()` discards pending text without painting (used when the list is
  cleared/replaced). Two competing timer coalescers existed before and are
  gone — that was the cause of the chunked/jumpy reveal.
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
- **Background-process lifetime is decoupled from the tool request
  (2026-09-30)** — `background_command` returns as soon as the process is
  confirmed running, and cancelling the agent run only stops *waiting*; it
  never kills a process that already started. A "cancel" that silently killed
  a dev server would be a destructive surprise, so termination is explicit
  (`stop`/`dispose`). Output stays in bounded in-memory buffers (never
  persisted), so a restarted extension never claims a stale PID.
- **Editor context is injected, never imported (2026-09-30)** — mirrors the
  diagnostics source: the tools talk to an `EditorContextSource`, VS Code is
  imported lazily, and only workspace-relative identity plus redacted/capped
  selection text reaches the model.
- **fetch_url allows loopback under policy, LAN stays blocked (2026-10-04)** —
  `parseFetchUrl`/`assertFetchableUrl` take a `LocalNetworkPolicy`; the tool
  passes `allowLocalNetwork` so `http://localhost:3000` works while
  `192.168.x`, link-local, metadata and non-loopback http stay rejected on
  every hop (redirects included). DNS is still resolved per hop; rebinding
  between check and connect (TOCTOU) is a documented limitation whose blast
  radius is the developer's own machine.
- **Web search is a provider interface, not a vendor call (2026-09-30)** —
  `search_web` talks to `WebSearchProvider`; the default implementation is
  Brave-compatible, reads its key lazily from SecretStorage, and can be
  replaced without touching the tool, the registry, or the loop. `search_web`
  and `fetch_url` stay separate by design (discover URLs vs. retrieve a known
  URL), so a search result is never silently fetched.
- **codebase_search is lexical, not a vector database (2026-09-30)** — no
  embedding service or persistent index was introduced. It reuses the existing
  walker, ignore rules, binary detection and path safety and scores chunks
  deterministically, so results are bounded and reproducible and a real index
  can be added later behind the same tool signature.
- **Git show/blame reuse the Phase 1 runner and Phase 2 parsers (2026-09-30)** —
  rather than a new Git service, `git_show`/`git_blame` take the same
  `GitCommandRunner` and the existing log/diff parsers, so they cannot drift
  from `git_status`/`git_log`/`git_diff`. The model supplies only a validated
  commit/ref and pathspec; every git flag is chosen by Spider.
- **ask_user is a broker, not a permission dialog (2026-09-30)** — a
  request-id-correlated `UserQuestionBroker` bridges an agent turn to the
  webview and back, with cancellation on run end / webview dispose. It is kept
  strictly separate from the permission pipeline so a question can never be
  used to approve a command.
- **Search honors .gitignore with an includeIgnored escape hatch (2026-10-04)** —
  `gitignore.ts` parses root + per-directory `.gitignore` files (negation,
  dir-only, anchored, `**`, basename rules; git precedence) and the shared
  walker plus `repo_map` skip ignored paths by default. The hardcoded
  generated-directory denylist remains as a safety/performance floor even
  with `includeIgnored: true`. No native backend was added: the walker is
  still in-process (ripgrep would need execution-environment routing through
  WSL/remote, which is a separate design).
- **Stored history is complete, the model sees a budgeted view (2026-10-04)** —
  `contextManager.ts` (`estimateTokens` at a documented ~4 chars/token,
  `compactChatTurns`) narrows what `completeChat` receives while the stored
  `ChatTurn[]` is never mutated: system turn + latest prompt always kept,
  assistant `tool_calls` + its results kept/dropped as one atomic unit (never
  an orphaned tool message), oldest units dropped first. The loop applies the
  default 100k-token budget on every model call (normal runs never trigger
  it) with an `onCompaction` observability hook — truncation is reported,
  never silent.
- **Restoration is text-only, never a replayed tool history (2026-10-04)** —
  transcripts carry no `tool_call_id`s, so `contextRestore.ts` rebuilds only
  user/assistant turns (capped, budget-compacted) and `AgentRuntime.
  restoreHistory` seeds providers only into empty histories (once per session
  via `RuntimeManager.restoredHistories`). After a restart the model continues
  from readable conversation, explicitly without tool memory — no fabricated
  ids, no invalid conversations.
- **run_tests is allow-listed and manager-owned (2026-09-30)** — the runner
  comes from a fixed name set and the process lifecycle is the existing
  `BackgroundProcessManager`'s (a new `whenClosed()` completion wait with
  graceful-then-forced kill), so verification reuse the Phase 2/3 machinery
  instead of a second process registry. A shell string cannot be expressed:
  input is `{runner, args[]}` only.
- **VS Code objects never cross the tool boundary (2026-09-30)** —
  `LanguageSource` normalizes symbols/locations into plain JSON
  (workspace-relative paths, zero-based positions) inside the extension host,
  exactly like `DiagnosticsSource` and `EditorContextSource` before it. The
  model can navigate code without ever receiving a live vscode object.
- **Secrets stay in SecretStorage; config persistence holds no credentials** —
  restore re-attaches the OpenRouter key at activation.

## 17. Current Development Status

- **Completed (2026-10-04, engine gaps B2/B3/B4/B6/B7/B10):**
  `.gitignore`-aware search (`gitignore.ts` + walker + `repo_map`,
  `includeIgnored` on search tools, hardcoded denylist kept as floor);
  deterministic text-only history restore (`contextRestore.ts` +
  `AgentRuntime.restoreHistory`, once per session into empty histories);
  explicit context budgets (`contextManager.ts`, default 100k est. tokens,
  tool-pair atomicity, `onCompaction` hook, loop-wired); live streaming usage
  (`stream_options.include_usage`, `usageDeltaSink` → partial `usage` events,
  display-only, no double-count); loopback http(s) policy for `fetch_url`
  (LAN/metadata still blocked, `external` permission still gates); formal
  `run_tests` `path`/`filter` → argv contract (mutually exclusive with raw
  `args`). Deferred by design: semantic embeddings (B1), web multi-provider
  fallback (B5), tree-sitter fallback (B8), GitHub remote (B9). 790 unit
  tests, lint 0 warnings, typecheck + compile green.
- **Completed (2026-10-04, execution environment architecture):**
  `src/runtime/execution/` (types, pure resolvers, `ExecutionManager`,
  backend-aware `buildCommandInvocation`) resolves commands from VS Code facts
  instead of probing; `run_command` → `ExecutionManager` → `CommandRunner` is
  wired into the real tool; WSL (remote and `\\wsl.localhost`-bridged), local
  Windows/Linux/macOS and other remotes are covered; a safe context summary is
  injected into the agent prompt; the 120 ms streaming, permissions, timeout
  and cancellation paths are unchanged. 735 unit tests (24 new execution
  tests), lint 0 warnings, typecheck + compile green.
- **Completed (2026-10-04, execution-environment follow-ups):**
  `background_command` and `run_tests` now resolve through the same
  `ExecutionManager` (argv launch bridged to WSL when needed); a
  `WorkspacePathTranslator` seam replaces the inline translation and adds the
  container/remote extension point; new tests cover the full
  `ToolRouter → executor → context → runner` chain, the system-prompt summary,
  and fuzz paths/argv for spaces/special characters/escapes; optional
  `spider.execution.shell` / `spider.execution.wslDistro` overrides and a
  read-only Settings → About execution row were added. 744 unit tests (88
  files), lint 0 warnings, typecheck + compile green.
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
- **Completed (2026-09-29, Phase 1 tool system):** five new read-only tools
  (`read_multiple_files`, `grep_search`, `glob_search`, `get_diagnostics`,
  `git_status`) added through the existing registry (recursive schemas,
  registry-owned progress copy, duplicate guard) with shared
  error/path/search/diagnostics building blocks, typed error codes, hard
  resource limits with truncation reporting, cancellation support, structured
  tool logging, and a real transcript-flush durability fix. 426 unit tests /
  56 files, lint 0 warnings, typecheck + compile green.
- **Completed (2026-09-29, streaming + provider profiles + chat chrome):**
  single-accumulator frame-batched streaming (upstream 110ms coalescer
  deleted; non-flushing `reset()` for list resets); provider **profile**
  system (`ProviderProfile` + `activeProfileId` in the existing
  `ProviderConfigStore`, legacy single-slot key migrated and still projected);
  generic per-profile credential store
  (`codeviaCursor.provider.<profileId>.apiKey`) with legacy OpenRouter key
  migration; generalized startup hydration
  (`restoreProviderConfig` → credential → `completeRestore`, no provider branch
  in `extension.ts`); composer Send anchored inside a structural
  `composer-input` wrapper; History UI removed from the chat (persistence
  untouched). 349 unit tests, lint 0 warnings, typecheck + compile green.
- **Completed (2026-09-28, chat UI redesign):** Copy/Delete message actions
  with stable ids (composer-generated user ids, host-generated assistant ids)
  and durable transcript deletion; collapsible tool/command output; composer
  live command stdout/stderr streaming (coalesced host-side); new tests for
  all of the above. A composer agent-mode selector was added and then reverted
  (see §15 Fixed) because it gated registered tools out of the model's
  available set.
- **Completed (2026-09-30, Phase 2 tools):** five new tools (`git_diff`,
  `git_log`, `get_active_file`, `get_selection`, `background_command`) added
  through the same registry + executor pattern (no loop branches). Git
  inspection is argv-only and parsed defensively; editor context is injected
  (VS Code imported lazily) and returns identity plus redacted/capped selection
  text; `background_command` runs an argv-only process whose lifetime is
  decoupled from the tool request (cancel never kills) under a bounded
  `BackgroundProcessManager` owned by `RuntimeManager` and disposed on
  deactivate. Cross-linking active-file/selection and git workflows are covered
  end-to-end through the real registry/router/executor. 502 unit tests / 61
  files, lint 0 warnings, typecheck + compile green.
- **Completed (2026-09-30, Phase 3 tools):** five new tools (`get_command_output`,
  `kill_command`, `ask_user`, `update_todo`, `fetch_url`) added through the same
  registry + executor pattern (no loop branches). Process tools are thin
  adapters over the Phase 2 manager (ownership-safe, no arbitrary pid kill);
  `ask_user` uses an id-correlated broker wired through the tool context and the
  existing runtime-event → webview bridge (cancel-safe on run end / webview
  dispose); `update_todo` owns a per-conversation `TaskPlanStore` separate from
  the transcript; `fetch_url` enforces a per-hop SSRF policy (https only;
  loopback/private/metadata blocked by literal and by DNS on every redirect)
  with bounded size/time/redirects and script-free HTML extraction. New protocol
  messages (`USER_QUESTION`, `USER_QUESTION_CLOSED`, `TODO_UPDATED`,
  `ANSWER_USER_QUESTION`, `CANCEL_USER_QUESTION`) and a minimal task-plan panel +
  question prompt. 575 unit tests / 67 files, lint 0 warnings, typecheck +
  compile green.
- **Completed (2026-09-30, Phase 4 tools):** five new tools (`search_web`,
  `codebase_search`, `repo_map`, `git_show`, `git_blame`) added through the same
  registry + executor pattern (no loop branches, no second permission or
  cancellation system). `search_web` sits on a `WebSearchProvider` abstraction
  with its key in SecretStorage; `codebase_search`/`repo_map` reuse the existing
  walker, ignore set and path safety (no vector DB, no second watcher);
  `git_show`/`git_blame` reuse the Phase 1 git runner and the Phase 2 log/diff
  parsers with argv-only commands and a range bounded before git runs. 635 unit
  tests / 74 files, lint 0 warnings, typecheck + compile green.
- **Completed (2026-09-30, Phase 5 tools):** five new tools (`list_symbols`,
  `go_to_definition`, `find_references`, `get_problems`, `run_tests`) added
  through the same registry + executor pattern (no loop branches). Language
  intelligence goes through a new `LanguageSource` (lazy `vscode`, provider
  commands only, everything normalized to plain data); `get_problems` reuses
  `DiagnosticsSource` and the existing normalizer; `run_tests` is allow-listed
  (runner name set + argv-only + bounded timeout) and awaits its process via
  `BackgroundProcessManager.whenClosed()` (timeout/cancel kill reused).
  Understand → navigate → edit → verify is now covered end to end. 678 unit
  tests / 79 files, lint 0 warnings, typecheck + compile green. 35 registered
  tools.
- **Current:** documentation/context (this file). All checks green:
  typecheck, lint (0 warnings), 678 unit tests / 79 files, compile. 35 tools.
- **Next planned (Phase 6 candidates):** browser tools, MCP, subagents,
  a native (ripgrep-style) search backend behind the existing search module,
  `.gitignore` support in the walker, an optional index behind
  `codebase_search`, watch/list-symbols watchers, per-conversation titles / a
  profile manager UI (the backend already supports multiple profiles; Settings
  exposes one connection per provider today); workspace indexing (reserved
  Settings section exists, honestly marked); agent behaviour settings if/when
  the backend supports them.
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
