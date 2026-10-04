# AI_PROJECT_CONTEXT2.md — GUI Redesign Pass (D-gaps, 2026-10-04)

> Companion to `AI_PROJECT_CONTEXT.md`. Read that file first for the full
> architecture; this file records ONLY what the GUI redesign pass changed,
> why, and the new rules going forward. Accent color (`#8b5cf6` violet
> family) was intentionally left untouched — only styling and render
> behavior changed.

---

## 1. What was wrong (diagnosis)

The reported symptom — "buttons/inputs blink or don't respond until window
reload" — had three concrete root causes in the webview, all the same bug
shape: **the UI destroyed interactive elements while the user was touching
them**, on a render path that runs on *every host event burst* (including
streaming deltas):

1. `renderSettingsView` (`gui/src/views/settingsView.ts`) does
   `root.replaceChildren()` unconditionally. `render()` in `main.ts` called
   it on every `scheduleUiSync` tick — so each streaming delta rebuilt the
   entire settings page. Hovering any button while a run streamed replaced
   the element between hover frames (blink); typing in the OpenRouter model
   filter rebuilt the input on every keystroke (focus + caret loss).
   `renderProviderSettings` had a value snapshot/restore hack but never
   restored focus or caret.
2. `renderSetupBanner` did `setupBanner.replaceChildren()` on every render
   while unconnected — same destroy-under-pointer for its "Choose provider"
   button.
3. `render()` rewrote `settingsBtn.textContent` ("Chat"/"Settings") and
   `runtimePill.textContent` on every tick, and `composer.sync()` rewrote
   placeholders/button text/disabled flags unconditionally — resetting
   hover/pressed state at streaming frequency reads as flicker even when
   values are identical.

None of this was a VS Code webview bug. It was unconditional DOM churn.

## 2. What changed (files)

### `gui/index.html`
- Header actions are now icon-only inline SVGs (history = clock, new = plus,
  settings = gear), 16px, `stroke="currentColor"`. Text labels ("History",
  "Settings", "+") removed. Element ids unchanged.

### `gui/src/main.ts`
- **Settings rebuild guard** (`renderSettingsViewGuarded`): settings DOM
  rebuilds only when a fingerprint of settings-relevant state changes
  (section, provider, models, filter, loading, connection, auth, shield,
  rules, extension info). Streaming deltas no longer touch settings.
- **Focus + caret restore** across the guarded rebuild (by element id,
  `setSelectionRange` best-effort).
- **Setup-banner fingerprint** (`lastSetupBannerFingerprint`): banner
  rebuilds only when readiness/provider/error changes.
- **Header guards** (`setTextOnce` + `aria-pressed` toggle): the settings
  button keeps its SVG children forever; only `aria-pressed`/`title`/
  `aria-label`/`.is-active` change. `runtimePill` and `newSessionBtn.disabled`
  write only on change.
- **Try Again removed**: `retryLastPrompt` deleted, `onRetry` no longer
  passed to the composer. The `TRY_AGAIN` protocol message type is kept in
  `gui/src/protocol.ts` (host still accepts it) — no host change needed.
- **Suggestion wiring**: `onSuggest` handler fills the composer via the new
  `composer.setPrompt()`.

### `gui/src/components/composer.ts` (rewritten)
- Removed the Cancel + Try Again + Send row. **One primary action only**:
  a round 32px button bottom-right inside the input — Send (↑) while idle,
  Stop (■, error-colored outline) while running. Never both, never three.
- `ComposerHandle.update` no longer takes `canRetry`; `onRetry` option
  removed; added `setPrompt(text)`.
- `current` is now `const` (mutated in place, never reassigned).
- **Guarded `sync()`**: placeholder, primary mode (`send`/`stop`/`disabled`),
  and shield state each have a last-value key; DOM writes happen only on
  change. `syncModelSelect` keeps its existing key guard.
- Shield is now a **labeled pill switch** (dot + "Auto-approve on/off" text)
  instead of a bare 🛡 emoji — the ON state is accent-filled and unmissable,
  since it disables safety prompts.

### `gui/src/views/chatView.ts`
- Dropped `canRetry` from the composer update call.

### `gui/src/components/messageList.ts`
- Empty state gains three suggestion chips ("Explain this file",
  "Find bugs", "Write tests") via `SUGGESTIONS` + `onSuggest` handler
  (`MessageListHandlers.onSuggest`). Chips fill the composer; they do not
  send directly.

### `gui/styles/main.css`
- Geometry: `border-radius: 0` ("sharp edges everywhere") replaced with
  8px radii on buttons/inputs/cards/composer/settings rows, 999px pills for
  status chips/toggles/shield/suggestion chips, 12px composer + 12px user
  bubble. Accent variables untouched.
- Message chrome: agent messages are borderless (no more wall of boxes);
  user messages are right-aligned tinted bubbles (`accent 13%` over user bg,
  max-width 88%); system/tool keep zero-chrome containers; errors keep a
  rounded error box. Streaming line shows a slim accent rail + caret.
- Message list is now a flex column so `align-self: flex-end` works for
  user bubbles.
- Composer v2 styles: round `.composer-send` with `::after` glyph per
  `data-mode`, labeled `.shield-btn` pill with `.shield-dot`/`.shield-label`,
  ghost model select, `.suggest-chip` pills.
- Empty-state watermark/animations/reduced-motion behavior unchanged.

## 3. Verification
- `pnpm run typecheck` — green (both configs).
- `pnpm run lint` — 0 warnings.
- `pnpm run compile` — green (extension + GUI bundles).
- `pnpm test` — 88 files / 744 tests passed.

## 4. New rules for future GUI work
1. **Never `replaceChildren` a container the user may be interacting with on
   an unguarded render path.** Fingerprint-guard rebuilds, or update in
   place. This was the blink bug; do not reintroduce it.
2. **Guard every per-render DOM write** (text/disabled/hidden/class) with a
   last-value check when the render runs at streaming frequency.
3. **Composer owns exactly one primary action.** Do not add a second button
   into `.composer-input` without removing one.
4. **Accent color stays `#8b5cf6` family.** Restyle around it, never replace it.
5. `TRY_AGAIN` still exists host-side; the GUI simply never sends it now.
   If retry returns, route it through the single primary action, not a new button.
