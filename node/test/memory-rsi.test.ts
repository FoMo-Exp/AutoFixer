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
  RsiRunOutcome,
  RsiRunOutcomeSource,
  RsiService,
  RsiStore,
} from "../src/memory/index.js";

/**
 * DAT-238: bounded RSI. These tests drive the real memory store, the real
 * retrieval path (offline replay calls `preview`), and the RSI governance
 * service. The canary arm is fed from a recorded outcome source — the same
 * shape the task projection implements — never from request fields.
 */

let db: ControlPlaneDb;
let scope: WorkspaceScope;
let otherScope: WorkspaceScope;
let memory: MemoryRepositories;
let retrievalStore: RetrievalStore;
let store: RsiStore;
let rsi: RsiService;
let outcomes: Map<string, RsiRunOutcome>;
let runSeq: number;

const OWNER = "usr_owner";
const ADMIN = "usr_admin";
const PROPOSER = "agent_proposer";
const GOLDEN_CASES = 20;
const HOLDOUT_CASES = 20;
const HOLDOUT_SECRET_QUERY = "HOLDOUT-SECRET-QUERY build flag rollout";
const ACTOR: { id: string; role: "owner" | "admin" | "member" } = { id: OWNER, role: "owner" };

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

function evaluate(proposal: RsiProposalView, actor = ACTOR): RsiProposalView {
  return rsi.evaluate(scope, proposal.proposal_id, {}, actor);
}

function approveAsOwner(proposal: RsiProposalView): RsiProposalView {
  return rsi.approve(scope, proposal.proposal_id, { id: OWNER, role: "owner" });
}

function recordOutcome(runId: string, overrides: Partial<RsiRunOutcome> = {}): void {
  outcomes.set(runId, {
    run_id: runId,
    terminal: true,
    success: true,
    rework: false,
    safety_events: 0,
    actions: 4,
    observed_at: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });
}

/**
 * Pin one run into the requested arm at the given canary share. The bucket is
 * deterministic, so the helper searches run ids until the resolver agrees.
 */
function pinRun(
  arm: "candidate" | "baseline",
  share: number,
  outcome: Partial<RsiRunOutcome> = {},
): string {
  for (;;) {
    runSeq += 1;
    const runId = `run_${arm}_${runSeq}`;
    const wouldSelect = canaryBucket(scope.workspace_id, runId) < share * 100;
    if (wouldSelect !== (arm === "candidate")) {
      continue;
    }
    const pin = rsi.resolveRunVersions(scope, runId);
    if (pin.canary !== (arm === "candidate")) {
      continue;
    }
    recordOutcome(runId, outcome);
    return runId;
  }
}

function seedArms(
  count: number,
  share: number,
  overrides: { candidate?: Partial<RsiRunOutcome>; baseline?: Partial<RsiRunOutcome> } = {},
): void {
  for (let index = 0; index < count; index += 1) {
    pinRun("candidate", share, overrides.candidate ?? {});
    pinRun("baseline", share, overrides.baseline ?? {});
  }
}

function observe(proposal: RsiProposalView): RsiProposalView {
  return rsi.recordCanaryObservation(scope, proposal.proposal_id, ACTOR);
}

function completeCanary(proposal: RsiProposalView): RsiProposalView {
  const started = rsi.startCanary(scope, proposal.proposal_id, ACTOR);
  seedArms(50, 10);
  let view = observe(started);
  view = observe(view);
  view = observe(view);
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
  outcomes = new Map<string, RsiRunOutcome>();
  runSeq = 0;
  const outcomeSource: RsiRunOutcomeSource = {
    outcomeFor: (runId) => outcomes.get(runId) ?? null,
  };
  rsi = createRsiService({ store, memory, retrieval, retrievalStore, outcomes: outcomeSource });
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
  test("the proposer cannot verify its own proposal and only an owner may evaluate", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    expect(() => evaluate(proposal, { id: PROPOSER, role: "owner" })).toThrow(/independent/);
    expect(() => evaluate(proposal, { id: "usr_member", role: "member" })).toThrow(/owner role/);
    expect(store.listEvaluations(scope, proposal.proposal_id)).toHaveLength(0);
  });

  test("the stored verifier is the authenticated actor with a server-derived reference", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    const evaluated = evaluate(proposal, { id: "usr_evaluator", role: "owner" });
    expect(evaluated.evaluations).toHaveLength(2);
    for (const evaluation of evaluated.evaluations) {
      expect(evaluation.verifier).toEqual({
        kind: "test",
        id: "usr_evaluator",
        reference: `replay:${proposal.proposal_id}:v${proposal.version}:${evaluation.dataset}`,
      });
    }
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
    expect(() => rsi.startCanary(scope, proposal.proposal_id, ACTOR)).toThrow(ConflictError);
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
    const orphan = rsi.createProposal(
      otherScope,
      proposalInput(fixture, { proposer: { id: PROPOSER, kind: "agent" } }),
    );
    expect(() =>
      rsi.evaluate(otherScope, orphan.proposal_id, {}, { id: "usr_other_owner", role: "owner" }),
    ).toThrow(/has no cases/);
  });

  test("another workspace cannot read or evaluate the proposal", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    expect(() => rsi.getProposal(otherScope, proposal.proposal_id)).toThrow(NotFoundError);
    expect(() =>
      rsi.evaluate(otherScope, proposal.proposal_id, {}, { id: OWNER, role: "owner" }),
    ).toThrow(NotFoundError);
  });
});

describe("human gates", () => {
  test("B needs a named human, and the proposer cannot be that human", () => {
    const fixture = seedFixture();
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
    expect(new Set(second.approvals.map((entry) => entry.approver_id)).size).toBe(2);
  });

  test("class A can skip human approval only when the workspace enables it", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    expect(() => rsi.startCanary(scope, proposal.proposal_id, ACTOR)).toThrow(/human approval/);

    rsi.updateControls(scope, { auto_promote_low_risk: true }, ACTOR);
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
    expect(promoted.observations.length).toBeGreaterThanOrEqual(3);
    expect(promoted.observations[0]?.evidence_reference).toMatch(/^pins:/);
  });

  test("a canary with too few terminal runs stays inconclusive and does not advance", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    seedArms(3, 10);
    const short = observe(proposal);
    expect(short.rollout?.stage).toBe(10);
    expect(short.status).toBe("canary");
    expect(short.observations[0]?.verdict).toBe("inconclusive");
  });

  test("an observation is refused when no pinned run is terminal yet", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    expect(() => observe(proposal)).toThrow(/no runs are pinned/);
    expect(
      store.listObservations(
        scope,
        rsi.getProposal(scope, proposal.proposal_id).rollout?.rollout_id ?? "",
      ),
    ).toHaveLength(0);
  });

  test("a security event in a recorded run rolls the canary back immediately", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    seedArms(10, 10, { candidate: { safety_events: 1 } });
    const rolled = observe(proposal);
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.rollout?.status).toBe("rolled_back");
    expect(rolled.rollout?.reason).toMatch(/security events/);
  });

  test("a recorded regression rolls the canary back before promotion", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    seedArms(10, 10, { candidate: { success: false } });
    const rolled = observe(proposal);
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.rollout?.reason).toMatch(/automatic rollback/);
    expect(retrievalStore.getPolicy(scope)?.version).toBe(
      rsi.getProposal(scope, proposal.proposal_id).baseline_policy_version,
    );
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

    const rolled = rsi.rollback(scope, proposal.proposal_id, "reviewer regression", ACTOR);
    expect(rolled.status).toBe("rolled_back");
    const reverted = retrievalStore.getPolicy(scope);
    expect(reverted?.policy_hash).toBe(baseline.policy_hash);
    expect(reverted?.version).toBeGreaterThan(baseline.version);
  });

  test("a workspace serializes canaries: a second rollout is refused", () => {
    const fixture = seedFixture();
    const first = rsi.createProposal(scope, proposalInput(fixture));
    const second = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(first);
    approveAsOwner(first);
    evaluate(second);
    approveAsOwner(second);

    rsi.startCanary(scope, first.proposal_id, ACTOR);
    expect(store.listActiveRollouts(scope)).toHaveLength(1);
    expect(() => rsi.startCanary(scope, second.proposal_id, ACTOR)).toThrow(/serialized/);
    expect(store.getRollout(scope, first.proposal_id)?.status).toBe("canary");
    expect(store.getRollout(scope, second.proposal_id)).toBeUndefined();
  });

  test("a proposal cannot canary against a baseline that moved since evaluation", () => {
    const fixture = seedFixture();
    const promoted = rsi.createProposal(scope, proposalInput(fixture));
    const stale = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(promoted);
    approveAsOwner(promoted);
    evaluate(stale);
    approveAsOwner(stale);

    completeCanary(promoted);
    expect(retrievalStore.getPolicy(scope)?.version).toBe(promoted.baseline_policy_version + 1);
    expect(() => rsi.startCanary(scope, stale.proposal_id, ACTOR)).toThrow(/baseline policy moved/);

    // A proposal opened after the promotion carries the new baseline and can run.
    const fresh = rsi.createProposal(scope, proposalInput(fixture));
    expect(fresh.baseline_policy_version).toBe(promoted.baseline_policy_version + 1);
    evaluate(fresh);
    approveAsOwner(fresh);
    expect(rsi.startCanary(scope, fresh.proposal_id, ACTOR).rollout?.stage).toBe(10);
  });

  test("a baseline change during the canary blocks promotion with a rollback", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    seedArms(50, 10);

    // Simulate an administrative policy change while the canary is running.
    retrievalStore.createPolicyVersion(scope, policyWith());
    const first = observe(proposal);
    const second = observe(first);
    const final = observe(second);
    expect(final.status).toBe("rolled_back");
    expect(final.rollout?.reason).toMatch(/baseline policy changed during the canary/);
    expect(retrievalStore.getPolicy(scope)?.version).toBe(proposal.baseline_policy_version + 1);
  });

  test("the weekly change budget blocks a second promotion", () => {
    const fixture = seedFixture();
    rsi.updateControls(scope, { weekly_change_budget: 1 }, ACTOR);
    const first = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(first);
    approveAsOwner(first);
    completeCanary(first);
    expect(rsi.status(scope).budget.changes_remaining).toBe(0);

    const second = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(second);
    const approved = approveAsOwner(second);
    expect(approved.gate.canary_eligible).toBe(false);
    expect(() => rsi.startCanary(scope, second.proposal_id, ACTOR)).toThrow(/change budget/);
  });

  test("the reflection-token budget blocks evaluation before it records anything", () => {
    const fixture = seedFixture();
    rsi.updateControls(scope, { weekly_reflection_token_budget: 0 }, ACTOR);
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
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    expect(store.listActiveRollouts(scope)).toHaveLength(1);

    const controls = rsi.setKillSwitch(scope, true, "security incident", ACTOR);
    expect(controls.kill_switch).toBe(true);
    expect(store.listActiveRollouts(scope)).toHaveLength(0);
    expect(rsi.getProposal(scope, proposal.proposal_id).status).toBe("rolled_back");
    expect(() => rsi.startCanary(scope, proposal.proposal_id, ACTOR)).toThrow(/kill switch/);
    expect(() => rsi.setKillSwitch(scope, true, null, ACTOR)).toThrow(/requires a reason/);
  });

  test("a run pin is stable, is reproducible, and never flips when the canary rolls back", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);

    const canaryRun = pinRun("candidate", 10);
    const baselineRun = pinRun("baseline", 10);

    const canaryPin = rsi.resolveRunVersions(scope, canaryRun);
    expect(canaryPin.canary).toBe(true);
    expect(canaryPin.policy).not.toBeNull();
    const repeated = rsi.resolveRunVersions(scope, canaryRun);
    expect(repeated.created_at).toBe(canaryPin.created_at);
    expect(repeated.policy_hash).toBe(canaryPin.policy_hash);

    const baselinePin = rsi.resolveRunVersions(scope, baselineRun);
    expect(baselinePin.canary).toBe(false);
    expect(baselinePin.policy).toBeNull();

    rsi.rollback(scope, proposal.proposal_id, "replay regression", ACTOR);
    const afterRollback = rsi.getRunPin(scope, canaryRun);
    expect(afterRollback?.policy_hash).toBe(canaryPin.policy_hash);
    expect(afterRollback?.policy_version).toBe(canaryPin.policy_version);
  });

  test("the kill switch makes new runs resolve to the baseline policy", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    rsi.setKillSwitch(scope, true, "incident", ACTOR);

    const resolved = rsi.resolveRunVersions(scope, "run-after-kill");
    expect(resolved.canary).toBe(false);
    expect(resolved.policy).toBeNull();
    expect(resolved.proposal_id).toBeNull();
  });

  test("canary samples come from pinned runs, not from the caller", () => {
    const fixture = seedFixture();
    const proposal = rsi.createProposal(scope, proposalInput(fixture));
    evaluate(proposal);
    approveAsOwner(proposal);
    rsi.startCanary(scope, proposal.proposal_id, ACTOR);
    // Only baseline runs exist: the candidate arm has no sample, so the gate
    // cannot pass even though the baseline looks perfect.
    for (let index = 0; index < 20; index += 1) {
      pinRun("baseline", 10);
    }
    const view = observe(proposal);
    expect(view.observations[0]?.candidate_sample_size).toBe(0);
    expect(view.observations[0]?.verdict).toBe("inconclusive");
    expect(view.rollout?.stage).toBe(10);
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

  test("per-arm samples are both required", () => {
    const verdict = verdictFor({ ...baseMetrics(), baseline_sample_size: 19 });
    expect(verdict.verdict).toBe("inconclusive");
  });

  test("the ISO budget week starts on Monday", () => {
    expect(isoWeekStart(new Date("2026-11-04T12:00:00.000Z"))).toBe("2026-11-02");
    expect(isoWeekStart(new Date("2026-11-02T00:00:00.000Z"))).toBe("2026-11-02");
  });
});

function baseMetrics() {
  return {
    sample_size: 40,
    baseline_sample_size: 20,
    candidate_sample_size: 20,
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
