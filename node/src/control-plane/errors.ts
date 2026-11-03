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
