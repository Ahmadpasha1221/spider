import { describe, expect, it, vi } from "vitest";
import { fetchUrl, FETCH_LIMITS, type FetchUrlResult } from "../../../../src/runtime/tools/fetchUrlTool";
import type { HostResolver } from "../../../../src/runtime/net/urlSecurity";

const publicResolver: HostResolver = async () => ["93.184.216.34"];

function fetchWith(
  response: Response | ((url: string, init?: RequestInit) => Response | Promise<Response>),
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return typeof response === "function" ? response(url, init) : response;
  }) as typeof fetch;
}

function run(
  input: Record<string, unknown>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  deps?: { resolveHost?: HostResolver; allowLocalNetwork?: boolean },
): Promise<FetchUrlResult> {
  return fetchUrl(input, { ...(signal ? { signal } : {}) }, { fetchFn, resolveHost: deps?.resolveHost ?? publicResolver, ...(deps?.allowLocalNetwork ? { allowLocalNetwork: true as const } : {}) });
}

function runLocal(input: Record<string, unknown>, fetchFn: typeof fetch): Promise<FetchUrlResult> {
  return fetchUrl(input, {}, { fetchFn, resolveHost: publicResolver, allowLocalNetwork: true });
}

describe("fetch_url", () => {
  it("retrieves JSON and reports status/content type", async () => {
    const fetchFn = fetchWith(new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    const result = await run({ url: "https://api.example.com/data" }, fetchFn);

    expect(result).toMatchObject({ status: 200, contentType: "application/json", content: '{"ok":true}' });
    expect(result.truncated).toBeUndefined();
  });

  it("extracts readable text from HTML without running scripts", async () => {
    const html = "<html><body><h1>Hello &amp; welcome</h1><script>alert(1)</script><p>Body text</p></body></html>";
    const fetchFn = fetchWith(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    const result = await run({ url: "https://example.com/page" }, fetchFn);

    expect(result.content).toContain("Hello & welcome");
    expect(result.content).toContain("Body text");
    expect(result.content).not.toContain("alert");
    expect(result.content).not.toContain("<");
  });

  it("returns plain text directly", async () => {
    const fetchFn = fetchWith(new Response("line one\nline two", { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await run({ url: "https://example.com/file.txt" }, fetchFn);
    expect(result.content).toBe("line one\nline two");
  });

  it("rejects an invalid URL and non-https schemes", async () => {
    const fetchFn = fetchWith(new Response(""));
    await expect(run({ url: "not a url" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run({ url: "http://example.com" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run({ url: "file:///etc/passwd" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run({ url: "https://user:pass@example.com" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("denies loopback by default and discloses it under the opt-in", async () => {
    // Fresh body per request: a Response stream can only be read once.
    const fetchFn = fetchWith(() => new Response("secret", { headers: { "content-type": "text/plain" } }));
    // Default: loopback blocked even though the tool's external permission
    // would gate each request.
    await expect(run({ url: "https://localhost/admin" }, fetchFn)).rejects.toMatchObject({ code: "security_rejected" });
    await expect(run({ url: "https://127.0.0.1/" }, fetchFn)).rejects.toMatchObject({ code: "security_rejected" });
    await expect(run({ url: "http://localhost:3000/status" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
    // Opt-in (spider.fetch.allowLocalNetwork): local dev servers reachable,
    // with a user-visible loopback disclosure on the result.
    await expect(runLocal({ url: "https://localhost/admin" }, fetchFn)).resolves.toMatchObject({
      content: "secret",
      destination: "loopback",
      notice: expect.stringContaining("destination: loopback"),
    });
    await expect(runLocal({ url: "https://127.0.0.1/" }, fetchFn)).resolves.toMatchObject({
      content: "secret",
      destination: "loopback",
    });
    await expect(runLocal({ url: "http://localhost:3000/status" }, fetchFn)).resolves.toMatchObject({
      content: "secret",
      destination: "loopback",
      notice: expect.stringContaining("destination: loopback"),
    });
    // Private, link-local and metadata ranges stay unreachable either way.
    await expect(runLocal({ url: "https://192.168.1.10/" }, fetchFn)).rejects.toMatchObject({ code: "security_rejected" });
    await expect(run({ url: "https://169.254.169.254/latest/meta-data/" }, fetchFn)).rejects.toMatchObject({
      code: "security_rejected",
    });
    await expect(run({ url: "https://metadata.google.internal/" }, fetchFn)).rejects.toMatchObject({
      code: "security_rejected",
    });
    // Plain http outside loopback is still rejected.
    await expect(run({ url: "http://example.com/" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("blocks a hostname that resolves to a private address", async () => {
    const fetchFn = fetchWith(new Response("secret"));
    const resolveHost: HostResolver = async () => ["10.0.0.5"];
    await expect(
      fetchUrl({ url: "https://evil.example.com" }, {}, { fetchFn, resolveHost }),
    ).rejects.toMatchObject({ code: "security_rejected" });
  });

  it("follows public redirects and reports the final URL", async () => {
    let calls = 0;
    const fetchFn = fetchWith(() => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/final" } })
        : new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await run({ url: "https://example.com/start" }, fetchFn);

    expect(result.url).toBe("https://cdn.example.com/final");
    expect(result.redirects).toBe(1);
    expect(result.content).toBe("done");
  });

  it("rejects a redirect that targets a private address", async () => {
    const fetchFn = fetchWith(new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }));
    await expect(run({ url: "https://example.com/start" }, fetchFn)).rejects.toMatchObject({
      code: "security_rejected",
    });
  });

  it("marks public destinations without a loopback notice", async () => {
    const fetchFn = fetchWith(new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await run({ url: "https://example.com/page" }, fetchFn);
    expect(result).toMatchObject({ destination: "public", content: "hello" });
    expect(result.notice).toBeUndefined();
  });

  it("rejects a loopback redirect by default, discloses it under the opt-in", async () => {
    const redirectToLoopback = (): typeof fetch => {
      let calls = 0;
      return fetchWith(() => {
        calls += 1;
        return calls === 1
          ? new Response(null, { status: 302, headers: { location: "http://localhost:3000/final" } })
          : new Response("local", { status: 200, headers: { "content-type": "text/plain" } });
      });
    };
    await expect(run({ url: "https://example.com/start" }, redirectToLoopback())).rejects.toMatchObject({
      code: "invalid_input",
    });
    const result = await runLocal({ url: "https://example.com/start" }, redirectToLoopback());
    expect(result.url).toBe("http://localhost:3000/final");
    expect(result.content).toBe("local");
    expect(result).toMatchObject({ destination: "loopback", notice: expect.stringContaining("destination: loopback") });
  });

  it("re-resolves DNS on every redirect hop", async () => {
    const seen: string[] = [];
    const resolveHost: HostResolver = async (hostname) => {
      seen.push(hostname);
      return ["93.184.216.34"];
    };
    let calls = 0;
    const fetchFn = fetchWith(() => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/final" } })
        : new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await fetchUrl({ url: "https://example.com/start" }, {}, { fetchFn, resolveHost });
    expect(result.content).toBe("done");
    // Per-hop re-resolution: original + redirect target, plus the final
    // destination disclosure re-resolution.
    expect(seen).toEqual(["example.com", "cdn.example.com", "cdn.example.com"]);
  });

  it("rejects a redirect loop after the maximum", async () => {
    const fetchFn = fetchWith((url) => new Response(null, { status: 302, headers: { location: `${url}?next` } }));
    await expect(run({ url: "https://example.com/start" }, fetchFn)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("treats redirects without a location as a network error", async () => {
    const fetchFn = fetchWith(new Response(null, { status: 302 }));
    await expect(run({ url: "https://example.com/start" }, fetchFn)).rejects.toMatchObject({ code: "network_error" });
  });

  it("reports an HTTP error as structured data", async () => {
    const fetchFn = fetchWith(new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }));
    const result = await run({ url: "https://example.com/missing" }, fetchFn);
    expect(result).toMatchObject({ status: 404, reason: "http_error", content: null });
  });

  it("reports unsupported binary content without downloading it", async () => {
    const fetchFn = fetchWith(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "application/pdf" } }));
    const result = await run({ url: "https://example.com/file.pdf" }, fetchFn);
    expect(result).toMatchObject({ status: 200, contentType: "application/pdf", unsupported: true, content: null, reason: "unsupported_content" });
  });

  it("bounds the response size and reports truncation", async () => {
    const fetchFn = fetchWith(new Response("0123456789ABCDEF", { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await run({ url: "https://example.com/big", maxBytes: 10 }, fetchFn);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(10);
    expect(result.content).toBe("0123456789");
  });

  it("caps maxBytes at the configured limit", async () => {
    const large = "x".repeat(FETCH_LIMITS.maxBytesLimit + 100);
    const fetchFn = fetchWith(new Response(large, { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await run({ url: "https://example.com/huge", maxBytes: 999_999_999 }, fetchFn);
    expect(result.bytes).toBe(FETCH_LIMITS.maxBytesLimit);
    expect(result.truncated).toBe(true);
  });

  it("maps a timeout to a typed error", async () => {
    const fetchFn = (() => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }) as unknown as typeof fetch;
    await expect(run({ url: "https://example.com/slow" }, fetchFn)).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps a network failure to a typed error", async () => {
    const fetchFn = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await expect(run({ url: "https://example.com/down" }, fetchFn)).rejects.toMatchObject({ code: "network_error" });
  });

  it("is cancellable and never issues a request once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const inner = vi.fn(async () => new Response("x"));
    const fetchFn = inner as unknown as typeof fetch;
    await expect(run({ url: "https://example.com/" }, fetchFn, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(inner).not.toHaveBeenCalled();
  });
});
