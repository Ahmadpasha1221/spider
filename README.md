# Spider

<p align="center">
  <img src="assets/icon.png" alt="Spider" width="260">
</p>

<h3 align="center">An autonomous AI coding agent for VS Code — powered by <em>your</em> model</h3>

<p align="center">
  <strong>Understand → Navigate → Edit → Verify</strong>, inside your editor, with local or cloud models.
</p>

<p align="center">
  <a href="#why-spider">Why Spider</a> ·
  <a href="#what-makes-spider-unique">Uniqueness</a> ·
  <a href="#providers">Providers</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#development">Development</a>
</p>

---

## Why Spider?

Most AI coding assistants share two limitations:

1. **They are chat-first.** They suggest code in a sidebar, but *you* do all the work: create the file, apply the edit, run the tests, read the errors, and repeat.
2. **They are cloud-locked.** Your code leaves your machine, your usage is metered by someone else's subscription, and you cannot choose the model — or the hardware — that runs it.

Spider takes a different position: **the agent does the work, and you own the model.**

- **Agent-first, not chat-first.** Spider plans, calls real tools against your workspace, observes the results, and keeps going until the task is done — a real agent loop running as a normal VS Code extension.
- **Model-agnostic by design.** One runtime interface, five runtimes: fully local through **Ollama** or any **OpenAI-compatible** server (LM Studio, llama.cpp, vLLM…), or cloud through **OpenRouter** and **Cursor agents**. Switch providers without changing your workflow — your code never has to leave your machine if you don't want it to.
- **Everything is verified.** A real permission system, a bounded tool set, and a verification loop (`get_problems`, `run_tests`) let the agent check its own edits instead of claiming success.

Spider is an **independent project** and is not affiliated with Cursor. Cursor is a trademark of Cursor, Inc.

---

## What makes Spider unique?

### 1. One centralized tool system — 35 registered tools

Spider does not let each provider reinvent tool execution. Every tool is defined **once** in a single registry that derives the model-facing schemas, argument validation, permission classes, availability sets, progress copy, and even the text-based fallback tool contract for models without native tool calling. Adding a tool never touches the agent loop.

| Area | Tools |
|---|---|
| **Files** | `list_files`, `read_file`, `read_multiple_files`, `write_file`, `edit_file`, `create_directory`, `move_file`, `delete_file` |
| **Search** | `search_files`, `grep_search`, `glob_search`, `codebase_search` (intent-oriented), `repo_map` (structure tree) |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_show`, `git_blame` |
| **IDE intelligence** | `list_symbols`, `go_to_definition`, `find_references`, `get_diagnostics`, `get_problems`, `get_active_file`, `get_selection` |
| **Execution** | `run_command`, `background_command`, `get_command_output`, `kill_command`, `run_tests` (allow-listed runners) |
| **Web & workflow** | `search_web`, `fetch_url`, `ask_user`, `update_todo`, `finish` |

That covers the full loop: **understand** the repo (`repo_map`, `codebase_search`, `list_symbols`), **navigate** to what matters (`go_to_definition`, `find_references`), **edit** (`write_file`, `edit_file`), and **verify** (`get_problems`, `run_tests`).

### 2. Real security architecture — not a prompt-and-pray agent

- **A permission pipeline, not a chat prompt.** Every tool call passes through trust checks → policy auto-allow rules → validation → an explicit Allow/Deny decision. Destructive tools (like `delete_file`) always require confirmation; external network tools are never auto-allowed.
- **The workspace is a boundary.** All paths resolve through one shared, symlink-aware path-safety module. Escapes (`../../`, links pointing out of the workspace) are rejected as structured errors, not accidents.
- **Processes are argv-only.** Commands spawn with `shell: false`, so shell injection (`&&`, `;`, pipes, substitution) is *structurally impossible*, not just discouraged. `run_tests` additionally restricts the runner to a fixed allow-list (`pnpm`, `npm`, `yarn`, `pytest`, `python`, `cargo`, `go`).
- **Network access is minimal and SSRF-safe.** `fetch_url` is https-only, blocks loopback/private/link-local/cloud-metadata addresses by literal *and* by resolved DNS on every redirect hop, and returns bounded, script-free text. `search_web` runs through a provider abstraction whose credential lives only in VS Code **SecretStorage** — never in settings, state, or transcripts.
- **Bounded by default.** Every tool reports `{ truncated: true, reason }` instead of silently cutting results: capped file reads, capped diffs, capped blame ranges, capped diagnostics, capped test output, bounded timeouts everywhere.

### 3. Agent UX that respects the editor

- Real **token streaming** (SSE) with in-place rendering, sticky scroll, and reduced-motion support — one UI accumulator, no duplicated state.
- **Background processes** outlive their tool call on purpose: start a dev server, keep working, read its output later, kill it explicitly.
- **`ask_user`** pauses the agent for a clarifying question through a correlated request/response broker — strictly separated from the permission system, so a question can never approve a command.
- **A task plan** (`update_todo`) lives as structured agent state, separate from the chat transcript.
- **Artifacts** appear in the UI only from real file-change events — never fabricated from model text.
- Sessions, history, and per-provider credential profiles persist across restarts.

### 4. Built test-first

**678 unit tests across 79 test files** cover the tool registry, the permission pipeline, path safety, SSRF policy, process lifecycle, streaming, and every tool — including end-to-end integration tests through the real registry → router → executor, and real-git tests against actual repositories.

---

## Providers

| Provider | Kind | Notes |
|---|---|---|
| **Ollama** | Local | Fully offline; a hard project rule is that Ollama must never break |
| **OpenAI-compatible** | Local / self-hosted | LM Studio, llama.cpp, vLLM — anything speaking the API |
| **OpenRouter** | Cloud | One key, many frontier models; key stored in SecretStorage |
| **Cursor agents** | Cloud | Via the official `@cursor/sdk` |
| **Mock** | Local | Deterministic runtime for UI development and tests |

Provider configuration supports **multiple profiles**, with credentials keyed by profile id in SecretStorage and restored at activation.

---

## How it works

```text
User
  ↓
Spider Agent (provider-independent runtime)
  ↓
Model
  ↓
Tool Call
  ↓
Tool Router → availability → validation → permission
  ↓
Tool Executor (workspace / git / editor / language services / processes / network)
  ↓
Tool Result (bounded, structured)
  ↓
Agent
  ↓
Model
```

The registry is the single source of truth; the router is the single execution path; the agent loop is **tool-agnostic** — it contains zero per-tool branches. Read-only work happens automatically in `ask`/`plan` modes; the full toolset is available in `agent` mode.

---

## Installation

**Requirements:** VS Code 1.95+

```bash
git clone https://github.com/Ahmadpasha1221/spider
cd spider
pnpm install
pnpm run compile
```

Then launch the extension from VS Code (`Run → Start Debugging`) or package a VSIX:

```bash
npx vsce package
```

Pick a provider in Spider's settings — Ollama needs nothing but `ollama serve`.

---

## Development

```bash
pnpm run typecheck   # both tsconfigs (extension + GUI)
pnpm run lint        # eslint, zero warnings allowed
pnpm run test        # vitest, 678 tests / 79 files
pnpm run compile     # esbuild production build
```

The architecture is documented in [`AI_PROJECT_CONTEXT.md`](AI_PROJECT_CONTEXT.md): the runtime, the tool system, the permission model, and the rules future changes must follow.

---

## Trademark

Spider is an independent, open project and is not affiliated with, endorsed by, or sponsored by Cursor, Inc. "Cursor" is a trademark of Cursor, Inc.