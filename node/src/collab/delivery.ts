import type { DeliveryState } from "./contract.js";
import type { DeliveryRecord, RepositoryRef } from "./types.js";
import { AUTOFIXER_BRANCH_PREFIX, autofixerBranchFor } from "./types.js";

/**
 * Broker-controlled delivery helpers (DAT-220, ADR-0007 "Approval and
 * delivery").
 *
 * A delivery operation is created only from a currently approved, frozen
 * candidate and is consumed by exactly one operation identity. The broker —
 * never a client or a model — obtains provider write credentials, and it
 * re-checks approval, permission, the dsh grant, audit availability, branch
 * constraints, and exact candidate identity before each write. There is no
 * merge, main-branch write, self-review, or check-waiver path in this module;
 * the provider contract itself exposes no such operation.
 */

/**
 * Delivery state edges. `unknown` and `partial` leave only through
 * `reconcile_delivery` (a separate command), so a retry can never smuggle a
 * second write past an unresolved outcome.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ["pushing", "failed", "cancelled"],
  pushing: ["opening_pr", "partial", "unknown", "failed", "cancelled"],
  opening_pr: ["delivered", "partial", "unknown", "failed", "cancelled"],
  delivered: [],
  partial: ["unknown", "failed", "cancelled"],
  unknown: ["partial", "failed", "cancelled"],
  failed: [],
  cancelled: [],
};

/** States a reconcile command may leave; never `delivered` from nothing. */
export const RECONCILABLE_STATES: readonly DeliveryState[] = ["unknown", "partial"];

export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

/** Terminal delivery states hold no further provider write. */
export function isTerminalDeliveryState(state: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[state].length === 0;
}

/**
 * Branch constraint: a delivery may only write the issue's own autofixer
 * branch and must never write the repository's base branch. Both checks are
 * exact — a suffix/prefix lookalike is refused.
 */
export function deliveryBranchProblem(
  repository: RepositoryRef,
  issueId: string,
  branch: string,
): string | null {
  if (branch === repository.base_ref) {
    return "delivery never writes the repository base branch";
  }
  if (branch === "main" || branch === "master") {
    return "delivery never writes a protected mainline branch";
  }
  const expected = autofixerBranchFor(issueId);
  if (branch !== expected) {
    return `delivery branch must be the issue autofixer branch ${expected}`;
  }
  if (
    !branch.startsWith(AUTOFIXER_BRANCH_PREFIX) ||
    branch.length <= AUTOFIXER_BRANCH_PREFIX.length
  ) {
    return "delivery branch must use the autofixer namespace";
  }
  return null;
}

/** Whether a URL names the provider the delivery record claims. */
export function providerMatchesRepository(
  provider: "github" | "gitlab",
  repository: RepositoryRef,
): boolean {
  let host: string;
  try {
    host = new URL(repository.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (provider === "github") {
    return host === "github.com";
  }
  return host === "gitlab.com" || host.startsWith("gitlab.");
}

/** The public `Delivery` projection: the internal grant reference stays out. */
export interface DeliveryView {
  delivery_id: string;
  operation_id: string;
  issue_id: string;
  candidate_id: string;
  approval_id: string;
  repository: RepositoryRef;
  target_branch: string;
  head_sha: string;
  provider: "github" | "gitlab";
  state: DeliveryState;
  branch: string | null;
  pr_id: string | null;
  pr_url: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  reconciled_at: string | null;
}

export function deliveryView(record: DeliveryRecord): DeliveryView {
  return {
    delivery_id: record.delivery_id,
    operation_id: record.operation_id,
    issue_id: record.issue_id,
    candidate_id: record.candidate_id,
    approval_id: record.approval_id,
    repository: structuredClone(record.repository),
    target_branch: record.target_branch,
    head_sha: record.head_sha,
    provider: record.provider,
    state: record.state,
    branch: record.branch,
    pr_id: record.pr_id,
    pr_url: record.pr_url,
    error_code: record.error_code,
    created_at: record.created_at,
    updated_at: record.updated_at,
    reconciled_at: record.reconciled_at,
  };
}
