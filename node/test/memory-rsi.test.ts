import { beforeEach, describe, expect, test } from "vitest";

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  DEFAULT_RETRIEVAL_POLICY,
  canaryBucket,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  createRsiService,
  createRsiStore,
  isoWeekStart,
  newcombeDifference,
  verdictFor,
} from "../src/memory/index.js";
import type {
  CreateRsiProposalInput,
  MemoryItemRecord,
  MemoryRepositories,
  RetrievalPolicy,
  RetrievalStore,
  RsiProposalView,
  RsiService,
  RsiStore,
} from "../src/memory/index.js";

/**
 * DAT-238: bounded RSI. These tests drive the real memory store, the real
 * retrieval path (offline replay calls `preview`), and the RSI governance
 * service. Nothing is mocked except identities, which are just strings.
 */

let db: ControlPlaneDb;
let scope: WorkspaceScope;
let otherScope: WorkspaceScope;
let memory: MemoryRepositories;
let retrievalStore: RetrievalStore;
let store: RsiStore;
let rsi: RsiService;

const OWNER = "usr_owner";
const ADMIN = "usr_admin";
const PROPOSER = "agent_proposer";
const VERIFIER = "qa_verifier";
const GOLDEN_CASES = 20;
const HOLDOUT_CASES = 20;
const HOLDOUT_SECRET_QUERY = "HOLDOUT-SECRET-QUERY build flag rollout";

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "RSI Enterprise",
    enterprise_slug: "rsi-ent",
    admin_user_id: "usr_root",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "RSI Workspace",
    repository_id: "repo-rsi",
    provider_instance_id: provider.id,
  });
  const other = seedWorkspace(db, admin_scope, {
    name: "Other Workspace",
    repository_id: "repo-other",
    provider_instance_id: provider.id,
  });
  void enterprise;
  otherScope = {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: other.id,
    actor_id: "usr_other",
  };
  return {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: workspace.id,
    actor_id: OWNER,
  };
}

function createLesson(statement: string, status: "active" | "candidate"): MemoryItemRecord {
  const record = memory.items.create(scope, {
    kind: "lesson",
    scope: { path_prefix: "node/src/memory" },
    statement,
    preconditions: ["node workspace"],
    provenance: { author_type: "agent", agent_model: "test-model" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
  });
  memory.evidence.add(scope, record.item.id, {
    evidence_type: "test",
    reference: `test:${record.item.id}`,
  });
  if (status === "active") {
    memory.items.reviewVersion(scope, record.item.id, 1, "usr_human_reviewer");
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
    memory.items.setStatus(scope, record.item.id, "active", 1);
  } else {
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
  }
  return memory.items.getById(scope, record.item.id) as MemoryItemRecord;
}

function policyWith(overrides: Partial<RetrievalPolicy["bounds"]> = {}): RetrievalPolicy {
  return {
    weights: { ...DEFAULT_RETRIEVAL_POLICY.weights },
    hybrid_weights: { ...DEFAULT_RETRIEVAL_POLICY.hybrid_weights },
    bounds: {
      ...DEFAULT_RETRIEVAL_POLICY.bounds,
      trust_class_weights: { ...DEFAULT_RETRIEVAL_POLICY.bounds.trust_class_weights },
      evidence_class_boost: { ...DEFAULT_RETRIEVAL_POLICY.bounds.evidence_class_boost },
      ...overrides,
    },
  } as RetrievalPolicy;
}

function seedCases(expectedItemId: string, forbiddenItemId?: string): void {
  for (let index = 0; index < GOLDEN_CASES; index += 1) {
    store.addGoldenCase(
      scope,
      {
        case_id: `golden-${index}`,
        dataset: "golden",
        query: "node memory tests build command",
        scope: { path_prefix: "node/src/memory" },
        role: "owner",
        expected_item_ids: [expectedItemId],
        forbidden_item_ids: forbiddenItemId === undefined ? [] : [forbiddenItemId],
      },
      OWNER,
    );
  }
  for (let index = 0; index < HOLDOUT_CASES; index += 1) {
    store.addHoldoutCase(
      scope,
      {
        case_id: `holdout-${index}`,
        dataset: "holdout",
        query: HOLDOUT_SECRET_QUERY,
        scope: { path_prefix: "node/src/memory" },
        role: "owner",
        expected_item_ids: [expectedItemId],
        forbidden_item_ids: forbiddenItemId === undefined ? [] : [forbiddenItemId],
      },
      OWNER,
    );
  }
}

interface Fixture {
  activeLessonId: string;
  candidate: MemoryItemRecord;
}

function seedFixture(options: { forbiddenCandidate?: boolean } = {}): Fixture {
  const active = createLesson("Run node memory tests before delivery", "active");
  const candidate = createLesson("Prefer bounded previews for replay evaluation", "candidate");
  seedCases(active.item.id, options.forbiddenCandidate ? candidate.item.id : undefined);
  return { activeLessonId: active.item.id, candidate };
}

function proposalInput(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    title: "Tighten retrieval relevance",
    summary: "Bounded weight change backed by replay",
    diff: "- relevance: 0.45\n+ relevance: 0.5",
    target: "retrieval_weights",
    proposer: { id: PROPOSER, kind: "agent", model: "test-model" },
    candidate_policy: policyWith(),
    ...overrides,
  } as CreateRsiProposalInput;
}

function approveAsOwner(proposal: RsiProposalView): RsiProposalView {
  return rsi.approve(scope, proposal.proposal_id, { id: OWNER, role: "owner" });
}

function evaluate(proposal: RsiProposalView): RsiProposalView {
  return rsi.evaluate(scope, proposal.proposal_id, {
    verifier: { kind: "test", id: VERIFIER, reference: "test:memory-rsi" },
  });
}

function completeCanary(proposal: RsiProposalView): RsiProposalView {
  const stages = [{ sample: 10 }, { sample: 25 }, { sample: 50 }];
  let view = rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" });
  for (const stage of stages) {
    view = rsi.recordCanaryObservation(
      scope,
      proposal.proposal_id,
      {
        sample_size: stage.sample,
        baseline_successes: Math.floor(stage.sample * 0.9),
        candidate_successes: Math.floor(stage.sample * 0.9),
        evidence_reference: `qa:canary-${stage.sample}`,
      },
      { id: OWNER, role: "owner" },
    );
  }
  return view;
}

beforeEach(() => {
  db = openControlPlaneDb();
  migrate(db);
  scope = bootstrap();
  memory = createMemoryRepositories(db);
  retrievalStore = createRetrievalStore(db);
  const retrieval = createMemoryRetrievalService({ memory, store: retrievalStore });
  store = createRsiStore(db);
  rsi = createRsiService({ store, memory, retrieval, retrievalStore });
});

describe("risk ladder", () => {
  test("class D targets are refused before any row is written", () => {
    const fixture = seedFixture();
    expect(() =>
      rsi.createProposal(scope, proposalInput(fixture, { target: "capability_grant" })),
    ).toThrow(ValidationError);
    expect(store.listProposals(scope)).toHaveLength(0);
  });

  test("the server derives risk from the target, not from the caller", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(
      scope,
      proposalInput(fixture, {
        target: "lesson",
        candidate_policy: undefined,
        memory_item: { item_id: fixture.candidate.item.id, item_version: 1 },
      }),
    );
    expect(proposal.risk).toBe("B");
    expect(proposal.target).toBe("lesson");

    const policyProposal = rsi.createProposal(
      scope,
      proposalInput(fixture, { target: "retrieval_bounds" }),
    );
    expect(policyProposal.risk).toBe("C");
  });
});

describe("offline replay and independent verification", () => {
  test("agent self-report and proposer verification are refused", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    expect(() =>
      rsi.evaluate(scope, proposal.proposal_id, {
        verifier: { kind: "agent_self_report" as never, id: PROPOSER, reference: "self" },
      }),
    ).toThrow(ValidationError);
    expect(() =>
      rsi.evaluate(scope, proposal.proposal_id, {
        verifier: { kind: "test", id: PROPOSER, reference: "self-run" },
      }),
    ).toThrow(/independent verifier/);
    expect(store.listEvaluations(scope, proposal.proposal_id)).toHaveLength(0);
  });

  test("a candidate that loses cases fails the gate and cannot canary", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(
      scope,
      proposalInput(fixture, { candidate_policy: policyWith({ relevance_floor: 1 }) }),
    );
    const evaluated = evaluate(proposal);
    expect(evaluated.gate.offline_evaluation).toBe("fail");
    expect(evaluated.status).toBe("blocked");
    expect(evaluated.gate.canary_eligible).toBe(false);
    expect(() =>
      rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" }),
    ).toThrow(ConflictError);
  });

  test("a replay that improves nothing but regresses nothing passes both datasets", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    const evaluated = evaluate(proposal);
    expect(evaluated.evaluations).toHaveLength(2);
    expect(evaluated.evaluations.map((entry) => entry.dataset).sort()).toEqual([
      "golden",
      "holdout",
    ]);
    expect(evaluated.gate.offline_evaluation).toBe("pass");
    expect(evaluated.gate.holdout_required).toBe(true);
  });

  test("holdout content never appears in a proposal, evaluation, or status payload", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    const evaluated = evaluate(proposal);
    const serialized = JSON.stringify({
      evaluated,
      status: rsi.status(scope),
      list: rsi.listProposals(scope),
    });
    expect(serialized).not.toContain("HOLDOUT-SECRET-QUERY");
    expect(rsi.status(scope).holdout.cases).toBe(HOLDOUT_CASES);
    expect(rsi.status(scope).holdout.last_evaluated_at).not.toBeNull();
    expect(() => store.listHoldoutCases(scope, {})).toThrow(/RSI evaluator/);
  });

  test("an empty dataset is a refusal, not a pass", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    const emptyScope = { ...scope, workspace_id: otherScope.workspace_id };
    expect(() =>
      rsi.evaluate(emptyScope, proposal.proposal_id, {
        verifier: { kind: "test", id: VERIFIER, reference: "test:empty" },
      }),
    ).toThrow(NotFoundError);
  });

  test("another workspace cannot read or evaluate the proposal", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    expect(() => rsi.getProposal(otherScope, proposal.proposal_id)).toThrow(NotFoundError);
  });
});

describe("human gates", () => {
  test("B needs a named human, and the proposer cannot be that human", () => {
    const fixture = seedFixture();
    // A bare two-item corpus would make one extra candidate double the bundle
    // cost; a realistic full bundle keeps the cost signal about real growth.
    for (let index = 0; index < 7; index += 1) {
      createLesson(`node memory tests filler ${index}`, "active");
    }
    const proposal = rsi.createProposal(
      scope,
      proposalInput(fixture, {
        target: "lesson",
        candidate_policy: undefined,
        memory_item: { item_id: fixture.candidate.item.id, item_version: 1 },
      }),
    );
    const evaluated = evaluate(proposal);
    expect(evaluated.status).toBe("awaiting_approval");
    expect(() => rsi.approve(scope, proposal.proposal_id, { id: PROPOSER, role: "owner" })).toThrow(
      /proposer cannot approve/,
    );
    expect(() =>
      rsi.approve(scope, proposal.proposal_id, { id: "usr_member", role: "member" }),
    ).toThrow(/owner or admin/);
    const approved = approveAsOwner(proposal);
    expect(approved.gate.approvals_satisfied).toBe(1);
    expect(approved.gate.canary_eligible).toBe(true);
  });

  test("C needs two distinct humans: owner and admin", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(
      scope,
      proposalInput(fixture, { target: "retrieval_bounds" }),
    );
    evaluate(proposal);
    const first = approveAsOwner(proposal);
    expect(first.gate.approvals_satisfied).toBe(1);
    expect(first.gate.approvals_required).toBe(2);
    expect(first.status).toBe("awaiting_approval");
    const second = rsi.approve(scope, proposal.proposal_id, { id: ADMIN, role: "admin" });
    expect(second.gate.approvals_satisfied).toBe(2);
    expect(second.gate.canary_eligible).toBe(true);
    // The same human approving twice cannot satisfy a two-key gate.
    expect(new Set(second.approvals.map((entry) => entry.approver_id)).size).toBe(2);
  });

  test("class A can skip human approval only when the workspace enables it", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    expect(() =>
      rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" }),
    ).toThrow(/human approval/);

    rsi.updateControls(scope, { auto_promote_low_risk: true }, { id: OWNER, role: "owner" });
    const enabled = rsi.getProposal(scope, proposal.proposal_id);
    expect(enabled.gate.approvals_required).toBe(0);
    expect(enabled.gate.canary_eligible).toBe(true);
  });
});

describe("canary, promotion, rollback", () => {
  test("10% → 50% → 100% promotion publishes exactly one policy version", () => {
    const fixture = seedFixture();
    const before = retrievalStore.ensurePolicy(scope).version;
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    const promoted = completeCanary(proposal);
    expect(promoted.status).toBe("promoted");
    expect(promoted.rollout?.status).toBe("promoted");
    expect(promoted.applied_policy_version).toBe(before + 1);
    expect(retrievalStore.getPolicy(scope)?.version).toBe(before + 1);
    expect(rsi.status(scope).budget.changes_promoted).toBe(1);
  });

  test("a canary-only evidence gap stays inconclusive and does not advance", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" });
    const short = rsi.recordCanaryObservation(
      scope,
      proposal.proposal_id,
      {
        sample_size: 3,
        baseline_successes: 3,
        candidate_successes: 3,
        evidence_reference: "qa:too-small",
      },
      { id: OWNER, role: "owner" },
    );
    expect(short.rollout?.stage).toBe(10);
    expect(short.status).toBe("canary");
  });

  test("a security event in canary rolls back immediately", () => {
    const fixture = seedFixture();
    const policyProposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(policyProposal);
    approveAsOwner(policyProposal);
    rsi.startCanary(scope, policyProposal.proposal_id, { id: OWNER, role: "owner" });
    const rolled = rsi.recordCanaryObservation(
      scope,
      policyProposal.proposal_id,
      {
        sample_size: 10,
        baseline_successes: 9,
        candidate_successes: 2,
        safety_events: 1,
        evidence_reference: "incident:canary-1",
      },
      { id: OWNER, role: "owner" },
    );
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.rollout?.status).toBe("rolled_back");
    expect(rolled.rollout?.reason).toMatch(/security events/);
  });

  test("promoted changes can be rolled back to the baseline policy content", () => {
    const fixture = seedFixture();
    const baseline = retrievalStore.ensurePolicy(scope);
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    completeCanary(proposal);
    const promoted = rsi.getProposal(scope, proposal.proposal_id);
    expect(promoted.status).toBe("promoted");

    const rolled = rsi.rollback(scope, proposal.proposal_id, "reviewer regression", {
      id: OWNER,
      role: "owner",
    });
    expect(rolled.status).toBe("rolled_back");
    const reverted = retrievalStore.getPolicy(scope);
    expect(reverted?.policy_hash).toBe(baseline?.policy_hash);
    expect(reverted?.version).toBeGreaterThan(baseline?.version ?? 0);
  });

  test("the weekly change budget blocks a second promotion", () => {
    const fixture = seedFixture();
    rsi.updateControls(scope, { weekly_change_budget: 1 }, { id: OWNER, role: "owner" });
    const first = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(first);
    approveAsOwner(first);
    completeCanary(first);
    expect(rsi.status(scope).budget.changes_remaining).toBe(0);

    const second = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(second);
    const approved = approveAsOwner(second);
    expect(approved.gate.canary_eligible).toBe(false);
    expect(() => rsi.startCanary(scope, second.proposal_id, { id: OWNER, role: "owner" })).toThrow(
      /change budget/,
    );
  });

  test("the reflection-token budget blocks evaluation before it records anything", () => {
    const fixture = seedFixture();
    rsi.updateControls(scope, { weekly_reflection_token_budget: 0 }, { id: OWNER, role: "owner" });
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    expect(() => evaluate(proposal)).toThrow(/reflection token budget/);
    expect(store.listEvaluations(scope, proposal.proposal_id)).toHaveLength(0);
  });
});

describe("kill switch and run pins", () => {
  test("the kill switch rolls back an active canary in the same call", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" });
    expect(store.listActiveRollouts(scope)).toHaveLength(1);

    const controls = rsi.setKillSwitch(scope, true, "security incident", {
      id: OWNER,
      role: "owner",
    });
    expect(controls.kill_switch).toBe(true);
    expect(store.listActiveRollouts(scope)).toHaveLength(0);
    expect(rsi.getProposal(scope, proposal.proposal_id).status).toBe("rolled_back");
    expect(() =>
      rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" }),
    ).toThrow(/kill switch/);
    expect(() => rsi.setKillSwitch(scope, true, null, { id: OWNER, role: "owner" })).toThrow(
      /requires a reason/,
    );
  });

  test("a run pin is stable, is reproducible, and never flips when the canary rolls back", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" });

    const canaryRun = Array.from({ length: 500 }, (_, index) => `run-canary-${index}`).find(
      (runId) => canaryBucket(scope.workspace_id, runId) < 10 * 100,
    );
    const baselineRun = Array.from({ length: 500 }, (_, index) => `run-base-${index}`).find(
      (runId) => canaryBucket(scope.workspace_id, runId) >= 10 * 100,
    );
    expect(canaryRun).toBeDefined();
    expect(baselineRun).toBeDefined();

    const canaryPin = rsi.resolveRunVersions(scope, canaryRun as string);
    expect(canaryPin.canary).toBe(true);
    expect(canaryPin.policy).not.toBeNull();
    const repeated = rsi.resolveRunVersions(scope, canaryRun as string);
    expect(repeated.created_at).toBe(canaryPin.created_at);
    expect(repeated.policy_hash).toBe(canaryPin.policy_hash);

    const baselinePin = rsi.resolveRunVersions(scope, baselineRun as string);
    expect(baselinePin.canary).toBe(false);
    expect(baselinePin.policy).toBeNull();

    rsi.rollback(scope, proposal.proposal_id, "replay regression", {
      id: OWNER,
      role: "owner",
    });
    const afterRollback = rsi.getRunPin(scope, canaryRun as string);
    expect(afterRollback?.policy_hash).toBe(canaryPin.policy_hash);
    expect(afterRollback?.policy_version).toBe(canaryPin.policy_version);
  });

  test("the kill switch makes new runs resolve to the baseline policy", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, { id: OWNER, role: "owner" });
    rsi.setKillSwitch(scope, true, "incident", { id: OWNER, role: "owner" });

    const resolved = rsi.resolveRunVersions(scope, "run-after-kill");
    expect(resolved.canary).toBe(false);
    expect(resolved.policy).toBeNull();
    expect(resolved.proposal_id).toBeNull();
  });
});

describe("statistics and bounds", () => {
  test("a regression verdict requires the confidence interval to establish it", () => {
    const regression = newcombeDifference(0, 20, 20, 20);
    expect(
      verdictFor({
        ...baseMetrics(),
        success_delta: regression.delta,
        delta_ci_low: regression.low,
        delta_ci_high: regression.high,
      }).verdict,
    ).toBe("fail");
    const flat = newcombeDifference(20, 20, 20, 20);
    expect(
      verdictFor({
        ...baseMetrics(),
        success_delta: flat.delta,
        delta_ci_low: flat.low,
        delta_ci_high: flat.high,
      }).verdict,
    ).toBe("pass");
  });

  test("the ISO budget week starts on Monday", () => {
    expect(isoWeekStart(new Date("2026-11-04T12:00:00.000Z"))).toBe("2026-11-02");
    expect(isoWeekStart(new Date("2026-11-02T00:00:00.000Z"))).toBe("2026-11-02");
  });
});

function baseMetrics() {
  return {
    sample_size: 20,
    baseline_successes: 20,
    candidate_successes: 20,
    baseline_rework: 0,
    candidate_rework: 0,
    baseline_cost: 100,
    candidate_cost: 100,
    safety_events: 0,
    success_delta: 0,
    delta_ci_low: -0.1,
    delta_ci_high: 0.1,
  };
}
