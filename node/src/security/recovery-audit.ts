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
 */

import { createHash, createHmac } from "node:crypto";
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
  /** Age after which a lock whose owner is gone may be broken. */
  lockStaleMs?: number;
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
const DEFAULT_LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 5;

/** Synchronous sleep: append order must not interleave with other writers. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== "ESRCH";
  }
}

/**
 * A lock older than `staleMs` whose owning process is gone (same host) is
 * abandoned by a crashed writer and may be broken; a live or remote writer's
 * lock is never broken.
 */
function isStaleLock(lockFile: string, staleMs: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return false;
  }
  if (Date.now() - stat.mtimeMs < staleMs) return false;
  let owner: { pid?: unknown; host?: unknown } = {};
  try {
    owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown; host?: unknown };
  } catch {
    owner = {};
  }
  const host = typeof owner.host === "string" ? owner.host : undefined;
  const pid = typeof owner.pid === "number" ? owner.pid : undefined;
  // Never break another host's lock: its process liveness is unknowable here.
  if (host !== undefined && host !== os.hostname()) return false;
  if (pid === undefined) return true;
  return !isProcessAlive(pid);
}

/**
 * Serialize every mutation of one audit log across processes with an
 * exclusive-create lock file, then release it. Waiting is bounded: a writer
 * that cannot get the lock raises instead of appending on a stale head, which
 * blocks the dispatch that depends on this record.
 */
function withLogLock<T>(file: string, options: RecoveryAuditSinkOptions, fn: () => T): T {
  const lockFile = `${file}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "EEXIST") throw error;
      fd = undefined;
    }
    if (fd !== undefined) {
      try {
        fs.writeSync(
          fd,
          JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }),
        );
        fs.fsyncSync(fd);
      } catch (error) {
        // Never leak a half-created lock: it would block every later writer.
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Already gone.
        }
        throw error;
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // Already released by a stale-lock sweep; the append itself stands.
        }
      }
    }
    if (isStaleLock(lockFile, staleMs)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Somebody else broke it first; retry the acquisition.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new SecurityError(
        "RECOVERY_AUDIT_LOCK_TIMEOUT",
        "another writer holds the recovery audit log; refusing to append unaudited or forked evidence",
        { file, lockFile },
      );
    }
    sleepSync(LOCK_RETRY_MS);
  }
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
