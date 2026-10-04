// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { decorateCodeBlocks, renderMarkdown, renderMarkdownInto } from "../../../gui/src/components/markdown";

/**
 * Markdown rendering (A3): the model's output is untrusted, so
 * every assertion below doubles as a security property — the
 * rendered HTML must never carry scripts, handlers, images,
 * inline styles or unsafe URLs.
 */
describe("renderMarkdown", () => {
  it("renders headings, paragraphs, bold, italic and inline code", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and *italic* and `code`.");
    expect(html).toContain("<h1>");
    expect(html).toContain("<p>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders fenced code blocks with the language class", () => {
    const html = renderMarkdown("```ts\nconst x: number = 1;\n```");
    expect(html).toContain("<pre><code class=\"language-ts\">");
    expect(html).toContain("const x: number = 1;");
  });

  it("renders ordered and unordered lists", () => {
    const html = renderMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("renders tables, blockquotes, links and horizontal rules", () => {
    const html = renderMarkdown(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n[link](https://example.com)\n\n---",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<a href=\"https://example.com\">link</a>");
    expect(html).toContain("<hr>");
  });

  it("escapes raw HTML in the source text", () => {
    const html = renderMarkdown("1 < 2 and 3 > 2");
    expect(html).not.toContain("1 < 2");
    expect(html).toContain("1 &lt; 2");
  });

  it("strips script tags and event handlers (XSS)", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src=javascript:alert(3)></iframe>\n\n<div onclick=alert(4)>click</div>",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("onclick");
    // Text content of stripped tags survives as plain text.
    expect(html).toContain("click");
  });

  it("never keeps javascript: or data: URLs in links", () => {
    const html = renderMarkdown(
      "[bad](javascript:alert(1)) and [worse](data:text/html,<script>alert(2)</script>)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).toContain("<a>bad</a>");
  });

  it("strips inline styles and data attributes", () => {
    const html = renderMarkdown('<span style="color:red" data-secret="x">text</span>');
    expect(html).not.toContain("style=");
    expect(html).not.toContain("data-secret");
    expect(html).toContain("text");
  });

  it("handles malformed and partial Markdown without throwing", () => {
    expect(() => renderMarkdown("```ts\nunterminated fence")).not.toThrow();
    expect(() => renderMarkdown("| broken table")).not.toThrow();
    expect(() => renderMarkdown("**unclosed bold")).not.toThrow();
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n\t ")).toBe("");
  });

  it("an unterminated fence degrades to a code block, not a crash", () => {
    // Streaming state: the closing fence has not arrived yet.
    const html = renderMarkdown("Some intro\n\n```ts\nconst partial = true;");
    expect(html).toContain("<pre>");
    expect(html).toContain("const partial = true;");
  });
});

describe("renderMarkdownInto / decorateCodeBlocks", () => {
  it("renders sanitized HTML into a body element", () => {
    const body = document.createElement("div");
    renderMarkdownInto(body, "**hello** <script>alert(1)</script>");
    expect(body.classList.contains("markdown-body")).toBe(true);
    expect(body.innerHTML).toContain("<strong>hello</strong>");
    expect(body.querySelector("script")).toBeNull();
  });

  it("wraps code blocks with a language label and copy button", () => {
    const body = document.createElement("div");
    renderMarkdownInto(body, "```py\nprint('hi')\n```");
    const block = body.querySelector(".code-block");
    expect(block).not.toBeNull();
    expect(body.querySelector(".code-lang")?.textContent).toBe("py");
    expect(body.querySelector(".code-copy")?.textContent).toBe("Copy");
    expect(block?.querySelector("pre code")?.textContent).toContain("print('hi')");
  });

  it("copy button reports Copied on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const body = document.createElement("div");
    renderMarkdownInto(body, "```js\nlet a = 1;\n```");
    const button = body.querySelector<HTMLButtonElement>(".code-copy");
    button?.click();
    await vi.waitFor(() => {
      // marked keeps the fence's trailing newline in the code content.
      expect(writeText).toHaveBeenCalledWith("let a = 1;\n");
    });
    await vi.waitFor(() => {
      expect(button?.textContent).toBe("Copied");
    });
    vi.unstubAllGlobals();
  });

  it("leaves plain text bodies alone (no code blocks to decorate)", () => {
    const body = document.createElement("div");
    renderMarkdownInto(body, "just text");
    expect(body.querySelector(".code-block")).toBeNull();
    decorateCodeBlocks(body);
    expect(body.textContent?.trim()).toBe("just text");
  });
});
