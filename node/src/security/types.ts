/**
 * Security disposal case domain (DAT-210, ADR-0005 §2).
 *
 * Blocking a model call on uncertain secret material opens (or idempotently
 * associates) a scoped human-handling case. The case vocabulary — `pending`,
 * `handling`, `awaiting_review`, `resolved`, `terminated` — is deliberately
 * its own kind: it never redefines harness stop-condition or terminal-state
 * semantics. In particular the shared word `awaiting_review` here means "a
 * handler submitted this case for independent review", not the harness
 * "a provider PR exists" (see `../collab/states.ts` and `../dsh/types.ts`).
 * The two vocabularies are never interchangeable.
 *
 * Everything in this module is non-secret by construction: events, reasons,
 * notifications, and errors carry identifiers, codes, and scrubbed text only.
 * Raw request context lives in encrypted quarantine (see `quarantine.ts`).
 */

/** Case states (ADR-0005 §2). Terminal: `resolved`, `terminated`. */
export const CASE_STATES = [
  "pending",
  "handling",
  "awaiting_review",
  "resolved",
  "terminated",
] as const;

export type CaseState = (typeof CASE_STATES)[number];

/**
 * Allowed case-state edges. A failed review returns `awaiting_review` to
 * `handling`; `resolved` means handling and required checks succeeded and
 * asserts nothing about any model call being sent (record dispatch separately).
 */
export const CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  pending: ["handling", "terminated"],
  handling: ["awaiting_review", "terminated"],
  awaiting_review: ["resolved", "handling", "terminated"],
  resolved: [],
  terminated: [],
};

export function canTransitionCase(from: CaseState, to: CaseState): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

/** Terminal case states: the disposition is final and never reopened. */
export function isTerminalCaseState(state: CaseState): boolean {
  return CASE_TRANSITIONS[state].length === 0;
}

/**
 * Who is acting on the case. Case disposition and pause release are human or
 * service actions: a `run` actor — or any actor id equal to the affected run
 * id — can never handle, resolve, or resume its own case ("the paused run
 * cannot self-recover").
 */
export type SecurityActorKind = "human" | "service" | "run";

export interface SecurityActor {
  actorId: string;
  actorKind: SecurityActorKind;
}

/** Enterprise/workspace/issue/run scope one case covers (ADR-0006 seam). */
export interface CaseScope {
  enterpriseId: string;
  workspaceId: string;
  issueId: string;
  runId: string;
}

/** Full identity of one blocked gateway invocation. */
export interface BlockIdentity extends CaseScope {
  invocationId: string;
  traceId: string;
}

/**
 * One idempotent block association on a case. `invocationId` is the dedup key:
 * the same blocked invocation never records twice. Text fields are scrubbed at
 * intake and are never secret material.
 */
export interface BlockAssociation {
  invocationId: string;
  traceId: string;
  /** Redacted machine reason (e.g. `SENSITIVE_DATA_UNCERTAIN`); never content. */
  reason: string;
  /** Scrubbed, content-free handler summary. */
  safeDetail: string;
  at: string;
}

export interface SecurityCase {
  caseId: string;
  scope: CaseScope;
  state: CaseState;
  createdAt: string;
  updatedAt: string;
  blocks: BlockAssociation[];
  quarantineIds: string[];
}

/**
 * Append-only case history event types. `quarantine.*` events describe
 * sealed context, access grants, authorized views, denials, and expiry —
 * never quarantined content itself.
 */
export type CaseEventType =
  | "case.opened"
  | "block.recorded"
  | "case.state_changed"
  | "run.dependent_work_paused"
  | "run.pause_released"
  | "notification.dispatched"
  | "notification.escalated"
  | "notification.undeliverable"
  | "quarantine.sealed"
  | "quarantine.seal_failed"
  | "quarantine.access_granted"
  | "quarantine.accessed"
  | "quarantine.access_denied"
  | "quarantine.expired";

export interface CaseEvent {
  /** Per-case, 1-based, strictly increasing; the history never rewrites. */
  seq: number;
  caseId: string;
  type: CaseEventType;
  at: string;
  /** Null for automatic service actions with no external principal. */
  actor: SecurityActor | null;
  /** Non-secret scalars only (ids, codes, counts, enum words). */
  detail: Record<string, string | number | boolean>;
}

/** Stable error contract for security-case control failures. */
export class SecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SecurityError";
  }
}

/** Identity validation at the case boundary: ids are non-empty strings. */
export function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SecurityError("SECURITY_INPUT_INVALID", `${name} must be a non-empty string`);
  }
  return value;
}

/** True when the actor is the affected run itself and must never self-resume. */
export function isRunItself(actor: SecurityActor, scope: CaseScope): boolean {
  return actor.actorKind === "run" || actor.actorId === scope.runId;
}

/**
 * Exactly the principals allowed to act on cases, release holds, or inspect
 * quarantine: an identified human or service. A `run` actor is never one —
 * and neither is a runtime `actorKind` outside the closed vocabulary.
 * Unknown kinds are refused at the authorization boundary, never defaulted
 * into authority (DAT-210).
 */
export function isHumanOrService(actor: SecurityActor): boolean {
  return (
    typeof actor === "object" &&
    actor !== null &&
    typeof actor.actorId === "string" &&
    actor.actorId.length > 0 &&
    (actor.actorKind === "human" || actor.actorKind === "service")
  );
}
