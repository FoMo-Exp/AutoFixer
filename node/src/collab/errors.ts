/**
 * Error vocabulary for the collaboration state machine.
 *
 * These codes describe deny-by-default domain outcomes. They are deliberately
 * separate from `api/errors.ts`: the HTTP contract (forgepilot-api/v1 and the
 * upcoming collaboration contract) maps them later. A denial is a recorded
 * domain event — see `machine.ts` — not a silent drop.
 */
export const COLLAB_ERROR_CODES = [
  "INVALID_INPUT",
  "OPERATION_CONFLICT",
  "ISSUE_NOT_FOUND",
  "TASK_NOT_FOUND",
  "RUN_NOT_FOUND",
  "GRANT_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "CANDIDATE_NOT_FOUND",
  "CANDIDATE_CONFLICT",
  "CANDIDATE_INVALID",
  "BASE_ADVANCED",
  "INVALID_CURSOR",
  "ISSUE_DEDUPE_CONFLICT",
  "TRANSITION_FORBIDDEN",
  "PRODUCT_HARNESS_CONFLICT",
  "RUN_TERMINAL",
  "RUN_RESTART_FORBIDDEN",
  "RUN_OPEN_FORBIDDEN",
  "WORKTREE_CONFLICT",
  "LEASE_REQUIRED",
  "LEASE_STALE",
  "LEASE_HELD",
  "GRANT_REQUIRED",
  "GRANT_EXPIRED",
  "GRANT_REVOKED",
  "ACTIVE_GRANT_EXISTS",
  "DISPOSITION_REQUIRED",
  "TASK_BLOCKED",
  "TASK_DEPENDENCY_INVALID",
] as const;

export type CollabErrorCode = (typeof COLLAB_ERROR_CODES)[number];

/** A denied or rejected domain command. */
export class CollabError extends Error {
  readonly code: CollabErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CollabErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CollabError";
    this.code = code;
    this.details = details;
  }
}
