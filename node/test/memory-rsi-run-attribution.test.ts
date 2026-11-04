import { beforeEach, describe, expect, test } from "vitest";

import {
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createTaskRunOutcomes } from "../src/api/run-outcomes.js";
import { TaskStore, createTaskRecord } from "../src/api/task-store.js";
import type { TaskRecord } from "../src/api/task-store.js";
import {
  DEFAULT_RETRIEVAL_POLICY,
  canaryBucket,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  createRsiService,
  createRsiStore,
} from "../src/memory/index.js";
import type { MemoryRepositories, RetrievalStore, RsiService } from "../src/memory/index.js";

/**
 * DAT-238 canary attribution: a task's task-level state must never make a
 * pinned historical run look successful. These tests drive the real RSI
 * service with the task-projection outcome adapter.
 */

let db: ControlPlaneDb;
let scope: WorkspaceScope;
let memory: MemoryRepositories;
let retrievalStore: RetrievalStore;
let taskStore: TaskStore;
let rsi: RsiService;
let proposalId: string;
let lessonId: string;
let seq: number;

const OWNER = "usr_owner";
const PROPOSER = "agent_proposer";

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Attribution Enterprise",
    enterprise_slug: "attribution-ent",
    admin_user_id: "usr_root",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Attribution",
    repository_id: "repo-attribution",
    provider_instance_id: provider.id,
  });
  void enterprise;
  return {
    enterprise_id: admin_scope.enterprise_id,
    workspace_id: workspace.id,
    actor_id: OWNER,
  };
}

function pinArm(arm: "candidate" | "baseline", count: number): string[] {
  const runIds: string[] = [];
  while (runIds.length < count) {
    seq += 1;
    const runId = `run_${arm}_${seq}`;
    const selected = canaryBucket(scope.workspace_id, runId) < 1_000;
    if (selected !== (arm === "candidate")) {
      continue;
    }
    const pin = rsi.resolveRunVersions(scope, runId);
    if (pin.canary !== (arm === "candidate")) {
      continue;
    }
    runIds.push(runId);
  }
  return runIds;
}

function putTask(
  id: string,
  runs: Array<{
    run_id: string;
    state: TaskRecord["runs"][number]["state"];
    actions_completed?: number;
  }>,
): void {
  const task = createTaskRecord({
    id,
    workspaceId: scope.workspace_id,
    enterpriseId: scope.enterprise_id,
    repository: {
      id: "github:test/attribution",
      display_name: "test/attribution",
      base_ref: "main",
      base_sha: "0".repeat(40),
    },
    summary: "attribution fixture",
    sourceReference: null,
    acceptanceCriteria: [],
  });
  task.runs = runs.map((run, index) => ({
    run_id: run.run_id,
    state: run.state,
    created_at: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
    ...(run.actions_completed !== undefined ? { actions_completed: run.actions_completed } : {}),
    ...(run.actions_completed !== undefined ? { safety_events: 0 } : {}),
    ...(run.actions_completed !== undefined
      ? { updated_at: `2026-11-0${(index % 9) + 1}T00:10:00.000Z` }
      : {}),
  }));
  task.runId = runs[runs.length - 1]?.run_id ?? null;
  // Contaminated aggregate: every run merged would be the wrong conclusion.
  task.status = "merged";
  task.terminal = true;
  task.progress = { phase: "validating", actions_completed: 999, actions_total: null };
  taskStore.put(task);
}

function startCanary(): void {
  const proposal = rsi.createProposal(scope, {
    title: "Attribution canary",
    summary: "Run-level evidence",
    diff: "- relevance: 0.45\n+ relevance: 0.45",
    target: "retrieval_weights",
    proposer: { id: PROPOSER, kind: "agent" },
    candidate_policy: DEFAULT_RETRIEVAL_POLICY,
  });
  proposalId = proposal.proposal_id;
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
  taskStore = new TaskStore();
  seq = 0;
  const retrieval = createMemoryRetrievalService({ memory, store: retrievalStore });
  const store = createRsiStore(db);
  rsi = createRsiService({
    store,
    memory,
    retrieval,
    retrievalStore,
    outcomes: createTaskRunOutcomes(taskStore),
  });

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
    reference: "pr:attribution",
  });
  memory.items.reviewVersion(scope, lesson.item.id, 1, "usr_reviewer");
  memory.items.setStatus(scope, lesson.item.id, "candidate", 1);
  memory.items.setStatus(scope, lesson.item.id, "active", 1);
  lessonId = lesson.item.id;

  for (let index = 0; index < 20; index += 1) {
    for (const dataset of ["golden", "holdout"] as const) {
      const input = {
        case_id: `${dataset}-${index}`,
        dataset,
        query: "node memory tests build command",
        scope: {},
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

describe("canary run attribution", () => {
  test("a task's merged status cannot turn a pinned rejected run into a success", () => {
    const candidateRuns = pinArm("candidate", 10);
    const baselineRuns = pinArm("baseline", 10);
    putTask(
      "tsk_candidate",
      candidateRuns.map((runId, index) => ({
        run_id: runId,
        state: index === 0 ? "merged" : "rejected",
        actions_completed: 1,
      })),
    );
    putTask(
      "tsk_baseline",
      baselineRuns.map((runId) => ({
        run_id: runId,
        state: "merged",
        actions_completed: 1,
      })),
    );

    const view = rsi.recordCanaryObservation(scope, proposalId, {
      id: OWNER,
      role: "owner",
    });
    const observation = view.observations[0];
    expect(observation?.candidate_sample_size).toBe(10);
    expect(observation?.candidate_successes).toBe(1);
    expect(observation?.candidate_rework).toBe(9);
    expect(observation?.baseline_successes).toBe(10);
    // One merged run out of ten is a regression, not a borrowed 10/10 pass.
    expect(view.status).toBe("rolled_back");
    expect(view.rollout?.reason).toMatch(/automatic rollback/);
  });

  test("unattributable multi-run samples are excluded and stay inconclusive", () => {
    const candidateRuns = pinArm("candidate", 10);
    putTask(
      "tsk_unattributed",
      candidateRuns.map((runId) => ({ run_id: runId, state: "merged" })),
    );

    const view = rsi.recordCanaryObservation(scope, proposalId, {
      id: OWNER,
      role: "owner",
    });
    const observation = view.observations[0];
    expect(observation?.sample_size).toBe(0);
    expect(observation?.verdict).toBe("inconclusive");
    expect(view.status).toBe("canary");
    expect(view.rollout?.stage).toBe(10);
  });
});
