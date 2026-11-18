/**
 * Durable distillation outbox (DAT-265).
 *
 * Distillation is scheduled, not performed in the capture worker: the outbox
 * derives one row per captured snapshot whose outcome class is learnable
 * (`accepted`, `rejected`, `cancelled`, `failed`) and a worker claims rows
 * under a lease. That is what makes the write path survive a restart (pending
 * rows are still there), a duplicate derivation (the unique capture key keeps
 * one row), and concurrent workers (only one claim wins).
 *
 * Two invariants live here:
 *
 * - Episode-only outcomes (`timeout`, `unknown`, `infra_failure`) never get a
 *   distillation row: they are captured as episodes and nothing else, so no
 *   model call can ever turn them into a candidate or a success claim.
 * - The row carries the **server-side** enterprise/workspace that owns the
 *   task. The worker builds the memory scope from these columns, never from
 *   the envelope or any model output.
 */

import type { ControlPlaneDb } from "../control-plane/db.js";
import { newId, nowIso } from "../control-plane/db.js";
import { ValidationError } from "../control-plane/errors.js";

export const DISTILLATION_JOB_STATES = [
  "pending",
  "processing",
  "distilled",
  "skipped",
  "failed",
] as const;
export type DistillationJobState = (typeof DISTILLATION_JOB_STATES)[number];

/**
 * Outcome classes that carry learnable evidence (`classification.known`).
 * Everything else is episode-only and never distilled from.
 */
export const LEARNABLE_OUTCOME_CLASSES = ["accepted", "rejected", "cancelled", "failed"] as const;

export interface DistillationJob {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  capture_job_id: string;
  run_id: string;
  terminal_state: string;
  outcome_class: string;
  state: DistillationJobState;
  attempts: number;
  lease_until: string | null;
  retry_after: string | null;
  last_error: string | null;
  model_id: string | null;
  prompt_template_version: string;
  /** Items this pass produced (or merged into); JSON array of item ids. */
  item_ids: string;
  /** Candidates kept (new, merged, or held as `proposed`). */
  accepted: number;
  /** Candidates dropped by validation or discarded by the admission gate. */
  dropped: number;
  created_at: string;
  updated_at: string;
}

export interface DistillationJobFilter {
  workspace_id?: string;
  run_id?: string;
  state?: DistillationJobState;
}

export interface MarkDistilledInput {
  model_id: string;
  item_ids: readonly string[];
  accepted: number;
  dropped: number;
}

export interface DistillationJobStore {
  /**
   * Derive a pending job for every captured learnable snapshot that does not
   * have one yet. Idempotent: the unique capture key keeps one row per
   * snapshot, and a snapshot captured before this outbox existed (no stored
   * envelope) is never enqueued with a reconstructed one.
   */
  sync(limit: number): number;
  /** Claim the oldest due row under a lease; `null` when nothing is due. */
  claim(now: Date, leaseMs: number): DistillationJob | null;
  /** Record a completed pass and the items it produced. */
  markDistilled(id: string, input: MarkDistilledInput, now?: Date): void;
  /**
   * End a snapshot without candidates: its batch was rejected by policy, or
   * its outcome is episode-only. Never a silent success — the reason code is
   * persisted on the row.
   */
  markSkipped(id: string, reasonCode: string, now?: Date): void;
  /** Return a claimed row to `pending` with a bounded backoff. */
  markRetry(id: string, errorCode: string, retryAfter: Date, now?: Date): void;
  /** End a snapshot as permanently failed after its attempt budget. */
  markFailed(id: string, errorCode: string, now?: Date): void;
  get(id: string): DistillationJob | undefined;
  list(filter?: DistillationJobFilter): DistillationJob[];
}

interface DistillationJobRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  capture_job_id: string;
  run_id: string;
  terminal_state: string;
  outcome_class: string;
  state: string;
  attempts: number;
  lease_until: string | null;
  retry_after: string | null;
  last_error: string | null;
  model_id: string | null;
  prompt_template_version: string;
  item_ids: string;
  accepted: number;
  dropped: number;
  created_at: string;
  updated_at: string;
}

interface DerivedSnapshotRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  run_id: string;
  terminal_state: string;
  outcome_class: string;
}

function toJob(row: DistillationJobRow): DistillationJob {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    capture_job_id: row.capture_job_id,
    run_id: row.run_id,
    terminal_state: row.terminal_state,
    outcome_class: row.outcome_class,
    state: row.state as DistillationJobState,
    attempts: row.attempts,
    lease_until: row.lease_until,
    retry_after: row.retry_after,
    last_error: row.last_error,
    model_id: row.model_id,
    prompt_template_version: row.prompt_template_version,
    item_ids: row.item_ids,
    accepted: row.accepted,
    dropped: row.dropped,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * One error token per failed attempt. Only stable codes are stored: an error
 * message can carry a path, a URL, or provider text and must never enter the
 * outbox.
 */
function requireErrorCode(code: string): string {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new ValidationError("distillation job error code must be a stable uppercase token");
  }
  return code;
}

function requireCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`distillation job ${field} must be a non-negative integer`);
  }
  return value;
}

export function createDistillationJobStore(
  db: ControlPlaneDb,
  promptTemplateVersion: string,
): DistillationJobStore {
  if (typeof promptTemplateVersion !== "string" || promptTemplateVersion.trim().length === 0) {
    throw new ValidationError("distillation prompt template version must be a non-empty string");
  }
  const selectById = db.prepare("SELECT * FROM memory_distillation WHERE id = ?");

  const get = (id: string): DistillationJob | undefined => {
    const row = selectById.get(id) as DistillationJobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  };

  return {
    sync(limit) {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new ValidationError("distillation sync limit must be a positive integer");
      }
      // Derived from the capture outbox, never from a caller's claim: only a
      // captured snapshot with a stored envelope in a learnable class and no
      // existing job is a candidate. Pre-migration captures have no envelope
      // and are deliberately left alone.
      const snapshots = db
        .prepare(
          `SELECT c.id, c.enterprise_id, c.workspace_id, c.run_id, c.terminal_state,
                  c.outcome_class
             FROM memory_outcome_capture c
             LEFT JOIN memory_distillation d ON d.capture_job_id = c.id
            WHERE c.state = 'captured'
              AND c.envelope IS NOT NULL
              AND c.outcome_class IN ('accepted', 'rejected', 'cancelled', 'failed')
              AND d.id IS NULL
            ORDER BY c.created_at, c.id
            LIMIT ?`,
        )
        .all(limit) as unknown as DerivedSnapshotRow[];
      const insert = db.prepare(
        `INSERT INTO memory_distillation
           (id, enterprise_id, workspace_id, capture_job_id, run_id, terminal_state,
            outcome_class, state, attempts, lease_until, retry_after, last_error, model_id,
            prompt_template_version, item_ids, accepted, dropped, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, '[]', 0, 0, ?, ?)
         ON CONFLICT(capture_job_id) DO NOTHING`,
      );
      let inserted = 0;
      for (const snapshot of snapshots) {
        const now = nowIso();
        const result = insert.run(
          newId("mds"),
          snapshot.enterprise_id,
          snapshot.workspace_id,
          snapshot.id,
          snapshot.run_id,
          snapshot.terminal_state,
          snapshot.outcome_class,
          promptTemplateVersion,
          now,
          now,
        );
        inserted += result.changes === 1 ? 1 : 0;
      }
      return inserted;
    },

    claim(now, leaseMs) {
      if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
        throw new ValidationError("distillation lease must be a positive integer of milliseconds");
      }
      const at = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const candidate = db
        .prepare(
          `SELECT id FROM memory_distillation
           WHERE (state = 'pending' AND (retry_after IS NULL OR retry_after <= ?))
              OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?)
           ORDER BY created_at, id
           LIMIT 1`,
        )
        .get(at, at) as { id: string } | undefined;
      if (candidate === undefined) {
        return null;
      }
      const updated = db
        .prepare(
          `UPDATE memory_distillation
           SET state = 'processing', lease_until = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ?
             AND ((state = 'pending' AND (retry_after IS NULL OR retry_after <= ?))
               OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?))`,
        )
        .run(leaseUntil, at, candidate.id, at, at);
      if (updated.changes !== 1) {
        // Another worker won the same row between the read and the update.
        return null;
      }
      return get(candidate.id) ?? null;
    },

    markDistilled(id, input, now = new Date()) {
      // Only opaque memory item ids are stored — never candidate text.
      const itemIds = JSON.stringify(
        input.item_ids.filter((itemId) => typeof itemId === "string" && itemId.length > 0),
      );
      db.prepare(
        `UPDATE memory_distillation
         SET state = 'distilled', model_id = ?, item_ids = ?, accepted = ?, dropped = ?,
             lease_until = NULL, retry_after = NULL, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.model_id,
        itemIds,
        requireCount(input.accepted, "accepted"),
        requireCount(input.dropped, "dropped"),
        now.toISOString(),
        id,
      );
    },

    markSkipped(id, reasonCode, now = new Date()) {
      db.prepare(
        `UPDATE memory_distillation
         SET state = 'skipped', lease_until = NULL, retry_after = NULL, last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(requireErrorCode(reasonCode), now.toISOString(), id);
    },

    markRetry(id, errorCode, retryAfter, now = new Date()) {
      db.prepare(
        `UPDATE memory_distillation
         SET state = 'pending', lease_until = NULL, retry_after = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(retryAfter.toISOString(), requireErrorCode(errorCode), now.toISOString(), id);
    },

    markFailed(id, errorCode, now = new Date()) {
      db.prepare(
        `UPDATE memory_distillation
         SET state = 'failed', lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(requireErrorCode(errorCode), now.toISOString(), id);
    },

    get,

    list(filter = {}) {
      const clauses: string[] = [];
      const values: string[] = [];
      if (filter.workspace_id !== undefined) {
        clauses.push("workspace_id = ?");
        values.push(filter.workspace_id);
      }
      if (filter.run_id !== undefined) {
        clauses.push("run_id = ?");
        values.push(filter.run_id);
      }
      if (filter.state !== undefined) {
        clauses.push("state = ?");
        values.push(filter.state);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return (
        db
          .prepare(`SELECT * FROM memory_distillation ${where} ORDER BY created_at, id`)
          .all(...values) as unknown as DistillationJobRow[]
      ).map(toJob);
    },
  };
}
