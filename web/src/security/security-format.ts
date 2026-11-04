import { ApiError } from "../api/client";
import type {
  SecurityAuditEntry,
  SecurityAuditEvent,
  SecurityCaseState,
  SecurityRecoveryApproval,
  SecurityRuleConstraints,
  SecurityRuleRevision,
  SecurityRuleStatus,
} from "../api/client";

/**
 * Presentation-only vocabulary for the ADR-0005 security surface (DAT-214).
 * Nothing here decides authority: the service owns duties, separation of
 * duties, and every lifecycle edge. These helpers only render what the
 * contract already says, and keep unknown enums visible instead of guessing.
 */

export const SECURITY_CASE_STATE_LABELS: Record<SecurityCaseState, string> = {
  pending: "Pending",
  handling: "Handling",
  awaiting_review: "Awaiting review",
  resolved: "Resolved",
  terminated: "Terminated",
};

export const SECURITY_CASE_STATE_OPTIONS: Array<{ value: string; label: string }> = (
  Object.keys(SECURITY_CASE_STATE_LABELS) as SecurityCaseState[]
).map((state) => ({ value: state, label: SECURITY_CASE_STATE_LABELS[state] }));

export const SECURITY_RULE_STATUS_LABELS: Record<SecurityRuleStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Rejected",
  activated: "Activated",
  superseded: "Superseded",
  rolled_back: "Rolled back",
  expired: "Expired",
  applied: "Applied",
};

export const SECURITY_RULE_STATUS_OPTIONS: Array<{ value: string; label: string }> = (
  Object.keys(SECURITY_RULE_STATUS_LABELS) as SecurityRuleStatus[]
).map((status) => ({ value: status, label: SECURITY_RULE_STATUS_LABELS[status] }));

export const SECURITY_RULE_KIND_LABELS: Record<SecurityRuleRevision["kind"], string> = {
  correction: "Correction",
  rollback: "Rollback",
};

const EVENT_LABELS: Partial<Record<SecurityAuditEvent["event"], string>> = {
  "block.detected": "Block detected",
  "block.enforced": "Block enforced",
  "case.opened": "Case opened",
  "gateway.pre_dispatch": "Gateway pre-dispatch",
  "gateway.outcome": "Gateway outcome",
  "notification.dispatched": "Notification dispatched",
  "notification.escalated": "Notification escalated",
  "notification.undeliverable": "Notification undeliverable",
  "case.termination_requested": "Termination requested",
  "case.reassignment_requested": "Reassignment requested",
  "quarantine.sealed": "Quarantine sealed",
  "quarantine.seal_failed": "Quarantine seal failed",
  "quarantine.access_granted": "Quarantine access granted",
  "quarantine.viewed": "Quarantine viewed",
  "quarantine.access_denied": "Quarantine access denied",
  "quarantine.expired": "Quarantine expired",
  "case.handled": "Case handled",
  "case.submitted_for_review": "Submitted for review",
  "case.review_approved": "Review approved",
  "case.review_rejected": "Review rejected",
  "case.review_denied": "Review denied",
  "case.reviewer_unavailable": "Reviewer unavailable",
  "case.resolved": "Case resolved",
  "case.state_changed": "Case state changed",
  "run.dependent_work_paused": "Dependent work paused",
  "run.pause_released": "Run pause released",
  "rule.proposed": "Rule proposed",
  "rule.proposal_rejected": "Rule proposal rejected",
  "rule.review_approved": "Rule review approved",
  "rule.review_rejected": "Rule review rejected",
  "rule.review_denied": "Rule review denied",
  "rule.activated": "Rule activated",
  "rule.activation_denied": "Rule activation denied",
  "rule.superseded": "Rule superseded",
  "rule.rolled_back": "Rule rolled back",
  "rule.rollback_denied": "Rule rollback denied",
  "rule.expired": "Rule expired",
  "recovery.approval_recorded": "Recovery approval recorded",
  "recovery.approval_revoked": "Recovery approval revoked",
  "recovery.authorization_invalidated": "Recovery authorization invalidated",
  "recovery.recheck_failed": "Recovery recheck failed",
  "recovery.dispatch_denied": "Recovery dispatch denied",
  "recovery.pre_dispatch": "Recovery pre-dispatch",
  "recovery.dispatch_attempted": "Recovery dispatch attempted",
  "recovery.dispatch_outcome": "Recovery dispatch outcome",
  "recovery.reconciliation_recorded": "Recovery reconciliation recorded",
  "case.terminated": "Case terminated",
  "audit.trail_read": "Audit trail read",
  "audit.trail_exported": "Audit trail exported",
  "audit.access_denied": "Audit access denied",
};

export function securityEventLabel(event: string): string {
  return EVENT_LABELS[event as SecurityAuditEvent["event"]] ?? event;
}

export const SECURITY_EVENT_OPTIONS: Array<{ value: string; label: string }> = (
  Object.keys(EVENT_LABELS) as Array<SecurityAuditEvent["event"]>
).map((event) => ({ value: event, label: EVENT_LABELS[event] ?? event }));

export function formatSecurityTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const SECURITY_SCOPE_LABELS: Array<[keyof SecurityRecoveryApproval["scope"], string]> = [
  ["enterprise_id", "Enterprise"],
  ["workspace_id", "Workspace"],
  ["issue_id", "Issue"],
  ["run_id", "Run"],
];

/**
 * Case edges are duty-gated by the service. The label only explains what the
 * edge means, and never suggests an alternative, faster route.
 */
export function transitionLabel(from: SecurityCaseState, to: SecurityCaseState): string {
  if (to === "terminated") return "Terminate case";
  if (to === "resolved") {
    return from === "awaiting_review" ? "Approve & resolve" : "Mark resolved";
  }
  if (to === "awaiting_review") return "Submit for independent review";
  if (to === "handling") {
    return from === "awaiting_review" ? "Send back to handling" : "Start handling";
  }
  if (to === "pending") return "Return to pending";
  return `Move to ${SECURITY_CASE_STATE_LABELS[to] ?? to}`;
}

/** `awaiting_review → resolved|handling` is the independent-review decision. */
export function isReviewTransition(from: SecurityCaseState, to: SecurityCaseState): boolean {
  return from === "awaiting_review" && (to === "resolved" || to === "handling");
}

export interface SecurityErrorDescription {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  requestId?: string;
  retryAfterSeconds?: number;
  nextAction?: string | null;
  traceRef?: string;
}

/**
 * Fixed guidance per stable code. Unknown codes fall back to the service's
 * redacted envelope text: the UI never guesses which condition produced an
 * opaque failure, and never prints a secret-carrying payload.
 */
const ERROR_COPY: Record<string, string> = {
  FORBIDDEN: "Your security duty in this workspace does not permit this action.",
  SOD_DUTY_REQUIRED:
    "This action belongs to a different security duty. Handling, independent review, and policy administration are separate responsibilities.",
  SOD_SELF_REVIEW_FORBIDDEN:
    "Handling and review must be different people. Your own handling cannot be approved or rejected by you.",
  SOD_SAME_PRINCIPAL_FORBIDDEN:
    "The same principal cannot perform both sides of this decision. No role combination waives independent review.",
  SOD_HUMAN_PRINCIPAL_REQUIRED: "Only a human principal can perform this action.",
  CASE_NOT_FOUND: "This case is not visible in the current workspace scope.",
  CASE_STATE_CONFLICT:
    "The case changed since it was loaded. Refresh it before choosing another disposition.",
  CANDIDATE_CONFLICT: "The case content changed. The disposition was not applied.",
  CASE_TERMINATION_REQUEST_FORBIDDEN:
    "Only the task owner can request termination. Handler work dispositions the case.",
  CASE_REASSIGNMENT_REQUEST_FORBIDDEN: "Only the task owner can request reassignment.",
  QUARANTINE_NOT_FOUND: "This quarantined record is not visible in the current scope.",
  QUARANTINE_ACCESS_DENIED:
    "Your grant does not cover this record, or the record is outside your scope.",
  QUARANTINE_EXPIRED:
    "The quarantine retention window has expired. The raw context is no longer available.",
  QUARANTINE_ACCESS_GRANT_EXPIRED:
    "The inspection grant has expired. An administrator must issue a new scoped grant.",
  RECOVERY_APPROVAL_INVALID:
    "The recovery approval is expired, revoked, consumed, or the request context, destination, policy, or rules changed. Request a new independent review.",
  RECOVERY_CASE_NOT_REVIEWABLE:
    "The case is not awaiting independent review, so no recovery approval can be recorded.",
  RECOVERY_APPROVAL_NOT_REVOCABLE: "Only an unconsumed approval can be withdrawn.",
  SENSITIVE_DATA_UNCERTAIN:
    "The complete recheck still finds uncertain secret material. Nothing was sent; handling must continue.",
  SECURITY_REVIEW_REQUIRED:
    "The request needs an independent review before any recheck. Nothing was sent.",
  MODEL_EGRESS_DENIED:
    "The destination or authorization policy refuses this egress. Nothing was sent.",
  RULE_PROPOSAL_INVALID:
    "The proposal is incomplete or outside the contract's bounded correction fields.",
  RULE_TARGETED_EXEMPTION:
    "A rule cannot select one invocation, case, request digest, or secret value.",
  RULE_BLANKET_EXEMPTION:
    "A whole-detector disable or blanket allow is an exemption, not a false-positive correction.",
  RULE_EVIDENCE_MISSING: "The service computed no regression evidence for this proposal.",
  RULE_EVIDENCE_FAILED:
    "Regression evidence fails: true-secret detection is not preserved under this correction.",
  RULE_EVIDENCE_CHANGED:
    "The trusted corpus or rule evidence changed since review. Review must run again.",
  RULE_NOT_APPROVED: "An independent reviewer must approve the revision before activation.",
  RULE_STATE_CONFLICT: "The revision is no longer in a state that allows this decision.",
  RULE_REVISION_NOT_FOUND: "The revision is not visible in this workspace scope.",
  RULE_NOTHING_TO_ROLL_BACK: "This lineage has no active correction to roll back.",
  SECURITY_AUDIT_LOG_TAMPERED:
    "The audit hash chain failed verification. The service refuses to serve unverified evidence.",
  SECURITY_AUDIT_LOCK_TIMEOUT:
    "The audit trail is temporarily unavailable. Reads stay closed rather than returning unverified data.",
  AUDIT_QUERY_INVALID: "The audit filters are invalid. Check the stated purpose and date range.",
  AUDIT_UNAVAILABLE: "Required audit evidence could not be written, so the action was refused.",
  SCANNER_UNAVAILABLE:
    "The secret scanner is unavailable. Fail-closed policy blocks the request and any dispatch.",
  UNAUTHENTICATED: "Sign in to continue.",
  NOT_FOUND: "The requested resource is not visible in your scope.",
  CSRF_TOKEN_INVALID: "Your session changed. Reload the page and try again.",
  RATE_LIMITED: "Too many attempts. Try again later.",
};

export function describeSecurityError(caught: unknown): SecurityErrorDescription {
  if (caught instanceof ApiError) {
    const traceRef =
      typeof caught.details.trace_ref === "string" ? caught.details.trace_ref : undefined;
    return {
      code: caught.code,
      message: ERROR_COPY[caught.code] ?? caught.message,
      status: caught.status,
      retryable: caught.retryable,
      ...(caught.requestId ? { requestId: caught.requestId } : {}),
      ...(typeof caught.retryAfterSeconds === "number"
        ? { retryAfterSeconds: caught.retryAfterSeconds }
        : {}),
      nextAction: caught.nextAction ?? null,
      ...(traceRef ? { traceRef } : {}),
    };
  }
  return {
    code: "REQUEST_FAILED",
    message: caught instanceof Error ? caught.message : "The security request failed.",
    status: 0,
    retryable: false,
    nextAction: null,
  };
}

export interface RuleDiffRow {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

function showConstraint(value: number | string | undefined): string {
  return value === undefined || value === "" ? "—" : String(value);
}

function constraintRows(
  previous: SecurityRuleConstraints | undefined,
  current: SecurityRuleConstraints,
): RuleDiffRow[] {
  const fields: Array<[keyof SecurityRuleConstraints, string]> = [
    ["min_length", "Minimum length"],
    ["min_shannon_entropy", "Minimum Shannon entropy"],
    ["required_prefix", "Required prefix"],
    ["required_suffix", "Required suffix"],
  ];
  return fields.map(([field, label]) => {
    const before = showConstraint(previous?.[field]);
    const after = showConstraint(current[field]);
    return { label, before, after, changed: before !== after };
  });
}

/**
 * The reviewer-facing diff: bounded constraints against the previous revision
 * of the same lineage, plus the applicability and expiry the ADR requires.
 * Regression evidence is displayed separately because the service computes it.
 */
export function ruleDiff(
  previous: SecurityRuleRevision | undefined,
  current: SecurityRuleRevision,
): RuleDiffRow[] {
  const rows = constraintRows(previous?.constraints, current.constraints);
  rows.unshift({
    label: "Detector",
    before: previous?.detector_id ?? "—",
    after: current.detector_id,
    changed: previous !== undefined && previous.detector_id !== current.detector_id,
  });
  rows.push({
    label: "Applicability",
    before: previous ? `${previous.scope.enterprise_id} / ${previous.scope.workspace_id}` : "—",
    after: `${current.scope.enterprise_id} / ${current.scope.workspace_id}`,
    changed:
      previous !== undefined &&
      (previous.scope.enterprise_id !== current.scope.enterprise_id ||
        previous.scope.workspace_id !== current.scope.workspace_id),
  });
  rows.push({
    label: "Expires",
    before: showConstraint(previous?.expires_at),
    after: current.expires_at,
    changed: previous !== undefined && previous.expires_at !== current.expires_at,
  });
  rows.push({
    label: "Review by",
    before: showConstraint(previous?.review_at ?? undefined),
    after: showConstraint(current.review_at ?? undefined),
    changed: previous !== undefined && (previous.review_at ?? null) !== (current.review_at ?? null),
  });
  return rows;
}

/** Earlier revision of the same lineage, when it was loaded with the list. */
export function previousRevision(
  revisions: SecurityRuleRevision[],
  current: SecurityRuleRevision,
): SecurityRuleRevision | undefined {
  return revisions
    .filter((entry) => entry.lineage === current.lineage && entry.version < current.version)
    .sort((left, right) => right.version - left.version)[0];
}

/**
 * Handler identities of the current review round, derived only from the
 * append-only audit events the service returned. The latest submission marks
 * the round; handling events after the previous review decision belong to it.
 */
export function handlersInReviewRound(entries: SecurityAuditEntry[]): Set<string> {
  const ordered = [...entries].sort((left, right) => left.seq - right.seq);
  let roundStart = -1;
  let submission = -1;
  ordered.forEach((entry, index) => {
    if (entry.event.event === "case.submitted_for_review") submission = index;
    if (
      entry.event.event === "case.review_approved" ||
      entry.event.event === "case.review_rejected" ||
      entry.event.event === "case.review_denied"
    ) {
      roundStart = index;
    }
  });
  const handlers = new Set<string>();
  if (submission < 0) return handlers;
  for (let index = roundStart + 1; index <= submission; index += 1) {
    const event = ordered[index].event;
    if (event.event === "case.handled" || event.event === "case.submitted_for_review") {
      if (event.actor?.actor_id) handlers.add(event.actor.actor_id);
    }
  }
  return handlers;
}

export type IndependenceVerdict = "independent" | "self" | "unknown";

/**
 * UI-only independence check. It never grants review authority; it disables a
 * control when the caller is provably the handler of record, and fails closed
 * when the evidence needed to prove independence is unavailable.
 */
export function caseReviewIndependence(
  entries: SecurityAuditEntry[] | undefined,
  userId: string | undefined,
): IndependenceVerdict {
  if (!entries || !userId) return "unknown";
  const handlers = handlersInReviewRound(entries);
  if (handlers.size === 0) return "unknown";
  return handlers.has(userId) ? "self" : "independent";
}

export function approvalIsExpired(
  approval: Pick<SecurityRecoveryApproval, "expires_at" | "state">,
  now: number = Date.now(),
): boolean {
  if (approval.state === "expired") return true;
  const expires = new Date(approval.expires_at).getTime();
  return !Number.isNaN(expires) && expires <= now;
}

export function approvalDispatchable(
  approval: SecurityRecoveryApproval,
  now: number = Date.now(),
): boolean {
  return approval.state === "approved" && !approvalIsExpired(approval, now);
}

export function approvalStateNote(approval: SecurityRecoveryApproval, now = Date.now()): string {
  if (approvalIsExpired(approval, now) || approval.state === "expired") {
    return "Expired: this authorization can no longer dispatch. Request a new independent review.";
  }
  switch (approval.state) {
    case "approved":
      return "Approved: one recheck attempt is authorized until it expires or is consumed.";
    case "consumed":
      return "Consumed: the single authorized attempt was already used. This authorization cannot dispatch again.";
    case "invalidated":
      return "Invalidated: context, destination, policy, or rules changed after approval. Request a new review.";
    case "revoked":
      return "Revoked: an authorized principal withdrew this approval before use.";
    default:
      return approval.state_reason ?? "This authorization is not available for dispatch.";
  }
}

/** One-line per-event summary for the append-only case timeline. */
export function auditEventSummary(event: SecurityAuditEvent): string {
  const parts: string[] = [];
  if (event.actor) {
    parts.push(
      event.actor.role ? `${event.actor.actor_id} · ${event.actor.role}` : event.actor.actor_id,
    );
  }
  parts.push(event.result);
  if (event.reason) parts.push(event.reason);
  return parts.join(" · ");
}

export type SecurityTone = "active" | "attention" | "danger" | "done" | "muted" | "unknown";

export const SECURITY_CASE_STATE_TONES: Record<SecurityCaseState, SecurityTone> = {
  pending: "attention",
  handling: "active",
  awaiting_review: "attention",
  resolved: "done",
  terminated: "muted",
};

export const SECURITY_RULE_STATUS_TONES: Record<SecurityRuleStatus, SecurityTone> = {
  proposed: "attention",
  approved: "attention",
  rejected: "danger",
  activated: "done",
  superseded: "muted",
  rolled_back: "muted",
  expired: "muted",
  applied: "done",
};
