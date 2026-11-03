import { describe, expect, test } from "vitest";

import type { RoutingMachine } from "../src/routing/machine.js";
import type { TransferProposal } from "../src/routing/types.js";
import {
  ACTOR,
  ALICE,
  BOB,
  CAROL,
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

function assignedAlice(): { directory: FakeDirectory; machine: RoutingMachine } {
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
      [
        blameFact("node/src/core.ts", identity("github", "1"), 10),
        blameFact("node/src/core.ts", identity("github", "2"), 4),
      ],
    ),
  });
  return { directory, machine };
}

function propose(
  machine: RoutingMachine,
  actor: string,
  toUserId: string,
  issueId = "iss_1",
): TransferProposal {
  return machine.proposeTransfer({
    operation_id: op(),
    actor,
    scope: SCOPE,
    issue_id: issueId,
    to_user_id: toUserId,
    reason: `${toUserId} is closer to the incident`,
    evidence: "incident-42",
  });
}

describe("manual transfer (DAT-217)", () => {
  test("a member proposes, the assignee confirms, and every audit field is recorded", () => {
    const { machine } = assignedAlice();
    const proposal = propose(machine, BOB, CAROL);
    expect(proposal).toMatchObject({
      issue_id: "iss_1",
      from_user_id: ALICE,
      to_user_id: CAROL,
      proposed_by: BOB,
      reason: `${CAROL} is closer to the incident`,
      evidence: "incident-42",
      status: "proposed",
      policy_version: "2026-11-03.1",
    });

    const { proposal: confirmed, assignment } = machine.confirmTransfer({
      operation_id: op(),
      actor: ALICE,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
    });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      resolved_by: ALICE,
      from_user_id: ALICE,
      to_user_id: CAROL,
    });
    expect(confirmed.resolved_at).not.toBe(null);
    expect(assignment).toMatchObject({
      assignee_user_id: CAROL,
      source: "transfer",
      transfer_id: proposal.transfer_id,
      decision_id: null,
    });
    expect(machine.getAssignment("iss_1")?.assignee_user_id).toBe(CAROL);
  });

  test("an owner or admin may confirm someone else's proposal", () => {
    const { machine } = assignedAlice();
    const proposal = propose(machine, BOB, CAROL);
    const { proposal: confirmed } = machine.confirmTransfer({
      operation_id: op(),
      actor: ERIN,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
    });
    expect(confirmed.resolved_by).toBe(ERIN);
  });

  test("proposals and confirmations are role-checked", () => {
    const { machine } = assignedAlice();
    expectCode(() => propose(machine, GRACE, CAROL), "ROLE_FORBIDDEN");
    expectCode(() => propose(machine, ZOE, CAROL), "ROLE_FORBIDDEN");

    const proposal = propose(machine, BOB, CAROL);
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: BOB,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
        }),
      "ROLE_FORBIDDEN",
    );
    expectCode(
      () =>
        machine.rejectTransfer({
          operation_id: op(),
          actor: BOB,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
          reason: "not mine to reject",
        }),
      "ROLE_FORBIDDEN",
    );
  });

  test("the destination is validated at proposal and re-validated at confirmation", () => {
    const { directory, machine } = assignedAlice();
    expectCode(() => propose(machine, BOB, ZOE), "DESTINATION_INELIGIBLE");

    const proposal = propose(machine, BOB, CAROL);
    directory.members = directory.members.map((entry) =>
      entry.user_id === CAROL ? member(CAROL, "member", "suspended") : entry,
    );
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
        }),
      "DESTINATION_INELIGIBLE",
    );
    expect(machine.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
  });

  test("transfers to the current assignee and stale proposals are refused", () => {
    const { machine } = assignedAlice();
    expectCode(() => propose(machine, BOB, ALICE), "INVALID_INPUT");

    const stale = propose(machine, BOB, CAROL);
    const winner = propose(machine, BOB, FRANK);
    machine.confirmTransfer({
      operation_id: op(),
      actor: ALICE,
      scope: SCOPE,
      proposal_id: winner.transfer_id,
    });
    expect(machine.getAssignment("iss_1")?.assignee_user_id).toBe(FRANK);
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: SCOPE,
          proposal_id: stale.transfer_id,
        }),
      "TRANSFER_STALE",
    );
  });

  test("a rejected transfer changes nothing", () => {
    const { machine } = assignedAlice();
    const proposal = propose(machine, BOB, CAROL);
    const rejected = machine.rejectTransfer({
      operation_id: op(),
      actor: ERIN,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
      reason: "keep alice on it",
    });
    expect(rejected).toMatchObject({ status: "rejected", resolved_by: ERIN });
    expect(machine.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
        }),
      "TRANSFER_NOT_PENDING",
    );
  });

  test("a transfer bestows no approval rights", () => {
    const { machine } = assignedAlice();
    const proposal = propose(machine, BOB, CAROL);
    machine.confirmTransfer({
      operation_id: op(),
      actor: ALICE,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
    });
    expectCode(
      () =>
        machine.addressApproval({
          operation_id: op(),
          actor: ACTOR,
          scope: SCOPE,
          issue_id: "iss_1",
          reviewer_user_id: CAROL,
        }),
      "REVIEWER_NOT_AUTHORIZED",
    );
    expect(machine.listApprovalRequests("iss_1")).toEqual([]);
  });

  test("an unassigned issue is taken over only with an owner/admin confirmation", () => {
    const directory = standardDirectory();
    const machine = makeMachine(directory);
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const decision = machine.route({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      issue_id: "iss_unassigned",
      service_mapping: mapped(),
      evidence: evidence([substantive("node/src/core.ts", 10)]),
    });
    expect(decision.outcome).toBe("triage_queue");

    const proposal = propose(machine, BOB, CAROL, "iss_unassigned");
    expect(proposal.from_user_id).toBe(null);
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: BOB,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
        }),
      "ROLE_FORBIDDEN",
    );
    const { assignment } = machine.confirmTransfer({
      operation_id: op(),
      actor: FRANK,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
    });
    expect(assignment).toMatchObject({ issue_id: "iss_unassigned", assignee_user_id: CAROL });
  });

  test("take-over stays owner/admin even when confirm_roles allow members", () => {
    const directory = standardDirectory();
    const machine = makeMachine(directory);
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy({
        transfer: {
          propose_roles: ["owner", "admin", "member"],
          confirm_roles: ["owner", "admin", "member"],
        },
      }),
    });
    machine.route({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      issue_id: "iss_unassigned",
      service_mapping: mapped(),
      evidence: evidence([substantive("node/src/core.ts", 10)]),
    });

    const proposal = propose(machine, BOB, CAROL, "iss_unassigned");
    // A member holding the widened confirm role still cannot take over an
    // unassigned issue, on either resolution path.
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: BOB,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
        }),
      "ROLE_FORBIDDEN",
    );
    expectCode(
      () =>
        machine.rejectTransfer({
          operation_id: op(),
          actor: BOB,
          scope: SCOPE,
          proposal_id: proposal.transfer_id,
          reason: "not mine",
        }),
      "ROLE_FORBIDDEN",
    );
    const { assignment } = machine.confirmTransfer({
      operation_id: op(),
      actor: ERIN,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
    });
    expect(assignment).toMatchObject({ issue_id: "iss_unassigned", assignee_user_id: CAROL });
  });

  test("an assignee who lost membership can no longer confirm or reject transfers", () => {
    const { directory, machine } = assignedAlice();

    // Suspended: still the recorded assignee, but no longer eligible.
    const first = propose(machine, BOB, CAROL);
    directory.members = directory.members.map((entry) =>
      entry.user_id === ALICE ? member(ALICE, "member", "suspended") : entry,
    );
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: SCOPE,
          proposal_id: first.transfer_id,
        }),
      "ROLE_FORBIDDEN",
    );

    // Removed from the workspace entirely.
    const second = propose(machine, BOB, FRANK);
    directory.members = directory.members.filter((entry) => entry.user_id !== ALICE);
    expectCode(
      () =>
        machine.rejectTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: SCOPE,
          proposal_id: second.transfer_id,
          reason: "mine to reject",
        }),
      "ROLE_FORBIDDEN",
    );
    expect(machine.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
  });
});
