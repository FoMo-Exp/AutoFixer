/**
 * HTTP transport for real provider adapters (DAT-247).
 *
 * One narrow seam — request in, status/headers/body out — so adapters can be
 * tested against an exact fake provider service and so every credential is
 * attached at exactly one place.
 *
 * Two rules are enforced here rather than in each adapter:
 *
 * - **No credential in a diagnostic.** Error messages carry the provider,
 *   status, and URL only. The `Authorization` header value is never formatted
 *   into a message, an error, or a thrown cause.
 * - **Failures are classified, not swallowed.** 401/403 are missing
 *   permission (never "no access"), 404 is handed to the caller (only the
 *   caller knows whether absence means "not a collaborator"), and 429/5xx/
 *   network failures are {@link ProviderUnavailableError} — unavailable, so
 *   callers keep the last verified fact and mark it `stale`.
 */

import type { ProviderType } from "../control-plane/types.js";
import {
  IncompleteRosterError,
  MissingPermissionError,
  ProviderUnavailableError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------------------

export interface ProviderHttpRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export interface ProviderHttpResponse {
  status: number;
  /** Response headers with lower-cased names. */
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type ProviderHttpClient = (request: ProviderHttpRequest) => Promise<ProviderHttpResponse>;

/** The subset of the Fetch API the transport needs. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: "error" },
) => Promise<{
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

export interface FetchHttpClientOptions {
  /**
   * Injectable for tests and for deployments with a pinned HTTP stack.
   * Defaults to the process-wide `fetch`.
   */
  fetch?: FetchLike;
}

/**
 * Build the default transport. Redirects are refused (`redirect: "error"`):
 * a redirect is a provider (or an attacker between us and it) choosing where
 * our service credential goes next.
 */
export function createFetchHttpClient(options: FetchHttpClientOptions = {}): ProviderHttpClient {
  const fetchImpl: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return async ({ url, headers }) => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { ...headers },
        redirect: "error",
      });
    } catch (error) {
      throw new ProviderUnavailableError(
        "network",
        `provider request to ${url} failed: ${describeNetworkError(error)}`,
      );
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new ProviderUnavailableError(
        "network",
        `provider response body from ${url} could not be read: ${describeNetworkError(error)}`,
      );
    }
    return { status: response.status, headers: responseHeaders, body };
  };
}

/** Describe a transport failure without echoing headers or payloads. */
function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause : undefined;
    return cause ? `${error.name}: ${cause.name}` : `${error.name}: ${error.message}`;
  }
  return "unknown transport failure";
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

export interface RateLimitSnapshot {
  remaining: number;
  /** RFC 3339 instant the budget resets, when the provider reported one. */
  reset_at?: string;
}

function integerHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): number | undefined {
  const raw = headers[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read the provider's rate-limit headers. GitHub reports
 * `x-ratelimit-remaining` / `x-ratelimit-reset`; GitLab reports the same
 * cadence under `ratelimit-remaining` / `ratelimit-reset`. Both express the
 * reset as epoch seconds.
 */
export function readRateLimit(
  headers: Readonly<Record<string, string>>,
  provider: ProviderType,
): RateLimitSnapshot | null {
  const prefix = provider === "github" ? "x-ratelimit-" : "ratelimit-";
  const remaining = integerHeader(headers, `${prefix}remaining`);
  if (remaining === undefined) {
    return null;
  }
  const resetSeconds = integerHeader(headers, `${prefix}reset`);
  if (resetSeconds === undefined) {
    return { remaining };
  }
  return { remaining, reset_at: new Date(resetSeconds * 1000).toISOString() };
}

/** `Retry-After` in milliseconds (seconds form, as both providers send it). */
export function retryAfterMs(headers: Readonly<Record<string, string>>): number | undefined {
  const seconds = integerHeader(headers, "retry-after");
  return seconds === undefined ? undefined : seconds * 1000;
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

/**
 * Classify a response status. `404` is deliberately not handled here: only
 * the calling adapter knows whether absence means "not a collaborator" (an
 * authority fact) or "the repository is not visible to this installation"
 * (a visibility failure).
 */
export function assertProviderStatus(
  provider: ProviderType,
  response: ProviderHttpResponse,
  url: string,
): void {
  const { status, headers } = response;
  if (status >= 200 && status < 300) {
    return;
  }
  if (status === 404) {
    return;
  }

  const rateLimit = readRateLimit(headers, provider);
  const exhaustivelyRateLimited = rateLimit !== null && rateLimit.remaining <= 0;

  if (status === 429 || (status === 403 && exhaustivelyRateLimited)) {
    throw new ProviderUnavailableError(
      "rate_limited",
      `provider rate limit reached for ${url} (HTTP ${String(status)})`,
    );
  }
  if (status === 401) {
    throw new MissingPermissionError(
      "token_scope",
      `provider rejected the service credential for ${url} (HTTP 401)`,
    );
  }
  if (status === 403) {
    // 403 without an exhausted budget is an authorization gap on the
    // integration's own scopes/permissions — never "this subject has no
    // access", which would be an invented removal fact.
    throw new MissingPermissionError(
      "permission_query",
      `service integration is not permitted to read ${url} (HTTP 403)`,
    );
  }
  if (status >= 500) {
    throw new ProviderUnavailableError(
      "server_error",
      `provider returned HTTP ${String(status)} for ${url}`,
    );
  }
  throw new ProviderUnavailableError(
    "unexpected_status",
    `provider returned unexpected HTTP ${String(status)} for ${url}`,
  );
}

/** Parse a JSON body, treating malformed payloads as an unavailable provider. */
export function parseJsonBody<T>(body: string, url: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ProviderUnavailableError(
      "unexpected_status",
      `provider returned a non-JSON body for ${url}`,
    );
  }
}

/** Parse a JSON body that must be an array of records. */
export function parseJsonArray(body: string, url: string): Record<string, unknown>[] {
  const parsed = parseJsonBody<unknown>(body, url);
  if (!Array.isArray(parsed)) {
    throw new ProviderUnavailableError(
      "unexpected_status",
      `provider returned a non-array body for ${url}`,
    );
  }
  return parsed.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

/**
 * Pagination continuation from a `Link` header (`rel="next"`). Used by GitHub;
 * GitLab sends `X-Next-Page` instead, which the GitLab adapter reads itself.
 */
export function linkHasNext(headers: Readonly<Record<string, string>>): boolean {
  const link = headers["link"];
  if (link === undefined) {
    return false;
  }
  return link.split(",").some((part) => /rel="?next"?/.test(part));
}

/**
 * Whether a roster page must be treated as incomplete because the adapter's
 * declared fetch budget is spent while the provider still reports more data.
 * Adapters call this so the error (and its `rate_limited` reason) comes from
 * one place.
 */
export function assertRateLimitBudget(
  rateLimit: RateLimitSnapshot | null,
  hasMore: boolean,
  url: string,
): void {
  if (rateLimit !== null && rateLimit.remaining <= 0 && hasMore) {
    throw new IncompleteRosterError(
      "rate_limited",
      `provider rate limit exhausted before the roster was complete (${url})`,
    );
  }
}
