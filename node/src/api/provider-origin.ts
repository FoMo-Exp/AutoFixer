import { isIP } from "node:net";

import { ApiError } from "./errors.js";

/**
 * Provider-instance origin policy.
 *
 * A provider origin becomes a credential-exfiltration and server-side request
 * endpoint the moment OAuth traffic flows to it, so registration only accepts
 * origins that are unambiguously public: HTTPS, no embedded credentials, the
 * default port, no path/query/fragment, a public hostname or IP literal, and
 * — when a resolver is supplied — public DNS answers only. An administrator
 * pre-approving the instance is the authority gate; this policy is the
 * technical floor under it. Arbitrary self-hosted or internal-network URLs
 * never pass.
 *
 * Residual risk accepted for v1: DNS answers are checked at registration
 * time, so a later rebinding of an approved hostname relies on deployment
 * egress controls.
 */

/** Resolves a hostname to every address it currently maps to. */
export type OriginDnsLookup = (hostname: string) => Promise<string[]>;

/** Reserved suffixes that always name an internal or non-public host. */
const RESERVED_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".intranet",
  ".corp",
  ".lan",
  ".home",
  ".localdomain",
  ".private",
  ".home.arpa",
];

function reject(message: string, details: Record<string, unknown> = {}): never {
  throw new ApiError(403, "PROVIDER_ORIGIN_REJECTED", message, details);
}

/** True when an IPv4 address is private, loopback, link-local, or reserved. */
function isNonPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a = -1, b = -1, c = -1] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a === 224 ||
    a >= 240
  );
}

/** Expand an IPv6 address to its eight 16-bit groups; undefined if malformed. */
function ipv6Groups(address: string): number[] | undefined {
  const parts = address.toLowerCase().split("::");
  if (parts.length > 2) {
    return undefined;
  }
  const left = (parts[0] ?? "") === "" ? [] : (parts[0] ?? "").split(":");
  const right = (parts[1] ?? "") === "" ? [] : (parts[1] ?? "").split(":");
  let head = [...left];
  let tail = [...right];
  // An embedded trailing IPv4 (e.g. ::ffff:10.0.0.1) becomes two groups.
  const last = [...head, ...tail].at(-1) ?? "";
  if (last.includes(".")) {
    const octets = last.split(".").map((part) => Number.parseInt(part, 10));
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    const replacement = [hi.toString(16), lo.toString(16)];
    if (tail.length > 0) {
      tail = [...tail.slice(0, -1), ...replacement];
    } else {
      head = [...head.slice(0, -1), ...replacement];
    }
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (parts.length === 1 && fill !== 0)) {
    return undefined;
  }
  return [...head, ...Array<string>(fill).fill("0"), ...tail].map(
    (group) => Number.parseInt(group, 16) || 0,
  );
}

/** True when an IPv6 address is loopback, link-local, unique-local, or reserved. */
function isNonPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") {
    return true;
  }
  const groups = ipv6Groups(lower);
  if (groups === undefined) {
    return true; // unparsable → fail closed
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  // IPv4-mapped (::ffff:a:b) and deprecated IPv4-compatible (::a:b) forms
  // inherit the IPv4 judgment — the URL parser hex-normalizes them, so a
  // dotted-tail check would miss exactly the dangerous case.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isNonPublicIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    (g0 === 0x2001 && g1 === 0x0db8) // 2001:db8::/32 documentation
  );
}

function isNonPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isNonPublicIpv4(address);
  }
  if (version === 6) {
    return isNonPublicIpv6(address);
  }
  return true;
}

/**
 * Lexical origin policy: returns the normalized `https://host[:443]` origin.
 * Throws {@link ApiError} `PROVIDER_ORIGIN_REJECTED` for anything that could
 * exfiltrate credentials or address an internal network.
 */
export function normalizeProviderOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject(`provider origin ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (url.protocol !== "https:") {
    reject("provider origin must use HTTPS", { origin: raw });
  }
  if (url.username !== "" || url.password !== "") {
    reject("provider origin must not embed credentials", { origin: raw });
  }
  if (url.search !== "" || url.hash !== "") {
    reject("provider origin must not include a query or fragment", { origin: raw });
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    reject("provider origin must not include a path", { origin: raw });
  }
  if (url.port !== "" && url.port !== "443") {
    reject("provider origin must use the default HTTPS port", { origin: raw });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (isNonPublicAddress(hostname)) {
      reject("provider origin must not resolve to an internal or reserved address", {
        hostname,
      });
    }
    return `https://${url.hostname.toLowerCase()}`;
  }
  if (!hostname.includes(".")) {
    reject("provider origin must be a fully qualified public hostname", { hostname });
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      reject("provider origin must not be an internal-network hostname", { hostname });
    }
  }
  return `https://${hostname}`;
}

/**
 * DNS-floor check for a syntactically accepted origin: the hostname must
 * resolve, and every answer must be a public address.
 */
export async function assertPublicResolution(
  origin: string,
  lookup: OriginDnsLookup,
): Promise<void> {
  const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    return; // literal addresses already passed the lexical floor
  }
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    reject(`provider origin hostname ${hostname} does not resolve`, { hostname });
  }
  if (addresses.length === 0) {
    reject(`provider origin hostname ${hostname} does not resolve`, { hostname });
  }
  for (const address of addresses) {
    if (isNonPublicAddress(address)) {
      reject(`provider origin hostname ${hostname} resolves to an internal or reserved address`, {
        hostname,
      });
    }
  }
}
