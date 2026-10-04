import { describe, expect, it } from "vitest";
import {
  assertFetchableUrl,
  isLoopbackAddress,
  isLoopbackHostname,
  parseFetchUrl,
  UrlSecurityError,
} from "../../../../src/runtime/net/urlSecurity";

const loopbackResolver = async () => ["127.0.0.1"];
const publicResolver = async () => ["93.184.216.34"];
const privateResolver = async () => ["192.168.1.10"];

async function reason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return (error as UrlSecurityError).reason;
  }
  return "allowed";
}

describe("local network policy", () => {
  it("keeps the default policy strict: http rejected at parse, loopback blocked", async () => {
    expect(() => parseFetchUrl("http://localhost:3000")).toThrowError(UrlSecurityError);
    await expect(reason(() => assertFetchableUrl(new URL("https://localhost"), loopbackResolver, {}))).resolves.toBe(
      "blocked_host",
    );
  });

  it("allows http(s) loopback literals under the local policy", async () => {
    const policy = { allowLocalNetwork: true };
    expect(parseFetchUrl("http://localhost:3000", policy).hostname).toBe("localhost");
    expect(parseFetchUrl("http://127.0.0.1:8080/api", policy).hostname).toBe("127.0.0.1");
    expect(parseFetchUrl("http://[::1]:3000/", policy).hostname).toBe("[::1]");
    expect(await reason(() => assertFetchableUrl(new URL("http://localhost:3000/"), loopbackResolver, policy))).toBe(
      "allowed",
    );
    expect(await reason(() => assertFetchableUrl(new URL("http://127.0.0.1:3000/"), loopbackResolver, policy))).toBe(
      "allowed",
    );
    expect(await reason(() => assertFetchableUrl(new URL("http://[::1]:3000/"), loopbackResolver, policy))).toBe(
      "allowed",
    );
    expect(await reason(() => assertFetchableUrl(new URL("https://localhost/"), loopbackResolver, policy))).toBe(
      "allowed",
    );
  });

  it("still blocks LAN, metadata and public-http under the local policy", async () => {
    const policy = { allowLocalNetwork: true };
    expect(await reason(() => assertFetchableUrl(new URL("http://192.168.1.10/"), loopbackResolver, policy))).toBe(
      "blocked_address",
    );
    expect(await reason(() => assertFetchableUrl(new URL("http://169.254.169.254/"), loopbackResolver, policy))).toBe(
      "blocked_address",
    );
    expect(await reason(() => assertFetchableUrl(new URL("https://internal.example/"), privateResolver, policy))).toBe(
      "blocked_address",
    );
    expect(await reason(() => assertFetchableUrl(new URL("http://93.184.216.34/"), publicResolver, policy))).toBe(
      "unsupported_scheme",
    );
    expect(await reason(() => assertFetchableUrl(new URL("https://example.com/"), publicResolver, policy))).toBe(
      "allowed",
    );
  });

  it("classifies loopback hosts and addresses", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("foo.localhost")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.12.34.56")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
  });
});
