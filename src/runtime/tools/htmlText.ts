/**
 * Minimal, dependency-free HTML→text extraction for `fetch_url`.
 *
 * This runs no JavaScript, loads no remote resources and interprets nothing as
 * application code: it strips script/style/comment content and tags, decodes
 * entities, and collapses whitespace. It is deliberately conservative — the
 * model needs readable text, not a rendering engine.
 */
const BLOCK_END_TAGS = /<\/(?:p|div|li|ul|ol|tr|table|section|article|header|footer|blockquote|h[1-6]|pre)>/gi;
const BR_TAGS = /<br\s*\/?>/gi;
const SCRIPT_STYLE = /<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const TAGS = /<[^>]*>/g;

export function htmlToText(html: string): string {
  const withoutScripts = html.replace(SCRIPT_STYLE, " ").replace(COMMENTS, " ");
  const withBreaks = withoutScripts.replace(BLOCK_END_TAGS, "\n").replace(BR_TAGS, "\n");
  const withoutTags = withBreaks.replace(TAGS, " ");
  return collapseWhitespace(decodeEntities(withoutTags));
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Collapses runs of spaces/tabs and more than one blank line. */
export function collapseWhitespace(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim());

  const result: string[] = [];
  let blank = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blank += 1;
      if (blank > 1) {
        continue;
      }
    } else {
      blank = 0;
    }
    result.push(line);
  }
  return result.join("\n").trim();
}
