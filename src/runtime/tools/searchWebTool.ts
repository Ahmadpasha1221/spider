import { ToolExecutionError } from "./toolError";
import {
  WEB_SEARCH_LIMITS,
  WebSearchProviderError,
  type WebSearchProvider,
  type WebSearchResult,
} from "../net/webSearchProvider";

/**
 * `search_web`: discover URLs for a query. This is a thin adapter over an
 * injected `WebSearchProvider`; it contains no provider-specific logic and
 * never retrieves full pages (that is `fetch_url`'s job).
 *
 * Search results are untrusted external data. They are returned as plain data
 * for the model to read; nothing in them can change permissions, tool
 * definitions, credentials, or configuration.
 */
export interface SearchWebToolContext {
  readonly signal?: AbortSignal;
}

export interface SearchWebDeps {
  readonly provider?: WebSearchProvider;
}

export interface SearchWebToolResult {
  readonly query: string;
  readonly results: readonly WebSearchResult[];
  readonly truncated?: true;
  readonly reason?: "max_results";
  readonly provider?: string;
  readonly message?: string;
}

export async function searchWeb(
  input: Record<string, unknown>,
  context: SearchWebToolContext,
  deps: SearchWebDeps,
): Promise<SearchWebToolResult> {
  const query = parseQuery(input.query);
  const maxResults = clampInt(input.maxResults, WEB_SEARCH_LIMITS.defaultResults, WEB_SEARCH_LIMITS.maxResults);
  const recencyDays = parseRecencyDays(input.recencyDays);

  if (context.signal?.aborted) {
    throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
  }

  const provider = deps.provider;
  if (!provider) {
    throw new ToolExecutionError("dependency_unavailable", "Web search is not configured in this host.");
  }

  let results: readonly WebSearchResult[];
  try {
    results = await provider.search({
      query,
      maxResults,
      ...(recencyDays !== undefined ? { recencyDays } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } catch (error) {
    throw toToolError(error);
  }

  // Dedupe by URL, preserving provider order, and enforce the result cap.
  const seen = new Set<string>();
  const sanitized: WebSearchResult[] = [];
  for (const result of results) {
    if (typeof result?.url !== "string" || result.url.length === 0 || seen.has(result.url)) {
      continue;
    }
    seen.add(result.url);
    sanitized.push({
      title: sanitize(result.title, WEB_SEARCH_LIMITS.maxTitleLength),
      url: result.url,
      snippet: sanitize(result.snippet, WEB_SEARCH_LIMITS.maxSnippetLength),
      ...(result.source ? { source: sanitize(result.source, WEB_SEARCH_LIMITS.maxTitleLength) } : {}),
    });
  }

  const truncated = sanitized.length > maxResults;
  return {
    query,
    results: truncated ? sanitized.slice(0, maxResults) : sanitized,
    provider: provider.id,
    ...(truncated ? { truncated: true as const, reason: "max_results" as const } : {}),
  };
}

function parseQuery(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError("invalid_input", "Missing required argument: query.");
  }
  const query = value.trim();
  if (query.length > WEB_SEARCH_LIMITS.maxQueryLength) {
    throw new ToolExecutionError(
      "invalid_input",
      `query cannot exceed ${WEB_SEARCH_LIMITS.maxQueryLength} characters.`,
    );
  }
  return query;
}

function parseRecencyDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError("invalid_input", "recencyDays must be a number.");
  }
  const days = Math.floor(value);
  if (days < 1) {
    throw new ToolExecutionError("invalid_input", "recencyDays must be at least 1.");
  }
  return Math.min(days, WEB_SEARCH_LIMITS.maxRecencyDays);
}

function clampInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function sanitize(value: string, max: number): string {
  const single = String(value ?? "").replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function toToolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) {
    return error;
  }
  if (error instanceof WebSearchProviderError) {
    switch (error.code) {
      case "not_configured":
        return new ToolExecutionError("dependency_unavailable", error.message);
      case "cancelled":
        return new ToolExecutionError("cancelled", error.message);
      case "timeout":
        return new ToolExecutionError("timeout", error.message);
      case "network_error":
        return new ToolExecutionError("network_error", error.message);
      case "provider_error":
      default:
        return new ToolExecutionError("internal_error", error.message);
    }
  }
  return new ToolExecutionError("internal_error", "The web search failed.");
}
