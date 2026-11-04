/**
 * Bounded RSI public surface (DAT-238).
 *
 * `holdoutRead` is deliberately not exported: the holdout case content has one
 * reader, the offline replay, and no caller of this package can acquire the
 * capability that unlocks it.
 */

export { createRsiStore } from "./store.js";
export type { RsiStore } from "./store.js";

export { createRsiService } from "./service.js";
export type { RsiActor, RsiProposalFilter, RsiService, RsiServiceDeps } from "./service.js";

export { canaryBucket, requiredApprovalKeys, verdictFor } from "./gate.js";
export type { GateOutcome } from "./gate.js";

export { isoWeekStart, newcombeDifference, wilsonInterval } from "./stats.js";
export type { DifferenceEstimate, Interval } from "./stats.js";

export * from "./types.js";
