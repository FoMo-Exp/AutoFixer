/**
 * Typed failures for the trace/event model (DAT-224).
 *
 * They are deliberately distinct from the HTTP error envelope (which
 * DAT-226 owns): these describe model-layer refusals so an API surface can
 * map them without the model depending on transport vocabulary.
 */

/** An event, scope, label, or aggregate dimension violates the trace schema. */
export class TraceValidationError extends Error {
  readonly code = "TRACE_VALIDATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "TraceValidationError";
  }
}

/** A read asked for data outside the caller's authenticated access scope. */
export class TraceAccessError extends Error {
  readonly code = "TRACE_ACCESS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "TraceAccessError";
  }
}

/** A redelivery tried to change content that is already recorded as evidence. */
export class TraceConflictError extends Error {
  readonly code = "TRACE_EVENT_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "TraceConflictError";
  }
}
