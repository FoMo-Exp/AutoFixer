import type { DshError } from "../dsh/client.js";

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
        details: this.details,
        next_action: this.nextAction,
      },
    };
  }
}

/**
 * Translate a dsh-control/v1 failure into the product API's error vocabulary.
 *
 * Node maps dsh policy outcomes without exposing dsh internals: the contract
 * codes the v1 error model allows, with the originating dsh code preserved in
 * `details.dsh_code` for audit correlation. The code registry supplies the
 * stage, category, retryability, and next action.
 */
export function apiErrorFromDsh(error: DshError): ApiError {
  const details = { ...error.details, dsh_code: error.code };
  switch (error.status) {
    case 400:
      return new ApiError(400, "INVALID_REQUEST", error.message, details);
    case 403:
      if (error.code === "DSH_SCOPE_DENIED" || error.code === "DSH_POLICY_DENIED") {
        return new ApiError(403, error.code, error.message, details);
      }
      return new ApiError(403, "FORBIDDEN", error.message, details);
    case 404:
      return new ApiError(404, "TASK_NOT_FOUND", error.message, details);
    case 409:
      return new ApiError(409, "TASK_STATE_CONFLICT", error.message, details);
    case 410:
      return new ApiError(410, "DSH_GRANT_EXPIRED", error.message, details);
    case 422:
      return new ApiError(422, "DSH_RISK_PROHIBITED", error.message, details);
    case 428:
      return new ApiError(428, "DSH_APPROVAL_REQUIRED", error.message, details);
    case 429:
      return new ApiError(429, "RATE_LIMITED", error.message, details);
    case 503:
      return new ApiError(503, "DSH_UNAVAILABLE", error.message, details);
    default:
      return new ApiError(500, "INTERNAL_ERROR", error.message, details);
  }
}
