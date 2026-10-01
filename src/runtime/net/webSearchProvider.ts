import type { SecretStorage } from "../../auth/secretStorage";
import { readSecret } from "../../shared/storageKeys";

/**
 * Web-search provider abstraction.
 *
 * `search_web` discovers URLs; `fetch_url` retrieves a known URL. They stay
 * separate capabilities. This module is the only place that knows about a
 * concrete search backend, so the tool never contains provider details and
 * switching providers never touches the registry or the executor.
 *
 * Credentials are read from SecretStorage on demand (never stored in the
 * webview, transcripts, workspace files, or logs) and only the sanitized result
 * fields leave the provider.
 */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source?: string;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults: number;
  /** Restrict to results from the last N days when the provider supports it. */
  readonly recencyDays?: number;
  readonly signal?: AbortSignal;
}

export interface WebSearchProvider {
  readonly id: string;
  search(request: WebSearchRequest): Promise<readonly WebSearchResult[]>;
}

export type WebSearchErrorCode = "not_configured" | "cancelled" | "timeout" | "network_error" | "provider_error";

export class WebSearchProviderError extends Error {
  readonly code: WebSearchErrorCode;

  constructor(code: WebSearchErrorCode, message: string) {
    super(message);
    this.name = "WebSearchProviderError";
    this.code = code;
  }
}

export const WEB_SEARCH_LIMITS = {
  defaultResults: 5,
  maxResults: 20,
  maxQueryLength: 400,
  maxSnippetLength: 400,
  maxTitleLength: 200,
  timeoutMs: 15_000,
  maxResponseBytes: 1_000_000,
  /** Only the last month is meaningfully supported by most providers. */
  maxRecencyDays: 3650,
} as const;

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface StoredWebSearchProviderOptions {
  readonly secretStorage: SecretStorage;
  /** SecretStorage key holding the provider API key. */
  readonly secretKey: string;
  /** Pre-rename key read as a fallback (see shared/storageKeys.ts). */
  readonly legacySecretKey?: string;
  /** Injectable for tests and alternative hosts. */
  readonly fetchFn?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly id?: string;
}

/**
 * A provider backed by a stored API key. It resolves the credential lazily on
 * every call, so rotating or removing the key takes effect immediately and no
 * secret is ever held in a long-lived field or logged.
 */
export function createStoredWebSearchProvider(options: StoredWebSearchProviderOptions): WebSearchProvider {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_LIMITS.timeoutMs;

  return {
    id: options.id ?? "stored",
    async search(request) {
      const apiKey = options.legacySecretKey
        ? await readSecret(options.secretStorage, {
            current: options.secretKey,
            legacy: options.legacySecretKey,
          })
        : await options.secretStorage.get(options.secretKey);
      if (!apiKey || apiKey.trim().length === 0) {
        throw new WebSearchProviderError("not_configured", "No web search API key is configured.");
      }
      const fetchFn = options.fetchFn ?? globalThis.fetch;
      if (typeof fetchFn !== "function") {
        throw new WebSearchProviderError("not_configured", "Web search is not available in this host.");
      }

      const url = new URL(endpoint);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.maxResults));
      if (request.recencyDays !== undefined) {
        url.searchParams.set("freshness", toFreshness(request.recencyDays));
      }

      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "x-subscription-token": apiKey,
            "user-agent": "Spider/1.0",
          },
        });
        if (!response.ok) {
          throw new WebSearchProviderError("provider_error", `The search provider returned HTTP ${response.status}.`);
        }
        const body = await readCapped(response, WEB_SEARCH_LIMITS.maxResponseBytes);
        return parseWebSearchResponse(body, hostLabel(url));
      } catch (error) {
        if (error instanceof WebSearchProviderError) {
          throw error;
        }
        if (request.signal?.aborted) {
          throw new WebSearchProviderError("cancelled", "The search request was cancelled.");
        }
        if (isAbortError(error)) {
          throw new WebSearchProviderError("timeout", "The search request timed out.");
        }
        throw new WebSearchProviderError("network_error", "The search request failed.");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Normalizes a provider response (Brave-style `{ web: { results } }` or a plain
 * `{ results }`) into sanitized results. Untrusted provider text is truncated
 * here and never interpreted as anything but data.
 */
export function parseWebSearchResponse(body: string, defaultSource?: string): WebSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WebSearchProviderError("provider_error", "The search provider returned an unreadable response.");
  }

  const record = asRecord(parsed);
  const web = asRecord(record?.web);
  const rawResults = Array.isArray(web?.results)
    ? web.results
    : Array.isArray(record?.results)
      ? record.results
      : [];

  const results: WebSearchResult[] = [];
  for (const entry of rawResults) {
    const item = asRecord(entry);
    if (!item) {
      continue;
    }
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (url.length === 0) {
      continue;
    }
    const title = truncate(typeof item.title === "string" ? item.title : url, WEB_SEARCH_LIMITS.maxTitleLength);
    const snippet = truncate(
      typeof item.description === "string" ? item.description : typeof item.snippet === "string" ? item.snippet : "",
      WEB_SEARCH_LIMITS.maxSnippetLength,
    );
    const source = hostOf(url) ?? defaultSource ?? "";
    results.push({ title, url, snippet, source });
  }
  return results;
}

function toFreshness(days: number): string {
  if (days <= 1) return "pd";
  if (days <= 7) return "pw";
  if (days <= 31) return "pm";
  if (days <= 365) return "py";
  return "py";
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

function hostLabel(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/** Hostname of an absolute URL, or undefined when it is not absolute. */
function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return hostLabel(url).length > 0 ? hostLabel(url) : undefined;
  } catch {
    return undefined;
  }
}

function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
