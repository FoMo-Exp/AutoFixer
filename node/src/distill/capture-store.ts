/**
 * Durable outcome-capture outbox (DAT-264).
 *
 * Capture is scheduled, not performed inline with a status transition: the
 * enqueue is a durable row, and a worker claims rows under a lease. That is
 * what makes the write path survive a restart (pending rows are still there),
 * a duplicate enqueue (the unique key keeps one row), and concurrent workers
 * (only one claim wins). A delivery failure leaves the row retryable instead of
 * dropping the outcome, and a failed row is an explicit state — never a silent
 * success.
 *
 * The row carries the **server-side** enterprise/workspace that owns the task.
 * Nothing in the evidence can retarget it: the worker builds the memory scope
 * from these columns, never from the run payload.
 */

import type { ControlPlaneDb } from "../control-plane/db.js";
import { newId, nowIso } from "../control-plane/db.js";
import { ValidationError } from "../control-plane/errors.js";

export const CAPTURE_JOB_STATES = ["pending", "processing", "captured", "failed"] as const;
export type CaptureJobState = (typeof CAPTURE_JOB_STATES)[number];

export interface CaptureJob {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  terminal_state: string;
  /** Set only for a provider-observed delivery merge (DAT-266); null otherwise. */
  delivery_id: string | null;
  state: CaptureJobState;
  attempts: number;
  lease_until: string | null;
  retry_after: string | null;
  last_error: string | null;
  item_id: string | null;
  /**
   * Derived outcome class of the captured snapshot (`accepted`, `rejected`,
   * `cancelled`, `failed`, `timeout`, `unknown`, `infra_failure`). The
   * distillation outbox derives learnable snapshots from it.
   */
  outcome_class: string | null;
  /** The redacted envelope exactly as captured, for a faithful re-distillation. */
  envelope: string | null;
  /** SHA-256 of `envelope` as stored; verified before any model call. */
  envelope_digest: string | null;
  created_at: string;
  updated_at: string;
}

/** The captured snapshot the distillation outbox reads back. */
export interface CaptureSnapshot {
  /** Redacted outcome envelope serialized as JSON. */
  envelope: string;
  /** Derived outcome class of that envelope. */
  outcome_class: string;
  /** SHA-256 of `envelope` as stored. */
  envelope_digest: string;
}

export interface EnqueueCaptureInput {
  enterprise_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  terminal_state: string;
  delivery_id?: string | null;
}

export interface CaptureJobFilter {
  workspace_id?: string;
  run_id?: string;
  delivery_id?: string;
  state?: CaptureJobState;
}

export interface CaptureJobStore {
  /**
   * Insert one job unless the exact terminal snapshot is already recorded.
   * Re-enqueueing a captured snapshot, after a restart included, is a no-op.
   */
  enqueue(input: EnqueueCaptureInput): CaptureJob;
  /** Claim the oldest due row under a lease; `null` when nothing is due. */
  claim(now: Date, leaseMs: number): CaptureJob | null;
  /**
   * Mark the snapshot captured with the episode it produced and the exact
   * envelope it was built from. The snapshot columns are what a later
   * distillation job re-reads; they are written in the same transaction as
   * the episode.
   */
  markCaptured(id: string, itemId: string, snapshot: CaptureSnapshot, now?: Date): void;
  /** Return a claimed row to `pending` with a bounded backoff. */
  markRetry(id: string, errorCode: string, retryAfter: Date, now?: Date): void;
  /** End a snapshot as permanently failed after its attempt budget. */
  markFailed(id: string, errorCode: string, now?: Date): void;
  get(id: string): CaptureJob | undefined;
  list(filter?: CaptureJobFilter): CaptureJob[];
}

interface CaptureJobRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  terminal_state: string;
  delivery_id: string | null;
  state: string;
  attempts: number;
  lease_until: string | null;
  retry_after: string | null;
  last_error: string | null;
  item_id: string | null;
  outcome_class: string | null;
  envelope: string | null;
  envelope_digest: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(row: CaptureJobRow): CaptureJob {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    task_id: row.task_id,
    run_id: row.run_id,
    terminal_state: row.terminal_state,
    delivery_id: row.delivery_id,
    state: row.state as CaptureJobState,
    attempts: row.attempts,
    lease_until: row.lease_until,
    retry_after: row.retry_after,
    last_error: row.last_error,
    item_id: row.item_id,
    outcome_class: row.outcome_class,
    envelope: row.envelope,
    envelope_digest: row.envelope_digest,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requireToken(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`capture job ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * One error token per failed attempt. Only stable codes are stored: an error
 * message can carry a path, a URL, or provider text and must never enter the
 * outbox.
 */
function requireErrorCode(code: string): string {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new ValidationError("capture job error code must be a stable uppercase token");
  }
  return code;
}

/** A snapshot digest is lowercase hex SHA-256; anything else is a bug. */
function requireDigest(digest: string): string {
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ValidationError("capture snapshot digest must be a lowercase hex SHA-256");
  }
  return digest;
}

export function createCaptureJobStore(db: ControlPlaneDb): CaptureJobStore {
  const selectById = db.prepare("SELECT * FROM memory_outcome_capture WHERE id = ?");

  const get = (id: string): CaptureJob | undefined => {
    const row = selectById.get(id) as CaptureJobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  };

  return {
    enqueue(input) {
      const enterpriseId = requireToken(input.enterprise_id, "enterprise_id");
      const workspaceId = requireToken(input.workspace_id, "workspace_id");
      const taskId = requireToken(input.task_id, "task_id");
      const runId = requireToken(input.run_id, "run_id");
      const terminalState = requireToken(input.terminal_state, "terminal_state");
      const deliveryId =
        input.delivery_id === undefined || input.delivery_id === null
          ? null
          : requireToken(input.delivery_id, "delivery_id");
      const now = nowIso();
      db.prepare(
        `INSERT INTO memory_outcome_capture
           (id, enterprise_id, workspace_id, task_id, run_id, terminal_state, delivery_id, state,
            attempts, lease_until, retry_after, last_error, item_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(workspace_id, run_id, terminal_state) DO NOTHING`,
      ).run(
        newId("mcp"),
        enterpriseId,
        workspaceId,
        taskId,
        runId,
        terminalState,
        deliveryId,
        now,
        now,
      );
      const row = db
        .prepare(
          `SELECT * FROM memory_outcome_capture
           WHERE workspace_id = ? AND run_id = ? AND terminal_state = ?`,
        )
        .get(workspaceId, runId, terminalState) as CaptureJobRow | undefined;
      if (row === undefined) {
        throw new ValidationError("capture job could not be recorded");
      }
      return toJob(row);
    },

    claim(now, leaseMs) {
      if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
        throw new ValidationError("capture lease must be a positive integer of milliseconds");
      }
      const at = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const candidate = db
        .prepare(
          `SELECT id FROM memory_outcome_capture
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
          `UPDATE memory_outcome_capture
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

    markCaptured(id, itemId, snapshot, now = new Date()) {
      db.prepare(
        `UPDATE memory_outcome_capture
         SET state = 'captured', item_id = ?, outcome_class = ?, envelope = ?,
             envelope_digest = ?, lease_until = NULL, retry_after = NULL,
             last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(
        requireToken(itemId, "item_id"),
        requireToken(snapshot.outcome_class, "outcome_class"),
        requireToken(snapshot.envelope, "envelope"),
        requireDigest(snapshot.envelope_digest),
        now.toISOString(),
        id,
      );
    },

    markRetry(id, errorCode, retryAfter, now = new Date()) {
      db.prepare(
        `UPDATE memory_outcome_capture
         SET state = 'pending', lease_until = NULL, retry_after = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(retryAfter.toISOString(), requireErrorCode(errorCode), now.toISOString(), id);
    },

    markFailed(id, errorCode, now = new Date()) {
      db.prepare(
        `UPDATE memory_outcome_capture
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
      if (filter.delivery_id !== undefined) {
        clauses.push("delivery_id = ?");
        values.push(filter.delivery_id);
      }
      if (filter.state !== undefined) {
        clauses.push("state = ?");
        values.push(filter.state);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return (
        db
          .prepare(`SELECT * FROM memory_outcome_capture ${where} ORDER BY created_at, id`)
          .all(...values) as unknown as CaptureJobRow[]
      ).map(toJob);
    },
  };
}
