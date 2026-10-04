# Spider — Agent Gap Analysis

> Gaps, missing patterns, and questionable decisions found by reviewing the
> codebase, `AI_PROJECT_CONTEXT.md`, `docs/`, the GUI sources, and comparing
> against real-world AI coding agents (Cline, Roo Code, Continue, Codex,
> Cursor). Ordered by impact. Each entry says what is missing, why it matters,
> and whether the current approach is wrong vs. merely incomplete.

---

## A. Product-level gaps (things competitors ship that Spider doesn't)

### A1. No MCP (Model Context Protocol) support — **missing, high impact**
Every serious agent (Cline, Roo, Cursor, Continue) supports MCP servers as a
tool source. Spider has a closed, hand-registered tool set. Any user wanting
Jira/GitHub/Postgres/browser tools must fork the code. This is the single
biggest ecosystem gap.

### A2. No checkpoints / workspace snapshots — **missing, high impact**
Users cannot roll the workspace back to "before the agent ran".
`fileChangeReviewManager` captures per-edit before/after and supports
revert, but there is no git-stash-like checkpoint timeline. Wrong pattern for
a coding agent: trust comes from being able to undo.

### A3. No markdown rendering in chat — **missing, high impact (GUI)**
`gui/styles/main.css` uses `white-space: pre-wrap` for messages and there is
no markdown parser dependency in `gui/`. Agent replies are rendered as raw
text — code fences, tables, and bold show as literal characters. Every
competitor renders markdown. **This is currently a broken user experience for
the primary output type of an LLM.**

### A4. No inline diff accept/reject in the editor — **missing**
Edits surface as artifact cards (Open/View changes/Keep/Revert) but there is
no editor-integrated inline diff view with Accept/Reject per hunk. `diffView.ts`
exists but the flow is weaker than Cline/Cursor's apply-edit.

### A5. No custom instructions / rules files — **missing**
No `.spiderrules` / `.clinerules` / memory file. Users cannot give persistent
project instructions (coding style, conventions) without pasting them every
session. System prompt is registry-generated only.

### A6. No slash commands / prompt templates — **missing**
No `/explain`, `/fix`, `/refactor` templates or user-defined commands.

### A7. No subagents / task orchestration — **missing**
No parallel agents, no "@agent" delegation. Fine to defer, but it's a
known differentiator gap.

### A8. No per-message metadata in chat — **missing**
No timestamps, no model name under a reply, no token count/cost per message.
Usage accumulates per session but is never shown in the transcript UI.

### A9. No suggestion chips / empty-state guidance — **missing (GUI)**
Empty state is only a watermark. No "Fix a bug", "Explain this file" starter
prompts.

### A10. No history UI in chat — **intentional but user-hostile**
History DELETION from the chat UI (2026-09-29) decoupled persistence from
the visible UI, but left no in-chat way to get back to an old conversation.
The backend keeps every conversation; the user can't reach them without the
editor History tab. At minimum the chat should link to it.

---

## B. Engine / agent-loop gaps

### B1. `codebase_search` is lexical, not semantic — **incomplete**
Query-term coverage over line chunks. No embeddings, no symbol-aware ranking.
Works as a stopgap but users should not be told it's "codebase search"
without qualification. Settings already admits no indexing.

### B2. Tool search ignores `.gitignore` and uses no native backend — **incomplete**
Walker + hardcoded ignore set. Monorepos with generated code, fixtures, and
vendored deps will produce noisy results. ripgrep should be the default
backend (it's what every editor already ships).

### B3. In-runtime model history is memory-only — **by design, still a gap**
After restart the session continues with empty model history while the
transcript UI looks full. The model silently "forgets" everything. Real
agents persist a compacted history. Your design comment says "zero tokens by
design" — the design is defensible for cost, but the UX consequence
(transcript looks intact, model has no memory) is not communicated anywhere in
the UI.

### B4. `fetch_url` rejects http:// outright, including localhost — **deliberate, but incomplete**
Blocks local dev servers forever "until an explicit local-network policy
exists". That policy should exist. Today the agent cannot read your own
`http://localhost:3000` error page — a very common debugging need.

### B5. `search_web` returns snippets only, needs a key, no provider abstraction beyond Brave-compatible — **incomplete**
No fallback, no page-body fetch of results (agent must guess URLs).

### B6. No streaming `usage`/cost feedback — **missing**
SSE stream merges tool fragments but nothing live-updates tokens/cost during
a run.

### B7. `run_tests` capped at 300 s, no per-test filter contract — **incomplete**
Workaround exists (`background_command`), but a `--grep`-style passthrough
contract should be formalized.

### B8. Language tools are editor-provider-dependent — **incomplete**
Without a language extension everything is `dependency_unavailable`. No
tree-sitter fallback. Acceptable tradeoff, but undocumented to users.

### B9. GitHub/remote integration absent — `git_show`/`git_blame` local-only, no PR/issue context — **missing**

### B10. No conversation compaction strategy — **missing**
History grows unboundedly in the runtime map; no summarization/truncation
policy before the context window overflows. Context window limits from the
catalog are read for display but not enforced for history trimming (no
evidence of trimming logic in the loop).

---

## C. Architecture / engineering risks (documented but unfixed)

### C1. GUI protocol drift — `gui/src/protocol.ts` vs `src/webview/types.ts` manually synced — **wrong-ish, fixable cheaply**
Two hand-maintained copies of the message protocol. This is how the
`SET_AGENT_MODE` removal and the missing History button drift happen. Generate
one from the other (or one shared schema package). **This is the kind of
duplication that will keep producing bugs.**

### C2. index.html still wires a History header button while docs say History UI was removed — **stale code / doc drift**
Verify which is true; either delete the button + `history-btn` handler or
restore the docs. Right now the repo disagrees with itself.

### C3. Brand drift — UX.md says `#7C3AED`, CSS says `#8b5cf6`, README/docs use "Spider" but package id is `codevia-cursor` — **cosmetic but sloppy**
Internal names are intentionally frozen (documented), but the UX doc
contradicting the CSS is an editorial error.

### C4. 735-test suite is unit-heavy; few real end-to-end runs — **incomplete**
Integration tests exist for OpenRouter flows, but the primary supported path
(Ollama NDJSON, WSL execution, permission shield) leans on unit tests. A
single scripted "full conversation against a mock provider through the real
webview host" e2e would catch an entire bug class.

### C5. `BackgroundProcessManager` is in-memory only — **by design, documented**
Output lost on restart; `run_tests` longer than 300 s needs it but you lose
everything on reload. Acceptable, noted.

### C6. `ChatTurn` shape changes must touch both runtimes + serializer — **fragile**
TypeScript catches most, but id semantics are only test-enforced. Shared
`toOpenAiMessages` already exists; Ollama path keeps its own serialization.
Eventually unify the history shape.

---

## D. GUI / UX gaps (from the pattern review)

### D1. Iconography is raw text — "History", "Settings", "+" buttons — **wrong for a shipped-feel product**
Use SVG icons (VS Code `codicon` set is available to extensions).

### D2. Everything is `border-radius: 0` — **deliberate, but reads as harsh/dated**
Modern agent UIs use 6–10px radii. At minimum differentiate cards from the
sharp inputs.

### D3. Message list is a wall of bordered boxes — **visually heavy**
Every message is a bordered padded block. Long sessions become noisy. Claude/
ChatGPT style: minimal chrome, clear user/agent alignment, more whitespace.

### D4. Composer shield state lacks visual weight — **safety UI deserves emphasis**
The auto-approve shield disables permission prompts. It should be unmissable
(color, icon, label like "Auto-approve ON"), not a quiet toggle.

### D5. No timestamps / no message chrome actions discoverability on touch — **incomplete**
Copy/Delete appear on hover/focus; noted touch shows always. Still no
timestamps.

### D6. Streaming accumulation is correct, but no typing indicator before first delta — **minor**
A gap of silence between send and first token looks like a hang on slow
providers. Needs a "waiting for model" state.

### D7. No keyboard shortcut map / accessibility audit — **missing**
focus-visible exists; no documented shortcuts, no aria-live for streaming text.

---

## E. "Is the way of development wrong?" — honest verdict

Not wrong overall — the discipline (single agent loop, registry-driven tools,
one permission pipeline, argv-only execution, secrets in SecretStorage,
persistent transcripts) is genuinely better than most. But three things are
actively working against you:

1. **The GUI is the weakest link.** Backend e2e is real; the webview looks
   like a dev tool. Markdown rendering (A3) alone would move the perceived
   quality by a full point.
2. **Docs say things the code doesn't do** (History removal, History button,
   accent color). `AI_PROJECT_CONTEXT.md` is your memory — if it drifts,
   future changes get made on false premises (C2, C3).
3. **The biggest competitive gaps are ecosystem, not code quality:** no MCP
   (A1), no checkpoints (A2), no rules files (A5). Competitors win on
   surface area. You cannot out-execute them feature-by-feature alone —
   MCP support is the only leverage point because it imports everyone else's
   tools.

Recommended priority order:
1. A3 markdown rendering in messages
2. A10 / C2 reconcile History UI vs docs
3. C1 single-source the webview protocol
4. A1 MCP client (the ecosystem multiplier)
5. A2 checkpoints
6. A5 rules files
7. D1 SVG icons, D4 shield visibility, D3 message chrome
8. B2 `.gitignore`-aware search via ripgrep (when you add it)
