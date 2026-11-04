/**
 * Invitation landing-page token handling (ADR-0006 / DAT-205 contract).
 *
 * The token arrives only in the URL fragment (`…#<token>`), is captured on
 * load, and the fragment is cleared from browser history immediately so a
 * reload, a link preview, or a security scanner never replays it. Capture is
 * pure: nothing here calls the API, so a GET of the landing page consumes
 * nothing.
 *
 * The one surviving copy is `sessionStorage`, written only when the visitor
 * must leave the page for provider sign-in and read back on return. It is
 * removed as soon as the token is captured again, and it never enters the
 * query string, DOM attributes, or React keys beyond the confirmation flow.
 */

export const INVITE_TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{22,200}$/;
export const INVITE_TOKEN_STORAGE_KEY = "forgepilot.invite-token";

export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HistoryReplacement {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function captureInviteToken(
  hash: string,
  history: HistoryReplacement | undefined,
  storage: TokenStorage | undefined,
  urlWithoutFragment: string,
): string | undefined {
  const candidate = hash.startsWith("#") ? hash.slice(1) : hash;
  if (INVITE_TOKEN_HASH_PATTERN.test(candidate)) {
    history?.replaceState(null, "", urlWithoutFragment);
    storage?.removeItem(INVITE_TOKEN_STORAGE_KEY);
    return candidate;
  }

  const stashed = storage?.getItem(INVITE_TOKEN_STORAGE_KEY);
  if (stashed && INVITE_TOKEN_HASH_PATTERN.test(stashed)) {
    storage?.removeItem(INVITE_TOKEN_STORAGE_KEY);
    return stashed;
  }
  storage?.removeItem(INVITE_TOKEN_STORAGE_KEY);
  return undefined;
}

/** Keeps the invitation across the provider sign-in round trip. */
export function stashInviteToken(token: string, storage: TokenStorage | undefined): void {
  storage?.setItem(INVITE_TOKEN_STORAGE_KEY, token);
}

/** Groups the code for display only; copying yields the ungrouped token. */
export function groupInviteCode(token: string): string {
  const separator = token.indexOf("_");
  const prefix = separator >= 0 ? token.slice(0, separator + 1) : "";
  const body = token.slice(prefix.length);
  return prefix + body.replace(/(.{4})(?=.)/g, "$1 ");
}
