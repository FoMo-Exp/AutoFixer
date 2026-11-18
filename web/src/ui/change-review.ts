import type {
  Approval,
  ApprovalInvalidationReason,
  ApprovalState,
  Candidate,
  ChangeRiskClass,
  Delivery,
  DeliveryState,
  Digest,
  PullRequestGovernanceObservation,
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
  if (candidate.invalidated_at) {
    return {
      canDecide: false,
      addressedTo,
      reason:
        "This candidate was invalidated and no longer authorizes delivery. A decision on it cannot produce a deliverable revision.",
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

/**
 * A candidate that stopped being valid for delivery. The server refuses the
 * write; showing the reason here prevents an operator from treating a stale
 * frozen revision as deliverable.
 */
export const CANDIDATE_INVALIDATION_LABELS: Record<
  NonNullable<Candidate["invalidated_reason"]>,
  string
> = {
  content_changed: "content changed after the candidate was frozen",
  test_evidence_changed: "test evidence changed after validation",
  base_advanced: "the repository base branch advanced",
  target_changed: "the delivery target changed",
  policy_changed: "the validation policy changed",
  authority_changed: "the approver's authority changed",
};

export function candidateInvalidationNote(candidate: Candidate): string | null {
  if (!candidate.invalidated_at) return null;
  const reason = candidate.invalidated_reason
    ? (CANDIDATE_INVALIDATION_LABELS[candidate.invalidated_reason] ?? candidate.invalidated_reason)
    : "no reason was recorded";
  return `This candidate was invalidated at ${candidate.invalidated_at}: ${reason}. It no longer authorizes delivery; a new revision needs a new preparation run and a new candidate.`;
}

export type GovernanceValidity = PullRequestGovernanceObservation["validity"];
export type GovernanceDimension = Pick<
  PullRequestGovernanceObservation["checks"],
  "state" | "reason"
>;
export type GovernanceReason = NonNullable<GovernanceDimension["reason"]>;
export type GovernanceUnmetCondition = NonNullable<
  PullRequestGovernanceObservation["unmet_condition"]
>;
export type GovernanceNotEvaluated = PullRequestGovernanceObservation["not_evaluated"][number];

export const GOVERNANCE_VALIDITY_LABELS: Record<GovernanceValidity, string> = {
  current: "Current head observed",
  superseded: "Superseded — PR moved to another head",
  unknown: "Unknown — provider answer unreadable",
  blocked: "Blocked — observation refused",
};

export const GOVERNANCE_REASON_LABELS: Record<GovernanceReason, string> = {
  integration_not_configured: "delivery integration is not configured",
  credential_unavailable: "the provider credential is unavailable",
  permission_denied: "the provider denied permission",
  pull_request_not_found: "the pull request no longer exists",
  provider_unavailable: "the provider was unavailable",
  invalid_provider_response: "the provider answer was malformed or truncated",
  head_changed_during_observation: "the PR head changed while it was observed",
  pull_request_state_changed_during_observation:
    "the pull request state changed while it was observed",
};

export const GOVERNANCE_UNMET_CONDITION_LABELS: Record<GovernanceUnmetCondition, string> = {
  head_unavailable: "the PR head could not be read",
  head_changed: "the PR head moved away from the delivered commit",
  governance_blocked: "the observation was blocked",
  governance_unknown: "the provider answer was unknown",
  pull_request_not_open: "the pull request is not open",
  checks_missing: "no check was observed on this head",
  checks_not_passed: "an observed check did not pass",
  review_discussions_unresolved: "a review conversation is unresolved",
  approvals_incomplete: "the approval quorum is not satisfied on this head",
};

export const GOVERNANCE_NOT_EVALUATED_LABELS: Record<GovernanceNotEvaluated, string> = {
  qa_verdict: "QA verdict",
  branch_protection_required_checks: "branch-protection required check set",
  merge_queue_availability: "merge-queue availability",
};

export const GOVERNANCE_CHECK_LABELS: Record<
  PullRequestGovernanceObservation["checks"]["items"][number]["status"],
  string
> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Pending — not passing",
};

export const GOVERNANCE_APPROVAL_LABELS: Record<
  PullRequestGovernanceObservation["approvals"]["items"][number]["decision"],
  string
> = {
  approved: "Approved",
  changes_requested: "Changes requested",
};

export function governanceValidityTone(validity: GovernanceValidity): ReviewTone {
  switch (validity) {
    case "current":
      return "done";
    case "superseded":
      return "neutral";
    case "unknown":
      return "unknown";
    case "blocked":
      return "danger";
    default:
      return "unknown";
  }
}

export function governanceCheckTone(
  status: PullRequestGovernanceObservation["checks"]["items"][number]["status"],
): ReviewTone {
  switch (status) {
    case "passed":
      return "done";
    case "failed":
      return "danger";
    case "pending":
      return "attention";
    default:
      return "unknown";
  }
}

export function governanceDimensionLabel(dimension: GovernanceDimension): string {
  if (dimension.state === "observed") return "Observed";
  const reason = dimension.reason
    ? (GOVERNANCE_REASON_LABELS[dimension.reason] ?? dimension.reason)
    : "no reason was reported";
  return `${dimension.state === "blocked" ? "Blocked" : "Unknown"} — ${reason}`;
}

/**
 * One sentence that never upgrades an observation into a merge claim. Only a
 * current-head observation whose observable conditions hold may say so, and
 * even then the UI repeats the conditions it could not evaluate.
 */
export function governanceHeadline(observation: PullRequestGovernanceObservation): string {
  if (observation.validity === "unknown") {
    return "The provider answer was unknown. No check, review, or discussion on this PR is treated as satisfied.";
  }
  if (observation.validity === "blocked") {
    return "The observation was refused. No check, review, or discussion on this PR is treated as satisfied.";
  }
  if (observation.validity === "superseded") {
    return "The PR moved to another head. Every dimension below belongs to an older commit and is superseded, not current.";
  }
  if (!observation.observations_valid) {
    return "At least one dimension could not be observed on this head. Conditions are not treated as satisfied.";
  }
  if (observation.conditions_satisfied) {
    return "Every condition this read-only observation can verify holds on this exact head. This is not a merge or merge-queue claim; the unevaluated gates are listed below.";
  }
  const unmet = observation.unmet_condition
    ? (GOVERNANCE_UNMET_CONDITION_LABELS[observation.unmet_condition] ??
      observation.unmet_condition)
    : "an observable condition";
  return `An observable condition does not hold: ${unmet}.`;
}

export function notEvaluatedLabels(observation: PullRequestGovernanceObservation): string[] {
  return observation.not_evaluated.map((item) => GOVERNANCE_NOT_EVALUATED_LABELS[item] ?? item);
}

export function deliveryHasPullRequest(delivery: Delivery): boolean {
  return Boolean(delivery.pr_url || delivery.pr_id);
}

export interface DeliveryRequestGate {
  canRequest: boolean;
  approval: Approval | undefined;
  candidate: Candidate | undefined;
  /** Why delivery cannot be requested; null only when `canRequest` is true. */
  reason: string | null;
}

/**
 * The pre-write conditions the workbench can check without guessing: a current
 * approved request, its frozen candidate, and no operation already bound to
 * that approval. Identity, grant validity, branch policy, and provider
 * permissions stay server-authoritative and are never inferred here.
 */
export function deliveryRequestGate(input: {
  approvals: readonly Approval[];
  candidates: readonly Candidate[];
  deliveries: readonly Delivery[];
  canMutate: boolean;
}): DeliveryRequestGate {
  const { approvals, candidates, deliveries, canMutate } = input;
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const deliveryApprovals = new Set(deliveries.map((delivery) => delivery.approval_id));
  const approved = approvals
    .filter(
      (approval) =>
        approval.state === "approved" &&
        !deliveryApprovals.has(approval.approval_id) &&
        candidateById.has(approval.candidate_id),
    )
    .sort((left, right) => Date.parse(right.requested_at) - Date.parse(left.requested_at));

  if (approved.length === 0) {
    return {
      canRequest: false,
      approval: undefined,
      candidate: undefined,
      reason:
        "No current approved candidate awaits delivery. Delivery requires a pending approval decided by the named human approver.",
    };
  }
  const approval = approved[0];
  const candidate = candidateById.get(approval.candidate_id);
  if (!candidate) {
    return {
      canRequest: false,
      approval,
      candidate: undefined,
      reason: "The approved candidate is not in this projection. Refresh before delivering.",
    };
  }
  if (candidate.invalidated_at) {
    return {
      canRequest: false,
      approval,
      candidate,
      reason:
        "The approved candidate is invalidated and no longer authorizes delivery. A new revision needs a new candidate and approval.",
    };
  }
  const newest = latestCandidate(candidates);
  if (newest && candidate.candidate_id !== newest.candidate_id) {
    return {
      canRequest: false,
      approval,
      candidate,
      reason: `This candidate was superseded by ${shortId(newest.candidate_id, 22)}. Only the newest frozen candidate can be delivered.`,
    };
  }
  if (!approvalBindingMatches(approval, candidate)) {
    return {
      canRequest: false,
      approval,
      candidate,
      reason:
        "The approval binding no longer matches the frozen candidate. The service refuses it as stale.",
    };
  }
  if (!canMutate) {
    return {
      canRequest: false,
      approval,
      candidate,
      reason:
        "Your workspace role is read-only. A delivery operator with a separate grant must request delivery.",
    };
  }
  return { canRequest: true, approval, candidate, reason: null };
}
