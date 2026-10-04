# Spider — Open-Source AI Coding Agent for VS Code

<p align="center">
  <img src="assets/icon.png" alt="Spider AI Coding Agent" width="260">
</p>

<h3 align="center">
  Open-source AI coding agent for VS Code — powered by <em>your</em> model
</h3>

<p align="center">
  Spider understands your codebase, navigates files, edits code, runs tools,
  and verifies changes using local or cloud AI models.
</p>

<p align="center">
  <strong>Understand → Navigate → Edit → Verify</strong>
</p>

<p align="center">
  Local AI · Cloud AI · Ollama · OpenRouter · OpenAI-Compatible APIs · Cursor Agents
</p>

<p align="center">

[![CI](https://github.com/Ahmadpasha1221/spider/actions/workflows/ci.yml/badge.svg)](https://github.com/Ahmadpasha1221/spider/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Ahmadpasha1221/spider)](https://github.com/Ahmadpasha1221/spider/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/Ahmadpasha1221/spider)](https://github.com/Ahmadpasha1221/spider/issues)
[![GitHub release](https://img.shields.io/github/v/release/Ahmadpasha1221/spider)](https://github.com/Ahmadpasha1221/spider/releases)

</p>

<p align="center">
  <a href="#why-spider">Why Spider</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#what-makes-spider-different">Why It's Different</a> ·
  <a href="#providers">Providers</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#development">Development</a>
</p>

---

## What is Spider?

**Spider is an open-source AI coding agent for VS Code.**

Instead of only generating code in a chat window, Spider can operate directly on your workspace.

Give Spider a task and the agent can:

```text
Understand the repository
        ↓
Navigate the codebase
        ↓
Read and analyze files
        ↓
Edit or create code
        ↓
Run commands and tests
        ↓
Inspect diagnostics
        ↓
Verify the result
```

Spider is designed around a provider-independent agent runtime, so you can choose the model and infrastructure that powers it.

Use local models with **Ollama**, self-hosted models through **OpenAI-compatible APIs**, cloud models through **OpenRouter**, or **Cursor agents**.

> **The agent does the work. You own the model.**

---

## Demo

<p align="center">
  <img
    src="docs/images/spider-demo.gif"
    alt="Spider AI coding agent working inside VS Code"
    width="900"
  >
</p>

> Give Spider a development task and let it explore, modify, execute, and verify the workspace.

> If the demo asset is not available yet, remove this section until `docs/images/spider-demo.gif` is added.

---

# Why Spider?

Most AI coding assistants have two common limitations.

### 1. Chat-first workflows

Traditional AI assistants often work like:

```text
User
 ↓
Ask AI
 ↓
Receive code
 ↓
Copy code
 ↓
Apply changes
 ↓
Run tests
 ↓
Read errors
 ↓
Ask AI again
```

Spider is designed around an agent loop:

```text
User
 ↓
Spider Agent
 ↓
Understand
 ↓
Navigate
 ↓
Edit
 ↓
Execute
 ↓
Observe
 ↓
Verify
 ↓
Continue until the task is complete
```

The agent interacts with the actual workspace through tools instead of only returning suggestions in chat.

---

### 2. Model lock-in

Many AI development tools tightly couple the workflow to a particular model provider.

Spider separates:

```text
Agent Runtime
      ↓
Provider Interface
      ↓
Model
```

This allows the same agent workflow to work with:

- Ollama
- OpenAI-compatible servers
- LM Studio
- llama.cpp
- vLLM
- OpenRouter
- Cursor agents
- Mock providers for development and testing

You can choose local or cloud infrastructure depending on your requirements.

With local providers such as Ollama, your coding workload can remain on your machine.

---

# Quick Start

## Local AI with Ollama

Install and start Ollama:

```bash
ollama serve
```

Download any supported coding model:

```bash
ollama pull <your-model>
```

Open Spider in VS Code and configure:

```text
Provider: Ollama
Model:    <your-model>
```

Then give Spider a task such as:

```text
Find the authentication flow in this project,
identify missing test coverage, and add tests for
the failed-login cases.
```

Spider can then:

```text
Understand
    ↓
Navigate
    ↓
Read
    ↓
Edit
    ↓
Run tests
    ↓
Inspect results
    ↓
Verify
```

---

## Cloud or self-hosted models

Spider also supports:

```text
OpenRouter
OpenAI-compatible APIs
Cursor agents
LM Studio
llama.cpp
vLLM
```

Configure the provider from Spider's settings and select the model/profile you want to use.

Provider credentials are stored using VS Code `SecretStorage` rather than being placed directly into project files or transcripts.

---

# What Makes Spider Different?

## 1. One centralized tool system

Spider currently provides **35 registered tools** through one centralized tool registry.

Tools are defined once.

The registry derives:

- Model-facing schemas
- Argument validation
- Permission classes
- Availability rules
- Progress messages
- Tool descriptions
- Text-based fallback contracts

Adding a tool does not require modifying the agent loop.

### Files

| Tool | Purpose |
|---|---|
| `list_files` | List workspace files |
| `read_file` | Read a file |
| `read_multiple_files` | Read multiple files |
| `write_file` | Create or replace a file |
| `edit_file` | Apply an edit |
| `create_directory` | Create directories |
| `move_file` | Move files |
| `delete_file` | Delete files |

### Search

| Tool | Purpose |
|---|---|
| `search_files` | Search workspace content |
| `grep_search` | Text search |
| `glob_search` | Pattern-based file discovery |
| `codebase_search` | Intent-oriented code search |
| `repo_map` | Repository structure map |

### Git

| Tool | Purpose |
|---|---|
| `git_status` | Repository status |
| `git_diff` | View changes |
| `git_log` | Inspect history |
| `git_show` | Inspect commits |
| `git_blame` | Inspect line history |

### IDE intelligence

| Tool | Purpose |
|---|---|
| `list_symbols` | Inspect symbols |
| `go_to_definition` | Navigate to definitions |
| `find_references` | Find symbol references |
| `get_diagnostics` | Read IDE diagnostics |
| `get_problems` | Inspect workspace problems |
| `get_active_file` | Inspect the active editor |
| `get_selection` | Inspect the current selection |

### Execution

| Tool | Purpose |
|---|---|
| `run_command` | Execute a command |
| `background_command` | Start a long-running process |
| `get_command_output` | Read process output |
| `kill_command` | Stop a process |
| `run_tests` | Execute supported test runners |

### Web and workflow

| Tool | Purpose |
|---|---|
| `search_web` | Search the web |
| `fetch_url` | Fetch a web resource |
| `ask_user` | Ask the user for clarification |
| `update_todo` | Maintain structured task state |
| `finish` | Complete the task |

Together, these tools cover the complete development loop:

```text
Understand
  ├── repo_map
  ├── codebase_search
  ├── list_files
  └── list_symbols

Navigate
  ├── go_to_definition
  ├── find_references
  ├── grep_search
  └── glob_search

Edit
  ├── write_file
  └── edit_file

Execute
  ├── run_command
  ├── background_command
  └── get_command_output

Verify
  ├── get_problems
  └── run_tests
```

---

# 2. Security architecture

Spider is designed around explicit execution boundaries instead of relying on model instructions such as "don't do anything dangerous."

## Permission pipeline

Every tool call passes through a centralized permission pipeline:

```text
Tool Call
   ↓
Trust Checks
   ↓
Policy Rules
   ↓
Argument Validation
   ↓
Permission Decision
   ↓
Execution
   ↓
Bounded Structured Result
```

Destructive operations such as `delete_file` require confirmation.

Network-capable operations are not silently granted permission.

---

## Workspace boundary

File operations use centralized path-safety validation.

Spider protects against:

- `../` traversal
- Absolute-path escapes
- Symlink escapes
- Workspace boundary violations

Unsafe paths are rejected as structured tool errors.

The goal is to make workspace isolation a property of the execution layer rather than something the model has to remember.

---

## Shell-free command execution

Spider uses argv-based process execution with:

```text
shell: false
```

This means shell metacharacters such as:

```text
&&
;
|
$
$(...)
```

are not interpreted by a shell.

Command execution is additionally governed by Spider's permission and execution policies.

`run_tests` uses an allow-listed set of supported runners, including:

```text
pnpm
npm
yarn
pytest
python
cargo
go
```

---

## Network safety

Network operations are intentionally constrained.

`fetch_url`:

- Requires HTTPS
- Blocks loopback addresses
- Blocks private-network addresses
- Blocks link-local addresses
- Blocks cloud metadata endpoints
- Resolves DNS before connection
- Re-checks addresses across redirects
- Returns bounded, script-free text

`search_web` uses a provider abstraction.

Provider credentials are stored in VS Code `SecretStorage`.

Credentials are not intended to be persisted in:

```text
Workspace settings
Extension state
Chat transcripts
Source code
```

---

## Bounded tool output

Tools do not silently return arbitrarily large results.

Spider uses bounded results for:

- File reads
- Diffs
- Git blame
- Diagnostics
- Test output
- Command output
- Network responses

When a result is truncated, the tool reports the condition explicitly:

```json
{
  "truncated": true,
  "reason": "output_limit"
}
```

This prevents the model from confusing an incomplete result with a complete result.

---

# 3. Agent UX

Spider is designed around the editor rather than treating VS Code as a simple chat host.

## Token streaming

Model responses stream into the UI using SSE where supported.

The UI uses a single streaming accumulator to avoid duplicated state and inconsistent rendering.

---

## Background processes

Long-running processes intentionally outlive their original tool call.

For example:

```text
Spider
  ↓
Start development server
  ↓
Continue working
  ↓
Read server output later
  ↓
Diagnose problem
  ↓
Kill server when finished
```

This allows Spider to work with development servers and other long-running processes without blocking the entire agent loop.

---

## User clarification

`ask_user` is implemented through a correlated request/response broker.

It is intentionally separated from the permission system.

A user clarification request cannot silently become a permission approval.

```text
Agent
 ↓
ask_user
 ↓
User response
 ↓
Agent continues
```

Permission decisions remain separate:

```text
Tool
 ↓
Permission System
 ↓
Allow / Deny
```

---

## Structured task plans

Spider's `update_todo` tool maintains structured agent state.

The task plan is separate from the chat transcript.

This allows the agent to maintain:

```text
Task
 ├── Pending
 ├── In progress
 ├── Completed
 └── Blocked
```

without relying on the model to reconstruct the plan from conversation history.

---

## Real artifacts

UI artifacts are generated from actual file-change events.

Spider does not treat model-generated text as proof that a file was changed.

The system observes real workspace events and uses those events to update the UI.

---

## Persistent sessions

Spider supports persistent:

- Sessions
- History
- Provider profiles
- Credentials
- Per-provider configuration

Provider credentials are associated with profile IDs and stored using VS Code `SecretStorage`.

---

# Providers

Spider uses a provider-independent runtime.

| Provider | Type | Description |
|---|---|---|
| **Ollama** | Local | Run models locally |
| **OpenAI-compatible** | Local / Self-hosted | LM Studio, llama.cpp, vLLM and compatible servers |
| **OpenRouter** | Cloud | Access multiple hosted models through one provider |
| **Cursor agents** | Cloud | Use the official Cursor SDK |
| **Mock** | Local | Deterministic provider for tests and UI development |

### Provider architecture

```text
                  ┌── Ollama
                  │
                  ├── OpenAI-compatible
                  │
Spider Agent ─────┼── OpenRouter
                  │
                  ├── Cursor agents
                  │
                  └── Mock
```

The agent runtime does not contain provider-specific tool execution logic.

This separation allows providers to change without rewriting the core agent loop.

---

# Multiple Provider Profiles

Spider supports multiple provider profiles.

For example:

```text
Local Coding
 └── Ollama
      └── qwen / coding model

Work
 └── OpenRouter
      └── selected cloud model

Self Hosted
 └── OpenAI-compatible
      └── internal endpoint

Cursor
 └── Cursor Agent
```

Credentials are associated with profile IDs and stored using VS Code `SecretStorage`.

This allows developers to switch between environments without rebuilding the agent workflow.

---

# Architecture

Spider follows a provider-independent agent architecture.

```text
┌──────────────────────────────┐
│             User             │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Spider Agent          │
│     Provider-independent     │
│         runtime              │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│            Model             │
│ Ollama / OpenRouter / etc.   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│         Tool Router          │
│                              │
│ Availability                 │
│ Validation                   │
│ Permission                   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Tool Executor         │
│                              │
│ Workspace                    │
│ Git                          │
│ Editor                       │
│ Language Services            │
│ Processes                    │
│ Network                      │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│    Bounded Tool Result       │
└──────────────┬───────────────┘
               │
               └──────────────► Agent
```

---

## Single source of truth

The tool registry is the central source of truth for tools.

The router is the central execution path.

The agent loop is tool-agnostic.

The agent should not contain large collections of per-tool branches such as:

```text
if tool === "read_file"
if tool === "write_file"
if tool === "run_command"
if tool === "git_diff"
...
```

Instead:

```text
Model Tool Call
      ↓
Registry
      ↓
Router
      ↓
Policy
      ↓
Executor
```

This keeps the system extensible as the number of tools grows.

---

# Agent Modes

Spider separates different levels of autonomy.

### Ask / Plan

Read-oriented capabilities are available for understanding and planning.

### Agent

The complete tool system can be used to perform development tasks.

The goal is to provide stronger autonomy without removing user control.

---

# Verification Loop

Spider does not treat a generated answer as proof that the task succeeded.

The intended workflow is:

```text
Plan
 ↓
Inspect
 ↓
Change
 ↓
Run
 ↓
Observe
 ↓
Diagnose
 ↓
Fix
 ↓
Verify
```

For example:

```text
Edit authentication code
        ↓
Run tests
        ↓
Tests fail
        ↓
Read diagnostics
        ↓
Inspect implementation
        ↓
Fix code
        ↓
Run tests again
        ↓
Tests pass
```

Tools such as:

```text
get_problems
run_tests
get_diagnostics
```

are part of this verification loop.

---

# Spider vs Chat-First Coding

Spider is designed around an agent workflow rather than a simple code-generation workflow.

| Capability | Spider |
|---|---|
| Agent-first workflow | Yes |
| VS Code integration | Yes |
| Local models | Yes |
| Ollama | Yes |
| OpenAI-compatible APIs | Yes |
| OpenRouter | Yes |
| Cursor agents | Yes |
| Centralized tool registry | Yes |
| Permission pipeline | Yes |
| Workspace path safety | Yes |
| Shell-free execution | Yes |
| Background processes | Yes |
| Git tools | Yes |
| IDE intelligence | Yes |
| Verification loop | Yes |
| Persistent sessions | Yes |
| Multiple provider profiles | Yes |

---

# Who is Spider for?

Spider is built for developers who want:

- An autonomous coding agent inside VS Code
- Local AI through Ollama
- Freedom to choose cloud or self-hosted models
- OpenAI-compatible model support
- OpenRouter support
- Cursor agent support
- Explicit tool permissions
- Workspace safety boundaries
- Transparent command execution
- Persistent agent sessions
- A provider-independent agent runtime
- An open-source alternative for experimenting with agent architecture

Spider is especially useful if you want to experiment with:

```text
Local AI
     +
Agentic coding
     +
Tool execution
     +
VS Code
     +
Security boundaries
```

---

# Installation

## For users

The easiest distribution method is the packaged VSIX release.

Download the latest `.vsix` from the GitHub Releases page.

In VS Code:

1. Open the Extensions view.
2. Open the `...` menu.
3. Select **Install from VSIX...**
4. Select the Spider `.vsix` file.
5. Restart or reload VS Code if requested.
6. Open Spider from the VS Code interface.

> A VS Code Marketplace release will provide an even simpler installation experience once published.

---

## For developers

Clone the repository:

```bash
git clone https://github.com/Ahmadpasha1221/spider
cd spider
```

Install dependencies:

```bash
pnpm install
```

Compile the project:

```bash
pnpm run compile
```

Launch the extension:

```text
VS Code
→ Run
→ Start Debugging
```

---

## Package a VSIX

Build a distributable VSIX:

```bash
npx vsce package
```

The generated package can then be installed through:

```text
VS Code
→ Extensions
→ ...
→ Install from VSIX...
```

---

# Requirements

- VS Code 1.95+
- Node.js compatible with the project configuration
- pnpm
- A supported AI provider

For local inference:

```text
Ollama
```

For cloud inference:

```text
OpenRouter
Cursor
OpenAI-compatible provider
```

---

# Development

Install dependencies:

```bash
pnpm install
```

Run type checking:

```bash
pnpm run typecheck
```

Run linting:

```bash
pnpm run lint
```

Run tests:

```bash
pnpm run test
```

Compile:

```bash
pnpm run compile
```

---

## Test suite

Spider is built with a test-first approach.

The current test suite contains:

```text
678 unit tests
79 test files
```

Coverage includes:

- Tool registry
- Tool schemas
- Permission pipeline
- Path safety
- Symlink protection
- SSRF protection
- Process lifecycle
- Streaming
- Provider routing
- Tool execution
- Git integration
- Agent behavior
- End-to-end registry → router → executor flows

The project also uses real Git repositories for relevant integration tests.

---

# Project Structure

The exact structure may evolve, but the project is broadly organized around:

```text
src/
├── agent/
│   └── Agent runtime
│
├── providers/
│   └── Provider implementations
│
├── tools/
│   ├── registry
│   ├── router
│   ├── executors
│   └── tool definitions
│
├── permissions/
│   ├── permission types
│   ├── permission manager
│   └── permission policy
│
├── execution/
│   └── process execution and safety
│
├── workspace/
│   └── path and workspace safety
│
├── web/
│   └── network tools and policies
│
├── sessions/
│   └── session and history management
│
└── extension/
    └── VS Code integration
```

For the deeper architectural rules and project context, see:

```text
AI_PROJECT_CONTEXT.md
```

---

# Roadmap

Spider is actively evolving.

## Core Agent

- [x] Provider-independent agent runtime
- [x] Centralized tool registry
- [x] Tool router
- [x] Permission pipeline
- [x] Workspace path safety
- [x] Symlink-aware path validation
- [x] Shell-free command execution
- [x] Bounded tool results
- [x] Agent verification loop

## Providers

- [x] Ollama
- [x] OpenAI-compatible providers
- [x] OpenRouter
- [x] Cursor agents
- [x] Mock provider
- [x] Multiple provider profiles
- [x] SecretStorage credential management

## Developer Tools

- [x] File operations
- [x] Search
- [x] Git
- [x] IDE intelligence
- [x] Command execution
- [x] Background processes
- [x] Test execution
- [x] Diagnostics
- [x] Task planning
- [x] User clarification

## UX

- [x] Token streaming
- [x] Persistent sessions
- [x] Session history
- [x] Provider profiles
- [x] Real file-change artifacts
- [x] Background process management

## Next

- [ ] VS Code Marketplace release
- [ ] Improved onboarding
- [ ] Agent session sharing
- [ ] Portable session handoff
- [ ] Remote session handoff
- [ ] Improved context management
- [ ] Better model discovery
- [ ] Expanded provider capabilities

## Future

- [ ] Multi-agent workflows
- [ ] Agent-to-agent handoff
- [ ] Persistent project memory
- [ ] Background agents
- [ ] Public extension API
- [ ] Advanced agent orchestration

---

# Contributing

Contributions are welcome.

Before making a change:

1. Understand the relevant architecture.
2. Check existing issues and discussions.
3. Add or update tests.
4. Run type checking.
5. Run linting.
6. Run the test suite.
7. Verify that security boundaries remain intact.

Typical development workflow:

```bash
pnpm install

pnpm run typecheck

pnpm run lint

pnpm run test

pnpm run compile
```

Please see the project's contributing documentation for additional guidelines.

---

# Security

Security is a core part of Spider's architecture.

If you discover a security vulnerability, please follow the project's security reporting process rather than publicly disclosing an exploitable issue before it can be investigated.

See:

```text
SECURITY.md
```

for the project's security policy.

---

# Architecture Documentation

The detailed architecture and project rules are documented in:

```text
AI_PROJECT_CONTEXT.md
```

This covers areas including:

- Agent runtime
- Provider architecture
- Tool registry
- Tool routing
- Permission management
- Execution safety
- Workspace boundaries
- Network security
- Session management
- UI architecture
- Development constraints

---

# License

Spider is released under the MIT License.

See:

```text
LICENSE
```

for the full license text.

---

# Trademark

Spider is an independent open-source project.

Spider is not affiliated with, endorsed by, or sponsored by Cursor, Inc.

"Cursor" is a trademark of Cursor, Inc.

---

<p align="center">

<strong>Spider — The agent does the work. You own the model.</strong>

</p>

<p align="center">

Built for developers who want control over their AI coding workflow.

</p>