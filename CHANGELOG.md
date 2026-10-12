# Changelog

## [Unreleased]

### Fixed

* OpenAI-compatible tool-call history (OpenRouter and any OpenAI-compatible provider): assistant tool calls and their ids are now preserved in conversation history, and every tool result is sent with `tool_call_id` set to the exact id of the corresponding assistant tool call — including parallel tool calls. Previously tool results were serialized without `tool_call_id`, so the second model request failed with `messages[N]: tool messages must include a non-empty string tool_call_id` and the malformed history then broke every later message in the session. Provider-supplied call ids are preserved end to end (streaming accumulation included); missing ids fail explicitly instead of sending an invalid request.

### Added

* NVIDIA provider: select **NVIDIA** in Settings, paste your own NVIDIA API Catalog key (`build.nvidia.com`), and run Spider on NVIDIA-hosted models through the cloud-hosted API Catalog (`https://integrate.api.nvidia.com/v1`). Live model discovery lists the catalog and filters out non-chat models (embeddings, reranking, speech, media, detection) without excluding partner-hosted families. Because the catalog exposes no per-model capability metadata and NVIDIA documents tool calling as model-dependent, native tool calling is not advertised; Spider uses its existing safe text-tool fallback while streaming. The key lives only in VS Code `SecretStorage` (per-profile), is never persisted to settings/state/logs, and is restored on restart. Missing-key, auth, quota, model-unavailable, 4xx/5xx, and network failures map to Spider's typed runtime errors with no silent fallback to another provider.
* Google Gemini provider: select **Google Gemini** in Settings, paste your own Google AI Studio API key, and run Spider on Gemini models through Google's official OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`). Model discovery lists the live catalog and filters out non-chat models; streaming, native tool calling, permissions, sessions, and the shared agent loop are reused unchanged. The key lives only in VS Code `SecretStorage` (per-profile), is never persisted to settings/state/logs, and is restored automatically on restart. Missing-key, auth, rate-limit, model-unavailable, 4xx/5xx, and network failures are mapped to Spider's typed runtime errors without ever falling back to another provider.
* Provider settings persist across restarts using the extension's existing workspace state: provider, base URL, and selected model are restored automatically on activation. The OpenRouter API key is never persisted to settings — it is re-attached from VS Code `SecretStorage`. Existing Ollama behavior is unchanged.
* Dedicated **History** page in the sidebar: previous conversations are listed (newest first) and open through the existing transcript/session mechanism. The user-facing "Session" terminology is now "History"; internal identifiers are unchanged.

### Changed

* User-facing product name is now **Spider** (UI header, welcome text, settings, labels, and command categories). Internal identifiers, file names, package name, extension id, storage keys, and APIs are unchanged.

### Added

* OpenRouter provider with live model discovery: after connecting with an API key, the model dropdown is populated from OpenRouter's `/models` catalog (no hardcoded list) with name, model ID, context length, tool-calling/vision capability, and per-million-token pricing where available. A searchable picker selects the model; **Refresh models** re-fetches the catalog without an extension restart.
* OpenRouter API keys are stored in VS Code `SecretStorage` (`codeviaCursor.openrouter.key`) and are never logged, displayed, or embedded in URLs.
* OpenRouter inference uses its OpenAI-compatible chat endpoint through the existing Agent Loop, Tool Registry, Tool Router, permission flow, and workspace executors. Tool calling is enabled from the selected model's capability metadata rather than model-name checks.
* New unit tests for OpenRouter model discovery, error mapping (invalid key, rate limit, network failure, empty catalog, unavailable model), and the OpenRouter webview message paths.

### Changed

* Agent/tool selection now follows the Continue/Roo production pattern end to end: the model receives tool schemas generated from the Tool Registry and selects every tool itself. No keyword or intent routing exists anywhere in the codebase.
* The Tool Registry is the single source of truth: tool names, descriptions, argument schemas, example arguments, permission groups, native provider schemas, and the system-prompt fallback contract are all generated from it (previously duplicated in `localToolDefinitions.ts`).
* Introduced the current available-tool set (`toolAvailability.ts`): agent mode exposes all registered tools; ask and plan modes are restricted to read/search tools. The loop hides unavailable tools from the model, recovers out-of-set selections with structured feedback, and the router refuses to execute them. No modes are surfaced in the UI yet — the architecture is ready for them.
* Unknown-tool errors returned to the model now list the current available-tool set so it can retry (e.g. `Unknown tool: create_file` → full tool list), and are never shown to the user as chat text.
* The agent system prompt now explicitly forbids answering workspace-change requests with chat-only code: file creation/modification must go through `write_file`/`edit_file` tool calls.

### Added

* New unit tests: mode-based tool availability, ask-mode enforcement (loop filter + router refusal), and the calculator scenario end-to-end (write_file → index.html/styles.css/app.py on disk → finish, no code dump as final response).

* Persistent chat transcripts: conversations are stored as append-only JSONL files in extension global storage and restored when a session is reopened, even after a VS Code restart. Restoring history never re-sends it to the model, so it costs zero tokens.
* `GET_TRANSCRIPT` / `TRANSCRIPT` webview messages for on-demand transcript loading.

* Project skeleton using VS Code Extension API and TypeScript.
* Build system with esbuild, ESLint, Prettier, and Vitest.
* Extension activation and command registration.
* Documentation for architecture, security, development, release, troubleshooting, API, and UX.
* Official Cursor icon as extension icon.

## [0.1.0] - 2026-09-22

### Added

* Initial release scaffolding.
