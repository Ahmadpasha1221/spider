import * as fs from "node:fs/promises";
import { ToolExecutionError } from "./toolError";
import { isSensitiveFilePath } from "../../context/contextTypes";
import { isProbablyBinary, SEARCH_LIMITS, walkWorkspace } from "./workspaceSearch";

/**
 * `codebase_search`: intent-oriented repository retrieval.
 *
 * `grep_search` matches exact text/regex; this tool ranks *chunks* of source by
 * how many query terms they cover, so "where is streaming state managed?" can
 * find the relevant region even when the phrasing differs. It is deliberately
 * lightweight: it reuses the shared workspace walker (same ignore rules, path
 * safety, binary detection and cancellation) and does not introduce a vector
 * database, embedding service, or persistent index.
 *
 * Sensitive files (`.env`, keys, credentials) are never scanned, and results
 * are bounded, deterministic and workspace-scoped.
 */
export const CODEBASE_SEARCH_LIMITS = {
  defaultResults: 8,
  maxResults: 20,
  chunkLines: 40,
  chunkStride: 20,
  maxChunksPerFile: 40,
  maxScannedFiles: SEARCH_LIMITS.grepMaxScannedFiles,
  /** Upper bound on candidates kept in memory before trimming. */
  candidateBuffer: 500,
} as const;

export interface CodebaseSearchHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reason: string;
}

export interface CodebaseSearchResult {
  readonly query: string;
  readonly results: readonly CodebaseSearchHit[];
  readonly terms: readonly string[];
  readonly scannedFiles: number;
  readonly truncated?: true;
  readonly reason?: "max_scanned_files" | "max_results";
  readonly cancelled?: true;
}

export interface CodebaseSearchToolContext {
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "of", "to", "in", "on", "at", "for", "with",
  "and", "or", "not", "do", "does", "did", "how", "what", "where", "when", "which", "who", "why", "it", "its", "this",
  "that", "these", "those", "as", "by", "from", "into", "we", "you", "i", "my", "our", "your", "can", "should", "would",
  "managed", "stored", "used",
]);

export async function codebaseSearch(
  input: Record<string, unknown>,
  context: CodebaseSearchToolContext,
): Promise<CodebaseSearchResult> {
  const query = parseQuery(input.query);
  const maxResults = clampInt(input.maxResults, CODEBASE_SEARCH_LIMITS.defaultResults, CODEBASE_SEARCH_LIMITS.maxResults);
  const includeIgnored = input.includeIgnored === true;
  const terms = tokenize(query);

  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  let candidates: CodebaseSearchHit[] = [];

  const walk = await walkWorkspace(
    context.workspacePath,
    async (entry) => {
      if (context.signal?.aborted) {
        return false;
      }
      await scoreFile(entry.absolutePath, entry.relativePath, terms, (hit) => {
        candidates.push(hit);
        if (candidates.length > CODEBASE_SEARCH_LIMITS.candidateBuffer) {
          candidates = trim(candidates);
        }
      });
      return true;
    },
    {
      ...(context.signal ? { signal: context.signal } : {}),
      maxEntries: CODEBASE_SEARCH_LIMITS.maxScannedFiles,
      relativeTo: context.workspacePath,
      includeIgnored,
    },
  );

  if (walk.cancelled) {
    return {
      query,
      terms,
      results: [],
      scannedFiles: walk.scannedFiles,
      cancelled: true,
    };
  }

  const ranked = trim(candidates);
  const truncatedByResults = ranked.length > maxResults;
  return {
    query,
    terms,
    results: truncatedByResults ? ranked.slice(0, maxResults) : ranked,
    scannedFiles: walk.scannedFiles,
    ...(walk.truncated
      ? { truncated: true as const, reason: "max_scanned_files" as const }
      : truncatedByResults
        ? { truncated: true as const, reason: "max_results" as const }
        : {}),
  };
}

async function scoreFile(
  absolutePath: string,
  relativePath: string,
  terms: readonly string[],
  emit: (hit: CodebaseSearchHit) => void,
): Promise<void> {
  // Never scan credential/secret-bearing files.
  if (isSensitiveFilePath(relativePath)) {
    return;
  }
  let buffer: Buffer;
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > SEARCH_LIMITS.grepMaxFileBytes) {
      return;
    }
    buffer = await fs.readFile(absolutePath);
  } catch {
    return;
  }
  if (isProbablyBinary(buffer)) {
    return;
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  const { chunkLines, chunkStride, maxChunksPerFile } = CODEBASE_SEARCH_LIMITS;
  let chunks = 0;

  for (let start = 0; start < lines.length && chunks < maxChunksPerFile; start += chunkStride) {
    const end = Math.min(start + chunkLines, lines.length);
    const text = lines.slice(start, end).join("\n").toLowerCase();
    const matched: string[] = [];
    let occurrences = 0;
    for (const term of terms) {
      const count = countOccurrences(text, term);
      if (count > 0) {
        matched.push(term);
        occurrences += count;
      }
    }
    chunks += 1;
    if (matched.length === 0) {
      continue;
    }
    const coverage = matched.length / terms.length;
    const density = Math.min(1, occurrences / 20);
    const score = Math.round((coverage * 0.8 + density * 0.2) * 100) / 100;
    emit({
      path: relativePath,
      startLine: start + 1,
      endLine: end,
      score,
      matchedTerms: matched,
      reason: `matched: ${matched.join(", ")}`,
    });
  }
}

/** Deterministic ranking: score desc, then path asc, then start line asc. */
function trim(candidates: CodebaseSearchHit[]): CodebaseSearchHit[] {
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine,
  );
  return candidates.slice(0, CODEBASE_SEARCH_LIMITS.candidateBuffer / 2);
}

function parseQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: query.");
  }
  const query = value.trim();
  if (query.length > 500) {
    throw new ToolExecutionError("invalid_input", "query is too long (limit 500 characters).");
  }
  return query;
}

export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9_$]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function clampInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}
