/**
 * Domain-event adapters for the unified security audit trail (DAT-213).
 *
 * Each security subsystem already produces its own typed, append-only event
 * (case history, rule history, recovery audit record, gateway attempt). This
 * module maps them onto {@link SecurityAuditEvent} without losing the
 * distinction ADR-0005 §6 demands: an approval is not a dispatch, a block is
 * not a case transition, and a read is not an access grant. Mapping is pure
 * and non-secret: only identifiers, codes, versions, counters, and scrubbed
 * text cross over.
 */

import type { GatewayAttemptEvent, GatewayEventSink } from "../gateway/types.js";
import type { CaseEvent, SecurityCase } from "./types.js";
import type { RecoveryAuditRecord } from "./recovery-audit.js";
import type { RecoveryAuditSink } from "./recovery-audit.js";
import type { RuleEvent } from "./rules.js";
import type {
  SecurityAuditActor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditResult,
  SecurityAuditScanEvidence,
  SecurityAuditTrail,
} from "./audit.js";

function stringDetail(
  detail: Record<string, string | number | boolean>,
  key: string,
): string | null {
  const value = detail[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function actorOf(actor: CaseEvent["actor"], role: string | null): SecurityAuditActor | null {
  if (!actor) return null;
  return {
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    role,
    independentOf: null,
  };
}

/**
 * Case history event -> unified audit event. State edges are expanded into the
 * distinct handling events ADR-0005 names: pending→handling is handling,
 * handling→awaiting_review is submission, awaiting_review→resolved is
 * resolution, and any →terminated is termination.
 */
export function auditEventFromCaseEvent(
  record: SecurityCase,
  event: CaseEvent,
): SecurityAuditEvent {
  const type = caseAuditEventType(event);
  const actor = actorOf(
    event.actor,
    type.startsWith("case.review")
      ? "independent_reviewer"
      : type.startsWith("case.handled") || type === "case.submitted_for_review"
        ? "security_handler"
        : null,
  );
  const review =
    type === "case.review_approved" || type === "case.review_rejected"
      ? {
          reviewerId: stringDetail(event.detail, "reviewer") ?? event.actor?.actorId ?? "",
          independent: true,
        }
      : null;
  return {
    event: type,
    scope: {
      enterpriseId: record.scope.enterpriseId,
      workspaceId: record.scope.workspaceId,
      issueId: record.scope.issueId,
      runId: record.scope.runId,
    },
    caseId: record.caseId,
    invocationId: stringDetail(event.detail, "invocationId"),
    traceId: stringDetail(event.detail, "traceId"),
    actor,
    action: event.type,
    reason:
      stringDetail(event.detail, "reason") ??
      stringDetail(event.detail, "code") ??
      stringDetail(event.detail, "detail"),
    result: caseAuditResult(event),
    review: review && review.reviewerId.length > 0 ? review : null,
    destination: null,
    dataClasses: [],
    protectedRefs: [],
    policyRevision: null,
    rulesRevision: null,
    detectorVersion: null,
    redactionVersion: null,
    scan: null,
    authorization:
      stringDetail(event.detail, "authorizationId") === null
        ? null
        : {
            authorizationId: stringDetail(event.detail, "authorizationId") as string,
            state: event.type,
            expiresAt: stringDetail(event.detail, "expiresAt"),
            consumedAt: null,
          },
    link: null,
    detail: { ...event.detail },
  };
}

function caseAuditEventType(event: CaseEvent): SecurityAuditEventType {
  switch (event.type) {
    case "case.opened":
      return "case.opened";
    case "block.recorded":
      return "block.detected";
    case "case.state_changed": {
      const from = stringDetail(event.detail, "from");
      const to = stringDetail(event.detail, "to");
      if (to === "terminated") return "case.terminated";
      if (to === "resolved") return "case.resolved";
      if (to === "awaiting_review") return "case.submitted_for_review";
      if (to === "handling" && from === "pending") return "case.handled";
      return "case.state_changed";
    }
    case "notification.dispatched":
    case "notification.escalated":
    case "notification.undeliverable":
    case "quarantine.sealed":
    case "quarantine.seal_failed":
    case "quarantine.access_granted":
    case "quarantine.expired":
    case "case.review_approved":
    case "case.review_rejected":
    case "case.review_denied":
    case "case.reviewer_unavailable":
    case "case.termination_requested":
    case "case.reassignment_requested":
    case "run.dependent_work_paused":
    case "run.pause_released":
      return event.type;
    case "quarantine.accessed":
      return "quarantine.viewed";
    case "quarantine.access_denied":
      return "quarantine.access_denied";
    case "recovery.approved":
      return "recovery.approval_recorded";
    case "recovery.invalidated":
      return "recovery.authorization_invalidated";
    case "recovery.dispatch_attempted":
      return "recovery.dispatch_attempted";
    case "recovery.dispatched":
      return "recovery.dispatch_outcome";
    case "recovery.dispatch_failed":
      return "recovery.dispatch_outcome";
    case "recovery.dispatch_unknown":
      return "recovery.dispatch_outcome";
    default:
      return event.type;
  }
}

function caseAuditResult(event: CaseEvent): SecurityAuditResult {
  switch (event.type) {
    case "case.review_denied":
    case "quarantine.access_denied":
      return "denied";
    case "notification.undeliverable":
    case "quarantine.seal_failed":
    case "recovery.dispatch_failed":
      return "failed";
    case "recovery.dispatch_unknown":
      return "unknown";
    case "quarantine.accessed":
    case "quarantine.access_granted":
    case "notification.dispatched":
    case "notification.escalated":
    case "recovery.approved":
    case "recovery.dispatched":
      return "succeeded";
    default:
      return "recorded";
  }
}

/**
 * Rule history event -> unified audit event. The lineage encodes
 * `detector|enterprise|workspace`; an unattributed malformed proposal has no
 * derivable scope and is recorded with null scope rather than dropped.
 */
export function auditEventFromRuleEvent(event: RuleEvent): SecurityAuditEvent {
  const parts = event.lineage.split("|");
  const attributed = parts.length === 3;
  const actor: SecurityAuditActor | null = event.actor
    ? {
        actorId: event.actor.principalId,
        actorKind: "human",
        role: event.actor.duty.length > 0 ? event.actor.duty : null,
        independentOf: null,
      }
    : null;
  return {
    event: event.type,
    scope: {
      enterpriseId: attributed ? (parts[1] as string) : null,
      workspaceId: attributed ? (parts[2] as string) : null,
      issueId: null,
      runId: null,
    },
    caseId: null,
    invocationId: null,
    traceId: null,
    actor,
    action: event.type,
    reason: stringDetail(event.detail, "reason") ?? stringDetail(event.detail, "code"),
    result: ruleAuditResult(event.type),
    review:
      event.type === "rule.review_approved" || event.type === "rule.review_rejected"
        ? {
            reviewerId: stringDetail(event.detail, "reviewerId") ?? event.actor?.principalId ?? "",
            independent: true,
          }
        : null,
    destination: null,
    dataClasses: [],
    protectedRefs: [],
    policyRevision: null,
    rulesRevision: stringDetail(event.detail, "version"),
    detectorVersion: stringDetail(event.detail, "detectorId"),
    redactionVersion: null,
    scan: null,
    authorization: null,
    link: null,
    detail: { ...event.detail },
  };
}

function ruleAuditResult(type: RuleEvent["type"]): SecurityAuditResult {
  switch (type) {
    case "rule.proposal_rejected":
    case "rule.review_rejected":
    case "rule.review_denied":
    case "rule.activation_denied":
    case "rule.rollback_denied":
      return "denied";
    case "rule.activated":
    case "rule.rolled_back":
    case "rule.superseded":
      return "succeeded";
    default:
      return "recorded";
  }
}

function scanEvidence(evidence: RecoveryAuditRecord["scan"]): SecurityAuditScanEvidence | null {
  if (evidence === null) return null;
  return {
    scanner: evidence.scanner,
    ruleVersion: evidence.ruleVersion,
    classification: evidence.classification,
    segments: evidence.segments,
    dataClasses: [...evidence.dataClasses],
    findingCounts: { ...evidence.findingCounts },
    detectors: [...evidence.detectors],
    derivedSegments: evidence.derivedSegments,
  };
}

function recoveryAuditResult(record: RecoveryAuditRecord): SecurityAuditResult {
  switch (record.outcome) {
    case "approved":
      return "recorded";
    case "dispatched":
      return "succeeded";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
    default:
      return record.event.endsWith("_denied") ? "denied" : "recorded";
  }
}

/** Recovery audit record -> unified audit event. */
export function auditEventFromRecoveryRecord(record: RecoveryAuditRecord): SecurityAuditEvent {
  const review =
    record.event === "recovery.approval_recorded"
      ? { reviewerId: record.approval.approvedBy, independent: true }
      : null;
  return {
    event: record.event,
    scope: {
      enterpriseId: record.scope.enterpriseId,
      workspaceId: record.scope.workspaceId,
      issueId: record.scope.issueId,
      runId: record.scope.runId,
    },
    caseId: record.caseId,
    invocationId: record.invocationId,
    traceId: record.traceId,
    actor: record.actor
      ? {
          actorId: record.actor.actorId,
          actorKind: record.actor.actorKind,
          role: null,
          independentOf: null,
        }
      : null,
    action: record.event,
    reason: record.reason,
    result: recoveryAuditResult(record),
    review: review && review.reviewerId.length > 0 ? review : null,
    destination: {
      endpointId: record.destination.endpointId,
      provider: record.destination.provider,
      modelId: record.destination.modelId,
      internal: record.destination.internal,
    },
    dataClasses: [],
    protectedRefs: record.requestDigest === null ? [] : [record.requestDigest],
    policyRevision: record.approval.policyRevision,
    rulesRevision: record.approval.rulesRevision,
    detectorVersion: record.approval.scanPolicyRevision,
    redactionVersion: null,
    scan: scanEvidence(record.scan),
    authorization: {
      authorizationId: record.authorizationId,
      state: record.event,
      expiresAt: record.approval.expiresAt,
      consumedAt: record.event === "recovery.dispatch_attempted" ? record.at : null,
    },
    link:
      record.event === "recovery.dispatch_attempted" || record.event === "recovery.dispatch_outcome"
        ? { blockEventId: null, dispatchEventId: record.invocationId }
        : null,
    detail: { ...record.detail },
  };
}

/**
 * Recovery's required durable sink, backed by the unified trail: every
 * approval, recheck, attempt, and outcome lands in the one security log. The
 * trail's durability marker propagates, so a test trail is still refused by
 * the recovery service without the explicit test opt-in.
 */
export function createSecurityAuditRecoverySink(trail: SecurityAuditTrail): RecoveryAuditSink {
  return {
    durability: trail.durability,
    record(record: RecoveryAuditRecord): void {
      trail.record(auditEventFromRecoveryRecord(record));
    },
  };
}

/**
 * Gateway attempt sink adapter: pre-dispatch evidence and outcomes join the
 * security trail, and a denied attempt is recorded as an enforced block. The
 * gateway's own sink remains the authority for its fail-closed behavior; this
 * adapter must therefore never be the only sink.
 */
export function createSecurityAuditGatewaySink(trail: SecurityAuditTrail): GatewayEventSink {
  return {
    record(attempt: GatewayAttemptEvent): void {
      trail.record(auditEventFromGatewayAttempt(attempt));
    },
  };
}

/** Gateway attempt event -> unified audit event. */
export function auditEventFromGatewayAttempt(attempt: GatewayAttemptEvent): SecurityAuditEvent {
  const identity = attempt.identity;
  const scope = {
    enterpriseId: identity.enterpriseId,
    workspaceId: identity.workspaceId,
    issueId: identity.issueId,
    runId: identity.runId,
  };
  if (attempt.phase === "pre_dispatch") {
    return {
      event: "gateway.pre_dispatch",
      scope,
      caseId: null,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      actor: { actorId: identity.runId, actorKind: "run", role: null, independentOf: null },
      action: "gateway.pre_dispatch",
      reason: null,
      result: "recorded",
      review: null,
      destination: { ...attempt.destination },
      dataClasses: [...attempt.scan.dataClasses],
      protectedRefs: [],
      policyRevision: attempt.policyRevision,
      rulesRevision: attempt.scan.ruleVersion,
      detectorVersion: attempt.scan.scanner,
      redactionVersion: null,
      scan: {
        scanner: attempt.scan.scanner,
        ruleVersion: attempt.scan.ruleVersion,
        classification: attempt.scan.classification,
        segments: attempt.scan.segments,
        dataClasses: [...attempt.scan.dataClasses],
        findingCounts: { ...attempt.scan.findingCounts },
        detectors: [...attempt.scan.detectors],
        derivedSegments: attempt.scan.derivedSegments,
      },
      authorization: null,
      link: null,
      detail: { attempt: attempt.attempt },
    };
  }
  const denied = attempt.outcome === "denied";
  return {
    event: denied ? "block.enforced" : "gateway.outcome",
    scope,
    caseId: null,
    invocationId: identity.invocationId,
    traceId: identity.traceId,
    actor: { actorId: identity.runId, actorKind: "run", role: null, independentOf: null },
    action: "gateway.outcome",
    reason: attempt.denyReason ?? attempt.detail ?? null,
    result:
      attempt.outcome === "dispatched"
        ? "succeeded"
        : attempt.outcome === "denied"
          ? "denied"
          : "failed",
    review: null,
    destination: attempt.destination === null ? null : { ...attempt.destination },
    dataClasses: attempt.scan === undefined ? [] : [...attempt.scan.dataClasses],
    protectedRefs: [],
    policyRevision: attempt.policyRevision,
    rulesRevision: attempt.scan?.ruleVersion ?? null,
    detectorVersion: attempt.scan?.scanner ?? null,
    redactionVersion: null,
    scan: scanEvidence(attempt.scan ?? null),
    authorization: null,
    link: null,
    detail: {
      attempt: attempt.attempt,
      ...(attempt.denyReason !== undefined ? { denyReason: attempt.denyReason } : {}),
    },
  };
}
