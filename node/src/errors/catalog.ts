/**
 * Closed error vocabulary shared by every AutoFixer surface (DAT-226).
 *
 * The catalog is the authority for what an error means: its stage, its
 * outcome category, whether the service ever retries it, and which single
 * next action is authorized. Surface code (dsh, gateway, trace) maps into
 * this vocabulary; nothing maps out of it into a "generic 500" — a policy
 * denial stays a denial end to end.
 *
 * Safety rules encoded here:
 * - Texts are catalog-authored and safe: they name the denied capability
 *   category or the failed step, never secrets and never policy internals.
 * - Display text is localizable through its stable `*_key`; the machine code
 *   and the authorized `next_action` never change with a translation.
 * - No entry and no `NextAction` widens a capability grant. Denials are
 *   terminal for the intent; only a human review can change a grant.
 */

export const ERROR_STAGES = [
  "request",
  "transport",
  "gateway",
  "policy",
  "tool",
  "validation",
  "sandbox",
  "usage",
  "delivery",
  "harness",
  "service",
] as const;

export type ErrorStage = (typeof ERROR_STAGES)[number];

/**
 * Outcome classes (ADR-0008 implementation acceptance 3):
 * - `denial` — refused on policy/authorization grounds; never retried with
 *   the same intent, never bypassed, never widened.
 * - `stop` — the current run cannot continue as-is; stop and preserve
 *   evidence instead of retrying.
 * - `retry` — a bounded retry is authorized under service-enforced limits.
 * - `unknown` — the outcome or side effects are not known; reconcile before
 *   any further write. Never auto-retried.
 */
export const ERROR_CATEGORIES = ["denial", "stop", "retry", "unknown"] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * The closed set of authorized next actions. Every action is either neutral
 * or narrowing: there is deliberately no action that retries with more scope,
 * widens a grant, or bypasses a policy decision.
 */
export const NEXT_ACTIONS = [
  /** Retry after `retry_after_ms`, within service-enforced limits. */
  "wait_and_retry",
  /** Retry now, within service-enforced attempt/time limits. */
  "retry_bounded",
  /** Stop the current run and preserve its evidence. */
  "stop_run",
  /** Correct the request or intent and submit it again. */
  "refine_request",
  /** Re-read the authoritative state before acting again. */
  "refresh_state",
  /** Ask a human to review the denial or decide the disposition. */
  "request_review",
  /** Reconcile metering; keep estimates provisional until then. */
  "reconcile_usage",
  /** Reconcile the existing delivery operation before further writes. */
  "reconcile_delivery",
  /** Do not execute; an operator must restore the infrastructure first. */
  "block_execution",
  /** Open an authenticated security case (ADR-0005). */
  "enter_security_case",
  /** Surface the trace reference to an operator. */
  "report_error",
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

/**
 * Denied capability categories surfaced to humans and agents. This is the
 * category of capability that was refused — not the policy that refused it.
 */
export const DENIED_CAPABILITIES = [
  "tool",
  "arguments",
  "path_scope",
  "network",
  "grant",
  "run_state",
  "policy",
] as const;

export type DeniedCapability = (typeof DENIED_CAPABILITIES)[number];

/**
 * Service retry policy per code:
 * - `never` — the service never retries this outcome.
 * - `bounded` — bounded retry is authorized while attempt/time limits hold.
 * - `guarded` — bounded retry only when no uncertain mutation exists.
 * - `reconcile` — never auto-retried; the outcome must be reconciled first.
 */
export type RetryPolicy = "never" | "bounded" | "guarded" | "reconcile";

export interface ErrorCodeSpec {
  code: string;
  stage: ErrorStage;
  category: ErrorCategory;
  retry: RetryPolicy;
  /** Authorized next action while a retry is still eligible. */
  next_action: NextAction;
  /** Authorized next action once retry is no longer eligible. */
  exhausted_action?: NextAction;
  message_key: string;
  message: string;
  agent_guidance_key: string;
  agent_guidance: string;
  human_guidance_key: string;
  human_guidance: string;
}

function spec(
  code: string,
  stage: ErrorStage,
  category: ErrorCategory,
  retry: RetryPolicy,
  nextAction: NextAction,
  message: string,
  agentGuidance: string,
  humanGuidance: string,
  exhaustedAction?: NextAction,
): ErrorCodeSpec {
  const slug = code.toLowerCase();
  return {
    code,
    stage,
    category,
    retry,
    next_action: nextAction,
    ...(exhaustedAction ? { exhausted_action: exhaustedAction } : {}),
    message_key: `error.${slug}.message`,
    message,
    agent_guidance_key: `error.${slug}.agent_guidance`,
    agent_guidance: agentGuidance,
    human_guidance_key: `error.${slug}.human_guidance`,
    human_guidance: humanGuidance,
  };
}

/**
 * The closed catalog. The seven ADR-0008 example codes come first; the rest
 * distinguish transport failures, harness stop conditions, gateway policy
 * denials, and the request-state refusals surfaces actually map into.
 */
export const ERROR_CATALOG: Readonly<Record<string, ErrorCodeSpec>> = Object.freeze(
  Object.fromEntries(
    [
      spec(
        "MODEL_RATE_LIMITED",
        "gateway",
        "retry",
        "bounded",
        "wait_and_retry",
        "The model provider rate-limited this call.",
        "Retry after the stated delay, within the capability grant, policy and budget; re-check the policy on every invocation.",
        "Retry timing and provider status are recorded in the run timeline; no action is needed unless retries are exhausted.",
        "stop_run",
      ),
      spec(
        "MODEL_USAGE_UNKNOWN",
        "usage",
        "unknown",
        "reconcile",
        "reconcile_usage",
        "Provider metering did not report usage for this call.",
        "Keep the cost estimate and its provenance separate from billed amounts; never assume zero usage.",
        "Metering is missing for this invocation, so totals stay provisional until usage is reconciled.",
      ),
      spec(
        "MODEL_BUDGET_EXHAUSTED",
        "gateway",
        "denial",
        "never",
        "request_review",
        "The invocation was not admitted because a budget has no remaining capacity.",
        "Stop. Do not retry or rephrase to obtain more budget; only an authorized budget change can admit this call.",
        "The enterprise, workspace or run budget is exhausted for this scope; review the budget or wait for the next allocation.",
      ),
      spec(
        "MODEL_BUDGET_UNAVAILABLE",
        "gateway",
        "denial",
        "never",
        "request_review",
        "The invocation has no finite safe budget reservation.",
        "Stop. Cost is never assumed to be zero; do not bypass the budget authority.",
        "No bounded budget policy or conservative cost ceiling covers this model; configure one before dispatch.",
      ),
      spec(
        "MODEL_TOKEN_CEILING_EXCEEDED",
        "gateway",
        "denial",
        "never",
        "refine_request",
        "The requested model token bound exceeds the enforced per-invocation ceiling.",
        "Stop and reduce the context or requested output; the ceiling is not raised by retrying.",
        "The workspace token ceiling is lower than this request's input plus output bound; adjust the ceiling or the request.",
      ),
      spec(
        "TOOL_SCOPE_DENIED",
        "tool",
        "denial",
        "never",
        "request_review",
        "The requested action is outside this run's capability grant.",
        "Stop. Do not retry with guessed arguments to evade the denial; a denied request is final for that intent.",
        "The denied capability category is recorded in the task timeline; request a capability review to change the grant.",
      ),
      spec(
        "VALIDATION_FAILED",
        "validation",
        "stop",
        "never",
        "stop_run",
        "Validation failed for the current run.",
        "Stop the current run and preserve the failing checks as evidence; do not continue past a failed check.",
        "Failing checks and their evidence are preserved for review; choose a disposition in the task timeline.",
      ),
      spec(
        "SANDBOX_UNAVAILABLE",
        "sandbox",
        "retry",
        "guarded",
        "block_execution",
        "The execution sandbox is unavailable.",
        "Block the action. A bounded infrastructure retry is authorized only while no uncertain mutation exists.",
        "Identify the affected environment and contact the operator; execution stays blocked until the sandbox recovers.",
      ),
      spec(
        "SENSITIVE_DATA_UNCERTAIN",
        "policy",
        "denial",
        "never",
        "enter_security_case",
        "Sensitive data handling for this operation is uncertain.",
        "Follow ADR-0005: do not retry and do not bypass; wait for a security decision.",
        "Open an authenticated security case to review the possible exposure.",
      ),
      spec(
        "DELIVERY_OUTCOME_UNKNOWN",
        "delivery",
        "unknown",
        "reconcile",
        "reconcile_delivery",
        "The delivery outcome is not known.",
        "Reconcile the existing operation before any further write; never repeat the delivery speculatively.",
        "Known side effects and reconciliation state are shown in the delivery record.",
      ),
      spec(
        "TRANSPORT_ERROR",
        "transport",
        "retry",
        "bounded",
        "retry_bounded",
        "A recoverable transport failure interrupted this operation.",
        "Retry within the service-enforced attempt and time limits; a transport failure is not a harness stop condition.",
        "Transient infrastructure failures retry automatically within limits; check the run timeline if retries are exhausted.",
        "report_error",
      ),
      spec(
        "HARNESS_STOP_CONDITION",
        "harness",
        "stop",
        "never",
        "stop_run",
        "A harness stop condition ended execution for this run.",
        "Stop. A stop condition is not a failure to retry; await instructions before acting again.",
        "The run stopped at a stop condition rather than failing; resume or redirect it from the task timeline.",
      ),
      spec(
        "MODEL_EGRESS_DENIED",
        "gateway",
        "denial",
        "never",
        "request_review",
        "Model egress is denied by policy for this scope.",
        "Stop. The policy denial is final for this request; do not attempt an unreviewed endpoint or credential.",
        "Review the model egress policy for this workspace to approve the destination or model.",
      ),
      spec(
        "SECURITY_REVIEW_REQUIRED",
        "policy",
        "denial",
        "never",
        "request_review",
        "The run's dependent work is held pending security case disposition.",
        "Stop. Dependent work stays held until an authorized human resolves the security case; continuing or re-sending the request is not permitted.",
        "A security case has paused this run's dependent work; disposition it through the security case workflow to release the hold.",
      ),
      spec(
        "RECOVERY_APPROVAL_INVALID",
        "policy",
        "denial",
        "never",
        "request_review",
        "The recovery approval no longer authorizes rechecking this request.",
        "Stop. An expired, revoked, consumed, or context-mismatched approval is never reused; only a fresh independent approval can authorize a recheck.",
        "The approval was invalidated by expiry, revocation, prior consumption, or a change to the bound context, destination, policy, or rules; request a new independent review.",
      ),
      spec(
        "MODEL_DISPATCH_FAILED",
        "gateway",
        "retry",
        "bounded",
        "retry_bounded",
        "The model dispatch failed before a result was produced.",
        "Retry within the service-enforced limits; do not alter the approved destination to work around the failure.",
        "Dispatch failures retry automatically within limits; provider status appears in the gateway attempt record.",
        "report_error",
      ),
      spec(
        "RISK_PROHIBITED",
        "policy",
        "denial",
        "never",
        "stop_run",
        "This action is prohibited by the run's risk policy.",
        "Stop. Prohibited actions are never retried or reformulated to evade the policy decision.",
        "The requested action falls in a prohibited risk class; a policy decision is required to proceed.",
      ),
      spec(
        "APPROVAL_REQUIRED",
        "policy",
        "stop",
        "never",
        "request_review",
        "This operation awaits an approval decision.",
        "Stop. Approval decisions belong to humans; do not attempt the action before it is granted.",
        "An approval decision is required before this action can proceed.",
      ),
      spec(
        "INVALID_REQUEST",
        "request",
        "stop",
        "never",
        "refine_request",
        "The request could not be accepted as submitted.",
        "Stop and correct the request; resubmitting the same request will fail the same way.",
        "The request shape or vocabulary was refused; correct it and resubmit.",
      ),
      spec(
        "ACTION_IN_FLIGHT",
        "tool",
        "stop",
        "never",
        "refresh_state",
        "An identical action is already in flight.",
        "Stop. An identical action is already running; await its outcome instead of submitting a duplicate.",
        "A duplicate submission was refused while the identical action is still running; its outcome appears in the run timeline.",
      ),
      spec(
        "ACTION_OUTCOME_UNKNOWN",
        "tool",
        "unknown",
        "reconcile",
        "refresh_state",
        "The outcome of this action is unknown.",
        "Stop. Read the authoritative state and reconcile before any further write; never repeat this action speculatively.",
        "The action was dispatched but its outcome is unknown; reconcile against the authoritative run state before any retry.",
        "refresh_state",
      ),
      spec(
        "FORBIDDEN",
        "policy",
        "denial",
        "never",
        "request_review",
        "The caller is not authorized for this operation.",
        "Stop. Do not attempt to work around the authorization refusal.",
        "Request an access review for the required scope.",
      ),
      spec(
        "STATE_CONFLICT",
        "request",
        "stop",
        "never",
        "refresh_state",
        "The operation conflicts with the current authoritative state.",
        "Re-read the authoritative state before acting again; do not repeat the write blindly.",
        "Another operation already changed this record; refresh the task view and decide the next step.",
      ),
      spec(
        "RATE_LIMITED",
        "request",
        "retry",
        "bounded",
        "wait_and_retry",
        "The service rate-limited this request.",
        "Retry after the stated delay within the service-enforced limits.",
        "The service is throttling this caller; requests resume automatically within limits.",
        "stop_run",
      ),
      spec(
        "INTERNAL_ERROR",
        "service",
        "stop",
        "never",
        "report_error",
        "The service failed to process this operation.",
        "Stop and surface the trace reference; do not guess a recovery.",
        "Report the trace reference to an operator for diagnosis.",
      ),
    ].map((entry) => [entry.code, entry]),
  ),
);

/**
 * A catalog code. The vocabulary is closed at runtime: anything that is not a
 * key of {@link ERROR_CATALOG} is refused by `buildErrorEnvelope`, so a typo
 * can never masquerade as an authorized error code.
 */
export type ErrorCode = string;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value);
}

export function errorCodeSpec(code: string): ErrorCodeSpec | undefined {
  return ERROR_CATALOG[code];
}
