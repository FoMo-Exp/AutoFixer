/**
 * Scoped persistence for bounded RSI (DAT-238).
 *
 * Every method takes a {@link WorkspaceScope} derived from authenticated
 * membership and embeds `enterprise_id` + `workspace_id` in its SQL: a foreign
 * workspace's proposal, evaluation, rollout, golden case, holdout case, or run
 * pin is indistinguishable from a missing one.
 *
 * The holdout table has exactly one reader — offline replay — and it is gated
 * by {@link holdoutRead}, a module-private symbol. Golden cases are readable
 * by evaluation only; neither table is reachable from the retrieval, feedback,
 * or proposal surface.
 */

import type { ControlPlaneDb } from "../../control-plane/db.js";
import { newId, nowIso } from "../../control-plane/db.js";
import { NotFoundError, ValidationError } from "../../control-plane/errors.js";
import type { UserId, WorkspaceRole, WorkspaceScope } from "../../control-plane/types.js";
import type { RetrievalPolicy } from "../retrieval/index.js";
import { validateRetrievalPolicy } from "../retrieval/index.js";
import { RSI_DEFAULTS } from "./constants.js";
import type {
  RsiApproval,
  RsiApprovalKey,
  RsiArtifactKind,
  RsiCanaryObservation,
  RsiCanaryStage,
  RsiControls,
  RsiEvalCase,
  RsiEvalMetrics,
  RsiEvaluationRecord,
  RsiEvalVerdict,
  RsiHoldoutStatus,
  RsiProposalStatus,
  RsiProposer,
  RsiRisk,
  RsiRollout,
  RsiRolloutStatus,
  RsiRunPin,
  RsiTarget,
  RsiVerifier,
} from "./types.js";

// ---------------------------------------------------------------------------
// Holdout access capability
// ---------------------------------------------------------------------------

const HOLDOUT_READERS = new WeakSet<object>();

/**
 * Mints the capability that permits reading holdout case content. Only the
 * RSI evaluation module calls it; it is deliberately not re-exported from the
 * package surface, so a proposal, retrieval, or HTTP credential cannot obtain
 * it.
 */
export function holdoutRead(): object {
  const capability: object = Object.freeze({ holdout: true });
  HOLDOUT_READERS.add(capability);
  return capability;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface RsiProposalRecord {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  diff: string;
  target: RsiTarget;
  risk: RsiRisk;
  artifact_kind: RsiArtifactKind;
  baseline_policy_version: number;
  baseline_memory_version: string;
  candidate_policy: RetrievalPolicy | null;
  candidate_policy_hash: string | null;
  candidate_item_id: string | null;
  candidate_item_version: number | null;
  proposer: RsiProposer;
  status: RsiProposalStatus;
  status_reason: string | null;
  applied_policy_version: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: UserId;
}

export interface CreateProposalRowInput {
  title: string;
  summary: string;
  diff: string;
  target: RsiTarget;
  risk: RsiRisk;
  artifact_kind: RsiArtifactKind;
  baseline_policy_version: number;
  baseline_memory_version: string;
  candidate_policy: RetrievalPolicy | null;
  candidate_policy_hash: string | null;
  candidate_item_id: string | null;
  candidate_item_version: number | null;
  proposer: RsiProposer;
  status: RsiProposalStatus;
  status_reason: string | null;
  created_by: UserId;
}

export interface RsiEvaluationRowInput {
  proposal_id: string;
  proposal_version: number;
  kind: "offline_replay" | "canary";
  dataset: "golden" | "holdout";
  metrics: RsiEvalMetrics;
  verdict: RsiEvalVerdict;
  verifier: RsiVerifier;
  policy_version: number;
  policy_hash: string;
  memory_version: string;
  reflection_tokens: number;
  created_by: UserId;
}

export interface RsiRolloutRowInput {
  proposal_id: string;
  stage: RsiCanaryStage;
  baseline_policy_version: number;
  candidate_policy: RetrievalPolicy | null;
  candidate_policy_hash: string;
  created_by: UserId;
}

export interface RsiObservationRowInput {
  rollout_id: string;
  stage: RsiCanaryStage;
  metrics: RsiEvalMetrics;
  verdict: RsiEvalVerdict;
  evidence_reference: string;
  created_by: UserId;
}

export interface RsiBudgetUsage {
  week_start: string;
  changes_promoted: number;
  reflection_tokens: number;
}

export interface RsiPinRowInput {
  run_id: string;
  policy_version: number;
  policy_hash: string;
  memory_version: string;
  canary: boolean;
  proposal_id: string | null;
  rollout_id: string | null;
  stage: RsiCanaryStage | null;
}

export interface RsiStore {
  controls(scope: WorkspaceScope): RsiControls;
  setKillSwitch(
    scope: WorkspaceScope,
    enabled: boolean,
    reason: string | null,
    actor: UserId,
  ): RsiControls;
  updateControls(
    scope: WorkspaceScope,
    patch: {
      auto_promote_low_risk?: boolean;
      weekly_change_budget?: number;
      weekly_reflection_token_budget?: number;
    },
    actor: UserId,
  ): RsiControls;
  recordControlEvent(
    scope: WorkspaceScope,
    input: {
      action: "kill_switch" | "controls_updated";
      enabled: boolean | null;
      reason: string | null;
      detail: Record<string, unknown>;
    },
    actor: UserId,
  ): void;
  budgetUsage(scope: WorkspaceScope, weekStart: string): RsiBudgetUsage;
  addBudgetUsage(
    scope: WorkspaceScope,
    weekStart: string,
    delta: { changes?: number; reflection_tokens?: number },
  ): RsiBudgetUsage;
  createProposal(scope: WorkspaceScope, input: CreateProposalRowInput): RsiProposalRecord;
  getProposal(scope: WorkspaceScope, proposalId: string): RsiProposalRecord | undefined;
  listProposals(
    scope: WorkspaceScope,
    filter?: { status?: RsiProposalStatus; risk?: RsiRisk; limit?: number },
  ): RsiProposalRecord[];
  setProposalStatus(
    scope: WorkspaceScope,
    proposalId: string,
    status: RsiProposalStatus,
    reason: string | null,
    appliedPolicyVersion?: number | null,
  ): RsiProposalRecord;
  addEvaluation(scope: WorkspaceScope, input: RsiEvaluationRowInput): RsiEvaluationRecord;
  listEvaluations(scope: WorkspaceScope, proposalId: string, limit?: number): RsiEvaluationRecord[];
  addApproval(
    scope: WorkspaceScope,
    input: {
      proposal_id: string;
      proposal_version: number;
      approval_key: RsiApprovalKey;
      approver_id: UserId;
      role: WorkspaceRole;
      note: string | null;
    },
  ): RsiApproval;
  listApprovals(scope: WorkspaceScope, proposalId: string): RsiApproval[];
  addRollout(scope: WorkspaceScope, input: RsiRolloutRowInput): RsiRollout;
  getRollout(scope: WorkspaceScope, proposalId: string): RsiRollout | undefined;
  getRolloutById(scope: WorkspaceScope, rolloutId: string): RsiRollout | undefined;
  /** The unpublished canary policy of a rollout; null for memory-item targets. */
  getRolloutPolicy(scope: WorkspaceScope, rolloutId: string): RetrievalPolicy | null;
  listActiveRollouts(scope: WorkspaceScope): RsiRollout[];
  updateRollout(
    scope: WorkspaceScope,
    proposalId: string,
    patch: {
      stage?: RsiCanaryStage;
      status?: RsiRolloutStatus;
      reason?: string | null;
      ended_at?: string | null;
    },
  ): RsiRollout;
  addObservation(scope: WorkspaceScope, input: RsiObservationRowInput): RsiCanaryObservation;
  listObservations(
    scope: WorkspaceScope,
    rolloutId: string,
    limit?: number,
  ): RsiCanaryObservation[];
  addGoldenCase(scope: WorkspaceScope, input: RsiEvalCase, actor: UserId): RsiEvalCase;
  listGoldenCases(scope: WorkspaceScope): RsiEvalCase[];
  addHoldoutCase(scope: WorkspaceScope, input: RsiEvalCase, actor: UserId): RsiEvalCase;
  listHoldoutCases(scope: WorkspaceScope, access: object): RsiEvalCase[];
  holdoutStatus(scope: WorkspaceScope): RsiHoldoutStatus;

  pinRun(scope: WorkspaceScope, input: RsiPinRowInput): RsiRunPin;
  getPin(scope: WorkspaceScope, runId: string): RsiRunPin | undefined;
  /** Pins assigned to one rollout (the canary arm). */
  listRolloutPins(scope: WorkspaceScope, rolloutId: string): RsiRunPin[];
  /** Baseline pins created in the canary window (the control arm). */
  listBaselinePinsSince(scope: WorkspaceScope, startedAt: string): RsiRunPin[];
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ControlsRow {
  kill_switch: number;
  kill_switch_reason: string | null;
  kill_switch_changed_at: string | null;
  kill_switch_changed_by: string | null;
  auto_promote_low_risk: number;
  weekly_change_budget: number;
  weekly_reflection_token_budget: number;
  updated_at: string;
  updated_by: string;
}

interface ProposalRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  diff: string;
  target: string;
  risk: string;
  artifact_kind: string;
  baseline_policy_version: number;
  baseline_memory_version: string;
  candidate_policy: string | null;
  candidate_policy_hash: string | null;
  candidate_item_id: string | null;
  candidate_item_version: number | null;
  proposer_id: string;
  proposer_kind: string;
  proposer_model: string | null;
  status: string;
  status_reason: string | null;
  applied_policy_version: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

interface EvaluationRow {
  id: string;
  proposal_id: string;
  proposal_version: number;
  dataset: string;
  sample_size: number;
  baseline_sample_size: number;
  candidate_sample_size: number;
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
  verdict: string;
  verifier_kind: string;
  verifier_id: string;
  verifier_reference: string;
  policy_version: number;
  policy_hash: string;
  memory_version: string;
  reflection_tokens: number;
  created_at: string;
  created_by: string;
}

interface ApprovalRow {
  id: string;
  proposal_id: string;
  proposal_version: number;
  approval_key: string;
  approver_id: string;
  role: string;
  note: string | null;
  created_at: string;
}

interface RolloutRow {
  id: string;
  proposal_id: string;
  stage: number;
  status: string;
  baseline_policy_version: number;
  candidate_policy: string | null;
  candidate_policy_hash: string;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
}

interface ObservationRow {
  id: string;
  rollout_id: string;
  stage: number;
  sample_size: number;
  baseline_sample_size: number;
  candidate_sample_size: number;
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
  verdict: string;
  evidence_reference: string;
  created_at: string;
  created_by: string;
}

interface CaseRow {
  case_key: string;
  payload: string;
}

interface PinRow {
  run_id: string;
  policy_version: number;
  policy_hash: string;
  memory_version: string;
  canary: number;
  proposal_id: string | null;
  rollout_id: string | null;
  stage: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireScope(scope: WorkspaceScope): void {
  for (const field of ["enterprise_id", "workspace_id", "actor_id"] as const) {
    if (typeof scope[field] !== "string" || scope[field].length === 0) {
      throw new ValidationError(`rsi scope must carry ${field}`);
    }
  }
}

function boundedLimit(value: number | undefined, fallback: number, cap: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(resolved, cap);
}

function parseCase(row: CaseRow, dataset: "golden" | "holdout"): RsiEvalCase {
  const payload = JSON.parse(row.payload) as Omit<RsiEvalCase, "case_id" | "dataset">;
  return { case_id: row.case_key, dataset, ...payload };
}

function transaction<T>(db: ControlPlaneDb, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function toControls(row: ControlsRow | undefined): RsiControls {
  if (row === undefined) {
    return {
      kill_switch: false,
      kill_switch_reason: null,
      kill_switch_changed_at: null,
      kill_switch_changed_by: null,
      auto_promote_low_risk: RSI_DEFAULTS.auto_promote_low_risk,
      weekly_change_budget: RSI_DEFAULTS.weekly_change_budget,
      weekly_reflection_token_budget: RSI_DEFAULTS.weekly_reflection_token_budget,
      updated_at: null,
      updated_by: null,
    };
  }
  return {
    kill_switch: row.kill_switch === 1,
    kill_switch_reason: row.kill_switch_reason,
    kill_switch_changed_at: row.kill_switch_changed_at,
    kill_switch_changed_by: row.kill_switch_changed_by,
    auto_promote_low_risk: row.auto_promote_low_risk === 1,
    weekly_change_budget: row.weekly_change_budget,
    weekly_reflection_token_budget: row.weekly_reflection_token_budget,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function toProposal(row: ProposalRow): RsiProposalRecord {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    title: row.title,
    summary: row.summary,
    diff: row.diff,
    target: row.target as RsiTarget,
    risk: row.risk as RsiRisk,
    artifact_kind: row.artifact_kind as RsiArtifactKind,
    baseline_policy_version: row.baseline_policy_version,
    baseline_memory_version: row.baseline_memory_version,
    candidate_policy:
      row.candidate_policy === null
        ? null
        : validateRetrievalPolicy(JSON.parse(row.candidate_policy) as unknown),
    candidate_policy_hash: row.candidate_policy_hash,
    candidate_item_id: row.candidate_item_id,
    candidate_item_version: row.candidate_item_version,
    proposer: {
      id: row.proposer_id,
      kind: row.proposer_kind as RsiProposer["kind"],
      ...(row.proposer_model !== null ? { model: row.proposer_model } : {}),
    },
    status: row.status as RsiProposalStatus,
    status_reason: row.status_reason,
    applied_policy_version: row.applied_policy_version,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

function toEvaluation(row: EvaluationRow): RsiEvaluationRecord {
  return {
    evaluation_id: row.id,
    proposal_id: row.proposal_id,
    proposal_version: row.proposal_version,
    dataset: row.dataset as "golden" | "holdout",
    holdout_used: row.dataset === "holdout",
    sample_size: row.sample_size,
    baseline_sample_size: row.baseline_sample_size,
    candidate_sample_size: row.candidate_sample_size,
    baseline_successes: row.baseline_successes,
    candidate_successes: row.candidate_successes,
    baseline_rework: row.baseline_rework,
    candidate_rework: row.candidate_rework,
    baseline_cost: row.baseline_cost,
    candidate_cost: row.candidate_cost,
    safety_events: row.safety_events,
    success_delta: row.success_delta,
    delta_ci_low: row.delta_ci_low,
    delta_ci_high: row.delta_ci_high,
    verdict: row.verdict as RsiEvalVerdict,
    verifier: {
      kind: row.verifier_kind as RsiVerifier["kind"],
      id: row.verifier_id,
      reference: row.verifier_reference,
    },
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    memory_version: row.memory_version,
    reflection_tokens: row.reflection_tokens,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

function toApproval(row: ApprovalRow): RsiApproval {
  return {
    approval_id: row.id,
    proposal_id: row.proposal_id,
    proposal_version: row.proposal_version,
    approval_key: row.approval_key as RsiApprovalKey,
    approver_id: row.approver_id,
    role: row.role as WorkspaceRole,
    note: row.note,
    created_at: row.created_at,
  };
}

function toRollout(row: RolloutRow): RsiRollout {
  return {
    rollout_id: row.id,
    proposal_id: row.proposal_id,
    stage: row.stage as RsiCanaryStage,
    status: row.status as RsiRolloutStatus,
    baseline_policy_version: row.baseline_policy_version,
    candidate_hash: row.candidate_policy_hash,
    reason: row.reason,
    started_at: row.started_at,
    ended_at: row.ended_at,
    updated_at: row.updated_at,
  };
}

function toObservation(row: ObservationRow): RsiCanaryObservation {
  return {
    observation_id: row.id,
    rollout_id: row.rollout_id,
    stage: row.stage as RsiCanaryStage,
    sample_size: row.sample_size,
    baseline_sample_size: row.baseline_sample_size,
    candidate_sample_size: row.candidate_sample_size,
    baseline_successes: row.baseline_successes,
    candidate_successes: row.candidate_successes,
    baseline_rework: row.baseline_rework,
    candidate_rework: row.candidate_rework,
    baseline_cost: row.baseline_cost,
    candidate_cost: row.candidate_cost,
    safety_events: row.safety_events,
    success_delta: row.success_delta,
    delta_ci_low: row.delta_ci_low,
    delta_ci_high: row.delta_ci_high,
    verdict: row.verdict as RsiEvalVerdict,
    evidence_reference: row.evidence_reference,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

function toPin(row: PinRow): RsiRunPin {
  return {
    run_id: row.run_id,
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    memory_version: row.memory_version,
    canary: row.canary === 1,
    proposal_id: row.proposal_id,
    rollout_id: row.rollout_id,
    stage: row.stage === null ? null : (row.stage as RsiCanaryStage),
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class SqliteRsiStore implements RsiStore {
  constructor(private readonly db: ControlPlaneDb) {}

  controls(scope: WorkspaceScope): RsiControls {
    requireScope(scope);
    const row = this.db
      .prepare("SELECT * FROM rsi_controls WHERE workspace_id = ? AND enterprise_id = ?")
      .get(scope.workspace_id, scope.enterprise_id) as ControlsRow | undefined;
    return toControls(row);
  }

  setKillSwitch(
    scope: WorkspaceScope,
    enabled: boolean,
    reason: string | null,
    actor: UserId,
  ): RsiControls {
    requireScope(scope);
    const before = this.controls(scope);
    const at = nowIso();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO rsi_controls (
             workspace_id, enterprise_id, kill_switch, kill_switch_reason,
             kill_switch_changed_at, kill_switch_changed_by, updated_at, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             kill_switch = excluded.kill_switch,
             kill_switch_reason = excluded.kill_switch_reason,
             kill_switch_changed_at = excluded.kill_switch_changed_at,
             kill_switch_changed_by = excluded.kill_switch_changed_by,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        )
        .run(
          scope.workspace_id,
          scope.enterprise_id,
          enabled ? 1 : 0,
          reason,
          at,
          actor,
          at,
          actor,
        );
    });
    if (before.kill_switch !== enabled || before.kill_switch_reason !== reason) {
      this.recordControlEvent(
        scope,
        {
          action: "kill_switch",
          enabled,
          reason,
          detail: { previous: before.kill_switch, previous_reason: before.kill_switch_reason },
        },
        actor,
      );
    }
    return this.controls(scope);
  }

  updateControls(
    scope: WorkspaceScope,
    patch: {
      auto_promote_low_risk?: boolean;
      weekly_change_budget?: number;
      weekly_reflection_token_budget?: number;
    },
    actor: UserId,
  ): RsiControls {
    requireScope(scope);
    const current = this.controls(scope);
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO rsi_controls (
           workspace_id, enterprise_id, auto_promote_low_risk,
           weekly_change_budget, weekly_reflection_token_budget, updated_at, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           auto_promote_low_risk = excluded.auto_promote_low_risk,
           weekly_change_budget = excluded.weekly_change_budget,
           weekly_reflection_token_budget = excluded.weekly_reflection_token_budget,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        scope.workspace_id,
        scope.enterprise_id,
        (patch.auto_promote_low_risk ?? current.auto_promote_low_risk) ? 1 : 0,
        patch.weekly_change_budget ?? current.weekly_change_budget,
        patch.weekly_reflection_token_budget ?? current.weekly_reflection_token_budget,
        at,
        actor,
      );
    this.recordControlEvent(
      scope,
      {
        action: "controls_updated",
        enabled: null,
        reason: null,
        detail: { ...patch },
      },
      actor,
    );
    return this.controls(scope);
  }

  recordControlEvent(
    scope: WorkspaceScope,
    input: {
      action: "kill_switch" | "controls_updated";
      enabled: boolean | null;
      reason: string | null;
      detail: Record<string, unknown>;
    },
    actor: UserId,
  ): void {
    requireScope(scope);
    this.db
      .prepare(
        `INSERT INTO rsi_control_events (
           id, enterprise_id, workspace_id, action, enabled, reason, detail,
           created_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("rsictl"),
        scope.enterprise_id,
        scope.workspace_id,
        input.action,
        input.enabled === null ? null : input.enabled ? 1 : 0,
        input.reason,
        JSON.stringify(input.detail),
        nowIso(),
        actor,
      );
  }

  budgetUsage(scope: WorkspaceScope, weekStart: string): RsiBudgetUsage {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT changes_promoted, reflection_tokens FROM rsi_budget_usage
         WHERE workspace_id = ? AND enterprise_id = ? AND week_start = ?`,
      )
      .get(scope.workspace_id, scope.enterprise_id, weekStart) as
      { changes_promoted: number; reflection_tokens: number } | undefined;
    return {
      week_start: weekStart,
      changes_promoted: row?.changes_promoted ?? 0,
      reflection_tokens: row?.reflection_tokens ?? 0,
    };
  }

  addBudgetUsage(
    scope: WorkspaceScope,
    weekStart: string,
    delta: { changes?: number; reflection_tokens?: number },
  ): RsiBudgetUsage {
    requireScope(scope);
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO rsi_budget_usage (
           workspace_id, enterprise_id, week_start, changes_promoted, reflection_tokens, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, week_start) DO UPDATE SET
           changes_promoted = changes_promoted + excluded.changes_promoted,
           reflection_tokens = reflection_tokens + excluded.reflection_tokens,
           updated_at = excluded.updated_at`,
      )
      .run(
        scope.workspace_id,
        scope.enterprise_id,
        weekStart,
        delta.changes ?? 0,
        delta.reflection_tokens ?? 0,
        at,
      );
    return this.budgetUsage(scope, weekStart);
  }

  createProposal(scope: WorkspaceScope, input: CreateProposalRowInput): RsiProposalRecord {
    requireScope(scope);
    const id = newId("rsi");
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO rsi_proposals (
           id, enterprise_id, workspace_id, title, summary, diff, target, risk,
           artifact_kind, baseline_policy_version, baseline_memory_version,
           candidate_policy, candidate_policy_hash, candidate_item_id,
           candidate_item_version, proposer_id, proposer_kind, proposer_model,
           status, status_reason, applied_policy_version, version,
           created_at, updated_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.title,
        input.summary,
        input.diff,
        input.target,
        input.risk,
        input.artifact_kind,
        input.baseline_policy_version,
        input.baseline_memory_version,
        input.candidate_policy === null ? null : JSON.stringify(input.candidate_policy),
        input.candidate_policy_hash,
        input.candidate_item_id,
        input.candidate_item_version,
        input.proposer.id,
        input.proposer.kind,
        input.proposer.model ?? null,
        input.status,
        input.status_reason,
        at,
        at,
        input.created_by,
      );
    return { ...this.requireProposal(scope, id) };
  }

  getProposal(scope: WorkspaceScope, proposalId: string): RsiProposalRecord | undefined {
    requireScope(scope);
    const row = this.db
      .prepare(
        "SELECT * FROM rsi_proposals WHERE id = ? AND workspace_id = ? AND enterprise_id = ?",
      )
      .get(proposalId, scope.workspace_id, scope.enterprise_id) as ProposalRow | undefined;
    return row === undefined ? undefined : toProposal(row);
  }

  listProposals(
    scope: WorkspaceScope,
    filter: { status?: RsiProposalStatus; risk?: RsiRisk; limit?: number } = {},
  ): RsiProposalRecord[] {
    requireScope(scope);
    const conditions = ["workspace_id = ?", "enterprise_id = ?"];
    const values: Array<string | number> = [scope.workspace_id, scope.enterprise_id];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter.risk !== undefined) {
      conditions.push("risk = ?");
      values.push(filter.risk);
    }
    const limit = boundedLimit(filter.limit, 50, 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_proposals WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...values, limit) as unknown as ProposalRow[];
    return rows.map(toProposal);
  }

  setProposalStatus(
    scope: WorkspaceScope,
    proposalId: string,
    status: RsiProposalStatus,
    reason: string | null,
    appliedPolicyVersion?: number | null,
  ): RsiProposalRecord {
    const current = this.requireProposal(scope, proposalId);
    this.db
      .prepare(
        `UPDATE rsi_proposals
           SET status = ?, status_reason = ?, applied_policy_version = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND enterprise_id = ?`,
      )
      .run(
        status,
        reason,
        appliedPolicyVersion === undefined ? current.applied_policy_version : appliedPolicyVersion,
        nowIso(),
        proposalId,
        scope.workspace_id,
        scope.enterprise_id,
      );
    return this.requireProposal(scope, proposalId);
  }

  addEvaluation(scope: WorkspaceScope, input: RsiEvaluationRowInput): RsiEvaluationRecord {
    requireScope(scope);
    this.requireProposal(scope, input.proposal_id);
    const id = newId("rsieval");
    this.db
      .prepare(
        `INSERT INTO rsi_evaluations (
           id, enterprise_id, workspace_id, proposal_id, proposal_version, kind, dataset,
           holdout_used, sample_size, baseline_sample_size, candidate_sample_size,
           baseline_successes, candidate_successes,
           baseline_rework, candidate_rework, baseline_cost, candidate_cost,
           safety_events, success_delta, delta_ci_low, delta_ci_high, verdict,
           verifier_kind, verifier_id, verifier_reference, policy_version,
           policy_hash, memory_version, reflection_tokens, created_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.proposal_id,
        input.proposal_version,
        input.kind,
        input.dataset,
        input.dataset === "holdout" ? 1 : 0,
        input.metrics.sample_size,
        input.metrics.baseline_sample_size,
        input.metrics.candidate_sample_size,
        input.metrics.baseline_successes,
        input.metrics.candidate_successes,
        input.metrics.baseline_rework,
        input.metrics.candidate_rework,
        input.metrics.baseline_cost,
        input.metrics.candidate_cost,
        input.metrics.safety_events,
        input.metrics.success_delta,
        input.metrics.delta_ci_low,
        input.metrics.delta_ci_high,
        input.verdict,
        input.verifier.kind,
        input.verifier.id,
        input.verifier.reference,
        input.policy_version,
        input.policy_hash,
        input.memory_version,
        input.reflection_tokens,
        nowIso(),
        input.created_by,
      );
    const row = this.db
      .prepare("SELECT * FROM rsi_evaluations WHERE id = ?")
      .get(id) as unknown as EvaluationRow;
    return toEvaluation(row);
  }

  listEvaluations(
    scope: WorkspaceScope,
    proposalId: string,
    limit?: number,
  ): RsiEvaluationRecord[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_evaluations
         WHERE workspace_id = ? AND enterprise_id = ? AND proposal_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        scope.workspace_id,
        scope.enterprise_id,
        proposalId,
        boundedLimit(limit, 20, 50),
      ) as unknown as EvaluationRow[];
    return rows.map(toEvaluation);
  }

  addApproval(
    scope: WorkspaceScope,
    input: {
      proposal_id: string;
      proposal_version: number;
      approval_key: RsiApprovalKey;
      approver_id: UserId;
      role: WorkspaceRole;
      note: string | null;
    },
  ): RsiApproval {
    requireScope(scope);
    this.requireProposal(scope, input.proposal_id);
    const existing = this.db
      .prepare(
        "SELECT * FROM rsi_approvals WHERE proposal_id = ? AND approver_id = ? AND workspace_id = ?",
      )
      .get(input.proposal_id, input.approver_id, scope.workspace_id) as ApprovalRow | undefined;
    if (existing !== undefined) {
      return toApproval(existing);
    }
    const id = newId("rsiapproval");
    this.db
      .prepare(
        `INSERT INTO rsi_approvals (
           id, enterprise_id, workspace_id, proposal_id, proposal_version,
           approval_key, approver_id, role, note, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.proposal_id,
        input.proposal_version,
        input.approval_key,
        input.approver_id,
        input.role,
        input.note,
        nowIso(),
      );
    const row = this.db
      .prepare("SELECT * FROM rsi_approvals WHERE id = ?")
      .get(id) as unknown as ApprovalRow;
    return toApproval(row);
  }

  listApprovals(scope: WorkspaceScope, proposalId: string): RsiApproval[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_approvals
         WHERE workspace_id = ? AND enterprise_id = ? AND proposal_id = ?
         ORDER BY created_at, id LIMIT 20`,
      )
      .all(scope.workspace_id, scope.enterprise_id, proposalId) as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }

  addRollout(scope: WorkspaceScope, input: RsiRolloutRowInput): RsiRollout {
    requireScope(scope);
    this.requireProposal(scope, input.proposal_id);
    const existing = this.getRollout(scope, input.proposal_id);
    if (existing !== undefined) {
      throw new ValidationError(`proposal ${input.proposal_id} already has a rollout`);
    }
    const id = newId("rsirollout");
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO rsi_rollouts (
           id, enterprise_id, workspace_id, proposal_id, stage, status,
           baseline_policy_version, candidate_policy, candidate_policy_hash,
           started_at, ended_at, updated_at, created_by
         ) VALUES (?, ?, ?, ?, ?, 'canary', ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.proposal_id,
        input.stage,
        input.baseline_policy_version,
        input.candidate_policy === null ? null : JSON.stringify(input.candidate_policy),
        input.candidate_policy_hash,
        at,
        at,
        input.created_by,
      );
    return this.requireRollout(scope, input.proposal_id);
  }

  getRollout(scope: WorkspaceScope, proposalId: string): RsiRollout | undefined {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT * FROM rsi_rollouts
         WHERE workspace_id = ? AND enterprise_id = ? AND proposal_id = ?`,
      )
      .get(scope.workspace_id, scope.enterprise_id, proposalId) as RolloutRow | undefined;
    return row === undefined ? undefined : toRollout(row);
  }

  getRolloutById(scope: WorkspaceScope, rolloutId: string): RsiRollout | undefined {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT * FROM rsi_rollouts
         WHERE id = ? AND workspace_id = ? AND enterprise_id = ?`,
      )
      .get(rolloutId, scope.workspace_id, scope.enterprise_id) as RolloutRow | undefined;
    return row === undefined ? undefined : toRollout(row);
  }

  getRolloutPolicy(scope: WorkspaceScope, rolloutId: string): RetrievalPolicy | null {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT candidate_policy FROM rsi_rollouts
         WHERE id = ? AND workspace_id = ? AND enterprise_id = ?`,
      )
      .get(rolloutId, scope.workspace_id, scope.enterprise_id) as
      { candidate_policy: string | null } | undefined;
    return row === undefined || row.candidate_policy === null
      ? null
      : validateRetrievalPolicy(JSON.parse(row.candidate_policy) as unknown);
  }

  listActiveRollouts(scope: WorkspaceScope): RsiRollout[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_rollouts
         WHERE workspace_id = ? AND enterprise_id = ? AND status = 'canary'
         ORDER BY started_at ASC`,
      )
      .all(scope.workspace_id, scope.enterprise_id) as unknown as RolloutRow[];
    return rows.map(toRollout);
  }

  updateRollout(
    scope: WorkspaceScope,
    proposalId: string,
    patch: {
      stage?: RsiCanaryStage;
      status?: RsiRolloutStatus;
      reason?: string | null;
      ended_at?: string | null;
    },
  ): RsiRollout {
    const current = this.requireRollout(scope, proposalId);
    this.db
      .prepare(
        `UPDATE rsi_rollouts
           SET stage = ?, status = ?, reason = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND enterprise_id = ?`,
      )
      .run(
        patch.stage ?? current.stage,
        patch.status ?? current.status,
        patch.reason === undefined ? current.reason : patch.reason,
        patch.ended_at === undefined ? current.ended_at : patch.ended_at,
        nowIso(),
        current.rollout_id,
        scope.workspace_id,
        scope.enterprise_id,
      );
    return this.requireRollout(scope, proposalId);
  }

  addObservation(scope: WorkspaceScope, input: RsiObservationRowInput): RsiCanaryObservation {
    requireScope(scope);
    const id = newId("rsiobs");
    this.db
      .prepare(
        `INSERT INTO rsi_canary_observations (
           id, enterprise_id, workspace_id, rollout_id, stage, sample_size,
           baseline_sample_size, candidate_sample_size,
           baseline_successes, candidate_successes, baseline_rework, candidate_rework,
           baseline_cost, candidate_cost, safety_events, success_delta,
           delta_ci_low, delta_ci_high, verdict, evidence_reference, created_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.rollout_id,
        input.stage,
        input.metrics.sample_size,
        input.metrics.baseline_sample_size,
        input.metrics.candidate_sample_size,
        input.metrics.baseline_successes,
        input.metrics.candidate_successes,
        input.metrics.baseline_rework,
        input.metrics.candidate_rework,
        input.metrics.baseline_cost,
        input.metrics.candidate_cost,
        input.metrics.safety_events,
        input.metrics.success_delta,
        input.metrics.delta_ci_low,
        input.metrics.delta_ci_high,
        input.verdict,
        input.evidence_reference,
        nowIso(),
        input.created_by,
      );
    const row = this.db
      .prepare("SELECT * FROM rsi_canary_observations WHERE id = ?")
      .get(id) as unknown as ObservationRow;
    return toObservation(row);
  }

  listObservations(
    scope: WorkspaceScope,
    rolloutId: string,
    limit?: number,
  ): RsiCanaryObservation[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_canary_observations
         WHERE workspace_id = ? AND enterprise_id = ? AND rollout_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        scope.workspace_id,
        scope.enterprise_id,
        rolloutId,
        boundedLimit(limit, 20, 100),
      ) as unknown as ObservationRow[];
    return rows.map(toObservation);
  }

  addGoldenCase(scope: WorkspaceScope, input: RsiEvalCase, actor: UserId): RsiEvalCase {
    requireScope(scope);
    this.db
      .prepare(
        `INSERT INTO rsi_golden_cases (
           id, enterprise_id, workspace_id, case_key, payload, created_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("rsicase"),
        scope.enterprise_id,
        scope.workspace_id,
        input.case_id,
        JSON.stringify({
          query: input.query,
          scope: input.scope,
          role: input.role,
          expected_item_ids: input.expected_item_ids,
          forbidden_item_ids: input.forbidden_item_ids,
        }),
        nowIso(),
        actor,
      );
    return input;
  }

  listGoldenCases(scope: WorkspaceScope): RsiEvalCase[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT case_key, payload FROM rsi_golden_cases
         WHERE workspace_id = ? AND enterprise_id = ?
         ORDER BY case_key LIMIT 1000`,
      )
      .all(scope.workspace_id, scope.enterprise_id) as unknown as CaseRow[];
    return rows.map((row) => parseCase(row, "golden"));
  }

  addHoldoutCase(scope: WorkspaceScope, input: RsiEvalCase, actor: UserId): RsiEvalCase {
    requireScope(scope);
    this.db
      .prepare(
        `INSERT INTO rsi_holdout_cases (
           id, enterprise_id, workspace_id, case_key, payload, created_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("rsiholdout"),
        scope.enterprise_id,
        scope.workspace_id,
        input.case_id,
        JSON.stringify({
          query: input.query,
          scope: input.scope,
          role: input.role,
          expected_item_ids: input.expected_item_ids,
          forbidden_item_ids: input.forbidden_item_ids,
        }),
        nowIso(),
        actor,
      );
    return input;
  }

  listHoldoutCases(scope: WorkspaceScope, access: object): RsiEvalCase[] {
    requireScope(scope);
    if (!HOLDOUT_READERS.has(access)) {
      throw new ValidationError("holdout cases are readable only by the RSI evaluator");
    }
    const rows = this.db
      .prepare(
        `SELECT case_key, payload FROM rsi_holdout_cases
         WHERE workspace_id = ? AND enterprise_id = ?
         ORDER BY case_key LIMIT 1000`,
      )
      .all(scope.workspace_id, scope.enterprise_id) as unknown as CaseRow[];
    return rows.map((row) => parseCase(row, "holdout"));
  }

  holdoutStatus(scope: WorkspaceScope): RsiHoldoutStatus {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cases FROM rsi_holdout_cases
         WHERE workspace_id = ? AND enterprise_id = ?`,
      )
      .get(scope.workspace_id, scope.enterprise_id) as { cases: number } | undefined;
    const last = this.db
      .prepare(
        `SELECT MAX(created_at) AS at FROM rsi_evaluations
         WHERE workspace_id = ? AND enterprise_id = ? AND dataset = 'holdout'`,
      )
      .get(scope.workspace_id, scope.enterprise_id) as { at: string | null } | undefined;
    return {
      cases: row?.cases ?? 0,
      last_evaluated_at: last?.at ?? null,
    };
  }

  pinRun(scope: WorkspaceScope, input: RsiPinRowInput): RsiRunPin {
    requireScope(scope);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO rsi_run_pins (
           workspace_id, enterprise_id, run_id, policy_version, policy_hash,
           memory_version, canary, proposal_id, rollout_id, stage, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.workspace_id,
        scope.enterprise_id,
        input.run_id,
        input.policy_version,
        input.policy_hash,
        input.memory_version,
        input.canary ? 1 : 0,
        input.proposal_id,
        input.rollout_id,
        input.stage,
        nowIso(),
      );
    const pin = this.getPin(scope, input.run_id);
    if (pin === undefined) {
      throw new NotFoundError("Run pin", input.run_id);
    }
    return pin;
  }

  getPin(scope: WorkspaceScope, runId: string): RsiRunPin | undefined {
    requireScope(scope);
    const row = this.db
      .prepare(
        `SELECT * FROM rsi_run_pins
         WHERE workspace_id = ? AND enterprise_id = ? AND run_id = ?`,
      )
      .get(scope.workspace_id, scope.enterprise_id, runId) as PinRow | undefined;
    return row === undefined ? undefined : toPin(row);
  }

  listRolloutPins(scope: WorkspaceScope, rolloutId: string): RsiRunPin[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_run_pins
         WHERE workspace_id = ? AND enterprise_id = ? AND rollout_id = ? AND canary = 1
         ORDER BY created_at, run_id LIMIT 5000`,
      )
      .all(scope.workspace_id, scope.enterprise_id, rolloutId) as unknown as PinRow[];
    return rows.map(toPin);
  }

  listBaselinePinsSince(scope: WorkspaceScope, startedAt: string): RsiRunPin[] {
    requireScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM rsi_run_pins
         WHERE workspace_id = ? AND enterprise_id = ? AND canary = 0 AND created_at >= ?
         ORDER BY created_at, run_id LIMIT 5000`,
      )
      .all(scope.workspace_id, scope.enterprise_id, startedAt) as unknown as PinRow[];
    return rows.map(toPin);
  }

  private requireProposal(scope: WorkspaceScope, proposalId: string): RsiProposalRecord {
    const proposal = this.getProposal(scope, proposalId);
    if (proposal === undefined) {
      throw new NotFoundError("RSI proposal", proposalId);
    }
    return proposal;
  }

  private requireRollout(scope: WorkspaceScope, proposalId: string): RsiRollout {
    const rollout = this.getRollout(scope, proposalId);
    if (rollout === undefined) {
      throw new NotFoundError("RSI rollout", proposalId);
    }
    return rollout;
  }
}

export function createRsiStore(db: ControlPlaneDb): RsiStore {
  return new SqliteRsiStore(db);
}
