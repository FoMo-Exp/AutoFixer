/**
 * Server-authoritative request scope resolution (DAT-241).
 *
 * Every protected request path needs one answer to three questions: which
 * enterprise, which workspace, and which role does the caller act with. This
 * module answers them from the authenticated identity alone:
 * {@link resolveRequestScope} takes a session-derived principal and reads live
 * membership state on every call. Client-supplied enterprise/workspace IDs are
 * never an input — a request that carries IDs can only be compared against the
 * resolved scope, and the scoped repositories reject ID substitution at the
 * storage layer (DAT-201). A scope exists only because an authenticated
 * membership exists (ADR-0006).
 *
 * Failure semantics are explicit and fail closed (401/403):
 *
 * - **401** — there is no valid authenticated session: the principal is
 *   missing or not session-derived, or the session is unknown, revoked, or
 *   expired. Code `UNAUTHENTICATED`. The caller must authenticate again.
 * - **403** — the caller is authenticated but no scope is available to them:
 *   suspended account (`ACCOUNT_SUSPENDED`), no live membership — never
 *   granted or since revoked (`SCOPE_MISSING`), more than one live membership
 *   in the enterprise (`SCOPE_AMBIGUOUS`), or live memberships spanning
 *   enterprises (`SCOPE_CROSS_TENANT`). These are authorization outcomes;
 *   retrying the same request never helps.
 *
 * A failure never yields an empty or default scope. There is no fallback
 * scope, no cached verdict, and no per-call override: revocation, suspension,
 * and role changes take effect on the very next resolution in the same
 * request path, because every call recomputes the conclusion from the store
 * (aligned with DAT-203's never-cached access decisions).
 *
 * The resolved scope extends {@link WorkspaceScope}, so it can be handed to
 * the scoped repositories as-is; `role` is the live workspace role from the
 * membership row — the `workspace_role` input of DAT-203's effective-access
 * intersection.
 */

import { RequestScopeError } from "./errors.js";
import type { SessionRepository, UserRepository } from "./identity-repositories.js";
import type { MembershipRepository, WorkspaceRepository } from "./repositories.js";
import type {
  EnterpriseScope,
  Membership,
  MembershipId,
  UserId,
  WorkspaceRole,
  WorkspaceScope,
} from "./types.js";

/**
 * Module-private brand. The only way to mint a principal is
 * {@link principalFromSession}, so a value decoded from a request body or
 * hand-built from client-supplied IDs cannot become one: a brandless object
 * is rejected before any lookup. The session↔user binding is re-verified on
 * every resolution, so even a copied principal with swapped IDs fails.
 */
const AUTHENTICATED_PRINCIPAL = Symbol("autofixer.authenticated-principal");

/**
 * An authenticated caller: the identity bound to a verified session. Obtain
 * it only from a session context produced by token verification
 * (`AuthService.resolveSession`), via {@link principalFromSession}; never
 * from request input.
 */
export interface AuthenticatedPrincipal {
  readonly session_id: string;
  readonly user_id: UserId;
  readonly [AUTHENTICATED_PRINCIPAL]: true;
}

/** Structural session context (`api/auth-service.ts` `SessionContext` fits). */
export interface SessionContextLike {
  session: { id: string };
  user: { id: string };
}

/** Bind a principal to a verified session context. */
export function principalFromSession(ctx: SessionContextLike): AuthenticatedPrincipal {
  return {
    session_id: ctx.session.id,
    user_id: ctx.user.id,
    [AUTHENTICATED_PRINCIPAL]: true,
  };
}

function isAuthenticatedPrincipal(value: unknown): value is AuthenticatedPrincipal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string | symbol, unknown>;
  return (
    candidate[AUTHENTICATED_PRINCIPAL] === true &&
    typeof candidate.session_id === "string" &&
    candidate.session_id.length > 0 &&
    typeof candidate.user_id === "string" &&
    candidate.user_id.length > 0
  );
}

/**
 * What a request is scoped to. Extends {@link WorkspaceScope} so it can be
 * passed straight to the scoped repositories; the extra fields record which
 * membership the authority came from and its live role.
 */
export interface ResolvedRequestScope extends WorkspaceScope {
  /** The live membership row the scope was derived from. */
  membership_id: MembershipId;
  /** The live workspace role from that row (DAT-203 `workspace_role`). */
  role: WorkspaceRole;
}

export interface RequestScopeDeps {
  sessions: SessionRepository;
  users: UserRepository;
  memberships: MembershipRepository;
  workspaces: WorkspaceRepository;
  /** Injected clock for tests and replay; defaults to the system clock. */
  clock?: () => Date;
}

/**
 * Resolve the caller's authoritative scope from live state.
 *
 * Reads the session, user, and memberships at call time — nothing is
 * memoized between calls. The outcome is exactly one of:
 * a {@link ResolvedRequestScope} derived from the unique live membership, or
 * a {@link RequestScopeError} (fail closed; no empty or default scope).
 */
export function resolveRequestScope(
  deps: RequestScopeDeps,
  principal: AuthenticatedPrincipal,
): ResolvedRequestScope {
  if (!isAuthenticatedPrincipal(principal)) {
    throw new RequestScopeError(
      401,
      "UNAUTHENTICATED",
      "an authenticated session principal is required",
    );
  }
  const now = deps.clock ? deps.clock() : new Date();

  // The session is re-read and re-checked on every call: a revoked or
  // expired session, or a session belonging to another user, ends the
  // request path immediately.
  const session = deps.sessions.getById(principal.session_id);
  if (session === undefined || session.user_id !== principal.user_id) {
    throw new RequestScopeError(401, "UNAUTHENTICATED", "no valid authenticated session");
  }
  if (session.revoked_at !== null || Date.parse(session.expires_at) <= now.getTime()) {
    throw new RequestScopeError(401, "UNAUTHENTICATED", "the session is revoked or expired");
  }

  const user = deps.users.getById(principal.user_id);
  if (user === undefined) {
    throw new RequestScopeError(401, "UNAUTHENTICATED", "no valid authenticated session");
  }
  if (user.status !== "active") {
    throw new RequestScopeError(403, "ACCOUNT_SUSPENDED", "this account is suspended");
  }

  // Live memberships: a row whose workspace is gone or sits in another
  // enterprise than the row claims is not live. The reads below are derived
  // from stored rows, never from client input.
  const live: Membership[] = [];
  for (const membership of deps.memberships.listAllForUser(principal.user_id)) {
    const scope: EnterpriseScope = {
      enterprise_id: membership.enterprise_id,
      actor_id: principal.user_id,
    };
    if (deps.workspaces.getById(scope, membership.workspace_id) !== undefined) {
      live.push(membership);
    }
  }

  const first = live[0];
  if (first === undefined) {
    // Revocation removes the membership row, so a revoked membership is
    // indistinguishable from one that was never granted — both are denied.
    throw new RequestScopeError(403, "SCOPE_MISSING", "no live workspace membership for this user");
  }
  if (live.some((membership) => membership.enterprise_id !== first.enterprise_id)) {
    throw new RequestScopeError(
      403,
      "SCOPE_CROSS_TENANT",
      "memberships crossing enterprise boundaries cannot resolve to one scope",
    );
  }
  if (live.length > 1) {
    throw new RequestScopeError(
      403,
      "SCOPE_AMBIGUOUS",
      "more than one live workspace membership; the scope is ambiguous",
    );
  }

  return {
    enterprise_id: first.enterprise_id,
    workspace_id: first.workspace_id,
    actor_id: principal.user_id,
    membership_id: first.id,
    role: first.role,
  };
}
