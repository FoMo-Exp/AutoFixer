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
 * and the sink is required: when the pre-dispatch record cannot be written,
 * the dispatch does not happen.
 *
 * The durable sink is tamper-*evident*: every line is hash-chained to its
 * predecessor and the head is anchored in a separate owner-only file, so an
 * ordinary edit, reordering, deletion of an anchored record, or a clean
 * truncation is detected when the log is opened or verified. Appends are
 * serialized across processes by an exclusive lock and derive their sequence
 * number from the log as it is on disk inside that lock, so concurrent writers
 * extend one chain instead of forking it — and a detected
 * log refuses to accept new records, which blocks the dispatch that depended
 * on it. Protection against an attacker who runs as the same OS identity and
 * rewrites both files is out of scope for any in-repo file sink: deployments
 * must inject an append-only/WORM backend for that guarantee, which is why
 * {@link RecoveryAuditSink} carries an explicit `durability` marker and the
 * service refuses an unmarked test sink unless a test opts in.
 *
 * Lock policy (Architect ruling on DAT-212): the lock is acquired only by an
 * exclusive create, {@link openAuditLogLock} stores a unique random token in
 * the lock file, and releasing it first reads that file back and removes it
 * only when the token still matches this process. There is deliberately **no
 * automatic stale-lock recovery**: "judge stale, then unlink by path" has a
 * time-of-check/time-of-use hole (two writers can both judge the same old lock
 * stale, one deletes the other's fresh lock, and both enter the append
 * critical section, forking the chain), so an expired lock fails closed with
 * `RECOVERY_AUDIT_LOCK_TIMEOUT` and the dispatch that needed the record is
 * blocked. A crashed holder's lock must be removed by an operator who has
 * confirmed the recorded pid/host is gone; never delete a live lock. The
 * holder identity is reported only when the lock file carries a complete and
 * well-typed one: a truncated or malformed lock is reported as unparseable and
 * is never padded with placeholder values, because a made-up pid/host could
 * send an operator to delete a live lock. Boundary
 * of the token check: while this process holds the lock, no legitimate writer
 * can create a new lock at that path, so a token mismatch can only come from
 * manual intervention — and an operator deleting a lock during a live write is
 * outside this guarantee, which is why a mismatch refuses to continue instead
 * of claiming the log is intact.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import type { RequestScanEvidence } from "../gateway/types.js";
import type { RecoveryDestination, RecoveryScope } from "./recovery-authorization.js";
import { SecurityError } from "./types.js";
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
 * blocks the send instead of letting unaudited bytes leave. `durability` is a
 * structural marker: `test` sinks are only accepted by an explicit test opt-in
 * on the recovery service, never by a deployment default.
 */
export interface RecoveryAuditSink {
  readonly durability: "durable" | "test";
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

/** One hash-chained line of the durable audit log. */
interface AuditLine {
  seq: number;
  prev: string;
  record: RecoveryAuditRecord;
  hash: string;
}

/** The anchored chain head, kept outside the log so truncation is detectable. */
interface AuditAnchor {
  seq: number;
  hash: string;
}

const GENESIS = "genesis";
const HASH_PREFIX = "h1.";
/** A log line larger than this is not a record this sink wrote. */
const MAX_LINE_BYTES = 512 * 1024;

export interface RecoveryAuditSinkOptions {
  /**
   * Optional service key. A keyed chain cannot be recomputed by somebody who
   * can only edit the log (an unkeyed chain can be re-forged by anyone).
   */
  key?: Buffer;
  /** How long to wait for another writer's lock before failing closed. */
  lockTimeoutMs?: number;
}

function chainHash(
  key: Buffer | undefined,
  prev: string,
  seq: number,
  record: RecoveryAuditRecord,
): string {
  const canonical = JSON.stringify([prev, seq, record]);
  const digest = (key ? createHmac("sha256", key) : createHash("sha256")).update(canonical);
  return `${HASH_PREFIX}${digest.digest("base64url")}`;
}

function integrityError(detail: string, details: Record<string, unknown> = {}): SecurityError {
  return new SecurityError(
    "RECOVERY_AUDIT_LOG_TAMPERED",
    `recovery audit log failed integrity verification: ${detail}`,
    details,
  );
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/** Owner-only regular file; a symlink or a group/world-readable log is refused. */
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
      "RECOVERY_AUDIT_LOG_UNPROTECTED",
      "the recovery audit log must be a regular file owned by the service",
      { file },
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new SecurityError(
      "RECOVERY_AUDIT_LOG_UNPROTECTED",
      "the recovery audit log is readable or writable beyond its owner; fix its mode (0600) first",
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
  const temporary = `${target}.${process.pid}.tmp`;
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
  records: RecoveryAuditRecord[];
  seq: number;
  hash: string;
  /** Bytes of a trailing torn line that must be dropped before appending. */
  tornBytes: number;
}

/**
 * Verify the whole hash chain and its anchor. A complete line that does not
 * verify, a reordering, an anchored truncation, or a forged head raises
 * `RECOVERY_AUDIT_LOG_TAMPERED`. A trailing partial line (a crash mid-write,
 * no final newline) is reported separately so the writer can drop exactly
 * those bytes instead of bricking the log.
 */
export function verifyRecoveryAuditLog(
  file: string,
  options: RecoveryAuditSinkOptions = {},
): VerifiedLog {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const lines = raw.split("\n");
  const records: RecoveryAuditRecord[] = [];
  const hashes: string[] = [];
  let tornBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLast = index === lines.length - 1;
    if (isLast && line === "") break;
    if (isLast && !raw.endsWith("\n")) {
      // Trailing bytes without a newline: a torn append. Only their size is
      // trusted; the writer drops exactly those bytes.
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
    const expectedHash = chainHash(options.key, prev as string, parsed.seq, parsed.record);
    if (parsed.hash !== expectedHash) {
      throw integrityError("an audit line was modified after it was written", { seq: parsed.seq });
    }
    records.push(parsed.record);
    hashes.push(parsed.hash);
  }
  const seq = records.length;
  const hash = seq === 0 ? GENESIS : (hashes[seq - 1] as string);
  const anchor = readAnchor(file);
  if (seq === 0) {
    // An empty log with a non-empty anchor means every anchored record was
    // removed; an empty log with no anchor is a fresh log.
    if (anchor && anchor.seq > 0) {
      throw integrityError("every anchored audit record was removed", { anchored: anchor.seq });
    }
    return { records, seq, hash, tornBytes };
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
  return { records, seq, hash, tornBytes };
}

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 5;

/** Synchronous sleep: append order must not interleave with other writers. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What one holder writes into its lock file; the token proves ownership. */
interface LockIdentity {
  token: string;
  pid: number;
  host: string;
  at: string;
}

/** What the lock file actually contains: the token (if readable) and full identity (if complete). */
interface LockFileContent {
  /** Ownership token exactly as written, or `null` when absent or not a non-empty string. */
  token: string | null;
  /** Complete holder identity, or `null` when any field is missing or malformed. */
  identity: LockIdentity | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Positive, safe integer: a real process id, never a sentinel such as `-1` or `0`. */
function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A timestamp string that names a real instant (`Date.parse` rejects garbage). */
function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

/**
 * Read the lock file once. Nothing in here fills in a missing field: an
 * unreadable, truncated, or mistyped lock yields `identity: null` rather than
 * a fabricated holder, because this is the evidence an operator uses to decide
 * whether a leftover lock may be deleted.
 */
function readLockFileContent(lockFile: string): LockFileContent {
  const empty: LockFileContent = { token: null, identity: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
  const fields = parsed as Partial<Record<keyof LockIdentity, unknown>>;
  const token = isNonEmptyString(fields.token) ? fields.token : null;
  if (token === null) return empty;
  if (!isPositivePid(fields.pid) || !isNonEmptyString(fields.host) || !isTimestamp(fields.at)) {
    return { token, identity: null };
  }
  return {
    token,
    identity: { token, pid: fields.pid, host: fields.host, at: fields.at },
  };
}

/**
 * Complete holder identity, or `null`. Every field must be present and valid:
 * a non-empty token, a positive safe-integer pid, a non-empty host, and a
 * parseable timestamp. A partial lock is not an identity — reporting one would
 * risk an operator deleting a live lock on the strength of a made-up pid/host.
 */
function readLockIdentity(lockFile: string): LockIdentity | null {
  return readLockFileContent(lockFile).identity;
}

/**
 * Fail closed with the evidence an operator needs to decide by hand. No
 * automatic recovery is attempted: the lock is never deleted from here.
 */
function lockTimeoutError(file: string, lockFile: string): SecurityError {
  let lockMtime: string | null = null;
  try {
    lockMtime = new Date(fs.statSync(lockFile).mtimeMs).toISOString();
  } catch {
    lockMtime = null;
  }
  const holder = readLockIdentity(lockFile);
  return new SecurityError(
    "RECOVERY_AUDIT_LOCK_TIMEOUT",
    "another writer holds the recovery audit log; the record was not appended and the dispatch that needed it is blocked. No automatic lock recovery is performed: confirm the holder recorded below is gone — and when no holder identity could be parsed, inspect the lock file itself and confirm by other means that nothing live holds it — then delete the lock file by hand. Never delete a live lock.",
    {
      file,
      lockFile,
      lockMtime,
      // Only a complete, valid identity is reported; a partial lock file is
      // reported as unparseable and never padded with placeholder values.
      lockHolder: holder
        ? { pid: holder.pid, host: holder.host, at: holder.at, parseable: true }
        : { parseable: false },
      manualAction: holder
        ? `confirm the process pid=${holder.pid} host=${holder.host} (lock written at ${holder.at}) is gone, then remove ${lockFile}; never remove a live lock`
        : `the lock file content is incomplete or not parseable, so the holder identity is unknown: inspect ${lockFile} directly (its mode, owner, size and mtime ${lockMtime ?? "unknown"}), confirm by other means that no live process holds it, and only then remove it by hand; never remove a live lock`,
    },
  );
}

/** A held audit-log lock: a unique token plus the only legitimate release. */
export interface AuditLogLock {
  /** Unique ownership token written into the lock file. */
  readonly token: string;
  /**
   * Remove the lock file, but only if it still carries this token. A mismatch
   * means the path no longer holds our lock (manual intervention), so nothing
   * is deleted and `RECOVERY_AUDIT_LOCK_LOST` is raised.
   */
  release(): void;
}

/**
 * Acquire the exclusive log lock. The only acquisition path is an exclusive
 * create of `<log>.lock`; nothing reclaims another writer's lock, however old
 * or evidently abandoned it looks, because a check-then-unlink on a path is a
 * time-of-check/time-of-use hole that can delete a fresh lock and put two
 * writers inside the append critical section. The only path-based delete this
 * module performs is the release of a lock whose owner token it read back and
 * verified; a lock whose token was never written is left for an operator.
 *
 * Exported for the release-path regression test; not a public contract.
 */
export function openAuditLogLock(
  file: string,
  options: RecoveryAuditSinkOptions = {},
): AuditLogLock {
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + (options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "EEXIST") throw error;
      fd = undefined;
    }
    if (fd !== undefined) {
      const identity: LockIdentity = {
        token,
        pid: process.pid,
        host: os.hostname(),
        at: new Date().toISOString(),
      };
      // If the owner token cannot be written durably, this process cannot
      // prove the path is still its own, so nothing is deleted: the leftover
      // lock blocks later writers until an operator inspects and removes it.
      // That availability loss is the fail-closed choice this ruling requires.
      try {
        fs.writeSync(fd, JSON.stringify(identity));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        token,
        release(): void {
          // One read yields both the ownership token and the evidence fields,
          // so the decision and the report can never disagree.
          const current = readLockFileContent(lockFile);
          // Ownership is proven by the token alone (this process wrote it and
          // no legitimate writer can have replaced it); the complete identity
          // is only ever reported as evidence, never synthesized.
          if (current.token !== token) {
            throw new SecurityError(
              "RECOVERY_AUDIT_LOCK_LOST",
              "the audit log lock no longer carries this process's ownership token; it was left in place and the write is not treated as exclusive",
              {
                file,
                lockFile,
                expectedToken: token,
                foundToken: current.token,
                lockHolder: current.identity
                  ? {
                      pid: current.identity.pid,
                      host: current.identity.host,
                      at: current.identity.at,
                      parseable: true,
                    }
                  : { parseable: false },
                manualAction: current.identity
                  ? `inspect ${lockFile}; it does not carry this process's token, so a live holder may own it — confirm pid=${current.identity.pid} host=${current.identity.host} is gone before removing it; a live lock must not be removed`
                  : `the lock file no longer carries a complete holder identity (a non-empty token, a positive pid, a non-empty host and a parseable timestamp are all required), so the owner is unknown: inspect ${lockFile} directly and confirm by other means that no live process holds it before removing it; a live lock must not be removed`,
              },
            );
          }
          fs.unlinkSync(lockFile);
        },
      };
    }
    if (Date.now() >= deadline) throw lockTimeoutError(file, lockFile);
    sleepSync(LOCK_RETRY_MS);
  }
}

/**
 * Run one mutation under the exclusive log lock. A release that finds the lock
 * no longer ours fails closed instead of silently continuing; when the body
 * itself failed, the body's error is the one raised (the lock stays in place,
 * which blocks later writers until an operator acts).
 */
function withLogLock<T>(file: string, options: RecoveryAuditSinkOptions, fn: () => T): T {
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

/**
 * Verify the log and drop a torn trailing append (a crash mid-write, no final
 * newline). Complete lines that fail verification still raise: a corrupted
 * chain is never silently repaired.
 */
function normalizeLog(file: string, options: RecoveryAuditSinkOptions): VerifiedLog {
  const verified = verifyRecoveryAuditLog(file, options);
  if (verified.tornBytes > 0) {
    const size = fs.statSync(file).size;
    fs.truncateSync(file, Math.max(0, size - verified.tornBytes));
  }
  return verified;
}

/**
 * Durable, tamper-evident audit sink: one hash-chained JSONL line per record,
 * owner-only permissions, fsynced appends, and an anchored head. Every append
 * takes an exclusive lock, re-reads and re-verifies the log, and derives its
 * sequence number and previous hash from what is on disk *inside* that lock —
 * so two workers appending to the same log produce one chain, not two forks
 * that both look locally valid.
 *
 * Opening a log that fails verification throws, as does an append that cannot
 * get the lock: the recovery service then refuses to dispatch instead of
 * sending on top of unproven audit evidence.
 */
export function createFileRecoveryAuditSink(
  file: string,
  options: RecoveryAuditSinkOptions = {},
): RecoveryAuditSink {
  assertProtectedLogFile(file);
  withLogLock(file, options, () => {
    normalizeLog(file, options);
  });
  return {
    durability: "durable",
    record(record: RecoveryAuditRecord): void {
      const scrubbed = scrubAuditRecord(record);
      withLogLock(file, options, () => {
        const verified = normalizeLog(file, options);
        const nextSeq = verified.seq + 1;
        const nextHash = chainHash(options.key, verified.hash, nextSeq, scrubbed);
        const line: AuditLine = {
          seq: nextSeq,
          prev: verified.hash,
          record: scrubbed,
          hash: nextHash,
        };
        const fd = fs.openSync(file, "a", 0o600);
        try {
          fs.writeSync(fd, `${JSON.stringify(line)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        writeAnchor(file, { seq: nextSeq, hash: nextHash });
      });
    },
  };
}

/**
 * In-memory sink for tests and for wiring checks. It is explicitly marked
 * `test`: the recovery service refuses it unless a test opts in, so no
 * deployment silently audits into memory.
 */
export function createMemoryRecoveryAuditSink(): {
  audit: RecoveryAuditSink;
  records: RecoveryAuditRecord[];
} {
  const records: RecoveryAuditRecord[] = [];
  return {
    audit: {
      durability: "test",
      record(record: RecoveryAuditRecord): void {
        records.push(record);
      },
    },
    records,
  };
}
