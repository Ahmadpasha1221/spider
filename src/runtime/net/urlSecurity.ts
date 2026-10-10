import { isIP } from "node:net";

/**
 * SSRF-safe URL rules for `fetch_url`.
 *
 * The extension runs on a developer machine, so a URL-fetch tool is a network
 * capability with real risk: it must never be usable to reach the loopback
 * interface, private/LAN ranges, link-local addresses, or cloud metadata
 * endpoints. Rules are enforced on the original URL **and on every redirect
 * target**, and DNS is resolved before each request so a hostname cannot smuggle
 * a private address past the literal check.
 *
 * This module is pure (no `vscode`, no I/O beyond an injected resolver), so the
 * policy is fully unit-testable.
 */
export type UrlRejectionReason =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_not_allowed"
  | "blocked_host"
  | "blocked_address"
  | "dns_failure";

export class UrlSecurityError extends Error {
  readonly reason: UrlRejectionReason;

  constructor(reason: UrlRejectionReason, message: string) {
    super(message);
    this.name = "UrlSecurityError";
    this.reason = reason;
  }
}

/** Only HTTPS: http/file/data/javascript/ftp etc. are rejected outright. */
export const ALLOWED_PROTOCOLS: readonly string[] = ["https:"];

/**
 * Local-network policy for `fetch_url`. Loopback access (the developer's own
 * machine: `localhost`, `127.0.0.0/8`, `::1`) is a separate question from
 * public-web access. Loopback is **denied by default**; when
 * `allowLocalNetwork` is explicitly set to `true` (opt-in via the
 * `spider.fetch.allowLocalNetwork` setting, default `false`), loopback
 * destinations are reachable over `http:` or `https:` — the common case is a
 * local dev server (`http://localhost:3000`). Everything else (LAN ranges,
 * link-local, cloud metadata, DNS that resolves non-loopback) stays blocked
 * exactly as before. Loopback still requires the tool's `external`
 * permission, so the user approves the request; this policy only decides what
 * the user *can* approve.
 */
export interface LocalNetworkPolicy {
  readonly allowLocalNetwork?: boolean;
}

/** Loopback hostnames that need no DNS lookup (the OS guarantees them). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost"]);

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** Hostnames that must never be contacted regardless of what DNS says. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

const BLOCKED_HOST_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".home.arpa"];

export function parseFetchUrl(raw: unknown, policy: LocalNetworkPolicy = {}): URL {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new UrlSecurityError("invalid_url", "A non-empty url string is required.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlSecurityError("invalid_url", "That is not a valid absolute URL.");
  }
  // Plain http reaches the parser only for loopback under an explicit local
  // policy; the destination check in assertFetchableUrl enforces that.
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && policy.allowLocalNetwork === true);
  if (!schemeOk) {
    throw new UrlSecurityError(
      "unsupported_scheme",
      url.protocol === "http:"
        ? "Plain http is only supported for localhost loopback destinations."
        : `Only https URLs are supported (received "${url.protocol.replace(":", "")}").`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new UrlSecurityError("credentials_not_allowed", "URLs with embedded credentials are not allowed.");
  }
  if (url.hostname.length === 0) {
    throw new UrlSecurityError("invalid_url", "The URL has no host.");
  }
  return url;
}

/** Normalizes an IPv6 hostname (`[::1]` → `::1`) and lowercases it. */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  // Strip an IPv6 zone id (`fe80::1%eth0`).
  const zone = host.indexOf("%");
  if (zone >= 0) {
    host = host.slice(0, zone);
  }
  return host;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host.length === 0) {
    return true;
  }
  // An IP literal is judged by its address, not by name.
  if (isIP(host) !== 0) {
    return isPrivateAddress(host);
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * True for loopback, private, link-local, CGNAT, multicast, reserved and
 * otherwise non-public addresses, in both IPv4 and IPv6 forms.
 */
export function isPrivateAddress(address: string): boolean {
  const host = normalizeHostname(address);
  const version = isIP(host);
  if (version === 4) {
    return isPrivateIpv4(host);
  }
  if (version === 6) {
    return isPrivateIpv6(host);
  }
  // Not a literal address: treat as unsafe for the literal check.
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const host = address.toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80")) return true; // link-local
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local
  if (host.startsWith("ff")) return true; // multicast
  // IPv4-mapped (`::ffff:127.0.0.1`) and deprecated IPv4-compatible forms.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped && mapped[1]) {
    return isPrivateIpv4(mapped[1]);
  }
  return false;
}

/**
 * Verifies a URL is safe to request: literal hostnames are checked directly,
 * and named hosts are resolved so a hostname pointing at a private address is
 * rejected before any request is made.
 */
export async function assertPublicUrl(url: URL, resolveHost: HostResolver): Promise<void> {
  return assertFetchableUrl(url, resolveHost, {});
}

/**
 * Policy-aware destination check. Loopback destinations are denied unless
 * `allowLocalNetwork === true` (opt-in via `spider.fetch.allowLocalNetwork`,
 * default `false`); under the opt-in they pass for `http:` and `https:`.
 * Every other destination follows the strict public rules (https only, no
 * private/link-local/metadata, DNS verified) regardless of policy. Callers
 * must invoke this on the original URL **and re-invoke it on every redirect
 * target** (`fetch_url` does so in its redirect loop), so each hop's DNS is
 * resolved and checked afresh.
 *
 * Known limitation (DNS rebinding, TOCTOU): DNS is resolved once per hop,
 * immediately before that hop's request, but the address is still checked
 * before the TCP connect rather than pinned to it. A hostile DNS server can
 * serve a benign address at check time and a private/loopback address at
 * connect time (short TTL + rapid record swap). This module cannot eliminate
 * that race without connection-level IP pinning (custom dialer / DoH with
 * validation), which the current `fetch`-based transport does not provide.
 * The default-deny loopback policy narrows the reachable set so a rebinding
 * attack cannot reach the local machine unless the user explicitly opted in;
 * enabling `allowLocalNetwork` re-opens loopback as a rebinding target on
 * the developer's own machine (LAN/metadata ranges stay unreachable either
 * way, and the `external` permission still gates every request).
 */
export async function assertFetchableUrl(url: URL, resolveHost: HostResolver, policy: LocalNetworkPolicy): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrlSecurityError("unsupported_scheme", "Only https URLs are supported (http for localhost loopback only).");
  }
  const host = normalizeHostname(url.hostname);
  if (isIP(host) !== 0) {
    if (isLoopbackAddress(host)) {
      if (policy.allowLocalNetwork !== true) {
        throw new UrlSecurityError("blocked_address", "Requests to local or private network addresses are not allowed.");
      }
      return;
    }
    if (isPrivateAddress(host)) {
      throw new UrlSecurityError("blocked_address", "Requests to local or private network addresses are not allowed.");
    }
    if (url.protocol !== "https:") {
      throw new UrlSecurityError("unsupported_scheme", "Plain http is only supported for localhost loopback destinations.");
    }
    return;
  }
  if (isLoopbackHostname(host)) {
    if (policy.allowLocalNetwork !== true) {
      throw new UrlSecurityError("blocked_host", "Requests to local or internal hostnames are not allowed.");
    }
    return;
  }
  if (url.protocol !== "https:") {
    throw new UrlSecurityError("unsupported_scheme", "Plain http is only supported for localhost loopback destinations.");
  }
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UrlSecurityError("blocked_host", "Requests to local or internal hostnames are not allowed.");
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new UrlSecurityError("dns_failure", `Could not resolve ${host}.`);
  }
  if (addresses.length === 0) {
    throw new UrlSecurityError("dns_failure", `Could not resolve ${host}.`);
  }
  const allLoopback = addresses.every((address) => isLoopbackAddress(address));
  if (allLoopback) {
    // A public name resolving to loopback (split-horizon DNS, dev tunnels).
    if (policy.allowLocalNetwork !== true) {
      throw new UrlSecurityError(
        "blocked_address",
        "That hostname resolves to a local or private address, which is not allowed.",
      );
    }
    return;
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new UrlSecurityError(
        "blocked_address",
        "That hostname resolves to a local or private address, which is not allowed.",
      );
    }
  }
}

/** True for `localhost` (and its subdomains); the OS guarantees loopback. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost");
}

/** True for 127.0.0.0/8, ::1, and IPv4-mapped loopback forms. */
export function isLoopbackAddress(address: string): boolean {
  const host = normalizeHostname(address);
  if (isIP(host) !== 4 && isIP(host) !== 6) {
    return false;
  }
  if (isIP(host) === 4) {
    return host.split(".")[0] === "127";
  }
  const lower = host.toLowerCase();
  if (lower === "::1") {
    return true;
  }
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return mapped?.[1]?.split(".")[0] === "127";
}
