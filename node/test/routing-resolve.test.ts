import { describe, expect, test } from "vitest";

import { auditChainProblem, digestOf } from "../src/collab/audit.js";
import { pathMatchesPattern } from "../src/routing/match.js";
import type {
  RouteEvidence,
  RoutingDecision,
  RoutingPolicy,
  ServiceMapping,
} from "../src/routing/types.js";
import type { RoutingMachine } from "../src/routing/machine.js";
import {
  ACTOR,
  ALICE,
  BOB,
  CAROL,
  ERIN,
  FRANK,
  HENRY,
  SCOPE,
  TEAM_BACKEND,
  ZOE,
  blameFact,
  bulkChange,
  cosmeticChange,
  evidence,
  expectCode,
  identity,
  makeMachine,
  mapped,
  member,
  op,
  standardDirectory,
  substantive,
  team,
  testPolicy,
} from "./helpers/routing.js";
import type { FakeDirectory } from "./helpers/routing.js";

function setup(policy: RoutingPolicy = testPolicy()): {
  directory: FakeDirectory;
  machine: RoutingMachine;
} {
  const directory = standardDirectory();
  const machine = makeMachine(directory);
  machine.registerPolicy({ operation_id: op(), actor: ACTOR, scope: SCOPE, policy });
  return { directory, machine };
}

function runRoute(
  machine: RoutingMachine,
  routeEvidence: RouteEvidence,
  options: { mapping?: ServiceMapping; issueId?: string } = {},
): RoutingDecision {
  return machine.route({
    operation_id: op(),
    actor: ACTOR,
    scope: SCOPE,
    issue_id: options.issueId ?? "iss_1",
    service_mapping: options.mapping ?? mapped(),
    evidence: routeEvidence,
  });
}

describe("routing path patterns", () => {
  test("directory prefix, basename, and glob semantics", () => {
    expect(pathMatchesPattern("node/", "node/src/a.ts")).toBe(true);
    expect(pathMatchesPattern("node/", "web/a.ts")).toBe(false);
    expect(pathMatchesPattern("*.ts", "node/src/a.ts")).toBe(true);
    expect(pathMatchesPattern("*.ts", "node/src/a.js")).toBe(false);
    expect(pathMatchesPattern("node/**", "node/src/deep/a.ts")).toBe(true);
    expect(pathMatchesPattern("node/**", "web/a.ts")).toBe(false);
    expect(pathMatchesPattern("**/a.ts", "a.ts")).toBe(true);
    expect(pathMatchesPattern("**/a.ts", "node/a.ts")).toBe(true);
    expect(pathMatchesPattern("node/**/a.ts", "node/a.ts")).toBe(true);
    expect(pathMatchesPattern("node/**/a.ts", "node/src/deep/a.ts")).toBe(true);
    expect(pathMatchesPattern("a/*/b", "a/x/b")).toBe(true);
    expect(pathMatchesPattern("a/*/b", "a/x/y/b")).toBe(false);
  });
});

describe("deterministic resolution (DAT-217)", () => {
  test("multi-author blame is weighted and the dominant author is assigned", () => {
    const { machine } = setup();
    const decision = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 10)],
        [
          blameFact("node/src/core.ts", identity("github", "1"), 10, { author_label: "alice" }),
          blameFact("node/src/core.ts", identity("github", "2"), 4, { author_label: "bob" }),
          blameFact("node/src/core.ts", identity("github", "3"), 2, { author_label: "carol" }),
        ],
      ),
    );

    expect(decision.outcome).toBe("assign");
    expect(decision.assignee_user_id).toBe(ALICE);
    expect(decision.candidates.map((candidate) => candidate.user_id)).toEqual([ALICE, BOB, CAROL]);
    expect(decision.candidates[0]).toMatchObject({
      eligibility: "eligible",
      blame_weight: 10,
      ownership_weight: 0,
      sources: [{ kind: "blame", rule_id: null, paths: ["node/src/core.ts"] }],
    });
    expect(decision.confidence).toMatchObject({
      level: "high",
      top_weight: 10,
      margin: 6,
      min_top_weight: 5,
      min_margin: 2,
    });
    expect(decision.policy_version).toBe("2026-11-03.1");
    expect(machine.getAssignment("iss_1")).toMatchObject({
      assignee_user_id: ALICE,
      source: "routing",
    });
  });

  test("cosmetic and bulk changes are ignored; substantive code is what gets weighted", () => {
    const { machine } = setup();
    const decision = runRoute(
      machine,
      evidence(
        [
          cosmeticChange("docs/readme.md", 500),
          bulkChange("yarn.lock", 500),
          substantive("node/src/core.ts", 10),
        ],
        [
          blameFact("docs/readme.md", identity("github", "1"), 500),
          blameFact("node/src/core.ts", identity("github", "2"), 10),
        ],
      ),
    );

    expect(decision.ignored_changes).toEqual([
      { path: "docs/readme.md", classification: "cosmetic" },
      { path: "yarn.lock", classification: "bulk" },
    ]);
    expect(decision.candidates).toHaveLength(1);
    expect(decision.candidates[0]).toMatchObject({ user_id: BOB, score: 10 });
    expect(decision.assignee_user_id).toBe(BOB);
  });

  test("ownership weight splits across owners and single owners take the full weight", () => {
    const split = setup(
      testPolicy({
        ownership_rules: [
          { rule_id: "own-1", pattern: "node/src/**", owner: { kind: "user", user_id: ALICE } },
          { rule_id: "own-2", pattern: "node/**", owner: { kind: "user", user_id: BOB } },
        ],
      }),
    );
    const shared = runRoute(split.machine, evidence([substantive("node/src/core.ts", 10)]));
    expect(shared.candidates).toEqual([
      expect.objectContaining({
        user_id: ALICE,
        ownership_weight: 5,
        blame_weight: 0,
        sources: [{ kind: "ownership_rule", rule_id: "own-1", paths: ["node/src/core.ts"] }],
      }),
      expect.objectContaining({ user_id: BOB, ownership_weight: 5 }),
    ]);
    // Two equally weighted owners: ambiguous, so a human decides.
    expect(shared.outcome).toBe("manual_triage");
    expect(shared.confidence.level).toBe("low");

    const solo = setup(
      testPolicy({
        ownership_rules: [
          { rule_id: "own-1", pattern: "node/**", owner: { kind: "user", user_id: ALICE } },
        ],
      }),
    );
    const single = runRoute(solo.machine, evidence([substantive("node/src/core.ts", 10)]));
    expect(single.candidates[0]).toMatchObject({
      user_id: ALICE,
      ownership_weight: 10,
      blame_weight: 0,
    });
    expect(single.outcome).toBe("assign");
    expect(single.assignee_user_id).toBe(ALICE);
  });

  test("team rules route to the team's active leader", () => {
    const { machine } = setup(
      testPolicy({
        team_rules: [{ rule_id: "team-1", pattern: "node/**", team_id: TEAM_BACKEND }],
      }),
    );
    const decision = runRoute(machine, evidence([substantive("node/src/core.ts", 10)]));
    expect(decision.candidates[0]).toMatchObject({
      user_id: ALICE,
      score: 10,
      sources: [{ kind: "team_leader", rule_id: "team-1", paths: ["node/src/core.ts"] }],
    });
    expect(decision.assignee_user_id).toBe(ALICE);
  });

  test("missing or inactive team leader records a gap and falls back to triage", () => {
    const missing = setup(
      testPolicy({
        team_rules: [{ rule_id: "team-1", pattern: "node/**", team_id: TEAM_BACKEND }],
      }),
    );
    missing.directory.teams = [team(TEAM_BACKEND, null)];
    const withoutLeader = runRoute(
      missing.machine,
      evidence([substantive("node/src/core.ts", 10)]),
    );
    expect(withoutLeader.team_gaps).toEqual([
      {
        kind: "team_leader",
        rule_id: "team-1",
        team_id: TEAM_BACKEND,
        paths: ["node/src/core.ts"],
        reason: "leader_missing",
      },
    ]);
    expect(withoutLeader.candidates).toHaveLength(0);
    expect(withoutLeader.outcome).toBe("triage_queue");
    expect(withoutLeader.triage_owners).toEqual([ERIN, FRANK]);

    const inactive = setup(
      testPolicy({
        team_rules: [{ rule_id: "team-1", pattern: "node/**", team_id: TEAM_BACKEND }],
      }),
    );
    inactive.directory.teams = [team(TEAM_BACKEND, HENRY)];
    const withInactiveLeader = runRoute(
      inactive.machine,
      evidence([substantive("node/src/core.ts", 10)]),
    );
    expect(withInactiveLeader.team_gaps[0]?.reason).toBe("leader_not_eligible");
    expect(withInactiveLeader.outcome).toBe("triage_queue");
    expect(withInactiveLeader.fallback_reason).toBe("no_candidates");
  });

  test("a departed top author falls back to triage instead of the runner-up", () => {
    const { machine } = setup();
    const decision = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 10)],
        [
          blameFact("node/src/core.ts", identity("github", "9"), 10, { author_label: "henry" }),
          blameFact("node/src/core.ts", identity("github", "2"), 4, { author_label: "bob" }),
        ],
      ),
    );
    expect(decision.candidates[0]).toMatchObject({ user_id: HENRY, eligibility: "suspended" });
    expect(decision.fallback_reason).toBe("top_candidate_ineligible");
    expect(decision.outcome).toBe("triage_queue");
    expect(decision.assignee_user_id).toBe(null);
    expect(machine.getAssignment("iss_1")).toBeUndefined();
  });

  test("a blame author with no workspace membership is not a member", () => {
    const directory = standardDirectory();
    directory.identify(identity("github", "77"), ZOE);
    const machine = makeMachine(directory);
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const decision = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 10)],
        [blameFact("node/src/core.ts", identity("github", "77"), 10, { author_label: "zoe" })],
      ),
    );
    expect(decision.candidates[0]).toMatchObject({ user_id: ZOE, eligibility: "not_a_member" });
    expect(decision.fallback_reason).toBe("top_candidate_ineligible");
    expect(decision.outcome).toBe("triage_queue");
  });

  test("unverified and unmatched identities are recorded and never candidates", () => {
    const { machine } = setup();
    const decision = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 10)],
        [
          blameFact("node/src/core.ts", null, 10, { author_label: "ghost@example.com" }),
          blameFact("node/src/core.ts", identity("github", "404"), 5, { author_label: "gone" }),
        ],
      ),
    );
    expect(decision.candidates).toHaveLength(0);
    expect(decision.unmatched_identities).toEqual([
      {
        author_label: "ghost@example.com",
        ref: null,
        path: "node/src/core.ts",
        reason: "unverified_author_identity",
      },
      {
        author_label: "gone",
        ref: identity("github", "404"),
        path: "node/src/core.ts",
        reason: "identity_not_found",
      },
    ]);
    expect(decision.fallback_reason).toBe("no_candidates");
    expect(decision.outcome).toBe("triage_queue");
  });

  test("low confidence — small margin or small top weight — enters manual triage", () => {
    const { machine } = setup();
    const ambiguous = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 10)],
        [
          blameFact("node/src/core.ts", identity("github", "1"), 10),
          blameFact("node/src/core.ts", identity("github", "2"), 9),
        ],
      ),
    );
    expect(ambiguous.outcome).toBe("manual_triage");
    expect(ambiguous.confidence).toMatchObject({ level: "low", top_weight: 10, margin: 1 });
    expect(ambiguous.assignee_user_id).toBe(null);

    const thin = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 3)],
        [blameFact("node/src/core.ts", identity("github", "1"), 3)],
      ),
    );
    expect(thin.outcome).toBe("manual_triage");
    expect(thin.confidence).toMatchObject({ level: "low", top_weight: 3 });
    expect(machine.getAssignment("iss_1")).toBeUndefined();
  });

  test("an unmapped service falls back to the triage queue", () => {
    const { machine } = setup();
    const decision = runRoute(
      machine,
      evidence(
        [substantive("node/src/core.ts", 10)],
        [blameFact("node/src/core.ts", identity("github", "1"), 10)],
      ),
      { mapping: { service: "mystery", status: "unmapped" } },
    );
    expect(decision.fallback_reason).toBe("service_unmapped");
    expect(decision.outcome).toBe("triage_queue");
    expect(decision.assignee_user_id).toBe(null);
    expect(decision.service_mapping).toEqual({ service: "mystery", status: "unmapped" });
  });

  test("nobody eligible for triage keeps the issue unassigned and alerts the operator", () => {
    const directory = standardDirectory();
    directory.members = [member(ALICE)];
    const machine = makeMachine(directory);
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const decision = runRoute(machine, evidence([substantive("node/src/core.ts", 10)]));
    expect(decision.outcome).toBe("unassigned_alert");
    expect(decision.triage_owners).toEqual([]);
    expect(machine.listAlerts()).toEqual([
      expect.objectContaining({
        kind: "unassigned_no_eligible_owner",
        issue_id: "iss_1",
        scope: SCOPE,
      }),
    ]);
  });

  test("policy version and evidence are auditable with an intact digest chain", () => {
    const policy = testPolicy();
    const { machine } = setup(policy);
    const routeEvidence = evidence(
      [substantive("node/src/core.ts", 10)],
      [blameFact("node/src/core.ts", identity("github", "1"), 10)],
    );
    const first = runRoute(machine, routeEvidence);
    const second = runRoute(machine, routeEvidence);

    expect(first.policy_version).toBe(policy.policy_version);
    expect(first.policy_digest).toBe(digestOf(policy));
    expect(first.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.evidence_digest).toBe(first.evidence_digest);
    expect(auditChainProblem(machine.auditLog())).toBe(null);
    expect(machine.auditLog()[0]?.command).toBe("register_policy");
    expect(machine.auditLog()[1]?.command).toBe("route");
  });

  test("policy registration rejects invalid policies", () => {
    const { machine } = setup();
    expectCode(
      () =>
        machine.registerPolicy({
          operation_id: op(),
          actor: ACTOR,
          scope: SCOPE,
          policy: testPolicy({
            ownership_rules: [
              { rule_id: "own-1", pattern: "node/**", owner: { kind: "user", user_id: ALICE } },
              { rule_id: "own-1", pattern: "web/**", owner: { kind: "user", user_id: BOB } },
            ],
          }),
        }),
      "POLICY_INVALID",
    );
  });
});
