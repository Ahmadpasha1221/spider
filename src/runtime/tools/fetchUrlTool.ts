import { lookup } from "node:dns/promises";
import { ToolExecutionError } from "./toolError";
import { htmlToText } from "./htmlText";
import {
  assertFetchableUrl,
  parseFetchUrl,
  UrlSecurityError,
  type HostResolver,
  type LocalNetworkPolicy,
} from "../net/urlSecurity";

/**
 * `fetch_url`: retrieve one URL the user/model already knows, safely.
 *
 * This is deliberately **not** web search and not a browser: no crawling, no
 * JavaScript, no page execution, no caching. Every request is bounded and the
 * target is validated against the SSRF policy (https for the public web;
 * http(s) loopback for local dev servers; private, link-local and metadata
 * addresses blocked, on the original URL *and* on every redirect).
 * Unsupported binary content is reported as metadata instead of being loaded
 * into model context.
 *
 * Loopback allowance is safe to default on here because `fetch_url` already
 * requires the `external` permission: the user approves each request, and the
 * policy only decides which destinations are approvable. LAN/metadata ranges
 * stay unreachable no matter what.
 */
const LOCAL_NETWORK_POLICY: LocalNetworkPolicy = { allowLocalNetwork: true };
export interface FetchUrlResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly content: string | null;
  readonly truncated?: true;
  readonly unsupported?: true;
  readonly redirects?: number;
  readonly bytes?: number;
  readonly reason?: "http_error" | "unsupported_content" | "truncated";
  readonly message?: string;
}

export interface FetchUrlToolContext {
  readonly signal?: AbortSignal;
}

export interface FetchUrlDeps {
  /** Injectable for tests and alternative hosts. */
  readonly fetchFn?: typeof fetch;
  readonly resolveHost?: HostResolver;
}

export const FETCH_LIMITS = {
  maxRedirects: 5,
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 60_000,
  minTimeoutMs: 1_000,
  defaultMaxBytes: 500_000,
  maxBytesLimit: 2_000_000,
  maxContentChars: 100_000,
} as const;

/** Base content types whose text is safe and useful to hand to the model. */
export const SUPPORTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "text/x-markdown",
  "text/xml",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
]);

const USER_AGENT = "Spider/1.0 (+https://github.com/codevia/codevia-cursor)";

const defaultResolver: HostResolver = async (hostname) => {
  const entries = await lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
};

export async function fetchUrl(
  input: Record<string, unknown>,
  context: FetchUrlToolContext,
  deps: FetchUrlDeps = {},
): Promise<FetchUrlResult> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new ToolExecutionError("dependency_unavailable", "URL fetching is not available in this host.");
  }
  const resolveHost = deps.resolveHost ?? defaultResolver;
  const maxBytes = clampPositive(input.maxBytes, FETCH_LIMITS.defaultMaxBytes, FETCH_LIMITS.maxBytesLimit);
  const timeoutMs = clampPositive(input.timeoutMs, FETCH_LIMITS.defaultTimeoutMs, FETCH_LIMITS.maxTimeoutMs, FETCH_LIMITS.minTimeoutMs);

  let current = mapSecurityError(() => parseFetchUrl(input.url, LOCAL_NETWORK_POLICY));
  let redirects = 0;
  let response: Response;

  for (;;) {
    if (context.signal?.aborted) {
      throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
    }
    await mapSecurityErrorAsync(() => assertFetchableUrl(current, resolveHost, LOCAL_NETWORK_POLICY));

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    context.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchFn(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/*, application/json, application/xml;q=0.9, */*;q=0.1" },
      });
    } catch (error) {
      if (context.signal?.aborted) {
        throw new ToolExecutionError("cancelled", "Tool execution was cancelled.");
      }
      if (isAbortError(error)) {
        throw new ToolExecutionError("timeout", "The request timed out.");
      }
      throw new ToolExecutionError("network_error", "The network request failed.");
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new ToolExecutionError("network_error", "The server sent a redirect without a location.");
      }
      redirects += 1;
      if (redirects > FETCH_LIMITS.maxRedirects) {
        throw new ToolExecutionError("invalid_input", `Too many redirects (maximum ${FETCH_LIMITS.maxRedirects}).`);
      }
      // Validate the redirect target before following it — a public URL must
      // not be able to bounce the agent onto a private address.
      current = mapSecurityError(() => parseFetchUrl(new URL(location, current).href, LOCAL_NETWORK_POLICY));
      continue;
    }
    break;
  }

  const contentType = baseContentType(response.headers.get("content-type"));

  if (response.status >= 400) {
    return {
      url: current.href,
      status: response.status,
      contentType,
      content: null,
      ...(redirects > 0 ? { redirects } : {}),
      reason: "http_error",
      message: `The server returned HTTP ${response.status}.`,
    };
  }

  if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
    return {
      url: current.href,
      status: response.status,
      contentType,
      content: null,
      unsupported: true,
      ...(redirects > 0 ? { redirects } : {}),
      reason: "unsupported_content",
      message: `Content type "${contentType || "unknown"}" is not text and was not downloaded.`,
    };
  }

  const read = await readBounded(response, maxBytes);
  const extracted = contentType === "text/html" || contentType === "application/xhtml+xml"
    ? htmlToText(read.text)
    : read.text;
  const contentTruncated = extracted.length > FETCH_LIMITS.maxContentChars;
  const content = contentTruncated ? extracted.slice(0, FETCH_LIMITS.maxContentChars) : extracted;
  const truncated = read.truncated || contentTruncated;

  return {
    url: current.href,
    status: response.status,
    contentType,
    content,
    ...(redirects > 0 ? { redirects } : {}),
    bytes: read.bytes,
    ...(truncated ? { truncated: true as const, reason: "truncated" as const } : {}),
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function baseContentType(header: string | null): string {
  if (!header) {
    return "";
  }
  return (header.split(";", 1)[0] ?? "").trim().toLowerCase();
}

async function readBounded(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }
        const remaining = maxBytes - size;
        if (value.byteLength >= remaining) {
          chunks.push(value.subarray(0, Math.max(0, remaining)));
          size += Math.max(0, remaining);
          truncated = true;
          break;
        }
        chunks.push(value);
        size += value.byteLength;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Cancelling a fully-drained reader throws in some runtimes; ignore.
      }
    }
    return { text: decode(chunks, size), truncated, bytes: size };
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const truncated = buffer.byteLength > maxBytes;
  const bytes = truncated ? buffer.subarray(0, maxBytes) : buffer;
  return { text: decode([bytes], bytes.byteLength), truncated, bytes: bytes.byteLength };
}

function decode(chunks: readonly Uint8Array[], totalLength: number): string {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function clampPositive(value: unknown, fallback: number, max: number, min = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Maps the URL policy's typed rejection onto a model-safe tool error code. */
function toToolError(error: UrlSecurityError): ToolExecutionError {
  switch (error.reason) {
    case "blocked_host":
    case "blocked_address":
      return new ToolExecutionError("security_rejected", error.message);
    case "dns_failure":
      return new ToolExecutionError("network_error", error.message);
    case "unsupported_scheme":
    case "credentials_not_allowed":
    case "invalid_url":
    default:
      return new ToolExecutionError("invalid_input", error.message);
  }
}

function mapSecurityError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UrlSecurityError) {
      throw toToolError(error);
    }
    throw error;
  }
}

async function mapSecurityErrorAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UrlSecurityError) {
      throw toToolError(error);
    }
    throw error;
  }
}
