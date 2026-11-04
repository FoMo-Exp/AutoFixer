import { createHash } from "node:crypto";

/**
 * Append-only audit log with a digest chain.
 *
 * Every first attempt of a command — applied or denied — appends exactly one
 * record. Re-deliveries of an applied operation append nothing and return the
 * recorded result; re-deliveries of a denied operation re-evaluate (so a
 * corrected retry can succeed) but keep the same operation payload. The chain
 * makes the log tamper-evident and, together with the recorded payloads,
 * lets a replay reproduce the exact state machine history.
 */

export type AuditOutcome = "applied" | "denied";

export type AuditCommand =
  | "create_issue"
  | "add_task"
  | "set_task_state"
  | "open_run"
  | "acquire_lease"
  | "renew_lease"
  | "release_lease"
  | "record_grant"
  | "revoke_grant"
  | "record_run_state"
  | "attach_artifact"
  | "record_test_plan"
  | "freeze_candidate"
  | "invalidate_candidate"
  | "record_base_advance"
  | "transition_issue"
  | "record_handoff"
  | "request_run_restart";

/**
 * One audit record. Generic over the command union so sibling state machines
 * (e.g. routing) can reuse the record shape and digest chain with their own
 * command vocabulary; collab code keeps the default parameter.
 */
export interface AuditRecord<Command extends string = AuditCommand> {
  sequence: number;
  event_id: string;
  operation_id: string;
  command: Command;
  actor: string;
  at: string;
  outcome: AuditOutcome;
  denial_code: string | null;
  /** Digest of the caller payload; binds one operation id to one payload. */
  fingerprint: string;
  /** Digest of the normalized command payload (ids and timestamp included). */
  payload_digest: string;
  payload: Record<string, unknown>;
  /** Digest of the applied result; null for a denial. */
  result_digest: string | null;
  previous_digest: string | null;
  digest: string;
}

/**
 * Canonical JSON: object keys sorted so equal values always serialize
 * identically, which is what the digest chain and replay comparison need.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Digest of one audit record over its logical content. `payload` itself is
 * covered through `fingerprint`; the chain links records through
 * `previous_digest`.
 */
export function auditDigest<Command extends string>(
  record: Omit<AuditRecord<Command>, "digest">,
): string {
  return digestOf({
    sequence: record.sequence,
    event_id: record.event_id,
    operation_id: record.operation_id,
    command: record.command,
    actor: record.actor,
    at: record.at,
    outcome: record.outcome,
    denial_code: record.denial_code,
    fingerprint: record.fingerprint,
    payload_digest: record.payload_digest,
    result_digest: record.result_digest,
    previous_digest: record.previous_digest,
  });
}

/**
 * Verify sequence contiguity, payload fingerprints, and the digest chain.
 * Returns null when the log is intact, otherwise the first problem found.
 */
export function auditChainProblem<Command extends string>(
  records: readonly AuditRecord<Command>[],
): string | null {
  let previous: string | null = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      return `missing record at index ${index}`;
    }
    if (record.sequence !== index + 1) {
      return `sequence gap at index ${index}: ${record.sequence}`;
    }
    if (record.previous_digest !== previous) {
      return `broken chain link at sequence ${record.sequence}`;
    }
    if (digestOf(record.payload) !== record.payload_digest) {
      return `payload digest mismatch at sequence ${record.sequence}`;
    }
    const { digest, ...content } = record;
    if (auditDigest(content) !== digest) {
      return `record digest mismatch at sequence ${record.sequence}`;
    }
    previous = record.digest;
  }
  return null;
}
