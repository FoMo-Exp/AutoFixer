import { describe, expect, test, beforeEach } from "vitest";

import {
  ValidationError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  approveAndPromote,
  assessAndAutoPromote,
  assessIndependentSupport,
  createMemoryLifecycleStore,
  createMemoryRepositories,
  evaluatePromotion,
} from "../src/memory/index.js";
import type {
  CreateMemoryItemInput,
  EvaluationStanding,
  EvidenceCitation,
  MemoryItemRecord,
  MemoryKind,
  MemoryLifecycleStore,
  MemoryRepositories,
  RunSupport,
  ValidationStanding,
} from "../src/memory/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let memory: MemoryRepositories;
let lifecycle: MemoryLifecycleStore;
let scope: WorkspaceScope;

const ACTOR = "usr_admin";
const ADMITTED: ValidationStanding = { disposition: "admitted" };
const HELD: ValidationStanding = { disposition: "held" };
const OK_EVAL: EvaluationStanding = { delta: 0 };

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Repo Workspace",
    repository_id: "repo-1",
    provider_instance_id: provider.id,
  });
  return { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR };
}

function itemContent(overrides: Partial<CreateMemoryItemInput> = {}): CreateMemoryItemInput {
  return {
    kind: "fact",
    scope: { path_prefix: "node/" },
    statement: "The node workspace builds with npm test",
    preconditions: ["node workspace"],
    provenance: { author_type: "agent", agent_model: "test-model" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-11-01T00:00:00Z",
    valid_to: null,
    source_run_id: "run_1",
    ...overrides,
  };
}

function mustGet(itemId: string): MemoryItemRecord {
  const record = memory.items.getById(scope, itemId);
  if (record === undefined) {
    throw new Error(`expected memory item ${itemId}`);
  }
  return record;
}

/** A fact in `candidate` state with one stored evidence citation. */
function factCandidate(statement?: string): MemoryItemRecord {
  const record = memory.items.create(
    scope,
    itemContent(statement === undefined ? {} : { statement }),
  );
  memory.evidence.add(scope, record.item.id, { evidence_type: "run", reference: "run_1" });
  memory.items.setStatus(scope, record.item.id, "candidate", 1);
  return mustGet(record.item.id);
}

function candidateOf(kind: MemoryKind, statement: string): MemoryItemRecord {
  const provenance =
    kind === "policy"
      ? { author_type: "human" as const }
      : { author_type: "agent" as const, agent_model: "test-model" };
  const record = memory.items.create(scope, itemContent({ kind, statement, provenance }));
  memory.evidence.add(scope, record.item.id, { evidence_type: "run", reference: "run_1" });
  memory.items.setStatus(scope, record.item.id, "candidate", 1);
  return mustGet(record.item.id);
}

function citation(
  evidence_type: EvidenceCitation["evidence_type"],
  reference: string,
): EvidenceCitation {
  return { evidence_type, reference };
}

function support(
  run_id: string,
  evidence: EvidenceCitation[] = [],
  known_outcome = true,
): RunSupport {
  return { run_id, known_outcome, evidence };
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  memory = createMemoryRepositories(db);
  lifecycle = createMemoryLifecycleStore(db);
  scope = bootstrap();
});

// ---------------------------------------------------------------------------
// Independent supporting runs
// ---------------------------------------------------------------------------

describe("Independent support definition", () => {
  test("two distinct runs with distinct evidence are two independent runs", () => {
    const result = assessIndependentSupport([
      support("run_a", [citation("test", "t1")]),
      support("run_b", [citation("test", "t2")]),
    ]);
    expect(result.independent_runs).toBe(2);
    expect(result.counted_run_ids).toEqual(["run_a", "run_b"]);
  });

  test("a retried attempt with repackaged evidence does not count twice", () => {
    const result = assessIndependentSupport([
      support("run_a", [citation("test", "t1"), citation("pr", "p1")]),
      support("run_retry", [citation("test", "t1"), citation("pr", "p1")]),
    ]);
    expect(result.independent_runs).toBe(1);
    expect(result.collapsed_run_ids).toEqual(["run_retry"]);
  });

  test("repeated observations of one run are one run", () => {
    const result = assessIndependentSupport([
      support("run_a", [citation("test", "t1")]),
      support("run_a", [citation("test", "t1")]),
    ]);
    expect(result.independent_runs).toBe(1);
    expect(result.counted_run_ids).toEqual(["run_a"]);
  });

  test("an unknown outcome never supports, however often observed", () => {
    expect(
      assessIndependentSupport([
        support("run_a", [citation("test", "t1")], false),
        support("run_a", [citation("test", "t1")], true),
      ]).independent_runs,
    ).toBe(0);
  });

  test("a run with no citations is not support", () => {
    expect(assessIndependentSupport([support("run_a", [])]).independent_runs).toBe(0);
  });

  test("a run counts when it contributes at least one new citation", () => {
    const result = assessIndependentSupport([
      support("run_a", [citation("test", "t1")]),
      support("run_b", [citation("test", "t1"), citation("test", "t2")]),
    ]);
    expect(result.independent_runs).toBe(2);
  });

  test("a run contributing only earlier citations is repackaged evidence", () => {
    const result = assessIndependentSupport([
      support("run_a", [citation("test", "t1"), citation("test", "t2")]),
      support("run_b", [citation("test", "t1")]),
    ]);
    expect(result.independent_runs).toBe(1);
    expect(result.collapsed_run_ids).toEqual(["run_b"]);
  });

  test("a citation is identified by type plus reference, never reference alone", () => {
    const result = assessIndependentSupport([
      support("run_a", [citation("issue", "42")]),
      support("run_b", [citation("pr", "42")]),
    ]);
    expect(result.independent_runs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Automatic fact promotion
// ---------------------------------------------------------------------------

describe("Automatic fact promotion", () => {
  const twoRuns = [
    support("run_1", [citation("test", "t1")]),
    support("run_2", [citation("test", "t2")]),
  ];

  test("promotes a fact meeting every gate and records the decision", () => {
    const record = factCandidate();
    const decision = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: { delta: 0.1, eval_run_id: "eval_1" },
      },
    );
    expect(decision.outcome).toBe("promoted");
    expect(mustGet(record.item.id).item.status).toBe("active");
    const decisions = lifecycle.listPromotionDecisions(scope, { item_id: record.item.id });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.outcome).toBe("promoted");
    expect(decisions[0]?.reasons).toEqual(["auto_promoted"]);
    expect(decisions[0]?.independent_support_runs).toBe(2);
    expect(decisions[0]?.evaluation_delta).toBe(0.1);
    expect(decisions[0]?.policy_digest).toEqual(expect.any(String));
  });

  test("below the independence threshold the item is never active", () => {
    const record = factCandidate();
    const decision = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: [
          support("run_1", [citation("test", "t1")]),
          support("run_retry", [citation("test", "t1")]),
        ],
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(decision.outcome).toBe("blocked");
    expect(decision.reasons).toContain("independent_support_below_threshold");
    expect(decision.independent_support_runs).toBe(1);
    expect(mustGet(record.item.id).item.status).toBe("candidate");
    expect(lifecycle.listPromotionDecisions(scope, { item_id: record.item.id })[0]?.outcome).toBe(
      "blocked",
    );
  });

  test("an unresolved contradiction blocks until it is resolved", () => {
    const record = factCandidate("the build uses npm test");
    const other = factCandidate("the build uses make test");
    memory.links.create(scope, {
      item_id: record.item.id,
      target_item_id: other.item.id,
      link_type: "contradicts",
      reason: "conflicting build facts",
    });
    const blocked = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(blocked.reasons).toContain("unresolved_contradiction");
    expect(mustGet(record.item.id).item.status).toBe("candidate");

    memory.items.setStatus(scope, other.item.id, "deprecated", 1);
    const promoted = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(promoted.outcome).toBe("promoted");
    expect(mustGet(record.item.id).item.status).toBe("active");
  });

  test("validation must have passed admission", () => {
    const record = factCandidate();
    const decision = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: twoRuns,
        validation: HELD,
        evaluation: OK_EVAL,
      },
    );
    expect(decision.reasons).toContain("validation_not_passed");
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });

  test("a missing or negative evaluation delta blocks promotion", () => {
    const missing = factCandidate("fact without evaluation");
    const verdict = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: missing.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: null,
      },
    );
    expect(verdict.reasons).toContain("evaluation_missing");

    const negative = factCandidate("fact with regression");
    const negVerdict = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: negative.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: { delta: -0.2 },
      },
    );
    expect(negVerdict.reasons).toContain("evaluation_negative");
    expect(mustGet(negative.item.id).item.status).toBe("candidate");
  });

  test("a non-finite evaluation delta never passes the gate", () => {
    // NaN compares false against `< 0`; without an explicit finiteness check
    // it would slip through as a promotion. Infinity is no better.
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const record = factCandidate(`fact with delta ${String(delta)}`);
      const verdict = assessAndAutoPromote(
        scope,
        { memory, lifecycle },
        {
          itemId: record.item.id,
          support: twoRuns,
          validation: ADMITTED,
          evaluation: { delta },
        },
      );
      expect(verdict.outcome).toBe("blocked");
      expect(verdict.reasons).toContain("evaluation_invalid");
      expect(verdict.evaluation_delta).toBeNull();
      expect(mustGet(record.item.id).item.status).toBe("candidate");
      const decisions = lifecycle.listPromotionDecisions(scope, { item_id: record.item.id });
      expect(decisions[0]?.outcome).toBe("blocked");
      expect(decisions[0]?.evaluation_delta).toBeNull();
      expect(decisions[0]?.reasons).toContain("evaluation_invalid");
    }
  });

  test("a workspace can disable automatic promotion and raise the threshold", () => {
    lifecycle.setPolicy(scope, {
      auto_promote_facts: false,
      fact_min_independent_runs: 2,
      require_human_approval_all: false,
    });
    const disabled = factCandidate("fact with promotion disabled");
    const verdict = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: disabled.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(verdict.reasons).toContain("auto_promotion_disabled");
    expect(mustGet(disabled.item.id).item.status).toBe("candidate");

    lifecycle.setPolicy(scope, {
      auto_promote_facts: true,
      fact_min_independent_runs: 3,
      require_human_approval_all: false,
    });
    const raised = factCandidate("fact under raised threshold");
    const raisedVerdict = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: raised.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(raisedVerdict.reasons).toContain("independent_support_below_threshold");

    const thirdRun = [...twoRuns, support("run_3", [citation("test", "t3")])];
    const promoted = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: raised.item.id,
        support: thirdRun,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(promoted.outcome).toBe("promoted");
  });

  test("the threshold has no setting below two independent runs", () => {
    expect(() =>
      lifecycle.setPolicy(scope, {
        auto_promote_facts: true,
        fact_min_independent_runs: 1,
        require_human_approval_all: false,
      }),
    ).toThrow(ValidationError);
  });

  test("requiring human approval for every item blocks even a clean fact", () => {
    lifecycle.setPolicy(scope, {
      auto_promote_facts: true,
      fact_min_independent_runs: 2,
      require_human_approval_all: true,
    });
    const record = factCandidate();
    const verdict = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(verdict.reasons).toContain("human_approval_required");
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });

  test("only candidates auto-promote", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "run", reference: "run_1" });
    const verdict = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: twoRuns,
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(verdict.reasons).toContain("not_candidate_status");
    expect(mustGet(record.item.id).item.status).toBe("proposed");
  });
});

// ---------------------------------------------------------------------------
// Procedural and policy content
// ---------------------------------------------------------------------------

describe("Procedural content requires named human approval", () => {
  test.each(["lesson", "playbook", "anti_pattern"] as const)(
    "a %s never auto-promotes, whatever its support",
    (kind) => {
      const record = candidateOf(kind, `procedural content ${kind}`);
      const decision = assessAndAutoPromote(
        scope,
        { memory, lifecycle },
        {
          itemId: record.item.id,
          support: [
            support("run_1", [citation("test", "t1")]),
            support("run_2", [citation("test", "t2")]),
          ],
          validation: ADMITTED,
          evaluation: OK_EVAL,
        },
      );
      expect(decision.outcome).toBe("blocked");
      expect(decision.reasons).toContain("procedural_requires_human_approval");
      expect(mustGet(record.item.id).item.status).toBe("candidate");
    },
  );

  test("institutional policy never auto-promotes", () => {
    const record = candidateOf("policy", "PRs require one human approval");
    const decision = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: [support("run_1", [citation("reviewer_decision", "r1")])],
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(decision.reasons).toContain("policy_requires_human_approval");
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });

  test("episodes have no promotion path", () => {
    const record = candidateOf("episode", "a completed run episode");
    const decision = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        support: [],
        validation: ADMITTED,
        evaluation: OK_EVAL,
      },
    );
    expect(decision.reasons).toContain("not_auto_promotable_kind");
  });

  test("the storage layer refuses activation of procedural content without approval", () => {
    const record = candidateOf("lesson", "reviewers require focused tests first");
    expect(() => memory.items.setStatus(scope, record.item.id, "active", 1)).toThrow(
      ValidationError,
    );

    memory.items.reviewVersion(scope, record.item.id, 1, "usr_lead");
    expect(memory.items.setStatus(scope, record.item.id, "active", 1).status).toBe("active");
  });

  test("institutional policy must be human-authored", () => {
    expect(() =>
      memory.items.create(
        scope,
        itemContent({
          kind: "policy",
          statement: "agents cannot approve their own runs",
          provenance: { author_type: "agent", agent_model: "test-model" },
        }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      memory.items.create(
        scope,
        itemContent({
          kind: "policy",
          statement: "agents cannot approve their own runs",
          provenance: { author_type: "system" },
        }),
      ),
    ).toThrow(ValidationError);
  });

  test("approveAndPromote stamps the named approver on the exact version", () => {
    const record = candidateOf("lesson", "lessons cite their evidence");
    const promoted = approveAndPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        version: 1,
      },
    );
    expect(promoted.item.status).toBe("active");
    expect(promoted.current.review?.approver_id).toBe(ACTOR);
    const decisions = lifecycle.listPromotionDecisions(scope, { item_id: record.item.id });
    expect(decisions[0]?.reasons).toEqual(["human_approved"]);
    expect(decisions[0]?.outcome).toBe("promoted");
  });

  test("approveAndPromote must name the current version", () => {
    const record = candidateOf("playbook", "playbooks state their preconditions");
    expect(() =>
      approveAndPromote(scope, { memory, lifecycle }, { itemId: record.item.id, version: 9 }),
    ).toThrow(ValidationError);
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });

  test("a human may promote a fact below the automatic threshold", () => {
    const record = factCandidate("a fact an owner vouches for");
    const promoted = approveAndPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        version: 1,
      },
    );
    expect(promoted.item.status).toBe("active");
    expect(promoted.current.review?.approver_id).toBe(ACTOR);
  });

  test("human-authored policy reaches active through approval", () => {
    const record = candidateOf("policy", "every merge needs one review");
    expect(() => memory.items.setStatus(scope, record.item.id, "active", 1)).toThrow(
      ValidationError,
    );
    const promoted = approveAndPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: record.item.id,
        version: 1,
      },
    );
    expect(promoted.item.status).toBe("active");
    expect(promoted.current.review?.approver_id).toBe(ACTOR);
  });
});

// ---------------------------------------------------------------------------
// Pure rule
// ---------------------------------------------------------------------------

describe("evaluatePromotion", () => {
  test("collects every applicable block reason", () => {
    const record = factCandidate();
    const decision = evaluatePromotion({
      record: mustGet(record.item.id),
      support: [support("run_unknown", [citation("test", "t1")], false)],
      validation: HELD,
      evaluation: null,
      policy: {
        auto_promote_facts: true,
        fact_min_independent_runs: 2,
        require_human_approval_all: true,
      },
      unresolved_contradictions: 1,
      evidence_count: 2,
    });
    expect(decision.outcome).toBe("blocked");
    expect(decision.reasons).toEqual([
      "human_approval_required",
      "independent_support_below_threshold",
      "validation_not_passed",
      "evaluation_missing",
      "unresolved_contradiction",
    ]);
    expect(decision.independent_support_runs).toBe(0);
    expect(decision.evaluation_delta).toBeNull();
  });
});
