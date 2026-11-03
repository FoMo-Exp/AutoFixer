import { randomBytes } from "node:crypto";

import { hashToken, secretEquals } from "../control-plane/identity-repositories.js";

/**
 * Web session cookies and CSRF tokens.
 *
 * The session token is 256 bits of randomness delivered exactly once — to the
 * client at login — and stored only as a SHA-256 digest. Web clients receive
 * it in an HttpOnly cookie (never in a response body the renderer can read)
 * and pair every mutating request with the session's CSRF token; desktop
 * clients present it as a bearer credential instead, so CSRF does not apply
 * to them. The OAuth binding cookie ties an authorization-code flow to the
 * browser that started it (login-CSRF defense).
 */

export const SESSION_COOKIE = "fp_session";
export const OAUTH_BINDING_COOKIE = "fp_oauth_binding";
export const CSRF_HEADER = "x-csrf-token";

export interface MintedSessionSecrets {
  token: string;
  token_hash: string;
  csrf_token: string;
}

export function mintSessionSecrets(): MintedSessionSecrets {
  const token = randomBytes(32).toString("base64url");
  return { token, token_hash: hashToken(token), csrf_token: randomBytes(32).toString("base64url") };
}

/** Parse a `Cookie` header into a name → value map (unknown names included). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) {
    return cookies;
  }
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    try {
      cookies[name] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      cookies[name] = pair.slice(separator + 1).trim();
    }
  }
  return cookies;
}

function cookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`
  );
}

export function sessionCookieValue(token: string, maxAgeSeconds: number, secure: boolean): string {
  return cookie(SESSION_COOKIE, token, maxAgeSeconds, secure);
}

export function bindingCookieValue(
  binding: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return cookie(OAUTH_BINDING_COOKIE, binding, maxAgeSeconds, secure);
}

/** Expire a cookie (used at logout and after a flow completes). */
export function expireCookieValue(name: string, secure: boolean): string {
  return cookie(name, "", 0, secure);
}

/** Timing-safe CSRF comparison; missing or mismatched headers fail closed. */
export function csrfMatches(presented: string | undefined, expected: string): boolean {
  return typeof presented === "string" && presented.length > 0 && secretEquals(presented, expected);
}
