import { validationEvidenceDigest } from "./candidate.js";
import type { ApprovalState } from "./contract.js";
import type { ApprovalBinding, ApprovalRecord, CandidateRecord, UserRef } from "./types.js";

/**
 * Candidate-bound human approval helpers (DAT-220, ADR-0007 "Approval and
 * delivery").
 *
 * Everything here is a pure projection or comparison over records. It grants
 * nothing: the authoritative decision is the append-only `decide_approval`
 * record, and the delivery broker re-checks the effective state and the exact
 * binding before every provider write.
 */

/**
 * Effective approval state at a point in time.
 *
 * `expired` is derived exactly like grant expiry: the finite TTL is part of
 * the record, so an approval whose window passed while the service was down
 * comes back `expired` and can never be used, even if no command recorded the
 * passage. A recorded terminal state is never revived by the clock.
 */
export function approvalStateAt(approval: ApprovalRecord, at: string): ApprovalState {
  if (approval.state === "pending" || approval.state === "approved") {
    return approval.expires_at <= at ? "expired" : approval.state;
  }
  return approval.state;
}

/** The exact binding a candidate freezes; approvals copy these values once. */
export function bindingForCandidate(
  candidate: CandidateRecord,
  targetBranch: string,
): ApprovalBinding {
  return {
    workspace: structuredClone(candidate.workspace),
    repository: structuredClone(candidate.repository),
    candidate_id: candidate.candidate_id,
    head_sha: candidate.head_sha,
    diff_digest: { algorithm: "sha256", value: candidate.diff.digest },
    test_evidence_digest: {
      algorithm: "sha256",
      value: validationEvidenceDigest(candidate.validation),
    },
    target_branch: targetBranch,
    policy_version: candidate.test_policy.policy_version,
  };
}

/**
 * Whether a stored approval still binds exactly this candidate at this base.
 *
 * Any difference — issue base advancing, a candidate invalidated, a different
 * diff or test-evidence digest, a changed target branch, policy version, or
 * repository identity — means the approval describes something other than the
 * revision that would be delivered. Returning the failing field keeps the
 * denial auditable without exposing anything sensitive.
 */
export type BindingMismatch =
  | "candidate_missing"
  | "candidate_invalidated"
  | "base_advanced"
  | "diff_digest"
  | "test_evidence_digest"
  | "head_sha"
  | "target_branch"
  | "policy_version"
  | "repository"
  | "workspace";

export function bindingMismatch(
  approval: ApprovalRecord,
  candidate: CandidateRecord,
  issueBaseSha: string,
): BindingMismatch | null {
  const binding = approval.binding;
  if (candidate.candidate_id !== binding.candidate_id || candidate.issue_id !== approval.issue_id) {
    return "candidate_missing";
  }
  if (candidate.invalidated_at !== null) {
    return "candidate_invalidated";
  }
  if (candidate.base_sha !== issueBaseSha || candidate.base_sha !== binding.repository.base_sha) {
    return "base_advanced";
  }
  if (candidate.head_sha !== binding.head_sha) {
    return "head_sha";
  }
  if (candidate.diff.digest !== binding.diff_digest.value) {
    return "diff_digest";
  }
  if (validationEvidenceDigest(candidate.validation) !== binding.test_evidence_digest.value) {
    return "test_evidence_digest";
  }
  if (candidate.test_policy.policy_version !== binding.policy_version) {
    return "policy_version";
  }
  if (
    candidate.repository.repository_id !== binding.repository.repository_id ||
    candidate.repository.url !== binding.repository.url ||
    candidate.repository.base_ref !== binding.repository.base_ref ||
    candidate.repository.base_sha !== binding.repository.base_sha
  ) {
    return "repository";
  }
  if (
    candidate.workspace.enterprise_id !== binding.workspace.enterprise_id ||
    candidate.workspace.workspace_id !== binding.workspace.workspace_id
  ) {
    return "workspace";
  }
  return null;
}

/** A stable ordering for approvals so pagination and list reads never flap. */
export function compareApprovals(a: ApprovalRecord, b: ApprovalRecord): number {
  return a.requested_at.localeCompare(b.requested_at) || a.approval_id.localeCompare(b.approval_id);
}

export function compareDeliveries(
  a: { created_at: string; delivery_id: string },
  b: { created_at: string; delivery_id: string },
): number {
  return a.created_at.localeCompare(b.created_at) || a.delivery_id.localeCompare(b.delivery_id);
}

/** The public `UserRef` shape, copied so a reader cannot mutate history. */
export function userRef(user: UserRef): UserRef {
  return { id: user.id, display_name: user.display_name };
}
