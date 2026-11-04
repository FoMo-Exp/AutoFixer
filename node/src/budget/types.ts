/**
 * Budget reservation, settlement, reconciliation and release (DAT-229,
 * ADR-0008 "Enterprise/workspace/run budgets have a common authority").
 *
 * The budget authority is the one place a model invocation is admitted
 * against enterprise, workspace and run limits. It reserves a conservative
 * bound before dispatch, settles against the usage actually observed, and
 * keeps the reservation when the provider outcome or its usage is unknown so
 * a lost accounting record can never turn into a free invocation.
 *
 * Honesty rules enforced here:
 * - A monetary limit needs a finite conservative bound. Without one the
 *   invocation is blocked unless the policy is an *explicit* bounded
 *   token-only policy — cost is never assumed to be zero.
 * - Usage that was not observed is `unknown`, never zero: the reservation
 *   keeps its bound until it is reconciled.
 * - An unknown provider outcome keeps the whole reservation and stops the
 *   caller from duplicating the invocation; budget is never silently
 *   released on uncertainty.
 * - A monetary settlement derived from the internal conservative cost
 *   ceiling is labelled `estimated` and its source is recorded. Internal
 *   limits bound what the service authorizes; they are not a provider
 *   invoice cap.
 * - Every reservation, settlement, reconciliation and release is an
 *   append-only journal entry carrying the identity it was made for.
 */

import type { CurrencyAmount } from "./amount.js";

/** Completeness of a token or cost figure, matching the ledger/cost domains. */
export type BudgetCompleteness = "known" | "estimated" | "unknown";

/** Scope levels at which a budget is enforced, outermost first. */
export const BUDGET_SCOPE_LEVELS = ["enterprise", "workspace", "run"] as const;

export type BudgetScopeLevel = (typeof BUDGET_SCOPE_LEVELS)[number];

/** Why an invocation could not be admitted against its budget. */
export type BudgetDenyReason =
  /** No budget policy resolves for the authenticated scope. */
  | "BUDGET_POLICY_UNAVAILABLE"
  /** A finite safe reservation cannot be computed for a monetary limit. */
  | "BUDGET_BOUND_UNKNOWN"
  /** The conservative token bound exceeds the per-invocation token ceiling. */
  | "BUDGET_TOKEN_CEILING_EXCEEDED"
  /** Enterprise, workspace or run budget has no room for the bound. */
  | "BUDGET_LIMIT_EXCEEDED";

/** Capabilities of one scope level: per-currency money and/or tokens. */
export interface BudgetLimits {
  /** Per-currency caps. Empty for a token-only policy. */
  monetary: CurrencyAmount[];
  /** Token cap for this scope; null means this level is not token-capped. */
  tokens: number | null;
}

/**
 * A conservative, administrator-entered internal cost ceiling used to bound a
 * monetary reservation before usage exists. It is a budget bound, not a rate
 * card and not a bill: it must never be presented as an invoiced amount.
 */
export interface BudgetCostCeiling {
  /** Endpoint scope; null matches any endpoint. */
  endpoint_id: string | null;
  /** Model scope; null matches any model. */
  model_id: string | null;
  /** Currency the ceiling is expressed in. */
  currency: string;
  /** Internal upper bound per 1000 chargeable tokens (canonical decimal). */
  amount_per_1000_tokens: string;
}

/**
 * An immutable, configuration-owned budget policy. Callers never supply it:
 * the authority resolves it for the authenticated enterprise/workspace scope
 * and snapshots the revision onto every reservation.
 */
export interface BudgetPolicy {
  /** Opaque configuration revision recorded on every reservation. */
  revision: string;
  enterprise: BudgetLimits;
  workspace: BudgetLimits;
  /** Optional per-run caps; a run without this section is uncapped at run level. */
  run: BudgetLimits | null;
  /**
   * Hard ceiling on the conservative per-invocation token bound (input plus
   * output). Exceeding it is denied rather than silently clamped: quietly
   * truncating a model response is not a budget control.
   */
  max_tokens_per_invocation: number | null;
  /**
   * Explicit bounded token-only mode. When set, the policy enforces tokens
   * only and every monetary cap must be absent (validated); a monetary limit
   * is never silently reinterpreted as token-only.
   */
  token_only: { enabled: true; reason: string } | null;
  /** Conservative bound rates used for monetary reservations when not token-only. */
  cost_ceilings: BudgetCostCeiling[];
}

/** Scope a policy is resolved for; the resolver is the ADR-0006 seam. */
export interface BudgetScope {
  enterpriseId: string;
  workspaceId: string;
}

export interface BudgetPolicyResolver {
  resolve(scope: BudgetScope): BudgetPolicy | undefined | Promise<BudgetPolicy | undefined>;
}

/** Identity carried by one invocation attempt. Matches the gateway identity. */
export interface BudgetInvocationIdentity {
  enterprise_id: string;
  workspace_id: string;
  issue_id: string;
  run_id: string;
  invocation_id: string;
  trace_id: string;
  /** 1-based attempt number within one dispatch call. */
  attempt: number;
  endpoint_id: string;
  provider: string;
  model_id: string;
}

/**
 * What the caller asks the authority to admit. `token_bound` is the
 * conservative input+output bound for this attempt; the authority derives the
 * monetary bound from the policy's conservative ceilings.
 */
export interface BudgetReserveRequest extends BudgetInvocationIdentity {
  token_bound: number;
}

/** The authority's admission decision for one attempt. */
export type BudgetReserveDecision =
  /** Admitted; the reservation id is recorded on the dispatch. */
  | { status: "reserved"; reservation_id: string; replayed: boolean }
  /** Refused; `detail` is safe for audit (no amounts, no policy internals). */
  | { status: "denied"; reason: BudgetDenyReason; detail: string };

/** Usage observed for one attempt, as reported by the provider/transport. */
export interface BudgetUsageObservation {
  /** Chargeable tokens; null means never reported — never a zero stand-in. */
  tokens: number | null;
  completeness: BudgetCompleteness;
}

/** Token account of one reservation. */
export interface BudgetTokenAccount {
  bound: number;
  /** Observed tokens; null until a settlement reports them. */
  used: number | null;
  completeness: BudgetCompleteness | null;
}

/**
 * Monetary account of one reservation. `bound` is the conservative bound;
 * `used` is the settled amount (observed cost or a labelled ceiling
 * estimate). While `used` is null the bound stays committed.
 */
export interface BudgetMoneyAccount {
  currency: string;
  bound: string;
  used: string | null;
  completeness: BudgetCompleteness | null;
  /** Where a settled amount came from; null while unsettled. */
  source: "bound_ceiling" | "cost" | null;
}

export type BudgetReservationStatus =
  /** Reserved, not yet settled. */
  | "held"
  /** All applicable dimensions settled to known/estimated amounts. */
  | "settled"
  /** Outcome, usage or cost is unknown; the bound stays committed. */
  | "reconciling"
  /** The attempt provably never left the gateway; the full bound is refunded. */
  | "released";

/** One admitted invocation attempt and its live accounting state. */
export interface BudgetReservation {
  /** Deterministic identity: one reservation per attempt. */
  reservation_id: string;
  identity: BudgetInvocationIdentity;
  policy_revision: string;
  /** Limits snapshotted at admission; later policy revisions never apply. */
  limits: {
    enterprise: BudgetLimits;
    workspace: BudgetLimits;
    run: BudgetLimits | null;
  };
  /** Conservative per-currency bound rates snapshotted for settlement. */
  cost_ceilings: { currency: string; amount_per_1000_tokens: string }[];
  tokens: BudgetTokenAccount;
  money: BudgetMoneyAccount[];
  status: BudgetReservationStatus;
  created_at: string;
  updated_at: string;
}

/** A settlement reported for one attempt. Exactly one dimension is required. */
export interface BudgetSettlement {
  usage?: BudgetUsageObservation;
  cost?: {
    amounts: CurrencyAmount[];
    completeness: BudgetCompleteness;
    source: "bound_ceiling" | "cost";
  };
}

/** A correction to an already settled dimension (provider reconciliation). */
export interface BudgetCorrection {
  usage?: BudgetUsageObservation;
  cost?: {
    amounts: CurrencyAmount[];
    completeness: BudgetCompleteness;
    source: "bound_ceiling" | "cost";
  };
  /** Why the correction exists; recorded verbatim in the journal. */
  reason: string;
}

/** Journal entry kinds; the journal is the audit trail of every transition. */
export type BudgetJournalKind =
  "reserve" | "settle" | "reconcile" | "reconciliation_required" | "release";

/**
 * One append-only audit entry. Entries are written before the in-memory state
 * changes, so a returned transition is a durable one.
 */
export interface BudgetJournalEntry {
  sequence: number;
  kind: BudgetJournalKind;
  at: string;
  reservation_id: string;
  /** Present on `reserve` only: the immutable reservation as admitted. */
  reservation?: BudgetReservation;
  settlement?: BudgetSettlement;
  correction?: BudgetCorrection;
  /** Free-text reason for a reconciliation requirement or a release. */
  reason?: string;
}

/** Aggregate usage committed at one scope level. */
export interface BudgetScopeUsage {
  level: BudgetScopeLevel;
  enterprise_id: string;
  workspace_id: string;
  /** Present for `run` level. */
  run_id: string | null;
  tokens: number;
  monetary: CurrencyAmount[];
}

/** Authenticated caller context for reads; financial reads stay scoped. */
export interface BudgetAccessScope {
  enterprise_id: string;
  workspace_id: string;
  /** Who is asking; kept for downstream audit of exports and reads. */
  subject: string;
}

/** Filter for scoped reservation reads. */
export interface BudgetReservationFilter {
  enterprise_id?: string;
  workspace_id?: string;
  issue_id?: string;
  run_id?: string;
  invocation_id?: string;
  trace_id?: string;
  attempt?: number;
  status?: BudgetReservationStatus;
  /** Only reservations that are currently reconciling or settled as estimated. */
  needs_reconciliation?: boolean;
  since?: string;
  until?: string;
}

/**
 * The gateway-facing seam. The gateway only reserves, settles observed usage,
 * marks an unknown outcome, or releases a provably unsent attempt; policy,
 * bounds, quotas and audit stay inside the authority.
 */
export interface InvocationBudget {
  reserve(request: BudgetReserveRequest): BudgetReserveDecision | Promise<BudgetReserveDecision>;
  settleUsage(reservationId: string, observation: BudgetUsageObservation): void | Promise<void>;
  /**
   * Retain the reservation because the provider outcome is unknown. The
   * caller must not retry the invocation before reconciliation.
   */
  requireReconciliation(reservationId: string, reason: string): void | Promise<void>;
  /** Release a reservation for an attempt that provably never left the gateway. */
  release(reservationId: string, reason: string): void | Promise<void>;
}
