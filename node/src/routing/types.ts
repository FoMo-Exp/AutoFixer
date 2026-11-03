import type { UserStatus } from "../control-plane/identity-types.js";
import type { WorkspaceRole } from "../control-plane/types.js";
import type { RepositoryMappingStatus } from "../intake/rules.js";

/**
 * Domain records for responsibility routing (DAT-217, ADR-0007 "Routing and
 * responsibility").
 *
 * Routing resolves an assignee deterministically from configured ownership
 * rules, parsed CODEOWNERS, verified provider identities, and blame on the
 * relevant revisions. A routing decision is an assignee decision only: it
 * never grants approval authority, and a transfer never bestows approval
 * rights. Identity follows ADR-0006 — the only account-match key is
 * (provider instance, stable subject); an author email or display name is
 * never an account.
 *
 * Like the collaboration machine, these records grant no authority and the
 * handlers rebuild exactly from the audit log: eligibility facts observed in
 * the directory at command time are captured into the audited payload.
 */

/** Enterprise/workspace pair a routing decision belongs to (ADR-0006). */
export interface RoutingScope {
  enterprise_id: string;
  workspace_id: string;
}

// ---------------------------------------------------------------------------
// Directory seam (ADR-0006 identity and membership facts)
// ---------------------------------------------------------------------------

/** Verified provider identity reference; the only account-match key. */
export interface ProviderIdentityRef {
  provider_instance_id: string;
  subject: string;
}

/** One current workspace member as the directory reports it. */
export interface DirectoryMember {
  user_id: string;
  role: WorkspaceRole;
  status: UserStatus;
}

/** One current workspace team as the directory reports it. */
export interface DirectoryTeam {
  team_id: string;
  name: string;
  responsibility: string | null;
  leader_user_id: string | null;
}

/**
 * Fact source for identity and membership. The routing machine resolves the
 * facts it needs at command time and records them in the audited payload; the
 * handlers never call this seam, so a replay is exact.
 */
export interface RoutingDirectory {
  /**
   * Resolve a verified provider identity to a user. Returns null when no
   * account is linked to this (provider instance, stable subject).
   */
  resolveProviderIdentity(ref: ProviderIdentityRef): string | null;
  /** Current members of the workspace. */
  listMembers(scope: RoutingScope): DirectoryMember[];
  /** Current teams of the workspace. */
  listTeams(scope: RoutingScope): DirectoryTeam[];
}

/** Directory facts captured into an audited command payload. */
export interface ResolvedFacts {
  /** Sorted by user_id. */
  members: DirectoryMember[];
  /** Sorted by team_id. */
  teams: DirectoryTeam[];
  /** One entry per referenced identity, sorted by (provider_instance_id, subject). */
  identity_matches: IdentityMatch[];
}

export interface IdentityMatch {
  ref: ProviderIdentityRef;
  user_id: string | null;
}

// ---------------------------------------------------------------------------
// Routing policy (versioned workspace configuration)
// ---------------------------------------------------------------------------

export type OwnerRef = { kind: "user"; user_id: string } | { kind: "team"; team_id: string };

/** A configured ownership or CODEOWNERS path rule. */
export interface PathRule {
  rule_id: string;
  pattern: string;
  owner: OwnerRef;
}

/** A team rule: matching paths route to the team's active leader. */
export interface TeamRule {
  rule_id: string;
  pattern: string;
  team_id: string;
}

export interface TransferPolicy {
  /** Roles that may propose a transfer ("members may propose transfer"). */
  propose_roles: WorkspaceRole[];
  /** Roles that may confirm a transfer proposed for someone else. */
  confirm_roles: WorkspaceRole[];
}

/**
 * The workspace's routing policy. Registered on the machine (never supplied
 * per command, so a caller cannot shop for a friendlier policy) and recorded
 * with its version and digest on every decision.
 */
export interface RoutingPolicy {
  policy_version: string;
  ownership_rules: PathRule[];
  codeowners_rules: PathRule[];
  team_rules: TeamRule[];
  confidence: {
    /** Minimum top score (substantive-code weight) for an automatic assignee. */
    min_top_weight: number;
    /** Minimum top-minus-second score gap for an automatic assignee. */
    min_margin: number;
  };
  /** Roles eligible for the owner/admin triage queue. */
  triage_roles: WorkspaceRole[];
  /** Roles holding explicit approval authority (routing never grants it). */
  approval_roles: WorkspaceRole[];
  transfer: TransferPolicy;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type ChangeClassification = "substantive" | "cosmetic" | "bulk";

/**
 * One affected file. `weight` is the weight of the affected substantive code
 * as the evidence layer computed it — never a raw line count. Cosmetic and
 * bulk changes are ignored by the resolver and recorded as such.
 */
export interface AffectedFile {
  path: string;
  classification: ChangeClassification;
  weight: number;
}

/**
 * One blame attribution on a relevant revision. `author` is the verified
 * provider identity; when the commit only carries an unverified label (an
 * email or display name) it stays null and `author_label` records the label —
 * an author email is never an account.
 */
export interface BlameFact {
  path: string;
  revision: string;
  author: ProviderIdentityRef | null;
  author_label: string;
  weight: number;
}

export interface RouteEvidence {
  affected_files: AffectedFile[];
  blame: BlameFact[];
}

/** Service-to-repository mapping status as intake resolved it. */
export interface ServiceMapping {
  service: string | null;
  status: RepositoryMappingStatus;
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

export type CandidateSourceKind = "ownership_rule" | "codeowners_rule" | "team_leader" | "blame";

/** Provenance of one candidate signal. */
export interface CandidateSource {
  kind: CandidateSourceKind;
  /** Rule that contributed the signal; null for blame. */
  rule_id: string | null;
  paths: string[];
}

export type CandidateEligibility = "eligible" | "not_a_member" | "suspended" | "viewer_role";

export interface RoutingCandidate {
  user_id: string;
  /** ownership_weight + blame_weight, in substantive-code weight units. */
  score: number;
  ownership_weight: number;
  blame_weight: number;
  sources: CandidateSource[];
  eligibility: CandidateEligibility;
}

export interface UnmatchedIdentity {
  author_label: string;
  ref: ProviderIdentityRef | null;
  path: string;
  reason: "unverified_author_identity" | "identity_not_found";
}

export interface TeamGap {
  kind: CandidateSourceKind;
  rule_id: string;
  team_id: string;
  paths: string[];
  reason: "team_missing" | "leader_missing" | "leader_not_eligible";
}

export interface IgnoredChange {
  path: string;
  classification: "cosmetic" | "bulk";
}

export type RoutingOutcome = "assign" | "manual_triage" | "triage_queue" | "unassigned_alert";

export type RoutingConfidence = "high" | "low" | "none";

export type FallbackReason = "service_unmapped" | "no_candidates" | "top_candidate_ineligible";

/**
 * One deterministic routing decision. Records the policy version and digest,
 * the evidence digest, every candidate with its sources and eligibility, the
 * ambiguity (score margin versus the policy thresholds), unmatched
 * identities, team gaps, and ignored changes — the full audit trail the
 * decision was made from.
 */
export interface RoutingDecision {
  decision_id: string;
  issue_id: string;
  scope: RoutingScope;
  service_mapping: ServiceMapping;
  policy_version: string;
  policy_digest: string;
  evidence_digest: string;
  candidates: RoutingCandidate[];
  unmatched_identities: UnmatchedIdentity[];
  team_gaps: TeamGap[];
  ignored_changes: IgnoredChange[];
  confidence: {
    level: RoutingConfidence;
    top_weight: number;
    margin: number;
    min_top_weight: number;
    min_margin: number;
  };
  fallback_reason: FallbackReason | null;
  outcome: RoutingOutcome;
  assignee_user_id: string | null;
  /** Eligible owner/admin users the issue may be triaged to; empty is an alert. */
  triage_owners: string[];
  at: string;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * A model recommendation recorded as a claim: `asserted_confidence` is the
 * model's own assertion and is never used by routing thresholds or checks.
 */
export interface Recommendation {
  recommended_user_id: string;
  rationale: string | null;
  asserted_confidence: number | null;
}

export type AssignmentSource = "routing" | "llm_recommendation" | "transfer";

/**
 * The current assignee of an issue. An assignment is only ever an assignee:
 * it confers no approval authority and no repository access.
 */
export interface AssignmentRecord {
  issue_id: string;
  assignee_user_id: string;
  source: AssignmentSource;
  decision_id: string | null;
  transfer_id: string | null;
  policy_version: string | null;
  assigned_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Manual transfer
// ---------------------------------------------------------------------------

export type TransferStatus = "proposed" | "confirmed" | "rejected";

/**
 * A proposed transfer. Members propose; the current assignee or an
 * owner/admin confirms under workspace policy. The destination is validated
 * at proposal and re-validated at confirmation; a transfer never bestows
 * approval rights.
 */
export interface TransferProposal {
  transfer_id: string;
  scope: RoutingScope;
  issue_id: string;
  /** Current assignee at proposal time; null proposes taking an unassigned issue. */
  from_user_id: string | null;
  to_user_id: string;
  reason: string;
  evidence: string | null;
  proposed_by: string;
  status: TransferStatus;
  policy_version: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// ---------------------------------------------------------------------------
// Approval addressing
// ---------------------------------------------------------------------------

export type ApprovalRequestStatus = "pending" | "invalidated";

export type ApprovalInvalidationReason = "authority_revoked" | "reviewer_changed";

/**
 * Who a pending approval request is addressed to. Routing only addresses the
 * request to an eligible reviewer holding explicit approval authority; the
 * approval semantics themselves (candidate binding, TTL, delivery) are the
 * approval contract's concern.
 */
export interface ApprovalRequestRecord {
  request_id: string;
  scope: RoutingScope;
  issue_id: string;
  addressee_user_id: string;
  status: ApprovalRequestStatus;
  policy_version: string;
  addressed_at: string;
  addressed_by: string;
  invalidated_at: string | null;
  invalidation_reason: ApprovalInvalidationReason | null;
  /** The newly addressed request created by the invalidation; null when unaddressable. */
  readdressed_request_id: string | null;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type RoutingAlertKind = "unassigned_no_eligible_owner" | "approval_unaddressable";

/** An alert for the enterprise operator (ADR-0007: "remain unassigned and alert"). */
export interface RoutingAlert {
  kind: RoutingAlertKind;
  scope: RoutingScope;
  issue_id: string | null;
  subject_user_id: string | null;
  detail: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Machine state
// ---------------------------------------------------------------------------

/** Everything the routing machine owns durably. Rebuilt only from the audit log. */
export interface RoutingState {
  /** `${enterprise_id}:${workspace_id}` -> registered policy. */
  policies: Map<string, RoutingPolicy>;
  decisions: Map<string, RoutingDecision>;
  /** issue id -> current assignment. */
  assignments: Map<string, AssignmentRecord>;
  transfers: Map<string, TransferProposal>;
  approvals: Map<string, ApprovalRequestRecord>;
  alerts: RoutingAlert[];
  /** operation id -> payload fingerprint; binds one id to exactly one payload. */
  attempts: Map<string, string>;
  /** operation id -> recorded result of the applied attempt. */
  results: Map<string, unknown>;
}

export function emptyRoutingState(): RoutingState {
  return {
    policies: new Map(),
    decisions: new Map(),
    assignments: new Map(),
    transfers: new Map(),
    approvals: new Map(),
    alerts: [],
    attempts: new Map(),
    results: new Map(),
  };
}

export function policyKey(scope: RoutingScope): string {
  return `${scope.enterprise_id}:${scope.workspace_id}`;
}
