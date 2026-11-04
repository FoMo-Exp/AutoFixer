/**
 * Cost domain contract failures (DAT-228): never a defaulted value, always
 * loud. A missing rate or missing usage stays unknown — it is never rounded
 * into a zero and never silently priced.
 */
export class CostValidationError extends Error {
  readonly code = "COST_CONTRACT";

  constructor(message: string) {
    super(message);
    this.name = "CostValidationError";
  }
}

/** A read asked for a scope the caller is not authenticated for. */
export class CostAccessError extends Error {
  readonly code = "COST_ACCESS";

  constructor(message: string) {
    super(message);
    this.name = "CostAccessError";
  }
}

/**
 * A write tried to alter financial evidence that is already recorded —
 * rate revisions, postings and adjustments are immutable once written.
 */
export class CostConflictError extends Error {
  readonly code = "COST_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "CostConflictError";
  }
}

/**
 * A cost record could not be persisted. Raised so no caller treats an
 * unrecorded posting as recorded.
 */
export class CostWriteError extends Error {
  readonly code = "COST_WRITE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CostWriteError";
  }
}
