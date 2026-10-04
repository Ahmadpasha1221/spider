import type { FileChangeView } from "../protocol";
import type { ChatLine } from "../state";
import { createStreamCoalescer } from "../streamCoalescer";
import { renderMarkdownInto } from "./markdown";

type MessageListHandlers = {
  onAllowPermission?: (requestId: string) => void;
  onDenyPermission?: (requestId: string) => void;
  onViewDiff?: (changeId: string) => void;
  onAcceptChange?: (changeId: string) => void;
  onRejectChange?: (changeId: string) => void;
  onOpenArtifact?: (path: string) => void;
  /** Markdown link click: the host opens it externally (http/https only). */
  onOpenUrl?: (url: string) => void;
  /** Message Delete: removes it from the UI and conversation persistence. */
  onDeleteMessage?: (messageId: string) => void;
  /** Empty-state suggestion chip: fills the composer with a starter prompt. */
  onSuggest?: (prompt: string) => void;
};

/**
 * The list appends only new lines and never rebuilds existing DOM. Rebuilding
 * on every host event made the Allow/Deny permission buttons unclickable (the
 * element was replaced between mousedown and mouseup) and reset scroll.
 *
 * Streaming text, tool/command lifecycle, and artifact cards mutate ONE element
 * in place instead of rebuilding the list, so no interactive element is ever
 * destroyed while the pointer is down. Scroll is pinned to the bottom only
 * while the user is already at the bottom (sticky scroll), and the scroll
 * write is batched to animation frames.
 */
export interface MessageListHandle {
  append(lines: readonly ChatLine[], handlers?: MessageListHandlers): void;
  /**
   * Replace the entire transcript (used when a session transcript is restored
   * after a restart or a session switch). Handlers are remembered so later
   * incremental appends keep working.
   */
  replaceAll(lines: readonly ChatLine[], handlers?: MessageListHandlers): void;
  /** Remove every line (used when a new conversation is activated). */
  clear(): void;
  /** Create (or replace) the single streaming assistant line and append a delta chunk. */
  upsertStreamingLine(text: string, handlers?: MessageListHandlers): void;
  /**
   * Finalize the streaming line into a normal agent line. `messageId` is the
   * transcript entry id, so the finalized reply can be copied or deleted.
   */
  finishStreamingLine(finalText: string, messageId?: string): void;
  /**
   * Closes the current streaming turn (flush + reset the accumulator) without
   * removing the painted text. Called at turn boundaries (tool calls, thinking
   * blocks) so the next assistant segment starts a fresh line instead of
   * concatenating onto the previous one.
   */
  endStreamingTurn(): void;
  /** Create or update the single agent-status (Thinking) block. */
  upsertThinkingBlock(text: string, state: "active" | "settled"): void;
  /** Settle the Thinking block when the next activity or response arrives. */
  settleThinkingBlock(): void;
  /** Create or update one tool execution box, matched by toolCallId. */
  upsertToolLine(tool: NonNullable<ChatLine["tool"]>, handlers?: MessageListHandlers): void;
  /** Create or update one command execution box, matched by toolCallId. */
  upsertCommandLine(command: NonNullable<ChatLine["command"]>, handlers?: MessageListHandlers): void;
  /** Flip an existing command box to its terminal state (no new element). */
  completeCommandLine(toolCallId: string | undefined, exitCode: number | null): void;
  /** Create or update one artifact card, matched by changeId. */
  upsertArtifact(change: FileChangeView, reverted: boolean, handlers?: MessageListHandlers): void;
  /** Resolve a pending permission prompt in place, without rebuilding the list. */
  resolvePermission(requestId: string, decision: "ALLOW" | "DENY"): void;
}

export function createMessageList(root: HTMLElement, initialHandlers?: MessageListHandlers): MessageListHandle {
  let currentHandlers: MessageListHandlers = initialHandlers ?? {};

  // Markdown links are intercepted here (delegation, so links
  // re-created on every streaming frame keep working): the host
  // decides whether the URL may be opened. Anchors never navigate
  // the webview itself.
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const anchor = target.closest("a");
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      currentHandlers.onOpenUrl?.(anchor.getAttribute("href") ?? "");
    }
  });

  const itemByToolCallId = new Map<string, HTMLElement>();
  const artifactByChangeId = new Map<string, HTMLElement>();
  let streamingLine: HTMLElement | undefined;
  /**
   * The streaming line's message body. Markdown is re-rendered into
   * it (at most once per animation frame by the coalescer), so the
   * accumulator below stays the single source of truth for content.
   */
  let streamingBody: HTMLDivElement | undefined;
  let thinkingBlock: HTMLElement | undefined;
  let thinkingBody: HTMLElement | undefined;
  let scrollScheduled = false;
  /**
   * THE source of truth for the current assistant stream. Chunks append here
   * synchronously and the coalescer repaints the text node at most once per
   * animation frame, so generation feels continuous without per-chunk DOM
   * writes. There is exactly one accumulator and one scheduler on the UI side
   * (a second one upstream was what made streaming look chunky).
   */
  let streamText = "";
  let coalescer = createStreamCoalescer(paintStreamText);

  /**
   * Discards the streaming state without painting. Used when the list is being
   * emptied or replaced: flushing pending text here would resurrect a stale
   * line into the cleared list.
   */
  function resetStreamState(): void {
    coalescer.reset();
    coalescer = createStreamCoalescer(paintStreamText);
    streamText = "";
  }

  function isPinnedToBottom(): boolean {
    return root.scrollHeight - root.scrollTop - root.clientHeight < 48;
  }

  /** Batched, sticky-bottom scroll: one rAF per burst, never mid-frame thrash. */
  function scheduleScroll(force = false): void {
    if (!force && !isPinnedToBottom()) {
      return;
    }
    if (scrollScheduled) {
      return;
    }
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      root.scrollTop = root.scrollHeight;
    });
  }

  function labelFor(message: ChatLine): string {
    switch (message.role) {
      case "user":
        return "You";
      case "agent":
        return "Spider";
      case "thinking":
        return "Thinking";
      case "error":
        return "Error";
      case "tool":
        return "Tool";
      case "system":
        return "Agent";
    }
  }

  function buildBaseLine(message: ChatLine): { article: HTMLElement; body: HTMLDivElement } {
    const article = document.createElement("article");
    article.className = `message message-${message.role}`;
    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = labelFor(message);
    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "agent") {
      // Assistant output is Markdown; user/system/tool text stays
      // plain (it is usually written as notes, not formatted).
      renderMarkdownInto(body, message.text);
    } else {
      body.textContent = bodyText(message);
    }
    article.append(meta, body);
    return { article, body };
  }

  function appendArtifactLine(change: FileChangeView): void {
    const card = document.createElement("article");
    card.className = "artifact-card";
    card.dataset.status = change.status === "REVERTED" ? "reverted" : "applied";
    card.setAttribute("role", "group");

    const head = document.createElement("div");
    head.className = "artifact-head";
    const icon = document.createElement("span");
    icon.className = "artifact-icon";
    icon.textContent = "◇";
    const kind = document.createElement("span");
    kind.className = "artifact-kind";
    kind.textContent = change.status === "REVERTED" ? "Artifact · Reverted" : change.isNewFile ? "Artifact · Created" : "Artifact · Updated";
    head.append(icon, kind);

    const path = document.createElement("div");
    path.className = "artifact-path";
    path.textContent = change.path;
    path.title = change.path;

    const stats = document.createElement("div");
    stats.className = "artifact-stats";
    const add = document.createElement("span");
    add.className = "diff-add";
    add.textContent = `+${change.additions}`;
    const del = document.createElement("span");
    del.className = "diff-del";
    del.textContent = `−${change.deletions}`;
    stats.append(add, del);

    const actions = document.createElement("div");
    actions.className = "artifact-actions";
    const open = document.createElement("button");
    open.className = "btn btn-ghost btn-small";
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", () => currentHandlers.onOpenArtifact?.(change.path));
    const view = document.createElement("button");
    view.className = "btn btn-ghost btn-small";
    view.type = "button";
    view.textContent = "View changes";
    view.addEventListener("click", () => currentHandlers.onViewDiff?.(change.changeId));
    actions.append(open, view);
    if (change.status === "APPLIED") {
      const keep = document.createElement("button");
      keep.className = "btn btn-small";
      keep.type = "button";
      keep.textContent = "Keep";
      keep.addEventListener("click", () => currentHandlers.onAcceptChange?.(change.changeId));
      const reject = document.createElement("button");
      reject.className = "btn btn-danger btn-small";
      reject.type = "button";
      reject.textContent = "Revert";
      reject.addEventListener("click", () => currentHandlers.onRejectChange?.(change.changeId));
      actions.append(keep, reject);
    }

    card.append(head, path, stats, actions);
    root.appendChild(card);
    artifactByChangeId.set(change.changeId, card);
  }

  function appendLine(message: ChatLine): void {
    // Artifacts restored from a transcript render as artifact cards too.
    if (message.artifact) {
      appendArtifactLine(message.artifact);
      return;
    }
    const { article } = buildBaseLine(message);
    appendInteractive(article, message);
    root.appendChild(article);
  }

  function appendInteractive(article: HTMLElement, message: ChatLine): void {
    attachMessageActions(article, message);
    if (message.permission?.pending) {
      article.appendChild(permissionActions(message.permission.requestId, currentHandlers));
    }
    if (message.fileChange && message.fileChange.status === "APPLIED") {
      article.appendChild(fileChangeActions(message.fileChange, currentHandlers));
    }
  }

  /**
   * Copy + Delete for user/assistant messages that carry a stable id. The bar
   * is CSS-hidden until hover/focus so it never clutters the transcript, and
   * it mutates in place — no rebuild, so clicks are never eaten.
   */
  function attachMessageActions(article: HTMLElement, message: ChatLine): void {
    if (!message.messageId || (message.role !== "user" && message.role !== "agent")) {
      return;
    }
    if (article.querySelector(".message-actions")) {
      return;
    }
    const messageId = message.messageId;
    article.dataset.messageId = messageId;
    const bar = document.createElement("div");
    bar.className = "message-actions";

    const copy = document.createElement("button");
    copy.className = "btn btn-ghost btn-small message-action";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", "Copy message");
    copy.addEventListener("click", () => {
      const body = article.querySelector<HTMLElement>(".message-body");
      void copyText(body?.textContent ?? "");
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1200);
    });

    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-small message-action";
    del.type = "button";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete message");
    del.addEventListener("click", () => {
      currentHandlers.onDeleteMessage?.(messageId);
      article.remove();
      syncEmptyState();
      scheduleScroll(true);
    });

    bar.append(copy, del);
    article.appendChild(bar);
  }

  /**
   * Collapsible exec output: `data-expanded` drives CSS, so toggling is a
   * single attribute write (no layout rebuild). User toggles are sticky — the
   * automatic running→completed collapse never fights a manual choice.
   */
  function execToggle(article: HTMLElement): HTMLButtonElement {
    const toggle = document.createElement("button");
    toggle.className = "exec-toggle";
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      article.dataset.userToggled = "true";
      setExecExpanded(article, article.dataset.expanded === "false");
    });
    return toggle;
  }

  function setExecExpanded(article: HTMLElement, expanded: boolean): void {
    article.dataset.expanded = expanded ? "true" : "false";
    const toggle = article.querySelector<HTMLButtonElement>(".exec-toggle");
    if (toggle) {
      toggle.textContent = expanded ? "Hide details" : "Details";
      toggle.setAttribute("aria-expanded", String(expanded));
    }
  }

  function syncEmptyState(): void {
    const hasLines = root.querySelector(".message, .artifact-card, .exec-box") !== null;
    const empty = root.querySelector<HTMLElement>(".empty-chat");
    if (!hasLines && !empty) {
      const placeholder = document.createElement("div");
      placeholder.className = "empty-chat";
      const mark = document.createElement("img");
      mark.className = "empty-chat-watermark";
      // Spider mark (assets/spider-icon.png) served through the webview URI
      // injected into the HTML; decorative, click-through, theme-tinted in CSS.
      const logoMeta = document.querySelector<HTMLMetaElement>('meta[name="spider-logo"]');
      if (logoMeta?.content && !logoMeta.content.includes("{{logoUri}}")) {
        mark.src = logoMeta.content;
      }
      mark.alt = "";
      mark.setAttribute("aria-hidden", "true");
      mark.draggable = false;
      const title = document.createElement("strong");
      title.textContent = "How can I help?";
      const hint = document.createElement("span");
      hint.textContent = "Ask Spider to explain, debug, refactor, or work on your code.";
      placeholder.append(mark, title, hint);
      const chips = document.createElement("div");
      chips.className = "suggest-chips";
      for (const suggestion of SUGGESTIONS) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "suggest-chip";
        chip.textContent = suggestion.label;
        chip.addEventListener("click", () => currentHandlers.onSuggest?.(suggestion.prompt));
        chips.appendChild(chip);
      }
      placeholder.appendChild(chips);
      root.appendChild(placeholder);
    } else if (hasLines && empty) {
      empty.remove();
    }
  }

  /**
   * Creates the streaming line on demand. One article + one text node; later
   * updates mutate the text node only, so nothing interactive is ever rebuilt.
   */
  function ensureStreamingLine(): void {
    if (streamingLine && streamingLine.isConnected) {
      return;
    }
    const article = document.createElement("article");
    article.className = "message message-agent streaming-line";
    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = "Spider";
    const body = document.createElement("div");
    body.className = "message-body";
    article.append(meta, body);
    root.appendChild(article);
    streamingLine = article;
    streamingBody = body;
    streamText = "";
    const empty = root.querySelector<HTMLElement>(".empty-chat");
    if (empty) {
      empty.remove();
    }
  }

  /**
   * Frame paint: the coalescer releases accumulated chunks at
   * most once per animation frame and the full accumulator is
   * re-rendered as Markdown. Incomplete fences/lists/tables
   * degrade gracefully (an unterminated fence renders as a
   * code block to end-of-stream) — no partial-DOM bookkeeping.
   */
  function paintStreamText(_text: string): void {
    if (!streamingLine || !streamingLine.isConnected) {
      ensureStreamingLine();
    }
    if (streamingBody && streamText.length > 0) {
      renderMarkdownInto(streamingBody, streamText);
      scheduleScroll();
    }
  }

  return {
    append(lines, handlers) {
      if (handlers) {
        currentHandlers = handlers;
      }
      const pinned = isPinnedToBottom();
      for (const message of lines) {
        appendLine(message);
      }
      syncEmptyState();
      scheduleScroll(pinned);
    },

    replaceAll(lines, handlers) {
      if (handlers) {
        currentHandlers = handlers;
      }
      root.replaceChildren();
      itemByToolCallId.clear();
      artifactByChangeId.clear();
      streamingLine = undefined;
      streamingBody = undefined;
      thinkingBlock = undefined;
      thinkingBody = undefined;
      resetStreamState();
      const pinned = isPinnedToBottom();
      for (const message of lines) {
        appendLine(message);
      }
      syncEmptyState();
      scheduleScroll(pinned);
    },

    clear() {
      root.replaceChildren();
      itemByToolCallId.clear();
      artifactByChangeId.clear();
      streamingLine = undefined;
      streamingBody = undefined;
      thinkingBlock = undefined;
      thinkingBody = undefined;
      resetStreamState();
      syncEmptyState();
      scheduleScroll(true);
    },

    upsertStreamingLine(text, handlers) {
      if (handlers) {
        currentHandlers = handlers;
      }
      // Assistant output starting settles the Thinking block in place — the
      // status block does not pop away; it transitions into the response.
      this.settleThinkingBlock();
      ensureStreamingLine();
      // Append the delta to the single accumulator; the coalescer paints it on
      // the next animation frame and close() flushes any remainder.
      streamText += text;
      coalescer.push(text);
    },

    endStreamingTurn() {
      // Flush pending text into the current line, then start a fresh segment:
      // the painted text stays, the accumulator resets for the next part of
      // the conversation (e.g. after a tool block).
      coalescer.close();
      coalescer = createStreamCoalescer(paintStreamText);
      if (streamingLine && streamingLine.isConnected) {
        streamingLine.classList.remove("streaming-line");
      }
      streamingLine = undefined;
      streamingBody = undefined;
      streamText = "";
    },

    finishStreamingLine(finalText, messageId) {
      // Release any text still held by the coalescer before deciding what to
      // keep, so the comparison below sees the fully painted state.
      coalescer.close();
      if (streamingLine && streamingLine.isConnected) {
        const streamedText = streamText;
        // Nothing visible was streamed and nothing final arrived: drop the
        // empty line instead of leaving an empty agent bubble.
        if (streamedText.length === 0 && finalText.length === 0) {
          streamingLine.remove();
        } else {
          streamingLine.classList.remove("streaming-line");
          if (finalText.length > 0) {
            const body = streamingLine.querySelector<HTMLDivElement>(".message-body");
            if (body) {
              // The finalized model message replaces the accumulated stream
              // text exactly once — same source, no duplication possible.
              renderMarkdownInto(body, finalText);
            }
          }
          attachMessageActions(streamingLine, {
            role: "agent",
            text: finalText,
            ...(messageId ? { messageId } : {}),
          });
        }
      } else if (finalText.length > 0) {
        const { article } = buildBaseLine({ role: "agent", text: finalText });
        root.appendChild(article);
        attachMessageActions(article, {
          role: "agent",
          text: finalText,
          ...(messageId ? { messageId } : {}),
        });
        scheduleScroll();
      }
      streamingLine = undefined;
      streamingBody = undefined;
      resetStreamState();
    },

    upsertThinkingBlock(text, state) {
      // Thinking precedes assistant output: close any open streaming segment.
      this.endStreamingTurn();
      const empty = root.querySelector<HTMLElement>(".empty-chat");
      if (empty) {
        empty.remove();
      }
      if (!thinkingBlock || !thinkingBlock.isConnected) {
        thinkingBlock = document.createElement("article");
        thinkingBlock.className = "message message-thinking-block";
        thinkingBlock.setAttribute("aria-live", "polite");
        const head = document.createElement("div");
        head.className = "thinking-head";
        const icon = document.createElement("span");
        icon.className = "thinking-icon";
        icon.textContent = "✦";
        const label = document.createElement("span");
        label.textContent = "Thinking";
        head.append(icon, label);
        thinkingBody = document.createElement("div");
        thinkingBody.className = "thinking-body";
        thinkingBlock.append(head, thinkingBody);
        root.appendChild(thinkingBlock);
      }
      thinkingBlock.dataset.state = state;
      if (thinkingBody && thinkingBody.textContent !== text) {
        thinkingBody.textContent = text;
      }
      scheduleScroll();
    },

    settleThinkingBlock() {
      if (thinkingBlock && thinkingBlock.isConnected && thinkingBlock.dataset.state === "active") {
        thinkingBlock.dataset.state = "settled";
      }
    },

    upsertToolLine(tool, handlers) {
      if (handlers) {
        currentHandlers = handlers;
      }
      this.settleThinkingBlock();
      // A tool call is its own activity block: close any open streaming
      // segment so assistant text after the tool starts a new line.
      this.endStreamingTurn();
      let article = itemByToolCallId.get(tool.toolCallId);
      const pinned = isPinnedToBottom();
      if (!article || !article.isConnected) {
        article = document.createElement("article");
        article.className = "message message-tool exec-box";
        article.setAttribute("role", "status");
        const card = document.createElement("div");
        card.className = "exec-card";
        const head = document.createElement("div");
        head.className = "exec-head";
        const icon = document.createElement("span");
        icon.className = "exec-icon";
        icon.textContent = "◈";
        const name = document.createElement("span");
        name.className = "exec-name";
        const status = document.createElement("span");
        status.className = "exec-status";
        const toggle = execToggle(article);
        toggle.hidden = true;
        head.append(icon, name, status, toggle);
        const detail = document.createElement("div");
        detail.className = "exec-detail";
        card.append(head, detail);
        article.append(card);
        setExecExpanded(article, true);
        root.appendChild(article);
        itemByToolCallId.set(tool.toolCallId, article);
      }
      const name = article.querySelector<HTMLElement>(".exec-name");
      const status = article.querySelector<HTMLElement>(".exec-status");
      const detail = article.querySelector<HTMLElement>(".exec-detail");
      if (name) {
        name.textContent = tool.toolName;
      }
      if (status) {
        status.textContent = tool.status === "running" ? "Running" : tool.status === "failed" ? "Failed" : "✓ Completed";
        status.className = `exec-status is-${tool.status}`;
      }
      if (detail) {
        detail.textContent = tool.error ?? tool.detail ?? "";
        detail.hidden = detail.textContent.length === 0;
        const toggle = article.querySelector<HTMLButtonElement>(".exec-toggle");
        if (toggle) {
          toggle.hidden = detail.textContent.length === 0;
        }
      }
      article.dataset.status = tool.status;
      if (article.dataset.userToggled !== "true") {
        // Stay open while running and for short details (e.g. a file path);
        // only substantial output settles into the compact completed state.
        setExecExpanded(
          article,
          tool.status === "running" || (detail?.textContent.length ?? 0) <= COMMAND_COLLAPSE_THRESHOLD,
        );
      }
      syncEmptyState();
      scheduleScroll(pinned);
    },

    upsertCommandLine(command, handlers) {
      if (handlers) {
        currentHandlers = handlers;
      }
      this.settleThinkingBlock();
      // Same turn-boundary rule as tools: commands get their own block.
      this.endStreamingTurn();
      const key = command.toolCallId ?? `cmd:${command.command}`;
      let article = itemByToolCallId.get(key);
      const pinned = isPinnedToBottom();
      if (!article || !article.isConnected) {
        article = document.createElement("article");
        article.className = "message message-tool exec-box";
        article.setAttribute("role", "status");
        const card = document.createElement("div");
        card.className = "exec-card";
        const head = document.createElement("div");
        head.className = "exec-head";
        const icon = document.createElement("span");
        icon.className = "exec-icon";
        icon.textContent = "▣";
        const name = document.createElement("span");
        name.className = "exec-name";
        const status = document.createElement("span");
        status.className = "exec-status";
        const toggle = execToggle(article);
        toggle.hidden = true;
        head.append(icon, name, status, toggle);
        const output = document.createElement("pre");
        output.className = "exec-output";
        card.append(head, output);
        setExecExpanded(article, true);
        article.append(card);
        root.appendChild(article);
        itemByToolCallId.set(key, article);
      }
      const name = article.querySelector<HTMLElement>(".exec-name");
      const status = article.querySelector<HTMLElement>(".exec-status");
      const output = article.querySelector<HTMLElement>(".exec-output");
      if (name) {
        name.textContent = `$ ${command.command}`;
      }
      const failed = command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0;
      if (status) {
        status.textContent = command.running ? "Running" : failed ? "Failed" : "✓ Completed";
        status.className = `exec-status is-${command.running ? "running" : failed ? "failed" : "completed"}`;
      }
      let outputLength = 0;
      if (output) {
        const text = [command.stdout, command.stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
        output.textContent = text;
        output.hidden = text.length === 0;
        outputLength = text.length;
        const toggle = article.querySelector<HTMLButtonElement>(".exec-toggle");
        if (toggle) {
          toggle.hidden = text.length === 0;
        }
      }
      article.dataset.status = command.running ? "running" : failed ? "failed" : "completed";
      if (article.dataset.userToggled !== "true") {
        // Stay open while streaming; collapse long finished output only.
        setExecExpanded(article, command.running === true || outputLength <= COMMAND_COLLAPSE_THRESHOLD);
      }
      syncEmptyState();
      scheduleScroll(pinned);
    },

    completeCommandLine(toolCallId, exitCode) {
      const key = toolCallId ?? undefined;
      const article = key ? itemByToolCallId.get(key) : undefined;
      if (!article || !article.isConnected) {
        return;
      }
      const status = article.querySelector<HTMLElement>(".exec-status");
      const failed = exitCode !== null && exitCode !== 0;
      if (status) {
        status.textContent = failed ? "Failed" : "✓ Completed";
        status.className = `exec-status is-${failed ? "failed" : "completed"}`;
      }
      article.dataset.status = failed ? "failed" : "completed";
      if (article.dataset.userToggled !== "true") {
        const text = article.querySelector<HTMLElement>(".exec-output")?.textContent ?? "";
        setExecExpanded(article, text.length <= COMMAND_COLLAPSE_THRESHOLD);
      }
    },

    upsertArtifact(change, reverted, handlers) {
      if (handlers) {
        currentHandlers = handlers;
      }
      let card = artifactByChangeId.get(change.changeId);
      const pinned = isPinnedToBottom();
      if (!card || !card.isConnected) {
        card = document.createElement("article");
        card.className = "artifact-card";
        card.setAttribute("role", "group");
        const head = document.createElement("div");
        head.className = "artifact-head";
        const icon = document.createElement("span");
        icon.className = "artifact-icon";
        icon.textContent = "◇";
        const kind = document.createElement("span");
        kind.className = "artifact-kind";
        head.append(icon, kind);
        const path = document.createElement("div");
        path.className = "artifact-path";
        const stats = document.createElement("div");
        stats.className = "artifact-stats";
        const actions = document.createElement("div");
        actions.className = "artifact-actions";
        card.append(head, path, stats, actions);
        root.appendChild(card);
        artifactByChangeId.set(change.changeId, card);
      }
      const kind = card.querySelector<HTMLElement>(".artifact-kind");
      const path = card.querySelector<HTMLElement>(".artifact-path");
      const stats = card.querySelector<HTMLElement>(".artifact-stats");
      const actions = card.querySelector<HTMLElement>(".artifact-actions");

      if (kind) {
        kind.textContent = reverted || change.status === "REVERTED" ? "Artifact · Reverted" : change.isNewFile ? "Artifact · Created" : "Artifact · Updated";
      }
      if (path) {
        path.textContent = change.path;
        path.title = change.path;
      }
      if (stats) {
        stats.replaceChildren();
        const add = document.createElement("span");
        add.className = "diff-add";
        add.textContent = `+${change.additions}`;
        const del = document.createElement("span");
        del.className = "diff-del";
        del.textContent = `−${change.deletions}`;
        stats.append(add, del);
      }
      if (actions) {
        actions.replaceChildren();
        const open = document.createElement("button");
        open.className = "btn btn-ghost btn-small";
        open.type = "button";
        open.textContent = "Open";
        open.addEventListener("click", () => currentHandlers.onOpenArtifact?.(change.path));
        const view = document.createElement("button");
        view.className = "btn btn-ghost btn-small";
        view.type = "button";
        view.textContent = "View changes";
        view.addEventListener("click", () => currentHandlers.onViewDiff?.(change.changeId));
        if (!reverted && change.status === "APPLIED") {
          const keep = document.createElement("button");
          keep.className = "btn btn-small";
          keep.type = "button";
          keep.textContent = "Keep";
          keep.addEventListener("click", () => currentHandlers.onAcceptChange?.(change.changeId));
          const reject = document.createElement("button");
          reject.className = "btn btn-danger btn-small";
          reject.type = "button";
          reject.textContent = "Revert";
          reject.addEventListener("click", () => currentHandlers.onRejectChange?.(change.changeId));
          actions.append(open, view, keep, reject);
        } else {
          actions.append(open, view);
        }
      }
      card.dataset.status = reverted || change.status === "REVERTED" ? "reverted" : "applied";
      syncEmptyState();
      scheduleScroll(pinned);
    },

    resolvePermission(requestId, decision) {
      const actions = root.querySelector<HTMLElement>(`.permission-actions[data-request-id="${requestId}"]`);
      if (!actions) {
        return;
      }
      const status = document.createElement("span");
      status.className = "permission-resolved";
      status.textContent = decision === "ALLOW" ? "Allowed" : "Denied";
      actions.replaceWith(status);
    },
  };
}

function bodyText(message: ChatLine): string {
  if (message.permission) {
    const command = message.permission.command ? `$ ${message.permission.command}` : "";
    return ["Permission required", command].filter((part) => part.length > 0).join("\n");
  }
  return message.text;
}

function fileChangeActions(
  change: FileChangeView,
  handlers?: MessageListHandlers,
): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "file-change-actions";
  actions.dataset.changeId = change.changeId;

  const view = document.createElement("button");
  view.className = "btn btn-ghost";
  view.type = "button";
  view.textContent = "View diff";
  view.addEventListener("click", () => handlers?.onViewDiff?.(change.changeId));

  const accept = document.createElement("button");
  accept.className = "btn";
  accept.type = "button";
  accept.textContent = "Keep";
  accept.addEventListener("click", () => handlers?.onAcceptChange?.(change.changeId));

  const reject = document.createElement("button");
  reject.className = "btn btn-danger";
  reject.type = "button";
  reject.textContent = "Revert";
  reject.addEventListener("click", () => handlers?.onRejectChange?.(change.changeId));

  actions.append(view, accept, reject);
  return actions;
}

/** Finished command output longer than this collapses to a compact block. */
const COMMAND_COLLAPSE_THRESHOLD = 400;

/** Starter prompts for the empty conversation state. */
const SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Explain this file", prompt: "Explain what the currently open file does." },
  { label: "Find bugs", prompt: "Review the currently open file for bugs and suggest fixes." },
  { label: "Write tests", prompt: "Write tests for the currently open file." },
];

/**
 * Clipboard write with a legacy textarea fallback: some webview hosts deny
 * the async clipboard API, and Copy must still work there.
 */
async function copyText(text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the selection-based fallback.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing more we can do; the selection stays for a manual copy.
  }
  area.remove();
}

function permissionActions(
  requestId: string,
  handlers?: MessageListHandlers,
): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "permission-actions";
  actions.dataset.requestId = requestId;
  const allow = document.createElement("button");
  allow.className = "btn";
  allow.type = "button";
  allow.textContent = "Allow";
  allow.addEventListener("click", () => handlers?.onAllowPermission?.(requestId));
  const deny = document.createElement("button");
  deny.className = "btn btn-ghost";
  deny.type = "button";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => handlers?.onDenyPermission?.(requestId));
  actions.append(allow, deny);
  return actions;
}
