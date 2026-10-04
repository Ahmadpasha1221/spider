import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Safe Markdown rendering for chat messages (A3).
 *
 * Model output is untrusted input. It is parsed by `marked` and then
 * run through DOMPurify with an EXPLICIT allowlist before it ever
 * reaches `innerHTML`: anything not on the list — scripts, iframes,
 * images, forms, event handlers, inline styles, `data-*` attributes —
 * is dropped, not escaped-and-kept. The webview CSP (no inline
 * scripts/styles, nonce-only script-src) is the second layer, so
 * rendering stays safe even if a parser edge case slips through.
 *
 * No syntax highlighter is bundled: code blocks get a language label
 * and a Copy button instead (highlighting would need another runtime
 * dependency for marginal value in a chat surface).
 */

marked.setOptions({ gfm: true, breaks: true });

/** Every tag a chat message may contain. Everything else is stripped. */
const ALLOWED_TAGS: readonly string[] = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

/**
 * Every attribute a chat message may carry. `class` only because
 * `marked` tags fenced code with `language-*`; `href`/`title`/`lang`
 * are the safe markdown extras. No `style`, no `on*`, no `data-*`.
 */
const ALLOWED_ATTR: readonly string[] = ["class", "href", "lang", "title"];

/**
 * Renders Markdown to a sanitized HTML string. Pure — the caller owns
 * the DOM write. Fail-safe: if DOMPurify cannot run (no DOM, as in a
 * bare Node process), the raw text is fully escaped instead of ever
 * passing HTML through unsanitized.
 */
export function renderMarkdown(text: string): string {
  if (text.trim().length === 0) {
    return "";
  }
  if (!DOMPurify.isSupported) {
    return escapeHtml(text);
  }
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Wraps every `<pre>` in a `.code-block` container with a language
 * label and a Copy button. Pure DOM construction — no HTML strings —
 * so it cannot introduce injection on its own.
 */
export function decorateCodeBlocks(body: HTMLElement): void {
  const blocks = Array.from(body.querySelectorAll("pre"));
  for (const pre of blocks) {
    const code = pre.querySelector("code");
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const lang = document.createElement("span");
    lang.className = "code-lang";
    const match = code?.className.match(/language-([^\s]+)/);
    lang.textContent = match?.[1] ?? "code";
    const copy = document.createElement("button");
    copy.className = "code-copy";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void copyCode(copy, code?.textContent ?? "");
    });
    head.append(lang, copy);
    pre.replaceWith(wrapper);
    wrapper.append(head, pre);
  }
}

/**
 * Renders Markdown into a message body and decorates its code blocks.
 * The single entry point the message list uses, so every agent
 * message (streaming, final, restored) renders identically.
 */
export function renderMarkdownInto(body: HTMLElement, text: string): void {
  body.classList.add("markdown-body");
  body.innerHTML = renderMarkdown(text);
  decorateCodeBlocks(body);
}

async function copyCode(button: HTMLButtonElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API unavailable: select the code so the user can
    // copy manually instead of failing silently.
    const range = document.createRange();
    const pre = button.closest(".code-block")?.querySelector("code");
    if (pre) {
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    return;
  }
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = "Copy";
  }, 1200);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
