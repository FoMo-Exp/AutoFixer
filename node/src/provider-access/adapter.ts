/**
 * Roster collection over the provider adapter contract (DAT-203).
 *
 * `collectRoster` is the only sanctioned way to read a provider roster. It
 * enforces everything the adapter declares:
 *
 * - Missing effective-permission visibility is a {@link MissingPermissionError}
 *   before any page is fetched — authority cannot be verified at all.
 * - Truncated pages, pagination past `pages_max`, a missing continuation
 *   cursor while the provider says there is more, or a rate limit exhausted
 *   before completion are all {@link IncompleteRosterError}. The partial data
 *   is never returned as a roster: an incomplete fetch is an error, not an
 *   empty (or half-full) member list.
 */

import {
  IncompleteRosterError,
  MissingPermissionError,
  type ProviderAdapter,
  type ProviderCallContext,
  type RawProviderRole,
  type RepositoryRef,
} from "./types.js";

export interface CollectedRoster {
  entries: RawProviderRole[];
  pages_fetched: number;
  /** Verification timestamp for the rows (caller supplies the clock). */
  completed: true;
}

export interface CollectOptions {
  /** Fail when the adapter's declared token scope cannot cover roster reads. */
  available_token_scope?: readonly string[];
  /** Optional hook for tests/observability; called per fetched page. */
  onPage?: (pageIndex: number, entryCount: number) => void;
}

/**
 * Fetch the complete roster of one repository, page by page.
 *
 * Throws instead of returning partial data whenever completeness cannot be
 * established. Callers (reconcile) treat a throw as "apply nothing".
 */
export async function collectRoster(
  adapter: ProviderAdapter,
  ctx: ProviderCallContext,
  repository: RepositoryRef,
  options: CollectOptions = {},
): Promise<CollectedRoster> {
  const { capabilities } = adapter;

  // Authority visibility is a precondition: if the adapter cannot see
  // effective permissions, no roster it returns can be complete.
  if (capabilities.effective_permission_visibility === "none") {
    throw new MissingPermissionError("visibility");
  }
  if (options.available_token_scope) {
    const held = new Set(options.available_token_scope);
    const missing = capabilities.required_token_scope.filter((scope) => !held.has(scope));
    if (missing.length > 0) {
      throw new MissingPermissionError(
        "token_scope",
        `service credential lacks scope: ${missing.join(", ")}`,
      );
    }
  }

  const entries: RawProviderRole[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;

  for (;;) {
    if (pagesFetched >= capabilities.pagination.pages_max) {
      // The provider still has more data but the declared fetch budget is
      // spent: the roster is provably incomplete.
      throw new IncompleteRosterError("pagination_limit");
    }

    const page = await adapter.fetchRosterPage(ctx, repository, cursor);
    pagesFetched += 1;
    options.onPage?.(pagesFetched, page.entries.length);

    if (page.truncated) {
      throw new IncompleteRosterError("truncated");
    }
    if (page.rate_limit && page.rate_limit.remaining <= 0 && page.has_more) {
      // Out of budget before the roster is complete.
      throw new IncompleteRosterError("rate_limited");
    }
    if (page.entries.length === 0 && page.has_more) {
      // A provider reporting more data but delivering none cannot be
      // distinguished from a dropped tail.
      throw new IncompleteRosterError("empty_page");
    }

    entries.push(...page.entries);

    if (!page.has_more) {
      return { entries, pages_fetched: pagesFetched, completed: true };
    }
    if (!page.next_cursor) {
      // "More data exists" with no way to reach it is an incomplete fetch.
      throw new IncompleteRosterError("missing_cursor");
    }
    cursor = page.next_cursor;
  }
}

/**
 * Verify one subject's effective repository permission through the adapter.
 * A provider that says "no access" yields null; a provider that cannot tell
 * throws {@link MissingPermissionError}.
 */
export async function fetchEffectivePermission(
  adapter: ProviderAdapter,
  ctx: ProviderCallContext,
  repository: RepositoryRef,
  subject: string,
  options: CollectOptions = {},
): Promise<RawProviderRole | null> {
  if (adapter.capabilities.effective_permission_visibility === "none") {
    throw new MissingPermissionError("visibility");
  }
  if (options.available_token_scope) {
    const held = new Set(options.available_token_scope);
    const missing = adapter.capabilities.required_token_scope.filter((scope) => !held.has(scope));
    if (missing.length > 0) {
      throw new MissingPermissionError(
        "token_scope",
        `service credential lacks scope: ${missing.join(", ")}`,
      );
    }
  }
  return adapter.fetchEffectivePermission(ctx, repository, subject);
}
