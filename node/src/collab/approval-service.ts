import { approvalStateAt, compareApprovals } from "./approval.js";
import { CollabError } from "./errors.js";
import type { CollabMachine } from "./machine.js";
import type { ApprovalRecord, UserRef, WorkspaceScope } from "./types.js";

/**
 * Candidate-bound approval service (DAT-220, ADR-0007 "Approval and
 * delivery").
 *
 * This is the trusted composition boundary around the durable approval
 * commands. It observes current identity/membership facts through
 * {@link ApprovalDirectory}, selects the one eligible named human delivery
 * approver deterministically, and passes the observed authority facts into the
 * audited command. The machine never calls the directory itself, so a replay
 * reproduces exactly the recorded decision instead of consulting a directory
 * that has since changed.
 *
 * The service grants no authority by itself: eligibility is "current active
 * member with repository access and explicit delivery-approval authority",
 * never assignee/blame/team-leader status. A request with no eligible approver
 * is recorded unaddressed (`approver: null`) and alerts via the caller; it can
 * never be approved automatically.
 */

/** One current directory fact for a workspace member. */
export interface ApprovalMemberFact {
  user_id: string;
  display_name: string;
  /** Workspace role, recorded only as context; authority is explicit. */
  role: string;
  /** `active` for a live account; anything else is ineligible. */
  status: string;
  /** Current repository access verified from the provider roster. */
  repository_access: boolean;
  /** Explicit delivery-approval authority, not assignee/blame/leadership. */
  approval_authority: boolean;
}

/**
 * Fact source for approval eligibility. Implementations must resolve current
 * facts every call — there is no cache that can outlive a revocation.
 */
export interface ApprovalDirectory {
  /** Version of the policy/directory facts; recorded on every decision. */
  authorityVersion(scope: WorkspaceScope, repositoryId: string): string;
  /** Current members of the workspace, in any order. */
  members(scope: WorkspaceScope, repositoryId: string): ApprovalMemberFact[];
  /** One current member fact, or null when the user is unknown/departed. */
  member(scope: WorkspaceScope, repositoryId: string, userId: string): ApprovalMemberFact | null;
}

export function isEligibleApprover(fact: ApprovalMemberFact | null): fact is ApprovalMemberFact {
  return (
    fact !== null && fact.status === "active" && fact.repository_access && fact.approval_authority
  );
}

function userRefOf(fact: ApprovalMemberFact): UserRef {
  return { id: fact.user_id, display_name: fact.display_name };
}

function authorityFacts(
  fact: ApprovalMemberFact | null,
  authorityVersion: string,
): {
  member_active: boolean;
  repository_access: boolean;
  approval_authority: boolean;
  authority_version: string;
} {
  return {
    member_active: fact !== null && fact.status === "active",
    repository_access: fact?.repository_access ?? false,
    approval_authority: fact?.approval_authority ?? false,
    authority_version: authorityVersion,
  };
}

export interface ApprovalPage {
  items: ApprovalRecord[];
  next_cursor: string | null;
}

export interface ApprovalServiceOptions {
  pageSize?: number;
}

export interface RequestApprovalOptions {
  operation_id: string;
  actor: string;
  issue_id: string;
  candidate_id: string;
  target_branch?: string;
  /** Trusted selector; when absent the service picks the first eligible approver. */
  approver_user_id?: string;
}

export interface DecideApprovalOptions {
  operation_id: string;
  actor_user: UserRef;
  issue_id: string;
  approval_id: string;
  decision: "approve" | "reject";
  diff_digest: { algorithm: string; value: string };
  note?: string | null;
}

export interface ReassignApprovalOptions {
  operation_id: string;
  actor: string;
  issue_id: string;
  approval_id: string;
  new_approver_user_id: string;
  reason?: "authority_changed" | "content_changed";
}

export class ApprovalService {
  private readonly machine: CollabMachine;
  private readonly directory: ApprovalDirectory;
  private readonly pageSize: number;

  constructor(
    machine: CollabMachine,
    directory: ApprovalDirectory,
    options: ApprovalServiceOptions = {},
  ) {
    this.machine = machine;
    this.directory = directory;
    const pageSize = options.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new CollabError("INVALID_INPUT", "pageSize must be a positive integer", {
        field: "pageSize",
      });
    }
    this.pageSize = pageSize;
  }

  /** Read APIs expose the effective state, including derived expiry. */
  private view(approval: ApprovalRecord): ApprovalRecord {
    return {
      ...structuredClone(approval),
      state: approvalStateAt(approval, this.machine.now()),
    };
  }

  list(issueId: string): ApprovalRecord[] {
    return this.machine.listApprovals(issueId).map((approval) => this.view(approval));
  }

  page(issueId: string, cursor: string | null = null): ApprovalPage {
    const approvals = this.machine.listApprovals(issueId).sort(compareApprovals);
    let start = 0;
    if (cursor !== null && cursor !== "") {
      const index = approvals.findIndex((approval) => approval.approval_id === cursor);
      if (index === -1) {
        throw new CollabError("INVALID_CURSOR", "unknown approval cursor", { cursor });
      }
      start = index + 1;
    }
    const page = approvals.slice(start, start + this.pageSize);
    const last = page[page.length - 1];
    const more = start + page.length < approvals.length;
    return {
      items: page.map((approval) => this.view(approval)),
      next_cursor: last !== undefined && more ? last.approval_id : null,
    };
  }

  get(issueId: string, approvalId: string): ApprovalRecord {
    const approval = this.machine.getApproval(approvalId);
    if (!approval || approval.issue_id !== issueId) {
      throw new CollabError("APPROVAL_NOT_FOUND", "unknown approval request", {
        approval_id: approvalId,
        issue_id: issueId,
      });
    }
    return this.view(approval);
  }

  /**
   * Address one request to the named eligible human approver (or record an
   * unaddressed request when the workspace has none). The candidate must be
   * frozen, current, and already in `awaiting_change_approval`.
   */
  request(options: RequestApprovalOptions): ApprovalRecord {
    const issue = this.machine.getIssue(options.issue_id);
    if (!issue) {
      throw new CollabError("ISSUE_NOT_FOUND", "unknown issue", { issue_id: options.issue_id });
    }
    const candidate = this.machine.getCandidate(options.candidate_id);
    if (!candidate || candidate.issue_id !== issue.issue_id) {
      throw new CollabError("CANDIDATE_NOT_FOUND", "candidate is not frozen on this issue", {
        candidate_id: options.candidate_id,
      });
    }
    const scope = issue.workspace;
    const repositoryId = issue.repository.repository_id;
    const authorityVersion = this.directory.authorityVersion(scope, repositoryId);
    const members = this.directory.members(scope, repositoryId);
    let approverFact: ApprovalMemberFact | null = null;
    if (options.approver_user_id !== undefined) {
      const fact = this.directory.member(scope, repositoryId, options.approver_user_id);
      if (!isEligibleApprover(fact)) {
        throw new CollabError(
          "APPROVER_NOT_AUTHORIZED",
          "the named approver is not an eligible human delivery approver",
          { approver_user_id: options.approver_user_id },
        );
      }
      approverFact = fact;
    } else {
      const eligible = members
        .filter(isEligibleApprover)
        .sort((a, b) => a.user_id.localeCompare(b.user_id));
      approverFact = eligible[0] ?? null;
    }
    return this.machine.requestApproval({
      operation_id: options.operation_id,
      actor: options.actor,
      issue_id: issue.issue_id,
      candidate_id: candidate.candidate_id,
      target_branch: options.target_branch ?? issue.repository.base_ref,
      approver: approverFact === null ? null : userRefOf(approverFact),
      no_eligible_approver: approverFact === null && options.approver_user_id === undefined,
      authority: authorityFacts(approverFact, authorityVersion),
    });
  }

  /**
   * Record the addressed approver's confirmed decision. The caller identity is
   * the authenticated actor — never a body field — and current authority is
   * re-observed now, so a revoked approver cannot decide.
   */
  decide(options: DecideApprovalOptions): ApprovalRecord {
    const approval = this.get(options.issue_id, options.approval_id);
    const scope = approval.binding.workspace;
    const repositoryId = approval.binding.repository.repository_id;
    const authorityVersion = this.directory.authorityVersion(scope, repositoryId);
    const fact = this.directory.member(scope, repositoryId, options.actor_user.id);
    return this.machine.decideApproval({
      operation_id: options.operation_id,
      actor: options.actor_user.id,
      issue_id: options.issue_id,
      approval_id: options.approval_id,
      decision: options.decision,
      diff_digest: options.diff_digest,
      note: options.note ?? null,
      actor_user: options.actor_user,
      authority: authorityFacts(fact, authorityVersion),
    });
  }

  /** Invalidate an approval after a content, target, policy, or authority change. */
  invalidate(options: {
    operation_id: string;
    actor: string;
    issue_id: string;
    approval_id: string;
    reason:
      | "content_changed"
      | "test_evidence_changed"
      | "base_advanced"
      | "target_changed"
      | "policy_changed"
      | "authority_changed";
  }): ApprovalRecord {
    return this.machine.invalidateApproval({
      operation_id: options.operation_id,
      actor: options.actor,
      issue_id: options.issue_id,
      approval_id: options.approval_id,
      reason: options.reason,
    });
  }

  /**
   * Revoke a pending request and re-address the same candidate to a different
   * eligible approver. The old record stays invalidated forever, so the
   * previous addressee can never decide or deliver under it.
   */
  reassign(options: ReassignApprovalOptions): {
    invalidated: ApprovalRecord;
    created: ApprovalRecord | null;
  } {
    const approval = this.get(options.issue_id, options.approval_id);
    const scope = approval.binding.workspace;
    const repositoryId = approval.binding.repository.repository_id;
    const fact = this.directory.member(scope, repositoryId, options.new_approver_user_id);
    if (!isEligibleApprover(fact)) {
      throw new CollabError("APPROVER_NOT_AUTHORIZED", "the replacement approver is not eligible", {
        approver_user_id: options.new_approver_user_id,
      });
    }
    const invalidated = this.machine.invalidateApproval({
      operation_id: `${options.operation_id}:invalidate`,
      actor: options.actor,
      issue_id: options.issue_id,
      approval_id: options.approval_id,
      reason: options.reason ?? "authority_changed",
    });
    const created = this.machine.requestApproval({
      operation_id: `${options.operation_id}:request`,
      actor: options.actor,
      issue_id: options.issue_id,
      candidate_id: approval.candidate_id,
      target_branch: approval.binding.target_branch,
      approver: userRefOf(fact),
      no_eligible_approver: false,
      authority: authorityFacts(fact, this.directory.authorityVersion(scope, repositoryId)),
    });
    return { invalidated, created };
  }
}
