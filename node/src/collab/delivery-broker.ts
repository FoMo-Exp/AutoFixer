import { randomUUID } from "node:crypto";

import { bindingMismatch } from "./approval.js";
import type { ApprovalDirectory } from "./approval-service.js";
import { isEligibleApprover } from "./approval-service.js";
import { deliveryBranchProblem, deliveryView } from "./delivery.js";
import type { DeliveryView } from "./delivery.js";
import { CollabError } from "./errors.js";
import type { CollabMachine } from "./machine.js";
import type { CandidateRecord, DeliveryRecord, RepositoryRef, UserRef } from "./types.js";
import { autofixerBranchFor } from "./types.js";

/**
 * Trusted delivery broker (DAT-220, ADR-0007 "Approval and delivery").
 *
 * Only this broker obtains provider write credentials. Before every provider
 * write it re-checks, in this order:
 *
 * 1. current human approval — the approval is consumed by this exact delivery,
 *    its binding still matches the candidate, and the addressed approver still
 *    holds current repository access and explicit approval authority;
 * 2. delivery permission — an injected trusted decision, never a job-title or
 *    assignee fact;
 * 3. the separate delivery capability grant — active, unrevoked, PR-capable,
 *    and bound to the approved candidate head;
 * 4. audit availability — no provider write when the audit sink is unavailable;
 * 5. branch constraints — only the issue's exact autofixer branch, never the
 *    repository base/main branch;
 * 6. exact candidate identity — the frozen head and its base are current.
 *
 * The provider contract has no merge, main-branch write, self-review, or
 * check-waiver operation, so the broker cannot perform one. Unknown outcomes
 * are recorded as `unknown` and only `reconcile` may resolve them; a retry
 * never opens a duplicate PR.
 */

export interface ProviderBranchEvidence {
  /** Current commit of the branch, or null when the branch does not exist. */
  head_sha: string | null;
}

export interface ProviderPullRequestEvidence {
  pr_id: string;
  pr_url: string;
  branch: string;
  head_sha: string;
  state: "open" | "closed" | "merged";
}

export interface DeliveryProviderCapabilities {
  push: boolean;
  pull_request: boolean;
  /**
   * Reviewed mapping to the provider's repository governance. A provider
   * without a reviewed mapping leaves delivery blocked; GitHub queue
   * semantics are never advertised as GitLab protection.
   */
  repository_governance:
    "github_branch_protection" | "gitlab_merge_request_mapping" | "unsupported";
}

export interface PushBranchInput {
  repository: RepositoryRef;
  branch: string;
  base_sha: string;
  head_sha: string;
  /** Exact immutable tree the approval covered; a provider may verify it. */
  tree_sha: string;
  /** Diff digest the pushed commit must reproduce. */
  diff_digest: string;
}

export type PushBranchOutcome =
  | { status: "pushed"; head_sha: string }
  | { status: "failed"; error_code: string }
  | { status: "ambiguous"; error_code: string };

export interface OpenPullRequestInput {
  repository: RepositoryRef;
  branch: string;
  target_branch: string;
  head_sha: string;
  title: string;
  body: string;
}

/**
 * Provider write seam. There is deliberately no `merge`, `close`, `delete`, or
 * `forcePush` member: the broker's capability surface cannot express a merge,
 * a main-branch write, or a self-review. A provider adapter that cannot honor
 * its declared governance mapping reports it as `unsupported`.
 */
export interface DeliveryProvider {
  readonly provider: "github" | "gitlab";
  readonly capabilities: DeliveryProviderCapabilities;
  observeBranch(repository: RepositoryRef, branch: string): Promise<ProviderBranchEvidence>;
  pushBranch(input: PushBranchInput): Promise<PushBranchOutcome>;
  findPullRequest(
    repository: RepositoryRef,
    branch: string,
    headSha: string,
  ): Promise<ProviderPullRequestEvidence | null>;
  openPullRequest(input: OpenPullRequestInput): Promise<ProviderPullRequestEvidence>;
}

/** A provider read failed; no write occurred and the call may be retried. */
export class DeliveryProviderError extends Error {
  readonly code = "PROVIDER_ERROR";
  readonly retryable = true;

  constructor(message = "provider evidence is temporarily unavailable") {
    super(message);
    this.name = "DeliveryProviderError";
  }
}

export interface DeliveryBrokerOptions {
  machine: CollabMachine;
  /** Write providers by type; a missing provider leaves delivery blocked. */
  providers: Partial<Record<"github" | "gitlab", DeliveryProvider>>;
  approvalDirectory: ApprovalDirectory;
  /**
   * Trusted delivery-permission decision, evaluated before each write. When
   * absent, delivery is denied (fail closed): missing integration permissions
   * must block delivery rather than be silently assumed.
   */
  deliveryAuthorized?: (input: {
    issue_id: string;
    repository_id: string;
    delivery_id: string;
  }) => boolean;
  /** Audit sink availability; a missing/closed sink blocks every write. */
  auditAvailable?: () => boolean;
}

export interface RequestDeliveryOptions {
  operation_id: string;
  actor: string;
  issue_id: string;
  candidate_id: string;
  approval_id: string;
  grant_id: string;
  requester_authorized: boolean;
}

export interface DeliverOptions {
  actor: string;
}

export interface ReconcileOptions {
  operation_id: string;
  actor: string;
}

function providerFor(repository: RepositoryRef): "github" | "gitlab" | null {
  let host: string;
  try {
    host = new URL(repository.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "github.com") {
    return "github";
  }
  if (host === "gitlab.com" || host.startsWith("gitlab.")) {
    return "gitlab";
  }
  return null;
}

/** Pull request title/body: bounded metadata only, never diff content. */
function pullRequestCopy(
  delivery: DeliveryRecord,
  candidate: CandidateRecord,
): {
  title: string;
  body: string;
} {
  const title = `Fix ${delivery.issue_id}: ${candidate.summary}`
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const body = [
    `AutoFixer delivery for issue ${delivery.issue_id}.`,
    `Candidate: ${candidate.candidate_id}`,
    `Base: ${candidate.base_sha}`,
    `Head: ${candidate.head_sha}`,
    `Validation policy: ${candidate.test_policy.policy_id} (${candidate.test_policy.policy_version})`,
    "A human change approval covers exactly this revision; this PR is not a merge and claims no production recovery.",
  ].join("\n");
  return { title, body };
}

export class DeliveryBroker {
  private readonly options: DeliveryBrokerOptions;

  constructor(options: DeliveryBrokerOptions) {
    this.options = options;
  }

  /**
   * Record the delivery operation (identity and intention) before any provider
   * write and consume the approval. Provider governance is checked here so an
   * unsupported provider never produces a pending operation that cannot run.
   */
  request(options: RequestDeliveryOptions): DeliveryView {
    const { machine } = this.options;
    const issue = machine.getIssue(options.issue_id);
    if (!issue) {
      throw new CollabError("ISSUE_NOT_FOUND", "unknown issue", { issue_id: options.issue_id });
    }
    const approval = machine.getApproval(options.approval_id);
    if (!approval || approval.issue_id !== issue.issue_id) {
      throw new CollabError("APPROVAL_NOT_FOUND", "unknown approval request", {
        approval_id: options.approval_id,
      });
    }
    const provider = providerFor(issue.repository);
    if (provider === null) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "the repository provider has no reviewed delivery integration",
        { repository_id: issue.repository.repository_id },
      );
    }
    this.assertProviderUsable(provider);
    const delivery = machine.requestDelivery({
      operation_id: options.operation_id,
      actor: options.actor,
      issue_id: options.issue_id,
      candidate_id: options.candidate_id,
      approval_id: options.approval_id,
      target_branch: approval.binding.target_branch,
      provider,
      grant_id: options.grant_id,
      requester_authorized: options.requester_authorized,
    });
    return deliveryView(delivery);
  }

  /**
   * Perform the push and PR through the provider. The operation identity is
   * already durable; each write is preceded by a recorded state transition that
   * re-checks approval, permission, grant, audit, branch, and candidate
   * identity. No step writes to the repository base or merges anything.
   */
  async deliver(deliveryId: string, options: DeliverOptions): Promise<DeliveryView> {
    const delivery = this.requireDelivery(deliveryId);
    if (delivery.state !== "pending") {
      throw new CollabError(
        "DELIVERY_STATE_CONFLICT",
        `delivery is ${delivery.state}; only a pending operation starts a write`,
        { delivery_id: delivery.delivery_id, state: delivery.state },
      );
    }
    const provider = this.providerFor(delivery);
    const issue = this.requireIssue(delivery.issue_id);
    const candidate = this.requireCandidate(delivery);
    this.assertCandidateCurrent(delivery, candidate, issue.repository.base_sha);
    const branch = autofixerBranchFor(delivery.issue_id);
    const branchProblem = deliveryBranchProblem(issue.repository, issue.issue_id, branch);
    if (branchProblem !== null) {
      throw new CollabError("DELIVERY_FORBIDDEN", branchProblem, { branch });
    }

    // A crashed earlier attempt may already have published this exact commit
    // and PR while its state write was lost. Read provider evidence first so a
    // retry reconciles instead of opening a duplicate PR.
    const existingPr = await this.safeFindPullRequest(provider, delivery, branch);
    if (
      existingPr !== null &&
      existingPr.state === "open" &&
      existingPr.head_sha === delivery.head_sha &&
      existingPr.branch === branch
    ) {
      this.recordState(delivery, options, "pushing", {});
      // A PR alone is not proof of delivery: the provider branch must still
      // hold the approved commit. A missing or drifted branch is a confirmed
      // PR with an unconfirmed push, never `delivered`.
      let branchEvidence: ProviderBranchEvidence;
      try {
        branchEvidence = await provider.observeBranch(delivery.repository, branch);
      } catch {
        return deliveryView(
          this.recordState(delivery, options, "unknown", {
            branch: null,
            error_code: "PROVIDER_UNAVAILABLE",
          }),
        );
      }
      if (branchEvidence.head_sha !== delivery.head_sha) {
        return deliveryView(
          this.recordState(delivery, options, "partial", {
            branch,
            error_code: "PROVIDER_BRANCH_UNCONFIRMED",
          }),
        );
      }
      this.recordState(delivery, options, "opening_pr", { branch });
      return deliveryView(
        this.recordState(delivery, options, "delivered", {
          branch,
          pr_id: existingPr.pr_id,
          pr_url: existingPr.pr_url,
        }),
      );
    }

    this.recordState(delivery, options, "pushing", {});
    let outcome: PushBranchOutcome;
    try {
      outcome = await provider.pushBranch({
        repository: delivery.repository,
        branch,
        base_sha: candidate.base_sha,
        head_sha: delivery.head_sha,
        tree_sha: candidate.tree_sha,
        diff_digest: candidate.diff.digest,
      });
    } catch {
      return deliveryView(
        this.recordState(delivery, options, "unknown", {
          branch: null,
          error_code: "PROVIDER_UNAVAILABLE",
        }),
      );
    }
    if (outcome.status === "ambiguous") {
      return deliveryView(
        this.recordState(delivery, options, "unknown", {
          branch: null,
          error_code: "PROVIDER_PUSH_UNKNOWN",
        }),
      );
    }
    if (outcome.status === "failed") {
      return deliveryView(
        this.recordState(delivery, options, "failed", {
          error_code: outcome.error_code,
        }),
      );
    }

    // Verify the provider branch holds the approved commit before any PR is
    // created. Provider drift is an unknown outcome, never a delivered one.
    let branchEvidence: ProviderBranchEvidence;
    try {
      branchEvidence = await provider.observeBranch(delivery.repository, branch);
    } catch {
      return deliveryView(
        this.recordState(delivery, options, "unknown", {
          branch: null,
          error_code: "PROVIDER_UNAVAILABLE",
        }),
      );
    }
    if (branchEvidence.head_sha !== delivery.head_sha) {
      return deliveryView(
        this.recordState(delivery, options, "unknown", {
          branch: null,
          error_code: "PROVIDER_HEAD_MISMATCH",
        }),
      );
    }
    this.recordState(delivery, options, "opening_pr", { branch });

    let pr: ProviderPullRequestEvidence;
    try {
      pr = await provider.openPullRequest({
        repository: delivery.repository,
        branch,
        target_branch: delivery.target_branch,
        head_sha: delivery.head_sha,
        ...pullRequestCopy(delivery, candidate),
      });
    } catch {
      // The branch is pushed but PR creation is unconfirmed: an explicit
      // partial delivery, never success and never automatic deletion.
      return deliveryView(
        this.recordState(delivery, options, "partial", {
          branch,
          error_code: "PR_CREATION_FAILED",
        }),
      );
    }
    if (pr.head_sha !== delivery.head_sha || pr.branch !== branch) {
      return deliveryView(
        this.recordState(delivery, options, "partial", {
          branch,
          error_code: "PROVIDER_PR_MISMATCH",
        }),
      );
    }
    return deliveryView(
      this.recordState(delivery, options, "delivered", {
        branch,
        pr_id: pr.pr_id,
        pr_url: pr.pr_url,
      }),
    );
  }

  /**
   * Reconcile an ambiguous/partial outcome against provider evidence. This is
   * the only way out of `unknown`, and it performs no provider write: a safe
   * retry reconciles the same operation, never a new candidate or PR.
   */
  async reconcile(deliveryId: string, options: ReconcileOptions): Promise<DeliveryView> {
    const { machine } = this.options;
    const delivery = this.requireDelivery(deliveryId);
    if (delivery.state !== "unknown" && delivery.state !== "partial") {
      throw new CollabError(
        "DELIVERY_STATE_CONFLICT",
        `delivery state ${delivery.state} has nothing to reconcile`,
        { delivery_id: delivery.delivery_id, state: delivery.state },
      );
    }
    const provider = this.providerFor(delivery);
    const branch = delivery.branch ?? autofixerBranchFor(delivery.issue_id);
    let branchEvidence: ProviderBranchEvidence;
    let pr: ProviderPullRequestEvidence | null;
    try {
      branchEvidence = await provider.observeBranch(delivery.repository, branch);
      pr = await provider.findPullRequest(delivery.repository, branch, delivery.head_sha);
    } catch {
      throw new DeliveryProviderError();
    }
    const evidence = {
      branch_head_sha: branchEvidence.head_sha,
      pr_head_sha: pr?.head_sha ?? null,
      pr_branch: pr?.branch ?? null,
    };
    if (
      pr !== null &&
      pr.state === "open" &&
      pr.head_sha === delivery.head_sha &&
      pr.branch === branch &&
      branchEvidence.head_sha === delivery.head_sha
    ) {
      return deliveryView(
        machine.reconcileDelivery({
          operation_id: options.operation_id,
          actor: options.actor,
          delivery_id: delivery.delivery_id,
          to: "delivered",
          branch,
          pr_id: pr.pr_id,
          pr_url: pr.pr_url,
          error_code: null,
          evidence,
        }),
      );
    }
    if (branchEvidence.head_sha === delivery.head_sha) {
      return deliveryView(
        machine.reconcileDelivery({
          operation_id: options.operation_id,
          actor: options.actor,
          delivery_id: delivery.delivery_id,
          to: "partial",
          branch,
          pr_id: null,
          pr_url: null,
          error_code: "PR_NOT_OBSERVED",
          evidence,
        }),
      );
    }
    if (branchEvidence.head_sha === null && pr === null) {
      return deliveryView(
        machine.reconcileDelivery({
          operation_id: options.operation_id,
          actor: options.actor,
          delivery_id: delivery.delivery_id,
          to: "failed",
          branch: null,
          pr_id: null,
          pr_url: null,
          error_code: "NO_PROVIDER_SIDE_EFFECT",
          evidence,
        }),
      );
    }
    return deliveryView(
      machine.reconcileDelivery({
        operation_id: options.operation_id,
        actor: options.actor,
        delivery_id: delivery.delivery_id,
        to: "unknown",
        branch: delivery.branch,
        pr_id: null,
        pr_url: null,
        error_code: "PROVIDER_EVIDENCE_AMBIGUOUS",
        evidence,
      }),
    );
  }

  /** The external view of one delivery operation. */
  get(issueId: string, deliveryId: string): DeliveryView {
    const delivery = this.requireDelivery(deliveryId);
    if (delivery.issue_id !== issueId) {
      throw new CollabError("DELIVERY_NOT_FOUND", "unknown delivery operation", {
        delivery_id: deliveryId,
        issue_id: issueId,
      });
    }
    return deliveryView(delivery);
  }

  list(issueId: string): DeliveryView[] {
    return this.options.machine.listDeliveries(issueId).map(deliveryView);
  }

  // --------------------------------------------------------------- internals

  private requireDelivery(deliveryId: string): DeliveryRecord {
    const delivery = this.options.machine.getDelivery(deliveryId);
    if (!delivery) {
      throw new CollabError("DELIVERY_NOT_FOUND", "unknown delivery operation", {
        delivery_id: deliveryId,
      });
    }
    return delivery;
  }

  private requireIssue(issueId: string) {
    const issue = this.options.machine.getIssue(issueId);
    if (!issue) {
      throw new CollabError("ISSUE_NOT_FOUND", "unknown issue", { issue_id: issueId });
    }
    return issue;
  }

  private requireCandidate(delivery: DeliveryRecord): CandidateRecord {
    const candidate = this.options.machine.getCandidate(delivery.candidate_id);
    if (!candidate) {
      throw new CollabError("APPROVAL_BINDING_STALE", "the candidate no longer exists", {
        delivery_id: delivery.delivery_id,
      });
    }
    return candidate;
  }

  private assertCandidateCurrent(
    delivery: DeliveryRecord,
    candidate: CandidateRecord,
    issueBaseSha: string,
  ): void {
    const approval = this.options.machine.getApproval(delivery.approval_id);
    if (!approval) {
      throw new CollabError("APPROVAL_REQUIRED", "the delivery has no approval", {
        delivery_id: delivery.delivery_id,
      });
    }
    if (approval.consumed_by_delivery_id !== delivery.delivery_id) {
      throw new CollabError(
        "APPROVAL_BINDING_STALE",
        "the delivery does not hold its consumed approval",
        { delivery_id: delivery.delivery_id },
      );
    }
    if (approval.state === "invalidated" || approval.state === "cancelled") {
      throw new CollabError(
        "APPROVAL_BINDING_STALE",
        "the approval was invalidated before delivery",
        { approval_id: approval.approval_id },
      );
    }
    const mismatch = bindingMismatch(approval, candidate, issueBaseSha);
    if (mismatch !== null || candidate.head_sha !== delivery.head_sha) {
      throw new CollabError(
        "APPROVAL_BINDING_STALE",
        "the candidate or its base no longer matches the approved revision",
        { delivery_id: delivery.delivery_id, mismatch: mismatch ?? "head_sha" },
      );
    }
  }

  private providerFor(delivery: DeliveryRecord): DeliveryProvider {
    const provider = this.options.providers[delivery.provider];
    this.assertProviderUsable(delivery.provider, provider);
    if (provider === undefined) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "no reviewed delivery integration is configured for this provider",
        { provider: delivery.provider },
      );
    }
    if (provider.provider !== delivery.provider) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "the configured provider integration does not match the delivery record",
        { provider: delivery.provider },
      );
    }
    return provider;
  }

  private assertProviderUsable(
    providerType: "github" | "gitlab",
    provider?: DeliveryProvider,
  ): void {
    const candidate = provider ?? this.options.providers[providerType];
    if (candidate === undefined) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "no reviewed delivery integration is configured for this provider",
        { provider: providerType },
      );
    }
    if (
      !candidate.capabilities.push ||
      !candidate.capabilities.pull_request ||
      candidate.capabilities.repository_governance === "unsupported"
    ) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "provider governance or integration permissions leave delivery blocked",
        { provider: providerType },
      );
    }
    if (
      providerType === "gitlab" &&
      candidate.capabilities.repository_governance !== "gitlab_merge_request_mapping"
    ) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "GitLab delivery requires a reviewed merge-request governance mapping",
        { provider: providerType },
      );
    }
    if (
      providerType === "github" &&
      candidate.capabilities.repository_governance !== "github_branch_protection"
    ) {
      throw new CollabError(
        "DELIVERY_FORBIDDEN",
        "GitHub delivery requires reviewed branch-protection governance",
        { provider: providerType },
      );
    }
  }

  /** Authority and audit facts observed immediately before one write. */
  private authorityFacts(delivery: DeliveryRecord): {
    approver_authorized: boolean;
    delivery_authorized: boolean;
    audit_available: boolean;
  } {
    const approval = this.options.machine.getApproval(delivery.approval_id);
    const approver: UserRef | null = approval?.approver ?? null;
    let approverAuthorized = false;
    if (approver !== null) {
      const issue = this.requireIssue(delivery.issue_id);
      const fact = this.options.approvalDirectory.member(
        issue.workspace,
        delivery.repository.repository_id,
        approver.id,
      );
      approverAuthorized = isEligibleApprover(fact);
    }
    const deliveryAuthorized =
      this.options.deliveryAuthorized?.({
        issue_id: delivery.issue_id,
        repository_id: delivery.repository.repository_id,
        delivery_id: delivery.delivery_id,
      }) ?? false;
    // Fail closed: an unconfigured audit sink cannot prove the write is
    // auditable, so it blocks delivery instead of assuming availability.
    const auditAvailable = this.options.auditAvailable?.() ?? false;
    return {
      approver_authorized: approverAuthorized,
      delivery_authorized: deliveryAuthorized,
      audit_available: auditAvailable,
    };
  }

  private recordState(
    delivery: DeliveryRecord,
    options: DeliverOptions,
    to: "pushing" | "opening_pr" | "delivered" | "partial" | "unknown" | "failed" | "cancelled",
    fields: {
      branch?: string | null;
      pr_id?: string | null;
      pr_url?: string | null;
      error_code?: string | null;
    },
  ): DeliveryRecord {
    return this.options.machine.recordDeliveryState({
      operation_id: `${delivery.operation_id}:${to}:${randomUUID()}`,
      actor: options.actor,
      delivery_id: delivery.delivery_id,
      to,
      branch: fields.branch ?? null,
      pr_id: fields.pr_id ?? null,
      pr_url: fields.pr_url ?? null,
      error_code: fields.error_code ?? null,
      authority: this.authorityFacts(delivery),
    });
  }

  private async safeFindPullRequest(
    provider: DeliveryProvider,
    delivery: DeliveryRecord,
    branch: string,
  ): Promise<ProviderPullRequestEvidence | null> {
    try {
      return await provider.findPullRequest(delivery.repository, branch, delivery.head_sha);
    } catch {
      // A failed read is not evidence of absence; the push/PR path proceeds,
      // and an ambiguous creation outcome is recorded as unknown/partial.
      return null;
    }
  }
}
