/**
 * One-time, expiring recovery authorizations (DAT-212, ADR-0005 §5).
 *
 * A recovery approval authorizes *rechecking* one rebuilt request for one
 * destination — never bypass. The store keeps the reviewed facts an approval
 * binds (context revision, enterprise/workspace/issue/run, case, destination,
 * policy and rule revisions), enforces a bounded expiry, and lets a dispatch
 * path consume the authorization exactly once.
 *
 * Consumption is deliberately a synchronous, total operation: check and
 * mark happen in one tick with a durable write in between, so two concurrent
 * workers can never both win — and a worker that crashes after consuming
 * leaves an authorization that is spent, never reusable.
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
export type RecoveryInvalidReason =
  | "unknown_authorization"
  | "already_consumed"
  | "already_invalidated"
  | "revoked"
  | "expired"
  | "case_changed"
  | "context_changed"
  | "destination_changed"
  | "policy_changed"
  | "rules_changed"
  | "scan_policy_changed"
  | "approval_principal_no_longer_authorized"
  | "identity_revoked"
  | "recheck_failed"
  | "data_class_not_authorized"
  | "scope_mismatch"
  | "request_unavailable"
  | "approval_unrecorded";

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
  private readonly options: RecoveryAuthorizationStoreOptions;
  private readonly now: () => Date;
  private readonly newAuthorizationId: () => string;

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
    this.persist();
    return authorization;
  }

  get(authorizationId: string): RecoveryAuthorization | undefined {
    return this.authorizations.get(authorizationId);
  }

  list(): readonly RecoveryAuthorization[] {
    return [...this.authorizations.values()];
  }

  /** Stored state plus the derived `expired` reading. */
  statusAt(
    authorizationId: string,
    at: Date = this.now(),
  ): RecoveryAuthorizationStatus | undefined {
    const record = this.authorizations.get(authorizationId);
    if (!record) return undefined;
    return this.statusOf(record, at);
  }

  statusOf(record: RecoveryAuthorization, at: Date = this.now()): RecoveryAuthorizationStatus {
    if (record.state === "approved" && this.isExpired(record, at)) return "expired";
    return record.state;
  }

  /**
   * Atomically consume an authorization for exactly one dispatch attempt.
   *
   * Synchronous by contract: the check and the durable state change happen
   * with no `await` in between, so of two concurrent workers at most one gets
   * `ok: true`. An expired, consumed, revoked, or invalidated authorization
   * is refused with its machine reason.
   */
  consume(authorizationId: string, consumerId: string): ConsumeResult {
    const record = this.authorizations.get(authorizationId);
    if (!record) return { ok: false, reason: "unknown_authorization" };
    if (record.state === "consumed") return { ok: false, reason: "already_consumed" };
    if (record.state === "invalidated") return { ok: false, reason: "already_invalidated" };
    if (record.state === "revoked") return { ok: false, reason: "revoked" };
    if (this.isExpired(record, this.now())) return { ok: false, reason: "expired" };
    requireNonEmpty(consumerId, "consumerId");
    const at = this.timestamp();
    record.state = "consumed";
    record.consumedAt = at;
    record.consumedBy = consumerId;
    record.updatedAt = at;
    this.persist();
    return { ok: true, authorization: record };
  }

  /**
   * Invalidate an unconsumed authorization. Invalidating never rewrites a
   * consumed, revoked, or terminal record: the first terminal reading stands.
   */
  invalidate(
    authorizationId: string,
    reason: RecoveryInvalidReason,
  ): RecoveryAuthorization | undefined {
    const record = this.authorizations.get(authorizationId);
    if (!record || record.state !== "approved") return record;
    record.state = "invalidated";
    record.stateReason = reason;
    record.updatedAt = this.timestamp();
    this.persist();
    return record;
  }

  /** Withdraw an unconsumed approval; a consumed authorization cannot be revived. */
  revoke(
    authorizationId: string,
    input: { by: string; reason: string },
  ): RecoveryAuthorization | undefined {
    const record = this.authorizations.get(authorizationId);
    if (!record) return undefined;
    requireNonEmpty(input.by, "revocation.by");
    requireNonEmpty(input.reason, "revocation.reason");
    if (record.state !== "approved") return record;
    record.state = "revoked";
    record.stateReason = scrubSecrets(input.reason);
    record.updatedAt = this.timestamp();
    this.persist();
    return record;
  }

  /**
   * Record the dispatch outcome durably. An `unknown` outcome starts in
   * reconciliation state `pending` and is never treated as "not sent".
   */
  recordOutcome(outcome: RecoveryDispatchOutcome): RecoveryDispatchOutcome {
    requireNonEmpty(outcome.authorizationId, "outcome.authorizationId");
    this.outcomesByAuthorization.set(outcome.authorizationId, outcome);
    this.persist();
    return outcome;
  }

  outcomeOf(authorizationId: string): RecoveryDispatchOutcome | undefined {
    return this.outcomesByAuthorization.get(authorizationId);
  }

  outcomes(): readonly RecoveryDispatchOutcome[] {
    return [...this.outcomesByAuthorization.values()];
  }

  /** Unreconciled `unknown` outcomes, for the operational reconciliation list. */
  pendingReconciliation(): readonly RecoveryDispatchOutcome[] {
    return [...this.outcomesByAuthorization.values()].filter(
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
    this.persist();
    return outcome;
  }

  private isExpired(record: RecoveryAuthorization, at: Date): boolean {
    return at.getTime() >= new Date(record.expiresAt).getTime();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private load(): void {
    const file = this.options.persistencePath;
    if (!file || !fs.existsSync(file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
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
    for (const record of state.authorizations) {
      this.authorizations.set(record.authorizationId, record);
    }
    for (const outcome of state.outcomes) {
      this.outcomesByAuthorization.set(outcome.authorizationId, outcome);
    }
  }

  private persist(): void {
    const file = this.options.persistencePath;
    if (!file) return;
    const state: PersistedState = {
      schema_version: SCHEMA_VERSION,
      authorizations: [...this.authorizations.values()],
      outcomes: [...this.outcomesByAuthorization.values()],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
