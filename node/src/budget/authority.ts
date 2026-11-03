/**
 * The budget authority (DAT-229).
 *
 * One authority per deployment enforces enterprise, workspace and run budgets
 * with a single reserve → settle → reconcile/release lifecycle. It resolves
 * the policy for the authenticated scope, computes a conservative bound,
 * admits or denies the attempt, and records every transition in the append-
 * only journal.
 *
 * The gateway sees only {@link InvocationBudget}: reserve before dispatch,
 * settle observed usage afterwards, mark an unknown outcome, or release an
 * attempt that provably never left the gateway. Limits, ceilings, quotas and
 * audit stay here.
 */
import { normalizeCurrencyAmounts, type CurrencyAmount } from "./amount.js";
import { computeBudgetBound, estimateCostFromCeilings } from "./bound.js";
import { BudgetConflictError, BudgetQuotaError } from "./errors.js";
import type { BudgetStore } from "./store.js";
import { budgetReservationId } from "./store.js";
import type {
  BudgetAccessScope,
  BudgetCorrection,
  BudgetInvocationIdentity,
  BudgetPolicy,
  BudgetPolicyResolver,
  BudgetReservation,
  BudgetReserveDecision,
  BudgetReserveRequest,
  BudgetScopeLevel,
  BudgetScopeUsage,
  BudgetSettlement,
  BudgetUsageObservation,
  InvocationBudget,
} from "./types.js";

export interface BudgetAuthorityOptions {
  store: BudgetStore;
  policyResolver: BudgetPolicyResolver;
}

function identityOf(request: BudgetReserveRequest): BudgetInvocationIdentity {
  return {
    enterprise_id: request.enterprise_id,
    workspace_id: request.workspace_id,
    issue_id: request.issue_id,
    run_id: request.run_id,
    invocation_id: request.invocation_id,
    trace_id: request.trace_id,
    attempt: request.attempt,
    endpoint_id: request.endpoint_id,
    provider: request.provider,
    model_id: request.model_id,
  };
}

function limitsSnapshot(policy: BudgetPolicy): BudgetReservation["limits"] {
  return {
    enterprise: policy.enterprise,
    workspace: policy.workspace,
    run: policy.run,
  };
}

export class BudgetAuthority implements InvocationBudget {
  private readonly store: BudgetStore;
  private readonly policyResolver: BudgetPolicyResolver;

  constructor(options: BudgetAuthorityOptions) {
    this.store = options.store;
    this.policyResolver = options.policyResolver;
  }

  /**
   * Admit one attempt against the resolved policy.
   *
   * A missing policy, an unbounded monetary limit, a token ceiling breach, or
   * an exhausted scope all deny. A denial never shrinks the requested bound
   * and never reserves partial budget.
   */
  async reserve(request: BudgetReserveRequest): Promise<BudgetReserveDecision> {
    const policy = await this.policyResolver.resolve({
      enterpriseId: request.enterprise_id,
      workspaceId: request.workspace_id,
    });
    if (policy === undefined) {
      return {
        status: "denied",
        reason: "BUDGET_POLICY_UNAVAILABLE",
        detail: "no budget policy is configured for this scope",
      };
    }
    const bound = computeBudgetBound(policy, request);
    if (bound.status === "denied") {
      return { status: "denied", reason: bound.reason, detail: bound.detail };
    }
    try {
      const admitted = this.store.reserve({
        identity: identityOf(request),
        policy_revision: policy.revision,
        limits: limitsSnapshot(policy),
        cost_ceilings: bound.bound.cost_ceilings,
        token_bound: bound.bound.token_bound,
        monetary_bound: bound.bound.monetary_bound,
      });
      return {
        status: "reserved",
        reservation_id: admitted.reservation.reservation_id,
        replayed: admitted.replayed,
      };
    } catch (error) {
      if (error instanceof BudgetQuotaError) {
        return {
          status: "denied",
          reason: error.reason,
          detail: error.message,
        };
      }
      // A conflicting redelivery of the same attempt is a contract error, not
      // a budget refusal: never rewrite committed accounting into a denial.
      if (error instanceof BudgetConflictError) {
        throw error;
      }
      throw error;
    }
  }

  /**
   * Settle observed usage for one attempt. The monetary dimension is priced
   * at the reservation's snapshotted conservative ceiling and labelled
   * `estimated`; it remains reconcilable to exact provider cost later.
   */
  settleUsage(reservationId: string, observation: BudgetUsageObservation): void {
    const reservation = this.requireReservation(reservationId);
    const settlement: BudgetSettlement = { usage: observation };
    if (reservation.cost_ceilings.length > 0) {
      if (observation.tokens !== null && observation.completeness !== "unknown") {
        settlement.cost = {
          amounts: estimateCostFromCeilings(reservation.cost_ceilings, observation.tokens),
          completeness: "estimated",
          source: "bound_ceiling",
        };
      } else {
        // Usage never observed: every reserved currency stays unknown and the
        // bound remains committed. Never turn missing usage into zero cost.
        settlement.cost = {
          amounts: [],
          completeness: "unknown",
          source: "bound_ceiling",
        };
      }
    }
    this.store.settle(reservationId, settlement);
  }

  /** Retain the reservation while the provider outcome is unknown. */
  requireReconciliation(reservationId: string, reason: string): void {
    this.store.requireReconciliation(reservationId, reason);
  }

  /** Refund a reservation for an attempt that never left the gateway. */
  release(reservationId: string, reason: string): void {
    this.store.release(reservationId, reason);
  }

  /**
   * Correct the monetary dimension with exact provider cost once it is known.
   * The correction is appended; the original settlement stays in the journal.
   */
  reconcileCost(
    reservationId: string,
    amounts: readonly CurrencyAmount[],
    completeness: "known" | "estimated" | "unknown",
    reason: string,
    source: "cost" | "bound_ceiling" = "cost",
  ): void {
    this.requireReservation(reservationId);
    const normalized = normalizeCurrencyAmounts(amounts, "cost correction");
    const correction: BudgetCorrection = {
      cost: { amounts: normalized, completeness, source },
      reason,
    };
    this.store.reconcile(reservationId, correction);
  }

  /** Correct the token dimension with reconciled provider usage. */
  reconcileUsage(reservationId: string, observation: BudgetUsageObservation, reason: string): void {
    this.requireReservation(reservationId);
    this.store.reconcile(reservationId, { usage: observation, reason });
  }

  /** Scoped committed usage for dashboards and tests. */
  scopeUsage(access: BudgetAccessScope, level: BudgetScopeLevel, runId?: string): BudgetScopeUsage {
    return this.store.scopeUsage(access, level, runId);
  }

  /** Reservation id for an attempt, without admitting it. */
  reservationIdFor(identity: { invocation_id: string; attempt: number }): string {
    return budgetReservationId(identity.invocation_id, identity.attempt);
  }

  private requireReservation(reservationId: string): BudgetReservation {
    const reservation = this.store.inspect(reservationId);
    if (reservation === undefined) {
      throw new BudgetConflictError(`unknown budget reservation ${reservationId}`);
    }
    return reservation;
  }
}

export function createBudgetAuthority(options: BudgetAuthorityOptions): BudgetAuthority {
  return new BudgetAuthority(options);
}
