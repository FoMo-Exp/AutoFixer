/**
 * Control-plane domain errors.
 *
 * Every error carries a stable machine-readable code so callers can map to
 * HTTP status codes without inspecting messages.
 */

import type { WorkspaceRepositorySetErrorCode } from "./workspace-repository-types.js";

/** Base class for all control-plane domain errors. */
export class ControlPlaneError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A requested entity does not exist within the caller's scope. */
export class NotFoundError extends ControlPlaneError {
  constructor(entity: string, id: string) {
    super("NOT_FOUND", `${entity} ${id} not found in scope`);
  }
}

/**
 * The actor is authenticated and may see the target, but has no standing for
 * this action (403). Authorization, not authentication; never a 401.
 */
export class ForbiddenError extends ControlPlaneError {
  constructor(message: string) {
    super("FORBIDDEN", message);
  }
}

/**
 * A lifecycle transition the state machine does not allow (DAT-251). A
 * governance action on the wrong status is a state conflict, not a bad
 * request: the client's *intent* is well-formed, the item is not in a state
 * that can accept it.
 */
export class InvalidTransitionError extends ControlPlaneError {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super("INVALID_TRANSITION", message);
  }
}

/**
 * A write whose preconditions do not hold (DAT-251): for example promoting an
 * item that has no evidence citation. The request is valid; the stored state
 * does not support the action yet.
 */
export class PreconditionFailedError extends ControlPlaneError {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super("PRECONDITION_FAILED", message);
  }
}

/** The caller's scope does not include the referenced entity. */
export class ScopeError extends ControlPlaneError {
  constructor(message: string) {
    super("SCOPE_DENIED", message);
  }
}

/** A uniqueness constraint would be violated (e.g. duplicate active repository). */
export class ConflictError extends ControlPlaneError {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super("CONFLICT", message);
  }
}

/**
 * Optimistic-concurrency check failed: the caller's `expectedVersion` does not
 * match the stored version, meaning the record was modified concurrently.
 */
export class VersionConflictError extends ControlPlaneError {
  constructor(entity: string, id: string, expected: number, actual: number) {
    super(
      "VERSION_CONFLICT",
      `${entity} ${id} was modified concurrently (expected version ${expected}, found ${actual})`,
    );
  }
}

/** An input value violates a domain invariant. */
export class ValidationError extends ControlPlaneError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
  }
}

/**
 * A workspace membership change would leave the workspace without an owner
 * anyone can act as (DAT-277, DAT-283, ADR-0011). The check and the write run in
 * the same transaction, so two concurrent removals/demotions cannot both
 * observe a second owner and both succeed: exactly one leaves at least one
 * owner in place.
 *
 * `details.reason` distinguishes the two refusals: `last_workspace_owner` is the
 * role-count floor (the only remaining `owner` row), `last_effective_owner`
 * means other owner rows exist but none proves active account, active enterprise
 * membership and verified repository management capability across every active
 * repository.
 */
export class LastOwnerError extends ControlPlaneError {
  constructor(
    readonly workspaceId: string,
    readonly action: "remove" | "demote",
    readonly details: Record<string, unknown> = {},
  ) {
    super(
      "LAST_WORKSPACE_OWNER",
      `Refusing to ${action} the workspace's last owner; assign another owner first`,
    );
  }
}

/**
 * A workspace repository-set read or write was refused (DAT-281, ADR-0011).
 *
 * The `status` states the request-path semantics for a later route: 404 is
 * never used here (a missing workspace stays a {@link NotFoundError}), 403 is
 * a scope this deployment may not use at all, 409 is a binding or version
 * fact that does not hold. Every one of these is a refusal — there is no
 * degraded single-repository fallback.
 */
export class WorkspaceRepositorySetError extends ControlPlaneError {
  readonly status: 403 | 409;

  constructor(
    code: WorkspaceRepositorySetErrorCode,
    message: string,
    status: 403 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message);
    this.status = status;
  }
}

/**
 * A capability-ceiling decision or mutation was refused (DAT-276).
 *
 * These codes are stable and each one is a refusal: an unverifiable ceiling
 * never degrades to the last known capabilities, and an administrator can
 * never approve more than the provider facts currently prove.
 *
 * - `CAPABILITY_CEILING_UNAVAILABLE` (409) — current evidence is missing,
 *   stale or incomplete, so no reapproval decision can be formed yet.
 * - `CAPABILITY_CEILING_EXCEEDS_VERIFIED` (403) — the requested capabilities
 *   are not a subset of the verified intersection.
 * - `CAPABILITY_CEILING_NOT_ELIGIBLE` (403) — the verified intersection lacks
 *   code read, so the member is not eligible for workspace access and no
 *   ceiling may be approved.
 * - `CAPABILITY_CEILING_MISMATCH` (409) — the observed `available_ceiling` is
 *   not the one the caller decided against (a concurrent provider change).
 * - `CAPABILITY_ADMIN_REQUIRED` (403) — only an enterprise administrator may
 *   reapprove a ceiling; the refusal is audited.
 * - `CAPABILITY_MANAGEMENT_REQUIRED` (403) — the caller lacks verified
 *   repository management capability across the workspace's repositories.
 */
export type CapabilityCeilingErrorCode =
  | "CAPABILITY_CEILING_UNAVAILABLE"
  | "CAPABILITY_CEILING_EXCEEDS_VERIFIED"
  | "CAPABILITY_CEILING_NOT_ELIGIBLE"
  | "CAPABILITY_CEILING_MISMATCH"
  | "CAPABILITY_ADMIN_REQUIRED"
  | "CAPABILITY_MANAGEMENT_REQUIRED";

export class CapabilityCeilingError extends ControlPlaneError {
  readonly status: 403 | 409;

  constructor(
    code: CapabilityCeilingErrorCode,
    message: string,
    status: 403 | 409 = 403,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message);
    this.status = status;
  }
}

/**
 * A repository-set change was refused, or its required audit could not be
 * written (DAT-284, ADR-0011).
 *
 * These codes are stable and each one is a refusal of the whole change: no
 * binding, set version, ceiling reduction, revocation or confirmation
 * consumption survives a refusal. `status` states the later request-path
 * semantics: 403 is an actor who may not decide this, 409 is a confirmation or
 * guarded write that no longer holds, and 500 is a required audit failure that
 * blocks the sensitive action instead of committing it unaudited.
 *
 * - `REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED` (403) — the actor is not an
 *   active workspace owner/admin with verified repository management
 *   capability across every current repository.
 * - `REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED` (409) — no confirmation with
 *   that id exists for this actor and workspace. Other actors' confirmations
 *   are indistinguishable from missing ones.
 * - `REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED` (409) — the confirmation was
 *   already used; a change commits at most once.
 * - `REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED` (409) — the bounded validity
 *   window passed; a fresh preview and confirmation are required.
 * - `REPOSITORY_SET_CHANGE_CONFIRMATION_STALE` (409) — the repository set,
 *   membership/role state, provider evidence or exact reductions changed since
 *   the confirmation, so the decision no longer describes the commit.
 * - `REPOSITORY_SET_CHANGE_INVALID_PROPOSAL` (409) — the proposal is empty,
 *   repeats a bound repository, or carries an invalid validity window.
 * - `REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE` (409) — the proposed set would lose
 *   a protected member's admission, leave evidence unverified, or leave no
 *   effective owner. The whole addition is refused; no member is removed.
 * - `REPOSITORY_SET_CHANGE_CONFLICT` (409) — a guarded write lost to a
 *   concurrent change and the transaction rolled back.
 * - `REPOSITORY_SET_CHANGE_AUDIT_FAILED` (500) — the required audit row could
 *   not be written, so the change was rolled back.
 */
export type RepositorySetChangeErrorCode =
  | "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED"
  | "REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED"
  | "REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED"
  | "REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED"
  | "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE"
  | "REPOSITORY_SET_CHANGE_INVALID_PROPOSAL"
  | "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE"
  | "REPOSITORY_SET_CHANGE_CONFLICT"
  | "REPOSITORY_SET_CHANGE_AUDIT_FAILED";

export class RepositorySetChangeError extends ControlPlaneError {
  readonly status: 403 | 409 | 500;

  constructor(
    code: RepositorySetChangeErrorCode,
    message: string,
    status: 403 | 409 | 500 = 409,
    readonly details: Record<string, unknown> = {},
    options: { cause?: unknown } = {},
  ) {
    super(code, message);
    this.status = status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Request-scope resolution failed (DAT-241). `status` states the request-path
 * semantics: 401 = there is no valid authenticated session (authenticate
 * again); 403 = the caller is authenticated but no scope is available to them
 * (authorization). Codes are stable and never re-mapped:
 *
 * - `UNAUTHENTICATED` (401) — principal missing or not session-derived, or
 *   the session is unknown, revoked, or expired.
 * - `ACCOUNT_SUSPENDED` (403) — the user account is suspended.
 * - `SCOPE_MISSING` (403) — no live workspace membership (never granted,
 *   revoked, or its workspace is gone).
 * - `SCOPE_AMBIGUOUS` (403) — more than one live workspace membership in the
 *   enterprise; resolution never guesses.
 * - `SCOPE_CROSS_TENANT` (403) — live memberships span enterprises.
 */
export type RequestScopeErrorCode =
  | "UNAUTHENTICATED"
  | "ACCOUNT_SUSPENDED"
  | "SCOPE_MISSING"
  | "SCOPE_AMBIGUOUS"
  | "SCOPE_CROSS_TENANT"
  | "ENTERPRISE_MEMBERSHIP_REQUIRED"
  | "ENTERPRISE_MEMBERSHIP_SUSPENDED";

export class RequestScopeError extends ControlPlaneError {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, code: RequestScopeErrorCode, message: string) {
    super(code, message);
    this.status = status;
  }
}
