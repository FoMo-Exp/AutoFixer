/**
 * Immutable rate cards, per-category cost computation, fixed-precision money,
 * linked adjustments and explicit FX conversion (DAT-228).
 *
 * See `types.ts` for the record classes and the honesty rules this domain
 * enforces: history is never repriced, unknown is never zero, estimates are
 * labeled and never invoiced, and currencies only merge through explicit
 * versioned FX quotes.
 */
export {
  CostAccessError,
  CostConflictError,
  CostValidationError,
  CostWriteError,
} from "./errors.js";
export {
  MONEY_SCALE,
  ZERO_AMOUNT,
  assertCanonicalAmount,
  computeChargeScaled,
  convertScaled,
  formatAmount,
  invertRateScaled,
  parseAmount,
  parseRateValue,
  roundHalfUpDiv,
} from "./money.js";
export {
  COST_CLASSES,
  COST_CATEGORIES,
  COST_SCHEMA_VERSION,
  INFRASTRUCTURE_CATEGORY,
  RATE_SOURCES,
  RATE_UNITS,
  TOKEN_COST_CATEGORIES,
} from "./types.js";
export type {
  AdjustmentComponent,
  AdjustmentEntry,
  AdjustmentInput,
  CostClass,
  CostClassTotals,
  CostComponent,
  CostCompleteness,
  CostLedgerEntry,
  CostPosting,
  CostSummary,
  CostUnknownReason,
  CostableInvocation,
  CostableUsageFigure,
  FxQuote,
  FxQuoteInput,
  InfrastructureCostInput,
  RateCardRevision,
  RateCardRevisionInput,
  RateSource,
  RateTarget,
  RateUnit,
  TokenCostCategory,
} from "./types.js";
export {
  bindRate,
  buildRateCardRevision,
  rateRevisionKey,
  validateRateCardRevision,
} from "./rate-card.js";
export type { RateBinding, RateBindingContext } from "./rate-card.js";
export {
  computeInfrastructureCost,
  computeInvocationCost,
  postingCurrency,
  rollupCompleteness,
  validateCostPosting,
} from "./pricing.js";
export {
  buildAdjustment,
  netPosting,
  resolveRebindRevision,
  summarizeCosts,
  validateAdjustmentEntry,
} from "./adjustments.js";
export type { NetPostingView } from "./adjustments.js";
export { buildFxQuote, convertSummary, validateFxQuote } from "./fx.js";
export type { ConvertedClassTotals, ConvertedSummary, FxSelection } from "./fx.js";
export { CostStore } from "./store.js";
export type { CostAccessScope, CostPostingFilter, CostStoreOptions } from "./store.js";
