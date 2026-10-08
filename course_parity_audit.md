# Course Parity Audit — Spider vs. microsoft/ai-agents-for-beginners

**Date:** 2026-10-07 · **Branch:** `feat/engine-gaps-a1-c10` · **Working tree:** uncommitted.

**Scope:** every **missing** and **wrong/problematic** thing found while comparing Spider against the full Microsoft course (`github.com/microsoft/ai-agents-for-beginners`, 18 lessons; principle lessons 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 18 read in full). Every point below was verified against the current working tree (grep/read of source), with file references.

**Effort:** S < 1 day · M ≈ 1–2 days · L > 2 days.
**Priority:** P1 = schedule now · P2 = next cycle · P3 = quality pass · P4 = nice to have.

---

## 1. Verdict summary

- **Missing:** 7 items (P1 ×2, P2 ×2, P3 ×1, P4 ×2) — §2.
- **Problematic / wrong:** 9 items (P2 ×2, P3 ×7) — §3.
- **Unverifiable:** 1 item — §4.
- **Deliberately out of scope (no action):** 4 course lessons — §4.
- Highest-impact path: **P1-1 (MCP)** → **P1-2 (long-term memory)** → findings P2-1/P2-2 — all four were explicitly called out by the course.

---

## 2. Missing — ordered by priority

| # | Lesson | What Spider lacks | Evidence in Spider | Where it would go | Effort |
|---|---|---|---|---|---|
| P1-1 | **L11 MCP** | No MCP client, no standard tool connector format, no dynamic tool discovery. All tools are 36 hand-written entries in a static registry — "integrate once" standardization is absent, and this is the course's flagship protocol. | `src/runtime/tools/toolRegistry.ts` (static `TOOLS`, no registry mutations); no `mcp` anywhere in `src/` | New `src/runtime/mcp/mcpClient.ts`; mutable tool overlay in `toolRegistry.ts`; wiring in `src/extension.ts` (this is already gap **A1** in `agent_gaps.md`) | L |
| P1-2 | **L13 long-term memory** | No persistent, cross-session memory store. Tool outcomes, user preferences, and learned facts live only in session transcripts loaded on demand. The course's core loop (working memory → short-term → long-term) only has the first two. | In-flight histories: `src/runtime/openaiCompatible/openaiCompatibleRuntime.ts:53` (`histories` Map); on-disk read-on-reopen: `src/session/transcriptStore.ts`; nothing else in `src/session/` | New `src/runtime/memory/` (store-backed manager + memory tool for the 36-tool registry, MCP-style overlay) | L |
| P2-1 | **L9 metacognition** | Self-reflection is reactive only: the loop retries invalid tool calls with no explicit reflection on *why* an approach failed. There is no reflection phase fed from run history. | `src/runtime/tools/inferenceAgentLoop.ts:52-53` — only `MAX_TOOL_ITERATIONS=20`, `MAX_INVALID_TOOL_RETRIES=2`; retries don't try a different strategy | New `src/runtime/reflection/` unit fed from `runtimeManager.ts` transcript/usage history | M |
| P2-2 | **L7 structured planning** | The agent's plan output is plain strings from tools and plain strings from the plan tool (`update_todo`). No schema-validated plan structures (Pydantic/Zod equivalent) consumed downstream. | `src/runtime/tools/parseToolCalls.ts` (plain strings); `src/runtime/tools/todoTool.ts` (plain plan items); no JSON-schema for plans | New `src/runtime/planning/` unit wired into the existing plan sink | M |
| P3-1 | **L5 Agentic RAG (corrective)** | Retrieval has no evaluation layer: `grep_search`/`workspace_search` return flat hit lists, and while `codebase_search` does rank chunks, no tool *validates* retrieved content before the model acts on it (the course's Corrective RAG step). | `src/runtime/tools/codebaseSearchTool.ts:169` (scoring exists: coverage·0.8 + density·0.2), `src/runtime/tools/searchWebTool.ts`, `src/runtime/tools/workspaceSearch.ts` | New `src/runtime/rag/` validation unit around existing retrieval endpoints | M |
| P4-1 | **L13 structured/episodic memory** | No word/entity-space episodic memory store — long-term facts, user preferences, or learned repo conventions are not persisted across sessions. | Nothing in `src/session/` besides `transcriptStore.ts`; no store keyed on learned facts | Follows from P1-2; add typed records (facts, preferences, episodes) | S |
| P4-2 | **L18 receipts at rest** | No encryption-at-rest for agent state data (transcripts), no secret-safe receipts; only trust-model mitigations exist (rule 6 + untrusted-workspace handling + user consent broker) | `src/permissions/permissionPolicy.ts:140` (untrusted-workspace boundary), `src/runtime/userInteraction/userQuestionBroker.ts` | Skip unless a compliance driver exists | S |

---

## 3. Problematic / wrong

| # | Lesson | Problem | Evidence in Spider | Fix direction | Effort |
|---|---|---|---|---|---|
| W1 (P2) | L12 | Every incoming message clears session history before restoring from disk, so the in-loop compaction at 100k tokens almost never has accumulated turns to compress — multi-turn work loses the course's "summarize as context grows" behavior. | `openaiCompatibleRuntime.ts:118` (`histories.set(sessionId, [])`), `inferenceAgentLoop.ts:112-114`, restore path `runtimeManager.ts:1076` | Retain the most recent N turns between messages; compact on restore | M |
| W2 (P2) | L8 | Subagent internals are invisible to the user (only final status/summary/toolsUsed), and the child transcript stays resident in provider history unless `disposeHistory` succeeds — below the course's visibility bar. | `runtimeManager.ts` `runSubagent` (event sink filters to final `assistant_message`), `subagent.ts` result contract | Emit per-step subagent events to the parent transcript; dispose child history on every exit path | S→M |
| W3 (P3) | L12/L6 | No token ceiling on the primary loop: natural limits are only the 20-tool-iteration cap and the invalid-retry counter; a few huge tool outputs in one run can still blow context. | `inferenceAgentLoop.ts:52` (20 iterations), `112-114` (trim only at limit) | Hard token budget → graceful stop with summary | S |
| W4 (P3) | L13 | Memory/plan structures are plain strings throughout — no typed facts/entities/preferences, which long-term memory (P1-2) will need before it can land cleanly. | `src/runtime/state/taskPlan.ts`, `update_todo` output shape | Typed record schema at the plan/memory layer | M |
| W5 (P3) | L6/L12 | Instruction-attack surface: `.spiderrules` and retrieved file contents are injected into context with trust-language only ("never permissions or safety controls"); tool arguments are not validated against rules, and external content has no post-retrieval check. Classic prompt-injection defense is missing. | `rules/workspaceRules.ts:129` (trust language only), no validation module in `src/runtime/` | Validator between authorize and executor for rules-sensitive args; heuristic/LLM check on externally sourced content | M |
| W6 (P3) | L6/L18 | Checkpoints do not survive a window reload — the timeline is in-memory only, so restoring after a VS Code restart is impossible even though the workspace state made them. | `runtimeManager.ts:172-173` (`private readonly checkpoints = new CheckpointManager()`; no persistence) | Persist timeline to disk (one JSON per session), rebuild on bootstrap | S |
| W7 (P3) | L12 | Checkpoint granularity is per-run only: `startTask` checkpoints each run, but there is no manual checkpoint button between messages — long multi-message tasks get sparse snapshots. | `runtimeManager.ts:828` (checkpoint on `startTask`); GUI can list/restore only | "Checkpoint now" action in the checkpoints menu | S |
| W8 (P3) | L6 | Secret handling is asymmetric: editor *selections* are redacted, but file contents the agent reads into model context (and echoes into chat/transcript) are not run through any redaction pass. | `src/context/editorContext.ts:30` (`redactSensitiveText` on selection only), no redact call in the transcript/file path | Apply `redactSensitiveText` at file-read/chat-echo boundary | M |
| W9 (P3) | L9 | Learning is not fed forward: the loop retries errors in-run, but nothing captures post-run lessons into a persistent strategy layer (blocked by P1-2 anyway — reflection store does not exist). | `inferenceAgentLoop.ts:144-170` (retry/stop only) | Post-run reflection pass writing into the P1-2 store | S |

---

## 4. Out of scope / unverifiable (no action)

- **Unverifiable:** L10 production behavior across real provider failures/rate limits cannot be verified from source + unit tests (providers are mocked in the suite). Treated as N/A by product scope rather than as a missing item.
- **Deliberately out of scope:** L15 (browser/computer use — coding agent, no browser automation), L16 (scales as a local VS Code extension, no fleet to deploy), L1/L2 (intro + framework overview — informational; Spider deliberately owns its loop rather than adopting an external framework, which matches the course's own agent-vs-workflow guidance).

---

## 5. Prioritized fix order

1. **P1-1** MCP client (L, existing gap A1) — start with a read-only, user-approved tool overlay in the registry.
2. **P1-2** Long-term memory store (L).
3. **P2 (W1)** Preserve recent history across messages instead of clearing (M).
4. **P2 (W2)** Subagent step visibility + authoritative child-history disposal (S→M).
5. **P3 (W3)** Hard token ceiling on the primary loop (S).
6. **P3 (W6)** Persist checkpoints across reloads (S).
7. **P3 (W7)** On-demand "checkpoint now" (S).
8. **P3 (W4+W9)** Typed memory records + post-run reflection feed (depends on #2).
9. **P3 (W5)** Rules/args validation + retrieval-content check (M).
10. **P3 (W8)** Extend `redactSensitiveText` to the file-read/chat-echo path (M).

