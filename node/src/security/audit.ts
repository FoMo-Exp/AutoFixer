/**
 * Unified, tamper-evident, non-secret security audit trail (DAT-213,
 * ADR-0005 §6).
 *
 * ADR-0005 requires one durable security record that keeps *every* distinct
 * step of the fail-closed egress path auditable: detection and blocking,
 * assignment and escalation, sensitive-context access, handling, rule
 * proposal/review/activation/rollback, recovery approval, recheck,
 * authorization invalidation, dispatch attempts/outcomes, and termination.
 * The domain stores keep their own append-only histories (case events, rule
 * events, recovery audit records); this module is the one trail that receives
 * them all, so one query answers "what happened to this invocation?" across
 * every subsystem.
 *
 * Invariants:
 * - Records are non-secret by construction. Callers pass identifiers, closed
 *   vocabulary words, counts, and scrub-safe text; every string field is
 *   scrubbed again before it is chained.
 * - Content correlation uses domain-separated keyed identifiers
 *   ({@link protectedAuditIdentifier}), never a plain hash of a low-entropy
 *   secret value: an unkeyed digest of a secret is itself a pointer back to
 *   the secret.
 * - The durable sink is tamper-evident: lines are hash-chained, the head is
 *   anchored separately, appends hold an exclusive lock, and a log that fails
 *   verification refuses new records (fail closed) and refuses reads.
 * - Reads and exports are themselves audited. They require a duty-gated
 *   actor and an explicit purpose, and the access record is appended before
 *   any data is returned — a read whose audit write fails returns nothing.
 *
 * The sink is *tamper-evident*, not tamper-proof against an attacker running
 * as the same OS identity: deployments that need provable immutability must
 * inject an append-only/WORM backend behind {@link SecurityAuditSink}.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import { requireDuty } from "./duties.js";
import type { SecurityDutyDirectory } from "./duties.js";
import { keyedIdentifier, requireCorrelationKey } from "./recovery-request.js";
import { SecurityError } from "./types.js";
import type { SecurityActor } from "./types.js";

/**
 * The closed audit event vocabulary. Each value is one distinct step; an
 * approval is never merged with a dispatch, a block is never merged with a
 * case transition, and an access read is never merged with the access grant.
 */
export const SECURITY_AUDIT_EVENT_TYPES = [
  // 1. Detection and blocking (gateway + case intake).
  "block.detected",
  "block.enforced",
  "case.opened",
  "gateway.pre_dispatch",
  "gateway.outcome",
  // 2. Assignment, notification, and escalation.
  "notification.dispatched",
  "notification.escalated",
  "notification.undeliverable",
  "case.termination_requested",
  "case.reassignment_requested",
  // 3. Sensitive-context access (quarantine lifecycle and every view attempt).
  "quarantine.sealed",
  "quarantine.seal_failed",
  "quarantine.access_granted",
  "quarantine.viewed",
  "quarantine.access_denied",
  "quarantine.expired",
  // 4. Handling and review of a case.
  "case.handled",
  "case.submitted_for_review",
  "case.review_approved",
  "case.review_rejected",
  "case.review_denied",
  "case.reviewer_unavailable",
  "case.resolved",
  "case.state_changed",
  "run.dependent_work_paused",
  "run.pause_released",
  // 5. Versioned rule correction lifecycle.
  "rule.proposed",
  "rule.proposal_rejected",
  "rule.review_approved",
  "rule.review_rejected",
  "rule.review_denied",
  "rule.activated",
  "rule.activation_denied",
  "rule.superseded",
  "rule.rolled_back",
  "rule.rollback_denied",
  "rule.expired",
  // 6. Recovery authorization, recheck, and dispatch.
  "recovery.approval_recorded",
  "recovery.approval_revoked",
  "recovery.authorization_invalidated",
  "recovery.recheck_failed",
  "recovery.dispatch_denied",
  "recovery.pre_dispatch",
  "recovery.dispatch_attempted",
  "recovery.dispatch_outcome",
  "recovery.reconciliation_recorded",
  // 7. Termination.
  "case.terminated",
  // 8. Audit access (restricted reads and exports are themselves audited).
  "audit.trail_read",
  "audit.trail_exported",
  "audit.access_denied",
] as const;

export type SecurityAuditEventType = (typeof SECURITY_AUDIT_EVENT_TYPES)[number];

/**
 * The ADR-0005 §6 event classes, used by coverage tests and the contract.
 * The mapping is exhaustive over {@link SECURITY_AUDIT_EVENT_TYPES}.
 */
export const SECURITY_AUDIT_EVENT_CLASSES = {
  detection_and_blocking: ["block.detected", "block.enforced", "case.opened"],
  assignment_and_escalation: [
    "notification.dispatched",
    "notification.escalated",
    "notification.undeliverable",
    "case.termination_requested",
    "case.reassignment_requested",
  ],
  sensitive_context_access: [
    "quarantine.sealed",
    "quarantine.seal_failed",
    "quarantine.access_granted",
    "quarantine.viewed",
    "quarantine.access_denied",
    "quarantine.expired",
  ],
  handling_and_review: [
    "case.handled",
    "case.submitted_for_review",
    "case.review_approved",
    "case.review_rejected",
    "case.review_denied",
    "case.reviewer_unavailable",
    "case.resolved",
    "case.state_changed",
    "run.dependent_work_paused",
    "run.pause_released",
  ],
  rule_lifecycle: [
    "rule.proposed",
    "rule.proposal_rejected",
    "rule.review_approved",
    "rule.review_rejected",
    "rule.review_denied",
    "rule.activated",
    "rule.activation_denied",
    "rule.superseded",
    "rule.rolled_back",
    "rule.rollback_denied",
    "rule.expired",
  ],
  approval_recheck_and_dispatch: [
    "recovery.approval_recorded",
    "recovery.approval_revoked",
    "recovery.authorization_invalidated",
    "recovery.recheck_failed",
    "recovery.dispatch_denied",
    "recovery.pre_dispatch",
    "recovery.dispatch_attempted",
    "recovery.dispatch_outcome",
    "recovery.reconciliation_recorded",
  ],
  termination: ["case.terminated"],
  gateway_attempts: ["gateway.pre_dispatch", "gateway.outcome"],
  audit_access: ["audit.trail_read", "audit.trail_exported", "audit.access_denied"],
} as const satisfies Record<string, readonly SecurityAuditEventType[]>;

/** How one audited step closed. */
export const SECURITY_AUDIT_RESULTS = [
  "recorded",
  "allowed",
  "denied",
  "succeeded",
  "failed",
  "unknown",
] as const;

export type SecurityAuditResult = (typeof SECURITY_AUDIT_RESULTS)[number];

/**
 * Enterprise/workspace/issue/run correlation for one event. Enterprise and
 * workspace are `null` only for an event that genuinely has no attributable
 * scope (e.g. a proposal too malformed to derive one); everything with a
 * counterpart scope carries both.
 */
export interface SecurityAuditScope {
  enterpriseId: string | null;
  workspaceId: string | null;
  issueId: string | null;
  runId: string | null;
}

/** Acting human/service principal and the duty it acted under. */
export interface SecurityAuditActor {
  actorId: string;
  actorKind: "human" | "service" | "run";
  /** Effective duty for duty-gated actions; null for service transitions. */
  role: string | null;
  /**
   * The principal whose handling/authoring the actor had to stay independent
   * of, when this event is a review decision.
   */
  independentOf: string | null;
}

/** Destination identity for egress events; never a credential or URL. */
export interface SecurityAuditDestination {
  endpointId: string;
  provider: string;
  modelId: string;
  internal: boolean;
}

/** Non-secret recheck evidence, mirroring the gateway's scan evidence. */
export interface SecurityAuditScanEvidence {
  scanner: string;
  ruleVersion: string;
  classification: string;
  segments: number;
  dataClasses: string[];
  findingCounts: { suspected: number; confirmed: number; unknown: number };
  detectors: string[];
  derivedSegments: number;
}

/** Recovery-authorization lifecycle facts, distinct from the dispatch itself. */
export interface SecurityAuditAuthorization {
  authorizationId: string;
  state: string;
  expiresAt: string | null;
  consumedAt: string | null;
}

/**
 * One non-secret audit event. `at`/`eventId` are filled by the trail when the
 * producer does not supply them; every other field is producer-supplied.
 */
export interface SecurityAuditEvent {
  /** Trail-assigned identity; stable across reads and exports. */
  eventId?: string;
  at?: string;
  event: SecurityAuditEventType;
  scope: SecurityAuditScope;
  caseId: string | null;
  invocationId: string | null;
  traceId: string | null;
  actor: SecurityAuditActor | null;
  /** Actor-visible action performed (usually the event type). */
  action: string;
  reason: string | null;
  result: SecurityAuditResult;
  /** Independent-review relationship, when this event is a review decision. */
  review: { reviewerId: string; independent: boolean } | null;
  destination: SecurityAuditDestination | null;
  dataClasses: string[];
  /** Keyed references to protected content; never raw content or plain hashes. */
  protectedRefs: string[];
  policyRevision: string | null;
  rulesRevision: string | null;
  detectorVersion: string | null;
  redactionVersion: string | null;
  scan: SecurityAuditScanEvidence | null;
  authorization: SecurityAuditAuthorization | null;
  /** Link from a block event to the dispatch attempt it actually produced. */
  link: { blockEventId: string | null; dispatchEventId: string | null } | null;
  /** Non-secret scalars only: ids, codes, counts, versions, booleans. */
  detail: Record<string, string | number | boolean>;
}

/** A stored, chain-linked audit event. */
export interface SecurityAuditEntry {
  seq: number;
  event: SecurityAuditEvent;
  hash: string;
}

/**
 * Durable audit seam. `durability` is a structural marker, exactly like the
 * recovery sink: a `test` trail is never accepted where a deployment audit is
 * required. A throwing `record` blocks the dependent action (fail closed).
 */
export interface SecurityAuditSink {
  readonly durability: "durable" | "test";
  record(event: SecurityAuditEvent): void | Promise<void>;
}

/** One restricted read/export request and the authority behind it. */
export interface SecurityAuditAccess {
  actor: SecurityActor;
  duties: SecurityDutyDirectory;
  /** Non-secret stated purpose recorded with the access event. */
  purpose: string;
}

/** Scope-bound filter for reads and exports. */
export interface SecurityAuditQuery {
  enterpriseId: string;
  workspaceId: string;
  issueId?: string;
  runId?: string;
  caseId?: string;
  invocationId?: string;
  traceId?: string;
  eventTypes?: readonly SecurityAuditEventType[];
  /** Inclusive lower / upper ISO timestamps. */
  from?: string;
  to?: string;
  /** Maximum entries returned, newest first is the caller's job; default 1000. */
  limit?: number;
}

export interface SecurityAuditExport {
  exportedAt: string;
  enterpriseId: string;
  workspaceId: string;
  eventCount: number;
  entries: readonly SecurityAuditEntry[];
}

export interface SecurityAuditTrail {
  readonly durability: "durable" | "test";
  record(event: SecurityAuditEvent): SecurityAuditEntry;
  /** Chain-verified entries, oldest first. */
  entries(): readonly SecurityAuditEntry[];
  verify(): { entries: number; headSeq: number; headHash: string };
  read(query: SecurityAuditQuery, access: SecurityAuditAccess): readonly SecurityAuditEntry[];
  export(query: SecurityAuditQuery, access: SecurityAuditAccess): SecurityAuditExport;
}

/**
 * Domain-separated keyed identifier for content correlation. This is the only
 * approved way to correlate protected content: the key makes the value
 * unusable without the service key, and the purpose prevents cross-use
 * comparisons.
 */
export function protectedAuditIdentifier(key: Buffer, purpose: string, canonical: string): string {
  return keyedIdentifier(requireCorrelationKey(key), `audit:${purpose}`, canonical);
}

const MAX_LINE_BYTES = 512 * 1024;
const GENESIS = "genesis";
const HASH_PREFIX = "ah1.";
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 5;
const DEFAULT_READ_LIMIT = 1_000;

interface AuditLine {
  seq: number;
  prev: string;
  event: SecurityAuditEvent;
  hash: string;
}

interface AuditAnchor {
  seq: number;
  hash: string;
}

function timestampOf(now: () => Date): string {
  return now().toISOString();
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SecurityError("AUDIT_EVENT_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

function scrubScalar(value: string): string {
  return scrubSecrets(value);
}

function scrubDetail(
  detail: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[scrubScalar(key)] = typeof value === "string" ? scrubScalar(value) : value;
  }
  return out;
}

/**
 * Normalize and validate one event: scrub every string field, fill identity
 * and time, and reject shapes that could carry content (arrays of objects,
 * nested records, numbers where a code belongs).
 */
export function normalizeSecurityAuditEvent(
  event: SecurityAuditEvent,
  options: { now: () => Date; newEventId: () => string },
): SecurityAuditEvent {
  if (!SECURITY_AUDIT_EVENT_TYPES.includes(event.event)) {
    throw new SecurityError("AUDIT_EVENT_INVALID", `unknown audit event ${String(event.event)}`);
  }
  const scope = event.scope;
  if (scope === null || typeof scope !== "object") {
    throw new SecurityError("AUDIT_EVENT_INVALID", "scope must be an object");
  }
  const hasEnterprise = scope.enterpriseId !== null;
  const hasWorkspace = scope.workspaceId !== null;
  if (hasEnterprise !== hasWorkspace) {
    throw new SecurityError(
      "AUDIT_EVENT_INVALID",
      "scope.enterpriseId and scope.workspaceId must both be present or both be null",
    );
  }
  if (hasEnterprise) {
    requireNonEmptyString(scope.enterpriseId, "scope.enterpriseId");
    requireNonEmptyString(scope.workspaceId, "scope.workspaceId");
  }
  if (!SECURITY_AUDIT_RESULTS.includes(event.result)) {
    throw new SecurityError("AUDIT_EVENT_INVALID", `unknown audit result ${String(event.result)}`);
  }
  const actor =
    event.actor === null
      ? null
      : {
          actorId: requireNonEmptyString(event.actor.actorId, "actor.actorId"),
          actorKind: event.actor.actorKind,
          role: event.actor.role === null ? null : scrubScalar(event.actor.role),
          independentOf:
            event.actor.independentOf === null ? null : scrubScalar(event.actor.independentOf),
        };
  return {
    eventId: event.eventId ?? options.newEventId(),
    at: event.at ?? timestampOf(options.now),
    event: event.event,
    scope: {
      enterpriseId: scope.enterpriseId === null ? null : scrubScalar(scope.enterpriseId),
      workspaceId: scope.workspaceId === null ? null : scrubScalar(scope.workspaceId),
      issueId: scope.issueId === null ? null : scrubScalar(scope.issueId),
      runId: scope.runId === null ? null : scrubScalar(scope.runId),
    },
    caseId: event.caseId === null ? null : scrubScalar(event.caseId),
    invocationId: event.invocationId === null ? null : scrubScalar(event.invocationId),
    traceId: event.traceId === null ? null : scrubScalar(event.traceId),
    actor,
    action: scrubScalar(requireNonEmptyString(event.action, "action")),
    reason: event.reason === null ? null : scrubScalar(event.reason),
    result: event.result,
    review:
      event.review === null
        ? null
        : {
            reviewerId: scrubScalar(
              requireNonEmptyString(event.review.reviewerId, "review.reviewerId"),
            ),
            independent: event.review.independent === true,
          },
    destination:
      event.destination === null
        ? null
        : {
            endpointId: scrubScalar(
              requireNonEmptyString(event.destination.endpointId, "destination.endpointId"),
            ),
            provider: scrubScalar(
              requireNonEmptyString(event.destination.provider, "destination.provider"),
            ),
            modelId: scrubScalar(
              requireNonEmptyString(event.destination.modelId, "destination.modelId"),
            ),
            internal: event.destination.internal === true,
          },
    dataClasses: (event.dataClasses ?? []).map(scrubScalar),
    protectedRefs: (event.protectedRefs ?? []).map(scrubScalar),
    policyRevision: event.policyRevision === null ? null : scrubScalar(event.policyRevision),
    rulesRevision: event.rulesRevision === null ? null : scrubScalar(event.rulesRevision),
    detectorVersion: event.detectorVersion === null ? null : scrubScalar(event.detectorVersion),
    redactionVersion: event.redactionVersion === null ? null : scrubScalar(event.redactionVersion),
    scan:
      event.scan === null
        ? null
        : {
            scanner: scrubScalar(event.scan.scanner),
            ruleVersion: scrubScalar(event.scan.ruleVersion),
            classification: scrubScalar(event.scan.classification),
            segments: event.scan.segments,
            dataClasses: event.scan.dataClasses.map(scrubScalar),
            findingCounts: { ...event.scan.findingCounts },
            detectors: event.scan.detectors.map(scrubScalar),
            derivedSegments: event.scan.derivedSegments,
          },
    authorization:
      event.authorization === null
        ? null
        : {
            authorizationId: scrubScalar(
              requireNonEmptyString(event.authorization.authorizationId, "authorization.id"),
            ),
            state: scrubScalar(event.authorization.state),
            expiresAt:
              event.authorization.expiresAt === null
                ? null
                : scrubScalar(event.authorization.expiresAt),
            consumedAt:
              event.authorization.consumedAt === null
                ? null
                : scrubScalar(event.authorization.consumedAt),
          },
    link:
      event.link === null
        ? null
        : {
            blockEventId:
              event.link.blockEventId === null ? null : scrubScalar(event.link.blockEventId),
            dispatchEventId:
              event.link.dispatchEventId === null ? null : scrubScalar(event.link.dispatchEventId),
          },
    detail: scrubDetail(event.detail ?? {}),
  };
}

function chainHash(key: Buffer, prev: string, seq: number, event: SecurityAuditEvent): string {
  const canonical = JSON.stringify([prev, seq, event]);
  return `${HASH_PREFIX}${createHmac("sha256", key).update(canonical).digest("base64url")}`;
}

function integrityError(detail: string, details: Record<string, unknown> = {}): SecurityError {
  return new SecurityError(
    "SECURITY_AUDIT_LOG_TAMPERED",
    `the security audit log failed integrity verification: ${detail}`,
    details,
  );
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function assertProtectedLogFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stat.isFile()) {
    throw new SecurityError(
      "SECURITY_AUDIT_LOG_UNPROTECTED",
      "the security audit log must be a regular file owned by the service",
      { file },
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new SecurityError(
      "SECURITY_AUDIT_LOG_UNPROTECTED",
      "the security audit log is readable or writable beyond its owner; fix its mode (0600) first",
      { file, mode: (stat.mode & 0o777).toString(8) },
    );
  }
}

function readAnchor(file: string): AuditAnchor | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${file}.anchor`, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AuditAnchor>;
    if (typeof parsed.seq !== "number" || typeof parsed.hash !== "string") {
      throw new Error("bad anchor");
    }
    return { seq: parsed.seq, hash: parsed.hash };
  } catch {
    throw integrityError("the audit anchor is not a valid anchor record", { file });
  }
}

function writeAnchor(file: string, anchor: AuditAnchor): void {
  const target = `${file}.anchor`;
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(anchor));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
}

interface VerifiedLog {
  entries: SecurityAuditEntry[];
  seq: number;
  hash: string;
  tornBytes: number;
}

/** Verify the complete chain and its anchored head. Never repairs corruption. */
function verifyFileLog(file: string, key: Buffer): VerifiedLog {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const lines = raw.split("\n");
  const entries: SecurityAuditEntry[] = [];
  const hashes: string[] = [];
  let tornBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLast = index === lines.length - 1;
    if (isLast && line === "") break;
    if (isLast && !raw.endsWith("\n")) {
      tornBytes = Buffer.byteLength(line, "utf8");
      break;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw integrityError("an audit line exceeds the maximum record size", { seq: index + 1 });
    }
    let parsed: AuditLine;
    try {
      parsed = JSON.parse(line) as AuditLine;
    } catch {
      throw integrityError("an audit line is not valid JSON", { seq: index + 1 });
    }
    if (parsed.seq !== index + 1) {
      throw integrityError("audit sequence numbers are not contiguous", {
        expected: index + 1,
        found: parsed.seq,
      });
    }
    const prev = index === 0 ? GENESIS : hashes[index - 1];
    if (parsed.prev !== prev) {
      throw integrityError("an audit line does not chain to its predecessor", { seq: parsed.seq });
    }
    if (parsed.hash !== chainHash(key, prev as string, parsed.seq, parsed.event)) {
      throw integrityError("an audit line was modified after it was written", { seq: parsed.seq });
    }
    entries.push({ seq: parsed.seq, event: parsed.event, hash: parsed.hash });
    hashes.push(parsed.hash);
  }
  const seq = entries.length;
  const hash = seq === 0 ? GENESIS : (hashes[seq - 1] as string);
  const anchor = readAnchor(file);
  if (seq === 0) {
    if (anchor && anchor.seq > 0) {
      throw integrityError("every anchored audit record was removed", { anchored: anchor.seq });
    }
    return { entries, seq, hash, tornBytes };
  }
  if (!anchor) {
    throw integrityError("the audit anchor is missing; the log head cannot be trusted");
  }
  if (anchor.seq > seq) {
    throw integrityError("audit records were removed from the end of the anchored log", {
      anchored: anchor.seq,
      present: seq,
    });
  }
  if (anchor.seq > 0 && hashes[anchor.seq - 1] !== anchor.hash) {
    throw integrityError("the audit anchor does not match the record it names", {
      seq: anchor.seq,
    });
  }
  return { entries, seq, hash, tornBytes };
}

function normalizeFileLog(file: string, key: Buffer): VerifiedLog {
  const verified = verifyFileLog(file, key);
  if (verified.tornBytes > 0) {
    const size = fs.statSync(file).size;
    fs.truncateSync(file, Math.max(0, size - verified.tornBytes));
  }
  return verified;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

interface LockIdentity {
  token: string;
  pid: number;
  host: string;
  at: string;
}

function lockTimeoutError(file: string, lockFile: string): SecurityError {
  return new SecurityError(
    "SECURITY_AUDIT_LOCK_TIMEOUT",
    "another writer holds the security audit lock; failing closed instead of appending unsafely",
    { file, lockFile, manualAction: "inspect the lock file before removing it" },
  );
}

/** Exclusive create lock with token-checked release; never auto-breaks a lock. */
function openAuditLogLock(
  file: string,
  options: { lockTimeoutMs?: number; now?: () => Date },
): { release: () => void } {
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + (options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const identity: LockIdentity = {
    token,
    pid: process.pid,
    host: process.env["HOSTNAME"] ?? "unknown",
    at: (options.now ?? (() => new Date()))().toISOString(),
  };
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw lockTimeoutError(file, lockFile);
      sleepSync(LOCK_RETRY_MS);
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify(identity));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return {
      release(): void {
        let current: LockIdentity | undefined;
        try {
          current = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockIdentity;
        } catch {
          current = undefined;
        }
        if (!current || current.token !== token) {
          throw new SecurityError(
            "SECURITY_AUDIT_LOCK_LOST",
            "the audit lock no longer carries this process's ownership token; it was left in place and the write is not treated as exclusive",
            { file, lockFile, expectedToken: token, foundToken: current?.token ?? null },
          );
        }
        fs.unlinkSync(lockFile);
      },
    };
  }
}

function withLock<T>(
  file: string,
  options: { lockTimeoutMs?: number; now?: () => Date },
  fn: () => T,
): T {
  const lock = openAuditLogLock(file, options);
  let result: T | undefined;
  let bodyFailure: unknown;
  let bodyFailed = false;
  try {
    result = fn();
  } catch (error) {
    bodyFailed = true;
    bodyFailure = error;
  }
  let releaseFailure: unknown;
  try {
    lock.release();
  } catch (error) {
    releaseFailure = error;
  }
  if (bodyFailed) throw bodyFailure;
  if (releaseFailure !== undefined) throw releaseFailure;
  return result as T;
}

function matchesQuery(entry: SecurityAuditEntry, query: SecurityAuditQuery): boolean {
  const event = entry.event;
  if (
    event.scope.enterpriseId !== query.enterpriseId ||
    event.scope.workspaceId !== query.workspaceId
  ) {
    return false;
  }
  if (query.issueId !== undefined && event.scope.issueId !== query.issueId) return false;
  if (query.runId !== undefined && event.scope.runId !== query.runId) return false;
  if (query.caseId !== undefined && event.caseId !== query.caseId) return false;
  if (query.invocationId !== undefined && event.invocationId !== query.invocationId) return false;
  if (query.traceId !== undefined && event.traceId !== query.traceId) return false;
  if (query.eventTypes !== undefined && !query.eventTypes.includes(event.event)) return false;
  if (query.from !== undefined && (event.at ?? "") < query.from) return false;
  if (query.to !== undefined && (event.at ?? "") > query.to) return false;
  return true;
}

function auditAccessEvent(
  type: "audit.trail_read" | "audit.trail_exported" | "audit.access_denied",
  query: SecurityAuditQuery,
  access: SecurityAuditAccess,
  result: SecurityAuditResult,
  count: number,
): SecurityAuditEvent {
  return {
    event: type,
    scope: {
      enterpriseId: query.enterpriseId,
      workspaceId: query.workspaceId,
      issueId: query.issueId ?? null,
      runId: query.runId ?? null,
    },
    caseId: query.caseId ?? null,
    invocationId: query.invocationId ?? null,
    traceId: query.traceId ?? null,
    actor: {
      actorId: access.actor.actorId,
      actorKind: access.actor.actorKind,
      role: null,
      independentOf: null,
    },
    action: type,
    reason: null,
    result,
    review: null,
    destination: null,
    dataClasses: [],
    protectedRefs: [],
    policyRevision: null,
    rulesRevision: null,
    detectorVersion: null,
    redactionVersion: null,
    scan: null,
    authorization: null,
    link: null,
    detail: { purpose: access.purpose, count },
  };
}

interface TrailInternals {
  durability: "durable" | "test";
  append(normalized: SecurityAuditEvent): SecurityAuditEntry;
  allEntries(): readonly SecurityAuditEntry[];
  verify(): { entries: number; headSeq: number; headHash: string };
}

/** Shared read/export/audit-access behavior for both trail backends. */
function buildTrail(
  internals: TrailInternals,
  options: { now: () => Date; newEventId: () => string },
): SecurityAuditTrail {
  const auditDenied = (
    query: SecurityAuditQuery,
    access: SecurityAuditAccess,
    error: unknown,
  ): never => {
    try {
      internals.append(
        normalizeSecurityAuditEvent(
          auditAccessEvent("audit.access_denied", query, access, "denied", 0),
          options,
        ),
      );
    } catch {
      // The denial stands even when the access record cannot be written; the
      // caller never receives the data either way.
    }
    throw error;
  };

  const authorize = (
    action: "audit.read" | "audit.export",
    query: SecurityAuditQuery,
    access: SecurityAuditAccess,
  ): void => {
    if (
      typeof query?.enterpriseId !== "string" ||
      query.enterpriseId.length === 0 ||
      typeof query.workspaceId !== "string" ||
      query.workspaceId.length === 0
    ) {
      throw new SecurityError(
        "AUDIT_QUERY_INVALID",
        "an audit read or export must name the enterprise and workspace scope",
      );
    }
    requireNonEmptyString(access?.purpose, "access.purpose");
    try {
      requireDuty(action, access.actor, access.duties, {
        enterpriseId: query.enterpriseId,
        workspaceId: query.workspaceId,
      });
    } catch (error) {
      auditDenied(query, access, error);
    }
  };

  const select = (query: SecurityAuditQuery): readonly SecurityAuditEntry[] => {
    const limit = query.limit ?? DEFAULT_READ_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new SecurityError("AUDIT_QUERY_INVALID", "limit must be a positive integer");
    }
    return internals
      .allEntries()
      .filter((entry) => matchesQuery(entry, query))
      .slice(0, limit);
  };

  return {
    durability: internals.durability,
    record(event: SecurityAuditEvent): SecurityAuditEntry {
      return internals.append(normalizeSecurityAuditEvent(event, options));
    },
    entries(): readonly SecurityAuditEntry[] {
      return internals.allEntries();
    },
    verify() {
      return internals.verify();
    },
    read(query: SecurityAuditQuery, access: SecurityAuditAccess): readonly SecurityAuditEntry[] {
      authorize("audit.read", query, access);
      const entries = select(query);
      // The access record is written before data is returned: a read whose
      // audit write fails returns nothing.
      internals.append(
        normalizeSecurityAuditEvent(
          auditAccessEvent("audit.trail_read", query, access, "allowed", entries.length),
          options,
        ),
      );
      return entries;
    },
    export(query: SecurityAuditQuery, access: SecurityAuditAccess): SecurityAuditExport {
      authorize("audit.export", query, access);
      const entries = select(query);
      internals.append(
        normalizeSecurityAuditEvent(
          auditAccessEvent("audit.trail_exported", query, access, "allowed", entries.length),
          options,
        ),
      );
      return {
        exportedAt: timestampOf(options.now),
        enterpriseId: query.enterpriseId,
        workspaceId: query.workspaceId,
        eventCount: entries.length,
        entries,
      };
    },
  };
}

export interface SecurityAuditTrailOptions {
  /**
   * Service key for the chain and for caller-supplied protected identifiers.
   * Required: an unkeyed chain can be re-forged by anyone who can edit the
   * file, and unkeyed digests of low-entropy secrets are re-identifiable.
   */
  key: Buffer;
  lockTimeoutMs?: number;
  now?: () => Date;
  newEventId?: () => string;
}

/**
 * Durable file-backed security audit trail: one hash-chained JSONL line per
 * event, owner-only permissions, fsynced appends, an anchored head, and an
 * exclusive append lock. A failed log verification refuses the append — the
 * action that required the evidence stays blocked.
 */
export function createFileSecurityAuditTrail(
  file: string,
  options: SecurityAuditTrailOptions,
): SecurityAuditTrail {
  const key = requireCorrelationKey(options.key);
  const now = options.now ?? (() => new Date());
  const newEventId = options.newEventId ?? (() => randomUUID());
  const lockOptions = {
    ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
    now,
  };
  assertProtectedLogFile(file);
  withLock(file, lockOptions, () => normalizeFileLog(file, key));

  return buildTrail(
    {
      durability: "durable",
      append(normalized: SecurityAuditEvent): SecurityAuditEntry {
        return withLock(file, lockOptions, () => {
          const verified = normalizeFileLog(file, key);
          const seq = verified.seq + 1;
          const hash = chainHash(key, verified.hash, seq, normalized);
          const line: AuditLine = { seq, prev: verified.hash, event: normalized, hash };
          const fd = fs.openSync(file, "a", 0o600);
          try {
            fs.writeSync(fd, `${JSON.stringify(line)}\n`);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          writeAnchor(file, { seq, hash });
          return { seq, event: normalized, hash };
        });
      },
      allEntries(): readonly SecurityAuditEntry[] {
        return withLock(file, lockOptions, () => normalizeFileLog(file, key).entries);
      },
      verify() {
        return withLock(file, lockOptions, () => {
          const verified = normalizeFileLog(file, key);
          return {
            entries: verified.seq,
            headSeq: verified.seq,
            headHash: verified.hash,
          };
        });
      },
    },
    { now, newEventId },
  );
}

/**
 * In-memory trail for tests and wiring checks. Explicitly marked `test` so a
 * deployment cannot silently audit into memory.
 */
export function createMemorySecurityAuditTrail(
  options: Partial<SecurityAuditTrailOptions> = {},
): SecurityAuditTrail {
  const now = options.now ?? (() => new Date());
  const newEventId = options.newEventId ?? (() => randomUUID());
  const key = options.key ? requireCorrelationKey(options.key) : Buffer.alloc(0);
  const entries: SecurityAuditEntry[] = [];
  let hash = GENESIS;
  const chain = (event: SecurityAuditEvent): string => {
    const seq = entries.length + 1;
    const next =
      key.length === 0
        ? `${HASH_PREFIX}${createHash("sha256")
            .update(JSON.stringify([hash, seq, event]))
            .digest("base64url")}`
        : chainHash(key, hash, seq, event);
    hash = next;
    return next;
  };
  return buildTrail(
    {
      durability: "test",
      append(normalized: SecurityAuditEvent): SecurityAuditEntry {
        const seq = entries.length + 1;
        const entry: SecurityAuditEntry = { seq, event: normalized, hash: chain(normalized) };
        entries.push(entry);
        return entry;
      },
      allEntries(): readonly SecurityAuditEntry[] {
        return [...entries];
      },
      verify() {
        return { entries: entries.length, headSeq: entries.length, headHash: hash };
      },
    },
    { now, newEventId },
  );
}

/** Apply the second line of defense to a value before it is chain-hashed. */
export function scrubAuditText(value: string): string {
  return scrubSecrets(value);
}
