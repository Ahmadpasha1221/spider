import { describe, expect, it, vi } from "vitest";
import {
  createStoredWebSearchProvider,
  parseWebSearchResponse,
  WEB_SEARCH_LIMITS,
  WebSearchProviderError,
} from "../../../../src/runtime/net/webSearchProvider";
import type { SecretStorage } from "../../../../src/auth/secretStorage";

function storageFor(key: string, value?: string): SecretStorage {
  return {
    get: async (requested) => (requested === key ? value : undefined),
    store: async () => undefined,
    delete: async () => undefined,
  };
}

const KEY = "codeviaCursor.webSearch.apiKey";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parseWebSearchResponse", () => {
  it("parses the Brave-style shape", () => {
    const results = parseWebSearchResponse(
      JSON.stringify({ web: { results: [{ title: "Docs", url: "https://example.com/docs", description: "Usage" }] } }),
    );
    expect(results).toEqual([{ title: "Docs", url: "https://example.com/docs", snippet: "Usage", source: "example.com" }]);
  });

  it("parses a plain results array and strips www", () => {
    const results = parseWebSearchResponse(
      JSON.stringify({ results: [{ title: "A", url: "https://www.example.org/a", snippet: "x" }] }),
    );
    expect(results[0]).toMatchObject({ source: "example.org" });
  });

  it("truncates untrusted text and skips entries without a url", () => {
    const long = "x".repeat(WEB_SEARCH_LIMITS.maxTitleLength + 50);
    const results = parseWebSearchResponse(
      JSON.stringify({ web: { results: [{ title: long, url: "https://example.com" }, { title: "no url" }] } }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.title.length).toBeLessThanOrEqual(WEB_SEARCH_LIMITS.maxTitleLength);
    expect(results[0]!.title.endsWith("…")).toBe(true);
  });

  it("rejects unreadable responses", () => {
    expect(() => parseWebSearchResponse("<html>not json</html>")).toThrowError(WebSearchProviderError);
  });
});

describe("createStoredWebSearchProvider", () => {
  it("returns not_configured when no key is stored", async () => {
    const provider = createStoredWebSearchProvider({ secretStorage: storageFor(KEY), secretKey: KEY });
    await expect(provider.search({ query: "x", maxResults: 5 })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("sends the stored key and bounded query parameters", async () => {
    const captured: { url: URL; headers: Record<string, string> }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse({ web: { results: [{ title: "T", url: "https://example.com", description: "D" }] } });
    }) as typeof fetch;

    const provider = createStoredWebSearchProvider({
      secretStorage: storageFor(KEY, "secret-key"),
      secretKey: KEY,
      fetchFn,
      endpoint: "https://search.example.com/v1",
    });
    const results = await provider.search({ query: "hello world", maxResults: 3, recencyDays: 7 });

    expect(results).toHaveLength(1);
    expect(captured[0]?.url.searchParams.get("q")).toBe("hello world");
    expect(captured[0]?.url.searchParams.get("count")).toBe("3");
    expect(captured[0]?.url.searchParams.get("freshness")).toBe("pw");
    expect(captured[0]?.headers["x-subscription-token"]).toBe("secret-key");
  });

  it("maps an HTTP error, timeout and network failure", async () => {
    const http500 = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const provider500 = createStoredWebSearchProvider({ secretStorage: storageFor(KEY, "k"), secretKey: KEY, fetchFn: http500 });
    await expect(provider500.search({ query: "x", maxResults: 1 })).rejects.toMatchObject({ code: "provider_error" });

    const aborting = (() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }) as unknown as typeof fetch;
    const providerTimeout = createStoredWebSearchProvider({ secretStorage: storageFor(KEY, "k"), secretKey: KEY, fetchFn: aborting });
    await expect(providerTimeout.search({ query: "x", maxResults: 1 })).rejects.toMatchObject({ code: "timeout" });

    const failing = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    const providerNet = createStoredWebSearchProvider({ secretStorage: storageFor(KEY, "k"), secretKey: KEY, fetchFn: failing });
    await expect(providerNet.search({ query: "x", maxResults: 1 })).rejects.toMatchObject({ code: "network_error" });
  });

  it("reports cancellation when the request signal aborts", async () => {
    const controller = new AbortController();
    const fetchFn = (() => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }) as unknown as typeof fetch;
    const provider = createStoredWebSearchProvider({ secretStorage: storageFor(KEY, "k"), secretKey: KEY, fetchFn });
    await expect(
      provider.search({ query: "x", maxResults: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never logs or returns the credential", async () => {
    const seen: string[] = [];
    const fetchFn = (async () => {
      seen.push("called");
      return jsonResponse({ web: { results: [] } });
    }) as typeof fetch;
    const provider = createStoredWebSearchProvider({ secretStorage: storageFor(KEY, "super-secret"), secretKey: KEY, fetchFn });
    const results = await provider.search({ query: "x", maxResults: 1 });
    expect(JSON.stringify(results)).not.toContain("super-secret");
    expect(seen).toEqual(["called"]);
    vi.restoreAllMocks();
  });
});
