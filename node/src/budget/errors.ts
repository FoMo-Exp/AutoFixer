/**
 * Budget-domain failures (DAT-229).
 *
 * These are contract failures of the budget surface, not user-facing error
 * envelopes: the gateway maps a refusal into the shared error catalog. Every
 * message here is safe to log — it names identities, currencies and limits,
 * never provider credentials, prompts, or content.
 */
import type { BudgetDenyReason, BudgetScopeLevel } from "./types.js";

/** A malformed policy, reservation, or settlement. */
export class BudgetValidationError extends Error {
  readonly code = "BUDGET_VALIDATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

/** A redelivery or transition that would rewrite committed accounting. */
export class BudgetConflictError extends Error {
  readonly code = "BUDGET_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "BudgetConflictError";
  }
}

/** A scoped read that asked for a scope other than the authenticated one. */
export class BudgetAccessError extends Error {
  readonly code = "BUDGET_ACCESS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "BudgetAccessError";
  }
}

/** A durable journal write failed; the transition did not take effect. */
export class BudgetWriteError extends Error {
  readonly code = "BUDGET_WRITE_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BudgetWriteError";
  }
}

/**
 * A reservation would exceed an enterprise, workspace or run budget. The
 * authority converts this into a denial decision; it never quietly shrinks
 * the requested bound.
 */
export class BudgetQuotaError extends Error {
  readonly code = "BUDGET_LIMIT_EXCEEDED";

  constructor(
    readonly reason: BudgetDenyReason,
    readonly level: BudgetScopeLevel,
    message: string,
  ) {
    super(message);
    this.name = "BudgetQuotaError";
  }
}
