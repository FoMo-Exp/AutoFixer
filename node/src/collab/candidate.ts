import { digestOf } from "./audit.js";
import type { ApprovalInvalidationReason } from "./contract.js";
import { TASK_EVIDENCE_CONTRACT_VERSION } from "./contract.js";
import { CollabError } from "./errors.js";
import type {
  ArtifactRef,
  CandidateDiff,
  CandidateRecord,
  CandidateValidation,
  ChangeRisk,
  RepositoryRef,
  RiskClass,
} from "./types.js";

/**
 * Immutable-candidate review card (DAT-219, ADR-0007).
 *
 * A card is a projection over one frozen candidate record — never an authority
 * object. It carries the digest of the exact diff, the validation evidence the
 * approval is bound to, the risk decision, and provenance references, so a
 * reviewer can independently recompute the digest from the retained diff
 * instead of trusting a summary line.
 *
 * `candidateNotification` is the out-of-band notification a reviewer receives: a
 * bounded summary plus an authenticated client link. It deliberately carries no
 * diff text, no changed path names, no tool output, and no bearer credential —
 * a notification must never double as an approval.
 */

const NOTIFICATION_SUMMARY_MAX = 240;

/** The exact provenance an independent verification needs. */
export interface CandidateReviewCard {
  contract_version: typeof TASK_EVIDENCE_CONTRACT_VERSION;
  candidate_id: string;
  issue_id: string;
  run_id: string;
  repository: RepositoryRef;
  base_sha: string;
  head_sha: string;
  tree_sha: string;
  diff: CandidateDiff;
  summary: string;
  validation: CandidateValidation;
  risk: ChangeRisk;
  artifacts: ArtifactRef[];
  audit_refs: string[];
  created_at: string;
  invalidated_at: string | null;
  invalidated_reason: ApprovalInvalidationReason | null;
}

/**
 * Project a frozen candidate as the review card the contract serves.
 * Values are copied, so a caller mutating the card cannot mutate history.
 */
export function candidateReviewCard(candidate: CandidateRecord): CandidateReviewCard {
  return {
    contract_version: TASK_EVIDENCE_CONTRACT_VERSION,
    candidate_id: candidate.candidate_id,
    issue_id: candidate.issue_id,
    run_id: candidate.run_id,
    repository: structuredClone(candidate.repository),
    base_sha: candidate.base_sha,
    head_sha: candidate.head_sha,
    tree_sha: candidate.tree_sha,
    diff: structuredClone(candidate.diff),
    summary: candidate.summary,
    validation: structuredClone(candidate.validation),
    risk: structuredClone(candidate.risk),
    artifacts: candidate.artifacts.map((artifact) => ({ ...artifact })),
    audit_refs: [...candidate.audit_refs],
    created_at: candidate.created_at,
    invalidated_at: candidate.invalidated_at,
    invalidated_reason: candidate.invalidated_reason,
  };
}

/**
 * Why a candidate may no longer authorize delivery. A recorded invalidation is
 * permanent; an observed base different from the frozen base is a rebase under
 * the candidate, so its evidence and approval no longer describe the tree that
 * would be delivered.
 */
export type CandidateStaleReason = ApprovalInvalidationReason | "invalidated";

export interface CandidateFreshness {
  current: boolean;
  reason: CandidateStaleReason | null;
}

export function candidateFreshness(
  candidate: CandidateRecord,
  observedBaseSha?: string,
): CandidateFreshness {
  if (candidate.invalidated_at !== null) {
    return { current: false, reason: candidate.invalidated_reason ?? "invalidated" };
  }
  if (observedBaseSha !== undefined && observedBaseSha !== candidate.base_sha) {
    return { current: false, reason: "base_advanced" };
  }
  return { current: true, reason: null };
}

/**
 * Test-evidence digest: sha256 over the exact validation evidence record, in
 * the same canonical JSON the audit chain uses. An approval binds this value,
 * so a changed test result invalidates the approval.
 */
export function validationEvidenceDigest(validation: CandidateValidation): string {
  return digestOf(validation);
}

export interface CandidateNotification {
  type: "candidate.ready_for_review";
  candidate_id: string;
  issue_id: string;
  summary: string;
  changed_paths: number;
  insertions: number;
  deletions: number;
  tests: { total: number; passed: number; failed: number };
  risk_class: RiskClass;
  requires_human_approval: boolean;
  /**
   * Authenticated client deep link to the review card. It selects a workspace
   * and candidate only; approval itself is a confirmed mutation in the client.
   */
  link: string;
}

export interface CandidateNotificationOptions {
  /**
   * Client origin the authenticated session already trusts (for example the
   * workbench's loopback origin). No credential may appear in it.
   */
  clientUrl: string;
}

/**
 * Build the reviewer notification for one frozen candidate.
 *
 * The body is assembled field by field from bounded metadata; it can never
 * echo the diff, a changed path, tool output, or a bearer token into an
 * external channel.
 */
export function candidateNotification(
  candidate: CandidateRecord,
  options: CandidateNotificationOptions,
): CandidateNotification {
  const results = candidate.validation.results;
  const passed = results.filter((result) => result.exit_status === 0).length;
  return {
    type: "candidate.ready_for_review",
    candidate_id: candidate.candidate_id,
    issue_id: candidate.issue_id,
    summary: boundedSummary(candidate.summary),
    changed_paths: candidate.diff.changed_paths.length,
    insertions: candidate.diff.insertions,
    deletions: candidate.diff.deletions,
    tests: { total: results.length, passed, failed: results.length - passed },
    risk_class: candidate.risk.class,
    requires_human_approval: candidate.risk.requires_human_approval,
    link: reviewLink(candidate, options.clientUrl),
  };
}

function boundedSummary(summary: string): string {
  const collapsed = summary.replaceAll(/\s+/g, " ").trim();
  if (collapsed.length <= NOTIFICATION_SUMMARY_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, NOTIFICATION_SUMMARY_MAX - 1)}…`;
}

function reviewLink(candidate: CandidateRecord, clientUrl: string): string {
  const base = clientUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new CollabError("INVALID_INPUT", "client URL must be an absolute URL", {
      client_url: clientUrl,
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CollabError("INVALID_INPUT", "client URL must not embed credentials", {
      client_url: clientUrl,
    });
  }
  // A bare origin and path only: a query string is where a bearer or approval
  // credential would ride, so the deep link never carries one.
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new CollabError("INVALID_INPUT", "client URL must be a bare origin and path", {
      client_url: clientUrl,
    });
  }
  const path =
    `/workspaces/${encodeURIComponent(candidate.workspace.workspace_id)}` +
    `/issues/${encodeURIComponent(candidate.issue_id)}` +
    `/candidates/${encodeURIComponent(candidate.candidate_id)}`;
  return `${base}${path}`;
}

/** Guard for callers that must not use a stale candidate (approval/delivery). */
export function assertCandidateCurrent(candidate: CandidateRecord, observedBaseSha?: string): void {
  const freshness = candidateFreshness(candidate, observedBaseSha);
  if (freshness.current) {
    return;
  }
  throw new CollabError(
    freshness.reason === "base_advanced" ? "BASE_ADVANCED" : "CANDIDATE_INVALID",
    freshness.reason === "base_advanced"
      ? "the repository base advanced after this candidate was frozen"
      : "the candidate was invalidated and can never authorize delivery",
    {
      candidate_id: candidate.candidate_id,
      base_sha: candidate.base_sha,
      ...(observedBaseSha !== undefined ? { observed_base_sha: observedBaseSha } : {}),
      reason: freshness.reason,
    },
  );
}
