/**
 * Ranking primitives for the retrieval read path (DAT-236).
 *
 * Order is fixed: hard filters first (workspace, applicability, status,
 * sensitivity, validity, approval), then scoring. A filter failure is never
 * traded against a high score, and an item that fails a filter is not counted
 * as "omitted" because it was never eligible.
 */

import type { WorkspaceRole } from "../../control-plane/types.js";
import type {
  MemoryApplicability,
  MemoryEvidenceType,
  MemoryItemRecord,
  MemoryItemVersion,
  MemorySensitivity,
  MemoryTrust,
} from "../types.js";
import type { RetrievalPolicy, MemoryScoreBreakdown, MemoryTier } from "./types.js";
import { tierOf } from "./types.js";
import { estimateTokens, recencyScore } from "./text.js";

const SENSITIVITY_RANK: Record<MemorySensitivity, number> = {
  internal: 0,
  confidential: 1,
  restricted: 2,
};

/**
 * Sensitivity ceiling by workspace role. `restricted` is never reachable from
 * retrieval: it needs separate authorization (ADR-0005/0008), not a higher
 * workspace role.
 */
export function sensitivityCeiling(role: WorkspaceRole): MemorySensitivity {
  switch (role) {
    case "owner":
    case "admin":
      return "confidential";
    case "member":
    case "viewer":
      return "internal";
  }
}

export function withinSensitivityCeiling(
  sensitivity: MemorySensitivity,
  role: WorkspaceRole,
): boolean {
  return SENSITIVITY_RANK[sensitivity] <= SENSITIVITY_RANK[sensitivityCeiling(role)];
}

/** The sensitivity classes a role may read, for scoped index/count queries. */
export function allowedSensitivities(role: WorkspaceRole): MemorySensitivity[] {
  const ceiling = SENSITIVITY_RANK[sensitivityCeiling(role)];
  return (Object.keys(SENSITIVITY_RANK) as MemorySensitivity[]).filter(
    (sensitivity) => SENSITIVITY_RANK[sensitivity] <= ceiling,
  );
}

/**
 * Applicability is a filter, not a hint: an item scoped to a team, path,
 * language, or task family applies only when the request context matches.
 * Empty item scope means broad applicability.
 */
export function applicabilityMatches(
  itemScope: MemoryApplicability,
  requestScope: MemoryApplicability,
): boolean {
  if (itemScope.team_id !== undefined && itemScope.team_id.length > 0) {
    if (itemScope.team_id !== requestScope.team_id) {
      return false;
    }
  }
  if (itemScope.language !== undefined && itemScope.language.length > 0) {
    if (itemScope.language !== requestScope.language) {
      return false;
    }
  }
  if (itemScope.task_family !== undefined && itemScope.task_family.length > 0) {
    if (itemScope.task_family !== requestScope.task_family) {
      return false;
    }
  }
  if (itemScope.path_prefix !== undefined && itemScope.path_prefix.length > 0) {
    const requested = requestScope.path_prefix;
    if (requested === undefined || requested.length === 0) {
      return false;
    }
    const normalizedItem = itemScope.path_prefix.replace(/\/+$/, "");
    const normalizedRequested = requested.replace(/\/+$/, "");
    if (
      normalizedRequested !== normalizedItem &&
      !normalizedRequested.startsWith(`${normalizedItem}/`)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a version carries a human approval. A named review stamp approves
 * exactly one version; human authorship is itself a human act.
 */
export function isApproved(version: MemoryItemVersion): boolean {
  if (version.review !== null) {
    return true;
  }
  return version.trust === "human";
}

/** Kinds whose content changes agent behavior enough to need named approval. */
const PROCEDURAL_KINDS: ReadonlySet<string> = new Set([
  "lesson",
  "playbook",
  "anti_pattern",
  "policy",
]);

/**
 * Approval for injection. Procedural content (lessons, playbooks,
 * anti-patterns, policy) needs a named human approval on that exact version.
 * Facts and episodes are approved by their validated promotion to `active`
 * (ADR-0009 permits automatic promotion for low-risk facts); a candidate
 * item is never approved.
 */
export function approvalSatisfied(version: MemoryItemVersion, status: string): boolean {
  if (status !== "active") {
    return false;
  }
  return PROCEDURAL_KINDS.has(version.kind) ? isApproved(version) : true;
}

/**
 * L4 policy must be human-authored and human-approved. An agent-authored
 * "policy" is not institutional policy and is never injected as mandatory.
 */
export function isEligiblePolicy(version: MemoryItemVersion, status: string): boolean {
  return status === "active" && version.kind === "policy" && isApproved(version);
}

export interface EligibilityContext {
  now: Date;
  role: WorkspaceRole;
  includeCandidates: boolean;
  requestScope: MemoryApplicability;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Injected at reduced weight as unapproved. */
  candidate: boolean;
  tier: MemoryTier;
  approved: boolean;
}

export function assessEligibility(
  record: MemoryItemRecord,
  context: EligibilityContext,
): EligibilityResult {
  const version = record.current;
  const tier = tierOf(version.kind);
  const status = record.item.status;
  const approved = approvalSatisfied(version, status);
  const denied: EligibilityResult = { eligible: false, candidate: false, tier, approved };

  // Status: only active items are authoritative; candidates may enter at
  // reduced weight. proposed/deprecated/retired/quarantined are never eligible.
  if (status !== "active" && status !== "candidate") {
    return denied;
  }
  // Validity window is evaluated against the request's clock.
  const nowMs = context.now.getTime();
  const fromMs = Date.parse(version.valid_from);
  if (!Number.isFinite(fromMs) || fromMs > nowMs) {
    return denied;
  }
  if (version.valid_to !== null) {
    const toMs = Date.parse(version.valid_to);
    if (!Number.isFinite(toMs) || toMs <= nowMs) {
      return denied;
    }
  }
  if (!withinSensitivityCeiling(version.sensitivity, context.role)) {
    return denied;
  }
  if (!applicabilityMatches(version.scope, context.requestScope)) {
    return denied;
  }
  if (version.kind === "policy" && !isEligiblePolicy(version, status)) {
    return denied;
  }

  // Candidate status is always candidate-tier. An active item without human
  // approval (agent-authored procedural content) is demoted rather than
  // trusted; a fact with agent trust is still labeled unapproved.
  const candidate = status === "candidate" || !approved;
  if (candidate && !context.includeCandidates) {
    return denied;
  }
  return { eligible: true, candidate, tier, approved };
}

/** Evidence classes that raise provenance trust, strongest first. */
const EVIDENCE_BOOST_ORDER: readonly MemoryEvidenceType[] = [
  "reviewer_decision",
  "test",
  "pr",
  "incident",
  "issue",
  "commit",
  "run",
];

export interface ScoreInput {
  record: MemoryItemRecord;
  relevance: number;
  supportingEvidence: readonly MemoryEvidenceType[];
  contradictions: number;
  now: Date;
  policy: RetrievalPolicy;
  candidate: boolean;
}

/** Deterministic weighted score, including the candidate down-weighting. */
export function scoreMemoryItem(input: ScoreInput): MemoryScoreBreakdown {
  const { record, policy, now } = input;
  const weights = policy.weights;
  const bounds = policy.bounds;
  const item = record.item;
  const version = record.current;

  const reviewerSalient = input.supportingEvidence.includes("reviewer_decision");
  const importance = Math.max(
    0,
    Math.min(
      1,
      Math.min(1, item.support_count / 3) +
        (reviewerSalient ? 0.2 : 0) +
        (input.supportingEvidence.includes("pr") ? 0.1 : 0),
    ),
  );
  const recency = recencyScore(version.valid_from, now, bounds.recency_half_life_days);
  const confidence = Math.max(
    -1,
    Math.min(1, (item.support_count - item.contradiction_count) / Math.max(1, item.support_count)),
  );

  let trust = bounds.trust_class_weights[version.trust as MemoryTrust] ?? 0;
  for (const evidence of EVIDENCE_BOOST_ORDER) {
    if (input.supportingEvidence.includes(evidence)) {
      trust += bounds.evidence_class_boost[evidence];
      break;
    }
  }
  trust = Math.max(0, Math.min(1, trust));

  const contradictionPenalty = Math.max(
    0,
    Math.min(1, input.contradictions / 2 + Math.min(1, item.contradiction_count / 4)),
  );

  let total =
    weights.relevance * input.relevance +
    weights.importance * importance +
    weights.recency * recency +
    weights.confidence * confidence +
    weights.trust * trust -
    weights.contradiction * contradictionPenalty;
  if (input.candidate) {
    total *= bounds.candidate_weight;
  }
  return {
    relevance: round(input.relevance),
    importance: round(importance),
    recency: round(recency),
    confidence: round(confidence),
    trust: round(trust),
    contradiction_penalty: round(contradictionPenalty),
    total: round(total),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Token footprint of one item, including its preconditions and citations. */
export function itemTokenEstimate(record: MemoryItemRecord): number {
  const version = record.current;
  const text = [
    version.statement,
    ...version.preconditions,
    version.scope.team_id ?? "",
    version.scope.path_prefix ?? "",
    version.scope.language ?? "",
    version.scope.task_family ?? "",
  ].join("\n");
  return estimateTokens(text) + 24;
}
