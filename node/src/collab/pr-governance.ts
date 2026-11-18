import { randomUUID } from "node:crypto";

import { CollabError } from "./errors.js";
import type { DeliveryRecord, RepositoryRef } from "./types.js";

/**
 * Read-only PR governance observation and invalidation (DAT-261, ADR-0007).
 *
 * A delivery publishes one proposed revision. What GitHub thinks of that
 * revision — required checks, human approvals, and review discussions — is an
 * observation of *one exact head*, never a fact about the pull request in
 * general. This module turns provider reads into that observation:
 *
 * - every observation names the `head_sha` it describes and the
 *   `observed_at` time it was read;
 * - `approvals` and review-state observations are filtered to that head, so a
 *   new head inherits nothing — a passing check or a human approval recorded
 *   against an older commit is simply absent from the new record;
 * - when the provider cannot be read, the record says `unknown` (transport,
 *   rate limit, timeout) or `blocked` (no integration/credential, permission
 *   denied, PR absent) instead of reusing the last known values;
 * - a record produced for a different head than the delivery published is
 *   `superseded` and can never be eligible.
 *
 * The surface is observation only. There is deliberately no `merge`,
 * `approve`, `dismiss`, or `waive` capability in this module or in the
 * provider seam it consumes: the observation may report that GitHub's merge
 * boundary is eligible, and it still performs no approval or merge itself.
 */

/** How one observation dimension was obtained for the observed head. */
export const GOVERNANCE_OBSERVATION_STATES = ["observed", "unknown", "blocked"] as const;
export type GovernanceObservationState = (typeof GOVERNANCE_OBSERVATION_STATES)[number];

/** Whether an observation still describes the delivery's published head. */
export const GOVERNANCE_VALIDITY = ["current", "superseded", "unknown", "blocked"] as const;
export type GovernanceValidity = (typeof GOVERNANCE_VALIDITY)[number];

/**
 * Why an observation is missing. `blocked` reasons are definite refusals
 * (configuration, permission, absence); `unknown` reasons are unreadable
 * provider answers that must never be turned into "not merged yet".
 */
export const GOVERNANCE_UNAVAILABLE_REASONS = [
  "integration_not_configured",
  "credential_unavailable",
  "permission_denied",
  "pull_request_not_found",
  "provider_unavailable",
  "invalid_provider_response",
] as const;
export type GovernanceUnavailableReason = (typeof GOVERNANCE_UNAVAILABLE_REASONS)[number];

/** Why an observed head is not eligible for GitHub merge-queue admission. */
export const GOVERNANCE_DENY_REASONS = [
  "head_unavailable",
  "head_changed",
  "governance_blocked",
  "governance_unknown",
  "pull_request_not_open",
  "checks_missing",
  "checks_not_passed",
  "review_discussions_unresolved",
  "approvals_incomplete",
] as const;
export type GovernanceDenyReason = (typeof GOVERNANCE_DENY_REASONS)[number];

export const GOVERNANCE_CHECK_STATES = ["passed", "failed", "pending"] as const;
export type GovernanceCheckState = (typeof GOVERNANCE_CHECK_STATES)[number];

export const GOVERNANCE_APPROVAL_DECISIONS = ["approved", "changes_requested"] as const;
export type GovernanceApprovalDecision = (typeof GOVERNANCE_APPROVAL_DECISIONS)[number];

/**
 * The approval quorum from `CONTEXT.md`: simultaneous approvals by both named
 * owners on the current pull-request head. Injectable so a deployment can pin
 * its own reviewers, but never widened by an observation.
 */
export const DEFAULT_REQUIRED_APPROVERS = ["Luthiel", "Ludwig-Planck"] as const;

export interface GovernanceCheckObservation {
  name: string;
  status: GovernanceCheckState;
  /** The commit this check result belongs to. Never inherited across heads. */
  head_sha: string;
  observed_at: string;
}

export interface GovernanceApprovalObservation {
  identity: string;
  decision: GovernanceApprovalDecision;
  /** The commit the reviewer decided on (`commit_id`), not the PR head. */
  head_sha: string;
  submitted_at: string;
}

export interface GovernanceChecks {
  state: GovernanceObservationState;
  reason: GovernanceUnavailableReason | null;
  observed_at: string | null;
  /** Only results that belong to this observation's `head_sha`. */
  items: GovernanceCheckObservation[];
}

export interface GovernanceApprovals {
  state: GovernanceObservationState;
  reason: GovernanceUnavailableReason | null;
  observed_at: string | null;
  required: string[];
  satisfied: boolean;
  /** Only decisions recorded against this observation's `head_sha`. */
  items: GovernanceApprovalObservation[];
}

export interface GovernanceDiscussions {
  state: GovernanceObservationState;
  reason: GovernanceUnavailableReason | null;
  observed_at: string | null;
  unresolved: number | null;
}

/** The delivery facts an observation is bound to. */
export type GovernanceDeliveryRef = Pick<
  DeliveryRecord,
  "delivery_id" | "issue_id" | "repository" | "head_sha" | "provider" | "pr_id" | "pr_url"
>;

export interface SupersededObservation {
  observation_id: string;
  head_sha: string;
  observed_at: string;
  invalidation_reason: "head_changed";
}

export interface PullRequestGovernanceObservation {
  observation_id: string;
  issue_id: string;
  delivery_id: string;
  repository_id: string;
  provider: "github" | "gitlab";
  pr_id: string;
  pr_url: string;
  /** The head the delivery published and the approval covered. */
  delivery_head_sha: string;
  /** The PR's current head at observation time; null when it could not be read. */
  head_sha: string | null;
  pull_request_state: "open" | "closed" | "merged" | null;
  observed_at: string;
  validity: GovernanceValidity;
  /** True only for a current-head observation with every dimension observed. */
  observations_valid: boolean;
  /**
   * GitHub merge-queue admission eligibility computed from this observation.
   * It never merges, approves, or dismisses anything.
   */
  merge_queue_eligible: boolean;
  deny_reason: GovernanceDenyReason | null;
  checks: GovernanceChecks;
  approvals: GovernanceApprovals;
  review_discussions: GovernanceDiscussions;
  /** Set when this record replaced an observation of a different head. */
  supersedes: SupersededObservation | null;
}

/**
 * One provider read of a pull request's current governance state. Items carry
 * their own head binding so the service can refuse to inherit them.
 */
export interface ProviderGovernanceSnapshot {
  head_sha: string;
  pull_request_state: "open" | "closed" | "merged";
  checks: GovernanceCheckObservation[];
  approvals: GovernanceApprovalObservation[];
  unresolved_discussions: number;
}

/**
 * Read-only provider seam. Implementations only read; there is no approve,
 * merge, dismiss, or check-waiver member to call.
 */
export interface PRGovernanceProvider {
  readonly provider: "github" | "gitlab";
  observe(repository: RepositoryRef, prId: string): Promise<ProviderGovernanceSnapshot>;
}

/**
 * A provider read failure, classified as a definite refusal (`blocked`) or an
 * unreadable answer (`unknown`). The observation records the reason; it never
 * carries raw provider text or credentials.
 */
export class GovernanceProviderError extends Error {
  readonly kind: "blocked" | "unknown";
  readonly reason: GovernanceUnavailableReason;

  constructor(kind: "blocked" | "unknown", reason: GovernanceUnavailableReason) {
    super(`pull-request governance observation failed: ${kind}/${reason}`);
    this.name = "GovernanceProviderError";
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Compute validity, eligibility, and the deny reason from the observation's
 * own dimensions. Pure: the service and the fixtures use the same function,
 * so a record can never claim eligibility its observations do not support.
 */
export function finalizeGovernanceObservation(
  observation: PullRequestGovernanceObservation,
): PullRequestGovernanceObservation {
  const dimensions = [
    observation.checks.state,
    observation.approvals.state,
    observation.review_discussions.state,
  ];
  let validity: GovernanceValidity;
  if (dimensions.includes("blocked")) {
    validity = "blocked";
  } else if (dimensions.includes("unknown")) {
    validity = "unknown";
  } else if (observation.head_sha === null) {
    validity = "unknown";
  } else if (observation.head_sha !== observation.delivery_head_sha) {
    validity = "superseded";
  } else {
    validity = "current";
  }

  const deny = (reason: GovernanceDenyReason): PullRequestGovernanceObservation => ({
    ...observation,
    validity,
    observations_valid: false,
    merge_queue_eligible: false,
    deny_reason: reason,
  });

  if (validity === "blocked") {
    return deny("governance_blocked");
  }
  if (validity === "unknown") {
    return deny(observation.head_sha === null ? "head_unavailable" : "governance_unknown");
  }
  if (validity === "superseded") {
    return deny("head_changed");
  }
  if (observation.pull_request_state !== "open") {
    return deny("pull_request_not_open");
  }
  if (observation.checks.items.length === 0) {
    return deny("checks_missing");
  }
  if (observation.checks.items.some((check) => check.status !== "passed")) {
    return deny("checks_not_passed");
  }
  if (
    observation.review_discussions.unresolved === null ||
    observation.review_discussions.unresolved > 0
  ) {
    return deny("review_discussions_unresolved");
  }
  if (!observation.approvals.satisfied) {
    return deny("approvals_incomplete");
  }
  return {
    ...observation,
    validity: "current",
    observations_valid: true,
    merge_queue_eligible: true,
    deny_reason: null,
  };
}

/**
 * Whether a previously served observation still describes `currentHeadSha`.
 * A different head invalidates every approval, check, and discussion
 * observation it carried: the caller must observe again. Eligibility is a
 * separate question (`merge_queue_eligible`) and is not implied by this.
 */
export function observationStillCurrent(
  observation: PullRequestGovernanceObservation,
  currentHeadSha: string | null,
): boolean {
  return (
    currentHeadSha !== null &&
    observation.head_sha === currentHeadSha &&
    observation.validity === "current"
  );
}

export interface PullRequestGovernanceServiceOptions {
  /**
   * Provider read seam. Absent means the deployment has no observation
   * integration: every call answers `blocked/integration_not_configured`
   * rather than inventing a snapshot.
   */
  provider?: PRGovernanceProvider;
  clock?: () => Date;
  /** Observation identity; injectable for deterministic tests. */
  observationId?: () => string;
  requiredApprovers?: readonly string[];
}

/**
 * Serve one read-only observation per delivery. The service keeps only the
 * last observation it served (to report `supersedes` when the head moved); it
 * stores no governance fact of its own, so nothing can be inherited from a
 * previous head.
 */
export class PullRequestGovernanceService {
  private readonly provider: PRGovernanceProvider | undefined;
  private readonly clock: () => Date;
  private readonly observationId: () => string;
  private readonly requiredApprovers: readonly string[];
  private readonly last = new Map<string, PullRequestGovernanceObservation>();

  constructor(options: PullRequestGovernanceServiceOptions = {}) {
    this.provider = options.provider;
    this.clock = options.clock ?? (() => new Date());
    this.observationId = options.observationId ?? (() => randomUUID());
    this.requiredApprovers = options.requiredApprovers ?? DEFAULT_REQUIRED_APPROVERS;
  }

  async observe(delivery: GovernanceDeliveryRef): Promise<PullRequestGovernanceObservation> {
    if (delivery.pr_id === null || delivery.pr_id === "") {
      throw new CollabError(
        "GOVERNANCE_NOT_OBSERVABLE",
        "the delivery has no pull request whose governance can be observed",
        { delivery_id: delivery.delivery_id },
      );
    }
    const observedAt = this.clock().toISOString();
    let observation: PullRequestGovernanceObservation;
    if (this.provider === undefined) {
      observation = this.unavailable(delivery, observedAt, "blocked", "integration_not_configured");
    } else {
      try {
        const snapshot = await this.provider.observe(delivery.repository, delivery.pr_id);
        observation = this.fromSnapshot(delivery, observedAt, snapshot);
      } catch (error) {
        const failure =
          error instanceof GovernanceProviderError
            ? error
            : new GovernanceProviderError("unknown", "provider_unavailable");
        observation = this.unavailable(delivery, observedAt, failure.kind, failure.reason);
      }
    }

    const previous = this.last.get(delivery.delivery_id);
    observation.supersedes =
      previous !== undefined &&
      previous.head_sha !== null &&
      previous.head_sha !== observation.head_sha
        ? {
            observation_id: previous.observation_id,
            head_sha: previous.head_sha,
            observed_at: previous.observed_at,
            invalidation_reason: "head_changed",
          }
        : null;

    this.last.set(delivery.delivery_id, observation);
    return observation;
  }

  private fromSnapshot(
    delivery: GovernanceDeliveryRef,
    observedAt: string,
    snapshot: ProviderGovernanceSnapshot,
  ): PullRequestGovernanceObservation {
    const head = snapshot.head_sha;
    // The filter is the invalidation rule made explicit: an item observed for
    // another commit is not evidence about this head, so it is dropped rather
    // than carried over.
    const checks = snapshot.checks.filter((check) => check.head_sha === head);
    const approvals = latestDecisions(
      snapshot.approvals.filter((approval) => approval.head_sha === head),
    );
    const observation: PullRequestGovernanceObservation = {
      observation_id: this.observationId(),
      issue_id: delivery.issue_id,
      delivery_id: delivery.delivery_id,
      repository_id: delivery.repository.repository_id,
      provider: delivery.provider,
      pr_id: delivery.pr_id ?? "",
      pr_url: delivery.pr_url ?? "",
      delivery_head_sha: delivery.head_sha,
      head_sha: head,
      pull_request_state: snapshot.pull_request_state,
      observed_at: observedAt,
      validity: "unknown",
      observations_valid: false,
      merge_queue_eligible: false,
      deny_reason: null,
      checks: {
        state: "observed",
        reason: null,
        observed_at: observedAt,
        items: checks,
      },
      approvals: {
        state: "observed",
        reason: null,
        observed_at: observedAt,
        required: [...this.requiredApprovers],
        satisfied: quorumSatisfied(approvals, this.requiredApprovers),
        items: approvals,
      },
      review_discussions: {
        state: "observed",
        reason: null,
        observed_at: observedAt,
        unresolved: snapshot.unresolved_discussions,
      },
      supersedes: null,
    };
    return finalizeGovernanceObservation(observation);
  }

  private unavailable(
    delivery: GovernanceDeliveryRef,
    observedAt: string,
    kind: "blocked" | "unknown",
    reason: GovernanceUnavailableReason,
  ): PullRequestGovernanceObservation {
    const state: GovernanceObservationState = kind;
    const observation: PullRequestGovernanceObservation = {
      observation_id: this.observationId(),
      issue_id: delivery.issue_id,
      delivery_id: delivery.delivery_id,
      repository_id: delivery.repository.repository_id,
      provider: delivery.provider,
      pr_id: delivery.pr_id ?? "",
      pr_url: delivery.pr_url ?? "",
      delivery_head_sha: delivery.head_sha,
      head_sha: null,
      pull_request_state: null,
      observed_at: observedAt,
      validity: kind,
      observations_valid: false,
      merge_queue_eligible: false,
      deny_reason: null,
      checks: { state, reason, observed_at: null, items: [] },
      approvals: {
        state,
        reason,
        observed_at: null,
        required: [...this.requiredApprovers],
        satisfied: false,
        items: [],
      },
      review_discussions: { state, reason, observed_at: null, unresolved: null },
      supersedes: null,
    };
    return finalizeGovernanceObservation(observation);
  }
}

/** Keep the newest decision per reviewer; an older approval never overrides it. */
function latestDecisions(
  approvals: GovernanceApprovalObservation[],
): GovernanceApprovalObservation[] {
  const byIdentity = new Map<string, GovernanceApprovalObservation>();
  for (const approval of approvals) {
    const current = byIdentity.get(approval.identity);
    if (current === undefined || approval.submitted_at > current.submitted_at) {
      byIdentity.set(approval.identity, approval);
    }
  }
  return [...byIdentity.values()];
}

function quorumSatisfied(
  approvals: GovernanceApprovalObservation[],
  required: readonly string[],
): boolean {
  return required.every((identity) =>
    approvals.some(
      (approval) => approval.identity === identity && approval.decision === "approved",
    ),
  );
}
