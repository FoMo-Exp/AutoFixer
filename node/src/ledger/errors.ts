/** Ledger contract failures (DAT-227): never a defaulted value, always loud. */
export class LedgerValidationError extends Error {
  readonly code = "USAGE_LEDGER_CONTRACT";

  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

/** A read asked for a scope the caller is not authenticated for. */
export class LedgerAccessError extends Error {
  readonly code = "USAGE_LEDGER_ACCESS";

  constructor(message: string) {
    super(message);
    this.name = "LedgerAccessError";
  }
}

/** A write tried to alter a ledger entry that is already recorded. */
export class LedgerConflictError extends Error {
  readonly code = "USAGE_LEDGER_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

/**
 * The usage record for an attempt could not be persisted. Raised after the
 * operational incident so no caller treats an unrecorded attempt as recorded,
 * and never retried on its own: a retry here would dispatch the model again.
 */
export class UsageLedgerWriteError extends Error {
  readonly code = "USAGE_LEDGER_WRITE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UsageLedgerWriteError";
  }
}
