/**
 * Risk-graded promotion (DAT-235).
 *
 * The ADR-0009 promotion rule: low-risk semantic `fact` items are promoted to
 * `active` automatically only when there are at least two independent
 * supporting runs, no unresolved contradiction, passing validation, and a
 * non-negative offline evaluation delta. Automatic promotion never applies to
 * `lesson`, `playbook`, or `anti_pattern` items — procedural content requires
 * named human approval — and institutional policy requires human authorship
 * and approval. A workspace may disable automatic promotion, raise the
 * evidence threshold, or require human approval for every item; it can never
 * weaken these rules.
 *
 * Two entry points:
 *
 * - {@link assessAndAutoPromote} — the automatic path for `fact` candidates.
 *   Every assessment is persisted as a promotion decision, promoted or not,
 *   so "below threshold stays inactive" is auditable rather than silent.
 * - {@link approveAndPromote} — the named human path. The approving actor is
 *   recorded on the exact version it approves, and the storage layer refuses
 *   to activate procedural or policy content without that stamp even if a
 *   caller bypasses this module.
 *
 * Deleted memory is never promoted, never restored, and never recreated here:
 * this module has no create or restore surface at all.
 */

import { NotFoundError, ValidationError } from "../../control-plane/errors.js";
import type { WorkspaceScope } from "../../control-plane/types.js";
import type { MemoryRepositories } from "../repositories.js";
import type { MemoryItemRecord, MemoryItemId, MemoryKind, MemoryStatus } from "../types.js";
import { assessIndependentSupport } from "./independence.js";
import type { MemoryLifecycleStore } from "./repositories.js";
import type {
  EvaluationStanding,
  MemoryPromotionPolicy,
  PromotionDecision,
  PromotionReason,
  RunSupport,
  ValidationStanding,
} from "./types.js";

/** Statuses in which a contradiction is still an open conflict. */
const OPEN_STATUSES: readonly MemoryStatus[] = ["proposed", "candidate", "active"];

const PROCEDURAL_KINDS: readonly MemoryKind[] = ["lesson", "playbook", "anti_pattern"];

export interface PromotionAssessment {
  record: MemoryItemRecord;
  /** What the outcome-capture path recorded about supporting runs. */
  support: readonly RunSupport[];
  /** What the candidate-admission gate decided about this item. */
  validation: ValidationStanding;
  /** The offline evaluation delta, or null when no evaluation ran. */
  evaluation: EvaluationStanding | null;
  policy: MemoryPromotionPolicy;
  /** Contradicting items still open on the other side of a `contradicts` link. */
  unresolved_contradictions: number;
  /** Stored evidence citations on the item. */
  evidence_count: number;
}

/**
 * The promotion rule as a pure decision function. Collects every applicable
 * block reason in assessment order; a promotion is the empty set.
 */
export function evaluatePromotion(assessment: PromotionAssessment): PromotionDecision {
  const { record, policy } = assessment;
  const kind = record.current.kind;
  const support = assessIndependentSupport(assessment.support);
  const reasons: PromotionReason[] = [];

  if (record.item.status !== "candidate") {
    reasons.push("not_candidate_status");
  }
  if (PROCEDURAL_KINDS.includes(kind)) {
    reasons.push("procedural_requires_human_approval");
  } else if (kind === "policy") {
    reasons.push("policy_requires_human_approval");
  } else if (kind !== "fact") {
    reasons.push("not_auto_promotable_kind");
  } else {
    if (policy.require_human_approval_all) {
      reasons.push("human_approval_required");
    }
    if (!policy.auto_promote_facts) {
      reasons.push("auto_promotion_disabled");
    }
    if (support.independent_runs < policy.fact_min_independent_runs) {
      reasons.push("independent_support_below_threshold");
    }
    if (assessment.evidence_count === 0) {
      reasons.push("evidence_missing");
    }
    if (assessment.validation.disposition !== "admitted") {
      reasons.push("validation_not_passed");
    }
    if (assessment.evaluation === null) {
      reasons.push("evaluation_missing");
    } else if (!Number.isFinite(assessment.evaluation.delta)) {
      // A NaN or infinite delta is not a non-negative delta: the comparison
      // `delta < 0` would silently pass it, so reject it explicitly.
      reasons.push("evaluation_invalid");
    } else if (assessment.evaluation.delta < 0) {
      reasons.push("evaluation_negative");
    }
  }
  if (assessment.unresolved_contradictions > 0) {
    reasons.push("unresolved_contradiction");
  }

  return {
    item_id: record.item.id,
    item_version: record.item.current_version,
    kind,
    outcome: reasons.length === 0 ? "promoted" : "blocked",
    reasons: reasons.length === 0 ? ["auto_promoted"] : reasons,
    independent_support_runs: support.independent_runs,
    evaluation_delta:
      assessment.evaluation === null || !Number.isFinite(assessment.evaluation.delta)
        ? null
        : assessment.evaluation.delta,
  };
}

export interface PromotionServiceDeps {
  memory: MemoryRepositories;
  lifecycle: MemoryLifecycleStore;
}

export interface AutoPromoteInput {
  itemId: MemoryItemId;
  support: readonly RunSupport[];
  validation: ValidationStanding;
  evaluation: EvaluationStanding | null;
  /** Correlation id of the caller's run, when one drove the assessment. */
  run_id?: string | null;
}

/**
 * Assess one candidate item and apply an automatic promotion when the rule
 * passes. The decision row and any status change commit together, so the
 * audit trail can never disagree with the item's state.
 */
export function assessAndAutoPromote(
  scope: WorkspaceScope,
  deps: PromotionServiceDeps,
  input: AutoPromoteInput,
): PromotionDecision {
  const record = deps.memory.items.getById(scope, input.itemId);
  if (record === undefined) {
    throw new NotFoundError("MemoryItem", input.itemId);
  }
  const links = deps.memory.links.listByItem(scope, input.itemId);
  let unresolved = 0;
  for (const link of links) {
    if (link.link_type !== "contradicts") {
      continue;
    }
    const otherId = link.item_id === input.itemId ? link.target_item_id : link.item_id;
    const other = deps.memory.items.getById(scope, otherId);
    if (other !== undefined && OPEN_STATUSES.includes(other.item.status)) {
      unresolved += 1;
    }
  }
  const evidence = deps.memory.evidence.listByItem(scope, input.itemId);
  const policy = deps.lifecycle.getPolicy(scope);
  const decision = evaluatePromotion({
    record,
    support: input.support,
    validation: input.validation,
    evaluation: input.evaluation,
    policy: {
      auto_promote_facts: policy.auto_promote_facts,
      fact_min_independent_runs: policy.fact_min_independent_runs,
      require_human_approval_all: policy.require_human_approval_all,
    },
    unresolved_contradictions: unresolved,
    evidence_count: evidence.length,
  });
  deps.memory.runAtomically(() => {
    deps.lifecycle.recordPromotionDecision(scope, {
      item_id: decision.item_id,
      item_version: decision.item_version,
      kind: decision.kind,
      outcome: decision.outcome,
      reasons: decision.reasons,
      independent_support_runs: decision.independent_support_runs,
      evaluation_delta: decision.evaluation_delta,
      run_id: input.run_id ?? null,
    });
    if (decision.outcome === "promoted") {
      deps.memory.items.setStatus(scope, input.itemId, "active", decision.item_version);
    }
  });
  return decision;
}

/**
 * The named human approval path: approve the exact current version and
 * activate the item. The approving actor is stamped on the version; the
 * storage layer refuses activation of procedural or policy content without
 * that stamp. Approval is a human authority act — role checks belong to the
 * calling API surface, which names a workspace owner or team lead as actor.
 */
export function approveAndPromote(
  scope: WorkspaceScope,
  deps: PromotionServiceDeps,
  input: { itemId: MemoryItemId; version: number; reasonCode?: string },
): MemoryItemRecord {
  const record = deps.memory.items.getById(scope, input.itemId);
  if (record === undefined) {
    throw new NotFoundError("MemoryItem", input.itemId);
  }
  if (record.item.current_version !== input.version) {
    throw new ValidationError(
      "human approval must name the current content version of the memory item",
    );
  }
  deps.memory.runAtomically(() => {
    if (record.current.review === null) {
      deps.memory.items.reviewVersion(scope, input.itemId, input.version, scope.actor_id);
    }
    deps.memory.items.setStatus(scope, input.itemId, "active", input.version, {
      // A governance caller records its fixed reason on the audited status
      // change; DAT-235 callers keep the default `status_changed` detail.
      ...(input.reasonCode !== undefined ? { reason_code: input.reasonCode } : {}),
    });
    deps.lifecycle.recordPromotionDecision(scope, {
      item_id: input.itemId,
      item_version: input.version,
      kind: record.current.kind,
      outcome: "promoted",
      reasons: ["human_approved"],
      independent_support_runs: 0,
      evaluation_delta: null,
      run_id: null,
    });
  });
  const promoted = deps.memory.items.getById(scope, input.itemId);
  if (promoted === undefined) {
    throw new NotFoundError("MemoryItem", input.itemId);
  }
  return promoted;
}
