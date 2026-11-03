import { beforeEach, describe, expect, test } from "vitest";

import {
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createTaskRecord } from "../src/api/task-store.js";
import type { TaskRecord } from "../src/api/task-store.js";
import { assembleRunMemory } from "../src/api/run-memory.js";
import {
  DEFAULT_RETRIEVAL_POLICY,
  canaryBucket,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  createRsiService,
  createRsiStore,
} from "../src/memory/index.js";
import type {
  MemoryRepositories,
  MemoryRetrievalService,
  RetrievalStore,
  RsiRunOutcomeSource,
  RsiService,
} from "../src/memory/index.js";

/**
 * DAT-238 blocker 3: the run path consumes the pin. `assembleRunMemory` is the
 * production caller of `resolveRunVersions`; these tests prove a canary run gets
 * the unpublished overlay while a baseline run names the stored version and is
 * audited.
 */

let db: ControlPlaneDb;
let scope: WorkspaceScope;
let memory: MemoryRepositories;
let retrievalStore: RetrievalStore;
let retrieval: MemoryRetrievalService;
let rsi: RsiService;
let lessonId: string;

const OWNER = "usr_owner";
const PROPOSER = "agent_proposer";

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Run Memory Enterprise",
    enterprise_slug: "run-memory-ent",
    admin_user_id: "usr_root",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Run Memory",
    repository_id: "repo-run-memory",
    provider_instance_id: provider.id,
  });
  void enterprise;
  return {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: workspace.id,
    actor_id: OWNER,
  };
}

function taskRecord(runId: string | null): TaskRecord {
  const record = createTaskRecord({
    id: "tsk_run_memory",
    repository: {
      id: "github:run/memory",
      display_name: "run/memory",
      base_ref: "main",
      base_sha: "0".repeat(40),
    },
    summary: "node memory tests build command",
    sourceReference: null,
    acceptanceCriteria: [],
  });
  record.runId = runId;
  return record;
}

function startCanary(): void {
  const proposal = rsi.createProposal(scope, {
    title: "Replay-backed weights",
    summary: "Offline replay",
    diff: "- relevance: 0.45\n+ relevance: 0.45",
    target: "retrieval_weights",
    proposer: { id: PROPOSER, kind: "agent" },
    candidate_policy: DEFAULT_RETRIEVAL_POLICY,
  });
  const actor = { id: OWNER, role: "owner" as const };
  rsi.evaluate(scope, proposal.proposal_id, {}, actor);
  rsi.approve(scope, proposal.proposal_id, actor);
  rsi.startCanary(scope, proposal.proposal_id, actor);
}

beforeEach(() => {
  db = openControlPlaneDb();
  migrate(db);
  scope = bootstrap();
  memory = createMemoryRepositories(db);
  retrievalStore = createRetrievalStore(db);
  retrieval = createMemoryRetrievalService({ memory, store: retrievalStore });
  const store = createRsiStore(db);
  const outcomes: RsiRunOutcomeSource = { outcomeFor: () => null };
  rsi = createRsiService({ store, memory, retrieval, retrievalStore, outcomes });

  const lesson = memory.items.create(scope, {
    kind: "lesson",
    scope: {},
    statement: "Run node memory tests before delivery",
    preconditions: ["node workspace"],
    provenance: { author_type: "human" },
    trust: "human",
    sensitivity: "internal",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
  });
  memory.evidence.add(scope, lesson.item.id, {
    evidence_type: "reviewer_decision",
    reference: "pr:run-memory",
  });
  memory.items.setStatus(scope, lesson.item.id, "candidate", 1);
  memory.items.setStatus(scope, lesson.item.id, "active", 1);
  lessonId = lesson.item.id;

  for (let index = 0; index < 20; index += 1) {
    for (const dataset of ["golden", "holdout"] as const) {
      const input = {
        case_id: `${dataset}-${index}`,
        dataset,
        query: "node memory tests build command",
        scope: { path_prefix: "node/src/memory" },
        role: "owner" as const,
        expected_item_ids: [lessonId],
        forbidden_item_ids: [],
      };
      if (dataset === "golden") {
        store.addGoldenCase(scope, input, OWNER);
      } else {
        store.addHoldoutCase(scope, input, OWNER);
      }
    }
  }
  startCanary();
});

describe("run-start memory assembly", () => {
  test("a canary-pinned run consumes the unpublished overlay without an audit row", () => {
    const runId = Array.from({ length: 2_000 }, (_, index) => `run_canary_${index}`).find(
      (candidate) => canaryBucket(scope.workspace_id, candidate) < 1_000,
    );
    expect(runId).toBeDefined();
    const record = taskRecord(runId as string);

    const context = assembleRunMemory({ memory: retrieval, rsi }, scope, record);
    expect(context.ref?.canary).toBe(true);
    expect(context.ref?.rollout_id).not.toBeNull();
    expect(context.ref?.item_ids).toContain(lessonId);
    expect(context.system_prompt).toContain("Run node memory tests before delivery");
    expect(context.system_prompt).toContain("<memory_directive>");
    expect(context.system_prompt).toContain('memory version="');

    const pin = rsi.getRunPin(scope, runId as string);
    expect(pin?.canary).toBe(true);
    expect(pin?.rollout_id).not.toBeNull();
    expect(pin?.policy_hash).toBe(context.ref?.policy_hash);
    // The overlay is a preview: no retrieval audit row is written for it.
    expect(retrievalStore.getRun(scope, context.ref?.bundle_id as string)).toBeUndefined();
  });

  test("a baseline-pinned run names the stored policy version and is audited", () => {
    const runId = Array.from({ length: 2_000 }, (_, index) => `run_base_${index}`).find(
      (candidate) => canaryBucket(scope.workspace_id, candidate) >= 1_000,
    );
    expect(runId).toBeDefined();
    const record = taskRecord(runId as string);

    const context = assembleRunMemory({ memory: retrieval, rsi }, scope, record);
    expect(context.ref?.canary).toBe(false);
    expect(context.ref?.policy_version).toBe(1);
    expect(context.ref?.item_ids).toContain(lessonId);
    expect(context.system_prompt).toContain("Run node memory tests before delivery");
    expect(retrievalStore.getRun(scope, context.ref?.bundle_id as string)).toBeDefined();
  });

  test("a run without an id has no memory context", () => {
    const context = assembleRunMemory(
      { memory: createMemoryRetrievalService({ memory, store: retrievalStore }), rsi },
      scope,
      taskRecord(null),
    );
    expect(context).toEqual({ system_prompt: "", ref: null });
  });
});
