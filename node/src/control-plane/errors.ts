/**
 * Control-plane domain errors.
 *
 * Every error carries a stable machine-readable code so callers can map to
 * HTTP status codes without inspecting messages.
 */

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
  | "SCOPE_CROSS_TENANT";

export class RequestScopeError extends ControlPlaneError {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, code: RequestScopeErrorCode, message: string) {
    super(code, message);
    this.status = status;
  }
}
