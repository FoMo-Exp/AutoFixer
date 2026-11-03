/**
 * Bounded RSI governance service (DAT-238).
 *
 * The service owns the proposal → offline replay → human gate → canary →
 * promote-or-roll-back loop, the weekly change and reflection budgets, and the
 * per-workspace kill switch. It deliberately does not own evaluation data:
 * golden and holdout cases are provisioned outside this surface, and an agent
 * self-report is not a representable verifier.
 *
 * Run reproducibility: `resolveRunVersions` pins one memory version and one
 * policy identity to a run id before planning. A run that is selected for a
 * canary receives the unpublished candidate policy as an overlay for
 * `MemoryRetrievalService.preview`; nothing else can see it, and the stored
 * policy is only republished when the canary reaches 100% or a rollback
 * reverses it.
 */

import type { UserId, WorkspaceRole, WorkspaceScope } from "../../control-plane/types.js";
import { ConflictError, NotFoundError, ValidationError } from "../../control-plane/errors.js";
import type { MemoryItemRecord, MemoryRepositories } from "../index.js";
import type {
  MemoryRetrievalService,
  RetrievalPolicy,
  RetrievalPolicyRecord,
  RetrievalStore,
} from "../retrieval/index.js";
import {
  computeMemoryVersion,
  retrievalPolicyHash,
  validateRetrievalPolicy,
} from "../retrieval/index.js";
import { RSI_HARD_LIMITS, RSI_STAGE_MIN_SAMPLE } from "./constants.js";
import { replayDataset } from "./eval.js";
import { canaryBucket, requiredApprovalKeys, verdictFor } from "./gate.js";
import { isoWeekStart, newcombeDifference } from "./stats.js";
import type { RsiProposalRecord, RsiStore } from "./store.js";
import type {
  CreateRsiProposalInput,
  RsiApprovalKey,
  RsiBudgetView,
  RsiCanaryObservationInput,
  RsiCanaryStage,
  RsiControls,
  RsiDataset,
  RsiEvalMetrics,
  RsiEvaluationRecord,
  RsiEvaluationRequest,
  RsiProposalGate,
  RsiProposalStatus,
  RsiProposalView,
  RsiResolvedRun,
  RsiRisk,
  RsiRollout,
  RsiRunPin,
  RsiStatusView,
  RsiTarget,
  RsiVerifier,
} from "./types.js";
import {
  RSI_CANARY_STAGES,
  RSI_DATASETS,
  RSI_TARGET_RISK,
  RSI_TARGETS,
  RSI_VERIFIER_KINDS,
  artifactKindFor,
} from "./types.js";

export interface RsiActor {
  id: UserId;
  role: WorkspaceRole;
}

export interface RsiServiceDeps {
  store: RsiStore;
  memory: MemoryRepositories;
  retrieval: MemoryRetrievalService;
  retrievalStore: RetrievalStore;
  clock?: () => Date;
}

export interface RsiProposalFilter {
  status?: RsiProposalStatus;
  risk?: RsiRisk;
  limit?: number;
}

export interface RsiService {
  createProposal(scope: WorkspaceScope, input: CreateRsiProposalInput): RsiProposalView;
  listProposals(scope: WorkspaceScope, filter?: RsiProposalFilter): RsiProposalView[];
  getProposal(scope: WorkspaceScope, proposalId: string): RsiProposalView;
  evaluate(scope: WorkspaceScope, proposalId: string, input: RsiEvaluationRequest): RsiProposalView;
  approve(
    scope: WorkspaceScope,
    proposalId: string,
    actor: RsiActor,
    note?: string,
  ): RsiProposalView;
  startCanary(scope: WorkspaceScope, proposalId: string, actor: RsiActor): RsiProposalView;
  recordCanaryObservation(
    scope: WorkspaceScope,
    proposalId: string,
    input: RsiCanaryObservationInput,
    actor: RsiActor,
  ): RsiProposalView;
  rollback(
    scope: WorkspaceScope,
    proposalId: string,
    reason: string,
    actor: RsiActor,
  ): RsiProposalView;
  status(scope: WorkspaceScope): RsiStatusView;
  setKillSwitch(
    scope: WorkspaceScope,
    enabled: boolean,
    reason: string | null,
    actor: RsiActor,
  ): RsiControls;
  updateControls(
    scope: WorkspaceScope,
    patch: {
      auto_promote_low_risk?: boolean;
      weekly_change_budget?: number;
      weekly_reflection_token_budget?: number;
    },
    actor: RsiActor,
  ): RsiControls;
  resolveRunVersions(scope: WorkspaceScope, runId: string): RsiResolvedRun;
  getRunPin(scope: WorkspaceScope, runId: string): RsiRunPin | undefined;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${label} must not be empty`);
  }
  if (trimmed.length > max) {
    throw new ValidationError(`${label} must be at most ${max} characters`);
  }
  return trimmed;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return text(value, label, max);
}

function target(value: unknown): RsiTarget {
  if (typeof value !== "string" || !(RSI_TARGETS as readonly string[]).includes(value)) {
    throw new ValidationError(`target must be one of ${RSI_TARGETS.join(", ")}`);
  }
  return value as RsiTarget;
}

function verifier(value: unknown): RsiVerifier {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("verifier is required");
  }
  const input = value as Record<string, unknown>;
  const kind = input["kind"];
  if (typeof kind !== "string" || !(RSI_VERIFIER_KINDS as readonly string[]).includes(kind)) {
    // Agent self-report is deliberately not in this vocabulary.
    throw new ValidationError(
      `verifier.kind must be one of ${RSI_VERIFIER_KINDS.join(", ")}; agent self-report cannot verify an evaluation`,
    );
  }
  return {
    kind: kind as RsiVerifier["kind"],
    id: text(input["id"], "verifier.id", RSI_HARD_LIMITS.item_id_chars),
    reference: text(
      input["reference"],
      "verifier.reference",
      RSI_HARD_LIMITS.evidence_reference_chars,
    ),
  };
}

function nonNegativeInteger(value: unknown, label: string, fallback = 0): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string, fallback = 0): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative number`);
  }
  return value;
}

/** Owner-only control writes; the HTTP layer checks this too. */
function requireOwner(actor: RsiActor): void {
  if (actor.role !== "owner") {
    throw new ValidationError("this action requires the workspace owner role");
  }
}

function requireReviewer(actor: RsiActor): void {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new ValidationError("this action requires an owner or admin approver");
  }
}

function latestByDataset(
  evaluations: readonly RsiEvaluationRecord[],
): Map<RsiDataset, RsiEvaluationRecord> {
  const latest = new Map<RsiDataset, RsiEvaluationRecord>();
  for (const evaluation of evaluations) {
    if (!latest.has(evaluation.dataset)) {
      latest.set(evaluation.dataset, evaluation);
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class RsiGovernanceService implements RsiService {
  constructor(private readonly deps: RsiServiceDeps) {}

  private get store(): RsiStore {
    return this.deps.store;
  }

  private get clock(): () => Date {
    return this.deps.clock ?? (() => new Date());
  }

  createProposal(scope: WorkspaceScope, input: CreateRsiProposalInput): RsiProposalView {
    const controls = this.store.controls(scope);
    if (controls.kill_switch) {
      throw new ConflictError(
        "the workspace RSI kill switch is active; no proposals can be opened",
      );
    }
    const selectedTarget = target(input.target);
    const risk = RSI_TARGET_RISK[selectedTarget];
    if (risk === "D") {
      throw new ValidationError(
        `target ${selectedTarget} is risk class D and forbidden to the learning loop; change it through a normal reviewed code or policy change`,
      );
    }
    if (
      input.proposer === null ||
      typeof input.proposer !== "object" ||
      typeof input.proposer.id !== "string" ||
      input.proposer.id.length === 0 ||
      (input.proposer.kind !== "agent" && input.proposer.kind !== "human")
    ) {
      throw new ValidationError("proposer must carry an id and kind agent|human");
    }
    const title = text(input.title, "title", RSI_HARD_LIMITS.title_chars);
    const summary = text(input.summary, "summary", RSI_HARD_LIMITS.summary_chars);
    const diff = text(input.diff, "diff", RSI_HARD_LIMITS.diff_chars);
    if (input.proposer.model !== undefined) {
      text(input.proposer.model, "proposer.model", 200);
    }

    const baselinePolicy = this.deps.retrievalStore.ensurePolicy(scope);
    const baselineMemoryVersion = computeMemoryVersion(
      this.deps.retrievalStore.corpusEntries(scope),
      baselinePolicy.version,
    );
    const kind = artifactKindFor(selectedTarget);

    if (kind === "retrieval_policy") {
      if (input.memory_item !== undefined) {
        throw new ValidationError("a retrieval-policy target must not carry a memory item");
      }
      const candidatePolicy = validateRetrievalPolicy(input.candidate_policy);
      const proposal = this.store.createProposal(scope, {
        title,
        summary,
        diff,
        target: selectedTarget,
        risk,
        artifact_kind: kind,
        baseline_policy_version: baselinePolicy.version,
        baseline_memory_version: baselineMemoryVersion,
        candidate_policy: candidatePolicy,
        candidate_policy_hash: retrievalPolicyHash(candidatePolicy),
        candidate_item_id: null,
        candidate_item_version: null,
        proposer: input.proposer,
        status: "proposed",
        status_reason: null,
        created_by: scope.actor_id,
      });
      return this.view(scope, proposal.id);
    }

    if (input.candidate_policy !== undefined) {
      throw new ValidationError("a memory-item target must not carry a retrieval policy");
    }
    const itemRef = input.memory_item;
    if (
      itemRef === undefined ||
      typeof itemRef.item_id !== "string" ||
      !Number.isInteger(itemRef.item_version)
    ) {
      throw new ValidationError(
        "a memory-item target requires memory_item.item_id and item_version",
      );
    }
    const record = this.deps.memory.items.getById(scope, itemRef.item_id);
    if (record === undefined) {
      throw new NotFoundError("memory item", itemRef.item_id);
    }
    if (record.item.status !== "candidate") {
      throw new ValidationError(
        "only a candidate memory item may be proposed for managed promotion",
      );
    }
    if (record.item.current_version !== itemRef.item_version) {
      throw new ConflictError(
        `memory item ${itemRef.item_id} is at version ${record.item.current_version}, not ${itemRef.item_version}`,
      );
    }
    const proposal = this.store.createProposal(scope, {
      title,
      summary,
      diff,
      target: selectedTarget,
      risk,
      artifact_kind: kind,
      baseline_policy_version: baselinePolicy.version,
      baseline_memory_version: baselineMemoryVersion,
      candidate_policy: null,
      candidate_policy_hash: record.current.content_hash,
      candidate_item_id: record.item.id,
      candidate_item_version: record.current.version,
      proposer: input.proposer,
      status: "proposed",
      status_reason: null,
      created_by: scope.actor_id,
    });
    return this.view(scope, proposal.id);
  }

  listProposals(scope: WorkspaceScope, filter: RsiProposalFilter = {}): RsiProposalView[] {
    return this.store.listProposals(scope, filter).map((proposal) => this.view(scope, proposal.id));
  }

  getProposal(scope: WorkspaceScope, proposalId: string): RsiProposalView {
    return this.view(scope, proposalId);
  }

  evaluate(
    scope: WorkspaceScope,
    proposalId: string,
    input: RsiEvaluationRequest,
  ): RsiProposalView {
    const proposal = this.requireProposal(scope, proposalId);
    const controls = this.requireLive(scope);
    const checkedVerifier = verifier(input.verifier);
    if (checkedVerifier.id === proposal.proposer.id) {
      throw new ValidationError(
        "the proposer cannot verify its own proposal; evaluation requires an independent verifier",
      );
    }
    const datasets = input.datasets ?? [...RSI_DATASETS];
    if (datasets.length === 0) {
      throw new ValidationError("at least one dataset must be replayed");
    }
    for (const dataset of datasets) {
      if (!(RSI_DATASETS as readonly string[]).includes(dataset)) {
        throw new ValidationError(`dataset must be one of ${RSI_DATASETS.join(", ")}`);
      }
    }
    if (proposal.status === "canary" || proposal.status === "promoted") {
      throw new ConflictError(`proposal ${proposalId} is already ${proposal.status}`);
    }

    const baseline = this.requirePolicy(scope, proposal.baseline_policy_version);
    const artifact = {
      kind: proposal.artifact_kind,
      baseline_policy: baseline.policy,
      candidate_policy: proposal.candidate_policy,
    };
    const results = datasets.map((dataset) => {
      const result = replayDataset(
        { store: this.store, retrieval: this.deps.retrieval },
        scope,
        dataset,
        artifact,
      );
      const outcome = verdictFor(result.metrics);
      return { ...result, verdict: outcome.verdict, reasons: outcome.reasons };
    });

    const week = isoWeekStart(this.clock());
    const used = this.store.budgetUsage(scope, week);
    if (used.reflection_tokens >= controls.weekly_reflection_token_budget) {
      throw new ConflictError(
        `reflection token budget exhausted: ${used.reflection_tokens} of ${controls.weekly_reflection_token_budget} used this week`,
      );
    }
    const spent = results.reduce((sum, result) => sum + result.reflection_tokens, 0);
    if (used.reflection_tokens + spent > controls.weekly_reflection_token_budget) {
      throw new ConflictError(
        `reflection token budget exhausted: ${used.reflection_tokens}+${spent} exceeds ${controls.weekly_reflection_token_budget} this week`,
      );
    }

    // Charge the budget before the rows exist: a failure here must over-count
    // rather than let an evaluation escape the weekly ceiling.
    this.store.addBudgetUsage(scope, week, { reflection_tokens: spent });
    for (const result of results) {
      this.store.addEvaluation(scope, {
        proposal_id: proposal.id,
        proposal_version: proposal.version,
        kind: "offline_replay",
        dataset: result.dataset,
        metrics: result.metrics,
        verdict: result.verdict,
        verifier: checkedVerifier,
        policy_version: baseline.version,
        policy_hash: baseline.policy_hash,
        memory_version: proposal.baseline_memory_version,
        reflection_tokens: result.reflection_tokens,
        created_by: scope.actor_id,
      });
    }
    return this.refreshStatus(scope, proposal.id);
  }

  approve(
    scope: WorkspaceScope,
    proposalId: string,
    actor: RsiActor,
    note?: string,
  ): RsiProposalView {
    const proposal = this.requireProposal(scope, proposalId);
    requireReviewer(actor);
    if (actor.id === proposal.proposer.id) {
      throw new ValidationError("a proposer cannot approve its own proposal");
    }
    if (proposal.status === "promoted" || proposal.status === "rolled_back") {
      throw new ConflictError(`proposal ${proposalId} is already ${proposal.status}`);
    }
    const gate = this.gate(scope, proposal);
    if (gate.offline_evaluation !== "pass") {
      throw new ConflictError("offline replay over the golden set and holdout has not passed");
    }
    const keys = requiredApprovalKeys(proposal.risk, this.store.controls(scope));
    let approvalKey: RsiApprovalKey = "single";
    if (actor.role === "owner" && keys.includes("owner")) {
      approvalKey = "owner";
    } else if (actor.role === "admin" && keys.includes("reviewer")) {
      approvalKey = "reviewer";
    }
    this.store.addApproval(scope, {
      proposal_id: proposal.id,
      proposal_version: proposal.version,
      approval_key: approvalKey,
      approver_id: actor.id,
      role: actor.role,
      note: optionalText(note, "note", RSI_HARD_LIMITS.note_chars) ?? null,
    });
    return this.refreshStatus(scope, proposal.id);
  }

  startCanary(scope: WorkspaceScope, proposalId: string, actor: RsiActor): RsiProposalView {
    requireOwner(actor);
    const proposal = this.requireProposal(scope, proposalId);
    this.requireLive(scope);
    if (proposal.status === "canary" || proposal.status === "promoted") {
      throw new ConflictError(`proposal ${proposalId} is already ${proposal.status}`);
    }
    const gate = this.gate(scope, proposal);
    if (!gate.canary_eligible) {
      throw new ConflictError(`canary is not eligible: ${gate.reasons.join("; ")}`);
    }
    this.store.addRollout(scope, {
      proposal_id: proposal.id,
      stage: 10,
      baseline_policy_version: proposal.baseline_policy_version,
      candidate_policy:
        proposal.artifact_kind === "retrieval_policy" ? proposal.candidate_policy : null,
      candidate_policy_hash: proposal.candidate_policy_hash ?? "",
      created_by: scope.actor_id,
    });
    this.store.setProposalStatus(scope, proposal.id, "canary", null);
    return this.view(scope, proposal.id);
  }

  recordCanaryObservation(
    scope: WorkspaceScope,
    proposalId: string,
    input: RsiCanaryObservationInput,
    actor: RsiActor,
  ): RsiProposalView {
    requireOwner(actor);
    this.requireProposal(scope, proposalId);
    const rollout = this.store.getRollout(scope, proposalId);
    if (rollout === undefined || rollout.status !== "canary") {
      throw new ConflictError(`proposal ${proposalId} has no active canary`);
    }
    if (this.store.controls(scope).kill_switch) {
      return this.finishRollback(scope, proposalId, "RSI kill switch engaged", actor);
    }

    const sample = nonNegativeInteger(input.sample_size, "sample_size");
    if (sample === 0) {
      throw new ValidationError("sample_size must be positive");
    }
    const metrics: RsiEvalMetrics = {
      sample_size: sample,
      baseline_successes: nonNegativeInteger(input.baseline_successes, "baseline_successes"),
      candidate_successes: nonNegativeInteger(input.candidate_successes, "candidate_successes"),
      baseline_rework: nonNegativeInteger(input.baseline_rework, "baseline_rework"),
      candidate_rework: nonNegativeInteger(input.candidate_rework, "candidate_rework"),
      baseline_cost: nonNegativeNumber(input.baseline_cost, "baseline_cost"),
      candidate_cost: nonNegativeNumber(input.candidate_cost, "candidate_cost"),
      safety_events: nonNegativeInteger(input.safety_events, "safety_events"),
      success_delta: 0,
      delta_ci_low: 0,
      delta_ci_high: 0,
    };
    if (metrics.baseline_successes > sample || metrics.candidate_successes > sample) {
      throw new ValidationError("success counts cannot exceed the sample size");
    }
    const estimate = newcombeDifference(
      metrics.candidate_successes,
      sample,
      metrics.baseline_successes,
      sample,
    );
    metrics.success_delta = estimate.delta;
    metrics.delta_ci_low = estimate.low;
    metrics.delta_ci_high = estimate.high;

    const stageMinimum = RSI_STAGE_MIN_SAMPLE[rollout.stage];
    const outcome = verdictFor(metrics, stageMinimum);
    const evidence = text(
      input.evidence_reference,
      "evidence_reference",
      RSI_HARD_LIMITS.evidence_reference_chars,
    );
    this.store.addObservation(scope, {
      rollout_id: rollout.rollout_id,
      stage: rollout.stage,
      metrics,
      verdict: outcome.verdict,
      evidence_reference: evidence,
      created_by: scope.actor_id,
    });

    if (outcome.verdict === "fail") {
      return this.finishRollback(
        scope,
        proposalId,
        `automatic rollback: ${outcome.reasons.join("; ")}`,
        actor,
      );
    }
    if (outcome.verdict === "inconclusive") {
      return this.view(scope, proposalId);
    }
    const stageIndex = RSI_CANARY_STAGES.indexOf(rollout.stage);
    const nextStage: RsiCanaryStage | undefined = RSI_CANARY_STAGES[stageIndex + 1];
    if (nextStage === undefined) {
      return this.promote(scope, proposalId, actor);
    }
    this.store.updateRollout(scope, proposalId, { stage: nextStage });
    return this.view(scope, proposalId);
  }

  rollback(
    scope: WorkspaceScope,
    proposalId: string,
    reason: string,
    actor: RsiActor,
  ): RsiProposalView {
    requireOwner(actor);
    const checked = text(reason, "reason", RSI_HARD_LIMITS.reason_chars);
    return this.finishRollback(scope, proposalId, checked, actor);
  }

  status(scope: WorkspaceScope): RsiStatusView {
    const controls = this.store.controls(scope);
    const week = isoWeekStart(this.clock());
    const usage = this.store.budgetUsage(scope, week);
    const counts = Object.fromEntries(
      [
        "proposed",
        "awaiting_approval",
        "ready",
        "canary",
        "promoted",
        "rolled_back",
        "blocked",
      ].map((status) => [status, 0]),
    ) as Record<RsiProposalStatus, number>;
    for (const proposal of this.store.listProposals(scope, { limit: 200 })) {
      counts[proposal.status] += 1;
    }
    const active = this.store.listActiveRollouts(scope);
    return {
      contract_version: 1,
      controls,
      budget: this.budgetView(controls, usage),
      holdout: this.store.holdoutStatus(scope),
      active_rollout: active[0] ?? null,
      proposals: counts,
    };
  }

  setKillSwitch(
    scope: WorkspaceScope,
    enabled: boolean,
    reason: string | null,
    actor: RsiActor,
  ): RsiControls {
    requireOwner(actor);
    if (enabled && (reason === null || reason.trim().length === 0)) {
      throw new ValidationError("engaging the kill switch requires a reason");
    }
    const controls = this.store.setKillSwitch(
      scope,
      enabled,
      optionalText(reason, "reason", RSI_HARD_LIMITS.reason_chars) ?? null,
      actor.id,
    );
    if (enabled) {
      // Immediate effect: every active canary is rolled back in the same call.
      for (const rollout of this.store.listActiveRollouts(scope)) {
        this.finishRollback(
          scope,
          rollout.proposal_id,
          "kill switch engaged; canary rolled back",
          actor,
        );
      }
    }
    return controls;
  }

  updateControls(
    scope: WorkspaceScope,
    patch: {
      auto_promote_low_risk?: boolean;
      weekly_change_budget?: number;
      weekly_reflection_token_budget?: number;
    },
    actor: RsiActor,
  ): RsiControls {
    requireOwner(actor);
    if (
      patch.auto_promote_low_risk !== undefined &&
      typeof patch.auto_promote_low_risk !== "boolean"
    ) {
      throw new ValidationError("auto_promote_low_risk must be a boolean");
    }
    return this.store.updateControls(
      scope,
      {
        ...(patch.auto_promote_low_risk !== undefined
          ? { auto_promote_low_risk: patch.auto_promote_low_risk }
          : {}),
        ...(patch.weekly_change_budget !== undefined
          ? {
              weekly_change_budget: nonNegativeInteger(
                patch.weekly_change_budget,
                "weekly_change_budget",
              ),
            }
          : {}),
        ...(patch.weekly_reflection_token_budget !== undefined
          ? {
              weekly_reflection_token_budget: nonNegativeInteger(
                patch.weekly_reflection_token_budget,
                "weekly_reflection_token_budget",
              ),
            }
          : {}),
      },
      actor.id,
    );
  }

  resolveRunVersions(scope: WorkspaceScope, runId: string): RsiResolvedRun {
    const id = text(runId, "run_id", RSI_HARD_LIMITS.item_id_chars);
    const existing = this.store.getPin(scope, id);
    if (existing !== undefined) {
      const policy =
        existing.canary && existing.rollout_id !== null
          ? this.store.getRolloutPolicy(scope, existing.rollout_id)
          : null;
      return { ...existing, policy };
    }
    const baseline = this.deps.retrievalStore.ensurePolicy(scope);
    const controls = this.store.controls(scope);
    const memoryVersion = computeMemoryVersion(
      this.deps.retrievalStore.corpusEntries(scope),
      baseline.version,
    );
    let selected: { rollout: RsiRollout; policy: RetrievalPolicy | null } | undefined;
    if (!controls.kill_switch) {
      for (const rollout of this.store.listActiveRollouts(scope)) {
        if (canaryBucket(scope.workspace_id, id) < rollout.stage * 100) {
          selected = {
            rollout,
            policy: this.store.getRolloutPolicy(scope, rollout.rollout_id),
          };
          break;
        }
      }
    }
    const pin = this.store.pinRun(scope, {
      run_id: id,
      policy_version: baseline.version,
      policy_hash: selected?.rollout.candidate_hash ?? baseline.policy_hash,
      memory_version: memoryVersion,
      canary: selected !== undefined,
      proposal_id: selected?.rollout.proposal_id ?? null,
      rollout_id: selected?.rollout.rollout_id ?? null,
      stage: selected?.rollout.stage ?? null,
    });
    return { ...pin, policy: selected?.policy ?? null };
  }

  getRunPin(scope: WorkspaceScope, runId: string): RsiRunPin | undefined {
    return this.store.getPin(scope, text(runId, "run_id", RSI_HARD_LIMITS.item_id_chars));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireProposal(scope: WorkspaceScope, proposalId: string) {
    const proposal = this.store.getProposal(scope, proposalId);
    if (proposal === undefined) {
      throw new NotFoundError("RSI proposal", proposalId);
    }
    return proposal;
  }

  /** Every state-changing RSI action is refused while the kill switch is on. */
  private requireLive(scope: WorkspaceScope): RsiControls {
    const controls = this.store.controls(scope);
    if (controls.kill_switch) {
      throw new ConflictError("the workspace RSI kill switch is active; RSI actions are refused");
    }
    return controls;
  }

  private requirePolicy(scope: WorkspaceScope, version: number): RetrievalPolicyRecord {
    const policy = this.deps.retrievalStore.getPolicy(scope, version);
    if (policy === undefined) {
      throw new NotFoundError("retrieval policy version", String(version));
    }
    return policy;
  }

  private budgetView(
    controls: RsiControls,
    usage: { week_start: string; changes_promoted: number; reflection_tokens: number },
  ): RsiBudgetView {
    return {
      week_start: usage.week_start,
      weekly_change_budget: controls.weekly_change_budget,
      changes_promoted: usage.changes_promoted,
      changes_remaining: Math.max(0, controls.weekly_change_budget - usage.changes_promoted),
      weekly_reflection_token_budget: controls.weekly_reflection_token_budget,
      reflection_tokens_used: usage.reflection_tokens,
      reflection_tokens_remaining: Math.max(
        0,
        controls.weekly_reflection_token_budget - usage.reflection_tokens,
      ),
    };
  }

  private gate(scope: WorkspaceScope, proposal: RsiProposalRecord): RsiProposalGate {
    const controls = this.store.controls(scope);
    const evaluations = this.store.listEvaluations(scope, proposal.id, 50);
    const latest = latestByDataset(evaluations);
    const golden = latest.get("golden");
    const holdout = latest.get("holdout");
    const verdicts = [golden?.verdict, holdout?.verdict];
    const offline: RsiProposalGate["offline_evaluation"] =
      golden === undefined || holdout === undefined
        ? "missing"
        : verdicts.every((verdictValue) => verdictValue === "pass")
          ? "pass"
          : "fail";

    const requiredKeys = requiredApprovalKeys(proposal.risk, controls);
    const approvals = this.store
      .listApprovals(scope, proposal.id)
      .filter((approval) => approval.proposal_version === proposal.version);
    const satisfiedKeys = requiredKeys.filter((key) => {
      if (key === "single") {
        return approvals.length > 0;
      }
      return approvals.some((approval) => approval.approval_key === key);
    });
    const reasons: string[] = [];
    if (offline !== "pass") {
      reasons.push(
        offline === "missing"
          ? "offline replay over the golden set and holdout is incomplete"
          : "offline replay did not pass",
      );
    }
    if (satisfiedKeys.length < requiredKeys.length) {
      reasons.push(`human approval is incomplete (${satisfiedKeys.length}/${requiredKeys.length})`);
    }
    const week = isoWeekStart(this.clock());
    const usage = this.store.budgetUsage(scope, week);
    if (usage.changes_promoted >= controls.weekly_change_budget) {
      reasons.push("weekly change budget is exhausted");
    }
    if (controls.kill_switch) {
      reasons.push("the workspace kill switch is active");
    }
    const canaryEligible =
      offline === "pass" &&
      satisfiedKeys.length === requiredKeys.length &&
      usage.changes_promoted < controls.weekly_change_budget &&
      !controls.kill_switch &&
      proposal.status !== "promoted" &&
      proposal.status !== "rolled_back";
    return {
      offline_evaluation: offline,
      holdout_required: true,
      approvals_required: requiredKeys.length,
      approvals_satisfied: satisfiedKeys.length,
      approval_keys: requiredKeys,
      budget_ok: usage.changes_promoted < controls.weekly_change_budget,
      kill_switch: controls.kill_switch,
      canary_eligible: canaryEligible,
      reasons,
    };
  }

  private view(scope: WorkspaceScope, proposalId: string): RsiProposalView {
    const proposal = this.requireProposal(scope, proposalId);
    const evaluations = this.store.listEvaluations(scope, proposal.id, 50);
    const approvals = this.store.listApprovals(scope, proposal.id);
    const rollout = this.store.getRollout(scope, proposal.id) ?? null;
    return {
      proposal_id: proposal.id,
      title: proposal.title,
      summary: proposal.summary,
      diff: proposal.diff,
      target: proposal.target,
      risk: proposal.risk,
      status: proposal.status,
      status_reason: proposal.status_reason,
      artifact: {
        kind: proposal.artifact_kind,
        baseline_policy_version: proposal.baseline_policy_version,
        candidate_policy_hash: proposal.candidate_policy_hash,
        item_id: proposal.candidate_item_id,
        item_version: proposal.candidate_item_version,
      },
      proposer: proposal.proposer,
      baseline_policy_version: proposal.baseline_policy_version,
      baseline_memory_version: proposal.baseline_memory_version,
      applied_policy_version: proposal.applied_policy_version,
      version: proposal.version,
      created_at: proposal.created_at,
      created_by: proposal.created_by,
      evaluations,
      approvals,
      rollout,
      gate: this.gate(scope, proposal),
    };
  }

  /** Recompute status from the current gate after an evaluation or approval. */
  private refreshStatus(scope: WorkspaceScope, proposalId: string): RsiProposalView {
    const proposal = this.requireProposal(scope, proposalId);
    if (
      proposal.status === "canary" ||
      proposal.status === "promoted" ||
      proposal.status === "rolled_back"
    ) {
      return this.view(scope, proposalId);
    }
    const gate = this.gate(scope, proposal);
    if (gate.canary_eligible) {
      this.store.setProposalStatus(scope, proposalId, "ready", null);
    } else {
      const waitingForApproval =
        gate.offline_evaluation === "pass" && gate.approvals_satisfied < gate.approvals_required;
      this.store.setProposalStatus(
        scope,
        proposalId,
        waitingForApproval ? "awaiting_approval" : "blocked",
        gate.reasons.join("; "),
      );
    }
    return this.view(scope, proposalId);
  }

  private promote(scope: WorkspaceScope, proposalId: string, actor: RsiActor): RsiProposalView {
    const proposal = this.requireProposal(scope, proposalId);
    const week = isoWeekStart(this.clock());
    const usage = this.store.budgetUsage(scope, week);
    if (usage.changes_promoted >= this.store.controls(scope).weekly_change_budget) {
      return this.finishRollback(scope, proposalId, "weekly change budget exhausted", actor);
    }
    if (proposal.artifact_kind === "retrieval_policy") {
      if (proposal.candidate_policy === null) {
        throw new ConflictError("proposal has no candidate policy to publish");
      }
      const published = this.deps.retrievalStore.createPolicyVersion(
        scope,
        proposal.candidate_policy,
      );
      this.store.updateRollout(scope, proposalId, {
        status: "promoted",
        ended_at: this.clock().toISOString(),
        reason: null,
      });
      this.store.setProposalStatus(scope, proposalId, "promoted", null, published.version);
    } else {
      this.applyMemoryPromotion(scope, proposal, actor);
      this.store.updateRollout(scope, proposalId, {
        status: "promoted",
        ended_at: this.clock().toISOString(),
        reason: null,
      });
      this.store.setProposalStatus(scope, proposalId, "promoted", null);
    }
    this.store.addBudgetUsage(scope, week, { changes: 1 });
    return this.view(scope, proposalId);
  }

  private applyMemoryPromotion(
    scope: WorkspaceScope,
    proposal: RsiProposalRecord,
    actor: RsiActor,
  ): void {
    const itemId = proposal.candidate_item_id;
    const itemVersion = proposal.candidate_item_version;
    if (itemId === null || itemVersion === null) {
      throw new ConflictError("proposal has no candidate memory item to activate");
    }
    const record: MemoryItemRecord | undefined = this.deps.memory.items.getById(scope, itemId);
    if (record === undefined) {
      throw new NotFoundError("memory item", itemId);
    }
    if (record.item.status !== "candidate") {
      throw new ConflictError(`memory item ${itemId} is no longer a candidate`);
    }
    const approval = this.store
      .listApprovals(scope, proposal.id)
      .find((entry) => entry.proposal_version === proposal.version);
    const approverId = approval?.approver_id ?? actor.id;
    this.deps.memory.items.reviewVersion(scope, itemId, itemVersion, approverId);
    this.deps.memory.items.setStatus(scope, itemId, "active", record.item.current_version);
  }

  private finishRollback(
    scope: WorkspaceScope,
    proposalId: string,
    reason: string,
    actor: RsiActor,
  ): RsiProposalView {
    const proposal = this.requireProposal(scope, proposalId);
    const rollout = this.store.getRollout(scope, proposalId);
    if (rollout === undefined || rollout.status === "rolled_back") {
      throw new ConflictError(`proposal ${proposalId} has no rollout to roll back`);
    }
    if (rollout.status === "promoted") {
      this.revertPromotion(scope, proposal, actor);
    }
    this.store.updateRollout(scope, proposalId, {
      status: "rolled_back",
      reason,
      ended_at: this.clock().toISOString(),
    });
    this.store.setProposalStatus(scope, proposalId, "rolled_back", reason);
    return this.view(scope, proposalId);
  }

  private revertPromotion(
    scope: WorkspaceScope,
    proposal: RsiProposalRecord,
    actor: RsiActor,
  ): void {
    if (proposal.artifact_kind === "retrieval_policy") {
      // Revert only while this proposal's policy is still the live one. A
      // later promotion owns the current policy; rewinding it would silently
      // discard that change.
      const current = this.deps.retrievalStore.getPolicy(scope);
      if (current === undefined || current.policy_hash !== proposal.candidate_policy_hash) {
        return;
      }
      const baseline = this.requirePolicy(scope, proposal.baseline_policy_version);
      this.deps.retrievalStore.createPolicyVersion(scope, baseline.policy);
      return;
    }
    const itemId = proposal.candidate_item_id;
    if (itemId === null) {
      return;
    }
    const record = this.deps.memory.items.getById(scope, itemId);
    if (record === undefined || record.item.status !== "active") {
      return;
    }
    this.deps.memory.items.setStatus(scope, itemId, "deprecated", record.item.current_version);
    void actor;
  }
}

export function createRsiService(deps: RsiServiceDeps): RsiService {
  return new RsiGovernanceService(deps);
}
