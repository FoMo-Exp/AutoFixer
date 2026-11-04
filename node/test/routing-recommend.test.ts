import { describe, expect, test } from "vitest";

import type { RoutingDecision, RoutingPolicy } from "../src/routing/types.js";
import type { RoutingMachine } from "../src/routing/machine.js";
import {
  ACTOR,
  ALICE,
  BOB,
  CAROL,
  ERIN,
  HENRY,
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

interface Fixture {
  directory: FakeDirectory;
  machine: RoutingMachine;
  decision: RoutingDecision;
}

/**
 * Route iss_1 with a high-confidence multi-author picture: alice 10, bob 4,
 * henry (suspended) 2 — alice is assigned deterministically and the bounded
 * candidate set is [alice, bob, henry].
 */
function routed(policy: RoutingPolicy = testPolicy()): Fixture {
  const directory = standardDirectory();
  const machine = makeMachine(directory);
  machine.registerPolicy({ operation_id: op(), actor: ACTOR, scope: SCOPE, policy });
  const decision = machine.route({
    operation_id: op(),
    actor: ACTOR,
    scope: SCOPE,
    issue_id: "iss_1",
    service_mapping: mapped(),
    evidence: evidence(
      [substantive("node/src/core.ts", 10)],
      [
        blameFact("node/src/core.ts", identity("github", "1"), 10, { author_label: "alice" }),
        blameFact("node/src/core.ts", identity("github", "2"), 4, { author_label: "bob" }),
        blameFact("node/src/core.ts", identity("github", "9"), 2, { author_label: "henry" }),
      ],
    ),
  });
  return { directory, machine, decision };
}

function recommend(fixture: Fixture, userId: string, asserted?: number): unknown {
  return fixture.machine.recommendAssignee({
    operation_id: op(),
    actor: ACTOR,
    scope: SCOPE,
    decision_id: fixture.decision.decision_id,
    recommendation: {
      recommended_user_id: userId,
      rationale: "main responsible developer",
      asserted_confidence: asserted ?? null,
    },
  });
}

describe("bounded LLM recommendation (DAT-217)", () => {
  test("a recommendation selects within the bounded candidates and becomes the assignee", () => {
    const fixture = routed();
    const assignment = recommend(fixture, BOB, 0.99) as {
      assignee_user_id: string;
      source: string;
    };
    expect(assignment).toMatchObject({
      issue_id: "iss_1",
      assignee_user_id: BOB,
      source: "llm_recommendation",
      decision_id: fixture.decision.decision_id,
      policy_version: "2026-11-03.1",
    });
    // The deterministic decision record stays as the evidence it was.
    expect(fixture.machine.getDecision(fixture.decision.decision_id)?.assignee_user_id).toBe(ALICE);
  });

  test("the model cannot assign a non-member", () => {
    const fixture = routed();
    expectCode(() => recommend(fixture, ZOE), "CANDIDATE_NOT_BOUNDED");
    expect(fixture.machine.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
  });

  test("a candidate recorded as ineligible is outside the bounded set", () => {
    const fixture = routed();
    expectCode(() => recommend(fixture, HENRY), "CANDIDATE_NOT_BOUNDED");
    expect(fixture.machine.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
  });

  test("current eligibility is re-checked at recommendation time", () => {
    const fixture = routed();
    fixture.directory.members = fixture.directory.members.map((entry) =>
      entry.user_id === BOB ? member(BOB, "member", "suspended") : entry,
    );
    expectCode(() => recommend(fixture, BOB), "NOT_ELIGIBLE");
    expect(fixture.machine.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
  });

  test("a model confidence claim cannot rescue a low-confidence routing", () => {
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
      issue_id: "iss_1",
      service_mapping: mapped(),
      evidence: evidence(
        [substantive("node/src/core.ts", 10)],
        [
          blameFact("node/src/core.ts", identity("github", "1"), 10),
          blameFact("node/src/core.ts", identity("github", "2"), 9),
        ],
      ),
    });
    expect(decision.outcome).toBe("manual_triage");
    expectCode(
      () =>
        machine.recommendAssignee({
          operation_id: op(),
          actor: ACTOR,
          scope: SCOPE,
          decision_id: decision.decision_id,
          recommendation: {
            recommended_user_id: ALICE,
            rationale: "trust me",
            asserted_confidence: 999,
          },
        }),
      "ASSIGNMENT_NOT_ALLOWED",
    );
    expect(machine.getAssignment("iss_1")).toBeUndefined();
  });

  test("a triage outcome cannot be turned into an assignment by the model", () => {
    const { machine, decision } = routedWithNoCandidates();
    expect(decision.outcome).toBe("triage_queue");
    expectCode(
      () =>
        machine.recommendAssignee({
          operation_id: op(),
          actor: ACTOR,
          scope: SCOPE,
          decision_id: decision.decision_id,
          recommendation: {
            recommended_user_id: ALICE,
            rationale: null,
            asserted_confidence: null,
          },
        }),
      "ASSIGNMENT_NOT_ALLOWED",
    );
    expect(machine.getAssignment("iss_1")).toBeUndefined();
  });

  test("routing and recommendation never grant approval rights", () => {
    const fixture = routed();
    recommend(fixture, BOB);
    // The model-made assignee is a plain member: addressing them as the
    // reviewer is denied and no approval request came into existence.
    expectCode(
      () =>
        fixture.machine.addressApproval({
          operation_id: op(),
          actor: ACTOR,
          scope: SCOPE,
          issue_id: "iss_1",
          reviewer_user_id: BOB,
        }),
      "REVIEWER_NOT_AUTHORIZED",
    );
    expect(fixture.machine.listApprovalRequests("iss_1")).toEqual([]);
    // A model recommendation cannot pick an approver either.
    expectCode(() => recommend(fixture, ERIN), "CANDIDATE_NOT_BOUNDED");
  });

  test("a recommendation cannot clobber a manual transfer", () => {
    const fixture = routed();
    const proposal = fixture.machine.proposeTransfer({
      operation_id: op(),
      actor: BOB,
      scope: SCOPE,
      issue_id: "iss_1",
      to_user_id: CAROL,
      reason: "carol owns the release",
      evidence: "incident-42",
    });
    fixture.machine.confirmTransfer({
      operation_id: op(),
      actor: ERIN,
      scope: SCOPE,
      proposal_id: proposal.transfer_id,
    });
    expect(fixture.machine.getAssignment("iss_1")?.assignee_user_id).toBe(CAROL);
    expectCode(() => recommend(fixture, BOB), "ASSIGNMENT_SUPERSEDED");
    expect(fixture.machine.getAssignment("iss_1")?.assignee_user_id).toBe(CAROL);
  });
});

function routedWithNoCandidates(): { machine: RoutingMachine; decision: RoutingDecision } {
  const directory = standardDirectory();
  const machine = makeMachine(directory);
  machine.registerPolicy({ operation_id: op(), actor: ACTOR, scope: SCOPE, policy: testPolicy() });
  const decision = machine.route({
    operation_id: op(),
    actor: ACTOR,
    scope: SCOPE,
    issue_id: "iss_1",
    service_mapping: mapped(),
    evidence: evidence([substantive("node/src/core.ts", 10)]),
  });
  return { machine, decision };
}
