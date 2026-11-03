/**
 * Service-side retry authority (DAT-226).
 *
 * The service, not the LLM, decides retry eligibility and enforces attempt
 * and time limits. A model hint is accepted as an input only so it can be
 * recorded and ignored: it never changes the decision, and nothing here can
 * widen a capability grant. Retry eligibility comes from the error catalog
 * (denial / stop / unknown outcomes are never retried) plus verified service
 * facts — recoverable transport errors stay distinct from harness stop
 * conditions because the catalog says so, not because a model claimed so.
 */
import { ERROR_CATALOG } from "./catalog.js";

/**
 * An untrusted suggestion from a model or provider. Recorded for audit at
 * most; a `widenGrant` hint in particular has no path to any decision.
 */
export interface RetryHint {
  retryable?: boolean;
  delayMs?: number;
  widenGrant?: boolean;
}

export interface RetryDecisionInput {
  /** Identity the governor accounts attempts under (e.g. an invocation id). */
  caseId: string;
  /** Catalog code of the failure being considered. */
  code: string;
  /** Untrusted hint; never influences the decision. */
  hint?: RetryHint | null;
  /** Verified fact: an uncertain mutation exists (blocks guarded retries). */
  uncertainMutation?: boolean;
  /** Verified fact: the producing service ruled a retry out. */
  serviceRetryAllowed?: boolean;
  /** Earliest safe retry time (ms epoch), e.g. from `retry_after_ms`. */
  notBeforeMs?: number;
  /** Deadline (ms epoch); no retry is authorized at or after it. */
  deadlineMs?: number;
  /** Injectable clock reading (ms epoch). */
  nowMs?: number;
}

export type RetryRefusalReason =
  /** Policy/authorization denial: terminal for the intent. */
  | "denied"
  /** Harness stop condition or run-stopping failure: not a retryable failure. */
  | "stop_condition"
  /** Unknown outcome: reconcile before any further attempt. */
  | "unknown_requires_reconciliation"
  /** Guarded retry with an uncertain mutation present. */
  | "guard_unsatisfied"
  /** The producing service ruled this occurrence non-retryable. */
  | "not_authorized"
  /** Attempt limit reached. */
  | "exhausted"
  /** Time budget gone, or the safe retry time falls after the deadline. */
  | "deadline"
  /** The code is not in the closed catalog. */
  | "unknown_code";

export type RetryDecision =
  | {
      retry: true;
      case_id: string;
      /** Attempt number within this case, counting this authorization. */
      attempt: number;
      /** Earliest time this retry may actually run. */
      authorized_at_ms: number;
      /** Always true: hints are recorded as ignored, never applied. */
      hint_ignored: true;
    }
  | {
      retry: false;
      case_id: string;
      attempt: number;
      reason: RetryRefusalReason;
      hint_ignored: true;
    };

export interface RetryGovernorOptions {
  /** Total attempts per case, including the first. */
  maxAttempts?: number;
  /** Injectable clock (ms epoch). */
  clock?: () => number;
}

/**
 * Per-case retry accounting. `decide` is synchronous, so concurrent callers
 * inside one process cannot lose an attempt increment; the concurrency tests
 * hammer it from interleaved async callers to hold that line.
 */
export class RetryGovernor {
  private readonly maxAttempts: number;
  private readonly clock: () => number;
  private readonly attempts = new Map<string, number>();

  constructor(options: RetryGovernorOptions = {}) {
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("RetryGovernor maxAttempts must be an integer >= 1");
    }
    this.maxAttempts = maxAttempts;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Attempts consumed so far for one case. */
  attemptsFor(caseId: string): number {
    return this.attempts.get(caseId) ?? 0;
  }

  /** The governor's clock reading (ms epoch); callers keep one time source. */
  now(): number {
    return this.clock();
  }

  /** Forget a case's accounting (e.g. after reconciliation). */
  release(caseId: string): void {
    this.attempts.delete(caseId);
  }

  decide(input: RetryDecisionInput): RetryDecision {
    const caseId = input.caseId;
    const attempt = this.attempts.get(caseId) ?? 0;
    const spec = ERROR_CATALOG[input.code];
    if (spec === undefined) {
      return this.refuse(caseId, attempt, "unknown_code");
    }
    const category = spec.category;
    if (category === "denial") {
      return this.refuse(caseId, attempt, "denied");
    }
    if (category === "stop") {
      return this.refuse(caseId, attempt, "stop_condition");
    }
    if (category === "unknown") {
      return this.refuse(caseId, attempt, "unknown_requires_reconciliation");
    }
    // Category is "retry" from here; the catalog and verified facts decide,
    // never the hint.
    if (spec.retry === "guarded" && input.uncertainMutation !== false) {
      return this.refuse(caseId, attempt, "guard_unsatisfied");
    }
    if (input.serviceRetryAllowed === false) {
      return this.refuse(caseId, attempt, "not_authorized");
    }
    const now = input.nowMs ?? this.clock();
    if (input.deadlineMs !== undefined && now >= input.deadlineMs) {
      return this.refuse(caseId, attempt, "deadline");
    }
    if (attempt + 1 > this.maxAttempts) {
      return this.refuse(caseId, attempt, "exhausted");
    }
    const authorizedAtMs = Math.max(now, input.notBeforeMs ?? now);
    if (input.deadlineMs !== undefined && authorizedAtMs >= input.deadlineMs) {
      return this.refuse(caseId, attempt, "deadline");
    }
    this.attempts.set(caseId, attempt + 1);
    return {
      retry: true,
      case_id: caseId,
      attempt: attempt + 1,
      authorized_at_ms: authorizedAtMs,
      hint_ignored: true,
    };
  }

  private refuse(caseId: string, attempt: number, reason: RetryRefusalReason): RetryDecision {
    return { retry: false, case_id: caseId, attempt, reason, hint_ignored: true };
  }
}
