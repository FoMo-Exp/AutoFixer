/**
 * Persistence for admission decisions and retirement candidates (DAT-234).
 *
 * These are the auditable record of the gate: what was evaluated, what the
 * verdict was, and which reasons produced it. They live in their own tables so
 * a decision survives the item it describes — the record that a poisoned
 * candidate was rejected is exactly the record an incident review needs after
 * the candidate itself is gone.
 *
 * Every column holds an opaque id, a fixed enum, a one-way content digest, or
 * a count. Candidate statements, matched lint text, and free-text reasons are
 * never written: the reason code is the reason.
 *
 * Like `memory_events`, these rows carry plain scope IDs with no foreign keys.
 * The audit of a deletion or a workspace erasure must outlive the rows it
 * describes, and a second look at an old decision must still resolve its
 * context.
 */

import type { ControlPlaneDb } from "../../control-plane/db.js";
import { newId, nowIso } from "../../control-plane/db.js";
import { NotFoundError, ScopeError, ValidationError } from "../../control-plane/errors.js";
import type {
  EnterpriseId,
  UserId,
  WorkspaceId,
  WorkspaceScope,
} from "../../control-plane/types.js";
import type { MemoryItemId } from "../types.js";
import type {
  AdmissionCheckResult,
  AdmissionDisposition,
  AdmissionReason,
  RetirementAction,
} from "./types.js";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One evaluated candidate: the verdict, and why. */
export interface MemoryAdmissionDecision {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  /** Canonical content hash of the candidate that was evaluated. */
  candidate_hash: string;
  /** Item the decision is about, or null when nothing was persisted. */
  item_id: MemoryItemId | null;
  item_version: number | null;
  disposition: AdmissionDisposition;
  reason_codes: AdmissionReason[];
  check_results: AdmissionCheckResult[];
  duplicate_of_item_id: MemoryItemId | null;
  contradicts_item_ids: MemoryItemId[];
  retrieval_eligible: boolean;
  factual_injection_allowed: boolean;
  run_id: string | null;
  created_at: string;
  created_by: UserId;
}

/**
 * A proposal to retire one item. Produced by a contradiction; never executed
 * by the gate. `status` is the human or consolidation decision.
 */
export interface MemoryRetirementCandidate {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId;
  successor_item_id: MemoryItemId | null;
  proposed_action: RetirementAction;
  reason_code: AdmissionReason;
  decision_id: string;
  status: "pending" | "accepted" | "rejected";
  resolved_at: string | null;
  resolved_by: UserId | null;
  created_at: string;
  created_by: UserId;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RecordAdmissionDecisionInput {
  candidate_hash: string;
  item_id: MemoryItemId | null;
  item_version: number | null;
  disposition: AdmissionDisposition;
  reason_codes: readonly AdmissionReason[];
  check_results: readonly AdmissionCheckResult[];
  duplicate_of_item_id: MemoryItemId | null;
  contradicts_item_ids: readonly MemoryItemId[];
  retrieval_eligible: boolean;
  factual_injection_allowed: boolean;
  run_id?: string | null;
}

export interface ProposeRetirementInput {
  item_id: MemoryItemId;
  successor_item_id: MemoryItemId | null;
  proposed_action: RetirementAction;
  reason_code: AdmissionReason;
  decision_id: string;
}

export interface RetirementListFilter {
  item_id?: MemoryItemId;
  status?: MemoryRetirementCandidate["status"];
  limit?: number;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface MemoryAdmissionRepository {
  /** Append one decision. Decisions are never updated in place. */
  recordDecision(
    scope: WorkspaceScope,
    input: RecordAdmissionDecisionInput,
  ): MemoryAdmissionDecision;
  /** Decisions for one item, newest first. */
  listDecisionsForItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryAdmissionDecision[];
  /**
   * The most recent decision that accepted a given content hash in this
   * workspace. Idempotent re-delivery of the same candidate answers here
   * instead of evaluating the whole corpus again.
   */
  findAcceptedDecision(
    scope: WorkspaceScope,
    candidateHash: string,
  ): MemoryAdmissionDecision | undefined;
  /** Every decision recorded in the workspace, newest first, bounded. */
  listDecisions(scope: WorkspaceScope, limit?: number): MemoryAdmissionDecision[];

  /** Propose retiring an item. Idempotent per (item, action, decision). */
  proposeRetirement(
    scope: WorkspaceScope,
    input: ProposeRetirementInput,
  ): MemoryRetirementCandidate;
  listRetirementCandidates(
    scope: WorkspaceScope,
    filter?: RetirementListFilter,
  ): MemoryRetirementCandidate[];
  /** Accept or reject one proposal. Set once. */
  resolveRetirementCandidate(
    scope: WorkspaceScope,
    id: string,
    status: "accepted" | "rejected",
    resolvedBy: UserId,
  ): MemoryRetirementCandidate;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function requireWorkspaceScope(scope: WorkspaceScope): WorkspaceScope {
  const missing: string[] = [];
  if (typeof scope.enterprise_id !== "string" || scope.enterprise_id.length === 0) {
    missing.push("enterprise_id");
  }
  if (typeof scope.workspace_id !== "string" || scope.workspace_id.length === 0) {
    missing.push("workspace_id");
  }
  if (typeof scope.actor_id !== "string" || scope.actor_id.length === 0) {
    missing.push("actor_id");
  }
  if (missing.length > 0) {
    throw new ScopeError(`memory admission scope must carry ${missing.join(", ")}`);
  }
  return scope;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ValidationError("limit must be an integer between 1 and 500");
  }
  return limit;
}

interface DecisionRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  candidate_hash: string;
  item_id: string | null;
  item_version: number | null;
  disposition: string;
  reason_codes: string;
  check_results: string;
  duplicate_of_item_id: string | null;
  contradicts_item_ids: string;
  retrieval_eligible: number;
  factual_injection_allowed: number;
  run_id: string | null;
  created_at: string;
  created_by: string;
}

function toDecision(row: DecisionRow): MemoryAdmissionDecision {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    candidate_hash: row.candidate_hash,
    item_id: row.item_id,
    item_version: row.item_version,
    disposition: row.disposition as AdmissionDisposition,
    reason_codes: JSON.parse(row.reason_codes) as AdmissionReason[],
    check_results: JSON.parse(row.check_results) as AdmissionCheckResult[],
    duplicate_of_item_id: row.duplicate_of_item_id,
    contradicts_item_ids: JSON.parse(row.contradicts_item_ids) as MemoryItemId[],
    retrieval_eligible: row.retrieval_eligible === 1,
    factual_injection_allowed: row.factual_injection_allowed === 1,
    run_id: row.run_id,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

interface RetirementRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string;
  successor_item_id: string | null;
  proposed_action: string;
  reason_code: string;
  decision_id: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  created_by: string;
}

function toRetirement(row: RetirementRow): MemoryRetirementCandidate {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    successor_item_id: row.successor_item_id,
    proposed_action: row.proposed_action as RetirementAction,
    reason_code: row.reason_code as AdmissionReason,
    decision_id: row.decision_id,
    status: row.status as MemoryRetirementCandidate["status"],
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

class SqliteMemoryAdmissionRepository implements MemoryAdmissionRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  recordDecision(
    scope: WorkspaceScope,
    input: RecordAdmissionDecisionInput,
  ): MemoryAdmissionDecision {
    requireWorkspaceScope(scope);
    const id = newId("mad");
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_admission_decisions
           (id, enterprise_id, workspace_id, candidate_hash, item_id, item_version,
            disposition, reason_codes, check_results, duplicate_of_item_id,
            contradicts_item_ids, retrieval_eligible, factual_injection_allowed,
            run_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.candidate_hash,
        input.item_id,
        input.item_version,
        input.disposition,
        JSON.stringify([...input.reason_codes]),
        JSON.stringify([...input.check_results]),
        input.duplicate_of_item_id,
        JSON.stringify([...input.contradicts_item_ids]),
        input.retrieval_eligible ? 1 : 0,
        input.factual_injection_allowed ? 1 : 0,
        input.run_id ?? null,
        created_at,
        scope.actor_id,
      );
    return {
      id,
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      candidate_hash: input.candidate_hash,
      item_id: input.item_id,
      item_version: input.item_version,
      disposition: input.disposition,
      reason_codes: [...input.reason_codes],
      check_results: [...input.check_results],
      duplicate_of_item_id: input.duplicate_of_item_id,
      contradicts_item_ids: [...input.contradicts_item_ids],
      retrieval_eligible: input.retrieval_eligible,
      factual_injection_allowed: input.factual_injection_allowed,
      run_id: input.run_id ?? null,
      created_at,
      created_by: scope.actor_id,
    };
  }

  listDecisionsForItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryAdmissionDecision[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_admission_decisions
          WHERE enterprise_id = ? AND workspace_id = ? AND item_id = ?
          ORDER BY created_at DESC, id DESC`,
      )
      .all(scope.enterprise_id, scope.workspace_id, itemId) as unknown as DecisionRow[];
    return rows.map(toDecision);
  }

  findAcceptedDecision(
    scope: WorkspaceScope,
    candidateHash: string,
  ): MemoryAdmissionDecision | undefined {
    requireWorkspaceScope(scope);
    const row = this.db
      .prepare(
        `SELECT * FROM memory_admission_decisions
          WHERE enterprise_id = ? AND workspace_id = ? AND candidate_hash = ?
            AND disposition IN ('admitted', 'merged')
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(scope.enterprise_id, scope.workspace_id, candidateHash) as unknown as
      DecisionRow | undefined;
    return row === undefined ? undefined : toDecision(row);
  }

  listDecisions(scope: WorkspaceScope, limit?: number): MemoryAdmissionDecision[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_admission_decisions
          WHERE enterprise_id = ? AND workspace_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        boundedLimit(limit),
      ) as unknown as DecisionRow[];
    return rows.map(toDecision);
  }

  proposeRetirement(
    scope: WorkspaceScope,
    input: ProposeRetirementInput,
  ): MemoryRetirementCandidate {
    requireWorkspaceScope(scope);
    const existing = this.db
      .prepare(
        `SELECT * FROM memory_retirement_candidates
          WHERE enterprise_id = ? AND workspace_id = ? AND item_id = ?
            AND proposed_action = ? AND decision_id = ?
            AND COALESCE(successor_item_id, '') = ?`,
      )
      .get(
        scope.enterprise_id,
        scope.workspace_id,
        input.item_id,
        input.proposed_action,
        input.decision_id,
        input.successor_item_id ?? "",
      ) as unknown as RetirementRow | undefined;
    if (existing !== undefined) {
      return toRetirement(existing);
    }

    const id = newId("mrt");
    const created_at = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_retirement_candidates
           (id, enterprise_id, workspace_id, item_id, successor_item_id, proposed_action,
            reason_code, decision_id, status, resolved_at, resolved_by, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.item_id,
        input.successor_item_id,
        input.proposed_action,
        input.reason_code,
        input.decision_id,
        created_at,
        scope.actor_id,
      );
    return {
      id,
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      item_id: input.item_id,
      successor_item_id: input.successor_item_id,
      proposed_action: input.proposed_action,
      reason_code: input.reason_code,
      decision_id: input.decision_id,
      status: "pending",
      resolved_at: null,
      resolved_by: null,
      created_at,
      created_by: scope.actor_id,
    };
  }

  listRetirementCandidates(
    scope: WorkspaceScope,
    filter: RetirementListFilter = {},
  ): MemoryRetirementCandidate[] {
    requireWorkspaceScope(scope);
    const clauses = ["enterprise_id = ?", "workspace_id = ?"];
    const params: unknown[] = [scope.enterprise_id, scope.workspace_id];
    if (filter.item_id !== undefined) {
      clauses.push("item_id = ?");
      params.push(filter.item_id);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    params.push(boundedLimit(filter.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_retirement_candidates
          WHERE ${clauses.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...(params as [])) as unknown as RetirementRow[];
    return rows.map(toRetirement);
  }

  resolveRetirementCandidate(
    scope: WorkspaceScope,
    id: string,
    status: "accepted" | "rejected",
    resolvedBy: UserId,
  ): MemoryRetirementCandidate {
    requireWorkspaceScope(scope);
    const current = this.db
      .prepare(
        `SELECT * FROM memory_retirement_candidates
          WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .get(id, scope.enterprise_id, scope.workspace_id) as unknown as RetirementRow | undefined;
    if (current === undefined) {
      throw new NotFoundError("MemoryRetirementCandidate", id);
    }
    if (current.status !== "pending") {
      // Resolution is set-once; a repeat call is an idempotent no-op.
      return toRetirement(current);
    }
    this.db
      .prepare(
        `UPDATE memory_retirement_candidates
            SET status = ?, resolved_at = ?, resolved_by = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(status, nowIso(), resolvedBy, id);
    return toRetirement(
      this.db
        .prepare("SELECT * FROM memory_retirement_candidates WHERE id = ?")
        .get(id) as unknown as RetirementRow,
    );
  }
}

/** Build the admission repository over one control-plane database. */
export function createMemoryAdmissionRepository(db: ControlPlaneDb): MemoryAdmissionRepository {
  return new SqliteMemoryAdmissionRepository(db);
}
