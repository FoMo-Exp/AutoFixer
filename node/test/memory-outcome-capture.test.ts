import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createMemoryRepositories } from "../src/memory/index.js";
import type { MemoryRepositories } from "../src/memory/index.js";
import { createOutcomeCaptureScheduler } from "../src/distill/index.js";
import type { OutcomeCaptureScheduler } from "../src/distill/index.js";
import {
  buildOutcomeEnvelope,
  classifyOutcome,
  classifyStopCode,
  parseOutcomeEnvelope,
} from "../src/distill/index.js";
import type { TerminalRunEvidence } from "../src/distill/index.js";
import type { DshCreateRunResponse, DshProposedWork, DshRunResponse } from "../src/dsh/types.js";
import type { TaskResource } from "../src/api/task-store.js";
import { postJson } from "./helpers/http.js";
import { startAuthApp } from "./helpers/auth-app.js";
import type { AuthApp } from "./helpers/auth-app.js";
import { startDshServer } from "./helpers/dsh-server.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";

/**
 * DAT-264: terminal outcome capture is scheduled from authoritative dsh run
 * evidence, not from a Node projection or agent self-report.
 *
 * These cases exercise the real local Go dsh control plane for every terminal
 * state it can produce here (cancelled, rejected) and the outbox invariants
 * that survive restart, duplicates, concurrency, and delivery failure.
 */

const REPOSITORY_ID = "github:FoMo-Exp/AutoFixer";
const BASE_SHA = "52081eaddca099967fd8be13b3060337fde50d3f";
const APPROVER = "github:local-operator";
const ACTOR = "usr_capture_operator";

let dsh: DshServerHandle;
let db: ControlPlaneDb;
let memory: MemoryRepositories;
let scope: WorkspaceScope;
let otherScope: WorkspaceScope;
let runCounter = 0;

function neutralProposedWork(): DshProposedWork {
  return {
    localized_reversible_change: false,
    broad_refactor: false,
    dependency_change: false,
    data_shape_change: false,
    migration: false,
    permission_sensitive: false,
    material_uncertainty: false,
    requests_secret_access: false,
    writes_to_main: false,
    edits_ci_workflows: false,
    edits_governance: false,
    publishes_package: false,
    deploys: false,
    alters_infrastructure: false,
    unapproved_network: false,
  };
}

async function createRun(): Promise<{
  runId: string;
  taskId: string;
  created: DshCreateRunResponse;
}> {
  runCounter += 1;
  const taskId = `tsk_capture_${runCounter}`;
  const created = await dsh.client.createRun({
    task_id: taskId,
    issue: {
      provider: "github",
      external_id: `issue-${runCounter}`,
      source_reference: `https://github.com/FoMo-Exp/AutoFixer/issues/${runCounter}`,
    },
    repository: {
      repository_id: REPOSITORY_ID,
      url: "https://github.com/FoMo-Exp/AutoFixer.git",
      base_ref: "main",
      base_sha: BASE_SHA,
    },
    request: {
      summary: `Capture fixture run ${runCounter}`,
      requested_by: { actor_id: ACTOR, display_name: "Capture Operator" },
    },
    proposed_work: neutralProposedWork(),
    requested_scope: {
      path_hints: ["node"],
      tool_capabilities: ["echo"],
      max_wall_clock_seconds: 60,
    },
  });
  return { runId: created.run_id, taskId, created };
}

async function cancelRun(runId: string): Promise<void> {
  await dsh.client.cancelRun(runId, {
    requested_by: { actor_id: ACTOR, identity: APPROVER },
    reason: "capture fixture cancellation",
  });
}

async function rejectRun(runId: string, scopeDigest: string): Promise<void> {
  // dsh stamps the run with microsecond precision while an approval built from
  // `Date` is millisecond-truncated; paced approvals are the real boundary.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await dsh.client.recordApproval(runId, {
    approval_id: `apr_${runId}`,
    decision: "reject",
    approved_by: { actor_id: ACTOR, identity: APPROVER },
    approved_at: new Date().toISOString(),
    scope_digest: scopeDigest,
  });
}

function newScheduler(
  overrides: { maxAttempts?: number; retryDelayMs?: number; batchSize?: number } = {},
): OutcomeCaptureScheduler {
  return createOutcomeCaptureScheduler({
    db,
    memory,
    dsh: dsh.client,
    actorId: ACTOR,
    leaseMs: 5_000,
    retryDelayMs: overrides.retryDelayMs ?? 1,
    intervalMs: 60 * 60 * 1000,
    ...overrides,
  });
}

function episodeFor(runId: string, target: WorkspaceScope = scope) {
  return memory.items
    .list(target, { kind: "episode" })
    .filter((record) => record.current.source_run_id === runId);
}

function registration(runId: string, taskId: string, state: string, target = scope) {
  return {
    enterprise_id: target.enterprise_id,
    workspace_id: target.workspace_id,
    task_id: taskId,
    run_id: runId,
    state,
  };
}

beforeAll(async () => {
  dsh = await startDshServer({ approver: APPROVER });
}, 180_000);

/** Fresh control plane and workspace memory per test: one outbox, no carryover. */
beforeEach(() => {
  db = openControlPlaneDb();
  memory = createMemoryRepositories(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Capture Enterprise",
    enterprise_slug: "capture-ent",
    admin_user_id: "usr_seed",
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Capture Workspace",
    repository_id: REPOSITORY_ID,
    provider_instance_id: provider.id,
  });
  const other = seedWorkspace(db, admin_scope, {
    name: "Other Workspace",
    repository_id: "github:FoMo-Exp/Other",
    provider_instance_id: provider.id,
  });
  scope = { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR };
  otherScope = { enterprise_id: enterprise.id, workspace_id: other.id, actor_id: ACTOR };
});

afterEach(() => {
  db.close();
});

afterAll(async () => {
  await dsh?.stop();
});

// ---------------------------------------------------------------------------
// Evidence → envelope mapping (no timers, no storage)
// ---------------------------------------------------------------------------

describe("terminal evidence classification", () => {
  test("every stop code maps to a real type, unknown codes never to success", () => {
    expect(classifyStopCode("stop_out_of_grant")).toEqual({
      stop_disposition: "failed",
      failure_cause: "policy_denied",
    });
    expect(classifyStopCode("deny_tool_not_permitted")).toEqual({
      stop_disposition: "failed",
      failure_cause: "policy_denied",
    });
    expect(classifyStopCode("stop_execution_failure")).toEqual({
      stop_disposition: "failed",
      failure_cause: "tool_failure",
    });
    expect(classifyStopCode("execution_resource_limit_exceeded")).toEqual({
      stop_disposition: "failed",
      failure_cause: "resource_limit",
    });
    expect(classifyStopCode("execution_supervision_unavailable")).toEqual({
      stop_disposition: "infra_failure",
      failure_cause: null,
    });
    expect(classifyStopCode("stop_local_review_required")).toEqual({
      stop_disposition: "unknown",
      failure_cause: null,
    });
    expect(classifyStopCode(null)).toEqual({ stop_disposition: "unknown", failure_cause: null });
  });

  test("a missing patch report or a merged state without delivery is not capturable", () => {
    const rejected = runEvidence({
      state: "rejected",
      patch_report: null,
      transition: {
        sequence: 2,
        resulting_state: "rejected",
        decision_or_stop_code: "approval_rejected",
      },
    });
    expect(() => buildOutcomeEnvelope(rejected)).toThrowError(/no finalized patch report/);

    const merged = runEvidence({
      state: "merged",
      patch_report: { patch_status: "not_created", change_summary: "claims a merge" },
      transition: { sequence: 3, resulting_state: "merged", decision_or_stop_code: null },
    });
    expect(() => buildOutcomeEnvelope(merged)).toThrowError(
      /merged but its patch report is not_created/,
    );
  });

  test("an unknown stop and a timeout stay non-success on the capture path", () => {
    const unknownStop = buildOutcomeEnvelope(
      runEvidence({
        state: "stopped",
        transition: {
          sequence: 2,
          resulting_state: "stopped",
          decision_or_stop_code: "stop_local_review_required",
        },
      }),
    );
    const unknownClass = classifyOutcome(parseOutcomeEnvelope(unknownStop));
    expect(unknownClass).toMatchObject({ class: "unknown", known: false, positive: false });
    if (unknownStop.terminal_state === "stopped") {
      expect(unknownStop.stop_disposition).toBe("unknown");
      expect(unknownStop.failure_cause).toBeNull();
    }

    const timedOut = buildOutcomeEnvelope(
      runEvidence({
        state: "timed_out",
        transition: {
          sequence: 2,
          resulting_state: "timed_out",
          decision_or_stop_code: "execution_timed_out",
        },
      }),
    );
    const timeoutClass = classifyOutcome(parseOutcomeEnvelope(timedOut));
    expect(timeoutClass).toMatchObject({ class: "timeout", known: false, positive: false });
  });

  test("a rejection without a recorded code is not capturable", () => {
    const evidence = runEvidence({
      state: "rejected",
      transition: { sequence: 2, resulting_state: "rejected", decision_or_stop_code: null },
    });
    expect(() => buildOutcomeEnvelope(evidence)).toThrowError(/without a recorded decision/);
  });

  test("an event chain that ends in another state is refused, never captured", () => {
    const evidence = runEvidence({
      state: "cancelled",
      transition: {
        sequence: 4,
        resulting_state: "stopped",
        decision_or_stop_code: "stop_local_review_required",
      },
    });
    expect(() => buildOutcomeEnvelope(evidence)).toThrowError(/newest transition is stopped/);
  });
});

function runEvidence(input: {
  state: string;
  patch_report?: unknown;
  transition: { sequence: number; resulting_state: string; decision_or_stop_code: string | null };
}): TerminalRunEvidence {
  const run = {
    run_id: "run-evidence-1",
    task_id: "tsk-evidence-1",
    issue_id: "issue-77",
    state: input.state,
    risk_assessment: {},
    grant_status: { state: "revoked", scope_digest: "sha256:scope", grant: null },
    execution_counts: { actions_total: 0, actions_allowed: 0, actions_denied: 0 },
    patch_report:
      input.patch_report === undefined
        ? {
            patch_status: "not_created",
            head_sha: null,
            pr_id: null,
            change_summary: "No patch was prepared.",
            validation: [],
            evidence_references: ["evidence://events/run-evidence-1/2"],
          }
        : input.patch_report,
    approval_snapshot: null,
    bundle_available: true,
    created_at: "2026-11-15T00:00:00.000Z",
  } as unknown as DshRunResponse;
  return {
    run,
    events: [
      {
        sequence: 1,
        event_type: "state_transition",
        prior_state: "requested",
        resulting_state: "approved",
        decision_or_stop_code: "approval_recorded",
      },
      {
        sequence: input.transition.sequence,
        event_type: "state_transition",
        prior_state: "approved",
        resulting_state: input.transition.resulting_state,
        decision_or_stop_code: input.transition.decision_or_stop_code,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Real dsh terminal states
// ---------------------------------------------------------------------------

describe("authoritative dsh terminal capture", () => {
  test("a cancelled run becomes one known cancelled episode with its reason", async () => {
    const { runId, taskId } = await createRun();
    await cancelRun(runId);
    const scheduler = newScheduler();
    scheduler.enqueue(registration(runId, taskId, "cancelled"));
    const report = await scheduler.drain();
    expect(report).toMatchObject({ claimed: 1, captured: 1, retried: 0, failed: 0 });

    const episodes = episodeFor(runId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.current.kind).toBe("episode");
    expect(episodes[0]?.current.statement).toContain("terminal outcome cancelled");
    expect(episodes[0]?.current.statement).toContain("reason cancellation_requested");
    expect(episodes[0]?.current.trust).toBe("system");

    const evidence = memory.evidence.listByItem(scope, episodes[0]?.item.id ?? "");
    expect(evidence.map((row) => `${row.evidence_type}:${row.reference}`)).toContain(
      `run:${runId}`,
    );

    const job = scheduler.jobs.list({ workspace_id: scope.workspace_id, run_id: runId }).at(0);
    expect(job?.state).toBe("captured");
    expect(job?.item_id).toBe(episodes[0]?.item.id);
  }, 60_000);

  test("a rejected run is recorded as rejected, never as success", async () => {
    const { runId, taskId, created } = await createRun();
    const digest = created.required_action?.scope_digest;
    expect(typeof digest).toBe("string");
    await rejectRun(runId, String(digest));
    const scheduler = newScheduler();
    scheduler.enqueue(registration(runId, taskId, "rejected"));
    await scheduler.drain();

    const episodes = episodeFor(runId);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.current.statement).toContain("terminal outcome rejected");
    expect(episodes[0]?.current.statement).toContain("reason approval_rejected");
  }, 60_000);

  test("a non-terminal run is never captured as a terminal outcome", async () => {
    const { runId, taskId } = await createRun();
    // A backoff longer than one drain pass keeps the assertion deterministic:
    // otherwise the row becomes due again mid-pass and burns its whole attempt
    // budget within one drain.
    const scheduler = newScheduler({ maxAttempts: 2, retryDelayMs: 60_000 });
    scheduler.enqueue(registration(runId, taskId, "stopped"));
    const first = await scheduler.drain();
    expect(first).toMatchObject({ captured: 0, retried: 1 });
    expect(episodeFor(runId)).toHaveLength(0);
    const job = scheduler.jobs.list({ workspace_id: scope.workspace_id, run_id: runId }).at(0);
    expect(job?.state).toBe("pending");
    expect(job?.last_error).toBe("RUN_NOT_TERMINAL");
    await cancelRun(runId);
  }, 60_000);

  test("a missing run's evidence leaves the job retryable, never fabricated", async () => {
    const scheduler = newScheduler({ maxAttempts: 1 });
    scheduler.enqueue(registration("run_does_not_exist", "tsk_missing", "cancelled"));
    const report = await scheduler.drain();
    expect(report).toMatchObject({ captured: 0, failed: 1 });
    const job = scheduler.jobs
      .list({ workspace_id: scope.workspace_id, run_id: "run_does_not_exist" })
      .at(0);
    expect(job?.state).toBe("failed");
    expect(job?.last_error).toBe("RUN_NOT_FOUND");
    expect(episodeFor("run_does_not_exist")).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Idempotency, recovery, isolation, delivery failure
// ---------------------------------------------------------------------------

describe("idempotent, recoverable scheduling", () => {
  test("restart and duplicate enqueue capture a terminal snapshot exactly once", async () => {
    const { runId, taskId } = await createRun();
    await cancelRun(runId);
    const first = newScheduler();
    first.enqueue(registration(runId, taskId, "cancelled"));
    expect(await first.drain()).toMatchObject({ captured: 1 });
    expect(episodeFor(runId)).toHaveLength(1);

    // Duplicate enqueue on the same worker.
    first.enqueue(registration(runId, taskId, "cancelled"));
    expect(await first.drain()).toMatchObject({ claimed: 0, captured: 0 });

    // A new process over the same durable outbox, recovering from the task
    // projection: the row is already captured, so nothing is written again.
    const restarted = newScheduler();
    const report = await restarted.recover([registration(runId, taskId, "cancelled")]);
    expect(report).toMatchObject({ claimed: 0, captured: 0 });
    expect(episodeFor(runId)).toHaveLength(1);
  }, 60_000);

  test("concurrent workers never capture the same run twice", async () => {
    const { runId, taskId } = await createRun();
    await cancelRun(runId);
    const a = newScheduler();
    const b = newScheduler();
    a.enqueue(registration(runId, taskId, "cancelled"));
    b.enqueue(registration(runId, taskId, "cancelled"));
    const reports = await Promise.all([a.drain(), b.drain()]);
    expect(reports.reduce((sum, report) => sum + report.captured, 0)).toBe(1);
    expect(episodeFor(runId)).toHaveLength(1);
  }, 60_000);

  test("the captured episode lives only in the job's server-side workspace", async () => {
    const { runId, taskId } = await createRun();
    await cancelRun(runId);
    const scheduler = newScheduler();
    scheduler.enqueue(registration(runId, taskId, "cancelled"));
    await scheduler.drain();
    const captured = episodeFor(runId);
    expect(captured).toHaveLength(1);
    // The same item is invisible through another workspace's scope, and the
    // other workspace has no capture job for this run.
    expect(memory.items.getById(otherScope, captured[0]?.item.id ?? "")).toBeUndefined();
    expect(episodeFor(runId, otherScope)).toHaveLength(0);
    expect(
      scheduler.jobs.list({ workspace_id: otherScope.workspace_id, run_id: runId }),
    ).toHaveLength(0);
  }, 60_000);

  test("a delivery failure is retried and never reported as captured", async () => {
    const { runId, taskId } = await createRun();
    await cancelRun(runId);
    // One row per pass: a 1ms backoff could otherwise become due again inside
    // the same drain and record a second attempt before the assertion.
    const scheduler = newScheduler({ batchSize: 1 });
    scheduler.enqueue(registration(runId, taskId, "cancelled"));

    db.exec(`CREATE TRIGGER capture_delivery_down
      BEFORE INSERT ON memory_items
      BEGIN SELECT RAISE(ABORT, 'delivery down'); END`);
    try {
      const failed = await scheduler.drain();
      expect(failed).toMatchObject({ captured: 0, retried: 1 });
      expect(episodeFor(runId)).toHaveLength(0);
      const pending = scheduler.jobs
        .list({ workspace_id: scope.workspace_id, run_id: runId })
        .at(0);
      expect(pending?.state).toBe("pending");
      expect(pending?.last_error).toBe("CAPTURE_DELIVERY_FAILED");
      expect(pending?.attempts).toBe(1);
    } finally {
      db.exec("DROP TRIGGER capture_delivery_down");
    }

    // The retry backoff is a real timestamp; wait it out.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retried = await scheduler.drain();
    expect(retried).toMatchObject({ claimed: 1, captured: 1 });
    expect(episodeFor(runId)).toHaveLength(1);
  }, 60_000);

  test("a terminal snapshot for a non-terminal state is ignored at enqueue", () => {
    const scheduler = newScheduler();
    expect(scheduler.enqueue(registration("run_queued", "tsk_queued", "running"))).toBeNull();
    expect(
      scheduler.jobs.list({ workspace_id: scope.workspace_id, run_id: "run_queued" }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Production wiring: a terminal task projection schedules the capture
// ---------------------------------------------------------------------------

describe("orchestrator terminal projection → capture", () => {
  let app: AuthApp | undefined;

  beforeAll(async () => {
    app = await startAuthApp({ dsh });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
  });

  test("cancelling a task registers the dsh terminal snapshot and captures one episode", async () => {
    const started = app;
    if (started === undefined) throw new Error("app did not start");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${started.orchestrator.apiToken}`,
    };
    const created = await postJson<TaskResource>(
      `${started.base}/api/v1/tasks`,
      {
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "Capture this cancelled run as a workspace episode",
        source_reference: "https://github.com/FoMo-Exp/AutoFixer/issues/264",
      },
      headers,
    );
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const runId = created.body.current_run_id;
    expect(typeof runId).toBe("string");

    const cancelled = await postJson<TaskResource>(
      `${started.base}/api/v1/tasks/${taskId}/cancel`,
      { reason: "operator cancelled the capture fixture" },
      headers,
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.status).toBe("cancelled");

    const capture = started.orchestrator.memoryCapture;
    const memoryRepos = started.orchestrator.memoryRepositories;
    if (capture === undefined || memoryRepos === undefined) {
      throw new Error("memory capture is not wired with the control plane");
    }
    const job = capture.jobs
      .list({ workspace_id: started.workspaceId, run_id: String(runId) })
      .at(0);
    // The projection registered the server-side workspace, not a request body.
    expect(job?.enterprise_id).toBe(started.enterpriseId);
    expect(job?.terminal_state).toBe("cancelled");

    const report = await capture.drain();
    expect(report.captured).toBeGreaterThanOrEqual(1);
    const scope: WorkspaceScope = {
      enterprise_id: started.enterpriseId,
      workspace_id: started.workspaceId,
      actor_id: "usr_seed",
    };
    const episodes = memoryRepos.items
      .list(scope, { kind: "episode" })
      .filter((record) => record.current.source_run_id === String(runId));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.current.statement).toContain("terminal outcome cancelled");

    // DAT-265 derives its work from this snapshot: capture stored the exact
    // redacted envelope, its class, and its digest in the same transaction.
    const capturedJob = capture.jobs
      .list({ workspace_id: started.workspaceId, run_id: String(runId) })
      .at(0);
    expect(capturedJob?.outcome_class).toBe("cancelled");
    expect(capturedJob?.envelope_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(capturedJob?.envelope ?? "null")).toMatchObject({
      run_id: String(runId),
      terminal_state: "cancelled",
    });
    expect(started.orchestrator.memoryDistillation).toBeDefined();
  }, 120_000);
});
