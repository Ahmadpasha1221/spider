import { describe, expect, it, vi } from "vitest";
import { searchWeb } from "../../../../src/runtime/tools/searchWebTool";
import {
  WEB_SEARCH_LIMITS,
  WebSearchProviderError,
  type WebSearchProvider,
  type WebSearchResult,
} from "../../../../src/runtime/net/webSearchProvider";

function providerReturning(results: WebSearchResult[]): WebSearchProvider {
  return { id: "fake", search: async () => results };
}

const SAMPLE: WebSearchResult[] = [
  { title: "Docs", url: "https://example.com/docs", snippet: "Usage guide" },
  { title: "Reference", url: "https://example.com/ref", snippet: "API reference" },
];

describe("search_web", () => {
  it("is unavailable when no provider is configured", async () => {
    await expect(searchWeb({ query: "x" }, {}, {})).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("validates the query", async () => {
    const provider = providerReturning([]);
    await expect(searchWeb({}, {}, { provider })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      searchWeb({ query: "x".repeat(WEB_SEARCH_LIMITS.maxQueryLength + 1) }, {}, { provider }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns sanitized results with the provider id", async () => {
    const response = await searchWeb({ query: "abort controller" }, {}, { provider: providerReturning(SAMPLE) });
    expect(response).toMatchObject({ query: "abort controller", provider: "fake" });
    expect(response.results).toEqual(SAMPLE);
    expect(response.truncated).toBeUndefined();
  });

  it("caps results and reports truncation", async () => {
    const many = Array.from({ length: 8 }, (_v, i) => ({ title: `T${i}`, url: `https://example.com/${i}`, snippet: "" }));
    const response = await searchWeb({ query: "x", maxResults: 3 }, {}, { provider: providerReturning(many) });
    expect(response.results).toHaveLength(3);
    expect(response.truncated).toBe(true);
    expect(response.reason).toBe("max_results");
  });

  it("deduplicates results by url", async () => {
    const dupes = [SAMPLE[0]!, SAMPLE[0]!, SAMPLE[1]!];
    const response = await searchWeb({ query: "x" }, {}, { provider: providerReturning(dupes) });
    expect(response.results.map((result) => result.url)).toEqual([SAMPLE[0]!.url, SAMPLE[1]!.url]);
  });

  it("clamps maxResults and recencyDays", async () => {
    const search = vi.fn(async () => SAMPLE);
    const provider: WebSearchProvider = { id: "fake", search };
    await searchWeb({ query: "x", maxResults: 999, recencyDays: 999_999 }, {}, { provider });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ maxResults: WEB_SEARCH_LIMITS.maxResults, recencyDays: WEB_SEARCH_LIMITS.maxRecencyDays }));

    await expect(searchWeb({ query: "x", recencyDays: 0 }, {}, { provider })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps provider failures onto typed tool errors", async () => {
    const failing = (code: ConstructorParameters<typeof WebSearchProviderError>[0]) =>
      ({ id: "fake", search: async () => { throw new WebSearchProviderError(code, "boom"); } }) as WebSearchProvider;

    await expect(searchWeb({ query: "x" }, {}, { provider: failing("not_configured") })).rejects.toMatchObject({ code: "dependency_unavailable" });
    await expect(searchWeb({ query: "x" }, {}, { provider: failing("timeout") })).rejects.toMatchObject({ code: "timeout" });
    await expect(searchWeb({ query: "x" }, {}, { provider: failing("network_error") })).rejects.toMatchObject({ code: "network_error" });
    await expect(searchWeb({ query: "x" }, {}, { provider: failing("provider_error") })).rejects.toMatchObject({ code: "internal_error" });
  });

  it("maps a cancellation error to cancelled", async () => {
    const provider: WebSearchProvider = {
      id: "fake",
      search: async () => {
        throw new WebSearchProviderError("cancelled", "cancelled");
      },
    };
    await expect(searchWeb({ query: "x" }, {}, { provider })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never calls the provider once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const search = vi.fn(async () => SAMPLE);
    await expect(searchWeb({ query: "x" }, { signal: controller.signal }, { provider: { id: "fake", search } })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(search).not.toHaveBeenCalled();
  });
});
