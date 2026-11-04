import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ApprovalService } from "../src/collab/approval-service.js";
import type { ApprovalDirectory, ApprovalMemberFact } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { ApprovalRecord, CandidateRecord, IssueRecord } from "../src/collab/types.js";
import {
  REPOSITORY,
  WORKSPACE,
  Clock,
  freezeCandidateInput,
  op,
  planningIssue,
  stoppedPreparation,
} from "./helpers/collab.js";
import type { PreparationContext } from "./helpers/collab.js";

/**
 * Candidate-bound human approval (DAT-220).
 *
 * The tests exercise the durable approval command path, not just the service:
 * a requirement that only exists in a client or in prose is not a control.
 */

const ERIN = "usr_erin";
const FRANK = "usr_frank";
const ZOE = "usr_zoe";

function member(userId: string, overrides: Partial<ApprovalMemberFact> = {}): ApprovalMemberFact {
  return {
    user_id: userId,
    display_name: userId.replace("usr_", ""),
    role: "maintainer",
    status: "active",
    repository_access: true,
    approval_authority: true,
    ...overrides,
  };
}

class FakeDirectory implements ApprovalDirectory {
  membersList: ApprovalMemberFact[] = [member(ERIN), member(FRANK)];

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

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
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
  service: ApprovalService;
  issue: IssueRecord;
  candidate: CandidateRecord;
  context: PreparationContext;
}

let root: string;

function fixture(options: { ttlSeconds?: number } = {}): Fixture {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-approval-"));
  const clock = new Clock();
  const machine = new CollabMachine({
    candidateStore: new CandidateContentStore(path.join(root, "candidates")),
    now: clock.now,
    ...(options.ttlSeconds !== undefined ? { approvalTtlSeconds: options.ttlSeconds } : {}),
  });
  const directory = new FakeDirectory();
  const service = new ApprovalService(machine, directory);
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
  return {
    root,
    clock,
    machine,
    directory,
    service,
    issue: machine.getIssue(issue.issue_id) as IssueRecord,
    candidate,
    context,
  };
}

beforeEach(() => {
  root = "";
});

afterEach(() => {
  if (root !== "") {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function request(f: Fixture, approverUserId = ERIN): ApprovalRecord {
  return f.service.request({
    operation_id: op(),
    actor: "orchestrator:approval",
    issue_id: f.issue.issue_id,
    candidate_id: f.candidate.candidate_id,
    target_branch: REPOSITORY.base_ref,
    approver_user_id: approverUserId,
  });
}

function decide(
  f: Fixture,
  approval: ApprovalRecord,
  userId = ERIN,
  diffDigest = approval.binding.diff_digest,
  decision: "approve" | "reject" = "approve",
): ApprovalRecord {
  return f.service.decide({
    operation_id: op(),
    actor_user: { id: userId, display_name: userId.replace("usr_", "") },
    issue_id: f.issue.issue_id,
    approval_id: approval.approval_id,
    decision,
    diff_digest: diffDigest,
  });
}

describe("candidate-bound approval request (DAT-220)", () => {
  test("an eligible named human is addressed and the binding freezes every digest", () => {
    const f = fixture();
    const approval = request(f);
    expect(approval.state).toBe("pending");
    expect(approval.approver).toEqual({ id: ERIN, display_name: "erin" });
    expect(approval.binding).toMatchObject({
      workspace: WORKSPACE,
      repository: REPOSITORY,
      candidate_id: f.candidate.candidate_id,
      head_sha: f.candidate.head_sha,
      diff_digest: { algorithm: "sha256", value: f.candidate.diff.digest },
      target_branch: REPOSITORY.base_ref,
      policy_version: f.candidate.test_policy.policy_version,
    });
    expect(approval.binding.test_evidence_digest.algorithm).toBe("sha256");
    expect(approval.binding.test_evidence_digest.value).toHaveLength(64);
    // default 24h TTL, from trusted configuration and never from the caller
    expect(Date.parse(approval.expires_at) - Date.parse(approval.requested_at)).toBe(86_400_000);
    expect(approval.consumed_by_delivery_id).toBeNull();
  });

  test("only the addressed approver may decide", () => {
    const f = fixture();
    const approval = request(f);
    expectCode(() => decide(f, approval, FRANK), "APPROVER_NOT_AUTHORIZED");
    expectCode(() => decide(f, approval, ZOE), "APPROVER_NOT_AUTHORIZED");
    expect(f.service.get(f.issue.issue_id, approval.approval_id).state).toBe("pending");
  });

  test("the decision must restate the reviewed diff digest", () => {
    const f = fixture();
    const approval = request(f);
    expectCode(
      () => decide(f, approval, ERIN, { algorithm: "sha256", value: "ab".repeat(32) }),
      "APPROVAL_BINDING_STALE",
    );
    expect(f.service.get(f.issue.issue_id, approval.approval_id).state).toBe("pending");
  });

  test("an approved candidate records the confirmed decision", () => {
    const f = fixture();
    const approval = request(f);
    const approved = decide(f, approval);
    expect(approved.state).toBe("approved");
    expect(approved.decision).toMatchObject({
      decision: "approve",
      decided_by: { id: ERIN },
    });
    expect(approved.decided_at).toBe(approved.decision?.decided_at);
    expect(f.machine.approvalState(approval.approval_id)).toBe("approved");
  });

  test("a rejection refuses delivery and is never revived", () => {
    const f = fixture();
    const approval = request(f);
    expect(decide(f, approval, ERIN, approval.binding.diff_digest, "reject").state).toBe(
      "rejected",
    );
    expectCode(() => decide(f, approval), "APPROVAL_STATE_CONFLICT");
  });

  test("a second decision from another operation id is a state conflict", () => {
    const f = fixture();
    const approval = request(f);
    decide(f, approval);
    expectCode(() => decide(f, approval), "APPROVAL_STATE_CONFLICT");
    expect(f.machine.listApprovals(f.issue.issue_id)).toHaveLength(1);
  });

  test("the finite TTL expires an approved request without a command", () => {
    const f = fixture({ ttlSeconds: 60 });
    const approval = request(f);
    decide(f, approval);
    f.clock.advance(61);
    expect(f.machine.approvalState(approval.approval_id)).toBe("expired");
    expect(f.service.get(f.issue.issue_id, approval.approval_id).state).toBe("expired");
    expectCode(() => decide(f, approval), "APPROVAL_STATE_CONFLICT");
  });

  test("a revoked approver can no longer decide", () => {
    const f = fixture();
    const approval = request(f);
    f.directory.membersList = [member(ERIN, { approval_authority: false }), member(FRANK)];
    expectCode(() => decide(f, approval), "APPROVER_NOT_AUTHORIZED");
  });

  test("the request cannot name a member without explicit approval authority", () => {
    const f = fixture();
    expectCode(
      () =>
        f.service.request({
          operation_id: op(),
          actor: "orchestrator:approval",
          issue_id: f.issue.issue_id,
          candidate_id: f.candidate.candidate_id,
          approver_user_id: ZOE,
        }),
      "APPROVER_NOT_AUTHORIZED",
    );
  });

  test("with no eligible approver the request is unaddressed and cannot be decided", () => {
    const f = fixture();
    f.directory.membersList = [];
    const approval = f.service.request({
      operation_id: op(),
      actor: "orchestrator:approval",
      issue_id: f.issue.issue_id,
      candidate_id: f.candidate.candidate_id,
    });
    expect(approval.approver).toBeNull();
    expect(approval.state).toBe("pending");
    expectCode(() => decide(f, approval), "APPROVER_NOT_AUTHORIZED");
    expect(f.machine.approvalState(approval.approval_id)).toBe("pending");
  });

  test("one candidate holds one actionable request at a time", () => {
    const f = fixture();
    request(f);
    expectCode(() => request(f), "APPROVAL_ALREADY_PENDING");
  });

  test("rebase or base advance permanently invalidates the approval", () => {
    const f = fixture();
    const approval = request(f);
    decide(f, approval);
    f.machine.recordBaseAdvance({
      operation_id: op(),
      actor: "orchestrator:repository",
      issue_id: f.issue.issue_id,
      base_sha: "a".repeat(40),
    });
    const invalidated = f.service.get(f.issue.issue_id, approval.approval_id);
    expect(invalidated.state).toBe("invalidated");
    expect(invalidated.invalidated_reason).toBe("base_advanced");
    expectCode(() => decide(f, approval), "APPROVAL_STATE_CONFLICT");
  });

  test("reassigning the reviewer invalidates the old request and addresses a new one", () => {
    const f = fixture();
    const approval = request(f, ERIN);
    const { invalidated, created } = f.service.reassign({
      operation_id: op(),
      actor: "system:control-plane",
      issue_id: f.issue.issue_id,
      approval_id: approval.approval_id,
      new_approver_user_id: FRANK,
    });
    expect(invalidated.state).toBe("invalidated");
    expect(invalidated.invalidated_reason).toBe("authority_changed");
    expect(created?.state).toBe("pending");
    expect(created?.approver?.id).toBe(FRANK);
    // The previous addressee can never decide under the replaced request.
    expectCode(() => decide(f, approval, ERIN), "APPROVAL_STATE_CONFLICT");
    // The new addressee can.
    expect(decide(f, created as ApprovalRecord, FRANK).state).toBe("approved");
  });

  test("a manual invalidation is recorded permanently", () => {
    const f = fixture();
    const approval = request(f);
    const invalidated = f.service.invalidate({
      operation_id: op(),
      actor: "system:control-plane",
      issue_id: f.issue.issue_id,
      approval_id: approval.approval_id,
      reason: "authority_changed",
    });
    expect(invalidated.state).toBe("invalidated");
    expect(invalidated.invalidated_reason).toBe("authority_changed");
    // Repeating the invalidation does not rewrite the first reason.
    const again = f.service.invalidate({
      operation_id: op(),
      actor: "system:control-plane",
      issue_id: f.issue.issue_id,
      approval_id: approval.approval_id,
      reason: "policy_changed",
    });
    expect(again.invalidated_reason).toBe("authority_changed");
  });

  test("cancelling the issue cancels an actionable approval", () => {
    const f = fixture();
    const approval = request(f);
    f.machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: f.issue.issue_id,
      to: "cancelled",
      reason: "operator cancelled the issue",
    });
    expect(f.service.get(f.issue.issue_id, approval.approval_id).state).toBe("cancelled");
    expectCode(() => decide(f, approval), "APPROVAL_STATE_CONFLICT");
  });

  test("approval replay reproduces the same state and digest", () => {
    const f = fixture();
    const approval = request(f);
    decide(f, approval);
    const rebuilt = CollabMachine.fromAudit(f.machine.auditLog(), {
      candidateStore: new CandidateContentStore(path.join(root, "replay-store")),
    });
    expect(rebuilt.snapshotDigest()).toBe(f.machine.snapshotDigest());
    expect(rebuilt.getApproval(approval.approval_id)).toEqual(
      f.machine.getApproval(approval.approval_id),
    );
  });

  test("a duplicate request operation returns the recorded result instead of a second request", () => {
    const f = fixture();
    const operationId = op();
    const first = f.machine.requestApproval({
      operation_id: operationId,
      actor: "orchestrator:approval",
      issue_id: f.issue.issue_id,
      candidate_id: f.candidate.candidate_id,
      target_branch: REPOSITORY.base_ref,
      approver: { id: ERIN, display_name: "erin" },
      no_eligible_approver: false,
      authority: {
        member_active: true,
        repository_access: true,
        approval_authority: true,
        authority_version: "2026-11-04.1",
      },
    });
    const second = f.machine.requestApproval({
      operation_id: operationId,
      actor: "orchestrator:approval",
      issue_id: f.issue.issue_id,
      candidate_id: f.candidate.candidate_id,
      target_branch: REPOSITORY.base_ref,
      approver: { id: ERIN, display_name: "erin" },
      no_eligible_approver: false,
      authority: {
        member_active: true,
        repository_access: true,
        approval_authority: true,
        authority_version: "2026-11-04.1",
      },
    });
    expect(second.approval_id).toBe(first.approval_id);
    expect(f.machine.listApprovals(f.issue.issue_id)).toHaveLength(1);
  });
});
