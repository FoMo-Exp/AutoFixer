/**
 * Scheduled consolidation (DAT-235): the ADR-0009 "sleep-time" phase.
 *
 * A bounded background job that merges exact duplicates, recomputes the
 * derived confidence counters, detects stale facts through an injected
 * verifier, expires items past their validity window, decays unused
 * candidates, and decides recorded retirement and quarantine proposals — then
 * emits an auditable consolidation report.
 *
 * Ground rules, structural rather than aspirational:
 *
 * - **Fixed operation vocabulary.** Every corpus change is one of `merge`,
 *   `supersede`, `expire`, `deprecate`, `quarantine` and lands in the report
 *   with a fixed reason code. There is no free-form rewriting of the corpus.
 * - **It cannot advance delivery.** It runs outside a remediation run, never
 *   promotes an item, and touches only the memory store.
 * - **It never creates or restores memory.** Merge folds evidence between
 *   live items and retires absorbed duplicates; nothing here writes an item
 *   or a content version. Deleted memory is therefore never silently rebuilt
 *   from retained evidence — a proposal naming a deleted identity is skipped
 *   and recorded, never re-derived.
 * - **Quarantined and retired items are never touched.** Security response
 *   and terminal states are outside consolidation's reach.
 * - **It is bounded.** Items scanned and operations attempted are capped per
 *   run; a budget stop is recorded, not silently truncated.
 */

import { ConflictError, ValidationError } from "../../control-plane/errors.js";
import { newId, nowIso } from "../../control-plane/db.js";
import type { WorkspaceScope } from "../../control-plane/types.js";
import { isTimestamp } from "../../trace/schema.js";
import { citationKey } from "./independence.js";
import type { MemoryLifecycleStore } from "./repositories.js";
import type { MemoryRepositories } from "../repositories.js";
import type { MemoryItemRecord, MemoryStatus } from "../types.js";
import type {
  ConsolidationOpRecord,
  ConsolidationOpReason,
  ConsolidationOptions,
  ConsolidationReport,
  ProposedOp,
  UsageStat,
} from "./types.js";
import {
  DEFAULT_CONSOLIDATION_BOUNDS,
  MAX_CONSOLIDATION_ITEMS_SCANNED,
  MAX_CONSOLIDATION_OPS,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses an item may hold while consolidation still acts on it. */
const MERGEABLE_STATUSES: readonly MemoryStatus[] = [
  "proposed",
  "candidate",
  "active",
  "deprecated",
];
const OPEN_FOR_EXPIRE: readonly MemoryStatus[] = ["proposed", "candidate", "active"];
const OPEN_FOR_DEPRECATE: readonly MemoryStatus[] = ["proposed", "candidate", "active"];

/**
 * Canonical-selection rank for merged duplicates: an active item outranks a
 * candidate, and so on; ties break by age so the survivor is deterministic.
 */
const CANONICAL_RANK: Record<MemoryStatus, number> = {
  active: 0,
  candidate: 1,
  proposed: 2,
  deprecated: 3,
  quarantined: 4,
  retired: 5,
};

export interface ConsolidationDeps {
  memory: MemoryRepositories;
  lifecycle: MemoryLifecycleStore;
}

interface ResolvedBounds {
  at: string;
  atMs: number;
  maxItems: number;
  maxOps: number;
  decayUnusedMs: number;
}

function resolveBounds(options: ConsolidationOptions): ResolvedBounds {
  const at = options.at ?? nowIso();
  if (!isTimestamp(at)) {
    throw new ValidationError("consolidation at must be an RFC 3339 timestamp");
  }
  const positiveInt = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new ValidationError(`consolidation ${name} must be a positive integer`);
    }
    return value;
  };
  const maxItems = Math.min(
    positiveInt(
      options.max_items_scanned,
      DEFAULT_CONSOLIDATION_BOUNDS.max_items_scanned,
      "max_items_scanned",
    ),
    MAX_CONSOLIDATION_ITEMS_SCANNED,
  );
  const maxOps = Math.min(
    positiveInt(options.max_ops, DEFAULT_CONSOLIDATION_BOUNDS.max_ops, "max_ops"),
    MAX_CONSOLIDATION_OPS,
  );
  const decayDays = positiveInt(
    options.decay_unused_days,
    DEFAULT_CONSOLIDATION_BOUNDS.decay_unused_days,
    "decay_unused_days",
  );
  return {
    at: new Date(Date.parse(at)).toISOString(),
    atMs: Date.parse(at),
    maxItems,
    maxOps,
    decayUnusedMs: decayDays * DAY_MS,
  };
}

/**
 * Run one bounded consolidation pass over the workspace and persist its
 * report. Deterministic for a given corpus and options: passes run in a fixed
 * order — merge, recompute, stale, expire, decay, proposals — and every
 * decision re-reads the item at operation time.
 */
export function runConsolidation(
  scope: WorkspaceScope,
  deps: ConsolidationDeps,
  options: ConsolidationOptions = {},
): ConsolidationReport {
  const bounds = resolveBounds(options);
  const runId = newId("mcr");
  const ops: ConsolidationOpRecord[] = [];
  const state = {
    items_scanned: 0,
    counts_recomputed: 0,
    budget_exhausted: false,
  };
  const budgetLeft = (): number => bounds.maxOps - ops.length;
  const recordOp = (op: ConsolidationOpRecord): void => {
    ops.push(op);
    deps.lifecycle.recordConsolidationOp(scope, runId, op, bounds.at);
  };

  deps.lifecycle.startConsolidationRun(scope, runId, bounds.at);
  try {
    const scanned = deps.memory.items.list(scope, { limit: bounds.maxItems });
    state.items_scanned = scanned.length;

    // --- merge exact duplicates -------------------------------------------
    const groups = new Map<string, MemoryItemRecord[]>();
    for (const record of scanned) {
      if (!MERGEABLE_STATUSES.includes(record.item.status)) {
        continue;
      }
      const key = record.current.content_hash;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [record]);
      } else {
        group.push(record);
      }
    }
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      const [canonical, ...duplicates] = [...group].sort(
        (a, b) =>
          CANONICAL_RANK[a.item.status] - CANONICAL_RANK[b.item.status] ||
          Date.parse(a.item.created_at) - Date.parse(b.item.created_at) ||
          (a.item.id < b.item.id ? -1 : 1),
      );
      if (canonical === undefined) {
        continue;
      }
      for (const duplicate of duplicates) {
        if (budgetLeft() <= 0) {
          state.budget_exhausted = true;
          break;
        }
        const merged = mergeDuplicate(scope, deps, canonical.item.id, duplicate);
        if (merged !== null) {
          recordOp(merged);
        }
      }
      if (state.budget_exhausted) {
        break;
      }
    }

    // --- recompute derived confidence counters -----------------------------
    for (const record of scanned) {
      const fresh = deps.memory.items.getById(scope, record.item.id);
      if (fresh === undefined) {
        continue;
      }
      const citations = new Set<string>();
      for (const row of deps.memory.evidence.listByItem(scope, fresh.item.id)) {
        citations.add(citationKey({ evidence_type: row.evidence_type, reference: row.reference }));
      }
      let contradictions = 0;
      for (const link of deps.memory.links.listByItem(scope, fresh.item.id)) {
        if (link.link_type !== "contradicts") {
          continue;
        }
        const otherId = link.item_id === fresh.item.id ? link.target_item_id : link.item_id;
        const other = deps.memory.items.getById(scope, otherId);
        if (other !== undefined && OPEN_STATUSES.includes(other.item.status)) {
          contradictions += 1;
        }
      }
      if (
        fresh.item.support_count !== citations.size ||
        fresh.item.contradiction_count !== contradictions
      ) {
        deps.memory.items.setConfidenceCounts(scope, fresh.item.id, {
          supportCount: citations.size,
          contradictionCount: contradictions,
        });
        state.counts_recomputed += 1;
      }
    }

    // --- detect stale active facts -----------------------------------------
    if (options.verifier !== undefined) {
      for (const record of scanned) {
        if (budgetLeft() <= 0) {
          state.budget_exhausted = true;
          break;
        }
        const fresh = deps.memory.items.getById(scope, record.item.id);
        if (
          fresh === undefined ||
          fresh.item.status !== "active" ||
          fresh.current.kind !== "fact"
        ) {
          continue;
        }
        if (options.verifier.verify(fresh) !== "stale") {
          continue;
        }
        const op = applySingleItemOp(scope, deps, "deprecate", fresh, "stale_fact");
        if (op !== null) {
          recordOp(op);
        }
      }
    }

    // --- expire items past their validity window ---------------------------
    for (const record of scanned) {
      if (budgetLeft() <= 0) {
        state.budget_exhausted = true;
        break;
      }
      const fresh = deps.memory.items.getById(scope, record.item.id);
      if (fresh === undefined || !OPEN_FOR_EXPIRE.includes(fresh.item.status)) {
        continue;
      }
      if (fresh.current.valid_to === null || Date.parse(fresh.current.valid_to) > bounds.atMs) {
        continue;
      }
      const op = applySingleItemOp(scope, deps, "expire", fresh, "past_valid_to");
      if (op !== null) {
        recordOp(op);
      }
    }

    // --- decay unused candidates ------------------------------------------
    const usageByItem = new Map<string, UsageStat>();
    for (const usage of options.usage ?? []) {
      usageByItem.set(usage.item_id, usage);
    }
    for (const record of scanned) {
      if (budgetLeft() <= 0) {
        state.budget_exhausted = true;
        break;
      }
      const fresh = deps.memory.items.getById(scope, record.item.id);
      if (fresh === undefined || fresh.item.status !== "candidate") {
        continue;
      }
      if (Date.parse(fresh.item.created_at) > bounds.atMs - bounds.decayUnusedMs) {
        continue;
      }
      const recentEvidence = deps.memory.evidence
        .listByItem(scope, fresh.item.id)
        .some((row) => Date.parse(row.created_at) > bounds.atMs - bounds.decayUnusedMs);
      if (recentEvidence) {
        continue;
      }
      const usage = usageByItem.get(fresh.item.id);
      const recentlyUsed =
        usage !== undefined &&
        usage.use_count > 0 &&
        usage.last_used_at !== null &&
        Date.parse(usage.last_used_at) > bounds.atMs - bounds.decayUnusedMs;
      if (recentlyUsed) {
        continue;
      }
      const op = applySingleItemOp(scope, deps, "deprecate", fresh, "unused_decay");
      if (op !== null) {
        recordOp(op);
      }
    }

    // --- decide recorded proposals ----------------------------------------
    for (const proposal of options.proposals ?? []) {
      if (budgetLeft() <= 0) {
        state.budget_exhausted = true;
        break;
      }
      const op = applyProposedOp(scope, deps, proposal);
      if (op !== null) {
        recordOp(op);
      }
    }

    const report: ConsolidationReport = {
      run_id: runId,
      status: "completed",
      started_at: bounds.at,
      finished_at: bounds.at,
      items_scanned: state.items_scanned,
      counts_recomputed: state.counts_recomputed,
      ops,
      ops_applied: ops.filter((op) => op.applied).length,
      ops_skipped: ops.filter((op) => !op.applied).length,
      budget_exhausted: state.budget_exhausted,
    };
    deps.lifecycle.finishConsolidationRun(scope, report, "completed");
    return report;
  } catch (error) {
    const failed: ConsolidationReport = {
      run_id: runId,
      status: "failed",
      started_at: bounds.at,
      finished_at: bounds.at,
      items_scanned: state.items_scanned,
      counts_recomputed: state.counts_recomputed,
      ops,
      ops_applied: ops.filter((op) => op.applied).length,
      ops_skipped: ops.filter((op) => !op.applied).length,
      budget_exhausted: state.budget_exhausted,
    };
    deps.lifecycle.finishConsolidationRun(scope, failed, "failed");
    throw error;
  }
}

/** Statuses in which a contradiction is still an open conflict. */
const OPEN_STATUSES: readonly MemoryStatus[] = ["proposed", "candidate", "active"];

/**
 * Fold one exact duplicate into its canonical item: fold missing evidence
 * citations, link the pair, and retire the absorbed duplicate through
 * `deprecated`. Atomic per duplicate; returns null when the corpus changed
 * under the scan and nothing merged.
 */
function mergeDuplicate(
  scope: WorkspaceScope,
  deps: ConsolidationDeps,
  canonicalId: string,
  duplicate: MemoryItemRecord,
): ConsolidationOpRecord | null {
  return deps.memory.runAtomically(() => {
    const canonical = deps.memory.items.getById(scope, canonicalId);
    const fresh = deps.memory.items.getById(scope, duplicate.item.id);
    if (
      canonical === undefined ||
      fresh === undefined ||
      !MERGEABLE_STATUSES.includes(fresh.item.status) ||
      fresh.current.content_hash !== canonical.current.content_hash
    ) {
      return null;
    }
    const existing = new Set<string>();
    for (const row of deps.memory.evidence.listByItem(scope, canonical.item.id)) {
      existing.add(citationKey({ evidence_type: row.evidence_type, reference: row.reference }));
    }
    let folded = 0;
    for (const row of deps.memory.evidence.listByItem(scope, fresh.item.id)) {
      const key = citationKey({ evidence_type: row.evidence_type, reference: row.reference });
      if (!existing.has(key)) {
        deps.memory.evidence.add(scope, canonical.item.id, {
          evidence_type: row.evidence_type,
          reference: row.reference,
        });
        existing.add(key);
        folded += 1;
      }
    }
    try {
      deps.memory.links.create(scope, {
        item_id: canonical.item.id,
        target_item_id: fresh.item.id,
        link_type: "related",
        reason: "duplicate_content",
      });
    } catch (error) {
      // A pre-existing link (for example from an earlier admission merge)
      // already records the relationship; the merge itself proceeds.
      if (!(error instanceof ConflictError)) {
        throw error;
      }
    }
    if (fresh.item.status !== "deprecated") {
      deps.memory.items.setStatus(scope, fresh.item.id, "deprecated", fresh.item.current_version);
    }
    deps.memory.items.setStatus(scope, fresh.item.id, "retired", fresh.item.current_version);
    return {
      op: "merge",
      item_id: fresh.item.id,
      target_item_id: canonical.item.id,
      item_version: fresh.item.current_version,
      reason_code: "duplicate_content",
      applied: true,
      detail: { evidence_folded: folded },
    };
  });
}

/**
 * Apply one single-item operation (`expire` or `deprecate`) at its current
 * state, or return null when the item is gone or no longer eligible.
 */
function applySingleItemOp(
  scope: WorkspaceScope,
  deps: ConsolidationDeps,
  op: "expire" | "deprecate",
  record: MemoryItemRecord,
  reason: ConsolidationOpReason,
): ConsolidationOpRecord | null {
  const eligible = op === "expire" ? OPEN_FOR_EXPIRE : OPEN_FOR_DEPRECATE;
  if (!eligible.includes(record.item.status)) {
    return null;
  }
  deps.memory.items.setStatus(scope, record.item.id, "deprecated", record.item.current_version);
  return {
    op,
    item_id: record.item.id,
    target_item_id: null,
    item_version: record.item.current_version,
    reason_code: reason,
    applied: true,
    detail: {},
  };
}

/**
 * Decide one recorded proposal. Every outcome is recorded: an applied
 * operation, or an explicit skip with the reason it did not run. A proposal
 * whose identity was deleted is skipped with `item_deleted` — deleted memory
 * is never rebuilt from a retained proposal.
 */
function applyProposedOp(
  scope: WorkspaceScope,
  deps: ConsolidationDeps,
  proposal: ProposedOp,
): ConsolidationOpRecord | null {
  const skip = (
    reason: ConsolidationOpReason,
    itemVersion: number | null,
  ): ConsolidationOpRecord => ({
    op: proposal.op,
    item_id: proposal.item_id,
    target_item_id: proposal.successor_item_id ?? null,
    item_version: itemVersion,
    reason_code: reason,
    applied: false,
    detail: {},
  });
  const record = deps.memory.items.getById(scope, proposal.item_id);
  if (record === undefined) {
    const tombstone = deps.memory.tombstones.getByItem(scope, proposal.item_id);
    return skip(tombstone === undefined ? "item_missing" : "item_deleted", null);
  }
  if (proposal.op === "supersede") {
    const successorId = proposal.successor_item_id;
    if (successorId === undefined) {
      throw new ValidationError("a supersede proposal requires a successor_item_id");
    }
    const successor = deps.memory.items.getById(scope, successorId);
    if (successor === undefined) {
      const tombstone = deps.memory.tombstones.getByItem(scope, successorId);
      return skip(
        tombstone === undefined ? "item_missing" : "item_deleted",
        record.item.current_version,
      );
    }
    // A quarantined item is security-response territory and a retired item is
    // terminal: consolidation never touches either, so a supersede proposal
    // closes no validity window and writes no succession link for them.
    if (record.item.status === "retired" || record.item.status === "quarantined") {
      return skip("status_not_applicable", record.item.current_version);
    }
    deps.memory.items.supersede(scope, record.item.id, successorId, proposal.reason_code);
    return {
      op: "supersede",
      item_id: record.item.id,
      target_item_id: successorId,
      item_version: record.item.current_version,
      reason_code: proposal.reason_code,
      applied: true,
      detail: {},
    };
  }
  if (proposal.op === "deprecate") {
    if (!OPEN_FOR_DEPRECATE.includes(record.item.status)) {
      return skip("status_not_applicable", record.item.current_version);
    }
    deps.memory.items.setStatus(scope, record.item.id, "deprecated", record.item.current_version);
    return {
      op: "deprecate",
      item_id: record.item.id,
      target_item_id: null,
      item_version: record.item.current_version,
      reason_code: proposal.reason_code,
      applied: true,
      detail: {},
    };
  }
  // quarantine: reachable from every non-terminal state; retired is terminal
  // and a quarantined item is already out of retrieval.
  if (record.item.status === "retired" || record.item.status === "quarantined") {
    return skip("status_not_applicable", record.item.current_version);
  }
  deps.memory.items.setStatus(scope, record.item.id, "quarantined", record.item.current_version);
  return {
    op: "quarantine",
    item_id: record.item.id,
    target_item_id: null,
    item_version: record.item.current_version,
    reason_code: proposal.reason_code,
    applied: true,
    detail: {},
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ConsolidationScheduleHandle {
  /** Stop the schedule; safe to call twice. */
  stop(): void;
}

export interface ConsolidationScheduleOptions {
  /** Interval between runs; a positive integer number of milliseconds. */
  intervalMs: number;
  /** The bounded consolidation entry point; expected to run synchronously. */
  run: () => void;
  /** Isolation boundary: a failing run never stops the schedule. */
  onError?: (error: unknown) => void;
}

/**
 * The "on a schedule" half of consolidation: fixed-interval invocation of the
 * bounded job outside any remediation run. Ticks that arrive while a run is
 * still in flight are dropped, never queued, and the timer never holds the
 * process open.
 */
export function scheduleMemoryConsolidation(
  options: ConsolidationScheduleOptions,
): ConsolidationScheduleHandle {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new ValidationError("consolidation intervalMs must be a positive integer");
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    try {
      options.run();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  }, options.intervalMs);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
