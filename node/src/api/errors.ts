import type { DshError } from "../dsh/client.js";
import type { ControlPlaneError } from "../control-plane/errors.js";
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  PreconditionFailedError,
  RequestScopeError,
  ValidationError,
  VersionConflictError,
} from "../control-plane/errors.js";

/**
 * forgepilot-api/v1 shared error envelope (version 1).
 *
 * The envelope is the one error shape every endpoint serves, aligned with the
 * ADR-0008 / DAT-226 shared error contract: a versioned envelope with a
 * stable machine code, the processing stage, the outcome category, a safe
 * user message, service-decided retryability, retry-after where applicable,
 * a trace/case reference (`request_id`), safe structured details, and the
 * authorized next action. Display text may be localized; machine codes never
 * change meaning. Secrets, credentials, invitation tokens, and sensitive
 * diagnostics never appear in any field (ADR-0008).
 */
export const ERROR_ENVELOPE_VERSION = 1;

/** Where processing rejected the request. */
export const ERROR_STAGES = [
  "auth",
  "validation",
  "authorization",
  "policy",
  "execution",
  "delivery",
  "reconciliation",
  "unknown",
] as const;
export type ErrorStage = (typeof ERROR_STAGES)[number];

/**
 * What the outcome means for the caller: `denial` (refused by authority or
 * policy; do not retry), `stop` (fix the request or state; do not retry),
 * `retry` (a retry may succeed within limits), `unknown` (the outcome is not
 * known; reconcile before further writes).
 */
export const ERROR_CATEGORIES = ["denial", "stop", "retry", "unknown"] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * The authorized next action, as a machine code. Additive vocabulary: a
 * client renders an unknown action as generic guidance from `message`.
 */
export const ERROR_NEXT_ACTIONS = [
  "reauthenticate",
  "refresh",
  "retry",
  "resubmit",
  "reconcile",
  "request_review",
  "request_new_invitation",
  "contact_admin",
  /**
   * Open or open the authenticated security case this invocation belongs to
   * (ADR-0005). It is the only next action for uncertain sensitive data: it
   * never authorizes resending the blocked request.
   */
  "enter_security_case",
] as const;
export type ErrorNextAction = (typeof ERROR_NEXT_ACTIONS)[number];

/** forgepilot-api/v1 error envelope (version 1). */
export interface ApiErrorBody {
  error: {
    /** Envelope format version; this contract serves 1. */
    envelope_version: number;
    /** Stable machine code; never localized, never re-mapped. */
    code: string;
    stage: ErrorStage;
    category: ErrorCategory;
    /** Safe user-facing message; localizable without changing `code`. */
    message: string;
    /** Whether the service judges a retry of the same request eligible. */
    retryable: boolean;
    /** Seconds to wait before a retry; null when not applicable. */
    retry_after_seconds: number | null;
    /** Trace/case reference to quote in support and security cases. */
    request_id: string;
    /**
     * Authenticated security-case identifier, when the failure belongs to one
     * (ADR-0005 §6). A correlation handle only: possessing it authorizes
     * nothing and it is never a credential to view quarantined content.
     */
    case_ref?: string | null;
    /** Trace identifier for correlation, when one exists. */
    trace_ref?: string | null;
    /** Safe structured context only; never secrets or raw sensitive data. */
    details: Record<string, unknown>;
    /** The authorized next action; null when no action applies. */
    next_action: ErrorNextAction | null;
  };
}

/** Per-instance overrides for the code's default semantics. */
export interface ApiErrorOverrides {
  retryable?: boolean;
  retry_after_seconds?: number | null;
  stage?: ErrorStage;
  category?: ErrorCategory;
  next_action?: ErrorNextAction | null;
  /** Authenticated security-case identifier for this failure, when it has one. */
  case_ref?: string | null;
  /** Trace identifier for this failure, when one exists. */
  trace_ref?: string | null;
}

interface ErrorSemantics {
  stage: ErrorStage;
  category: ErrorCategory;
  retryable: boolean;
  next_action: ErrorNextAction | null;
}

/**
 * Default envelope semantics per stable machine code. The service — never a
 * model or a client — owns retry eligibility; a policy denial is never
 * rewritten as a generic server error. Codes not listed here fail closed as
 * `unknown`/`unknown` with `contact_admin`.
 */
const ERROR_SEMANTICS: Record<string, ErrorSemantics> = {
  INVALID_REQUEST: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "resubmit",
  },
  INVALID_CURSOR: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "resubmit",
  },
  UNAUTHENTICATED: {
    stage: "auth",
    category: "denial",
    retryable: false,
    next_action: "reauthenticate",
  },
  FORBIDDEN: {
    stage: "authorization",
    category: "denial",
    retryable: false,
    next_action: "contact_admin",
  },
  ACCOUNT_SUSPENDED: {
    stage: "auth",
    category: "denial",
    retryable: false,
    next_action: "contact_admin",
  },
  SCOPE_MISSING: {
    stage: "authorization",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  SCOPE_AMBIGUOUS: {
    stage: "authorization",
    category: "stop",
    retryable: false,
    next_action: "contact_admin",
  },
  SCOPE_CROSS_TENANT: {
    stage: "authorization",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  CSRF_TOKEN_INVALID: { stage: "auth", category: "stop", retryable: false, next_action: "refresh" },
  NOT_FOUND: { stage: "validation", category: "stop", retryable: false, next_action: null },
  TASK_NOT_FOUND: { stage: "validation", category: "stop", retryable: false, next_action: null },
  TASK_STATE_CONFLICT: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  VERSION_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  INVALID_TRANSITION: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  PRECONDITION_FAILED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  IDEMPOTENCY_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "resubmit",
  },
  WORKSPACE_REPOSITORY_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: null,
  },
  MEMBERSHIP_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: null,
  },
  TEAM_LEADER_NOT_MEMBER: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "resubmit",
  },
  ROLE_NOT_ASSIGNABLE: {
    stage: "authorization",
    category: "denial",
    retryable: false,
    next_action: "contact_admin",
  },
  INVITATION_NOT_ACCEPTED: {
    stage: "authorization",
    category: "denial",
    retryable: false,
    next_action: "request_new_invitation",
  },
  PROVIDER_ROSTER_INCOMPLETE: {
    stage: "reconciliation",
    category: "retry",
    retryable: true,
    next_action: "retry",
  },
  AUTHORITY_RECHECK_REQUIRED: {
    stage: "reconciliation",
    category: "stop",
    retryable: false,
    next_action: "reconcile",
  },
  CONFLICT: { stage: "validation", category: "stop", retryable: false, next_action: "refresh" },
  AUTH_FLOW_CONSUMED: {
    stage: "auth",
    category: "stop",
    retryable: false,
    next_action: "reauthenticate",
  },
  AUTH_FLOW_EXPIRED: {
    stage: "auth",
    category: "stop",
    retryable: false,
    next_action: "reauthenticate",
  },
  AUTH_FLOW_INVALID: {
    stage: "auth",
    category: "denial",
    retryable: false,
    next_action: "reauthenticate",
  },
  AUTH_FLOW_NOT_READY: {
    stage: "auth",
    category: "stop",
    retryable: false,
    next_action: "retry",
  },
  BOOTSTRAP_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "contact_admin",
  },
  BOOTSTRAP_UNAVAILABLE: {
    stage: "auth",
    category: "retry",
    retryable: true,
    next_action: "retry",
  },
  PROVIDER_ERROR: { stage: "auth", category: "retry", retryable: true, next_action: "retry" },
  PROVIDER_ORIGIN_REJECTED: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "contact_admin",
  },
  // Stable ADR-0005 security codes (DAT-213). Every one is a non-retryable
  // denial/stop: none of them authorizes resending the blocked request, and
  // none names the policy internals behind the decision.
  MODEL_EGRESS_DENIED: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  SENSITIVE_DATA_UNCERTAIN: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "enter_security_case",
  },
  SECURITY_REVIEW_REQUIRED: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  RECOVERY_APPROVAL_INVALID: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  RATE_LIMITED: { stage: "execution", category: "retry", retryable: true, next_action: "retry" },
  INTERNAL_ERROR: {
    stage: "unknown",
    category: "unknown",
    retryable: false,
    next_action: "contact_admin",
  },
  PI_UNAVAILABLE: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "contact_admin",
  },
  DSH_UNAVAILABLE: { stage: "execution", category: "retry", retryable: true, next_action: "retry" },
  DSH_SCOPE_DENIED: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  DSH_POLICY_DENIED: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  DSH_GRANT_EXPIRED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "request_review",
  },
  DSH_RISK_PROHIBITED: {
    stage: "policy",
    category: "denial",
    retryable: false,
    next_action: "request_review",
  },
  DSH_APPROVAL_REQUIRED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "request_review",
  },

  // Collaboration v1 (DAT-221, ADR-0007). A deny-by-default domain outcome is
  // a `stop` — never retried with the same intent — and the two outcomes the
  // contract singles out are explicit: `needs_human` stops are `stop` with
  // `request_review` (human disposition required before any continuation),
  // and `unknown` provider outcomes are `unknown` with `reconcile` (never
  // auto-retried, never guessed).
  ISSUE_NOT_FOUND: { stage: "validation", category: "stop", retryable: false, next_action: null },
  RUN_NOT_FOUND: { stage: "validation", category: "stop", retryable: false, next_action: null },
  CANDIDATE_NOT_FOUND: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: null,
  },
  TEST_POLICY_NOT_FOUND: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  TEST_POLICY_CONFLICT: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  TEST_PLAN_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  CANDIDATE_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  CANDIDATE_INVALID: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  BASE_ADVANCED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  APPROVAL_NOT_FOUND: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: null,
  },
  DELIVERY_NOT_FOUND: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: null,
  },
  ISSUE_DEDUPE_CONFLICT: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  TRANSITION_FORBIDDEN: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  PRODUCT_HARNESS_CONFLICT: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  RUN_OPEN_FORBIDDEN: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  TASK_BLOCKED: { stage: "execution", category: "stop", retryable: false, next_action: "refresh" },
  TASK_DEPENDENCY_INVALID: {
    stage: "validation",
    category: "stop",
    retryable: false,
    next_action: "resubmit",
  },
  DISPOSITION_REQUIRED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "request_review",
  },
  APPROVAL_REQUIRED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "request_review",
  },
  APPROVAL_NOT_APPROVED: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "request_review",
  },
  APPROVAL_CONSUMED: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "reconcile",
  },
  APPROVAL_BINDING_STALE: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  APPROVAL_STATE_CONFLICT: {
    stage: "execution",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  APPROVAL_ALREADY_PENDING: {
    stage: "policy",
    category: "stop",
    retryable: false,
    next_action: "request_review",
  },
  APPROVER_NOT_AUTHORIZED: {
    stage: "authorization",
    category: "denial",
    retryable: false,
    next_action: "contact_admin",
  },
  DELIVERY_FORBIDDEN: {
    stage: "delivery",
    category: "denial",
    retryable: false,
    next_action: "contact_admin",
  },
  DELIVERY_AUDIT_UNAVAILABLE: {
    stage: "delivery",
    category: "stop",
    retryable: false,
    next_action: "contact_admin",
  },
  DELIVERY_STATE_CONFLICT: {
    stage: "delivery",
    category: "stop",
    retryable: false,
    next_action: "refresh",
  },
  DELIVERY_OUTCOME_UNKNOWN: {
    stage: "delivery",
    category: "unknown",
    retryable: false,
    next_action: "reconcile",
  },
};

const UNKNOWN_SEMANTICS: ErrorSemantics = {
  stage: "unknown",
  category: "unknown",
  retryable: false,
  next_action: "contact_admin",
};

/** An error that renders as the contract's shared error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly stage: ErrorStage;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly details: Record<string, unknown>;
  readonly nextAction: ErrorNextAction | null;
  readonly caseRef: string | null;
  readonly traceRef: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    overrides: ApiErrorOverrides = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    const defaults = ERROR_SEMANTICS[code] ?? UNKNOWN_SEMANTICS;
    this.stage = overrides.stage ?? defaults.stage;
    this.category = overrides.category ?? defaults.category;
    this.retryable = overrides.retryable ?? defaults.retryable;
    this.retryAfterSeconds = overrides.retry_after_seconds ?? null;
    this.details = details;
    this.nextAction =
      overrides.next_action === undefined ? defaults.next_action : overrides.next_action;
    this.caseRef = overrides.case_ref ?? null;
    this.traceRef = overrides.trace_ref ?? null;
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        envelope_version: ERROR_ENVELOPE_VERSION,
        code: this.code,
        stage: this.stage,
        category: this.category,
        message: this.message,
        retryable: this.retryable,
        retry_after_seconds: this.retryAfterSeconds,
        request_id: requestId,
        case_ref: this.caseRef,
        trace_ref: this.traceRef,
        details: this.details,
        next_action: this.nextAction,
      },
    };
  }
}

/**
 * Translate a control-plane domain failure into the product API's error
 * envelope without leaking storage internals.
 */
export function apiErrorFromControlPlane(error: ControlPlaneError): ApiError {
  if (error instanceof NotFoundError) {
    return new ApiError(404, "NOT_FOUND", error.message);
  }
  if (error instanceof ConflictError) {
    return new ApiError(409, "CONFLICT", error.message, error.details);
  }
  if (error instanceof VersionConflictError) {
    return new ApiError(409, "VERSION_CONFLICT", error.message);
  }
  if (error instanceof InvalidTransitionError) {
    return new ApiError(409, "INVALID_TRANSITION", error.message, error.details);
  }
  if (error instanceof PreconditionFailedError) {
    return new ApiError(409, "PRECONDITION_FAILED", error.message, error.details);
  }
  if (error instanceof ForbiddenError) {
    return new ApiError(403, "FORBIDDEN", error.message);
  }
  if (error instanceof ValidationError) {
    return new ApiError(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof RequestScopeError) {
    // Scope failures carry their own 401/403 semantics and stable codes;
    // flattening them into a generic FORBIDDEN would lose the 401 cases.
    return new ApiError(error.status, error.code, error.message);
  }
  return new ApiError(403, "FORBIDDEN", error.message);
}

/**
 * Fixed safe client-visible messages for dsh-mapped failures. A dsh error's
 * own message and details can carry internal diagnostics — Go error strings,
 * raw non-contract response fragments, downstream paths — so the HTTP
 * envelope never echoes them (ADR-0008: no raw provider or downstream error
 * text in messages or details).
 */
export const DSH_SAFE_MESSAGES = {
  INVALID_REQUEST: "The request was rejected by the execution control plane.",
  POLICY_DENIED: "The action was denied by execution policy.",
  FORBIDDEN: "The action was refused by the execution control plane.",
  TASK_NOT_FOUND: "The task was not found in your visible scope.",
  TASK_STATE_CONFLICT: "The task is not in a state that allows this action.",
  DSH_GRANT_EXPIRED: "The execution grant expired before the action could run.",
  DSH_RISK_PROHIBITED: "The work was rejected by risk policy.",
  DSH_APPROVAL_REQUIRED: "The action requires human approval before it can run.",
  RATE_LIMITED: "Too many requests. Try again later.",
  DSH_UNAVAILABLE: "The execution control plane is temporarily unavailable.",
  INTERNAL_ERROR: "The execution control plane reported an unexpected failure.",
} as const;

/**
 * Translate a dsh-control/v1 failure into the product API's error vocabulary.
 *
 * Node maps dsh policy outcomes without exposing dsh internals. Only the
 * stable origin code crosses into the client-visible envelope (in
 * `details.dsh_code` for audit correlation); the message is the fixed safe
 * text above and dsh's own message/details never leave this function. The
 * code registry supplies the stage, category, retryability, and next action.
 */
export function apiErrorFromDsh(error: DshError): ApiError {
  const details = { dsh_code: error.code };
  switch (error.status) {
    case 400:
      return new ApiError(400, "INVALID_REQUEST", DSH_SAFE_MESSAGES.INVALID_REQUEST, details);
    case 403:
      if (error.code === "DSH_SCOPE_DENIED" || error.code === "DSH_POLICY_DENIED") {
        return new ApiError(403, error.code, DSH_SAFE_MESSAGES.POLICY_DENIED, details);
      }
      return new ApiError(403, "FORBIDDEN", DSH_SAFE_MESSAGES.FORBIDDEN, details);
    case 404:
      return new ApiError(404, "TASK_NOT_FOUND", DSH_SAFE_MESSAGES.TASK_NOT_FOUND, details);
    case 409:
      return new ApiError(
        409,
        "TASK_STATE_CONFLICT",
        DSH_SAFE_MESSAGES.TASK_STATE_CONFLICT,
        details,
      );
    case 410:
      return new ApiError(410, "DSH_GRANT_EXPIRED", DSH_SAFE_MESSAGES.DSH_GRANT_EXPIRED, details);
    case 422:
      return new ApiError(
        422,
        "DSH_RISK_PROHIBITED",
        DSH_SAFE_MESSAGES.DSH_RISK_PROHIBITED,
        details,
      );
    case 428:
      return new ApiError(
        428,
        "DSH_APPROVAL_REQUIRED",
        DSH_SAFE_MESSAGES.DSH_APPROVAL_REQUIRED,
        details,
      );
    case 429:
      return new ApiError(429, "RATE_LIMITED", DSH_SAFE_MESSAGES.RATE_LIMITED, details);
    case 503:
      return new ApiError(503, "DSH_UNAVAILABLE", DSH_SAFE_MESSAGES.DSH_UNAVAILABLE, details);
    default:
      return new ApiError(500, "INTERNAL_ERROR", DSH_SAFE_MESSAGES.INTERNAL_ERROR, details);
  }
}
