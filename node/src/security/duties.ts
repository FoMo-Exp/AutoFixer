/**
 * Security duties, permission matrix, and separation of duties (DAT-211,
 * ADR-0005 §3).
 *
 * Handling a case, reviewing a disposition or rule change, and administering
 * policy are three different questions answered by three different
 * principals. This module is the single place that answers "who may do what"
 * and "may this principal decide over this change": every duty-gated action
 * goes through {@link requireDuty}, and every review or activation decision
 * goes through the independence checks below.
 *
 * Invariants enforced here (fail closed by construction):
 * - Exactly the duties in {@link SECURITY_DUTY_MATRIX} grant an action; an
 *   unknown duty, an agent (`run` actor), or an unnamed principal gets
 *   nothing. Repository ownership grants no security privilege.
 * - Review and disposition decisions are human-principal actions only.
 * - Self-review is forbidden: the deciding principal must differ from the
 *   change author / handling principals, and role combinations never create
 *   an exception (`assertIndependentReview`).
 * - Missing independent reviewer is a rejection, never a waiver.
 */

import { SecurityError, requireNonEmpty } from "./types.js";
import type { SecurityActor } from "./types.js";

/** The four separated security responsibilities (ADR-0005 §3). */
export type SecurityDuty =
  "task_owner" | "security_handler" | "independent_reviewer" | "enterprise_security_admin";

/**
 * Every duty-gated security action. Actions outside this table have no
 * authority path at all (an agent cannot approve, change rules, read
 * quarantined values, or resume anything — there is simply no action for it).
 */
export type SecurityAction =
  | "case.read_redacted_status"
  | "case.request_termination"
  | "case.request_reassignment"
  | "case.handle"
  | "case.submit_for_review"
  | "case.review_decide"
  | "case.terminate"
  | "quarantine.grant_access"
  | "quarantine.view"
  | "rule.propose"
  | "rule.review"
  | "rule.activate"
  | "rule.rollback"
  | "role.grant"
  | "endpoint.configure";

/**
 * The permission matrix (ADR-0005 §3). Read it as "which duties may perform
 * the action"; every omitted duty is denied. Administrative status never
 * widens review authority (`enterprise_security_admin` cannot
 * `case.review_decide` or `rule.review`), and task ownership never grants
 * handling or viewing authority (`task_owner` cannot `quarantine.view`).
 */
export const SECURITY_DUTY_MATRIX: Record<SecurityAction, readonly SecurityDuty[]> = {
  // Task owner: read redacted status; request termination or reassignment.
  "case.read_redacted_status": [
    "task_owner",
    "security_handler",
    "independent_reviewer",
    "enterprise_security_admin",
  ],
  "case.request_termination": ["task_owner"],
  "case.request_reassignment": ["task_owner"],
  // Security handler: handle the case and propose corrections — never
  // approve their own handling or rule change.
  "case.handle": ["security_handler"],
  "case.submit_for_review": ["security_handler"],
  "case.terminate": ["security_handler", "enterprise_security_admin"],
  "quarantine.view": ["security_handler", "independent_reviewer"],
  "quarantine.grant_access": ["enterprise_security_admin"],
  "rule.propose": ["security_handler"],
  // Independent reviewer: decide over evidence and corrections. Nothing else
  // — and never their own change (checked separately, see below).
  "case.review_decide": ["independent_reviewer"],
  "rule.review": ["independent_reviewer"],
  // Enterprise security administrator: grant roles, configure policy, and
  // activate or roll back reviewed rule revisions — never waive review.
  "rule.activate": ["enterprise_security_admin"],
  "rule.rollback": ["enterprise_security_admin"],
  "role.grant": ["enterprise_security_admin"],
  "endpoint.configure": ["enterprise_security_admin"],
};

/**
 * Enterprise/workspace scope a duty assignment is resolved for (ADR-0006
 * seam). A deployment resolves real people here; nothing in this module ever
 * invents principals.
 */
export interface SecurityDutyScope {
  enterpriseId: string;
  workspaceId: string;
}

/**
 * ADR-0006 seam: which duties one principal holds in one scope, and which
 * human principals can serve as independent reviewer there. An empty
 * `reviewersIn` means no independent reviewer is available: the case stays
 * blocked and escalates — it is never a waiver.
 */
export interface SecurityDutyDirectory {
  dutiesOf(principalId: string, scope: SecurityDutyScope): readonly SecurityDuty[];
  reviewersIn(scope: SecurityDutyScope): readonly string[];
}

/** Validate a duty scope at the boundary. */
export function requireScope(scope: SecurityDutyScope): SecurityDutyScope {
  return {
    enterpriseId: requireNonEmpty(scope?.enterpriseId, "scope.enterpriseId"),
    workspaceId: requireNonEmpty(scope?.workspaceId, "scope.workspaceId"),
  };
}

/**
 * Duty-gated action authorization. Only a human principal holding one of the
 * matrix duties may act; agents (`run` actors), services on duty-gated
 * actions, unknown actor kinds, and unnamed principals are refused before
 * anything changes. Role combinations never exceed the matrix union.
 */
export function requireDuty(
  action: SecurityAction,
  actor: SecurityActor,
  directory: SecurityDutyDirectory,
  scope: SecurityDutyScope,
): void {
  if (
    !actor ||
    typeof actor !== "object" ||
    typeof actor.actorId !== "string" ||
    actor.actorId.length === 0 ||
    (actor.actorKind !== "human" && actor.actorKind !== "service" && actor.actorKind !== "run")
  ) {
    throw new SecurityError("SECURITY_INPUT_INVALID", "actor must carry a non-empty actorId");
  }
  if (actor.actorKind !== "human") {
    // An agent or service account never holds a duty: the matrix is a matrix
    // of human responsibilities (ADR-0005 §3).
    throw new SecurityError(
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
      `${action} requires a human principal`,
      {
        action,
        actorKind: actor.actorKind,
      },
    );
  }
  const held = directory.dutiesOf(actor.actorId, scope) ?? [];
  const allowed = SECURITY_DUTY_MATRIX[action];
  if (!held.some((duty) => allowed.includes(duty))) {
    throw new SecurityError("SOD_DUTY_REQUIRED", `action ${action} requires one of: ${allowed}`, {
      action,
      actorId: actor.actorId,
    });
  }
}

/**
 * The relationship a review decision must stay independent of: the change
 * author plus every principal that handled or submitted the change. Compared
 * by principal id — a second role hat on the same person is still the same
 * principal.
 */
export interface ReviewIndependence {
  /** The change author / handling principal of record. */
  authorId: string;
  /** Every principal of record (author plus co-handlers), including authorId. */
  subjectIds: readonly string[];
  /** The principal deciding. Must be a different human principal. */
  reviewer: SecurityActor;
  /** Duty the decision requires (`case.review_decide` or `rule.review`). */
  action: "case.review_decide" | "rule.review";
  scope: SecurityDutyScope;
}

/**
 * Separation-of-duties gate for every review decision (case disposition and
 * rule correction alike). Rejects, in order:
 * - a missing or unnamed reviewer (`SOD_INDEPENDENT_REVIEWER_REQUIRED`);
 * - a non-human reviewer — a service or agent is never an independent human
 *   principal (`SOD_HUMAN_PRINCIPAL_REQUIRED`);
 * - a change without a principal of record
 *   (`SOD_INDEPENDENT_REVIEWER_REQUIRED`);
 * - the author/handler reviewing their own change
 *   (`SOD_SELF_REVIEW_FORBIDDEN`);
 * - any other same-principal review, e.g. a co-handler deciding over the
 *   change they handled together (`SOD_SAME_PRINCIPAL_FORBIDDEN`);
 * - a reviewer without the reviewer duty (`SOD_DUTY_REQUIRED`).
 */
export function assertIndependentReview(
  directory: SecurityDutyDirectory,
  review: ReviewIndependence,
): void {
  const reviewer = review.reviewer;
  if (
    !reviewer ||
    typeof reviewer !== "object" ||
    typeof reviewer.actorId !== "string" ||
    reviewer.actorId.length === 0
  ) {
    throw new SecurityError(
      "SOD_INDEPENDENT_REVIEWER_REQUIRED",
      "a review decision requires an identified independent reviewer",
      { action: review.action },
    );
  }
  if (reviewer.actorKind !== "human") {
    throw new SecurityError(
      "SOD_HUMAN_PRINCIPAL_REQUIRED",
      "an independent reviewer must be a different human principal",
      { action: review.action, actorKind: reviewer.actorKind },
    );
  }
  const subjectIds = review.subjectIds ?? [];
  if (
    typeof review.authorId !== "string" ||
    review.authorId.length === 0 ||
    subjectIds.length === 0
  ) {
    throw new SecurityError(
      "SOD_INDEPENDENT_REVIEWER_REQUIRED",
      "a change without a principal of record cannot be reviewed",
      { action: review.action },
    );
  }
  if (reviewer.actorId === review.authorId) {
    // The author/handler deciding over their own change — including under a
    // second role hat ("role combinations never permit self-review").
    throw new SecurityError(
      "SOD_SELF_REVIEW_FORBIDDEN",
      "the change author or handler never reviews their own change",
      { action: review.action, actorId: reviewer.actorId },
    );
  }
  if (subjectIds.includes(reviewer.actorId)) {
    throw new SecurityError(
      "SOD_SAME_PRINCIPAL_FORBIDDEN",
      "a review must come from a principal outside the change's handling principals",
      { action: review.action, actorId: reviewer.actorId },
    );
  }
  const held = directory.dutiesOf(reviewer.actorId, review.scope) ?? [];
  if (!held.includes("independent_reviewer")) {
    throw new SecurityError(
      "SOD_DUTY_REQUIRED",
      "the deciding principal does not hold the independent_reviewer duty",
      { action: review.action, actorId: reviewer.actorId },
    );
  }
}

/**
 * Activation/administration separation: the principal activating or rolling
 * back a reviewed change must differ from the change author and its reviewer
 * — handling, review, and policy administration are three separated
 * principals, never one principal wearing three hats. The administrator must
 * still hold the matrix duty for the action.
 */
export function assertSeparateAdministrator(
  directory: SecurityDutyDirectory,
  input: {
    subjectIds: readonly string[];
    administrator: SecurityActor;
    action: "rule.activate" | "rule.rollback";
    scope: SecurityDutyScope;
  },
): void {
  requireDuty(input.action, input.administrator, directory, input.scope);
  if (input.subjectIds.includes(input.administrator.actorId)) {
    throw new SecurityError(
      "SOD_SAME_PRINCIPAL_FORBIDDEN",
      "the activating administrator must be a principal separate from author and reviewer",
      { action: input.action, actorId: input.administrator.actorId },
    );
  }
}

/**
 * Static directory from explicit id lists (deployment configuration). Duties
 * are granted only by explicit listing — nothing is inferred — and a
 * principal may hold several duties; that never creates self-review, because
 * independence is always compared by principal id.
 */
export function staticDutyDirectory(assignments: {
  taskOwners?: readonly string[];
  handlers?: readonly string[];
  reviewers?: readonly string[];
  admins?: readonly string[];
}): SecurityDutyDirectory {
  const owners = assignments.taskOwners ?? [];
  const handlers = assignments.handlers ?? [];
  const reviewers = assignments.reviewers ?? [];
  const admins = assignments.admins ?? [];
  return {
    dutiesOf(principalId: string): readonly SecurityDuty[] {
      const held: SecurityDuty[] = [];
      if (owners.includes(principalId)) held.push("task_owner");
      if (handlers.includes(principalId)) held.push("security_handler");
      if (reviewers.includes(principalId)) held.push("independent_reviewer");
      if (admins.includes(principalId)) held.push("enterprise_security_admin");
      return held;
    },
    reviewersIn(): readonly string[] {
      return reviewers;
    },
  };
}
