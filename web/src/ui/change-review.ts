import type {
  Approval,
  ApprovalInvalidationReason,
  ApprovalState,
  Candidate,
  ChangeRiskClass,
  Delivery,
  DeliveryState,
  Digest,
} from "../api/client";
import { shortId } from "./format";

/**
 * Labels for the candidate-bound pre-PR approval lifecycle (ADR-0007). A
 * decision is only ever possible on `pending`; every other state is history or
 * an explicit invalidation, never a reason to re-enable the buttons.
 */
export const APPROVAL_STATE_LABELS: Record<ApprovalState, string> = {
  pending: "Pending decision",
  approved: "Approved",
  rejected: "Rejected",
  invalidated: "Invalidated",
  expired: "Expired",
  consumed: "Consumed by delivery",
  cancelled: "Cancelled",
};

export const INVALIDATION_REASON_LABELS: Record<ApprovalInvalidationReason, string> = {
  content_changed: "content changed after review",
  test_evidence_changed: "test evidence changed",
  base_advanced: "base branch advanced",
  target_changed: "delivery target changed",
  policy_changed: "approval policy changed",
  authority_changed: "approver authority changed",
};

/**
 * Broker delivery states. `partial` and `unknown` are explicit outcomes, not
 * progress toward success: neither is rendered with the delivered tone.
 */
export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  pending: "Pending — broker queued",
  pushing: "Pushing candidate branch",
  opening_pr: "Opening pull request",
  delivered: "Delivered — pull request opened",
  partial: "Partial — branch pushed, PR not confirmed",
  unknown: "Unknown — reconcile before retrying",
  failed: "Failed — no further write",
  cancelled: "Cancelled",
};

export const RISK_CLASS_LABELS: Record<ChangeRiskClass, string> = {
  low: "Low risk",
  elevated: "Elevated risk",
  prohibited: "Prohibited",
};

export type ReviewTone = "neutral" | "active" | "attention" | "danger" | "done" | "unknown";

export function approvalStateTone(state: ApprovalState): ReviewTone {
  switch (state) {
    case "approved":
      return "done";
    case "pending":
      return "attention";
    case "invalidated":
    case "expired":
    case "rejected":
    case "cancelled":
      return "danger";
    case "consumed":
      return "active";
    default:
      return "unknown";
  }
}

export function deliveryStateTone(state: DeliveryState): ReviewTone {
  switch (state) {
    case "delivered":
      return "done";
    case "pending":
    case "pushing":
    case "opening_pr":
      return "active";
    case "partial":
      return "attention";
    case "unknown":
    case "failed":
      return "danger";
    case "cancelled":
      return "neutral";
    default:
      return "unknown";
  }
}

export function riskTone(risk: ChangeRiskClass): ReviewTone {
  switch (risk) {
    case "low":
      return "done";
    case "elevated":
      return "attention";
    case "prohibited":
      return "danger";
    default:
      return "unknown";
  }
}

export function approvalStateLabel(state: string): string {
  return APPROVAL_STATE_LABELS[state as ApprovalState] ?? `Unknown approval state (${state})`;
}

export function deliveryStateLabel(state: string): string {
  return DELIVERY_STATE_LABELS[state as DeliveryState] ?? `Unknown delivery state (${state})`;
}

export function riskClassLabel(risk: string): string {
  return RISK_CLASS_LABELS[risk as ChangeRiskClass] ?? `Unknown risk class (${risk})`;
}

export function invalidatedDetail(approval: Approval): string | null {
  if (!approval.invalidated_reason) return null;
  const reason = INVALIDATION_REASON_LABELS[approval.invalidated_reason];
  return reason ? `Reason: ${reason}.` : `Reason: ${approval.invalidated_reason}.`;
}

export function digestLabel(digest: Digest | null | undefined): string {
  if (!digest || !digest.algorithm || !digest.value) return "No digest recorded";
  return `${digest.algorithm}:${digest.value}`;
}

/**
 * Freeze order is authoritative, but the projection may be merged from more
 * than one page; `created_at` gives the newest candidate, and a later list
 * position breaks a tie so the result is deterministic.
 */
export function latestCandidate(candidates: readonly Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  candidates.forEach((candidate, index) => {
    const parsed = Date.parse(candidate.created_at);
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (!best || time > bestTime || (time === bestTime && index > bestIndex)) {
      best = candidate;
      bestTime = time;
      bestIndex = index;
    }
  });
  return best;
}

export function approvalsForCandidate(
  approvals: readonly Approval[],
  candidateId: string,
): Approval[] {
  return approvals
    .filter((approval) => approval.candidate_id === candidateId)
    .sort((left, right) => Date.parse(right.requested_at) - Date.parse(left.requested_at));
}

export function deliveriesForCandidate(
  deliveries: readonly Delivery[],
  candidateId: string,
): Delivery[] {
  return deliveries.filter((delivery) => delivery.candidate_id === candidateId);
}

/**
 * An approval is bound to one exact revision: candidate identity, head commit,
 * and diff digest. A mismatch is already stale server-side; the UI must not
 * offer a decision that would be refused as APPROVAL_BINDING_STALE.
 */
export function approvalBindingMatches(approval: Approval, candidate: Candidate): boolean {
  const binding = approval.binding;
  return (
    binding.candidate_id === candidate.candidate_id &&
    binding.head_sha === candidate.head_sha &&
    binding.diff_digest.algorithm === candidate.diff.digest_algorithm &&
    binding.diff_digest.value === candidate.diff.digest
  );
}

export interface ApprovalDecisionGate {
  canDecide: boolean;
  /** Why the actions are unavailable; null only when `canDecide` is true. */
  reason: string | null;
  addressedTo: string | null;
}

/**
 * Role gating for the pre-PR approval. The named human approver is the only
 * actor who may decide; the server still enforces identity, repository access,
 * and approval authority, so this only removes impossible actions from the UI.
 */
export function approvalDecisionGate(input: {
  approval: Approval | undefined;
  candidate: Candidate;
  latestCandidateId: string | undefined;
  currentUserId: string | undefined;
  canMutate: boolean;
}): ApprovalDecisionGate {
  const { approval, candidate, latestCandidateId, currentUserId, canMutate } = input;
  const addressedTo = approval?.approver?.display_name ?? null;
  if (!approval) {
    return {
      canDecide: false,
      addressedTo,
      reason:
        "No approval request exists for this candidate. The service creates requests; the workbench never authors one.",
    };
  }
  if (approval.state !== "pending") {
    const detail = invalidatedDetail(approval);
    return {
      canDecide: false,
      addressedTo,
      reason: `This approval is ${approvalStateLabel(approval.state).toLowerCase()}. Only a pending request can be decided.${detail ? ` ${detail}` : ""}`,
    };
  }
  if (candidate.candidate_id !== latestCandidateId) {
    return {
      canDecide: false,
      addressedTo,
      reason: `This candidate was superseded by ${shortId(latestCandidateId, 22)}. Only the current frozen candidate can receive a decision.`,
    };
  }
  if (!approvalBindingMatches(approval, candidate)) {
    return {
      canDecide: false,
      addressedTo,
      reason:
        "The approval binding no longer matches this frozen candidate (head commit or diff digest changed). The service refuses it as stale; a new candidate needs a new request.",
    };
  }
  if (!approval.approver) {
    return {
      canDecide: false,
      addressedTo: null,
      reason:
        "No eligible named human approver is assigned. This issue awaits human triage; an approval is never automatic.",
    };
  }
  if (!canMutate) {
    return {
      canDecide: false,
      addressedTo,
      reason: "Your workspace role is read-only. Approval decisions are disabled.",
    };
  }
  if (!currentUserId) {
    return {
      canDecide: false,
      addressedTo,
      reason:
        "No named human identity is available in this session. An agent or anonymous credential can never approve.",
    };
  }
  if (approval.approver.id !== currentUserId) {
    return {
      canDecide: false,
      addressedTo,
      reason: `This request is addressed to ${approval.approver.display_name}. Only that named approver can decide.`,
    };
  }
  return { canDecide: true, reason: null, addressedTo };
}

export function deliveryNeedsReconcile(state: DeliveryState): boolean {
  return state === "unknown" || state === "partial";
}

export function deliveryOutcomeNote(state: DeliveryState): string | null {
  switch (state) {
    case "partial":
      return "The candidate branch was pushed but the pull request is not confirmed. This is not success, and the branch is not deleted automatically; reconcile before any retry.";
    case "unknown":
      return "The provider outcome is unknown. The service never retries automatically; reconcile against branch and PR evidence before any further write.";
    case "delivered":
      return "The pull request exists. Merging remains the repository's own review, checks, and quorum; this workbench never merges.";
    case "failed":
      return "The broker recorded a failure and performed no further write.";
    default:
      return null;
  }
}
