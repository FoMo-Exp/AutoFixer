/**
 * Bounded recursive self-improvement types (DAT-238).
 *
 * RSI governs proposals that change memory artifacts or retrieval policy. It
 * never owns evaluation data, never evaluates itself, and never reaches the
 * guardrails listed in ADR-0009's risk ladder D. Every promotion is either an
 * automatic promotion of a bounded class-A retrieval change that the workspace
 * enabled, or a human-approved change backed by an offline replay over a
 * workspace golden set plus a hidden holdout the proposer cannot read.
 */

import type { UserId, WorkspaceRole } from "../../control-plane/types.js";
import type { MemoryApplicability } from "../types.js";
import type { RetrievalPolicy } from "../retrieval/index.js";

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const RSI_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Risk ladder (ADR-0009). The target determines the risk; a caller never
// chooses its own risk class, and D targets are rejected outright.
// ---------------------------------------------------------------------------

export const RSI_TARGETS = [
  // A — automatic promotion permitted when the workspace enables it.
  "retrieval_weights",
  "ranking_tiebreakers",
  // B — offline evaluation plus named human approval.
  "lesson",
  "playbook",
  "prompt_hint",
  // C — offline evaluation plus two-key human approval.
  "retrieval_bounds",
  "scope_taxonomy",
  "consolidation_thresholds",
  // D — forbidden to the learning loop; a normal reviewed change only.
  "capability_grant",
  "approval_rules",
  "evidence_schema",
  "evaluation_definition",
  "safety_policy",
  "merge_deploy",
] as const;
export type RsiTarget = (typeof RSI_TARGETS)[number];

export const RSI_RISKS = ["A", "B", "C", "D"] as const;
export type RsiRisk = (typeof RSI_RISKS)[number];

export const RSI_TARGET_RISK: Readonly<Record<RsiTarget, RsiRisk>> = Object.freeze({
  retrieval_weights: "A",
  ranking_tiebreakers: "A",
  lesson: "B",
  playbook: "B",
  prompt_hint: "B",
  retrieval_bounds: "C",
  scope_taxonomy: "C",
  consolidation_thresholds: "C",
  capability_grant: "D",
  approval_rules: "D",
  evidence_schema: "D",
  evaluation_definition: "D",
  safety_policy: "D",
  merge_deploy: "D",
});

/** Artifact a proposal changes. A and C targets change retrieval policy. */
export type RsiArtifactKind = "retrieval_policy" | "memory_item";

export function artifactKindFor(target: RsiTarget): RsiArtifactKind {
  return RSI_TARGET_RISK[target] === "B" ? "memory_item" : "retrieval_policy";
}

// ---------------------------------------------------------------------------
// Proposal lifecycle
// ---------------------------------------------------------------------------

export const RSI_PROPOSAL_STATUSES = [
  "proposed",
  "awaiting_approval",
  "ready",
  "canary",
  "promoted",
  "rolled_back",
  "blocked",
] as const;
export type RsiProposalStatus = (typeof RSI_PROPOSAL_STATUSES)[number];

export const RSI_PROPOSER_KINDS = ["agent", "human"] as const;
export type RsiProposerKind = (typeof RSI_PROPOSER_KINDS)[number];

export interface RsiProposer {
  id: UserId;
  kind: RsiProposerKind;
  /** Model identifier when an agent proposed the change. */
  model?: string;
}

export interface CreateRsiProposalInput {
  title: string;
  summary: string;
  /** Human-readable artifact diff; never contains holdout case content. */
  diff: string;
  target: RsiTarget;
  proposer: RsiProposer;
  /**
   * For retrieval-policy targets: the complete candidate policy. It is
   * validated against the same hard ceilings as a stored policy and remains
   * unpublished until promotion.
   */
  candidate_policy?: unknown;
  /** For memory-item targets: the candidate item version being proposed. */
  memory_item?: { item_id: string; item_version: number };
}

// ---------------------------------------------------------------------------
// Independent evaluation
// ---------------------------------------------------------------------------

/**
 * Who independently established the outcome. Agent self-report is not in this
 * vocabulary: a self-grade can never be recorded, let alone pass a gate.
 */
export const RSI_VERIFIER_KINDS = ["test", "qa_disposition", "reviewer_acceptance"] as const;
export type RsiVerifierKind = (typeof RSI_VERIFIER_KINDS)[number];

export interface RsiVerifier {
  kind: RsiVerifierKind;
  /** Identity of the verifier (human, QA agent, or test harness owner). */
  id: UserId;
  /** Evidence pointer: test run, QA comment, or reviewer decision. */
  reference: string;
}

export const RSI_DATASETS = ["golden", "holdout"] as const;
export type RsiDataset = (typeof RSI_DATASETS)[number];

export const RSI_EVAL_VERDICTS = ["pass", "fail", "inconclusive"] as const;
export type RsiEvalVerdict = (typeof RSI_EVAL_VERDICTS)[number];

export interface RsiEvalCase {
  case_id: string;
  dataset: RsiDataset;
  query: string;
  scope: MemoryApplicability;
  role: WorkspaceRole;
  /** Item ids the bundle must contain for the case to succeed. */
  expected_item_ids: string[];
  /** Item ids whose injection is a hard failure (safety event). */
  forbidden_item_ids: string[];
}

export interface RsiEvalMetrics {
  sample_size: number;
  baseline_successes: number;
  candidate_successes: number;
  baseline_rework: number;
  candidate_rework: number;
  baseline_cost: number;
  candidate_cost: number;
  safety_events: number;
  success_delta: number;
  delta_ci_low: number;
  delta_ci_high: number;
}

export interface RsiEvaluationRecord extends RsiEvalMetrics {
  evaluation_id: string;
  proposal_id: string;
  proposal_version: number;
  dataset: RsiDataset;
  holdout_used: boolean;
  verdict: RsiEvalVerdict;
  verifier: RsiVerifier;
  policy_version: number;
  policy_hash: string;
  memory_version: string;
  reflection_tokens: number;
  created_at: string;
  created_by: UserId;
}

export interface RsiEvaluationRequest {
  verifier: RsiVerifier;
  /** Datasets to replay. Defaults to both, which the canary gate requires. */
  datasets?: RsiDataset[];
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const RSI_APPROVAL_KEYS = ["single", "owner", "reviewer"] as const;
export type RsiApprovalKey = (typeof RSI_APPROVAL_KEYS)[number];

export interface RsiApproval {
  approval_id: string;
  proposal_id: string;
  proposal_version: number;
  approval_key: RsiApprovalKey;
  approver_id: UserId;
  role: WorkspaceRole;
  note: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Canary rollout
// ---------------------------------------------------------------------------

/** 10% → 50% → 100%; a stage advances only after its minimum sample. */
export const RSI_CANARY_STAGES = [10, 50, 100] as const;
export type RsiCanaryStage = (typeof RSI_CANARY_STAGES)[number];

export const RSI_ROLLOUT_STATUSES = ["canary", "promoted", "rolled_back"] as const;
export type RsiRolloutStatus = (typeof RSI_ROLLOUT_STATUSES)[number];

export interface RsiRollout {
  rollout_id: string;
  proposal_id: string;
  stage: RsiCanaryStage;
  status: RsiRolloutStatus;
  baseline_policy_version: number;
  /** Canonical hash of the candidate policy, or of the candidate item version. */
  candidate_hash: string;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

export interface RsiCanaryObservationInput {
  sample_size: number;
  baseline_successes: number;
  candidate_successes: number;
  baseline_rework?: number;
  candidate_rework?: number;
  baseline_cost?: number;
  candidate_cost?: number;
  safety_events?: number;
  /** Run/QA evidence this observation is drawn from. */
  evidence_reference: string;
}

export interface RsiCanaryObservation extends RsiEvalMetrics {
  observation_id: string;
  rollout_id: string;
  stage: RsiCanaryStage;
  verdict: RsiEvalVerdict;
  evidence_reference: string;
  created_at: string;
  created_by: UserId;
}

// ---------------------------------------------------------------------------
// Workspace controls, budgets, and run pins
// ---------------------------------------------------------------------------

export interface RsiControls {
  kill_switch: boolean;
  kill_switch_reason: string | null;
  kill_switch_changed_at: string | null;
  kill_switch_changed_by: UserId | null;
  auto_promote_low_risk: boolean;
  weekly_change_budget: number;
  weekly_reflection_token_budget: number;
  updated_at: string | null;
  updated_by: UserId | null;
}

export interface UpdateRsiControlsInput {
  auto_promote_low_risk?: boolean;
  weekly_change_budget?: number;
  weekly_reflection_token_budget?: number;
}

export interface RsiBudgetView {
  week_start: string;
  weekly_change_budget: number;
  changes_promoted: number;
  changes_remaining: number;
  weekly_reflection_token_budget: number;
  reflection_tokens_used: number;
  reflection_tokens_remaining: number;
}

export interface RsiHoldoutStatus {
  /** Aggregate only: case content is never exposed outside evaluation. */
  cases: number;
  last_evaluated_at: string | null;
}

export interface RsiRunPin {
  run_id: string;
  policy_version: number;
  policy_hash: string;
  memory_version: string;
  canary: boolean;
  proposal_id: string | null;
  rollout_id: string | null;
  stage: RsiCanaryStage | null;
  created_at: string;
}

/**
 * A resolved run pin plus the unpublished canary policy the orchestrator must
 * pass to retrieval for this run. Baseline runs carry no policy overlay.
 */
export interface RsiResolvedRun extends RsiRunPin {
  policy: RetrievalPolicy | null;
}

// ---------------------------------------------------------------------------
// Read views (the HTTP surface never returns holdout case content)
// ---------------------------------------------------------------------------

export interface RsiProposalArtifactView {
  kind: RsiArtifactKind;
  baseline_policy_version: number;
  candidate_policy_hash: string | null;
  item_id: string | null;
  item_version: number | null;
}

export interface RsiProposalGate {
  offline_evaluation: "missing" | "pass" | "fail";
  holdout_required: boolean;
  approvals_required: number;
  approvals_satisfied: number;
  approval_keys: readonly RsiApprovalKey[];
  budget_ok: boolean;
  kill_switch: boolean;
  canary_eligible: boolean;
  reasons: string[];
}

export interface RsiProposalView {
  proposal_id: string;
  title: string;
  summary: string;
  diff: string;
  target: RsiTarget;
  risk: RsiRisk;
  status: RsiProposalStatus;
  status_reason: string | null;
  artifact: RsiProposalArtifactView;
  proposer: RsiProposer;
  baseline_policy_version: number;
  baseline_memory_version: string;
  applied_policy_version: number | null;
  version: number;
  created_at: string;
  created_by: UserId;
  evaluations: RsiEvaluationRecord[];
  approvals: RsiApproval[];
  rollout: RsiRollout | null;
  gate: RsiProposalGate;
}

export interface RsiStatusView {
  contract_version: number;
  controls: RsiControls;
  budget: RsiBudgetView;
  holdout: RsiHoldoutStatus;
  active_rollout: RsiRollout | null;
  proposals: Record<RsiProposalStatus, number>;
}
