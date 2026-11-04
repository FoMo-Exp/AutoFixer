/**
 * Contract vocabulary for the collaboration v1 API (DAT-221, ADR-0007).
 *
 * These closed vocabularies are shared by the OpenAPI document
 * (`node/src/api/openapi.ts`) and the code that serves and consumes the
 * collaboration surface, so an enum in the contract and the value a server
 * emits cannot drift apart. They describe the resources of the durable
 * collaboration API — immutable candidates, pre-PR human approvals,
 * broker-controlled delivery, and the issue event stream.
 *
 * The candidate/approval/delivery records and their HTTP endpoints are
 * defined here as the implementable contract; their implementation lands with
 * the collaboration API issues that build on DAT-221. Defining a vocabulary
 * grants no authority and claims no running control: dsh remains the only
 * execution gate, and no branch push or PR exists before a valid
 * candidate-bound human approval.
 */

/**
 * Approval lifecycle for one immutable candidate (ADR-0007 "Approval and
 * delivery"):
 *
 * - `pending` — a candidate-bound request is addressed to one named eligible
 *   human delivery approver and awaits their confirmed decision.
 * - `approved` — the approver approved the exact bound digests and the
 *   request has not expired, been invalidated, or been consumed.
 * - `rejected` — the approver rejected the candidate; delivery is refused.
 * - `invalidated` — content, required test evidence, base advancement,
 *   target, approval policy, expiry, or relevant authority changed. The old
 *   request never authorizes anything; a newly addressed request is created.
 * - `expired` — the finite TTL (default 24 hours) passed.
 * - `consumed` — the delivery operation it authorized was recorded; safe
 *   retries reconcile that same operation instead of reusing the approval.
 * - `cancelled` — the issue was cancelled or the request withdrawn.
 */
export const APPROVAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "invalidated",
  "expired",
  "consumed",
  "cancelled",
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** Why a pending approval stopped being valid (ADR-0007 binding list). */
export const APPROVAL_INVALIDATION_REASONS = [
  "content_changed",
  "test_evidence_changed",
  "base_advanced",
  "target_changed",
  "policy_changed",
  "authority_changed",
] as const;

export type ApprovalInvalidationReason = (typeof APPROVAL_INVALIDATION_REASONS)[number];

/**
 * Broker-controlled delivery lifecycle for one approved candidate
 * (ADR-0007 "Approval and delivery"):
 *
 * - `pending` — operation identity and intention are persisted; no provider
 *   write has happened yet.
 * - `pushing` — the branch push is in flight or was attempted.
 * - `opening_pr` — the branch is verified pushed and PR creation is in
 *   flight.
 * - `delivered` — the branch and PR are provider-confirmed. A published PR is
 *   not a merge and never claims the issue is completed.
 * - `partial` — the branch was pushed but PR creation failed or is
 *   unconfirmed; an explicit partial delivery, never success and never
 *   automatically deleted.
 * - `unknown` — the provider outcome is not known. Reconcile against branch
 *   and provider operation evidence before any further write; never
 *   auto-retried.
 * - `failed` — the delivery was refused or failed with no provider side
 *   effect.
 * - `cancelled` — delivery was cancelled; a completed provider side effect
 *   cannot be undone by it.
 */
export const DELIVERY_STATES = [
  "pending",
  "pushing",
  "opening_pr",
  "delivered",
  "partial",
  "unknown",
  "failed",
  "cancelled",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * Closed, additive event vocabulary of one issue's SSE stream (DAT-221).
 *
 * Every event is a projection of one durable audit record: `event_id` is
 * stable across replays (the idempotency key a consumer deduplicates on),
 * `sequence` is monotonic and gap-free per issue, and `data` carries the
 * projected resource. Payloads:
 *
 * - `issue.created`, `issue.stage_changed` — the issue, plus `from`/`to`/
 *   `reason` on a stage change.
 * - `issue.terminal` — the terminal `product_state`; the stream closes after
 *   this event's replay.
 * - `task.created`, `task.state_changed` — the child task.
 * - `run.opened`, `run.state_changed` — the run with its observed harness
 *   state.
 * - `run.grant_recorded`, `run.grant_revoked` — the run's grant record.
 * - `run.artifact_attached` — the immutable artifact reference.
 * - `candidate.frozen` — the immutable candidate (review card source).
 * - `approval.requested`, `approval.decided`, `approval.invalidated` — the
 *   approval record and its new state.
 * - `delivery.requested`, `delivery.state_changed`, `delivery.reconciled` —
 *   the delivery record and its new state.
 * - `operation.denied` — a recorded deny-by-default domain outcome
 *   (`operation_id`, `command`, `error_code`); the denial is never a silent
 *   drop.
 */
export const ISSUE_EVENT_TYPES = [
  "issue.created",
  "issue.stage_changed",
  "issue.terminal",
  "task.created",
  "task.state_changed",
  "run.opened",
  "run.state_changed",
  "run.grant_recorded",
  "run.grant_revoked",
  "run.artifact_attached",
  "candidate.frozen",
  "approval.requested",
  "approval.decided",
  "approval.invalidated",
  "delivery.requested",
  "delivery.state_changed",
  "delivery.reconciled",
  "operation.denied",
] as const;

export type IssueEventType = (typeof ISSUE_EVENT_TYPES)[number];

/**
 * Version of the task/evidence contract (`docs/contracts/
 * task-evidence-contract-v1.md`) that the candidate and approval records
 * carry and claim compatibility with.
 */
export const TASK_EVIDENCE_CONTRACT_VERSION = "1.0.0";
