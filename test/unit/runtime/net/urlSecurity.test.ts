import { describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  isBlockedHostname,
  isPrivateAddress,
  normalizeHostname,
  parseFetchUrl,
  UrlSecurityError,
  type HostResolver,
} from "../../../../src/runtime/net/urlSecurity";

const publicResolver: HostResolver = async () => ["93.184.216.34"];
const privateResolver: HostResolver = async () => ["10.0.0.5"];

describe("parseFetchUrl", () => {
  it("accepts an absolute https URL", () => {
    expect(parseFetchUrl("https://example.com/a?b=1").hostname).toBe("example.com");
  });

  it("rejects non-https schemes", () => {
    for (const raw of ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://x"]) {
      expect(() => parseFetchUrl(raw)).toThrowError(UrlSecurityError);
    }
    try {
      parseFetchUrl("http://example.com");
    } catch (error) {
      expect((error as UrlSecurityError).reason).toBe("unsupported_scheme");
    }
  });

  it("rejects malformed and relative URLs and embedded credentials", () => {
    expect(() => parseFetchUrl("not a url")).toThrowError(UrlSecurityError);
    expect(() => parseFetchUrl(42)).toThrowError(UrlSecurityError);
    try {
      parseFetchUrl("https://user:pass@example.com");
    } catch (error) {
      expect((error as UrlSecurityError).reason).toBe("credentials_not_allowed");
    }
  });
});

describe("normalizeHostname", () => {
  it("strips IPv6 brackets and zone ids and lowercases", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
    expect(normalizeHostname("Example.COM")).toBe("example.com");
    expect(normalizeHostname("fe80::1%eth0")).toBe("fe80::1");
  });
});

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local, CGNAT and reserved IPv4", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.32.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("flags private IPv6 forms and mapped IPv4", () => {
    for (const address of ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks local/internal names and private literals", () => {
    for (const host of ["localhost", "foo.localhost", "metadata.google.internal", "service.internal", "printer.local", "127.0.0.1", "[::1]"]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("8.8.8.8")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("allows a public hostname", async () => {
    await expect(assertPublicUrl(new URL("https://example.com"), publicResolver)).resolves.toBeUndefined();
  });

  it("rejects a private literal address", async () => {
    await expect(assertPublicUrl(new URL("https://127.0.0.1"), publicResolver)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(assertPublicUrl(new URL("https://evil.example.com"), privateResolver)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("rejects blocked hostnames without resolving", async () => {
    await expect(assertPublicUrl(new URL("https://localhost"), publicResolver)).rejects.toMatchObject({
      reason: "blocked_host",
    });
  });

  it("maps a DNS failure to a typed reason", async () => {
    const failing: HostResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicUrl(new URL("https://nope.example.com"), failing)).rejects.toMatchObject({
      reason: "dns_failure",
    });
    const empty: HostResolver = async () => [];
    await expect(assertPublicUrl(new URL("https://empty.example.com"), empty)).rejects.toMatchObject({
      reason: "dns_failure",
    });
  });
});
