/**
 * One-time, expiring recovery authorizations (DAT-212, ADR-0005 §5).
 *
 * A recovery approval authorizes *rechecking* one rebuilt request for one
 * destination — never bypass. The store keeps the reviewed facts an approval
 * binds (context revision, enterprise/workspace/issue/run, case, destination,
 * policy and rule revisions), enforces a bounded expiry, and lets a dispatch
 * path consume the authorization exactly once.
 *
 * Single use is arbitrated by a *claim ledger*, not by in-memory state: the
 * first decision about one authorization — consume, invalidate, or revoke —
 * wins an exclusive-create (`O_CREAT|O_EXCL`) claim file and every later
 * decision is refused. Two independent Node workers sharing one state file
 * therefore cannot both dispatch, and a worker that crashes between claiming
 * and persisting leaves the claim behind, so the authorization stays spent.
 * A store without a persistence path is single-process by construction and
 * uses the same arbitration in memory.
 *
 * The claim file is per authorization and is written with owner-only
 * permissions under `<state>.claims/`. Cross-process guarantees follow the
 * underlying filesystem's `O_EXCL` semantics (atomic on local POSIX and
 * Windows filesystems); a deployment on a network filesystem must provide a
 * storage backend with the same guarantee.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import { SecurityError, requireNonEmpty } from "./types.js";

/**
 * Closed vocabulary of why a recovery authorization can no longer be used.
 * Every value is a non-secret machine reason suitable for audit and for the
 * `RECOVERY_APPROVAL_INVALID` error contract.
 */
export const RECOVERY_INVALID_REASONS = [
  "unknown_authorization",
  "already_consumed",
  "already_invalidated",
  "revoked",
  "expired",
  "case_changed",
  "context_changed",
  "destination_changed",
  "policy_changed",
  "rules_changed",
  "scan_policy_changed",
  "approval_principal_no_longer_authorized",
  "identity_revoked",
  "recheck_failed",
  "data_class_not_authorized",
  "scope_mismatch",
  "request_unavailable",
  "approval_unrecorded",
] as const;

export type RecoveryInvalidReason = (typeof RECOVERY_INVALID_REASONS)[number];

/** Stored lifecycle state; `expired` is derived, never stored. */
export type RecoveryAuthorizationState = "approved" | "consumed" | "invalidated" | "revoked";

/** Derived status including expiry. */
export type RecoveryAuthorizationStatus = RecoveryAuthorizationState | "expired";

/**
 * The destination one approval covers. The endpoint's pinned base URL is part
 * of the binding: an endpoint that keeps its id but changes its origin is a
 * different destination and invalidates the approval.
 */
export interface RecoveryDestination {
  endpointId: string;
  provider: string;
  api: string;
  modelId: string;
  internal: boolean;
  baseUrl: string;
}

/** Enterprise/workspace/issue/run scope one approval covers. */
export interface RecoveryScope {
  enterpriseId: string;
  workspaceId: string;
  issueId: string;
  runId: string;
}

/**
 * The reviewed facts an approval binds (ADR-0005 §5). All revisions are
 * keyed, non-secret correlation identifiers; none is derivable from request
 * content without the service correlation key.
 */
export interface RecoveryApproval {
  caseId: string;
  scope: RecoveryScope;
  destination: RecoveryDestination;
  /** Keyed identifier of the complete reviewed request. */
  contextRevision: string;
  /** Policy revision the recheck must still resolve. */
  policyRevision: string;
  /** Keyed identifier of the active rule revisions in this scope. */
  rulesRevision: string;
  /** Keyed identifier of the scan policy (minimization/derivation) in force. */
  scanPolicyRevision: string;
  /** The independent reviewer who approved rechecking. */
  approvedBy: string;
  approvedAt: string;
}

/** One issued, expiring, single-use recovery authorization. */
export interface RecoveryAuthorization {
  authorizationId: string;
  approval: RecoveryApproval;
  expiresAt: string;
  state: RecoveryAuthorizationState;
  /** Machine reason for the stored state (`null` while `approved`). */
  stateReason: string | null;
  consumedAt: string | null;
  consumedBy: string | null;
  updatedAt: string;
}

/** Outcome classification of one recovery dispatch attempt. */
export type RecoveryDispatchOutcomeKind = "dispatched" | "failed" | "unknown";

/**
 * How an `unknown` provider outcome was reconciled. Reconciliation never
 * authorizes a replay: a consumed authorization stays consumed whatever the
 * finding, and a further send needs a fresh, independently approved one.
 */
export type RecoveryReconciliationFinding =
  "confirmed_sent" | "confirmed_not_sent" | "provider_rejected" | "unresolved";

export interface RecoveryReconciliation {
  state: "pending" | RecoveryReconciliationFinding;
  at: string | null;
  by: string | null;
  detail: string | null;
}

/**
 * The durable record of what actually happened at dispatch — deliberately
 * separate from the approval record (ADR-0005 §6: audit distinguishes
 * approval from sending).
 */
export interface RecoveryDispatchOutcome {
  authorizationId: string;
  caseId: string;
  scope: RecoveryScope;
  invocationId: string | null;
  traceId: string | null;
  kind: RecoveryDispatchOutcomeKind;
  detail: string | null;
  /** Keyed digest of the exact frozen request handed to the adapter. */
  requestDigest: string | null;
  recordedAt: string;
  /** Present only for `unknown` outcomes awaiting reconciliation. */
  reconciliation: RecoveryReconciliation | null;
}

export interface RecoveryAuthorizationStoreOptions {
  /** JSON state file; every mutation persists atomically when set. */
  persistencePath?: string;
  now?: () => Date;
  newAuthorizationId?: () => string;
  /** Expiry applied when an approval does not state one. */
  defaultTtlSeconds?: number;
  /** Hard upper bound on any approval lifetime. */
  maxTtlSeconds?: number;
}

/**
 * The first decided outcome for one authorization. Exactly one claim file per
 * authorization is ever created; its existence is the arbitration point.
 */
interface RecoveryClaim {
  kind: RecoveryAuthorizationState;
  by: string;
  at: string;
  reason: string | null;
}

type ClaimOutcome = { won: true; claim: RecoveryClaim } | { won: false; claim: RecoveryClaim };

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_SECONDS = 15 * 60;
const DEFAULT_MAX_TTL_SECONDS = 60 * 60;

interface PersistedState {
  schema_version: number;
  authorizations: RecoveryAuthorization[];
  outcomes: RecoveryDispatchOutcome[];
}

export type ConsumeResult =
  { ok: true; authorization: RecoveryAuthorization } | { ok: false; reason: RecoveryInvalidReason };

/**
 * Durable store for recovery authorizations and their dispatch outcomes.
 *
 * Nothing in this store holds request content: the reviewed request appears
 * only as a keyed `contextRevision`, and the dispatched request only as a
 * keyed `requestDigest`.
 */
export class RecoveryAuthorizationStore {
  private readonly authorizations = new Map<string, RecoveryAuthorization>();
  private readonly outcomesByAuthorization = new Map<string, RecoveryDispatchOutcome>();
  private readonly inMemoryClaims = new Map<string, RecoveryClaim>();
  /** Records this instance changed and must write back over another worker's file. */
  private readonly dirtyAuthorizations = new Set<string>();
  private readonly dirtyOutcomes = new Set<string>();
  private readonly options: RecoveryAuthorizationStoreOptions;
  private readonly now: () => Date;
  private readonly newAuthorizationId: () => string;
  /** Last state-file content observed, to avoid re-reading an unchanged file. */
  private lastLoadedRaw: string | null = null;

  constructor(options: RecoveryAuthorizationStoreOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.newAuthorizationId = options.newAuthorizationId ?? (() => randomUUID());
    this.load();
  }

  /** Hard upper bound on any approval lifetime (seconds). */
  get maxTtlSeconds(): number {
    return this.options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
  }

  /** Expiry applied when an approval states none (seconds). */
  get defaultTtlSeconds(): number {
    return this.options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  /**
   * Issue one authorization for reviewed facts. The lifetime must be a
   * positive whole number of seconds within the configured bound — an
   * unbounded or non-positive approval is refused, never clamped.
   */
  issue(input: { approval: RecoveryApproval; ttlSeconds?: number }): RecoveryAuthorization {
    const ttl = input.ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > this.maxTtlSeconds) {
      throw new SecurityError(
        "RECOVERY_TTL_INVALID",
        `recovery approval lifetime must be 1..${this.maxTtlSeconds} seconds`,
        { ttlSeconds: ttl, maxTtlSeconds: this.maxTtlSeconds },
      );
    }
    const approval = input.approval;
    requireNonEmpty(approval.caseId, "approval.caseId");
    requireNonEmpty(approval.approvedBy, "approval.approvedBy");
    requireNonEmpty(approval.contextRevision, "approval.contextRevision");
    requireNonEmpty(approval.policyRevision, "approval.policyRevision");
    requireNonEmpty(approval.rulesRevision, "approval.rulesRevision");
    requireNonEmpty(approval.scanPolicyRevision, "approval.scanPolicyRevision");
    requireNonEmpty(approval.destination.endpointId, "approval.destination.endpointId");
    requireNonEmpty(approval.destination.modelId, "approval.destination.modelId");
    const at = this.timestamp();
    const authorization: RecoveryAuthorization = {
      authorizationId: this.newAuthorizationId(),
      approval,
      expiresAt: new Date(this.now().getTime() + ttl * 1000).toISOString(),
      state: "approved",
      stateReason: null,
      consumedAt: null,
      consumedBy: null,
      updatedAt: at,
    };
    this.authorizations.set(authorization.authorizationId, authorization);
    this.dirtyAuthorizations.add(authorization.authorizationId);
    this.persist();
    return authorization;
  }

  /**
   * Read one authorization as the shared state currently describes it: the
   * durable file is re-read (so another worker's decision is visible) and the
   * claim ledger is overlaid on the stored record.
   */
  get(authorizationId: string): RecoveryAuthorization | undefined {
    this.syncFromDisk();
    const record = this.authorizations.get(authorizationId);
    if (!record) return undefined;
    return this.applyClaim(record);
  }

  list(): readonly RecoveryAuthorization[] {
    this.syncFromDisk();
    return [...this.authorizations.values()].map((record) => this.applyClaim(record));
  }

  /** Stored state plus the derived `expired` reading. */
  statusAt(
    authorizationId: string,
    at: Date = this.now(),
  ): RecoveryAuthorizationStatus | undefined {
    const record = this.get(authorizationId);
    if (!record) return undefined;
    return this.statusOf(record, at);
  }

  statusOf(record: RecoveryAuthorization, at: Date = this.now()): RecoveryAuthorizationStatus {
    // A claim is authoritative even when this instance's in-memory record has
    // not caught up with the file yet.
    const claim = this.readClaim(record.authorizationId);
    if (claim) return claim.kind;
    if (record.state === "approved" && this.isExpired(record, at)) return "expired";
    return record.state;
  }

  /**
   * Consume an authorization for exactly one dispatch attempt.
   *
   * The check is synchronous, and the decision is arbitrated by an exclusive
   * claim file, so of two *independent workers* sharing one state file at most
   * one gets `ok: true`. An expired, consumed, revoked, or invalidated
   * authorization is refused with its machine reason.
   */
  consume(authorizationId: string, consumerId: string): ConsumeResult {
    const record = this.get(authorizationId);
    if (!record) return { ok: false, reason: "unknown_authorization" };
    const existing = this.readClaim(authorizationId);
    if (existing) return { ok: false, reason: this.reasonForClaim(existing) };
    if (record.state !== "approved") {
      return { ok: false, reason: this.reasonForState(record.state) };
    }
    if (this.isExpired(record, this.now())) return { ok: false, reason: "expired" };
    requireNonEmpty(consumerId, "consumerId");
    // The arbitration point: exactly one claimant ever wins this file.
    const claimed = this.claim(authorizationId, {
      kind: "consumed",
      by: consumerId,
      at: this.timestamp(),
      reason: null,
    });
    if (!claimed.won) return { ok: false, reason: this.reasonForClaim(claimed.claim) };
    record.state = "consumed";
    record.stateReason = null;
    record.consumedAt = claimed.claim.at;
    record.consumedBy = consumerId;
    record.updatedAt = claimed.claim.at;
    this.dirtyAuthorizations.add(authorizationId);
    this.persist();
    return { ok: true, authorization: record };
  }

  /**
   * Invalidate an unconsumed authorization. Invalidating never rewrites a
   * consumed, revoked, or already invalidated record: the first claim stands,
   * whichever worker wrote it.
   */
  invalidate(
    authorizationId: string,
    reason: RecoveryInvalidReason,
  ): RecoveryAuthorization | undefined {
    const record = this.get(authorizationId);
    if (!record) return undefined;
    if (record.state !== "approved") return record;
    const claimed = this.claim(authorizationId, {
      kind: "invalidated",
      by: "recovery-service",
      at: this.timestamp(),
      reason,
    });
    if (!claimed.won) return this.applyClaim(record, claimed.claim);
    record.state = "invalidated";
    record.stateReason = reason;
    record.updatedAt = claimed.claim.at;
    this.dirtyAuthorizations.add(authorizationId);
    this.persist();
    return record;
  }

  /** Withdraw an unconsumed approval; a consumed authorization cannot be revived. */
  revoke(
    authorizationId: string,
    input: { by: string; reason: string },
  ): RecoveryAuthorization | undefined {
    const record = this.get(authorizationId);
    if (!record) return undefined;
    requireNonEmpty(input.by, "revocation.by");
    requireNonEmpty(input.reason, "revocation.reason");
    if (record.state !== "approved") return record;
    const claimed = this.claim(authorizationId, {
      kind: "revoked",
      by: input.by,
      at: this.timestamp(),
      reason: scrubSecrets(input.reason),
    });
    if (!claimed.won) return this.applyClaim(record, claimed.claim);
    record.state = "revoked";
    record.stateReason = scrubSecrets(input.reason);
    record.updatedAt = claimed.claim.at;
    this.dirtyAuthorizations.add(authorizationId);
    this.persist();
    return record;
  }

  /**
   * Record the dispatch outcome durably. An `unknown` outcome starts in
   * reconciliation state `pending` and is never treated as "not sent".
   */
  recordOutcome(outcome: RecoveryDispatchOutcome): RecoveryDispatchOutcome {
    requireNonEmpty(outcome.authorizationId, "outcome.authorizationId");
    this.syncFromDisk();
    this.outcomesByAuthorization.set(outcome.authorizationId, outcome);
    this.dirtyOutcomes.add(outcome.authorizationId);
    this.persist();
    return outcome;
  }

  outcomeOf(authorizationId: string): RecoveryDispatchOutcome | undefined {
    this.syncFromDisk();
    return this.outcomesByAuthorization.get(authorizationId);
  }

  outcomes(): readonly RecoveryDispatchOutcome[] {
    this.syncFromDisk();
    return [...this.outcomesByAuthorization.values()];
  }

  /** Unreconciled `unknown` outcomes, for the operational reconciliation list. */
  pendingReconciliation(): readonly RecoveryDispatchOutcome[] {
    return this.outcomes().filter(
      (outcome) => outcome.kind === "unknown" && outcome.reconciliation?.state === "pending",
    );
  }

  /**
   * Record how one `unknown` outcome was reconciled. Reconciliation is a
   * record, not a grant: it cannot reset consumption and never authorizes a
   * replay (ADR-0005 §5).
   */
  reconcile(
    authorizationId: string,
    input: { by: string; finding: RecoveryReconciliationFinding; detail?: string },
  ): RecoveryDispatchOutcome {
    this.syncFromDisk();
    const outcome = this.outcomesByAuthorization.get(authorizationId);
    if (!outcome) {
      throw new SecurityError(
        "RECOVERY_OUTCOME_NOT_FOUND",
        `no recovery dispatch outcome for ${authorizationId}`,
        { authorizationId },
      );
    }
    if (outcome.kind !== "unknown") {
      throw new SecurityError(
        "RECOVERY_OUTCOME_NOT_UNKNOWN",
        "only an unknown provider outcome can be reconciled",
        { authorizationId, kind: outcome.kind },
      );
    }
    requireNonEmpty(input.by, "reconciliation.by");
    outcome.reconciliation = {
      state: input.finding,
      at: this.timestamp(),
      by: input.by,
      detail: input.detail ?? null,
    };
    this.dirtyOutcomes.add(authorizationId);
    this.persist();
    return outcome;
  }

  /** Overlay a claim onto an in-memory record so every reader agrees. */
  private applyClaim(
    record: RecoveryAuthorization,
    claim: RecoveryClaim | undefined = this.readClaim(record.authorizationId),
  ): RecoveryAuthorization {
    // No claim: the stored record is what it says (expiry is derived, never
    // written), so there is nothing to overlay.
    if (!claim) return record;
    if (claim.kind === "consumed") {
      record.state = "consumed";
      record.consumedAt = claim.at;
      record.consumedBy = claim.by;
      record.updatedAt = claim.at;
    } else {
      record.state = claim.kind;
      record.stateReason = claim.reason ?? claim.kind;
      record.updatedAt = claim.at;
    }
    return record;
  }

  private reasonForClaim(claim: RecoveryClaim): RecoveryInvalidReason {
    return claim.kind === "consumed"
      ? "already_consumed"
      : claim.kind === "invalidated"
        ? "already_invalidated"
        : "revoked";
  }

  private reasonForState(state: RecoveryAuthorizationState): RecoveryInvalidReason {
    return state === "consumed"
      ? "already_consumed"
      : state === "invalidated"
        ? "already_invalidated"
        : "revoked";
  }

  /**
   * Win the one-time claim for this authorization. The exclusive create
   * (`wx`/`O_EXCL`) is the cross-process arbitration: exactly one caller
   * creates the file; everybody else reads the winner's decision.
   */
  private claim(authorizationId: string, claim: RecoveryClaim): ClaimOutcome {
    const existing = this.readClaim(authorizationId);
    if (existing) return { won: false, claim: existing };
    const file = this.claimPath(authorizationId);
    if (!file) {
      // Single-process store: the map is the arbitration and JS is single
      // threaded, so a check-then-set here is atomic.
      this.inMemoryClaims.set(authorizationId, claim);
      return { won: true, claim };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "EEXIST") throw error;
      const winner = this.readClaim(authorizationId);
      if (winner) return { won: false, claim: winner };
      // A claim file exists but cannot be read: refuse rather than guess.
      throw new SecurityError(
        "RECOVERY_CLAIM_UNREADABLE",
        "a recovery claim exists but could not be read; refusing to dispatch",
        { authorizationId },
      );
    }
    try {
      fs.writeSync(fd, JSON.stringify(claim));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { won: true, claim };
  }

  private readClaim(authorizationId: string): RecoveryClaim | undefined {
    const file = this.claimPath(authorizationId);
    if (!file) return this.inMemoryClaims.get(authorizationId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RecoveryClaim>;
      if (
        parsed.kind !== "consumed" &&
        parsed.kind !== "invalidated" &&
        parsed.kind !== "revoked"
      ) {
        return undefined;
      }
      return {
        kind: parsed.kind,
        by: typeof parsed.by === "string" ? parsed.by : "unknown",
        at: typeof parsed.at === "string" ? parsed.at : "",
        reason: typeof parsed.reason === "string" ? parsed.reason : null,
      };
    } catch {
      return undefined;
    }
  }

  private claimPath(authorizationId: string): string | undefined {
    const base = this.options.persistencePath;
    if (!base) return undefined;
    return path.join(`${base}.claims`, `${encodeURIComponent(authorizationId)}.json`);
  }

  private isExpired(record: RecoveryAuthorization, at: Date): boolean {
    return at.getTime() >= new Date(record.expiresAt).getTime();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  /**
   * Re-read the shared state file. Another worker's consume/invalidate/revoke
   * lands here, so this instance never dispatches on a stale reading.
   */
  private syncFromDisk(): void {
    const file = this.options.persistencePath;
    if (!file) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") return;
      throw error;
    }
    if (raw === this.lastLoadedRaw) return;
    this.applyPersisted(raw);
  }

  private load(): void {
    const file = this.options.persistencePath;
    if (!file || !fs.existsSync(file)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      throw new SecurityError("RECOVERY_STORE_INVALID", "recovery state file cannot be read");
    }
    this.applyPersisted(raw);
  }

  private applyPersisted(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SecurityError("RECOVERY_STORE_INVALID", "recovery state file is not valid JSON");
    }
    const state = parsed as Partial<PersistedState>;
    if (
      state.schema_version !== SCHEMA_VERSION ||
      !Array.isArray(state.authorizations) ||
      !Array.isArray(state.outcomes)
    ) {
      throw new SecurityError(
        "RECOVERY_STORE_INVALID",
        "recovery state file has an unsupported shape",
      );
    }
    const authorizations = new Map<string, RecoveryAuthorization>();
    for (const record of state.authorizations) {
      authorizations.set(record.authorizationId, record);
    }
    const outcomes = new Map<string, RecoveryDispatchOutcome>();
    for (const outcome of state.outcomes) {
      outcomes.set(outcome.authorizationId, outcome);
    }
    this.authorizations.clear();
    for (const [id, record] of authorizations) this.authorizations.set(id, record);
    this.outcomesByAuthorization.clear();
    for (const [id, outcome] of outcomes) this.outcomesByAuthorization.set(id, outcome);
    this.lastLoadedRaw = raw;
  }

  /**
   * Write the shared file without clobbering another worker's unrelated
   * records: records this instance changed win, everything else is taken from
   * the file as it stands now. The claim ledger remains the authority for
   * whether an authorization is spent, so even a lost write can never make a
   * consumed approval usable again.
   */
  private persist(): void {
    const file = this.options.persistencePath;
    if (!file) return;
    const disk = this.readStateQuietly(file);
    const authorizations = new Map<string, RecoveryAuthorization>(
      (disk?.authorizations ?? []).map((record) => [record.authorizationId, record]),
    );
    for (const [id, record] of this.authorizations) {
      if (this.dirtyAuthorizations.has(id) || !authorizations.has(id)) {
        authorizations.set(id, record);
      }
    }
    const outcomes = new Map<string, RecoveryDispatchOutcome>(
      (disk?.outcomes ?? []).map((outcome) => [outcome.authorizationId, outcome]),
    );
    for (const [id, outcome] of this.outcomesByAuthorization) {
      if (this.dirtyOutcomes.has(id) || !outcomes.has(id)) outcomes.set(id, outcome);
    }
    this.authorizations.clear();
    for (const [id, record] of authorizations) this.authorizations.set(id, record);
    this.outcomesByAuthorization.clear();
    for (const [id, outcome] of outcomes) this.outcomesByAuthorization.set(id, outcome);
    const state: PersistedState = {
      schema_version: SCHEMA_VERSION,
      authorizations: [...authorizations.values()],
      outcomes: [...outcomes.values()],
    };
    const serialized = JSON.stringify(state);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    this.lastLoadedRaw = serialized;
  }

  /** Read the shared state file without mutating in-memory state. */
  private readStateQuietly(file: string): PersistedState | null {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.schema_version !== SCHEMA_VERSION) return null;
      if (!Array.isArray(parsed.authorizations) || !Array.isArray(parsed.outcomes)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}
