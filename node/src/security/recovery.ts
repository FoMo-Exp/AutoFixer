/**
 * Reviewed recovery: full request reconstruction, complete recheck, and a
 * single audited dispatch (DAT-212, ADR-0005 §5).
 *
 * The flow is fixed:
 *
 * 1. An independent reviewer approves *rechecking* one rebuilt request for one
 *    destination. The approval binds the keyed context revision, the
 *    enterprise/workspace/issue/run/case scope, the destination, and the
 *    policy, rule, and scan-policy revisions in force.
 * 2. A recovery attempt rebuilds the complete request from approved sources
 *    and refuses to continue when anything the approval bound has changed.
 * 3. Authorization, destination, classification, minimization, and secret
 *    checks run again in full over that rebuilt request, under the current
 *    policy and the currently activated rule corrections.
 * 4. The passing scan is bound to a frozen copy of the exact final request and
 *    its destination; every required audit record is written durably before
 *    anything is sent.
 * 5. Authorization is revalidated at dispatch and consumed atomically, so
 *    concurrent workers cannot send twice and a crashed worker cannot reuse
 *    the approval.
 * 6. An unknown provider outcome is recorded as unknown — never as "not sent",
 *    never replayed under the consumed authorization.
 *
 * There is no retry and no fallback in this path: every additional send needs
 * its own authorized destination and its own independent approval.
 */

import { randomUUID } from "node:crypto";

import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import { buildAdapterOptions } from "../gateway/adapter.js";
import type { ProviderAdapter } from "../gateway/adapter.js";
import type { GatewayCredentialStore } from "../gateway/credentials.js";
import type { GatewayPolicyResolver } from "../gateway/policy.js";
import { scrubSecrets } from "../gateway/redact.js";
import { authorizeRequestDataClasses, runRequestScanGate } from "../gateway/scan.js";
import type { ScanDenyReason, SecretScanPolicy, SecretScanner } from "../gateway/scan.js";
import type {
  DataClass,
  GatewayDenyReason,
  GatewayRequestIdentity,
  RequestScanEvidence,
} from "../gateway/types.js";
import {
  MODEL_EGRESS_DENIED,
  ModelDispatchError,
  ModelEgressDeniedError,
  SENSITIVE_DATA_UNCERTAIN,
} from "../gateway/types.js";
import type { SecurityCaseStore } from "./case-store.js";
import { assertIndependentReview, requireDuty, requireScope } from "./duties.js";
import type { SecurityDutyDirectory } from "./duties.js";
import { scrubAuditRecord } from "./recovery-audit.js";
import type { RecoveryAuditRecord, RecoveryAuditSink } from "./recovery-audit.js";
import {
  contextRevisionOf,
  deepFreezeRequest,
  rebuildCompleteRequest,
  requestDigestOf,
  requireCorrelationKey,
  rulesRevisionOf,
  scanPolicyRevisionOf,
} from "./recovery-request.js";
import type { RecoveryRequestSource } from "./recovery-request.js";
import type { ActiveRuleCorrection } from "./rules.js";
import type {
  RecoveryApproval,
  RecoveryAuthorization,
  RecoveryAuthorizationStore,
  RecoveryDestination,
  RecoveryDispatchOutcome,
  RecoveryDispatchOutcomeKind,
  RecoveryInvalidReason,
  RecoveryReconciliationFinding,
  RecoveryScope,
} from "./recovery-authorization.js";
import { SecurityError, isTerminalCaseState, requireNonEmpty } from "./types.js";
import type { SecurityActor, SecurityCase } from "./types.js";

/** Stable redacted error code for an approval that can no longer authorize. */
export const RECOVERY_APPROVAL_INVALID = "RECOVERY_APPROVAL_INVALID";

/**
 * A recovery attempt whose approval no longer authorizes it. Not retryable:
 * the approval is invalid, revoked, expired, or consumed, or the world it
 * bound has changed, and only a fresh independent approval can authorize a
 * recheck.
 */
export class RecoveryApprovalInvalidError extends Error {
  readonly code = RECOVERY_APPROVAL_INVALID;
  readonly retryable = false;
  readonly stage = "recovery_dispatch";

  constructor(
    readonly reason: RecoveryInvalidReason,
    message: string,
    readonly refs: { authorizationId?: string; caseId?: string } = {},
  ) {
    super(message);
    this.name = "RecoveryApprovalInvalidError";
  }
}

/**
 * A recheck that failed closed. Reuses the gateway's denial contract so a
 * caller sees the same stable codes, and adds the case and authorization it
 * belongs to.
 */
export class RecoveryEgressDeniedError extends ModelEgressDeniedError {
  readonly stage = "recovery_recheck";
  override readonly caseId: string;
  readonly authorizationId: string;

  constructor(input: {
    reason: GatewayDenyReason;
    message: string;
    code: string;
    caseId: string;
    authorizationId: string;
  }) {
    super(input.reason, input.message, input.code);
    this.name = "RecoveryEgressDeniedError";
    this.caseId = input.caseId;
    this.authorizationId = input.authorizationId;
  }
}

/** A permitted dispatch attempt failed — with a known or an unknown outcome. */
export class RecoveryDispatchError extends ModelDispatchError {
  readonly authorizationId: string;
  readonly caseId: string;
  readonly outcome: "failed" | "unknown";

  constructor(input: {
    message: string;
    authorizationId: string;
    caseId: string;
    retryable: boolean;
    outcome: "failed" | "unknown";
  }) {
    super(input.message, input.retryable);
    this.name = "RecoveryDispatchError";
    this.authorizationId = input.authorizationId;
    this.caseId = input.caseId;
    this.outcome = input.outcome;
  }
}

/**
 * ADR-0006 seam: whether a principal's identity is still active. A revoked or
 * unestablished answer invalidates recovery authority; deployments without the
 * seam still get role revocation enforced through the duty directory.
 */
export interface RecoveryIdentityStatus {
  isActive(principalId: string): boolean | undefined;
}

export interface RecoveryServiceDeps {
  authorizations: RecoveryAuthorizationStore;
  cases: SecurityCaseStore;
  duties: SecurityDutyDirectory;
  source: RecoveryRequestSource;
  policyResolver: GatewayPolicyResolver;
  credentials: GatewayCredentialStore;
  adapter: ProviderAdapter;
  /**
   * Required durable audit sink: pre-dispatch evidence must exist before
   * sending. A sink marked `test` is refused unless `allowTestAuditSink` is
   * set, so no deployment can silently audit into memory.
   */
  audit: RecoveryAuditSink;
  /** Explicit test-only opt-in for a non-durable audit sink. Never set in deployment. */
  allowTestAuditSink?: boolean;
  /** Service key for keyed context revisions and request digests. */
  correlationKey: Buffer;
  rules?: { activeCorrections(): readonly ActiveRuleCorrection[] };
  scanner?: SecretScanner;
  scanPolicy?: SecretScanPolicy;
  scanTimeoutMs?: number;
  /** Idle timeout while awaiting a provider event; silence is an unknown outcome. */
  dispatchTimeoutMs?: number;
  identityStatus?: RecoveryIdentityStatus;
  now?: () => Date;
  newInvocationId?: () => string;
  onIncident?: (message: string) => void;
}

/** One permitted recovery dispatch: the forwarded stream and its durable outcome. */
export interface RecoveryDispatchHandle {
  authorizationId: string;
  caseId: string;
  invocationId: string;
  traceId: string;
  /** Keyed digest of the frozen request handed to the adapter. */
  requestDigest: string;
  stream: AssistantMessageEventStream;
  /** Resolves with the recorded outcome; never rejects. */
  outcome: Promise<RecoveryDispatchOutcome>;
}

export interface ApproveRecoveryInput {
  caseId: string;
  reviewer: SecurityActor;
  destination: { endpointId: string; modelId: string };
  ttlSeconds?: number;
}

export interface RecoverInput {
  authorizationId: string;
  /** Identity of the run whose blocked request is being recovered. */
  identity: Omit<GatewayRequestIdentity, "invocationId">;
  /** Stable identifier of the worker performing the dispatch. */
  workerId: string;
  /** Model metadata for the bound destination; identity fields are pinned. */
  model: Model<Api>;
  options?: SimpleStreamOptions;
}

interface EndpointResolution {
  endpointId: string;
  provider: string;
  api: Api;
  baseUrl: string;
  internal: boolean;
  credentialRef: string;
  models: string[];
  permittedDataClasses?: DataClass[];
  policyRevision: string;
}

interface PreparedDispatch {
  authorization: RecoveryAuthorization;
  caseId: string;
  scope: RecoveryScope;
  destination: RecoveryDestination;
  modelId: string;
  provider: string;
  api: Api;
  baseUrl: string;
  credential: string;
  frozen: Context;
  requestDigest: string;
  scan: RequestScanEvidence;
  invocationId: string;
  traceId: string;
  workerId: string;
  model: Model<Api>;
  options?: SimpleStreamOptions;
}

interface PumpControl {
  isSettled(): boolean;
  arm(): void;
  conclude(kind: RecoveryDispatchOutcomeKind, detail: string | null): Promise<void>;
  fail(kind: RecoveryDispatchOutcomeKind, detail: string): void;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

/** Codes that prove the request bytes never left this process. */
const NOT_SENT_ERROR_CODES =
  /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|ERR_INVALID_URL)$/;

function isNotSentFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && NOT_SENT_ERROR_CODES.test(code);
}

function isTerminalEvent(event: AssistantMessageEvent): boolean {
  return event.type === "done" || event.type === "error";
}

function syntheticErrorMessage(model: Model<Api>, detail: string): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    content: [],
    stopReason: "error",
    errorMessage: detail,
  };
}

/**
 * Scan-gate denials about uncertain secret handling surface under the stable
 * `SENSITIVE_DATA_UNCERTAIN` code (ADR-0005); authorization denials stay
 * `MODEL_EGRESS_DENIED`.
 */
function scanDenyErrorCode(reason: ScanDenyReason): string {
  return reason === "AUTHORIZATION_MISSING" ? MODEL_EGRESS_DENIED : SENSITIVE_DATA_UNCERTAIN;
}

const SERVICE_ACTOR: SecurityActor = { actorId: "recovery-service", actorKind: "service" };

/**
 * Recovery service: issue one-time approvals and perform the single rechecked,
 * audited dispatch each one authorizes.
 */
export class RecoveryService {
  private readonly deps: RecoveryServiceDeps;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private readonly newInvocationId: () => string;

  constructor(deps: RecoveryServiceDeps) {
    if (deps.audit?.durability !== "durable" && deps.allowTestAuditSink !== true) {
      // Fail closed at composition: without a durable, tamper-evident audit
      // sink the recovery boundary cannot meet ADR-0005 §6.
      throw new SecurityError(
        "RECOVERY_AUDIT_SINK_UNPROTECTED",
        "recovery requires a durable audit sink; a test sink needs the explicit allowTestAuditSink opt-in",
        { durability: deps.audit?.durability ?? null },
      );
    }
    this.deps = deps;
    this.key = requireCorrelationKey(deps.correlationKey);
    this.now = deps.now ?? (() => new Date());
    this.newInvocationId = deps.newInvocationId ?? (() => randomUUID());
  }

  /**
   * Approve rechecking one rebuilt request at one destination. The reviewer
   * must hold the independent-reviewer duty, must not be a handling principal
   * of the case, and the case must be awaiting review. The approval carries a
   * bounded expiry and binds every fact later revalidation re-checks.
   */
  async approve(input: ApproveRecoveryInput): Promise<RecoveryAuthorization> {
    const record = this.requireCase(input.caseId);
    const scope: RecoveryScope = { ...record.scope };
    requireDuty("recovery.approve", input.reviewer, this.deps.duties, requireScope(scope));
    if (record.state !== "awaiting_review") {
      throw new SecurityError(
        "RECOVERY_CASE_NOT_REVIEWABLE",
        `case ${record.caseId} is ${record.state}; rechecking is approved only during review`,
        { caseId: record.caseId, state: record.state },
      );
    }
    this.assertIndependent(record, input.reviewer);
    this.assertIdentityActive(input.reviewer.actorId);

    const rebuilt = await rebuildCompleteRequest(this.deps.source, {
      caseId: record.caseId,
      scope,
    });
    const endpoint = await this.resolveApprovedEndpoint(scope, input.destination);
    const approval: RecoveryApproval = {
      caseId: record.caseId,
      scope: { ...record.scope },
      destination: this.destinationOf(endpoint, input.destination.modelId),
      contextRevision: contextRevisionOf(rebuilt.context, this.key),
      policyRevision: endpoint.policyRevision,
      rulesRevision: this.rulesRevision(scope),
      scanPolicyRevision: scanPolicyRevisionOf(this.deps.scanPolicy, this.key),
      approvedBy: requireNonEmpty(input.reviewer.actorId, "reviewer.actorId"),
      approvedAt: this.timestamp(),
    };
    const authorization = this.deps.authorizations.issue({
      approval,
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    });
    try {
      await this.audit({
        event: "recovery.approval_recorded",
        authorizationId: authorization.authorizationId,
        caseId: record.caseId,
        scope: approval.scope,
        approvalRecord: authorization,
        actor: input.reviewer,
        invocationId: null,
        traceId: null,
        requestDigest: null,
        scan: null,
        outcome: "approved",
        reason: "independent review approved rechecking",
        detail: {
          sourceCount: rebuilt.sourceIds.length,
          sources: rebuilt.sourceIds.map((sourceId) => scrubSecrets(sourceId)).join(","),
        },
      });
    } catch {
      // An approval without an audit record must not be usable.
      this.deps.authorizations.invalidate(authorization.authorizationId, "approval_unrecorded");
      this.incident(`recovery approval audit write failed for case ${record.caseId}`);
      throw new SecurityError(
        "RECOVERY_AUDIT_UNAVAILABLE",
        "the approval could not be recorded durably; no authorization was issued",
        { caseId: record.caseId },
      );
    }
    this.appendCaseEvent(record.caseId, "recovery.approved", input.reviewer, {
      authorizationId: authorization.authorizationId,
      expiresAt: authorization.expiresAt,
      endpointId: approval.destination.endpointId,
      modelId: approval.destination.modelId,
      contextRevision: approval.contextRevision,
      policyRevision: approval.policyRevision,
      rulesRevision: approval.rulesRevision,
    });
    return authorization;
  }

  /** Withdraw an unconsumed approval (reviewer or administrator work). */
  revoke(authorizationId: string, actor: SecurityActor, reason: string): RecoveryAuthorization {
    const record = this.requireAuthorization(authorizationId);
    requireDuty("recovery.revoke", actor, this.deps.duties, requireScope(record.approval.scope));
    requireNonEmpty(reason, "reason");
    const revoked = this.deps.authorizations.revoke(authorizationId, {
      by: actor.actorId,
      reason: scrubSecrets(reason),
    });
    if (!revoked) {
      throw new RecoveryApprovalInvalidError(
        "unknown_authorization",
        "no such recovery authorization",
        { authorizationId },
      );
    }
    if (revoked.state !== "revoked") {
      // A consumed or already-invalidated approval cannot be withdrawn: its
      // state is final and the caller must not believe otherwise.
      throw new SecurityError(
        "RECOVERY_APPROVAL_NOT_REVOCABLE",
        "only an unconsumed, approved recovery authorization can be revoked",
        { authorizationId, state: this.deps.authorizations.statusOf(revoked) ?? null },
      );
    }
    void this.auditSafely({
      event: "recovery.approval_revoked",
      authorizationId,
      caseId: revoked.approval.caseId,
      scope: revoked.approval.scope,
      approvalRecord: revoked,
      actor,
      invocationId: null,
      traceId: null,
      requestDigest: null,
      scan: null,
      outcome: "failed",
      reason: "revoked",
      detail: { revokedBy: actor.actorId },
    });
    this.appendCaseEvent(revoked.approval.caseId, "recovery.invalidated", actor, {
      authorizationId,
      reason: "revoked",
    });
    return revoked;
  }

  /**
   * One recovery attempt: revalidate the bound world, rebuild and recheck the
   * complete request, persist the required pre-dispatch evidence, revalidate
   * once more, consume the approval atomically, and dispatch exactly once.
   */
  async recover(input: RecoverInput): Promise<RecoveryDispatchHandle> {
    const authorization = this.requireAuthorization(input.authorizationId);
    const approval = authorization.approval;
    const preflight = this.deps.authorizations.statusOf(authorization);
    if (preflight !== "approved") {
      throw this.invalid(
        authorization,
        this.reasonForStatus(preflight),
        "the approval is no longer usable",
      );
    }
    if (
      input.identity.enterpriseId !== approval.scope.enterpriseId ||
      input.identity.workspaceId !== approval.scope.workspaceId ||
      input.identity.issueId !== approval.scope.issueId ||
      input.identity.runId !== approval.scope.runId
    ) {
      throw new RecoveryApprovalInvalidError(
        "scope_mismatch",
        "the invocation does not belong to the scope this approval binds",
        { authorizationId: authorization.authorizationId, caseId: approval.caseId },
      );
    }
    requireNonEmpty(input.workerId, "workerId");
    if (input.model.id !== approval.destination.modelId) {
      throw this.egressDeny(authorization, {
        reason: "MODEL_NOT_APPROVED",
        message: `the approval binds ${approval.destination.modelId}, not ${scrubSecrets(input.model.id)}`,
      });
    }

    // Every fact the approval bound is re-checked here — case state and
    // scope, the reviewer's current authority and independence, identity
    // revocation, and (below) the policy, destination, rule and scan-policy
    // revisions — and the same check runs again after the pre-dispatch audit.
    await this.revalidateDispatchBounds(authorization);

    // Rebuild the complete request from approved sources and recheck the
    // reviewed content. Any difference invalidates the approval.
    let rebuilt;
    try {
      rebuilt = await rebuildCompleteRequest(this.deps.source, {
        caseId: approval.caseId,
        scope: approval.scope,
      });
    } catch {
      throw this.invalidateAndDeny(
        authorization,
        "request_unavailable",
        "the complete request could not be rebuilt from approved sources",
      );
    }
    if (contextRevisionOf(rebuilt.context, this.key) !== approval.contextRevision) {
      throw this.invalidateAndDeny(
        authorization,
        "context_changed",
        "the rebuilt request is not the reviewed request",
      );
    }

    const endpoint = await this.revalidateDestination(authorization);
    if (input.options?.apiKey !== undefined) {
      throw this.egressDeny(authorization, {
        reason: "CALLER_CREDENTIAL_SUPPLIED",
        message: "the caller must not supply provider credentials",
      });
    }
    const credential = this.deps.credentials.get(endpoint.credentialRef);
    if (!credential) {
      throw this.egressDeny(authorization, {
        reason: "CREDENTIAL_MISSING",
        message: `no credential for ${endpoint.credentialRef}`,
      });
    }

    // Complete recheck: authorization, destination, classification,
    // minimization, and secret checks over the whole rebuilt request.
    const scope = requireScope(approval.scope);
    const gate = await runRequestScanGate(rebuilt.context, {
      ...(this.deps.scanner ? { scanner: this.deps.scanner } : {}),
      ...(this.deps.scanPolicy ? { scanPolicy: this.deps.scanPolicy } : {}),
      ...(this.deps.scanTimeoutMs !== undefined ? { scanTimeoutMs: this.deps.scanTimeoutMs } : {}),
      scope,
    });
    if (!gate.ok) {
      // Continued uncertainty keeps the request blocked; the approval is spent
      // on this failed recheck and a fresh one is required.
      this.deps.authorizations.invalidate(authorization.authorizationId, "recheck_failed");
      await this.auditSafely({
        event: "recovery.recheck_failed",
        authorizationId: authorization.authorizationId,
        caseId: approval.caseId,
        scope: approval.scope,
        approvalRecord: authorization,
        actor: SERVICE_ACTOR,
        invocationId: null,
        traceId: input.identity.traceId,
        requestDigest: null,
        scan: gate.evidence,
        outcome: "failed",
        reason: gate.reason,
        detail: { sourceCount: rebuilt.sourceIds.length },
      });
      this.appendCaseEvent(approval.caseId, "recovery.invalidated", SERVICE_ACTOR, {
        authorizationId: authorization.authorizationId,
        reason: "recheck_failed",
      });
      throw new RecoveryEgressDeniedError({
        reason: gate.reason,
        message: `model egress denied (${gate.reason}): ${scrubSecrets(gate.detail)}`,
        code: scanDenyErrorCode(gate.reason),
        caseId: approval.caseId,
        authorizationId: authorization.authorizationId,
      });
    }
    const authorizationCheck = authorizeRequestDataClasses(gate.evidence.dataClasses, endpoint);
    if (!authorizationCheck.ok) {
      throw this.invalidateAndDeny(
        authorization,
        "data_class_not_authorized",
        authorizationCheck.detail,
        authorizationCheck.reason,
      );
    }

    // Bind the passing scan to an immutable copy of the exact final request
    // and its destination. The adapter gets this copy and nothing else.
    const destination = this.destinationOf(endpoint, approval.destination.modelId);
    const frozen = deepFreezeRequest(gate.context);
    const requestDigest = requestDigestOf(frozen, destination, this.key);
    this.assertIntact(frozen, destination, requestDigest);
    const invocationId = this.newInvocationId();
    const prepared: PreparedDispatch = {
      authorization,
      caseId: approval.caseId,
      scope: approval.scope,
      destination,
      modelId: approval.destination.modelId,
      provider: approval.destination.provider,
      api: approval.destination.api as Api,
      baseUrl: approval.destination.baseUrl,
      credential,
      frozen,
      requestDigest,
      scan: gate.evidence,
      invocationId,
      traceId: input.identity.traceId,
      workerId: input.workerId,
      model: input.model,
      ...(input.options !== undefined ? { options: input.options } : {}),
    };

    // Required pre-dispatch evidence: the recheck result, the frozen-request
    // digest, and the authorization lifecycle. A write failure blocks the send.
    try {
      await this.audit({
        event: "recovery.pre_dispatch",
        authorizationId: authorization.authorizationId,
        caseId: approval.caseId,
        scope: approval.scope,
        approvalRecord: authorization,
        actor: SERVICE_ACTOR,
        invocationId,
        traceId: input.identity.traceId,
        requestDigest,
        scan: gate.evidence,
        outcome: null,
        reason: "complete request rechecked under current policy",
        detail: {
          sourceCount: rebuilt.sourceIds.length,
          workerId: scrubSecrets(input.workerId),
          segments: gate.evidence.segments,
        },
      });
    } catch {
      throw this.egressDeny(authorization, {
        reason: "AUDIT_UNAVAILABLE",
        message: "required pre-dispatch audit evidence could not be recorded",
      });
    }

    // The pre-dispatch audit sink is external and may take arbitrary time, so
    // every bound fact is revalidated *again* after it — policy, destination,
    // rule revisions, scan policy, case state, reviewer authority, and
    // identity revocation. The context cannot drift into this send: the
    // dispatched bytes are the frozen copy already bound to the audit record.
    await this.revalidateDispatchBounds(authorization);

    // From here to the claim there is no `await`: these final checks and the
    // one-time claim form one uninterrupted critical section, and the claim
    // file arbitrates against every other worker.
    const revalidated = this.deps.authorizations.statusOf(authorization);
    if (revalidated !== "approved") {
      throw this.invalid(
        authorization,
        this.reasonForStatus(revalidated),
        "the approval is no longer usable",
      );
    }
    this.assertIntact(frozen, destination, requestDigest);
    const consumed = this.deps.authorizations.consume(
      authorization.authorizationId,
      input.workerId,
    );
    if (!consumed.ok) {
      throw this.invalid(authorization, consumed.reason, "the approval was not consumable");
    }

    // A consumed approval marks an actual dispatch attempt — distinct from the
    // approval record and from the eventual send outcome.
    try {
      await this.audit({
        event: "recovery.dispatch_attempted",
        authorizationId: authorization.authorizationId,
        caseId: approval.caseId,
        scope: approval.scope,
        approvalRecord: authorization,
        actor: SERVICE_ACTOR,
        invocationId,
        traceId: input.identity.traceId,
        requestDigest,
        scan: gate.evidence,
        outcome: null,
        reason: "one-time authorization consumed for a single dispatch attempt",
        detail: { workerId: scrubSecrets(input.workerId) },
      });
    } catch {
      const failure = await this.recordOutcome(
        prepared,
        "failed",
        "dispatch aborted before send: audit unavailable",
      );
      this.incident(
        `recovery dispatch aborted for case ${approval.caseId}: dispatch-attempt audit write failed`,
      );
      throw new RecoveryDispatchError({
        message: "the dispatch attempt could not be recorded; nothing was sent",
        authorizationId: authorization.authorizationId,
        caseId: approval.caseId,
        retryable: false,
        outcome: failure.kind === "unknown" ? "unknown" : "failed",
      });
    }
    this.appendCaseEvent(approval.caseId, "recovery.dispatch_attempted", SERVICE_ACTOR, {
      authorizationId: authorization.authorizationId,
      invocationId,
      requestDigest,
    });
    return this.startAttempt(prepared);
  }

  /** Unreconciled unknown provider outcomes awaiting operational reconciliation. */
  pendingReconciliation(): readonly RecoveryDispatchOutcome[] {
    return this.deps.authorizations.pendingReconciliation();
  }

  /**
   * Record how one unknown provider outcome was reconciled. Never a replay
   * grant: the authorization stays consumed whatever the finding.
   */
  reconcile(
    authorizationId: string,
    actor: SecurityActor,
    finding: RecoveryReconciliationFinding,
    detail?: string,
  ): RecoveryDispatchOutcome {
    const record = this.requireAuthorization(authorizationId);
    requireDuty("recovery.reconcile", actor, this.deps.duties, requireScope(record.approval.scope));
    const outcome = this.deps.authorizations.reconcile(authorizationId, {
      by: actor.actorId,
      finding,
      ...(detail !== undefined ? { detail: scrubSecrets(detail) } : {}),
    });
    void this.auditSafely({
      event: "recovery.reconciliation_recorded",
      authorizationId,
      caseId: record.approval.caseId,
      scope: record.approval.scope,
      approvalRecord: record,
      actor,
      invocationId: outcome.invocationId,
      traceId: outcome.traceId,
      requestDigest: outcome.requestDigest,
      scan: null,
      outcome: "unknown",
      reason: finding,
      detail: { finding },
    });
    return outcome;
  }

  /**
   * One dispatch attempt with an idle deadline. The outcome is recorded before
   * the stream ends, so a caller that observes a failure can never be told a
   * request was sent when it was not — or the reverse.
   */
  private startAttempt(prepared: PreparedDispatch): RecoveryDispatchHandle {
    const out = createAssistantMessageEventStream();
    const resolved = Promise.withResolvers<RecoveryDispatchOutcome>();
    const timeoutMs = this.deps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    const state = { settled: false };
    let timer: NodeJS.Timeout | undefined;
    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const conclude = async (
      kind: RecoveryDispatchOutcomeKind,
      detail: string | null,
    ): Promise<void> => {
      if (state.settled) return;
      state.settled = true;
      clear();
      resolved.resolve(await this.recordOutcome(prepared, kind, detail));
    };
    const fail = (kind: RecoveryDispatchOutcomeKind, detail: string): void => {
      out.push({
        type: "error",
        reason: "error",
        error: syntheticErrorMessage(
          {
            ...prepared.model,
            id: prepared.modelId,
            provider: prepared.provider,
            api: prepared.api,
          },
          detail,
        ),
      });
      out.end();
      void conclude(kind, detail);
    };
    const arm = (): void => {
      clear();
      if (state.settled) return;
      timer = setTimeout(() => {
        if (state.settled) return;
        fail(
          "unknown",
          "no provider event within the dispatch timeout; the provider may have received the request",
        );
      }, timeoutMs);
      timer.unref?.();
    };
    const control: PumpControl = {
      isSettled: () => state.settled,
      arm,
      conclude,
      fail,
    };

    const pinned: Model<Api> = {
      ...prepared.model,
      id: prepared.modelId,
      name: prepared.modelId,
      provider: prepared.provider,
      api: prepared.api,
      baseUrl: prepared.baseUrl,
    };
    const adapterOptions = buildAdapterOptions(prepared.options, prepared.credential);
    let pending: AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
    try {
      pending = this.deps.adapter.stream(pinned, prepared.frozen, adapterOptions);
    } catch (error) {
      fail(isNotSentFailure(error) ? "failed" : "unknown", this.scrubDispatchFailure(error));
      return this.handle(prepared, out, resolved.promise);
    }
    arm();
    void (async () => {
      let inner: AssistantMessageEventStream;
      try {
        inner = await pending;
      } catch (error) {
        if (state.settled) return;
        fail(isNotSentFailure(error) ? "failed" : "unknown", this.scrubDispatchFailure(error));
        return;
      }
      if (state.settled) return;
      if (!inner || typeof inner[Symbol.asyncIterator] !== "function") {
        fail("unknown", "the provider returned no readable stream; the request may have been sent");
        return;
      }
      await this.pump(prepared, inner, out, control);
    })();
    return this.handle(prepared, out, resolved.promise);
  }

  private handle(
    prepared: PreparedDispatch,
    stream: AssistantMessageEventStream,
    outcome: Promise<RecoveryDispatchOutcome>,
  ): RecoveryDispatchHandle {
    return {
      authorizationId: prepared.authorization.authorizationId,
      caseId: prepared.caseId,
      invocationId: prepared.invocationId,
      traceId: prepared.traceId,
      requestDigest: prepared.requestDigest,
      stream,
      outcome,
    };
  }

  /** Forward the provider stream, recording exactly one terminal outcome. */
  private async pump(
    prepared: PreparedDispatch,
    inner: AssistantMessageEventStream,
    out: AssistantMessageEventStream,
    control: PumpControl,
  ): Promise<void> {
    const iterator = inner[Symbol.asyncIterator]();
    for (;;) {
      let next: IteratorResult<AssistantMessageEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        if (control.isSettled()) return;
        control.fail(
          isNotSentFailure(error) ? "failed" : "unknown",
          this.scrubDispatchFailure(error),
        );
        return;
      }
      if (control.isSettled()) return;
      if (next.done) {
        // A stream that ends without a terminal event was truncated: the
        // request may have been sent, so the outcome is unknown, not success.
        control.fail(
          "unknown",
          "the provider stream ended without a terminal event; outcome unknown",
        );
        return;
      }
      const event = next.value;
      control.arm();
      if (isTerminalEvent(event)) {
        if (event.type === "error") {
          const detail = scrubSecrets(event.error.errorMessage ?? "provider stream failed", [
            prepared.credential,
          ]);
          out.push({ ...event, error: { ...event.error, errorMessage: detail } });
          out.end();
          // A provider error is a known failed outcome; an abort leaves it
          // unknown whether the provider received the complete request.
          await control.conclude(event.reason === "aborted" ? "unknown" : "failed", detail);
          return;
        }
        out.push(event);
        out.end();
        await control.conclude("dispatched", null);
        return;
      }
      out.push(event);
    }
  }

  /** Record one outcome durably; failures raise an incident, never a replay. */
  private async recordOutcome(
    prepared: PreparedDispatch,
    kind: RecoveryDispatchOutcomeKind,
    detail: string | null,
  ): Promise<RecoveryDispatchOutcome> {
    const outcome: RecoveryDispatchOutcome = {
      authorizationId: prepared.authorization.authorizationId,
      caseId: prepared.caseId,
      scope: prepared.scope,
      invocationId: prepared.invocationId,
      traceId: prepared.traceId,
      kind,
      detail: detail === null ? null : scrubSecrets(detail, [prepared.credential]),
      requestDigest: prepared.requestDigest,
      recordedAt: this.timestamp(),
      reconciliation:
        kind === "unknown" ? { state: "pending", at: null, by: null, detail: null } : null,
    };
    try {
      this.deps.authorizations.recordOutcome(outcome);
    } catch {
      this.incident(
        `recovery outcome could not be persisted for case ${prepared.caseId}; the request is not replayed`,
      );
    }
    const audited = await this.auditSafely({
      event: "recovery.dispatch_outcome",
      authorizationId: prepared.authorization.authorizationId,
      caseId: prepared.caseId,
      scope: prepared.scope,
      approvalRecord: prepared.authorization,
      actor: SERVICE_ACTOR,
      invocationId: prepared.invocationId,
      traceId: prepared.traceId,
      requestDigest: prepared.requestDigest,
      scan: prepared.scan,
      outcome: kind,
      reason: kind === "unknown" ? "unknown provider outcome; reconciliation required" : kind,
      detail: { workerId: scrubSecrets(prepared.workerId) },
    });
    if (!audited) {
      this.incident(
        `recovery outcome audit write failed for case ${prepared.caseId}; explicit operational incident`,
      );
    }
    if (kind === "unknown") {
      this.incident(
        `unknown provider outcome for case ${prepared.caseId}; not replayed, reconciliation required`,
      );
    }
    this.appendCaseEvent(
      prepared.caseId,
      kind === "unknown"
        ? "recovery.dispatch_unknown"
        : kind === "dispatched"
          ? "recovery.dispatched"
          : "recovery.dispatch_failed",
      SERVICE_ACTOR,
      {
        authorizationId: prepared.authorization.authorizationId,
        invocationId: prepared.invocationId,
        requestDigest: prepared.requestDigest,
      },
    );
    return outcome;
  }

  private scrubDispatchFailure(error: unknown): string {
    return scrubSecrets(error instanceof Error ? error.message : String(error));
  }

  /**
   * A denial that does not invalidate the approval (a caller defect, a
   * missing credential, or unavailable audit): record it and refuse. Nothing
   * was rechecked or sent, so the approval stays usable until it expires.
   */
  private egressDeny(
    authorization: RecoveryAuthorization,
    input: { reason: GatewayDenyReason; message: string },
  ): RecoveryEgressDeniedError {
    void this.auditSafely({
      event: "recovery.dispatch_denied",
      authorizationId: authorization.authorizationId,
      caseId: authorization.approval.caseId,
      scope: authorization.approval.scope,
      approvalRecord: authorization,
      actor: SERVICE_ACTOR,
      invocationId: null,
      traceId: null,
      requestDigest: null,
      scan: null,
      outcome: "failed",
      reason: input.reason,
      detail: {},
    });
    return new RecoveryEgressDeniedError({
      reason: input.reason,
      message: scrubSecrets(input.message),
      code: MODEL_EGRESS_DENIED,
      caseId: authorization.approval.caseId,
      authorizationId: authorization.authorizationId,
    });
  }

  /** Recompute the digest of the frozen copy and refuse any mismatch. */
  private assertIntact(frozen: Context, destination: RecoveryDestination, expected: string): void {
    if (requestDigestOf(frozen, destination, this.key) !== expected) {
      throw new SecurityError(
        "RECOVERY_REQUEST_MUTATED",
        "the final request changed after its scan; nothing may be dispatched",
      );
    }
  }

  /**
   * Re-check every fact a dispatch depends on, from live sources. Each
   * difference invalidates the approval at the claim ledger, so no worker can
   * use it afterwards. Called before the recheck and again after the
   * pre-dispatch audit write.
   */
  private async revalidateDispatchBounds(authorization: RecoveryAuthorization): Promise<void> {
    const approval = authorization.approval;
    const caseRecord = this.requireCurrentCase(authorization);
    this.assertCaseAllowsReviewRound(authorization, caseRecord);
    this.revalidateReviewer(authorization, caseRecord);
    this.revalidateIdentity(authorization, caseRecord.scope.runId);
    if (this.rulesRevision(approval.scope) !== approval.rulesRevision) {
      throw this.invalidateAndDeny(
        authorization,
        "rules_changed",
        "the active rule revisions changed since the approval",
      );
    }
    if (scanPolicyRevisionOf(this.deps.scanPolicy, this.key) !== approval.scanPolicyRevision) {
      throw this.invalidateAndDeny(
        authorization,
        "scan_policy_changed",
        "the scan policy changed since the approval",
      );
    }
    await this.revalidateDestination(authorization);
  }

  /** The case this approval names, still existing and still in its scope. */
  private requireCurrentCase(authorization: RecoveryAuthorization): SecurityCase {
    const approval = authorization.approval;
    const caseRecord = this.deps.cases.get(approval.caseId);
    if (!caseRecord) {
      throw this.invalidateAndDeny(
        authorization,
        "case_changed",
        "the disposal case no longer exists",
      );
    }
    if (
      caseRecord.scope.enterpriseId !== approval.scope.enterpriseId ||
      caseRecord.scope.workspaceId !== approval.scope.workspaceId ||
      caseRecord.scope.issueId !== approval.scope.issueId ||
      caseRecord.scope.runId !== approval.scope.runId
    ) {
      throw this.invalidateAndDeny(authorization, "scope_mismatch", "the case scope changed");
    }
    return caseRecord;
  }

  /**
   * A review-round approval applies while the case is awaiting review or has
   * already been resolved; a case back in handling, still pending, or
   * terminated no longer describes the round that was approved.
   */
  private assertCaseAllowsReviewRound(
    authorization: RecoveryAuthorization,
    caseRecord: SecurityCase,
  ): void {
    if (
      isTerminalCaseState(caseRecord.state) ||
      caseRecord.state === "pending" ||
      caseRecord.state === "handling"
    ) {
      throw this.invalidateAndDeny(
        authorization,
        "case_changed",
        `case ${caseRecord.caseId} is ${caseRecord.state}; a review-round approval no longer applies`,
      );
    }
  }

  /** The approving reviewer must still be an independent, authorized human. */
  private revalidateReviewer(authorization: RecoveryAuthorization, caseRecord: SecurityCase): void {
    try {
      requireDuty(
        "recovery.approve",
        { actorId: authorization.approval.approvedBy, actorKind: "human" },
        this.deps.duties,
        requireScope(authorization.approval.scope),
      );
      if (
        this.deps.cases
          .handlingPrincipals(caseRecord.caseId)
          .includes(authorization.approval.approvedBy)
      ) {
        throw new SecurityError(
          "SOD_SAME_PRINCIPAL_FORBIDDEN",
          "the approving reviewer became a handling principal of the case",
        );
      }
    } catch {
      throw this.invalidateAndDeny(
        authorization,
        "approval_principal_no_longer_authorized",
        "the approving reviewer no longer holds independent review authority for this case",
      );
    }
  }

  /** Identity revocation invalidates the approval; it never merely warns. */
  private revalidateIdentity(authorization: RecoveryAuthorization, runId: string): void {
    try {
      this.assertIdentityActive(authorization.approval.approvedBy);
      this.assertIdentityActive(runId);
    } catch {
      throw this.invalidateAndDeny(
        authorization,
        "identity_revoked",
        "the approving principal or the affected run identity is revoked",
      );
    }
  }

  private async resolveApprovedEndpoint(
    scope: RecoveryScope,
    requested: { endpointId: string; modelId: string },
  ): Promise<EndpointResolution> {
    const policy = await this.deps.policyResolver.resolve(scope);
    if (!policy) {
      throw new SecurityError(
        "RECOVERY_POLICY_UNAVAILABLE",
        "no model egress policy for this scope",
        { workspaceId: scope.workspaceId },
      );
    }
    const endpoint = policy.endpoints.find(
      (candidate) => candidate.endpointId === requested.endpointId,
    );
    if (!endpoint || !endpoint.models.includes(requested.modelId)) {
      throw new SecurityError(
        "RECOVERY_DESTINATION_NOT_APPROVED",
        "the policy does not approve this destination for this model",
        { endpointId: requested.endpointId, modelId: requested.modelId },
      );
    }
    return { ...endpoint, policyRevision: policy.revision };
  }

  private async revalidateDestination(
    authorization: RecoveryAuthorization,
  ): Promise<EndpointResolution> {
    const bound = authorization.approval.destination;
    let endpoint: EndpointResolution;
    try {
      endpoint = await this.resolveApprovedEndpoint(authorization.approval.scope, {
        endpointId: bound.endpointId,
        modelId: bound.modelId,
      });
    } catch {
      throw this.invalidateAndDeny(
        authorization,
        "destination_changed",
        "the approved destination is no longer approved for this model",
      );
    }
    if (endpoint.policyRevision !== authorization.approval.policyRevision) {
      throw this.invalidateAndDeny(
        authorization,
        "policy_changed",
        "the egress policy revision changed since the approval",
      );
    }
    if (
      endpoint.provider !== bound.provider ||
      endpoint.api !== bound.api ||
      endpoint.baseUrl !== bound.baseUrl ||
      endpoint.internal !== bound.internal
    ) {
      throw this.invalidateAndDeny(
        authorization,
        "destination_changed",
        "the approved endpoint now resolves to a different destination",
      );
    }
    return endpoint;
  }

  private destinationOf(endpoint: EndpointResolution, modelId: string): RecoveryDestination {
    return {
      endpointId: endpoint.endpointId,
      provider: endpoint.provider,
      api: endpoint.api,
      modelId,
      internal: endpoint.internal,
      baseUrl: endpoint.baseUrl,
    };
  }

  private rulesRevision(scope: { enterpriseId: string; workspaceId: string }): string {
    const corrections = this.deps.rules?.activeCorrections() ?? [];
    return rulesRevisionOf(corrections, scope, this.key);
  }

  /** Role revocation and identity revocation both invalidate approvals. */
  private assertIdentityActive(principalId: string): void {
    const status = this.deps.identityStatus;
    if (!status) return;
    let active: boolean | undefined;
    try {
      active = status.isActive(principalId);
    } catch {
      active = undefined;
    }
    if (active !== true) {
      throw new SecurityError(
        "RECOVERY_IDENTITY_REVOKED",
        "the principal's identity is revoked or its status cannot be established",
        { principalId },
      );
    }
  }

  private invalidateAndDeny(
    authorization: RecoveryAuthorization,
    reason: RecoveryInvalidReason,
    detail: string,
    denyReason?: "AUTHORIZATION_MISSING" | "DATA_CLASS_NOT_AUTHORIZED",
  ): never {
    this.deps.authorizations.invalidate(authorization.authorizationId, reason);
    void this.auditSafely({
      event: "recovery.authorization_invalidated",
      authorizationId: authorization.authorizationId,
      caseId: authorization.approval.caseId,
      scope: authorization.approval.scope,
      approvalRecord: authorization,
      actor: SERVICE_ACTOR,
      invocationId: null,
      traceId: null,
      requestDigest: null,
      scan: null,
      outcome: "failed",
      reason,
      detail: {},
    });
    this.appendCaseEvent(authorization.approval.caseId, "recovery.invalidated", SERVICE_ACTOR, {
      authorizationId: authorization.authorizationId,
      reason,
    });
    if (denyReason !== undefined) {
      // Destination/authorization failures keep the gateway's stable
      // `MODEL_EGRESS_DENIED` code; only uncertain secret content surfaces as
      // `SENSITIVE_DATA_UNCERTAIN`.
      throw new RecoveryEgressDeniedError({
        reason: denyReason,
        message: scrubSecrets(detail),
        code: MODEL_EGRESS_DENIED,
        caseId: authorization.approval.caseId,
        authorizationId: authorization.authorizationId,
      });
    }
    throw new RecoveryApprovalInvalidError(reason, scrubSecrets(detail), {
      authorizationId: authorization.authorizationId,
      caseId: authorization.approval.caseId,
    });
  }

  private invalid(
    authorization: RecoveryAuthorization,
    reason: RecoveryInvalidReason,
    message: string,
  ): RecoveryApprovalInvalidError {
    return new RecoveryApprovalInvalidError(reason, `${message} (${reason})`, {
      authorizationId: authorization.authorizationId,
      caseId: authorization.approval.caseId,
    });
  }

  private reasonForStatus(status: string): RecoveryInvalidReason {
    switch (status) {
      case "consumed":
        return "already_consumed";
      case "invalidated":
        return "already_invalidated";
      case "revoked":
        return "revoked";
      case "expired":
        return "expired";
      default:
        return "unknown_authorization";
    }
  }

  private assertIndependent(record: SecurityCase, reviewer: SecurityActor): void {
    const subjects = this.deps.cases.handlingPrincipals(record.caseId);
    const submitter = this.deps.cases.submittedBy(record.caseId);
    if (submitter !== undefined && !subjects.includes(submitter)) subjects.push(submitter);
    assertIndependentReview(this.deps.duties, {
      authorId: submitter ?? subjects[0] ?? "",
      subjectIds: subjects,
      reviewer,
      action: "recovery.approve",
      scope: requireScope(record.scope),
    });
  }

  private requireCase(caseId: string): SecurityCase {
    const record = this.deps.cases.get(caseId);
    if (!record) {
      throw new SecurityError("CASE_NOT_FOUND", `no security case ${caseId}`, { caseId });
    }
    return record;
  }

  private requireAuthorization(authorizationId: string): RecoveryAuthorization {
    requireNonEmpty(authorizationId, "authorizationId");
    const record = this.deps.authorizations.get(authorizationId);
    if (!record) {
      throw new RecoveryApprovalInvalidError(
        "unknown_authorization",
        "no such recovery authorization",
        { authorizationId },
      );
    }
    return record;
  }

  private appendCaseEvent(
    caseId: string,
    type: Parameters<SecurityCaseStore["appendEvent"]>[1],
    actor: SecurityActor,
    detail: Record<string, string | number | boolean>,
  ): void {
    try {
      this.deps.cases.appendEvent(caseId, type, actor, detail);
    } catch {
      this.incident(`recovery case-history write failed for case ${caseId}`);
    }
  }

  private async audit(
    input: Omit<RecoveryAuditRecord, "at" | "approval" | "destination"> & {
      approvalRecord: RecoveryAuthorization;
    },
  ): Promise<void> {
    const { approvalRecord, ...rest } = input;
    const approval = approvalRecord.approval;
    const record: RecoveryAuditRecord = {
      ...rest,
      at: this.timestamp(),
      approval: {
        contextRevision: approval.contextRevision,
        policyRevision: approval.policyRevision,
        rulesRevision: approval.rulesRevision,
        scanPolicyRevision: approval.scanPolicyRevision,
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        expiresAt: approvalRecord.expiresAt,
      },
      destination: {
        endpointId: approval.destination.endpointId,
        provider: approval.destination.provider,
        api: approval.destination.api,
        modelId: approval.destination.modelId,
        internal: approval.destination.internal,
      },
    };
    await this.deps.audit.record(scrubAuditRecord(record));
  }

  private async auditSafely(
    input: Omit<RecoveryAuditRecord, "at" | "approval" | "destination"> & {
      approvalRecord: RecoveryAuthorization;
    },
  ): Promise<boolean> {
    try {
      await this.audit(input);
      return true;
    } catch {
      this.incident(
        `recovery audit write failed for case ${input.approvalRecord.approval.caseId} (${input.event})`,
      );
      return false;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private incident(message: string): void {
    if (this.deps.onIncident) {
      this.deps.onIncident(scrubSecrets(message));
      return;
    }
    console.error(scrubSecrets(message));
  }
}
