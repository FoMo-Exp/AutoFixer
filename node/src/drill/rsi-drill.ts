/**
 * DAT-271: isolated, reproducible synthetic-data drill for the bounded RSI
 * loop.
 *
 * This module drives the real stores and services — the control-plane schema,
 * the memory repositories, the retrieval path, the RSI governance service, and
 * the task-projection outcome adapter — against a synthetic workspace created
 * in an in-memory SQLite database. It proves the loop's fail-closed properties
 * rather than simulating a passing report:
 *
 *   proposal → independent golden/holdout replay → named human approval →
 *   canary pins → promotion → rollback / kill switch
 *
 * What it does NOT do: it never calls a model, a gateway, dsh, a provider, or
 * a network endpoint, and it uses no production data, credential, or
 * permission. The report says so explicitly (`scope.production_enabled` is
 * false). Every synthetic identifier is generated inside the drill; the only
 * stable values carried into the transcript digest are governance facts.
 *
 * Reproducibility: `runRsiDrill` executes the whole drill in fresh in-memory
 * databases and hashes a normalized transcript (statuses, verdicts, gate
 * booleans, pin invariants). Random row ids and wall-clock timestamps are
 * deliberately excluded, so two runs on the same code produce the same
 * digest. The CLI runs the drill twice by default.
 */

import { createHash } from "node:crypto";

import { rsiOpenApiPaths } from "../api/openapi-rsi.js";
import { createTaskRunOutcomes } from "../api/run-outcomes.js";
import { TaskStore, createTaskRecord } from "../api/task-store.js";
import type { TaskRecord } from "../api/task-store.js";
import {
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../control-plane/index.js";
import {
  DEFAULT_RETRIEVAL_POLICY,
  canaryBucket,
  computeMemoryVersion,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  createRsiService,
  createRsiStore,
} from "../memory/index.js";
import type {
  MemoryItemRecord,
  MemoryRetrievalService,
  MemoryRepositories,
  RetrievalPolicy,
  RetrievalStore,
  RsiActor,
  RsiProposalView,
  RsiRunPin,
  RsiService,
  RsiStore,
} from "../memory/index.js";
import * as rsiSurface from "../memory/rsi/index.js";

export const DRILL_NAME = "rsi-offline-holdout-approval-rollback";
export const DRILL_VERSION = 1;

/** Fixed replay clock: recency scoring and the ISO budget week are stable. */
const DRILL_NOW = new Date("2026-11-02T12:00:00.000Z");
const DRILL_NOW_ISO = DRILL_NOW.toISOString();

/** Synthetic holdout marker. It must never appear in any output payload. */
const HOLDOUT_SECRET = "HOLDOUT-DRILL-SECRET-7f3a";
const GOLDEN_QUERY = "node memory tests build command before delivery";
const HOLDOUT_QUERY = `${HOLDOUT_SECRET} node memory tests build command`;
const FORBIDDEN_QUERY = "node memory tests build command bounded previews replay evaluation";

const GOLDEN_CASES = 20;
const HOLDOUT_CASES = 20;

const OWNER = "usr_drill_owner";
const ADMIN = "usr_drill_admin";
const MEMBER = "usr_drill_member";
const PROPOSER = "agent_drill_proposer";
const OTHER_OWNER = "usr_drill_other_owner";

const OWNER_ACTOR = { id: OWNER, role: "owner" as const };
const ADMIN_ACTOR = { id: ADMIN, role: "admin" as const };
const MEMBER_ACTOR = { id: MEMBER, role: "member" as const };
const OTHER_OWNER_ACTOR = { id: OTHER_OWNER, role: "owner" as const };

const DRILL_REPOSITORY: TaskRecord["repository"] = {
  id: "github:drill/synthetic",
  display_name: "drill/synthetic",
  base_ref: "main",
  base_sha: "0".repeat(40),
};

const FILLER_LESSONS = [
  "Sandbox profiles deny network access by default",
  "Approval quorum needs a named human reviewer",
  "Trace retention follows the workspace policy",
  "Provider credentials never enter the agent process",
  "Broker opens a pull request only after approval",
  "Budget ledger is append-only",
  "Case rotation follows a schedule",
  "Workspace notes are advisory data",
  "Evidence bundles bind the head SHA",
];

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export interface RsiDrillCheck {
  id: string;
  description: string;
  ok: boolean;
  /** Stable wording: never contains generated ids, timestamps, or case text. */
  evidence: string;
}

export type RsiDrillFact = string | number | boolean | readonly (string | number)[];

export interface RsiDrillAct {
  act: string;
  facts: Record<string, RsiDrillFact>;
  checks: RsiDrillCheck[];
}

export interface RsiDrillScope {
  kind: "synthetic_offline_drill";
  synthetic_data: true;
  production_enabled: false;
  real_model_calls: 0;
  real_provider_calls: 0;
  real_permissions_used: false;
  network_access: false;
  dsh_execution: false;
}

export interface RsiDrillSynthetic {
  enterprise: string;
  workspace: string;
  other_workspace: string;
  repository: string;
  provider: string;
  actors: Record<string, string>;
  active_lessons: number;
  candidate_items: number;
  golden_cases: number;
  holdout_cases: number;
  canary_runs: number;
  holdout_query_sha256: string;
}

export interface RsiDrillReport {
  drill: string;
  drill_version: number;
  generated_at: string;
  scope: RsiDrillScope;
  environment: {
    node: string;
    platform: string;
    database: string;
    outcome_source: string;
    replay_clock: string;
  };
  synthetic: RsiDrillSynthetic;
  baseline: {
    policy_version: number;
    policy_hash: string;
    memory_version: string;
    weekly_change_budget: number;
    weekly_reflection_token_budget: number;
  };
  acts: RsiDrillAct[];
  checks: RsiDrillCheck[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    ok: boolean;
  };
  reproducibility: {
    runs: number;
    identical: boolean;
    normalized_sha256: string;
  };
  not_verified: string[];
}

export interface RsiDrillOptions {
  /** Fresh in-memory executions to compare. Defaults to 2. */
  repeats?: number;
}

// ---------------------------------------------------------------------------
// Internal context
// ---------------------------------------------------------------------------

interface RecordedPin {
  arm: "candidate" | "baseline";
  pin: RsiRunPin;
}

interface DrillContext {
  db: ControlPlaneDb;
  scope: WorkspaceScope;
  otherScope: WorkspaceScope;
  memory: MemoryRepositories;
  retrievalStore: RetrievalStore;
  retrieval: MemoryRetrievalService;
  rsiStore: RsiStore;
  rsi: RsiService;
  taskStore: TaskStore;
  pins: RecordedPin[];
  runSeq: number;
  taskSeq: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True only when the action is refused with a message matching `pattern`. */
function refusedWith(action: () => unknown, pattern: RegExp): boolean {
  try {
    action();
    return false;
  } catch (error) {
    return pattern.test(errorMessage(error));
  }
}

function methodNames(service: object): string[] {
  const prototype = Object.getPrototypeOf(service) as object | null;
  if (prototype === null) {
    return [];
  }
  return Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor");
}

function createAct(name: string): RsiDrillAct {
  return { act: name, facts: {}, checks: [] };
}

function addCheck(
  act: RsiDrillAct,
  id: string,
  description: string,
  ok: boolean,
  evidence: string,
): void {
  act.checks.push({ id, description, ok, evidence });
}

/** Canonical JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Synthetic workspace
// ---------------------------------------------------------------------------

function createContext(): DrillContext {
  const db = openControlPlaneDb();
  const { admin_scope } = seedEnterprise(db, {
    enterprise_name: "RSI Drill Enterprise",
    enterprise_slug: "rsi-drill-enterprise",
    admin_user_id: ADMIN,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "RSI Drill Workspace",
    repository_id: "repo-rsi-drill",
    provider_instance_id: provider.id,
  });
  const other = seedWorkspace(db, admin_scope, {
    name: "RSI Drill Other Workspace",
    repository_id: "repo-rsi-drill-other",
    provider_instance_id: provider.id,
  });
  const scope: WorkspaceScope = {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: workspace.id,
    actor_id: OWNER,
  };
  const otherScope: WorkspaceScope = {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: other.id,
    actor_id: OTHER_OWNER,
  };
  const memory = createMemoryRepositories(db);
  const retrievalStore = createRetrievalStore(db);
  const retrieval = createMemoryRetrievalService({
    memory,
    store: retrievalStore,
    clock: () => DRILL_NOW,
  });
  const taskStore = new TaskStore();
  const rsiStore = createRsiStore(db);
  const rsi = createRsiService({
    store: rsiStore,
    memory,
    retrieval,
    retrievalStore,
    outcomes: createTaskRunOutcomes(taskStore),
    clock: () => DRILL_NOW,
  });
  return {
    db,
    scope,
    otherScope,
    memory,
    retrievalStore,
    retrieval,
    rsiStore,
    rsi,
    taskStore,
    pins: [],
    runSeq: 0,
    taskSeq: 0,
  };
}

function createLesson(
  ctx: DrillContext,
  scope: WorkspaceScope,
  statement: string,
  status: "active" | "candidate",
): MemoryItemRecord {
  const record = ctx.memory.items.create(scope, {
    kind: "lesson",
    scope: { path_prefix: "node/src/memory" },
    statement,
    preconditions: ["node workspace"],
    provenance: { author_type: "agent", agent_model: "synthetic-drill" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
  });
  ctx.memory.evidence.add(scope, record.item.id, {
    evidence_type: "test",
    reference: `drill:${sha256(statement).slice(0, 16)}`,
  });
  if (status === "candidate") {
    ctx.memory.items.setStatus(scope, record.item.id, "candidate", 1);
  } else {
    ctx.memory.items.reviewVersion(scope, record.item.id, 1, "usr_drill_reviewer");
    ctx.memory.items.setStatus(scope, record.item.id, "candidate", 1);
    ctx.memory.items.setStatus(scope, record.item.id, "active", 1);
  }
  const stored = ctx.memory.items.getById(scope, record.item.id);
  if (stored === undefined) {
    throw new Error("synthetic lesson disappeared after creation");
  }
  return stored;
}

function addCase(
  ctx: DrillContext,
  scope: WorkspaceScope,
  dataset: "golden" | "holdout",
  index: number,
  query: string,
  expectedItemId: string,
  forbiddenItemIds: string[],
): void {
  const input = {
    case_id: `${dataset}-${String(index).padStart(2, "0")}`,
    dataset,
    query,
    scope: { path_prefix: "node/src/memory" },
    role: "owner" as const,
    expected_item_ids: [expectedItemId],
    forbidden_item_ids: forbiddenItemIds,
  };
  if (dataset === "golden") {
    ctx.rsiStore.addGoldenCase(scope, input, scope.actor_id);
  } else {
    ctx.rsiStore.addHoldoutCase(scope, input, scope.actor_id);
  }
}

/**
 * Seed one hidden holdout and one curated golden set. The optional forbidden
 * case names a candidate whose injection must fail closed; it is used only by
 * the separate poisoned-workspace scenario.
 */
function seedDatasets(
  ctx: DrillContext,
  scope: WorkspaceScope,
  expectedItemId: string,
  forbidden?: { itemId: string; query: string },
): void {
  for (let index = 0; index < GOLDEN_CASES; index += 1) {
    const useForbidden = forbidden !== undefined && index === 0;
    addCase(
      ctx,
      scope,
      "golden",
      index,
      useForbidden ? forbidden.query : GOLDEN_QUERY,
      expectedItemId,
      useForbidden ? [forbidden.itemId] : [],
    );
  }
  for (let index = 0; index < HOLDOUT_CASES; index += 1) {
    const useForbidden = forbidden !== undefined && index === 0;
    addCase(
      ctx,
      scope,
      "holdout",
      index,
      useForbidden ? forbidden.query : HOLDOUT_QUERY,
      expectedItemId,
      useForbidden ? [forbidden.itemId] : [],
    );
  }
}

function policyWithRelevance(relevance: number): RetrievalPolicy {
  return {
    weights: { ...DEFAULT_RETRIEVAL_POLICY.weights, relevance },
    hybrid_weights: { ...DEFAULT_RETRIEVAL_POLICY.hybrid_weights },
    bounds: {
      ...DEFAULT_RETRIEVAL_POLICY.bounds,
      trust_class_weights: { ...DEFAULT_RETRIEVAL_POLICY.bounds.trust_class_weights },
      evidence_class_boost: { ...DEFAULT_RETRIEVAL_POLICY.bounds.evidence_class_boost },
    },
  };
}

function createPolicyProposal(
  ctx: DrillContext,
  scope: WorkspaceScope,
  title: string,
): RsiProposalView {
  return ctx.rsi.createProposal(scope, {
    title,
    summary: "Offline replay backed retrieval-weight proposal (synthetic drill)",
    diff: "- relevance: 0.45\n+ relevance: 0.50",
    target: "retrieval_weights",
    proposer: { id: PROPOSER, kind: "agent", model: "synthetic-drill-model" },
    candidate_policy: policyWithRelevance(0.5),
  });
}

function createItemProposal(
  ctx: DrillContext,
  scope: WorkspaceScope,
  title: string,
  item: MemoryItemRecord,
): RsiProposalView {
  return ctx.rsi.createProposal(scope, {
    title,
    summary: "Named-human promotion of a candidate lesson (synthetic drill)",
    diff: "- candidate lesson\n+ active lesson at the reviewed version",
    target: "lesson",
    proposer: { id: PROPOSER, kind: "agent", model: "synthetic-drill-model" },
    memory_item: { item_id: item.item.id, item_version: item.item.current_version },
  });
}

function recordTask(
  ctx: DrillContext,
  scope: WorkspaceScope,
  runId: string,
  state: "merged" | "rejected",
  actions: number,
  safetyEvents: number,
): void {
  ctx.taskSeq += 1;
  const task = createTaskRecord({
    id: `tsk_drill_${ctx.taskSeq}`,
    workspaceId: scope.workspace_id,
    enterpriseId: scope.enterprise_id,
    repository: DRILL_REPOSITORY,
    summary: `synthetic drill run ${runId}`,
    sourceReference: null,
    acceptanceCriteria: [],
  });
  task.runs = [
    {
      run_id: runId,
      state,
      created_at: DRILL_NOW_ISO,
      actions_completed: actions,
      safety_events: safetyEvents,
      updated_at: DRILL_NOW_ISO,
    },
  ];
  task.runId = runId;
  task.status = state === "merged" ? "merged" : "rejected";
  task.terminal = true;
  task.progress = { phase: "validating", actions_completed: actions, actions_total: null };
  ctx.taskStore.put(task);
}

/**
 * Pin one run into the requested canary arm and record its synthetic terminal
 * outcome in the real task projection. The bucket is deterministic per
 * (workspace, run id), so the helper searches fresh ids until the resolver
 * agrees with the requested arm.
 */
function pinRun(
  ctx: DrillContext,
  scope: WorkspaceScope,
  arm: "candidate" | "baseline",
  share: number,
  state: "merged" | "rejected",
): RsiRunPin {
  for (let guard = 0; guard < 100_000; guard += 1) {
    ctx.runSeq += 1;
    const runId = `run_drill_${ctx.runSeq}`;
    const selected = canaryBucket(scope.workspace_id, runId) < share * 100;
    if (selected !== (arm === "candidate")) {
      continue;
    }
    const pin = ctx.rsi.resolveRunVersions(scope, runId);
    if (pin.canary !== (arm === "candidate")) {
      continue;
    }
    recordTask(ctx, scope, runId, state, 4, 0);
    ctx.pins.push({ arm, pin });
    return pin;
  }
  throw new Error("could not find a deterministic run id for the requested canary arm");
}

function seedArmPairs(
  ctx: DrillContext,
  scope: WorkspaceScope,
  share: number,
  count: number,
  states: { candidate?: "merged" | "rejected"; baseline?: "merged" | "rejected" } = {},
): void {
  for (let index = 0; index < count; index += 1) {
    pinRun(ctx, scope, "candidate", share, states.candidate ?? "merged");
    pinRun(ctx, scope, "baseline", share, states.baseline ?? "merged");
  }
}

function evaluateProposal(
  ctx: DrillContext,
  scope: WorkspaceScope,
  proposal: RsiProposalView,
  actor: RsiActor = OWNER_ACTOR,
): RsiProposalView {
  return ctx.rsi.evaluate(scope, proposal.proposal_id, {}, actor);
}

function approveProposal(
  ctx: DrillContext,
  scope: WorkspaceScope,
  proposal: RsiProposalView,
  actor: RsiActor = OWNER_ACTOR,
): RsiProposalView {
  return ctx.rsi.approve(
    scope,
    proposal.proposal_id,
    actor,
    "drill: reviewed the offline replay and the named approval record",
  );
}

function observe(
  ctx: DrillContext,
  scope: WorkspaceScope,
  proposal: RsiProposalView,
): RsiProposalView {
  return ctx.rsi.recordCanaryObservation(scope, proposal.proposal_id, OWNER_ACTOR);
}

function gradeThroughCanary(
  ctx: DrillContext,
  scope: WorkspaceScope,
  proposal: RsiProposalView,
): RsiProposalView {
  ctx.rsi.startCanary(scope, proposal.proposal_id, OWNER_ACTOR);
  seedArmPairs(ctx, scope, 10, 20);
  let view = observe(ctx, scope, proposal);
  seedArmPairs(ctx, scope, 50, 30);
  view = observe(ctx, scope, proposal);
  view = observe(ctx, scope, proposal);
  return view;
}

// ---------------------------------------------------------------------------
// Drill execution
// ---------------------------------------------------------------------------

interface DrillRun {
  acts: RsiDrillAct[];
  baselinePolicyVersion: number;
  baselinePolicyHash: string;
  baselineMemoryVersion: string;
  synthetic: RsiDrillSynthetic;
  digest: string;
}

function executeDrill(): DrillRun {
  const ctx = createContext();
  const acts: RsiDrillAct[] = [];

  // ---- synthetic corpus ---------------------------------------------------
  const expected = createLesson(
    ctx,
    ctx.scope,
    "Run node memory tests build command before delivery",
    "active",
  );
  for (const statement of FILLER_LESSONS) {
    createLesson(ctx, ctx.scope, statement, "active");
  }
  const benignCandidate = createLesson(
    ctx,
    ctx.scope,
    "Prefer short review notes for borderless widgets",
    "candidate",
  );
  seedDatasets(ctx, ctx.scope, expected.item.id);

  const otherExpected = createLesson(
    ctx,
    ctx.otherScope,
    "Run node memory tests build command before delivery",
    "active",
  );
  const poisonCandidate = createLesson(
    ctx,
    ctx.otherScope,
    "Prefer bounded previews replay evaluation node memory tests build command",
    "candidate",
  );
  seedDatasets(ctx, ctx.otherScope, otherExpected.item.id, {
    itemId: poisonCandidate.item.id,
    query: FORBIDDEN_QUERY,
  });

  const baselinePolicy = ctx.retrievalStore.ensurePolicy(ctx.scope);
  const baselineMemoryVersion = computeMemoryVersion(
    ctx.retrievalStore.corpusEntries(ctx.scope),
    baselinePolicy.version,
  );
  const baselineHash = baselinePolicy.policy_hash;

  // ---- act: risk ladder ---------------------------------------------------
  const riskAct = createAct("risk_ladder");
  const proposalsBefore = ctx.rsi.listProposals(ctx.scope).length;
  const classDRefused = refusedWith(
    () =>
      ctx.rsi.createProposal(ctx.scope, {
        title: "Forbidden guardrail change",
        summary: "The learning loop may not touch class D",
        diff: "- nothing\n+ capability grant",
        target: "capability_grant",
        proposer: { id: PROPOSER, kind: "agent" },
        candidate_policy: policyWithRelevance(0.5),
      }),
    /risk class D/,
  );
  addCheck(
    riskAct,
    "class_d_target_refused",
    "Class D targets are refused before any row is written",
    classDRefused && ctx.rsi.listProposals(ctx.scope).length === proposalsBefore,
    "capability_grant refused with a class-D error; proposal count unchanged",
  );
  const p1 = createPolicyProposal(ctx, ctx.scope, "Tighten retrieval relevance after replay");
  addCheck(
    riskAct,
    "risk_is_server_derived",
    "Risk comes from the target, never from the caller",
    p1.risk === "A" && p1.target === "retrieval_weights" && p1.status === "proposed",
    "retrieval_weights proposal opens as risk A in proposed state",
  );
  riskAct.facts["class_d_refused"] = classDRefused;
  riskAct.facts["class_a_risk"] = p1.risk;
  acts.push(riskAct);

  // ---- act: holdout isolation --------------------------------------------
  const holdoutAct = createAct("holdout_isolation");
  const forgedCapability = refusedWith(
    () => ctx.rsiStore.listHoldoutCases(ctx.scope, {}),
    /RSI evaluator/,
  );
  const copiedCapability = refusedWith(
    () => ctx.rsiStore.listHoldoutCases(ctx.scope, Object.freeze({ holdout: true })),
    /RSI evaluator/,
  );
  addCheck(
    holdoutAct,
    "holdout_read_requires_evaluator_capability",
    "Holdout content is readable only through the replay capability",
    forgedCapability && copiedCapability,
    "two forged capability objects are refused; only offline replay holds the reader",
  );

  const serviceMethods = methodNames(ctx.rsi);
  const caseMethods = serviceMethods.filter((name) => /case|holdout|golden|dataset/i.test(name));
  addCheck(
    holdoutAct,
    "rsi_service_has_no_case_mutation",
    "The governance service exposes no case read or write",
    caseMethods.length === 0,
    `service exposes ${serviceMethods.length} methods and none reads, adds, or edits evaluation cases`,
  );
  addCheck(
    holdoutAct,
    "rsi_package_does_not_export_holdout_reader",
    "The public RSI package never exports the holdout capability",
    !("holdoutRead" in rsiSurface),
    "holdoutRead is absent from the package's exported symbols",
  );

  const rsiPaths = rsiOpenApiPaths();
  const pathNames = Object.keys(rsiPaths);
  const casePaths = pathNames.filter((path) => /case|holdout|golden/i.test(path));
  const observationEntry = rsiPaths[
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/canary/observations"
  ] as Record<string, { requestBody?: unknown }> | undefined;
  const observationBody = observationEntry?.["post"]?.requestBody;
  addCheck(
    holdoutAct,
    "no_http_holdout_read_or_provisioning",
    "No HTTP operation reads or provisions cases, or accepts a canary sample",
    pathNames.length === 10 && casePaths.length === 0 && observationBody === undefined,
    "10 documented RSI paths; no case path; the observation endpoint takes no request body",
  );

  const learningPayloads = JSON.stringify({
    proposal: p1,
    evaluations: p1.evaluations,
    status: ctx.rsi.status(ctx.scope),
    list: ctx.rsi.listProposals(ctx.scope),
  });
  const status = ctx.rsi.status(ctx.scope);
  addCheck(
    holdoutAct,
    "holdout_content_absent_from_learning_payloads",
    "Holdout content never appears in proposal, evaluation, list, or status payloads",
    !learningPayloads.includes(HOLDOUT_SECRET) && status.holdout.cases === HOLDOUT_CASES,
    `status exposes ${status.holdout.cases} holdout cases as an aggregate count and no case text`,
  );
  const crossWorkspaceRead = refusedWith(
    () => ctx.rsi.getProposal(ctx.otherScope, p1.proposal_id),
    /not found in scope/,
  );
  addCheck(
    holdoutAct,
    "cross_workspace_proposal_invisible",
    "Another workspace cannot read this workspace's proposal",
    crossWorkspaceRead,
    "proposal lookup from a second workspace is an indistinguishable not-found",
  );
  holdoutAct.facts["holdout_cases"] = status.holdout.cases;
  holdoutAct.facts["http_rsi_paths"] = pathNames.length;
  holdoutAct.facts["http_case_paths"] = casePaths.length;
  holdoutAct.facts["holdout_text_in_payloads"] = learningPayloads.includes(HOLDOUT_SECRET);
  acts.push(holdoutAct);

  // ---- act: independent evaluation ---------------------------------------
  const evalAct = createAct("independent_evaluation");
  const goldenOnly = ctx.rsi.evaluate(
    ctx.scope,
    p1.proposal_id,
    { datasets: ["golden"] },
    OWNER_ACTOR,
  );
  addCheck(
    evalAct,
    "holdout_required_before_canary",
    "A golden-only replay is incomplete and cannot open a canary",
    goldenOnly.gate.offline_evaluation === "missing" &&
      goldenOnly.gate.holdout_required &&
      !goldenOnly.gate.canary_eligible,
    "golden-only replay leaves offline_evaluation=missing and canary_eligible=false",
  );
  const evaluationsBeforeRefusals = ctx.rsiStore.listEvaluations(ctx.scope, p1.proposal_id).length;
  const selfEvaluation = refusedWith(
    () =>
      ctx.rsi.evaluate(
        ctx.scope,
        p1.proposal_id,
        {},
        {
          id: PROPOSER,
          role: "owner",
        },
      ),
    /independent verifier/,
  );
  const memberEvaluation = refusedWith(
    () => ctx.rsi.evaluate(ctx.scope, p1.proposal_id, {}, MEMBER_ACTOR),
    /owner role/,
  );
  addCheck(
    evalAct,
    "proposer_cannot_self_evaluate",
    "The proposer can never verify its own proposal",
    selfEvaluation &&
      ctx.rsiStore.listEvaluations(ctx.scope, p1.proposal_id).length === evaluationsBeforeRefusals,
    "an owner-role proposer is refused and no evaluation row is written",
  );
  addCheck(
    evalAct,
    "member_cannot_evaluate",
    "Only an owner may run the replay",
    memberEvaluation,
    "a member-role actor is refused before any replay starts",
  );

  const p1Evaluated = evaluateProposal(ctx, ctx.scope, p1);
  const datasetVerdicts = new Map(
    p1Evaluated.evaluations.map((entry) => [entry.dataset, entry.verdict]),
  );
  const verifiers = p1Evaluated.evaluations.map((entry) => entry.verifier);
  const verifierOk =
    verifiers.length > 0 &&
    verifiers.every(
      (verifier) =>
        verifier.kind === "test" &&
        verifier.id === OWNER &&
        verifier.reference.startsWith(`replay:${p1.proposal_id}:v${p1.version}:`),
    );
  addCheck(
    evalAct,
    "independent_replay_passes_both_datasets",
    "An independent replay over both datasets passes",
    p1Evaluated.gate.offline_evaluation === "pass" &&
      datasetVerdicts.get("golden") === "pass" &&
      datasetVerdicts.get("holdout") === "pass" &&
      !p1Evaluated.gate.canary_eligible,
    "golden and holdout both pass; the gate still waits for named human approval",
  );
  addCheck(
    evalAct,
    "verifier_is_server_derived",
    "The recorded verifier is the authenticated evaluator with a server-derived reference",
    verifierOk,
    "every verifier is kind=test, named by the evaluating owner, and referenced by replay:<proposal>:v<version>:<dataset>",
  );
  evalAct.facts["golden_verdict"] = datasetVerdicts.get("golden") ?? "missing";
  evalAct.facts["holdout_verdict"] = datasetVerdicts.get("holdout") ?? "missing";
  evalAct.facts["self_evaluation_refused"] = selfEvaluation;
  evalAct.facts["member_evaluation_refused"] = memberEvaluation;
  acts.push(evalAct);

  // ---- act: named human approval -----------------------------------------
  const approvalAct = createAct("named_human_approval");
  const unapprovedCanary = refusedWith(
    () => ctx.rsi.startCanary(ctx.scope, p1.proposal_id, OWNER_ACTOR),
    /human approval/,
  );
  addCheck(
    approvalAct,
    "human_approval_required_for_class_a",
    "A class A change still needs a named human when automatic promotion is off",
    unapprovedCanary && p1Evaluated.gate.approvals_required === 1,
    "canary start is refused until one named human approves",
  );
  const proposerApproval = refusedWith(
    () => ctx.rsi.approve(ctx.scope, p1.proposal_id, { id: PROPOSER, role: "owner" }),
    /proposer cannot approve/,
  );
  const memberApproval = refusedWith(
    () => ctx.rsi.approve(ctx.scope, p1.proposal_id, MEMBER_ACTOR),
    /owner or admin/,
  );
  addCheck(
    approvalAct,
    "proposer_cannot_approve",
    "A proposer cannot approve its own change even with the owner role",
    proposerApproval,
    "proposer approval is refused as self-approval",
  );
  addCheck(
    approvalAct,
    "member_cannot_approve",
    "A member cannot record an approval",
    memberApproval,
    "member approval is refused before any row is written",
  );
  const p1Approved = approveProposal(ctx, ctx.scope, p1);
  const p1Approval = p1Approved.approvals[0];
  const approvalRecorded =
    p1Approved.gate.approvals_satisfied === 1 &&
    p1Approved.gate.approvals_required === 1 &&
    p1Approval?.approver_id === OWNER &&
    p1Approval.approval_key === "single" &&
    p1Approval.note !== null &&
    p1Approved.gate.canary_eligible;
  addCheck(
    approvalAct,
    "named_approval_recorded",
    "The named human approval is recorded and unlocks the canary",
    approvalRecorded,
    "approval key=single, approver is the synthetic owner, note recorded, gate eligible",
  );
  approvalAct.facts["approvals_required"] = p1Approved.gate.approvals_required;
  approvalAct.facts["approvals_satisfied"] = p1Approved.gate.approvals_satisfied;
  acts.push(approvalAct);

  // ---- act: canary promotion ---------------------------------------------
  const canaryAct = createAct("canary_promotion");
  const p1Promoted = gradeThroughCanary(ctx, ctx.scope, p1);
  const observationStages = p1Promoted.observations
    .map((entry) => entry.stage)
    .sort((left, right) => left - right);
  const observationVerdicts = p1Promoted.observations.map((entry) => entry.verdict);
  const publishedPolicies = ctx.retrievalStore.listPolicies(ctx.scope, 10);
  const firstCandidatePin = ctx.pins.find((entry) => entry.arm === "candidate");
  const taskBackedOutcome =
    firstCandidatePin !== undefined &&
    ctx.taskStore.getByRunId(firstCandidatePin.pin.run_id)?.runs[0]?.state === "merged";
  addCheck(
    canaryAct,
    "canary_stages_advance_on_pinned_runs",
    "The canary advances 10% → 50% → 100% only on enough terminal pinned runs",
    observationVerdicts.length === 3 &&
      observationVerdicts.every((verdict) => verdict === "pass") &&
      observationStages.join(",") === "10,50,100" &&
      p1Promoted.status === "promoted",
    "three passing stage observations at 10/50/100 promote the proposal",
  );
  addCheck(
    canaryAct,
    "promotion_publishes_exactly_one_policy_version",
    "A promoted policy target publishes exactly one immutable policy version",
    publishedPolicies.length === 2 &&
      p1Promoted.applied_policy_version === baselinePolicy.version + 1 &&
      ctx.retrievalStore.getPolicy(ctx.scope)?.version === baselinePolicy.version + 1,
    "the stored policy moves from version 1 to version 2 exactly once",
  );
  addCheck(
    canaryAct,
    "canary_samples_come_from_task_projection",
    "Canary samples come from pinned runs and their own run-level task evidence",
    taskBackedOutcome &&
      ctx.rsi.recordCanaryObservation.length === 3 &&
      p1Promoted.observations.every((entry) => entry.evidence_reference.startsWith("pins:")),
    "observation API takes no sample; each observation names its pin set and reads run-level task evidence",
  );
  canaryAct.facts["stages"] = [10, 50, 100];
  canaryAct.facts["stage_verdicts"] = observationVerdicts;
  canaryAct.facts["promoted_status"] = p1Promoted.status;
  canaryAct.facts["applied_policy_version"] = p1Promoted.applied_policy_version ?? 0;
  canaryAct.facts["policy_versions"] = publishedPolicies.length;
  acts.push(canaryAct);

  // ---- act: manual rollback after promotion ------------------------------
  const rollbackAct = createAct("post_promotion_rollback");
  const policyVersionBeforeRollback =
    ctx.retrievalStore.getPolicy(ctx.scope)?.version ?? baselinePolicy.version;
  const pinSnapshot = ctx.pins.map((entry) => ({ ...entry.pin }));
  const p1RolledBack = ctx.rsi.rollback(
    ctx.scope,
    p1.proposal_id,
    "drill: post-promotion reviewer rollback",
    OWNER_ACTOR,
  );
  const afterRollback = ctx.retrievalStore.getPolicy(ctx.scope);
  const pinsPreserved = pinSnapshot.every((snapshot) => {
    const stored = ctx.rsi.getRunPin(ctx.scope, snapshot.run_id);
    return (
      stored !== undefined &&
      stored.policy_version === snapshot.policy_version &&
      stored.policy_hash === snapshot.policy_hash &&
      stored.memory_version === snapshot.memory_version &&
      stored.canary === snapshot.canary &&
      stored.created_at === snapshot.created_at
    );
  });
  addCheck(
    rollbackAct,
    "promoted_change_reverts_to_baseline_content",
    "Rolling back a promoted policy publishes the baseline content as a new version",
    p1RolledBack.status === "rolled_back" &&
      afterRollback !== undefined &&
      afterRollback.version === policyVersionBeforeRollback + 1 &&
      afterRollback.policy_hash === baselineHash,
    "status rolled_back; a new policy version carries the original baseline hash",
  );
  addCheck(
    rollbackAct,
    "historical_pins_preserved",
    "Rollback never rewrites the version a historical run used",
    pinsPreserved && pinSnapshot.length > 0,
    `${pinSnapshot.length} pins keep their policy version, policy hash, memory version, and created-at`,
  );
  rollbackAct.facts["rollback_status"] = p1RolledBack.status;
  rollbackAct.facts["rollback_restored_baseline_hash"] =
    afterRollback?.policy_hash === baselineHash;
  rollbackAct.facts["pins_preserved"] = pinsPreserved;
  acts.push(rollbackAct);

  // ---- act: class B named-human activation -------------------------------
  const classBAct = createAct("class_b_named_human_activation");
  const p2 = createItemProposal(
    ctx,
    ctx.scope,
    "Activate a reviewed candidate lesson",
    benignCandidate,
  );
  const p2Evaluated = evaluateProposal(ctx, ctx.scope, p2);
  const p2AdminApproved = approveProposal(ctx, ctx.scope, p2, ADMIN_ACTOR);
  const p2Promoted = gradeThroughCanary(ctx, ctx.scope, p2);
  const activated = ctx.memory.items.getById(ctx.scope, benignCandidate.item.id);
  addCheck(
    classBAct,
    "class_b_named_human_activation",
    "A procedural item activates only its exact reviewed version after a named human approval",
    p2.risk === "B" &&
      p2Evaluated.gate.offline_evaluation === "pass" &&
      p2AdminApproved.gate.canary_eligible &&
      p2Promoted.status === "promoted" &&
      activated?.item.status === "active" &&
      activated.current.version === benignCandidate.item.current_version &&
      activated.current.review?.approver_id === ADMIN,
    "risk B, offline pass, admin approval, canary promotion, item active at version 1 with the admin review stamp",
  );
  classBAct.facts["class_b_risk"] = p2.risk;
  classBAct.facts["class_b_status"] = p2Promoted.status;
  classBAct.facts["activated_item_status"] = activated?.item.status ?? "missing";
  classBAct.facts["activated_item_version"] = activated?.current.version ?? 0;
  classBAct.facts["review_stamp_matches_approver"] =
    activated?.current.review?.approver_id === ADMIN;
  acts.push(classBAct);

  // ---- act: regression and inconclusive samples --------------------------
  const regressionAct = createAct("regression_gate");
  const p3 = createPolicyProposal(ctx, ctx.scope, "Candidate regression drill");
  evaluateProposal(ctx, ctx.scope, p3);
  approveProposal(ctx, ctx.scope, p3);
  ctx.rsi.startCanary(ctx.scope, p3.proposal_id, OWNER_ACTOR);
  seedArmPairs(ctx, ctx.scope, 10, 3, { candidate: "rejected", baseline: "merged" });
  const shortSample = observe(ctx, ctx.scope, p3);
  const shortObservation = shortSample.observations[0];
  seedArmPairs(ctx, ctx.scope, 10, 20, { candidate: "rejected", baseline: "merged" });
  const regressed = observe(ctx, ctx.scope, p3);
  const policyAfterRegression = ctx.retrievalStore.getPolicy(ctx.scope);
  addCheck(
    regressionAct,
    "below_minimum_sample_stays_inconclusive",
    "A below-minimum sample is a refusal, not a pass",
    shortObservation?.verdict === "inconclusive" &&
      shortSample.rollout?.stage === 10 &&
      shortSample.status === "canary",
    "a three-run sample is inconclusive and leaves the canary at the 10% stage",
  );
  addCheck(
    regressionAct,
    "regression_rolls_back_automatically",
    "A recorded success regression rolls the canary back before promotion",
    regressed.status === "rolled_back" &&
      /automatic rollback/.test(regressed.rollout?.reason ?? "") &&
      policyAfterRegression?.version === policyVersionBeforeRollback + 1 &&
      policyAfterRegression.policy_hash === baselineHash,
    "zero of 23 candidate runs succeeded against 23 of 23 baseline runs; rollback keeps the stored policy",
  );
  regressionAct.facts["inconclusive_verdict"] = shortObservation?.verdict ?? "missing";
  regressionAct.facts["regression_status"] = regressed.status;
  regressionAct.facts["regression_rolled_back"] = regressed.status === "rolled_back";
  acts.push(regressionAct);

  // ---- act: forbidden injection in an isolated workspace -----------------
  const forbiddenAct = createAct("forbidden_injection");
  const p4 = createItemProposal(
    ctx,
    ctx.otherScope,
    "Poisoned candidate replay drill",
    poisonCandidate,
  );
  const p4Evaluated = evaluateProposal(ctx, ctx.otherScope, p4, OTHER_OWNER_ACTOR);
  const p4Verdicts = p4Evaluated.evaluations.map((entry) => entry.verdict);
  const p4Safety = p4Evaluated.evaluations.reduce((sum, entry) => sum + entry.safety_events, 0);
  addCheck(
    forbiddenAct,
    "forbidden_injection_fails_closed",
    "Injecting a forbidden item is a safety event and blocks the gate",
    p4Verdicts.length === 2 &&
      p4Verdicts.every((verdict) => verdict === "fail") &&
      p4Safety > 0 &&
      p4Evaluated.status === "blocked" &&
      refusedWith(
        () => ctx.rsi.startCanary(ctx.otherScope, p4.proposal_id, OTHER_OWNER_ACTOR),
        /not eligible/,
      ),
    "both datasets fail on forbidden injection; safety events are recorded; the proposal is blocked",
  );
  forbiddenAct.facts["forbidden_verdicts"] = p4Verdicts;
  forbiddenAct.facts["forbidden_status"] = p4Evaluated.status;
  forbiddenAct.facts["forbidden_safety_events"] = p4Safety;
  acts.push(forbiddenAct);

  // ---- act: baseline version drift ---------------------------------------
  const driftAct = createAct("version_drift");
  const p5 = createPolicyProposal(ctx, ctx.scope, "Drift before canary drill");
  evaluateProposal(ctx, ctx.scope, p5);
  approveProposal(ctx, ctx.scope, p5);
  const externalVersion = ctx.retrievalStore.createPolicyVersion(
    ctx.scope,
    policyWithRelevance(0.47),
  );
  const driftBefore = refusedWith(
    () => ctx.rsi.startCanary(ctx.scope, p5.proposal_id, OWNER_ACTOR),
    /baseline policy moved/,
  );
  addCheck(
    driftAct,
    "baseline_drift_before_canary_refused",
    "A canary cannot start against a baseline that moved after evaluation",
    driftBefore && externalVersion.version > p5.baseline_policy_version,
    "start is refused and asks for re-evaluation against the current baseline",
  );

  const p6 = createPolicyProposal(ctx, ctx.scope, "Drift during canary drill");
  evaluateProposal(ctx, ctx.scope, p6);
  approveProposal(ctx, ctx.scope, p6);
  ctx.rsi.startCanary(ctx.scope, p6.proposal_id, OWNER_ACTOR);
  seedArmPairs(ctx, ctx.scope, 10, 50);
  observe(ctx, ctx.scope, p6);
  observe(ctx, ctx.scope, p6);
  const externalMid = ctx.retrievalStore.createPolicyVersion(ctx.scope, policyWithRelevance(0.48));
  const drifted = observe(ctx, ctx.scope, p6);
  const policyAfterDrift = ctx.retrievalStore.getPolicy(ctx.scope);
  addCheck(
    driftAct,
    "baseline_drift_during_canary_rolls_back",
    "A baseline that moves during a canary rolls the canary back instead of promoting a stale comparison",
    drifted.status === "rolled_back" &&
      /baseline policy changed during the canary/.test(drifted.rollout?.reason ?? "") &&
      policyAfterDrift?.version === externalMid.version &&
      policyAfterDrift.policy_hash === externalMid.policy_hash,
    "the final observation finds the stale comparison and rolls back; the external policy stays live",
  );
  driftAct.facts["drift_before_refused"] = driftBefore;
  driftAct.facts["drift_during_status"] = drifted.status;
  driftAct.facts["external_baseline_version"] = externalMid.version;
  acts.push(driftAct);

  // ---- act: budget exhaustion --------------------------------------------
  const budgetAct = createAct("budget_exhaustion");
  const budgetBefore = ctx.rsi.status(ctx.scope).budget;
  ctx.rsi.updateControls(
    ctx.scope,
    { weekly_change_budget: budgetBefore.changes_promoted },
    OWNER_ACTOR,
  );
  const p7 = createPolicyProposal(ctx, ctx.scope, "Change-budget blocked proposal");
  evaluateProposal(ctx, ctx.scope, p7);
  const p7Approved = approveProposal(ctx, ctx.scope, p7);
  const changeBudgetBlocked =
    !p7Approved.gate.budget_ok &&
    !p7Approved.gate.canary_eligible &&
    refusedWith(() => ctx.rsi.startCanary(ctx.scope, p7.proposal_id, OWNER_ACTOR), /change budget/);
  addCheck(
    budgetAct,
    "change_budget_blocks_canary",
    "An exhausted weekly change budget blocks a canary even with a passing replay and approval",
    changeBudgetBlocked,
    "gate reports budget_ok=false and canary start is refused with the change-budget conflict",
  );
  ctx.rsi.updateControls(ctx.scope, { weekly_change_budget: 3 }, OWNER_ACTOR);

  ctx.rsi.updateControls(ctx.scope, { weekly_reflection_token_budget: 0 }, OWNER_ACTOR);
  const p8 = createPolicyProposal(ctx, ctx.scope, "Reflection-budget blocked proposal");
  const reflectionRefused = refusedWith(
    () => evaluateProposal(ctx, ctx.scope, p8),
    /reflection token budget/,
  );
  const reflectionRows = ctx.rsiStore.listEvaluations(ctx.scope, p8.proposal_id).length;
  addCheck(
    budgetAct,
    "reflection_budget_refuses_before_rows",
    "An exhausted reflection-token budget refuses before any evaluation row exists",
    reflectionRefused && reflectionRows === 0,
    "evaluation is refused and the proposal has zero evaluation rows",
  );
  ctx.rsi.updateControls(ctx.scope, { weekly_reflection_token_budget: 200_000 }, OWNER_ACTOR);
  budgetAct.facts["changes_promoted_at_budget_test"] = budgetBefore.changes_promoted;
  budgetAct.facts["change_budget_blocked"] = changeBudgetBlocked;
  budgetAct.facts["reflection_rows_written"] = reflectionRows;
  acts.push(budgetAct);

  // ---- act: kill switch ---------------------------------------------------
  const killAct = createAct("kill_switch");
  const p9 = createPolicyProposal(ctx, ctx.scope, "Kill-switch drill");
  evaluateProposal(ctx, ctx.scope, p9);
  approveProposal(ctx, ctx.scope, p9);
  ctx.rsi.startCanary(ctx.scope, p9.proposal_id, OWNER_ACTOR);
  seedArmPairs(ctx, ctx.scope, 10, 5);
  const livePolicy = ctx.retrievalStore.getPolicy(ctx.scope);
  const killSnapshot = ctx.pins.map((entry) => ({ ...entry.pin }));
  const controls = ctx.rsi.setKillSwitch(
    ctx.scope,
    true,
    "drill: synthetic security incident",
    OWNER_ACTOR,
  );
  const p9AfterKill = ctx.rsi.getProposal(ctx.scope, p9.proposal_id);
  const policyUnderKill = ctx.retrievalStore.getPolicy(ctx.scope);
  const pinsIntact = killSnapshot.every((snapshot) => {
    const stored = ctx.rsi.getRunPin(ctx.scope, snapshot.run_id);
    return (
      stored !== undefined &&
      stored.policy_version === snapshot.policy_version &&
      stored.policy_hash === snapshot.policy_hash &&
      stored.memory_version === snapshot.memory_version &&
      stored.created_at === snapshot.created_at
    );
  });
  addCheck(
    killAct,
    "kill_switch_rolls_back_same_call",
    "Engaging the kill switch rolls back an active canary in the same call",
    controls.kill_switch &&
      ctx.rsiStore.listActiveRollouts(ctx.scope).length === 0 &&
      p9AfterKill.status === "rolled_back",
    "kill switch is on; no active rollout remains; the proposal is rolled back",
  );
  addCheck(
    killAct,
    "kill_switch_restores_baseline_policy",
    "The unpublished candidate never becomes live when the kill switch fires",
    livePolicy !== undefined &&
      policyUnderKill !== undefined &&
      policyUnderKill.version === livePolicy.version &&
      policyUnderKill.policy_hash === livePolicy.policy_hash,
    "the stored policy keeps its version and hash; only the canary overlay is discarded",
  );
  addCheck(
    killAct,
    "kill_switch_preserves_existing_pins",
    "Runs pinned before the kill switch keep the exact versions they used",
    pinsIntact && killSnapshot.length > 0,
    `${killSnapshot.length} pins keep their policy identity, memory version, and created-at`,
  );

  const afterKillRun = ctx.rsi.resolveRunVersions(ctx.scope, "run_drill_after_kill");
  addCheck(
    killAct,
    "kill_switch_makes_new_runs_baseline",
    "New runs resolve to the baseline policy while the kill switch is on",
    !afterKillRun.canary &&
      afterKillRun.policy === null &&
      afterKillRun.policy_version === livePolicy?.version,
    "a new pin is a non-canary pin at the live baseline version with no candidate overlay",
  );

  const killRefusals = [
    refusedWith(
      () => createPolicyProposal(ctx, ctx.scope, "Refused under kill switch"),
      /kill switch/,
    ),
    refusedWith(() => ctx.rsi.evaluate(ctx.scope, p9.proposal_id, {}, OWNER_ACTOR), /kill switch/),
    refusedWith(() => ctx.rsi.approve(ctx.scope, p9.proposal_id, OWNER_ACTOR), /kill switch/),
    refusedWith(() => ctx.rsi.startCanary(ctx.scope, p9.proposal_id, OWNER_ACTOR), /kill switch/),
  ];
  addCheck(
    killAct,
    "kill_switch_refuses_rsi_actions",
    "Proposals, evaluations, approvals, and canaries are refused while the kill switch is on",
    killRefusals.every(Boolean),
    "all four state-changing actions are refused with the kill-switch conflict",
  );

  const released = ctx.rsi.setKillSwitch(ctx.scope, false, null, OWNER_ACTOR);
  const p10 = createPolicyProposal(ctx, ctx.scope, "Post-kill-switch recovery");
  const p10Evaluated = evaluateProposal(ctx, ctx.scope, p10);
  const p10Approved = approveProposal(ctx, ctx.scope, p10);
  const afterReleaseRun = ctx.rsi.resolveRunVersions(ctx.scope, "run_drill_after_release");
  addCheck(
    killAct,
    "kill_switch_release_restores_actions",
    "Releasing the kill switch restores normal RSI operation",
    !released.kill_switch &&
      p10Evaluated.gate.offline_evaluation === "pass" &&
      p10Approved.gate.canary_eligible &&
      !afterReleaseRun.canary,
    "a new proposal can be evaluated and approved; a new run is not force-pinned to a canary",
  );
  killAct.facts["rollback_status_after_kill"] = p9AfterKill.status;
  killAct.facts["active_rollouts_after_kill"] = 0;
  killAct.facts["pins_preserved_after_kill"] = pinsIntact;
  killAct.facts["actions_refused_under_kill"] = killRefusals.filter(Boolean).length;
  killAct.facts["kill_switch_released"] = !released.kill_switch;
  acts.push(killAct);

  // ---- act: run-pin traceability -----------------------------------------
  const pinAct = createAct("run_pin_traceability");
  const allPins = ctx.pins;
  const stablePins = allPins.every(({ pin }) => {
    const stored = ctx.rsi.getRunPin(ctx.scope, pin.run_id);
    return (
      stored !== undefined &&
      stored.policy_version === pin.policy_version &&
      stored.policy_hash === pin.policy_hash &&
      stored.memory_version === pin.memory_version &&
      stored.canary === pin.canary &&
      stored.created_at === pin.created_at
    );
  });
  const completePins = allPins.every(
    ({ arm, pin }) =>
      Number.isInteger(pin.policy_version) &&
      pin.policy_version >= 1 &&
      /^[0-9a-f]{64}$/.test(pin.policy_hash) &&
      /^m1\.[0-9a-f]{32}$/.test(pin.memory_version) &&
      pin.created_at.length > 0 &&
      (arm === "candidate"
        ? pin.canary && pin.proposal_id !== null && pin.rollout_id !== null && pin.stage !== null
        : !pin.canary && pin.policy_version >= 1),
  );
  const corpusVersions = new Set(allPins.map(({ pin }) => pin.memory_version));
  addCheck(
    pinAct,
    "every_run_pin_is_traceable_and_stable",
    "Every run records one fixed memory version and policy identity, stable across retries",
    completePins && stablePins && allPins.length > 0,
    `${allPins.length} pins carry an integer policy version, a 64-hex policy hash, an m1 memory version, and a stable created-at`,
  );
  addCheck(
    pinAct,
    "memory_version_tracks_corpus_activation",
    "A run pin's memory version follows the corpus it was taken from",
    corpusVersions.size >= 2,
    "the corpus before and after the class B activation yields different memory versions",
  );
  const finalCounts = ctx.rsi.status(ctx.scope).proposals;
  const expectedCounts = {
    proposed: 1,
    awaiting_approval: 0,
    ready: 2,
    canary: 0,
    promoted: 1,
    rolled_back: 4,
    blocked: 1,
  };
  const countsMatch = (Object.keys(expectedCounts) as Array<keyof typeof expectedCounts>).every(
    (key) => finalCounts[key] === expectedCounts[key],
  );
  addCheck(
    pinAct,
    "final_proposal_statuses_are_governed",
    "The final proposal set reflects the gates that fired",
    countsMatch,
    "1 proposed, 2 ready, 1 blocked, 1 promoted, 4 rolled back",
  );
  pinAct.facts["pins"] = allPins.length;
  pinAct.facts["distinct_memory_versions"] = corpusVersions.size;
  for (const key of Object.keys(expectedCounts) as Array<keyof typeof expectedCounts>) {
    pinAct.facts[`proposals_${key}`] = finalCounts[key] ?? 0;
  }
  acts.push(pinAct);

  // ---- act: no holdout content in this report ----------------------------
  const reportAct = createAct("report_self_check");
  const synthetic: RsiDrillSynthetic = {
    enterprise: "RSI Drill Enterprise",
    workspace: "RSI Drill Workspace",
    other_workspace: "RSI Drill Other Workspace",
    repository: DRILL_REPOSITORY.id,
    provider: "github (synthetic origin; never contacted)",
    actors: {
      owner: OWNER,
      admin: ADMIN,
      member: MEMBER,
      proposer_agent: PROPOSER,
      other_workspace_owner: OTHER_OWNER,
    },
    active_lessons: FILLER_LESSONS.length + 1,
    candidate_items: 1,
    golden_cases: GOLDEN_CASES,
    holdout_cases: HOLDOUT_CASES,
    canary_runs: ctx.taskSeq,
    holdout_query_sha256: sha256(HOLDOUT_QUERY),
  };
  const serializedTranscript = JSON.stringify({ acts, synthetic });
  addCheck(
    reportAct,
    "holdout_content_absent_from_drill_report",
    "The drill's own transcript never contains holdout text",
    !serializedTranscript.includes(HOLDOUT_SECRET),
    "the holdout query appears only as a SHA-256 digest in the report",
  );
  reportAct.facts["holdout_text_in_transcript"] = serializedTranscript.includes(HOLDOUT_SECRET);
  reportAct.facts["checks_recorded"] = acts.reduce((sum, act) => sum + act.checks.length, 0);
  acts.push(reportAct);

  const digest = sha256(canonicalJson(acts));
  return {
    acts,
    baselinePolicyVersion: baselinePolicy.version,
    baselinePolicyHash: baselineHash,
    baselineMemoryVersion,
    synthetic,
    digest,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const NOT_VERIFIED = [
  "Real model behavior: the drill calls no model and uses no gateway; proposals and outcomes are synthetic.",
  "Memory distillation from real runs: covered by DAT-270 and the distillation suites, not by this drill.",
  "HTTP session authentication and role enforcement for the RSI routes: covered by the memory-rsi-api suite; this drill exercises the service and the documented OpenAPI shape.",
  "Real dsh execution and task projection writes from an orchestrator run: the drill inserts synthetic task records directly into the in-memory task projection, which is the same adapter but not a live run.",
  "Holdout curation, rotation, and case provenance: the drill seeds a fixed synthetic golden/holdout set; operator case management is out of band.",
  "Production deployment, tenancy, PostgreSQL row-level isolation, and provider credentials: the drill uses an in-memory SQLite control plane and synthetic identities only.",
];

export function runRsiDrill(options: RsiDrillOptions = {}): RsiDrillReport {
  const runs = Math.max(1, Math.floor(options.repeats ?? 2));
  const executed: DrillRun[] = [];
  for (let index = 0; index < runs; index += 1) {
    executed.push(executeDrill());
  }
  const first = executed[0];
  if (first === undefined) {
    throw new Error("rsi drill did not execute");
  }
  const digests = new Set(executed.map((run) => run.digest));
  const reproducible = digests.size === 1;
  const acts = first.acts.map((act) => ({
    ...act,
    checks: [...act.checks],
    facts: { ...act.facts },
  }));
  if (runs > 1) {
    const reproducibilityAct = createAct("reproducibility");
    addCheck(
      reproducibilityAct,
      "reproducible_across_fresh_in_memory_runs",
      "Fresh drill executions produce the same normalized governance transcript",
      reproducible,
      `${runs} fresh in-memory runs produced ${digests.size} distinct normalized transcript digest(s)`,
    );
    reproducibilityAct.facts["runs"] = runs;
    reproducibilityAct.facts["distinct_digests"] = digests.size;
    acts.push(reproducibilityAct);
  }
  const checks = acts.flatMap((act) => act.checks);
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  return {
    drill: DRILL_NAME,
    drill_version: DRILL_VERSION,
    generated_at: new Date().toISOString(),
    scope: {
      kind: "synthetic_offline_drill",
      synthetic_data: true,
      production_enabled: false,
      real_model_calls: 0,
      real_provider_calls: 0,
      real_permissions_used: false,
      network_access: false,
      dsh_execution: false,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      database: "sqlite :memory: (control-plane migrations applied)",
      outcome_source: "real task-projection adapter over synthetic task records",
      replay_clock: DRILL_NOW_ISO,
    },
    synthetic: first.synthetic,
    baseline: {
      policy_version: first.baselinePolicyVersion,
      policy_hash: first.baselinePolicyHash,
      memory_version: first.baselineMemoryVersion,
      weekly_change_budget: 3,
      weekly_reflection_token_budget: 200_000,
    },
    acts,
    checks,
    summary: {
      total: checks.length,
      passed,
      failed,
      ok: failed === 0,
    },
    reproducibility: {
      runs,
      identical: reproducible,
      normalized_sha256: first.digest,
    },
    not_verified: NOT_VERIFIED,
  };
}
