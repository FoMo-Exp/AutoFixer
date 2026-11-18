/**
 * A real, delivered candidate against a fake provider (DAT-266 tests).
 *
 * The fixture drives the product's own domain commands — candidate freeze,
 * candidate-bound approval, delivery grant, broker delivery — so the delivery,
 * candidate, approval, and evidence references are the same records production
 * writes. Only the provider is fake: its PR can be flipped to `merged` to model
 * the human merge, or made unreadable to model an outage.
 *
 * One context can own several deliveries, each on its own issue branch, so a
 * test can prove the watcher reaches a merge behind other open deliveries.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApprovalService } from "../../src/collab/approval-service.js";
import type { ApprovalDirectory, ApprovalMemberFact } from "../../src/collab/approval-service.js";
import { CandidateContentStore } from "../../src/collab/candidate-store.js";
import { DeliveryBroker } from "../../src/collab/delivery-broker.js";
import type {
  DeliveryProvider,
  DeliveryProviderCapabilities,
  OpenPullRequestInput,
  ProviderBranchEvidence,
  ProviderPullRequestEvidence,
  PushBranchInput,
  PushBranchOutcome,
} from "../../src/collab/delivery-broker.js";
import { CollabMachine } from "../../src/collab/machine.js";
import type { CandidateRecord, DeliveryRecord, IssueRecord } from "../../src/collab/types.js";
import type { WorkspaceScope } from "../../src/control-plane/types.js";
import {
  REPOSITORY,
  acquireLease,
  freezeCandidateInput,
  grantInput,
  leaseRef,
  op,
  openRun,
  planningIssue,
  registerTestPolicy,
  stoppedPreparation,
} from "../helpers/collab.js";

const APPROVER = "usr_approver";
const BASE_TIME = Date.parse("2026-11-03T00:00:10.000Z");

export class FakeDeliveryProvider implements DeliveryProvider {
  readonly provider = "github" as const;
  capabilities: DeliveryProviderCapabilities = {
    push: true,
    pull_request: true,
    repository_governance: "github_branch_protection",
  };
  branchHead: string | null = null;
  /** PRs by branch, so one context can hold several deliveries. */
  prs = new Map<string, ProviderPullRequestEvidence>();
  /** The most recently created PR, for single-delivery tests. */
  pr: ProviderPullRequestEvidence | null = null;
  /** Set to make every read fail, as a revoked credential or outage would. */
  unreadable = false;
  pushCalls: PushBranchInput[] = [];
  openCalls: OpenPullRequestInput[] = [];

  async observeBranch(): Promise<ProviderBranchEvidence> {
    if (this.unreadable) throw new Error("provider unavailable");
    return { head_sha: this.branchHead };
  }

  async pushBranch(input: PushBranchInput): Promise<PushBranchOutcome> {
    this.pushCalls.push({ ...input });
    this.branchHead = input.head_sha;
    return { status: "pushed", head_sha: input.head_sha };
  }

  async findPullRequest(
    _repository: unknown,
    branch: string,
  ): Promise<ProviderPullRequestEvidence | null> {
    if (this.unreadable) throw new Error("provider unavailable");
    const pr = this.prs.get(branch) ?? this.pr;
    return pr === null || pr === undefined ? null : { ...pr };
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<ProviderPullRequestEvidence> {
    this.openCalls.push({ ...input });
    const pr: ProviderPullRequestEvidence = {
      pr_id: `pr_${this.openCalls.length}`,
      pr_url: `https://github.com/FoMo-Exp/autofixer-delivery-test/pull/${this.openCalls.length}`,
      branch: input.branch,
      head_sha: input.head_sha,
      base_ref: input.target_branch,
      state: "open",
    };
    this.prs.set(input.branch, pr);
    this.pr = pr;
    return { ...pr };
  }
}

function member(userId: string): ApprovalMemberFact {
  return {
    user_id: userId,
    display_name: userId.replace("usr_", ""),
    role: "maintainer",
    status: "active",
    repository_access: true,
    approval_authority: true,
  };
}

class FixtureDirectory implements ApprovalDirectory {
  list: ApprovalMemberFact[] = [member(APPROVER)];
  authorityVersion(): string {
    return "2026-11-18.1";
  }
  members(): ApprovalMemberFact[] {
    return this.list.map((entry) => ({ ...entry }));
  }
  member(_scope: unknown, _repositoryId: string, userId: string): ApprovalMemberFact | null {
    const found = this.list.find((entry) => entry.user_id === userId);
    return found ? { ...found } : null;
  }
}

/** Shared state for one or more deliveries on the same collab machine. */
export interface DeliveryFixtureContext {
  machine: CollabMachine;
  provider: FakeDeliveryProvider;
  broker: DeliveryBroker;
  /** One registered policy version per workspace + repository. */
  policies: Map<string, string>;
  /** Advance the fixture clock so delivery order is deterministic. */
  tick(): void;
  close(): void;
}

export interface DeliveryMergeFixture {
  machine: CollabMachine;
  provider: FakeDeliveryProvider;
  broker: DeliveryBroker;
  issue: IssueRecord;
  candidate: CandidateRecord;
  delivery: DeliveryRecord;
  /** Flip this delivery's provider PR to merged; the human act observed. */
  merge(): void;
  close(): void;
}

export function createDeliveryFixtureContext(): DeliveryFixtureContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-dat266-"));
  const store = new CandidateContentStore(path.join(root, "candidates"));
  // A fixed, slowly advancing clock inside the fixture grant's validity
  // window: the records are the product's, but their times are deterministic.
  let clock = BASE_TIME;
  const machine = new CollabMachine({
    candidateStore: store,
    now: () => new Date(clock),
  });
  const provider = new FakeDeliveryProvider();
  const directory = new FixtureDirectory();
  const broker = new DeliveryBroker({
    machine,
    providers: { github: provider },
    approvalDirectory: directory,
    candidateContent: { read: (digest) => store.read(digest) },
    deliveryAuthorized: () => true,
    auditAvailable: () => true,
  });
  return {
    machine,
    provider,
    broker,
    policies: new Map(),
    tick() {
      clock += 1000;
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create one issue → stopped preparation → frozen candidate → approved →
 * delivered PR bound to `scope`. The provider's PR starts `open`.
 *
 * Pass the same `context` to create several deliveries; each gets a later
 * created_at and its own issue-scoped branch.
 */
export async function createDeliveryMergeFixture(
  scope: WorkspaceScope,
  context: DeliveryFixtureContext = createDeliveryFixtureContext(),
): Promise<DeliveryMergeFixture & { context: DeliveryFixtureContext }> {
  context.tick();
  const { machine, provider, broker } = context;
  const directory = new FixtureDirectory();
  const approvalService = new ApprovalService(machine, directory);
  const issue = planningIssue(machine, {
    workspace: {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
    },
    repository: REPOSITORY,
    // Each fixture is a distinct issue; the dedupe key is the issue identity.
    dedupe_key: op(),
  });
  const policyKey = `${scope.enterprise_id}/${scope.workspace_id}/${REPOSITORY.repository_id}`;
  const existingPolicy = context.policies.get(policyKey);
  const policyId =
    existingPolicy ?? registerTestPolicy(machine, { workspace: issue.workspace }).policy_id;
  context.policies.set(policyKey, policyId);
  const task = machine.addTask({
    operation_id: op(),
    actor: "orchestrator:planner",
    issue_id: issue.issue_id,
    role: "implementation",
  });
  const worktreeId = op();
  const preparation = stoppedPreparation(machine, issue.issue_id, {
    policyId,
    taskId: task.task_id,
    worktreeId,
    worktreePath: `/tmp/worktrees/${worktreeId}`,
  });
  const candidate = machine.freezeCandidate(freezeCandidateInput(preparation));
  machine.transitionIssue({
    operation_id: op(),
    actor: "human:operator",
    issue_id: issue.issue_id,
    to: "validating",
    reason: null,
  });
  machine.transitionIssue({
    operation_id: op(),
    actor: "human:operator",
    issue_id: issue.issue_id,
    to: "awaiting_change_approval",
    reason: null,
  });
  const request = approvalService.request({
    operation_id: op(),
    actor: "orchestrator:approval",
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    target_branch: REPOSITORY.base_ref,
    approver_user_id: APPROVER,
  });
  approvalService.decide({
    operation_id: op(),
    actor_user: { id: APPROVER, display_name: "approver" },
    issue_id: issue.issue_id,
    approval_id: request.approval_id,
    decision: "approve",
    diff_digest: request.binding.diff_digest,
  });
  const deliveryRun = openRun(machine, issue.issue_id, { role: "delivery" });
  const lease = leaseRef(acquireLease(machine, deliveryRun.run_id, "worker:delivery"));
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:delivery",
    run_id: deliveryRun.run_id,
    lease,
    to: "approved",
    head_sha: candidate.head_sha,
  });
  const grant = machine.recordGrant({
    operation_id: op(),
    actor: "worker:delivery",
    run_id: deliveryRun.run_id,
    lease,
    grant: grantInput({ may_create_or_update_pr: true }),
  });
  const requested = broker.request({
    operation_id: op(),
    actor: "orchestrator:delivery",
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    approval_id: request.approval_id,
    grant_id: grant.grant_id,
    requester_authorized: true,
  });
  await broker.deliver(requested.delivery_id, { actor: "broker:delivery" });
  const delivery = machine.getDelivery(requested.delivery_id);
  if (delivery === undefined) {
    throw new Error("fixture delivery was not recorded");
  }
  return {
    context,
    machine,
    provider,
    broker,
    issue,
    candidate,
    delivery,
    merge() {
      const branch = delivery.branch;
      if (branch === null) return;
      const pr = provider.prs.get(branch);
      if (pr !== undefined) provider.prs.set(branch, { ...pr, state: "merged" });
      if (provider.pr?.branch === branch) provider.pr = { ...provider.pr, state: "merged" };
    },
    close() {
      context.close();
    },
  };
}
