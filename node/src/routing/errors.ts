/**
 * Error vocabulary for the routing domain.
 *
 * These codes describe deny-by-default routing outcomes, deliberately
 * separate from `api/errors.ts` like the collaboration vocabulary: the HTTP
 * contract maps them later. A denial is a recorded domain event (see
 * `machine.ts`), never a silent drop.
 */
export const ROUTING_ERROR_CODES = [
  "INVALID_INPUT",
  "OPERATION_CONFLICT",
  "POLICY_NOT_REGISTERED",
  "POLICY_INVALID",
  "DECISION_NOT_FOUND",
  "PROPOSAL_NOT_FOUND",
  "APPROVAL_NOT_FOUND",
  "ASSIGNMENT_NOT_ALLOWED",
  "ASSIGNMENT_SUPERSEDED",
  "CANDIDATE_NOT_BOUNDED",
  "NOT_ELIGIBLE",
  "ROLE_FORBIDDEN",
  "DESTINATION_INELIGIBLE",
  "REVIEWER_NOT_AUTHORIZED",
  "TRANSFER_NOT_PENDING",
  "TRANSFER_STALE",
  "APPROVAL_ALREADY_PENDING",
  "NO_PENDING_APPROVAL",
  "AUTHORITY_STILL_ACTIVE",
] as const;

export type RoutingErrorCode = (typeof ROUTING_ERROR_CODES)[number];

/** A denied or rejected domain command. */
export class RoutingError extends Error {
  readonly code: RoutingErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: RoutingErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
    this.details = details;
  }
}
