import { describe, expect, test } from "vitest";

import type { RoutingMachine } from "../src/routing/machine.js";
import {
  ACTOR,
  BOB,
  ERIN,
  FRANK,
  GRACE,
  SCOPE,
  ZOE,
  blameFact,
  evidence,
  expectCode,
  identity,
  makeMachine,
  mapped,
  member,
  op,
  standardDirectory,
  substantive,
  testPolicy,
} from "./helpers/routing.js";
import type { FakeDirectory } from "./helpers/routing.js";

function fixture(): { directory: FakeDirectory; machine: RoutingMachine } {
  const directory = standardDirectory();
  const machine = makeMachine(directory);
  machine.registerPolicy({ operation_id: op(), actor: ACTOR, scope: SCOPE, policy: testPolicy() });
  machine.route({
    operation_id: op(),
    actor: ACTOR,
    scope: SCOPE,
    issue_id: "iss_1",
    service_mapping: mapped(),
    evidence: evidence(
      [substantive("node/src/core.ts", 10)],
      [blameFact("node/src/core.ts", identity("github", "1"), 10)],
    ),
  });
  return { directory, machine };
}

function address(machine: RoutingMachine, reviewerUserId: string): unknown {
  return machine.addressApproval({
    operation_id: op(),
    actor: "system:approval",
    scope: SCOPE,
    issue_id: "iss_1",
    reviewer_user_id: reviewerUserId,
  });
}

describe("approval addressing and invalidation (DAT-217)", () => {
  test("an eligible approver is addressed and the record carries the policy version", () => {
    const { machine } = fixture();
    const request = address(machine, ERIN) as {
      request_id: string;
      addressee_user_id: string;
      status: string;
      policy_version: string;
      addressed_by: string;
    };
    expect(request).toMatchObject({
      issue_id: "iss_1",
      addressee_user_id: ERIN,
      status: "pending",
      policy_version: "2026-11-03.1",
      addressed_by: "system:approval",
    });
  });

  test("reviewers must be current eligible members with approval authority", () => {
    const { machine } = fixture();
    expectCode(() => address(machine, BOB), "REVIEWER_NOT_AUTHORIZED");
    expectCode(() => address(machine, GRACE), "NOT_ELIGIBLE");
    expectCode(() => address(machine, ZOE), "NOT_ELIGIBLE");
  });

  test("one pending approval request per issue", () => {
    const { machine } = fixture();
    address(machine, ERIN);
    expectCode(() => address(machine, FRANK), "APPROVAL_ALREADY_PENDING");
    expect(machine.listApprovalRequests("iss_1")).toHaveLength(1);
  });

  test("revoked authority invalidates the pending approval and re-addresses it", () => {
    const { directory, machine } = fixture();
    const request = address(machine, ERIN) as { request_id: string };

    // Erin is demoted out of the approval roles: the revocation is now a fact
    // the directory reports, so the sweep is accepted.
    directory.members = directory.members.map((entry) =>
      entry.user_id === ERIN ? member(ERIN, "member") : entry,
    );
    const { invalidated, created } = machine.revokeAuthority({
      operation_id: op(),
      actor: "system:control-plane",
      scope: SCOPE,
      subject_user_id: ERIN,
      reason: "role revoked",
    });

    expect(invalidated).toEqual([
      expect.objectContaining({
        request_id: request.request_id,
        status: "invalidated",
        invalidation_reason: "authority_revoked",
      }),
    ]);
    expect(created).toEqual([
      expect.objectContaining({
        issue_id: "iss_1",
        addressee_user_id: FRANK,
        status: "pending",
      }),
    ]);
    expect(invalidated[0]?.readdressed_request_id).toBe(created[0]?.request_id);
    const requests = machine.listApprovalRequests("iss_1");
    expect(requests.filter((entry) => entry.status === "pending")).toHaveLength(1);
  });

  test("a suspended subject's pending approval is swept the same way", () => {
    const { directory, machine } = fixture();
    address(machine, ERIN);
    directory.members = directory.members.map((entry) =>
      entry.user_id === ERIN ? member(ERIN, "owner", "suspended") : entry,
    );
    const { invalidated, created } = machine.revokeAuthority({
      operation_id: op(),
      actor: "system:control-plane",
      scope: SCOPE,
      subject_user_id: ERIN,
      reason: "account suspended",
    });
    expect(invalidated[0]?.status).toBe("invalidated");
    expect(created[0]?.addressee_user_id).toBe(FRANK);
  });

  test("with no eligible approver left the request is invalidated and the operator alerted", () => {
    const directory = standardDirectory();
    directory.members = [member(ERIN, "owner")];
    const machine = makeMachine(directory);
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    address(machine, ERIN);
    directory.members = [member(ERIN, "member")];

    const { invalidated, created } = machine.revokeAuthority({
      operation_id: op(),
      actor: "system:control-plane",
      scope: SCOPE,
      subject_user_id: ERIN,
      reason: "role revoked",
    });
    expect(invalidated[0]).toMatchObject({
      status: "invalidated",
      readdressed_request_id: null,
    });
    expect(created).toEqual([]);
    expect(machine.listAlerts()).toEqual([
      expect.objectContaining({ kind: "approval_unaddressable", issue_id: "iss_1" }),
    ]);
  });

  test("a revocation claim against a still-authorized subject is refused", () => {
    const { machine } = fixture();
    address(machine, ERIN);
    expectCode(
      () =>
        machine.revokeAuthority({
          operation_id: op(),
          actor: "system:control-plane",
          scope: SCOPE,
          subject_user_id: ERIN,
          reason: "role revoked",
        }),
      "AUTHORITY_STILL_ACTIVE",
    );
    expect(machine.listApprovalRequests("iss_1")[0]?.status).toBe("pending");
  });

  test("a reviewer change invalidates the pending approval and addresses the new reviewer", () => {
    const { machine } = fixture();
    const request = address(machine, ERIN) as { request_id: string };
    const { invalidated, created } = machine.changeReviewer({
      operation_id: op(),
      actor: "system:approval",
      scope: SCOPE,
      issue_id: "iss_1",
      new_reviewer_user_id: FRANK,
      reason: "erin is on leave",
    });
    expect(invalidated).toMatchObject({
      request_id: request.request_id,
      status: "invalidated",
      invalidation_reason: "reviewer_changed",
      readdressed_request_id: created.request_id,
    });
    expect(created).toMatchObject({ addressee_user_id: FRANK, status: "pending" });
  });

  test("reviewer changes validate the new reviewer and require a pending request", () => {
    const { machine } = fixture();
    address(machine, ERIN);
    expectCode(
      () =>
        machine.changeReviewer({
          operation_id: op(),
          actor: "system:approval",
          scope: SCOPE,
          issue_id: "iss_1",
          new_reviewer_user_id: BOB,
          reason: "not an approver",
        }),
      "REVIEWER_NOT_AUTHORIZED",
    );
    expect(machine.listApprovalRequests("iss_1")[0]?.status).toBe("pending");

    const other = fixture();
    expectCode(
      () =>
        other.machine.changeReviewer({
          operation_id: op(),
          actor: "system:approval",
          scope: SCOPE,
          issue_id: "iss_1",
          new_reviewer_user_id: FRANK,
          reason: "no pending request",
        }),
      "NO_PENDING_APPROVAL",
    );
  });
});
