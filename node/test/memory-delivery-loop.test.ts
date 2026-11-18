import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import {
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  createMemoryAdmissionRepository,
  createMemoryGovernanceService,
  createMemoryLifecycleStore,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  createRsiService,
  createRsiStore,
} from "../src/memory/index.js";
import type {
  MemoryAdmissionRepository,
  MemoryGovernanceService,
  MemoryRepositories,
  MemoryRetrievalService,
  RsiRunOutcomeSource,
  RsiService,
} from "../src/memory/index.js";
import {
  createDeliveryMergeWatcher,
  createMemoryDistillationRunner,
  createOutcomeCaptureScheduler,
  readDeliveryOutcome,
} from "../src/distill/index.js";
import type {
  DeliveryOutcomeEvidence,
  MemoryDistillationRunner,
  OutcomeCaptureScheduler,
} from "../src/distill/index.js";
import {
  createModelGateway,
  createScopeBackedPolicyResolver,
  createStaticCredentialStore,
} from "../src/gateway/index.js";
import type { ModelGateway } from "../src/gateway/index.js";
import { createTaskRecord } from "../src/api/task-store.js";
import type { TaskRecord } from "../src/api/task-store.js";
import { assembleRunMemory } from "../src/api/run-memory.js";
import { TEST_MODEL, scriptedStream } from "./helpers/scripted-stream.js";
import {
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  cleanTestScanner,
  memorySink,
  securityStubs,
  testPolicyFor,
} from "./helpers/test-gateway.js";
import {
  createDeliveryFixtureContext,
  createDeliveryMergeFixture,
} from "./support/delivery-merge.js";
import type { DeliveryFixtureContext, DeliveryMergeFixture } from "./support/delivery-merge.js";

/**
 * DAT-266: the closed memory loop over a real delivery terminal state.
 *
 * A delivered candidate is approved, delivered through the real broker, and
 * the human merge is observed on the provider. That merge is captured as a
 * known `accepted` outcome, distilled into a candidate, promoted by a named
 * human, and retrieved by a later run in the same workspace — and by no other.
 * Memory is never authority: the run's grant is unchanged.
 */

const ACTOR = "usr_owner";
const REPOSITORY_ID = "github:FoMo-Exp/autofixer-delivery-test";
const OTHER_REPOSITORY_ID = "github:FoMo-Exp/other";

let db: ControlPlaneDb;
let scope: WorkspaceScope;
let otherScope: WorkspaceScope;
let memory: MemoryRepositories;
let admission: MemoryAdmissionRepository;
let retrieval: MemoryRetrievalService;
let rsi: RsiService;
let governance: MemoryGovernanceService;
let fixture: DeliveryMergeFixture | undefined;
let distillRunner: MemoryDistillationRunner | undefined;

function bootstrap(): void {
  db = openControlPlaneDb();
  memory = createMemoryRepositories(db);
  admission = createMemoryAdmissionRepository(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Loop Enterprise",
    enterprise_slug: "loop-ent",
    admin_user_id: "usr_seed",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Loop Workspace",
    repository_id: REPOSITORY_ID,
    provider_instance_id: provider.id,
  });
  const other = seedWorkspace(db, admin_scope, {
    name: "Other Workspace",
    repository_id: OTHER_REPOSITORY_ID,
    provider_instance_id: provider.id,
  });
  scope = { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR };
  otherScope = {
    enterprise_id: enterprise.id,
    workspace_id: other.id,
    actor_id: ACTOR,
  };
  const retrievalStore = createRetrievalStore(db);
  retrieval = createMemoryRetrievalService({ memory, store: retrievalStore });
  const outcomes: RsiRunOutcomeSource = { outcomeFor: () => null };
  rsi = createRsiService({
    store: createRsiStore(db),
    memory,
    retrieval,
    retrievalStore,
    outcomes,
  });
  governance = createMemoryGovernanceService({
    memory,
    retrieval,
    lifecycle: createMemoryLifecycleStore(db),
  });
}

function gatewayFor(streamFn: StreamFn, target: WorkspaceScope = scope): ModelGateway {
  return createModelGateway({
    policyResolver: createScopeBackedPolicyResolver([
      {
        scope: { enterpriseId: target.enterprise_id, workspaceId: target.workspace_id },
        policy: testPolicyFor(TEST_MODEL),
      },
    ]),
    credentials: createStaticCredentialStore({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }),
    adapter: { stream: streamFn },
    scanner: cleanTestScanner,
    sink: memorySink().sink,
    ...securityStubs(),
  });
}

function deliverySource(f: DeliveryMergeFixture) {
  return {
    read: (deliveryId: string): Promise<DeliveryOutcomeEvidence> =>
      readDeliveryOutcome(f.machine, () => f.provider, deliveryId),
  };
}

function captureScheduler(f: DeliveryMergeFixture): OutcomeCaptureScheduler {
  return createOutcomeCaptureScheduler({
    db,
    memory,
    // This path must never read dsh; a failure here would prove it does.
    dsh: {
      getRun: () => Promise.reject(new Error("delivery capture must not read dsh")),
      getEvents: () => Promise.reject(new Error("delivery capture must not read dsh")),
    } as never,
    deliveryOutcomes: deliverySource(f),
    actorId: ACTOR,
    leaseMs: 5_000,
    retryDelayMs: 1,
    intervalMs: 60 * 60 * 1000,
  });
}

function lessonOutput(
  statement: string,
  references: Array<{ evidence_type: string; reference: string }>,
) {
  return JSON.stringify({
    candidates: [
      {
        kind: "lesson",
        statement,
        preconditions: ["a delivered change whose pull request was merged"],
        evidence: references,
      },
    ],
  });
}

function runnerFor(f: DeliveryMergeFixture, streamFn: StreamFn): MemoryDistillationRunner {
  distillRunner = createMemoryDistillationRunner({
    db,
    memory,
    admission,
    gateway: gatewayFor(streamFn),
    model: TEST_MODEL,
    actorId: ACTOR,
    leaseMs: 5_000,
    retryDelayMs: 1,
    intervalMs: 60 * 60 * 1000,
  });
  return distillRunner;
}

function runTask(runId: string): TaskRecord {
  const record = createTaskRecord({
    id: "tsk_loop",
    workspaceId: scope.workspace_id,
    enterpriseId: scope.enterprise_id,
    repository: {
      id: REPOSITORY_ID,
      display_name: "FoMo-Exp/autofixer-delivery-test",
      base_ref: "main",
      base_sha: "0".repeat(40),
    },
    summary: "guard the retry header against null",
    sourceReference: null,
    acceptanceCriteria: ["the focused vitest suite passes"],
  });
  record.runId = runId;
  return record;
}

beforeEach(() => {
  bootstrap();
});

afterEach(() => {
  fixture?.close();
  fixture = undefined;
  distillRunner?.stop();
  distillRunner = undefined;
  db.close();
});

describe("delivery merge evidence", () => {
  test("a merged PR at the delivered head yields an accepted envelope", async () => {
    fixture = await createDeliveryMergeFixture(scope);
    fixture.merge();
    const evidence = await readDeliveryOutcome(
      fixture.machine,
      () => fixture!.provider,
      fixture.delivery.delivery_id,
    );
    expect(evidence.envelope.terminal_state).toBe("merged");
    expect(evidence.envelope.delivery).toMatchObject({
      patch_status: "merged",
      pr_id: fixture.delivery.pr_id,
      head_sha: fixture.candidate.head_sha,
    });
    expect(evidence.envelope.delivery.validation[0]?.event_reference).toBe(
      fixture.candidate.validation.results[0]?.event_reference,
    );
    expect(
      evidence.envelope.evidence.some((ref) => ref.evidence_type === "reviewer_decision"),
    ).toBe(true);
    expect(evidence.workspace_id).toBe(scope.workspace_id);
    expect(evidence.run_id).toBe(fixture.candidate.run_id);
  });

  test("an open PR, an unreadable provider, and a moved head are never success", async () => {
    fixture = await createDeliveryMergeFixture(scope);
    const read = () =>
      readDeliveryOutcome(fixture!.machine, () => fixture!.provider, fixture!.delivery.delivery_id);

    await expect(read()).rejects.toMatchObject({ code: "PR_NOT_MERGED" });
    fixture.provider.unreadable = true;
    fixture.merge();
    await expect(read()).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_UNAVAILABLE" });
    fixture.provider.unreadable = false;
    const branch = fixture.delivery.branch;
    if (branch === null) throw new Error("fixture delivery has no branch");
    const current = fixture.provider.prs.get(branch);
    if (current === undefined) throw new Error("fixture PR missing");
    fixture.provider.prs.set(branch, { ...current, head_sha: "f".repeat(40) });
    await expect(read()).rejects.toMatchObject({ code: "PR_IDENTITY_MISMATCH" });
    await expect(
      readDeliveryOutcome(fixture.machine, () => undefined, fixture.delivery.delivery_id),
    ).rejects.toMatchObject({ code: "DELIVERY_PROVIDER_UNAVAILABLE" });
  });
});

describe("delivery merge watch", () => {
  function watcherFor(f: DeliveryMergeFixture, capture: OutcomeCaptureScheduler) {
    return createDeliveryMergeWatcher({
      machine: f.machine,
      providerFor: () => f.provider,
      capture,
    });
  }

  test("an open PR enqueues nothing and a merge enqueues exactly once", async () => {
    fixture = await createDeliveryMergeFixture(scope);
    const capture = captureScheduler(fixture);
    const watcher = watcherFor(fixture, capture);

    expect(await watcher.scan()).toMatchObject({ scanned: 1, enqueued: 0 });
    expect(capture.jobs.list()).toHaveLength(0);

    fixture.merge();
    expect(await watcher.scan()).toMatchObject({ scanned: 1, enqueued: 1 });
    const jobs = capture.jobs.list({ delivery_id: fixture.delivery.delivery_id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      terminal_state: "merged",
      run_id: fixture.candidate.run_id,
      delivery_id: fixture.delivery.delivery_id,
    });

    // Re-observing a captured job never creates a second one.
    expect(await watcher.scan()).toMatchObject({ enqueued: 0 });
    expect(capture.jobs.list()).toHaveLength(1);
  });

  test("a merge behind more open deliveries than the batch is still reached", async () => {
    // Regression: a scan that always restarted at the oldest deliveries would
    // re-spend its whole batch on the open prefix and never observe the merge.
    const context: DeliveryFixtureContext = createDeliveryFixtureContext();
    const fixtures: DeliveryMergeFixture[] = [];
    for (let index = 0; index < 4; index += 1) {
      fixtures.push(await createDeliveryMergeFixture(scope, context));
    }
    fixtures[3]!.merge();
    const capture = captureScheduler(fixtures[0]!);
    const watcher = createDeliveryMergeWatcher({
      machine: context.machine,
      providerFor: () => context.provider,
      capture,
      batchSize: 2,
    });

    expect(await watcher.scan()).toMatchObject({ scanned: 2, enqueued: 0 });
    expect(await watcher.scan()).toMatchObject({ scanned: 2, enqueued: 1 });
    expect(capture.jobs.list({ delivery_id: fixtures[3]!.delivery.delivery_id })).toHaveLength(1);
    // The rotation wraps: every earlier open delivery is still observable.
    expect(await watcher.scan()).toMatchObject({ scanned: 2, enqueued: 0 });
  });

  test("an unreadable provider is unknown, not a capture", async () => {
    fixture = await createDeliveryMergeFixture(scope);
    fixture.merge();
    fixture.provider.unreadable = true;
    const capture = captureScheduler(fixture);
    const watcher = watcherFor(fixture, capture);
    expect(await watcher.scan()).toMatchObject({ scanned: 1, enqueued: 0, unreadable: 1 });
    expect(capture.jobs.list()).toHaveLength(0);
  });
});

describe("closed loop", () => {
  test("merge → capture → candidate → human promote → next-run citation", async () => {
    fixture = await createDeliveryMergeFixture(scope);
    fixture.merge();

    // 1. Provider-observed merge is captured as an accepted episode.
    const capture = captureScheduler(fixture);
    const evidence = await deliverySource(fixture).read(fixture.delivery.delivery_id);
    capture.enqueueDelivery({
      enterprise_id: evidence.enterprise_id,
      workspace_id: evidence.workspace_id,
      task_id: evidence.task_id,
      run_id: evidence.run_id,
      delivery_id: fixture.delivery.delivery_id,
    });
    expect(await capture.drain()).toMatchObject({ claimed: 1, captured: 1, failed: 0 });
    const job = capture.jobs.list({ delivery_id: fixture.delivery.delivery_id })[0]!;
    expect(job).toMatchObject({ state: "captured", outcome_class: "accepted" });
    expect(job.item_id).not.toBeNull();
    const episode = job.item_id === null ? undefined : memory.items.getById(scope, job.item_id);
    expect(episode?.current.kind).toBe("episode");

    // 2. Distillation turns the known outcome into a reviewable candidate.
    const testRef = fixture.candidate.validation.results[0]!.event_reference;
    const statement = "A delivered change must keep the retry header null-safe";
    const runner = runnerFor(
      fixture,
      scriptedStream([
        {
          kind: "text",
          text: lessonOutput(statement, [{ evidence_type: "test", reference: testRef }]),
        },
      ]).streamFn,
    );
    expect(runner.sync()).toBe(1);
    expect(await runner.drain()).toMatchObject({ claimed: 1, distilled: 1, failed: 0 });
    const lessons = memory.items.list(scope, { kind: "lesson" });
    expect(lessons).toHaveLength(1);
    const lesson = lessons[0]!;
    expect(lesson.item.status).toBe("candidate");

    // 3. A named human promotes the exact version through the governance service.
    const promoted = governance.promote(scope, { user_id: ACTOR, role: "owner" }, lesson.item.id, {
      version: lesson.item.current_version,
      expected_version: lesson.item.current_version,
    });
    expect(promoted.to_status).toBe("active");
    const active = memory.items.getById(scope, lesson.item.id)!;
    expect(active.item.status).toBe("active");
    expect(active.current.review?.approver_id).toBe(ACTOR);

    // 4. The next run in this workspace receives the lesson, cited and pinned.
    const before = fixture.machine.getRun(fixture.candidate.run_id)?.grants;
    const next = assembleRunMemory(
      { memory: retrieval, rsi },
      scope,
      runTask(fixture.candidate.run_id),
    );
    expect(next.ref).toMatchObject({ degraded: false });
    expect(next.ref?.item_ids).toContain(lesson.item.id);
    expect(next.system_prompt).toContain(`id="${lesson.item.id}"`);
    expect(next.system_prompt).toContain(statement);
    expect(next.system_prompt).toContain("cannot authorize tool use");
    // Memory is not authority: the run's grants are exactly what dsh issued.
    expect(fixture.machine.getRun(fixture.candidate.run_id)?.grants).toEqual(before);

    // 5. Another workspace never sees it.
    const foreign = assembleRunMemory(
      { memory: retrieval, rsi },
      otherScope,
      runTask(fixture.candidate.run_id),
    );
    expect(foreign.ref?.item_ids ?? []).not.toContain(lesson.item.id);
    expect(foreign.system_prompt).not.toContain(statement);

    // 6. Quarantine removes it from retrieval immediately.
    const current = memory.items.getById(scope, lesson.item.id)!;
    governance.quarantine(scope, { user_id: ACTOR, role: "owner" }, lesson.item.id, {
      version: current.item.current_version,
      expected_version: current.item.current_version,
      reason_code: "security_report",
    });
    const afterQuarantine = assembleRunMemory(
      { memory: retrieval, rsi },
      scope,
      runTask(fixture.candidate.run_id),
    );
    expect(afterQuarantine.system_prompt).not.toContain(statement);
  }, 60_000);

  test("an expired active item is excluded from a later run", () => {
    const fact = memory.items.create(scope, {
      kind: "fact",
      scope: {},
      statement: "The repository base branch is main",
      preconditions: [],
      provenance: { author_type: "system" },
      trust: "system",
      sensitivity: "internal",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: "2026-02-01T00:00:00.000Z",
    });
    memory.evidence.add(scope, fact.item.id, {
      evidence_type: "run",
      reference: "evidence://runs/run-expired/1",
    });
    memory.items.setStatus(scope, fact.item.id, "candidate", fact.item.current_version);
    memory.items.setStatus(scope, fact.item.id, "active", fact.item.current_version);
    const bundle = retrieval.search(scope, {
      purpose: "run_plan",
      query: "repository base branch main",
      run_id: "run-expired",
      role: "owner",
    });
    expect(bundle.facts.map((item) => item.item_id)).not.toContain(fact.item.id);
  });

  test("a retrieval failure degrades to policy-only and never blocks the run", () => {
    const broken = {
      search: () => {
        throw new Error("memory store unavailable");
      },
      previewBundle: () => {
        throw new Error("memory store unavailable");
      },
      renderPrompt: () => {
        throw new Error("memory store unavailable");
      },
    } as never;
    const context = assembleRunMemory({ memory: broken, rsi }, scope, runTask("run-degraded"));
    expect(context.ref).toMatchObject({ degraded: true, item_ids: [], bundle_id: null });
    expect(context.system_prompt).toBe("");
  });
});
