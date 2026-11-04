import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ApprovalService } from "../src/collab/approval-service.js";
import type { ApprovalDirectory, ApprovalMemberFact } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { DeliveryBroker } from "../src/collab/delivery-broker.js";
import type {
  DeliveryProvider,
  DeliveryProviderCapabilities,
  OpenPullRequestInput,
  ProviderBranchEvidence,
  ProviderPullRequestEvidence,
  PushBranchInput,
  PushBranchOutcome,
} from "../src/collab/delivery-broker.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { ApprovalRecord, CandidateRecord, IssueRecord } from "../src/collab/types.js";
import { autofixerBranchFor } from "../src/collab/types.js";
import {
  REPOSITORY,
  Clock,
  acquireLease,
  freezeCandidateInput,
  grantInput,
  leaseRef,
  op,
  openRun,
  planningIssue,
  stoppedPreparation,
} from "./helpers/collab.js";

/**
 * Broker-controlled delivery (DAT-220).
 *
 * Every test drives the real domain commands; the fake provider records every
 * write it receives, so a control that exists only in prose cannot pass.
 */

const ERIN = "usr_erin";
const OTHER_HEAD = "f".repeat(40);

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

class FakeDirectory implements ApprovalDirectory {
  membersList: ApprovalMemberFact[] = [member(ERIN)];

  authorityVersion(): string {
    return "2026-11-04.1";
  }

  members(): ApprovalMemberFact[] {
    return this.membersList.map((entry) => ({ ...entry }));
  }

  member(_scope: unknown, _repositoryId: string, userId: string): ApprovalMemberFact | null {
    const found = this.membersList.find((entry) => entry.user_id === userId);
    return found ? { ...found } : null;
  }
}

class FakeProvider implements DeliveryProvider {
  readonly provider = "github" as const;
  capabilities: DeliveryProviderCapabilities = {
    push: true,
    pull_request: true,
    repository_governance: "github_branch_protection",
  };
  branchHead: string | null = null;
  pr: ProviderPullRequestEvidence | null = null;
  pushMode: "pushed" | "failed" | "ambiguous" | "throw" | "wrong_head" = "pushed";
  prMode: "ok" | "throw" | "wrong_head" | "created_then_throw" = "ok";
  pushCalls: PushBranchInput[] = [];
  openCalls: OpenPullRequestInput[] = [];
  observeCalls = 0;

  async observeBranch(): Promise<ProviderBranchEvidence> {
    this.observeCalls += 1;
    return { head_sha: this.branchHead };
  }

  async pushBranch(input: PushBranchInput): Promise<PushBranchOutcome> {
    this.pushCalls.push({ ...input });
    if (this.pushMode === "throw") {
      throw new Error("provider write timed out");
    }
    if (this.pushMode === "failed") {
      return { status: "failed", error_code: "PROVIDER_REJECTED" };
    }
    if (this.pushMode === "ambiguous") {
      return { status: "ambiguous", error_code: "PROVIDER_PUSH_UNKNOWN" };
    }
    this.branchHead = this.pushMode === "wrong_head" ? OTHER_HEAD : input.head_sha;
    return { status: "pushed", head_sha: this.branchHead };
  }

  async findPullRequest(): Promise<ProviderPullRequestEvidence | null> {
    return this.pr;
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<ProviderPullRequestEvidence> {
    this.openCalls.push({ ...input });
    if (this.prMode === "throw") {
      throw new Error("PR creation timed out");
    }
    const pr: ProviderPullRequestEvidence = {
      pr_id: "pr_1",
      pr_url: "https://github.com/Luthiel/AutoFixer/pull/1",
      branch: input.branch,
      head_sha: this.prMode === "wrong_head" ? OTHER_HEAD : input.head_sha,
      state: "open",
    };
    this.pr = pr;
    if (this.prMode === "created_then_throw") {
      throw new Error("PR created but response lost");
    }
    return pr;
  }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new Error("expectCode received a promise");
    }
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

interface Fixture {
  root: string;
  clock: Clock;
  machine: CollabMachine;
  directory: FakeDirectory;
  approvalService: ApprovalService;
  provider: FakeProvider;
  broker: DeliveryBroker;
  issue: IssueRecord;
  candidate: CandidateRecord;
  approval: ApprovalRecord;
  grantId: string;
  runId: string;
}

interface SetupOptions {
  ttlSeconds?: number;
  /** Skip the approval decision so the request stays pending. */
  pendingApproval?: boolean;
  reject?: boolean;
  /** Register the delivery grant with these overrides. */
  grant?: {
    role?: "delivery" | "implementation";
    mayCreateOrUpdatePr?: boolean;
    headSha?: string;
    expiresAt?: string;
  };
  /** Do not register any delivery grant. */
  withoutGrant?: boolean;
  deliveryAuthorized?: boolean;
  auditAvailable?: boolean;
}

let root = "";

function setup(options: SetupOptions = {}): Fixture {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-delivery-"));
  const clock = new Clock();
  const machine = new CollabMachine({
    candidateStore: new CandidateContentStore(path.join(root, "candidates")),
    now: clock.now,
    ...(options.ttlSeconds !== undefined ? { approvalTtlSeconds: options.ttlSeconds } : {}),
  });
  const directory = new FakeDirectory();
  const approvalService = new ApprovalService(machine, directory);
  const issue = planningIssue(machine);
  const context = stoppedPreparation(machine, issue.issue_id);
  const candidate = machine.freezeCandidate(freezeCandidateInput(context));
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

  const approval = approvalService.request({
    operation_id: op(),
    actor: "orchestrator:approval",
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    target_branch: REPOSITORY.base_ref,
    approver_user_id: ERIN,
  });
  if (options.pendingApproval !== true) {
    approvalService.decide({
      operation_id: op(),
      actor_user: { id: ERIN, display_name: "erin" },
      issue_id: issue.issue_id,
      approval_id: approval.approval_id,
      decision: options.reject === true ? "reject" : "approve",
      diff_digest: approval.binding.diff_digest,
    });
  }

  let grantId = "";
  let runId = "";
  if (options.withoutGrant !== true) {
    const run = openRun(machine, issue.issue_id, {
      role: options.grant?.role ?? "delivery",
    });
    runId = run.run_id;
    const lease = leaseRef(acquireLease(machine, run.run_id, "worker:delivery"));
    machine.recordRunState({
      operation_id: op(),
      actor: "worker:delivery",
      run_id: run.run_id,
      lease,
      to: "approved",
      head_sha: options.grant?.headSha ?? candidate.head_sha,
    });
    const grant = machine.recordGrant({
      operation_id: op(),
      actor: "worker:delivery",
      run_id: run.run_id,
      lease,
      grant: grantInput({
        may_create_or_update_pr: options.grant?.mayCreateOrUpdatePr ?? true,
        ...(options.grant?.expiresAt !== undefined ? { expires_at: options.grant.expiresAt } : {}),
      }),
    });
    grantId = grant.grant_id;
  }

  const provider = new FakeProvider();
  const broker = new DeliveryBroker({
    machine,
    providers: { github: provider },
    approvalDirectory: directory,
    deliveryAuthorized: () => options.deliveryAuthorized ?? true,
    auditAvailable: () => options.auditAvailable ?? true,
  });

  return {
    root,
    clock,
    machine,
    directory,
    approvalService,
    provider,
    broker,
    issue: machine.getIssue(issue.issue_id) as IssueRecord,
    candidate,
    approval: machine.getApproval(approval.approval_id) as ApprovalRecord,
    grantId,
    runId,
  };
}

afterEach(() => {
  if (root !== "") {
    fs.rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function requestDelivery(
  f: Fixture,
  overrides: { operation_id?: string; approval_id?: string } = {},
) {
  return f.broker.request({
    operation_id: overrides.operation_id ?? op(),
    actor: "orchestrator:delivery",
    issue_id: f.issue.issue_id,
    candidate_id: f.candidate.candidate_id,
    approval_id: overrides.approval_id ?? f.approval.approval_id,
    grant_id: f.grantId === "" ? "grt_missing" : f.grantId,
    requester_authorized: true,
  });
}

describe("delivery requires a current candidate-bound approval", () => {
  test("an unknown approval cannot start a delivery", () => {
    const f = setup();
    expectCode(() => requestDelivery(f, { approval_id: "apr_unknown" }), "APPROVAL_NOT_FOUND");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a pending approval is not enough", () => {
    const f = setup({ pendingApproval: true });
    expectCode(() => requestDelivery(f), "APPROVAL_NOT_APPROVED");
    expect(f.machine.listDeliveries(f.issue.issue_id)).toHaveLength(0);
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a rejected approval refuses delivery", () => {
    const f = setup({ reject: true });
    expectCode(() => requestDelivery(f), "APPROVAL_NOT_APPROVED");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("an expired approval refuses delivery", () => {
    const f = setup({ ttlSeconds: 60 });
    f.clock.advance(61);
    expectCode(() => requestDelivery(f), "APPROVAL_NOT_APPROVED");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a candidate invalidated after approval refuses delivery", () => {
    const f = setup();
    f.machine.invalidateCandidate({
      operation_id: op(),
      actor: "system:control-plane",
      candidate_id: f.candidate.candidate_id,
      reason: "content_changed",
    });
    expectCode(() => requestDelivery(f), "APPROVAL_NOT_APPROVED");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a base advance after approval refuses delivery", () => {
    const f = setup();
    f.machine.recordBaseAdvance({
      operation_id: op(),
      actor: "orchestrator:repository",
      issue_id: f.issue.issue_id,
      base_sha: "a".repeat(40),
    });
    expectCode(() => requestDelivery(f), "APPROVAL_NOT_APPROVED");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("an approval is consumed exactly once; a second delivery is refused", () => {
    const f = setup();
    const first = requestDelivery(f);
    expect(f.machine.getApproval(f.approval.approval_id)?.state).toBe("consumed");
    expect(f.machine.getApproval(f.approval.approval_id)?.consumed_by_delivery_id).toBe(
      first.delivery_id,
    );
    expectCode(() => requestDelivery(f), "APPROVAL_CONSUMED");
    expect(f.machine.listDeliveries(f.issue.issue_id)).toHaveLength(1);
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a safe retry with the same operation identity returns the same delivery", () => {
    const f = setup();
    const operationId = op();
    const first = requestDelivery(f, { operation_id: operationId });
    const second = requestDelivery(f, { operation_id: operationId });
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(f.machine.listDeliveries(f.issue.issue_id)).toHaveLength(1);
  });

  test("a missing or unusable delivery grant is refused", () => {
    const missing = setup({ withoutGrant: true });
    expectCode(() => requestDelivery(missing), "GRANT_NOT_FOUND");

    const noPr = setup({ grant: { mayCreateOrUpdatePr: false } });
    expectCode(() => requestDelivery(noPr), "DELIVERY_FORBIDDEN");

    const wrongHead = setup({ grant: { headSha: OTHER_HEAD } });
    expectCode(() => requestDelivery(wrongHead), "DELIVERY_FORBIDDEN");

    const wrongRole = setup({ grant: { role: "implementation" } });
    expectCode(() => requestDelivery(wrongRole), "DELIVERY_FORBIDDEN");
  });

  test("an expired or revoked grant never authorizes delivery", () => {
    const expired = setup({
      grant: { expiresAt: "2026-11-03T00:10:00.000Z" },
    });
    expired.clock.advance(601);
    expectCode(() => requestDelivery(expired), "GRANT_EXPIRED");

    const revoked = setup();
    revoked.machine.revokeGrant({
      operation_id: op(),
      actor: "system:control-plane",
      run_id: revoked.runId,
      grant_id: revoked.grantId,
      reason: "operator revoked delivery",
    });
    expectCode(() => requestDelivery(revoked), "GRANT_REVOKED");
  });

  test("the requester needs trusted delivery authority", () => {
    const f = setup();
    expectCode(
      () =>
        f.broker.request({
          operation_id: op(),
          actor: "untrained:agent",
          issue_id: f.issue.issue_id,
          candidate_id: f.candidate.candidate_id,
          approval_id: f.approval.approval_id,
          grant_id: f.grantId,
          requester_authorized: false,
        }),
      "DELIVERY_FORBIDDEN",
    );
  });

  test("delivery never writes the base/main branch or an arbitrary branch", () => {
    const f = setup();
    const base = {
      actor: "orchestrator:delivery",
      issue_id: f.issue.issue_id,
      candidate_id: f.candidate.candidate_id,
      approval_id: f.approval.approval_id,
      target_branch: REPOSITORY.base_ref,
      provider: "github" as const,
      grant_id: f.grantId,
      requester_authorized: true,
    };
    expectCode(
      () =>
        f.machine.requestDelivery({
          ...base,
          operation_id: op(),
          branch: REPOSITORY.base_ref,
        }),
      "DELIVERY_FORBIDDEN",
    );
    expectCode(
      () =>
        f.machine.requestDelivery({
          ...base,
          operation_id: op(),
          branch: "feature/anything",
        }),
      "INVALID_INPUT",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });
});

describe("broker-controlled push and PR", () => {
  test("the happy path publishes exactly the approved commit and opens one PR", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    const branch = autofixerBranchFor(f.issue.issue_id);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("delivered");
    expect(view.branch).toBe(branch);
    expect(view.head_sha).toBe(f.candidate.head_sha);
    expect(view.pr_id).toBe("pr_1");
    expect(f.provider.pushCalls).toHaveLength(1);
    expect(f.provider.pushCalls[0]).toMatchObject({
      branch,
      base_sha: f.candidate.base_sha,
      head_sha: f.candidate.head_sha,
      tree_sha: f.candidate.tree_sha,
      diff_digest: f.candidate.diff.digest,
    });
    expect(f.provider.openCalls).toHaveLength(1);
    expect(f.provider.openCalls[0]).toMatchObject({
      branch,
      target_branch: REPOSITORY.base_ref,
      head_sha: f.candidate.head_sha,
    });
    const states = f.machine
      .auditLog()
      .filter((record) => record.command === "record_delivery_state")
      .map((record) => record.payload["to"]);
    expect(states).toEqual(["pushing", "opening_pr", "delivered"]);
  });

  test("the broker has no merge or main-branch operation", () => {
    const f = setup();
    const broker = f.broker as unknown as Record<string, unknown>;
    expect(broker["merge"]).toBeUndefined();
    expect(broker["mergePullRequest"]).toBeUndefined();
    expect(f.provider).not.toHaveProperty("mergePullRequest");
  });

  test("an ambiguous push is unknown, not success, and is never auto-retried", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.provider.pushMode = "ambiguous";
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("unknown");
    expect(view.error_code).toBe("PROVIDER_PUSH_UNKNOWN");
    expect(f.provider.openCalls).toHaveLength(0);
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_STATE_CONFLICT",
    );
    expect(f.provider.pushCalls).toHaveLength(1);
  });

  test("a failed PR creation after a pushed branch is partial, then reconciles to delivered without a duplicate", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.provider.prMode = "created_then_throw";
    const partial = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(partial.state).toBe("partial");
    expect(partial.branch).toBe(autofixerBranchFor(f.issue.issue_id));
    expect(partial.error_code).toBe("PR_CREATION_FAILED");
    expect(f.provider.pushCalls).toHaveLength(1);
    expect(f.provider.openCalls).toHaveLength(1);

    const reconciled = await f.broker.reconcile(delivery.delivery_id, {
      operation_id: op(),
      actor: "broker:reconcile",
    });
    expect(reconciled.state).toBe("delivered");
    expect(reconciled.pr_id).toBe("pr_1");
    expect(reconciled.reconciled_at).not.toBeNull();
    // Reconciliation performs provider reads only: no second push or PR.
    expect(f.provider.pushCalls).toHaveLength(1);
    expect(f.provider.openCalls).toHaveLength(1);
  });

  test("a pushed branch without a PR reconciles to partial, never delivered", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.provider.pushMode = "ambiguous";
    await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    // The provider actually accepted the push; no PR exists.
    f.provider.branchHead = f.candidate.head_sha;
    const partial = await f.broker.reconcile(delivery.delivery_id, {
      operation_id: op(),
      actor: "broker:reconcile",
    });
    expect(partial.state).toBe("partial");
    expect(partial.error_code).toBe("PR_NOT_OBSERVED");
    expect(f.provider.openCalls).toHaveLength(0);
  });

  test("reconciliation proves an unknown outcome had no side effect", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.provider.pushMode = "ambiguous";
    await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    f.provider.branchHead = null;
    const failed = await f.broker.reconcile(delivery.delivery_id, {
      operation_id: op(),
      actor: "broker:reconcile",
    });
    expect(failed.state).toBe("failed");
    expect(failed.error_code).toBe("NO_PROVIDER_SIDE_EFFECT");
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_STATE_CONFLICT",
    );
  });

  test("provider head drift is unknown and never opens a PR", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.provider.pushMode = "wrong_head";
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("unknown");
    expect(view.error_code).toBe("PROVIDER_HEAD_MISMATCH");
    expect(f.provider.openCalls).toHaveLength(0);
  });

  test("a PR bound to another head is partial, never delivered", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.provider.prMode = "wrong_head";
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("partial");
    expect(view.error_code).toBe("PROVIDER_PR_MISMATCH");
  });

  test("reconciliation refuses a delivery that has nothing to reconcile", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    await expectCodeAsync(
      () => f.broker.reconcile(delivery.delivery_id, { operation_id: op(), actor: "broker" }),
      "DELIVERY_STATE_CONFLICT",
    );
    await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    await expectCodeAsync(
      () => f.broker.reconcile(delivery.delivery_id, { operation_id: op(), actor: "broker" }),
      "DELIVERY_STATE_CONFLICT",
    );
  });
});

describe("pre-write authority, grant, audit, and branch checks", () => {
  test("a grant that expires between request and write blocks the push", async () => {
    const f = setup({ grant: { expiresAt: "2026-11-03T00:10:00.000Z" } });
    const delivery = requestDelivery(f);
    f.clock.advance(601);
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "GRANT_EXPIRED",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a revoked approver blocks the write even though the approval was consumed", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.directory.membersList = [{ ...member(ERIN), approval_authority: false }];
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_FORBIDDEN",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("an unavailable audit sink blocks the write", async () => {
    const f = setup({ auditAvailable: false });
    const delivery = requestDelivery(f);
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_AUDIT_UNAVAILABLE",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("missing trusted delivery permission blocks the write", async () => {
    const f = setup({ deliveryAuthorized: false });
    const delivery = requestDelivery(f);
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_FORBIDDEN",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("unsupported provider governance leaves delivery blocked", () => {
    const f = setup();
    f.provider.capabilities.repository_governance = "unsupported";
    expectCode(() => requestDelivery(f), "DELIVERY_FORBIDDEN");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("cancelling the issue cancels an undelivered operation", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    f.machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: f.issue.issue_id,
      to: "cancelled",
      reason: "operator cancelled the issue",
    });
    expect(f.machine.getDelivery(delivery.delivery_id)?.state).toBe("cancelled");
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_STATE_CONFLICT",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("delivery replay reproduces the same state and digest", async () => {
    const f = setup();
    const delivery = requestDelivery(f);
    await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    const rebuilt = CollabMachine.fromAudit(f.machine.auditLog(), {
      candidateStore: new CandidateContentStore(path.join(root, "replay-store")),
    });
    expect(rebuilt.snapshotDigest()).toBe(f.machine.snapshotDigest());
    expect(rebuilt.getDelivery(delivery.delivery_id)).toEqual(
      f.machine.getDelivery(delivery.delivery_id),
    );
  });
});
