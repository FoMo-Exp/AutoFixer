/**
 * Non-secret recovery audit records (DAT-212, ADR-0005 §5 and §6).
 *
 * Recovery is audited as distinct events: an approval is recorded when the
 * independent reviewer issues the authorization, a recheck result when the
 * complete request is scanned again, a pre-dispatch record when the exact
 * frozen request and its scan evidence exist, an attempt record when the
 * authorization has been consumed, and an outcome record when the provider
 * answered — or did not.
 *
 * Records carry identifiers, revisions, keyed digests, scan evidence, and
 * redacted details only. They never carry request content or secret material,
 * and the durable sink is required: when the pre-dispatch record cannot be
 * written, the dispatch does not happen.
 */

import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import type { RequestScanEvidence } from "../gateway/types.js";
import type { RecoveryDestination, RecoveryScope } from "./recovery-authorization.js";
import type { SecurityActor } from "./types.js";

/** Every distinct recovery event type (approval is never a dispatch). */
export type RecoveryAuditEventType =
  | "recovery.approval_recorded"
  | "recovery.approval_revoked"
  | "recovery.authorization_invalidated"
  | "recovery.recheck_failed"
  | "recovery.dispatch_denied"
  | "recovery.pre_dispatch"
  | "recovery.dispatch_attempted"
  | "recovery.dispatch_outcome"
  | "recovery.reconciliation_recorded";

/** The approval facts as recorded on every later event of the same authorization. */
export interface RecoveryAuditApproval {
  contextRevision: string;
  policyRevision: string;
  rulesRevision: string;
  scanPolicyRevision: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}

/** Destination identity as recorded for audit; the pinned base URL stays in the binding. */
export type RecoveryAuditDestination = Omit<RecoveryDestination, "baseUrl">;

export interface RecoveryAuditRecord {
  event: RecoveryAuditEventType;
  at: string;
  authorizationId: string;
  caseId: string;
  /** New invocation id of this recovery attempt; `null` before dispatch. */
  invocationId: string | null;
  traceId: string | null;
  scope: RecoveryScope;
  /** Acting principal, or `null` for a service-side transition. */
  actor: SecurityActor | null;
  approval: RecoveryAuditApproval;
  destination: RecoveryAuditDestination;
  /** Keyed digest of the exact frozen request handed to the adapter. */
  requestDigest: string | null;
  /** Non-secret evidence of the complete-request recheck. */
  scan: RequestScanEvidence | null;
  /** `approved` and dispatch outcomes are distinct values, never merged. */
  outcome: "approved" | "dispatched" | "failed" | "unknown" | null;
  /** Machine reason (stable code or closed-vocabulary word). */
  reason: string | null;
  /** Non-secret scalars: ids, codes, counts, versions, booleans. */
  detail: Record<string, string | number | boolean>;
}

/**
 * Durable audit seam. Recording is awaited before dispatch; a throwing sink
 * blocks the send instead of letting unaudited bytes leave.
 */
export interface RecoveryAuditSink {
  record(record: RecoveryAuditRecord): void | Promise<void>;
}

/** Apply the second line of defense: no scrubbed field ever carries a credential shape. */
export function scrubAuditRecord(record: RecoveryAuditRecord): RecoveryAuditRecord {
  const detail: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record.detail)) {
    detail[scrubSecrets(key)] = typeof value === "string" ? scrubSecrets(value) : value;
  }
  return {
    ...record,
    reason: record.reason === null ? null : scrubSecrets(record.reason),
    detail,
  };
}

/**
 * Deployment-grade durable sink: one JSONL line per audit record, created
 * with owner-only permissions. A write failure propagates to the service,
 * which blocks the dispatch when the failing record is required
 * pre-dispatch evidence.
 */
export function createFileRecoveryAuditSink(file: string): RecoveryAuditSink {
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  return {
    record(record: RecoveryAuditRecord): void {
      fs.appendFileSync(file, `${JSON.stringify(scrubAuditRecord(record))}\n`, { mode: 0o600 });
    },
  };
}

/** In-memory sink for tests and for wiring checks; never a production default. */
export function createMemoryRecoveryAuditSink(): {
  audit: RecoveryAuditSink;
  records: RecoveryAuditRecord[];
} {
  const records: RecoveryAuditRecord[] = [];
  return {
    audit: {
      record(record: RecoveryAuditRecord): void {
        records.push(record);
      },
    },
    records,
  };
}
