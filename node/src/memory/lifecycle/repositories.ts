/**
 * Lifecycle persistence (DAT-235): promotion policy, promotion decisions, and
 * consolidation run/operation reports.
 *
 * These tables live in the control-plane SQLite database (migration version
 * 6). The policy row is workspace configuration and cascades with its
 * workspace; decisions and reports are audit records that carry only opaque
 * IDs, fixed enums, one-way digests, counts, and timestamps — never memory
 * statements, provenance payloads, or free-text reasons — so, like
 * `memory_events`, they survive item deletion and workspace erasure without
 * leaking content.
 */

import { createHash } from "node:crypto";

import type { ControlPlaneDb } from "../../control-plane/db.js";
import { newId, nowIso } from "../../control-plane/db.js";
import { ValidationError } from "../../control-plane/errors.js";
import type { UserId, WorkspaceScope } from "../../control-plane/types.js";
import type { MemoryItemId, MemoryKind } from "../types.js";
import type { MemoryTimelinePosition } from "../repositories.js";
import type {
  ConsolidationOp,
  ConsolidationOpReason,
  ConsolidationOpRecord,
  ConsolidationReport,
  MemoryPromotionPolicy,
  PromotionReason,
} from "./types.js";
import {
  CONSOLIDATION_OPS,
  CONSOLIDATION_OP_REASONS,
  DEFAULT_PROMOTION_POLICY,
  PROMOTION_BLOCK_REASONS,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export interface MemoryPromotionPolicyRecord extends MemoryPromotionPolicy {
  created_at: string;
  created_by: UserId;
  updated_at: string;
  updated_by: UserId;
}

export interface PromotionDecisionInput {
  item_id: MemoryItemId;
  item_version: number;
  kind: MemoryKind;
  outcome: "promoted" | "blocked";
  reasons: readonly PromotionReason[];
  independent_support_runs: number;
  evaluation_delta: number | null;
  run_id: string | null;
}

export interface PromotionDecisionRecord {
  id: string;
  item_id: MemoryItemId;
  item_version: number;
  kind: MemoryKind;
  outcome: "promoted" | "blocked";
  reasons: PromotionReason[];
  independent_support_runs: number;
  evaluation_delta: number | null;
  policy_digest: string;
  run_id: string | null;
  created_at: string;
  created_by: UserId;
}

export interface ConsolidationOpRecordWithTime extends ConsolidationOpRecord {
  /** When the operation row was written (RFC 3339, canonical UTC). */
  created_at: string;
  created_by: UserId;
  run_id: string;
}

/** One promotion decision with its audit-stream position. */
export interface PromotionDecisionEntry {
  decision: PromotionDecisionRecord;
  sequence: number;
}

/** One consolidation operation with its audit-stream position. */
export interface ConsolidationOpEntry {
  op: ConsolidationOpRecordWithTime;
  sequence: number;
}

export interface MemoryLifecycleStore {
  /** The workspace's promotion policy, or the ADR-0009 defaults when unset. */
  getPolicy(scope: WorkspaceScope): MemoryPromotionPolicyRecord;
  /**
   * Set the workspace's promotion policy. The ADR floor is enforced here too:
   * a workspace may disable automatic promotion and raise the threshold, but
   * never require fewer than two independent runs.
   */
  setPolicy(scope: WorkspaceScope, policy: MemoryPromotionPolicy): MemoryPromotionPolicyRecord;
  /** Persist one promotion assessment. Every assessment is auditable. */
  recordPromotionDecision(scope: WorkspaceScope, input: PromotionDecisionInput): void;
  /**
   * Promotion decisions of this workspace, newest first — optionally only
   * those of one item. The audit behind "below threshold stays inactive".
   */
  listPromotionDecisions(
    scope: WorkspaceScope,
    filter?: { item_id?: MemoryItemId; limit?: number },
  ): PromotionDecisionRecord[];
  /** Open a consolidation run row (`status: running`). */
  startConsolidationRun(scope: WorkspaceScope, runId: string, startedAt: string): void;
  /** Record one applied or skipped consolidation operation. */
  recordConsolidationOp(
    scope: WorkspaceScope,
    runId: string,
    op: ConsolidationOpRecord,
    createdAt: string,
  ): void;
  /** Close a consolidation run row with its bounded summary. */
  finishConsolidationRun(
    scope: WorkspaceScope,
    report: ConsolidationReport,
    status: "completed" | "failed",
  ): void;
  /** Consolidation runs of this workspace, newest first. */
  listConsolidationRuns(scope: WorkspaceScope, limit?: number): ConsolidationReport[];
  /** Operations of one consolidation run, in application order. */
  listConsolidationOps(scope: WorkspaceScope, runId: string): ConsolidationOpRecord[];
  /**
   * Keyset page of one item's promotion decisions, oldest first (DAT-251).
   * `after` is exclusive, so the governance timeline traverses the whole
   * decision history instead of a fixed newest-first sample.
   */
  listPromotionDecisionsPage(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    after: MemoryTimelinePosition | undefined,
    limit: number,
  ): PromotionDecisionEntry[];
  /**
   * Keyset page of the consolidation operations that targeted one item,
   * oldest first (DAT-251). A read over the existing ops table, not a new
   * record, and pageable for the same reason.
   */
  listConsolidationOpsForItem(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    after: MemoryTimelinePosition | undefined,
    limit: number,
  ): ConsolidationOpEntry[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const KINDS: readonly MemoryKind[] = [
  "fact",
  "lesson",
  "playbook",
  "anti_pattern",
  "episode",
  "policy",
];
const BLOCK_REASONS: readonly PromotionReason[] = [...PROMOTION_BLOCK_REASONS];

function assertReasons(reasons: readonly PromotionReason[]): void {
  for (const reason of reasons) {
    if (
      !BLOCK_REASONS.includes(reason) &&
      reason !== "auto_promoted" &&
      reason !== "human_approved"
    ) {
      throw new ValidationError(`unsupported promotion reason: ${String(reason)}`);
    }
  }
}

function assertOpRecord(op: ConsolidationOpRecord): void {
  if (!CONSOLIDATION_OPS.includes(op.op)) {
    throw new ValidationError(`unsupported consolidation op: ${String(op.op)}`);
  }
  if (!CONSOLIDATION_OP_REASONS.includes(op.reason_code)) {
    throw new ValidationError(`unsupported consolidation reason: ${String(op.reason_code)}`);
  }
  for (const value of Object.values(op.detail)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ValidationError("consolidation op detail must hold non-negative integer counts");
    }
  }
}

/** Stable one-way digest of a promotion policy, for decision audit rows. */
export function promotionPolicyDigest(policy: MemoryPromotionPolicy): string {
  const canonical = `${policy.auto_promote_facts ? 1 : 0}:${policy.fact_min_independent_runs}:${
    policy.require_human_approval_all ? 1 : 0
  }`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizePolicy(policy: MemoryPromotionPolicy): MemoryPromotionPolicy {
  if (
    policy === null ||
    typeof policy !== "object" ||
    typeof policy.auto_promote_facts !== "boolean" ||
    typeof policy.require_human_approval_all !== "boolean"
  ) {
    throw new ValidationError("promotion policy fields must be booleans");
  }
  if (!Number.isInteger(policy.fact_min_independent_runs) || policy.fact_min_independent_runs < 2) {
    throw new ValidationError(
      "fact_min_independent_runs is an integer of at least 2; a workspace may raise the threshold, never lower it",
    );
  }
  return {
    auto_promote_facts: policy.auto_promote_facts,
    fact_min_independent_runs: policy.fact_min_independent_runs,
    require_human_approval_all: policy.require_human_approval_all,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PolicyRow {
  enterprise_id: string;
  workspace_id: string;
  auto_promote_facts: number;
  fact_min_independent_runs: number;
  require_human_approval_all: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface DecisionRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string;
  item_version: number;
  kind: string;
  outcome: string;
  reasons: string;
  independent_support_runs: number;
  evaluation_delta: number | null;
  policy_digest: string;
  run_id: string | null;
  created_at: string;
  created_by: string;
}

interface RunRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  items_scanned: number;
  counts_recomputed: number;
  ops_applied: number;
  ops_skipped: number;
  budget_exhausted: number;
  created_at: string;
  created_by: string;
}

interface OpRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  run_id: string;
  op: string;
  item_id: string;
  target_item_id: string | null;
  item_version: number | null;
  reason_code: string;
  applied: number;
  detail: string;
  created_at: string;
  created_by: string;
}

function toPromotionDecision(row: DecisionRow): PromotionDecisionRecord {
  return {
    id: row.id,
    item_id: row.item_id,
    item_version: row.item_version,
    kind: row.kind as MemoryKind,
    outcome: row.outcome as "promoted" | "blocked",
    reasons: JSON.parse(row.reasons) as PromotionReason[],
    independent_support_runs: row.independent_support_runs,
    evaluation_delta: row.evaluation_delta,
    policy_digest: row.policy_digest,
    run_id: row.run_id,
    created_at: row.created_at,
    created_by: row.created_by as UserId,
  };
}

function toConsolidationOp(row: OpRow): ConsolidationOpRecord {
  return {
    op: row.op as ConsolidationOp,
    item_id: row.item_id,
    target_item_id: row.target_item_id,
    item_version: row.item_version,
    reason_code: row.reason_code as ConsolidationOpReason,
    applied: row.applied === 1,
    detail: JSON.parse(row.detail) as Record<string, number>,
  };
}

class SqliteMemoryLifecycleStore implements MemoryLifecycleStore {
  constructor(private readonly db: ControlPlaneDb) {}

  getPolicy(scope: WorkspaceScope): MemoryPromotionPolicyRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_promotion_policy
         WHERE enterprise_id = ? AND workspace_id = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id) as PolicyRow | undefined;
    if (row === undefined) {
      return {
        ...DEFAULT_PROMOTION_POLICY,
        created_at: nowIso(),
        created_by: scope.actor_id,
        updated_at: nowIso(),
        updated_by: scope.actor_id,
      };
    }
    return {
      auto_promote_facts: row.auto_promote_facts === 1,
      fact_min_independent_runs: row.fact_min_independent_runs,
      require_human_approval_all: row.require_human_approval_all === 1,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  }

  setPolicy(scope: WorkspaceScope, policy: MemoryPromotionPolicy): MemoryPromotionPolicyRecord {
    const normalized = normalizePolicy(policy);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_promotion_policy
           (enterprise_id, workspace_id, auto_promote_facts, fact_min_independent_runs,
            require_human_approval_all, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (enterprise_id, workspace_id) DO UPDATE SET
           auto_promote_facts = excluded.auto_promote_facts,
           fact_min_independent_runs = excluded.fact_min_independent_runs,
           require_human_approval_all = excluded.require_human_approval_all,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(
        scope.enterprise_id,
        scope.workspace_id,
        normalized.auto_promote_facts ? 1 : 0,
        normalized.fact_min_independent_runs,
        normalized.require_human_approval_all ? 1 : 0,
        now,
        scope.actor_id,
        now,
        scope.actor_id,
      );
    return this.getPolicy(scope);
  }

  recordPromotionDecision(scope: WorkspaceScope, input: PromotionDecisionInput): void {
    if (!KINDS.includes(input.kind)) {
      throw new ValidationError(`unsupported memory kind: ${String(input.kind)}`);
    }
    if (input.outcome !== "promoted" && input.outcome !== "blocked") {
      throw new ValidationError(`unsupported promotion outcome: ${String(input.outcome)}`);
    }
    assertReasons(input.reasons);
    if (!Number.isInteger(input.independent_support_runs) || input.independent_support_runs < 0) {
      throw new ValidationError("independent_support_runs must be a non-negative integer");
    }
    this.db
      .prepare(
        `INSERT INTO memory_promotion_decisions
           (id, enterprise_id, workspace_id, item_id, item_version, kind, outcome, reasons,
            independent_support_runs, evaluation_delta, policy_digest, run_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("mpd"),
        scope.enterprise_id,
        scope.workspace_id,
        input.item_id,
        input.item_version,
        input.kind,
        input.outcome,
        JSON.stringify([...input.reasons]),
        input.independent_support_runs,
        input.evaluation_delta,
        promotionPolicyDigest(this.getPolicy(scope)),
        input.run_id,
        nowIso(),
        scope.actor_id,
      );
  }

  listPromotionDecisions(
    scope: WorkspaceScope,
    filter: { item_id?: MemoryItemId; limit?: number } = {},
  ): PromotionDecisionRecord[] {
    const clauses = ["enterprise_id = ?", "workspace_id = ?"];
    const params: (string | number)[] = [scope.enterprise_id, scope.workspace_id];
    if (filter.item_id !== undefined) {
      clauses.push("item_id = ?");
      params.push(filter.item_id);
    }
    params.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_promotion_decisions
         WHERE ${clauses.join(" AND ")}
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...params) as unknown as DecisionRow[];
    return rows.map(toPromotionDecision);
  }

  listPromotionDecisionsPage(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    after: MemoryTimelinePosition | undefined,
    limit: number,
  ): PromotionDecisionEntry[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const keyset =
      after === undefined ? "" : " AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    const params: (string | number)[] = [scope.enterprise_id, scope.workspace_id, itemId];
    if (after !== undefined) {
      params.push(after.at, after.at, after.sequence);
    }
    params.push(bounded);
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence, * FROM memory_promotion_decisions
          WHERE enterprise_id = ? AND workspace_id = ? AND item_id = ?${keyset}
          ORDER BY created_at, rowid
          LIMIT ?`,
      )
      .all(...params) as unknown as (DecisionRow & { sequence: number })[];
    return rows.map((row) => ({ decision: toPromotionDecision(row), sequence: row.sequence }));
  }

  startConsolidationRun(scope: WorkspaceScope, runId: string, startedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_consolidation_runs
           (id, enterprise_id, workspace_id, status, started_at, items_scanned, counts_recomputed,
            ops_applied, ops_skipped, budget_exhausted, created_at, created_by)
         VALUES (?, ?, ?, 'running', ?, 0, 0, 0, 0, 0, ?, ?)`,
      )
      .run(runId, scope.enterprise_id, scope.workspace_id, startedAt, startedAt, scope.actor_id);
  }

  recordConsolidationOp(
    scope: WorkspaceScope,
    runId: string,
    op: ConsolidationOpRecord,
    createdAt: string,
  ): void {
    assertOpRecord(op);
    this.db
      .prepare(
        `INSERT INTO memory_consolidation_ops
           (id, enterprise_id, workspace_id, run_id, op, item_id, target_item_id, item_version,
            reason_code, applied, detail, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("mco"),
        scope.enterprise_id,
        scope.workspace_id,
        runId,
        op.op,
        op.item_id,
        op.target_item_id,
        op.item_version,
        op.reason_code,
        op.applied ? 1 : 0,
        JSON.stringify(op.detail),
        createdAt,
        scope.actor_id,
      );
  }

  finishConsolidationRun(
    scope: WorkspaceScope,
    report: ConsolidationReport,
    status: "completed" | "failed",
  ): void {
    this.db
      .prepare(
        `UPDATE memory_consolidation_runs
           SET status = ?, finished_at = ?, items_scanned = ?, counts_recomputed = ?,
               ops_applied = ?, ops_skipped = ?, budget_exhausted = ?
         WHERE id = ? AND enterprise_id = ? AND workspace_id = ?`,
      )
      .run(
        status,
        report.finished_at,
        report.items_scanned,
        report.counts_recomputed,
        report.ops_applied,
        report.ops_skipped,
        report.budget_exhausted ? 1 : 0,
        report.run_id,
        scope.enterprise_id,
        scope.workspace_id,
      );
  }

  listConsolidationRuns(scope: WorkspaceScope, limit = 50): ConsolidationReport[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_consolidation_runs
         WHERE enterprise_id = ? AND workspace_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        Math.min(Math.max(limit, 1), 500),
      ) as unknown as RunRow[];
    return rows.map((row) => ({
      run_id: row.id,
      status: row.status as ConsolidationReport["status"],
      started_at: row.started_at,
      finished_at: row.finished_at ?? row.started_at,
      items_scanned: row.items_scanned,
      counts_recomputed: row.counts_recomputed,
      ops: [],
      ops_applied: row.ops_applied,
      ops_skipped: row.ops_skipped,
      budget_exhausted: row.budget_exhausted === 1,
    }));
  }

  listConsolidationOps(scope: WorkspaceScope, runId: string): ConsolidationOpRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_consolidation_ops
         WHERE enterprise_id = ? AND workspace_id = ? AND run_id = ?
         ORDER BY rowid`,
      )
      .all(scope.enterprise_id, scope.workspace_id, runId) as unknown as OpRow[];
    return rows.map(toConsolidationOp);
  }

  listConsolidationOpsForItem(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    after: MemoryTimelinePosition | undefined,
    limit: number,
  ): ConsolidationOpEntry[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const keyset =
      after === undefined ? "" : " AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    const params: (string | number)[] = [scope.enterprise_id, scope.workspace_id, itemId];
    if (after !== undefined) {
      params.push(after.at, after.at, after.sequence);
    }
    params.push(bounded);
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence, * FROM memory_consolidation_ops
          WHERE enterprise_id = ? AND workspace_id = ? AND item_id = ?${keyset}
          ORDER BY created_at, rowid
          LIMIT ?`,
      )
      .all(...params) as unknown as (OpRow & { sequence: number })[];
    return rows.map((row) => ({
      op: {
        ...toConsolidationOp(row),
        created_at: row.created_at,
        created_by: row.created_by as UserId,
        run_id: row.run_id,
      },
      sequence: row.sequence,
    }));
  }
}

export function createMemoryLifecycleStore(db: ControlPlaneDb): MemoryLifecycleStore {
  return new SqliteMemoryLifecycleStore(db);
}
