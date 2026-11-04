/**
 * Dashboard read-model tests (DAT-230, ADR-0008).
 *
 * These seed the real upstream stores (invocation ledger, cost ledger, budget
 * journal, trace, task events) rather than stubbing aggregate inputs, so the
 * assertions cover the joins and the honesty rules end to end: unknown usage
 * is counted, never added as zero; empty and missing sources are distinguishable;
 * financial reads are role-gated; and every read is audited with metadata only.
 */

import { describe, expect, test } from "vitest";

import { ApiError } from "../src/api/errors.js";
import { createTaskRecord, type TaskEvent, type TaskRecord } from "../src/api/task-store.js";
import {
  BudgetStore,
  createBudgetAuthority,
  createStaticBudgetPolicyResolver,
} from "../src/budget/index.js";
import { CostStore, type RateCardRevisionInput } from "../src/cost/index.js";
import {
  DashboardService,
  type DashboardScope,
  type DashboardSources,
} from "../src/dashboard/index.js";
import { UsageLedgerStore, type InvocationAttemptObservation } from "../src/ledger/index.js";
import { TraceStore } from "../src/trace/store.js";
import {
  BUDGET_SCOPE,
  knownUsage,
  reserveRequest,
  testBudgetPolicy,
} from "./helpers/budget-fixtures.js";
import { figure, invocationInput, rateInput } from "./helpers/cost-fixtures.js";

const ENT = "ent_test";
const WS = "ws_test";

const ACCESS = { enterprise_id: ENT, workspace_id: WS, subject: "tester" };

const OWNER: DashboardScope = { ...ACCESS, role: "owner" };
const ADMIN: DashboardScope = { ...ACCESS, role: "admin" };
const MEMBER: DashboardScope = { ...ACCESS, role: "member" };

const NOW = new Date("2026-06-01T12:00:00.000Z");
const FROM = "2026-06-01T00:00:00.000Z";
const TO = "2026-06-02T00:00:00.000Z";
const BASE_QUERY = { from: FROM, to: TO, timezone: "UTC", bucket: "hour" };

function fixedNow(): () => Date {
  return () => NOW;
}

function observation(
  overrides: {
    identity?: Partial<InvocationAttemptObservation["identity"]>;
  } & Partial<Omit<InvocationAttemptObservation, "identity">> = {},
): InvocationAttemptObservation {
  const { identity, ...rest } = overrides;
  return {
    identity: {
      enterprise_id: ENT,
      workspace_id: WS,
      issue_id: "issue-1",
      run_id: "run-1",
      invocation_id: "inv-1",
      trace_id: "trace-1",
      ...identity,
    },
    attempt: 1,
    destination: {
      endpoint_id: "ep-1",
      provider: "openai",
      model_id: "model-a",
      internal: false,
    },
    api: "openai-completions",
    started_at: "2026-06-01T10:00:00.000Z",
    ended_at: "2026-06-01T10:00:02.000Z",
    finish_status: "stop",
    provider_request_id: "req_1",
    returned_model: null,
    usage_report: {
      source: "transport_reported",
      payload: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    },
    ...rest,
  };
}

function rateRevisions(store: CostStore): void {
  const revisions: Array<[string, RateCardRevisionInput["category"], string]> = [
    ["rev-input", "input", "0.003"],
    ["rev-output", "output", "0.015"],
    ["rev-cache-read", "cache_read", "0.000001"],
    ["rev-cache-write", "cache_write", "0.000001"],
    ["rev-reasoning", "reasoning", "0.000001"],
  ];
  for (const [revisionId, category, rate] of revisions) {
    store.addRateRevision(
      rateInput({
        revision_id: revisionId,
        enterprise_id: ENT,
        workspace_id: WS,
        endpoint_id: "ep-1",
        model_id: "model-a",
        category,
        rate,
      }),
    );
  }
}

function seedLedger(store: UsageLedgerStore): void {
  store.recordAttempt(observation());
  store.recordAttempt(
    observation({
      attempt: 2,
      started_at: "2026-06-01T10:01:00.000Z",
      ended_at: "2026-06-01T10:01:01.000Z",
      finish_status: "error",
      provider_request_id: "req_2",
      usage_report: {
        source: "transport_reported",
        payload: { input: 800, output: 400, cacheRead: 0, cacheWrite: 0 },
      },
    }),
  );
  store.recordAttempt(
    observation({
      identity: {
        issue_id: "issue-2",
        run_id: "run-2",
        invocation_id: "inv-2",
        trace_id: "trace-2",
      },
      started_at: "2026-06-01T10:02:00.000Z",
      ended_at: "2026-06-01T10:02:03.000Z",
      finish_status: "transport_failed",
      provider_request_id: null,
      usage_report: null,
    }),
  );
}

function seedCost(store: CostStore): void {
  store.recordInvocationCost(
    invocationInput({
      enterprise_id: ENT,
      workspace_id: WS,
      invocation_id: "inv-1",
      attempt: 1,
      started_at: "2026-06-01T10:00:00.000Z",
      ended_at: "2026-06-01T10:00:02.000Z",
    }),
  );
  store.recordInvocationCost(
    invocationInput({
      enterprise_id: ENT,
      workspace_id: WS,
      invocation_id: "inv-2",
      attempt: 1,
      started_at: "2026-06-01T10:02:00.000Z",
      ended_at: "2026-06-01T10:02:03.000Z",
      usage: {
        input: figure(800, null, "estimated"),
        output: figure(400, null, "estimated"),
        cache_read: figure(0, null, "estimated"),
        cache_write: figure(0, null, "estimated"),
        reasoning: figure(0, null, "estimated"),
        completeness: "estimated",
      },
    }),
  );
}

async function seedBudget(): Promise<BudgetStore> {
  const store = new BudgetStore({ now: () => new Date("2026-06-01T10:30:00.000Z") });
  const authority = createBudgetAuthority({
    store,
    policyResolver: createStaticBudgetPolicyResolver(testBudgetPolicy(), BUDGET_SCOPE),
  });
  const settled = await authority.reserve(
    reserveRequest({ invocation_id: "inv_test", issue_id: "issue-1", trace_id: "trace-1" }),
  );
  if (settled.status !== "reserved") {
    throw new Error(`expected a reservation, got ${settled.status}`);
  }
  authority.settleUsage(settled.reservation_id, knownUsage(1200));

  const held = await authority.reserve(reserveRequest({ invocation_id: "inv_test2" }));
  if (held.status !== "reserved") {
    throw new Error(`expected a reservation, got ${held.status}`);
  }

  const released = await authority.reserve(reserveRequest({ invocation_id: "inv_test3" }));
  if (released.status !== "reserved") {
    throw new Error(`expected a reservation, got ${released.status}`);
  }
  authority.release(released.reservation_id, "attempt never left the gateway");
  return store;
}

function seedTrace(store: TraceStore): void {
  store.append({
    source: "worker",
    event_id: "evt-1",
    sequence: 1,
    event_time: "2026-06-01T10:05:00.000Z",
    record_class: "operational_trace",
    kind: "error.raised",
    enterprise_id: ENT,
    workspace_id: WS,
    trace_id: "trace-1",
    span_id: "span-1",
    issue_id: "issue-1",
    task_id: "task-1",
    run_id: "run-1",
    agent_id: "agent-a",
    labels: { outcome: "denied" },
    payload: { prompt: "never served by the dashboard" },
  });
  store.append({
    source: "worker",
    event_id: "evt-2",
    sequence: 2,
    event_time: "2026-06-01T10:06:00.000Z",
    record_class: "operational_trace",
    kind: "error.raised",
    enterprise_id: ENT,
    workspace_id: WS,
    trace_id: "trace-2",
    span_id: "span-2",
    issue_id: "issue-2",
    run_id: "run-2",
    agent_id: "agent-b",
    labels: { outcome: "allowed" },
  });
  store.append({
    source: "worker",
    event_id: "evt-3",
    sequence: 3,
    event_time: "2026-06-01T10:07:00.000Z",
    record_class: "operational_trace",
    kind: "delivery.finished",
    enterprise_id: ENT,
    workspace_id: WS,
    trace_id: "trace-1",
    span_id: "span-3",
    issue_id: "issue-1",
    task_id: "task-1",
    run_id: "run-1",
    agent_id: "agent-a",
    delivery_id: "del-1",
    artifact_id: "art-1",
    evidence_refs: ["ev-1"],
    labels: { outcome: "succeeded" },
  });
  store.append({
    source: "worker",
    event_id: "evt-4",
    sequence: 4,
    event_time: "2026-06-01T10:08:00.000Z",
    record_class: "operational_trace",
    kind: "tool.executed",
    enterprise_id: ENT,
    workspace_id: WS,
    trace_id: "trace-1",
    span_id: "span-4",
    issue_id: "issue-1",
    task_id: "task-1",
    run_id: "run-1",
    agent_id: "agent-a",
  });
}

function taskEvent(
  eventId: string,
  sequence: number,
  occurredAt: string,
  type: TaskEvent["type"],
  data: Record<string, unknown>,
): TaskEvent {
  return {
    event_id: eventId,
    sequence,
    occurred_at: occurredAt,
    task_id: "task-1",
    task_version: 1,
    type,
    data,
  };
}

function seedTask(): TaskRecord {
  const task = createTaskRecord({
    id: "task-1",
    workspaceId: WS,
    enterpriseId: ENT,
    repository: {
      id: "repo-1",
      display_name: "AutoFixer",
      base_ref: "main",
      base_sha: "base-sha",
    },
    summary: "dashboard fixture task",
    sourceReference: null,
    acceptanceCriteria: [],
  });
  task.createdAt = "2026-06-01T09:00:00.000Z";
  task.events.push(
    taskEvent("task-evt-1", 1, "2026-06-01T09:00:30.000Z", "task.status_changed", {
      from: "queued",
      to: "planning",
    }),
    taskEvent("task-evt-2", 2, "2026-06-01T09:05:00.000Z", "approval.required", {}),
    taskEvent("task-evE-3", 3, "2026-06-01T09:07:00.000Z", "approval.resolved", {
      approved: true,
    }),
    taskEvent("task-evt-4", 4, "2026-06-01T09:08:00.000Z", "validation.completed", {
      passed: true,
    }),
  );
  return task;
}

interface Fixture {
  service: DashboardService;
  sources: DashboardSources;
  ledger: UsageLedgerStore;
  cost: CostStore;
  trace: TraceStore;
}

async function fullFixture(): Promise<Fixture> {
  const ledger = new UsageLedgerStore({ now: fixedNow() });
  seedLedger(ledger);
  const cost = new CostStore({ now: () => new Date("2026-06-01T10:30:00.000Z") });
  rateRevisions(cost);
  seedCost(cost);
  const budget = await seedBudget();
  const trace = new TraceStore({ now: fixedNow() });
  seedTrace(trace);
  const task = seedTask();
  const sources: DashboardSources = {
    ledger,
    cost,
    budget,
    trace,
    tasks: { list: () => [task] },
  };
  return {
    service: new DashboardService({ sources, now: fixedNow() }),
    sources,
    ledger,
    cost,
    trace,
  };
}

function expectApiError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(status);
    expect(apiError.code).toBe(code);
    return;
  }
  throw new Error(`expected ApiError ${status}/${code}`);
}

describe("dashboard totals keep known, estimated and unknown separate", () => {
  test("ledger counts, rates and token figures expose their own denominators", async () => {
    const { service } = await fullFixture();
    const summary = service.summary(OWNER, BASE_QUERY, "req-1");

    expect(summary.period).toEqual({
      from: FROM,
      to: TO,
      timezone: "UTC",
      boundary: "half_open",
      bucket: "hour",
    });
    // 3 attempts across 2 invocations: one retry, two error finishes.
    expect(summary.totals.requests).toEqual({
      status: "ok",
      source: "invocation_ledger",
      value: 3,
    });
    expect(summary.totals.invocations.value).toBe(2);
    expect(summary.totals.retries.value).toBe(1);
    expect(summary.totals.retry_rate).toEqual({
      status: "ok",
      source: "invocation_ledger",
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(summary.totals.error_rate).toEqual({
      status: "ok",
      source: "invocation_ledger",
      numerator: 2,
      denominator: 3,
      value: 0.666667,
    });

    const figures = summary.totals.tokens.figures;
    expect(summary.totals.tokens.status).toBe("ok");
    expect(figures).not.toBeNull();
    // Known from the completed provider-native attempt.
    expect(figures?.input).toEqual({
      known_tokens: 1000,
      estimated_tokens: 800,
      unknown_attempts: 1,
    });
    // The uncompleted attempt's output is unknown, not a partial or a zero.
    expect(figures?.output).toEqual({
      known_tokens: 500,
      estimated_tokens: 0,
      unknown_attempts: 2,
    });
    expect(figures?.total_tokens).toEqual({
      known_tokens: 1500,
      estimated_tokens: 0,
      unknown_attempts: 2,
    });
    expect(figures?.cache_read.unknown_attempts).toBe(1);
    expect(figures?.reasoning.unknown_attempts).toBe(3);

    // Latency samples are 2000ms, 1000ms and 3000ms.
    expect(summary.totals.latency_ms).toEqual({
      status: "ok",
      source: "invocation_ledger",
      p50_ms: 2000,
      p95_ms: 3000,
      sample_size: 3,
    });

    // Every ratio/metric publishes its denominator definition.
    expect(summary.denominators.requests).toContain("invocation-ledger attempts");
    expect(summary.denominators.tokens).toContain("never zero-filled");
    expect(summary.denominators.retry_rate).toBe("retries / invocations");
  });

  test("trace and task-event metrics use explicit decision denominators", async () => {
    const { service } = await fullFixture();
    const summary = service.summary(OWNER, BASE_QUERY, "req-2");

    // 2 decisions (denied, allowed); the non-decision tool event is outside
    // the denominator entirely.
    expect(summary.totals.denial_rate).toEqual({
      status: "ok",
      source: "trace",
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(summary.totals.delivery_results).toEqual({
      status: "ok",
      source: "trace",
      total: 1,
      succeeded: 1,
      failed: 0,
      unknown: 0,
    });
    expect(summary.totals.validation_outcomes).toEqual({
      status: "ok",
      source: "task_events",
      total: 1,
      passed: 1,
      failed: 0,
      unclassified: 0,
    });
    expect(summary.totals.queue_age_ms).toEqual({
      status: "ok",
      source: "task_events",
      p50_ms: 30_000,
      p95_ms: 30_000,
      sample_size: 1,
    });
    expect(summary.totals.approval_wait_ms).toEqual({
      status: "ok",
      source: "task_events",
      p50_ms: 120_000,
      p95_ms: 120_000,
      sample_size: 1,
    });
    // No connector-lag or worker-utilization telemetry exists; say so instead
    // of reporting a zero.
    expect(summary.totals.connector_lag_ms.status).toBe("not_measured");
    expect(summary.totals.connector_lag_ms.value).toBeNull();
    expect(summary.totals.worker_utilization.source).toBeNull();
  });

  test("cost separates known from estimated amounts per currency", async () => {
    const { service } = await fullFixture();
    const summary = service.summary(OWNER, BASE_QUERY, "req-3");
    const cost = summary.totals.cost;

    expect(cost.status).toBe("ok");
    expect(cost.source).toBe("cost_ledger");
    expect(cost.currencies).toEqual(["USD"]);
    expect(cost.rate_revision_ids).toEqual([
      "rev-cache-read",
      "rev-cache-write",
      "rev-input",
      "rev-output",
      "rev-reasoning",
    ]);
    expect(cost.completeness).toEqual({ known: 1, estimated: 1, unknown: 0 });
    const line = cost.lines?.find((candidate) => candidate.currency === "USD");
    expect(line).toMatchObject({
      cost_class: "provider_tokens",
      // 1000 input @ 0.003/1k + 500 output @ 0.015/1k.
      known_cost: "0.010500000000",
      // 800 input + 400 output on the estimated posting.
      estimated_cost: "0.008400000000",
      unknown_components: 0,
    });
    expect(cost.updated_at).not.toBeNull();
  });

  test("budget commitments stay committed until settled, held or released", async () => {
    const { service } = await fullFixture();
    const budget = service.summary(OWNER, BASE_QUERY, "req-4").totals.budget;

    expect(budget.status).toBe("ok");
    expect(budget.reservations).toEqual({ held: 1, settled: 1, reconciling: 0, released: 1 });
    // The held reservation keeps its full bound; the released one is refunded.
    expect(budget.outstanding_bound).toEqual([{ currency: "USD", amount: "0.1" }]);
    // The settled amount is a labelled ceiling estimate, not known cost.
    expect(budget.settled_known).toEqual([]);
    expect(budget.settled_estimated).toEqual([{ currency: "USD", amount: "0.012" }]);
    // The held reservation's monetary account was never observed.
    expect(budget.unknown_money_accounts).toBe(1);
  });
});

describe("dashboard breakdowns and drilldown", () => {
  test("breakdowns are grouped, capped by page size and served with a cursor", async () => {
    const { service } = await fullFixture();
    const first = service.summary(OWNER, { ...BASE_QUERY, breakdown: "task", limit: "1" }, "req-5");
    expect(first.breakdown.status).toBe("ok");
    expect(first.breakdown.rows.map((row) => row.key)).toEqual(["issue-1"]);
    expect(first.breakdown.rows[0]).toMatchObject({
      request_count: 2,
      invocation_count: 1,
      retry_count: 1,
      error_rate: 0.5,
    });
    expect(first.breakdown.next_cursor).not.toBeNull();

    const second = service.summary(
      OWNER,
      { ...BASE_QUERY, breakdown: "task", limit: "1", cursor: first.breakdown.next_cursor ?? "" },
      "req-6",
    );
    expect(second.breakdown.rows.map((row) => row.key)).toEqual(["issue-2"]);
    expect(second.breakdown.next_cursor).toBeNull();
  });

  test("agent breakdown comes from trace identity, never invented", async () => {
    const { service } = await fullFixture();
    const byAgent = service.summary(
      OWNER,
      { ...BASE_QUERY, breakdown: "agent" },
      "req-7",
    ).breakdown;
    expect(byAgent.status).toBe("ok");
    expect(byAgent.rows.map((row) => row.key)).toEqual(["agent-a", "agent-b"]);
    expect(byAgent.rows.map((row) => row.request_count)).toEqual([2, 1]);

    // Without trace there is no agent identity to attribute, so the
    // dimension is missing rather than an "unattributed" fabrication.
    const ledger = new UsageLedgerStore({ now: fixedNow() });
    seedLedger(ledger);
    const withoutTrace = new DashboardService({ sources: { ledger }, now: fixedNow() });
    const missing = withoutTrace.summary(
      OWNER,
      { ...BASE_QUERY, breakdown: "agent" },
      "req-8",
    ).breakdown;
    expect(missing.status).toBe("missing_source");
    expect(missing.rows).toEqual([]);
  });

  test("date buckets follow the requested civil timezone", () => {
    const ledger = new UsageLedgerStore({ now: fixedNow() });
    ledger.recordAttempt(
      observation({
        started_at: "2026-06-01T02:00:00.000Z",
        ended_at: "2026-06-01T02:00:01.000Z",
      }),
    );
    const service = new DashboardService({ sources: { ledger }, now: fixedNow() });
    const breakdown = service.summary(
      OWNER,
      {
        from: FROM,
        to: TO,
        timezone: "America/Los_Angeles",
        bucket: "day",
        breakdown: "date",
      },
      "req-9",
    ).breakdown;
    // 02:00Z is still 2026-05-31 in Los Angeles.
    expect(breakdown.rows.map((row) => row.key)).toEqual(["2026-05-31"]);
  });

  test("issue drilldown joins execution, cost, trace and references", async () => {
    const { service } = await fullFixture();
    const drilldown = service.issueDrilldown(OWNER, "issue-1", BASE_QUERY, "req-10");

    expect(drilldown.issue_id).toBe("issue-1");
    // Only issue-1's two attempts and its priced posting.
    expect(drilldown.totals.requests.value).toBe(2);
    expect(drilldown.totals.error_rate.value).toBe(0.5);
    expect(drilldown.totals.cost.lines?.[0]?.known_cost).toBe("0.010500000000");
    expect(drilldown.totals.cost.lines?.[0]?.estimated_cost).toBe("0.000000000000");

    expect(drilldown.runs).toHaveLength(1);
    expect(drilldown.runs[0]).toMatchObject({
      run_id: "run-1",
      task_ids: ["task-1"],
      event_count: 3,
    });
    expect(drilldown.references).toEqual({
      artifact_ids: ["art-1"],
      delivery_ids: ["del-1"],
      evidence_refs: ["ev-1"],
      task_ids: ["task-1"],
      truncated: false,
    });
    expect(drilldown.content).toEqual({
      access: "separate_authorization_required",
      payload_included: false,
    });
    expect(drilldown.trace.status).toBe("ok");
    expect(drilldown.trace.events).toHaveLength(3);
    for (const event of drilldown.trace.events) {
      expect(event).not.toHaveProperty("payload");
    }
  });

  test("workspace task metrics need only the task log; issue attribution needs trace", () => {
    const ledger = new UsageLedgerStore({ now: fixedNow() });
    seedLedger(ledger);
    const task = seedTask();
    const service = new DashboardService({
      sources: { ledger, tasks: { list: () => [task] } },
      now: fixedNow(),
    });

    const summary = service.summary(OWNER, BASE_QUERY, "req-task-summary");
    expect(summary.totals.queue_age_ms).toEqual({
      status: "ok",
      source: "task_events",
      p50_ms: 30_000,
      p95_ms: 30_000,
      sample_size: 1,
    });
    expect(summary.totals.approval_wait_ms.p50_ms).toBe(120_000);
    expect(summary.totals.validation_outcomes).toEqual({
      status: "ok",
      source: "task_events",
      total: 1,
      passed: 1,
      failed: 0,
      unclassified: 0,
    });
    // The task log is wired and has rows, but its newest row predates the
    // period end by more than the default hour: stale, not ok.
    expect(summary.sources.find((source) => source.source === "task_events")?.status).toBe("stale");

    // An issue cannot own a task without trace task identity, so the
    // drilldown reports the metric as missing rather than attributing it.
    const drilldown = service.issueDrilldown(OWNER, "issue-1", BASE_QUERY, "req-task-drilldown");
    expect(drilldown.totals.queue_age_ms.status).toBe("missing_source");
    expect(drilldown.totals.approval_wait_ms.status).toBe("missing_source");
    expect(drilldown.totals.validation_outcomes.status).toBe("missing_source");
    expect(drilldown.sources.find((source) => source.source === "task_events")?.status).toBe(
      "missing",
    );
  });

  test("cost items join each posting back to its ledger attempt", async () => {
    const { service } = await fullFixture();
    const page = service.costItems(OWNER, { ...BASE_QUERY, limit: "1" }, "req-11");

    expect(page.ledger_lookup).toBe("ok");
    expect(page.total).toBe(2);
    expect(page.next_cursor).not.toBeNull();
    const newest = page.items[0];
    expect(newest?.posting_id).toBe("cost-inv:inv-2:1");
    expect(newest?.completeness).toBe("estimated");
    expect(newest?.ledger_lookup).toBe("ok");
    expect(newest?.ledger_entry).toMatchObject({
      invocation_id: "inv-2",
      attempt: 1,
      issue_id: "issue-2",
      finish_status: "transport_failed",
      usage_completeness: "unknown",
      issue_drilldown_url: `/api/v1/workspaces/${WS}/dashboard/issues/issue-2`,
    });

    const next = service.costItems(
      OWNER,
      { ...BASE_QUERY, limit: "1", cursor: page.next_cursor ?? "" },
      "req-12",
    );
    expect(next.items[0]?.posting_id).toBe("cost-inv:inv-1:1");
    expect(next.items[0]?.completeness).toBe("known");
    expect(next.next_cursor).toBeNull();
  });
});

describe("missing, empty, stale and restricted data stay explicit", () => {
  test("an unwired deployment reports missing sources, not zeros", () => {
    const service = new DashboardService({ sources: {}, now: fixedNow() });
    const summary = service.summary(OWNER, BASE_QUERY, "req-13");

    expect(summary.totals.requests).toEqual({
      status: "missing_source",
      source: "invocation_ledger",
      value: null,
    });
    expect(summary.totals.tokens).toEqual({
      status: "missing_source",
      source: "invocation_ledger",
      figures: null,
    });
    expect(summary.totals.latency_ms.p50_ms).toBeNull();
    expect(summary.totals.latency_ms.sample_size).toBeNull();
    expect(summary.totals.denial_rate).toMatchObject({
      status: "missing_source",
      numerator: null,
      denominator: null,
      value: null,
    });
    expect(summary.totals.cost).toMatchObject({
      status: "missing_source",
      lines: null,
      currencies: null,
    });
    expect(summary.totals.budget.status).toBe("missing_source");
    expect(summary.totals.queue_age_ms.status).toBe("missing_source");
    expect(summary.totals.validation_outcomes.status).toBe("missing_source");
    expect(summary.sources.map((source) => source.status)).toEqual([
      "missing",
      "missing",
      "missing",
      "missing",
      "missing",
    ]);
    expect(summary.sources.every((source) => source.record_count === null)).toBe(true);
    expect(summary.unavailable_metrics.map((metric) => metric.metric)).toEqual(
      expect.arrayContaining(["requests", "denial_rate", "queue_age_ms", "connector_lag_ms"]),
    );
  });

  test("wired-but-empty sources report real zeros and empty status", () => {
    const sources: DashboardSources = {
      ledger: new UsageLedgerStore({ now: fixedNow() }),
      cost: new CostStore({ now: fixedNow() }),
      budget: new BudgetStore({ now: fixedNow() }),
      trace: new TraceStore({ now: fixedNow() }),
      tasks: { list: () => [] },
    };
    const service = new DashboardService({ sources, now: fixedNow() });
    const summary = service.summary(OWNER, BASE_QUERY, "req-14");

    expect(summary.totals.requests).toEqual({
      status: "empty",
      source: "invocation_ledger",
      value: 0,
    });
    expect(summary.totals.tokens.figures?.input).toEqual({
      known_tokens: 0,
      estimated_tokens: 0,
      unknown_attempts: 0,
    });
    expect(summary.totals.latency_ms).toEqual({
      status: "empty",
      source: "invocation_ledger",
      p50_ms: null,
      p95_ms: null,
      sample_size: 0,
    });
    expect(summary.totals.denial_rate).toMatchObject({ status: "empty", value: null });
    expect(summary.totals.delivery_results.status).toBe("empty");
    expect(summary.totals.queue_age_ms.status).toBe("empty");
    expect(summary.totals.validation_outcomes.status).toBe("empty");
    expect(summary.totals.cost).toMatchObject({
      status: "empty",
      source: "cost_ledger",
      lines: [],
      currencies: [],
      completeness: { known: 0, estimated: 0, unknown: 0 },
    });
    expect(summary.totals.budget).toMatchObject({
      status: "empty",
      reservations: { held: 0, settled: 0, reconciling: 0, released: 0 },
    });
    expect(summary.sources.map((source) => source.status)).toEqual([
      "empty",
      "empty",
      "empty",
      "empty",
      "empty",
    ]);
    expect(summary.breakdown.status).toBe("empty");
  });

  test("a source whose newest record is too old is stale, not ok", async () => {
    const { service } = await fullFixture();
    const stale = service.summary(OWNER, { ...BASE_QUERY, stale_after_seconds: "3600" }, "req-15");
    expect(stale.sources.find((source) => source.source === "invocation_ledger")).toMatchObject({
      status: "stale",
      watermark: "2026-06-01T10:02:00.000Z",
      record_count: 3,
    });
    expect(stale.sources.find((source) => source.source === "invocation_ledger")?.note).toContain(
      "older than 3600s",
    );

    const fresh = service.summary(OWNER, { ...BASE_QUERY, stale_after_seconds: "86400" }, "req-16");
    expect(fresh.sources.find((source) => source.source === "invocation_ledger")?.status).toBe(
      "ok",
    );
  });

  test("non-financial roles see restricted cost and budget, never zeros", async () => {
    const { service } = await fullFixture();
    const summary = service.summary(MEMBER, BASE_QUERY, "req-17");

    expect(summary.access).toEqual({
      financial: "restricted",
      content: "separate_authorization_required",
      quarantine: "separate_authorization_required",
    });
    expect(summary.totals.cost).toEqual({
      status: "restricted",
      source: "cost_ledger",
      lines: null,
      currencies: null,
      rate_revision_ids: null,
      completeness: null,
      updated_at: null,
    });
    expect(summary.totals.budget).toMatchObject({
      status: "restricted",
      reservations: null,
      outstanding_bound: null,
      settled_known: null,
    });
    // Financial source health is restricted too: not even its record count or
    // watermark leaks to a role that may not read the amounts.
    expect(summary.sources.find((source) => source.source === "cost_ledger")).toEqual({
      source: "cost_ledger",
      status: "restricted",
      watermark: null,
      record_count: null,
      stale_after_seconds: 3600,
      note: "financial access requires the owner or admin role",
    });
    expect(summary.sources.find((source) => source.source === "budget_journal")?.status).toBe(
      "restricted",
    );
    // Operational metrics stay available.
    expect(summary.totals.requests.value).toBe(3);
    expect(summary.unavailable_metrics.map((metric) => metric.metric)).toEqual(
      expect.arrayContaining(["cost", "budget"]),
    );
  });

  test("financial and audit reads refuse member and viewer roles", async () => {
    const { service } = await fullFixture();
    for (const role of ["member", "viewer"]) {
      const scope: DashboardScope = { ...ACCESS, role };
      expectApiError(
        () => service.costItems(scope, BASE_QUERY, "req-18"),
        403,
        "FINANCIAL_ACCESS_DENIED",
      );
      expectApiError(
        () => service.exportBundle(scope, BASE_QUERY, "req-19"),
        403,
        "FINANCIAL_ACCESS_DENIED",
      );
      expectApiError(
        () => service.auditTrail(scope, BASE_QUERY, "req-20"),
        403,
        "AUDIT_ACCESS_DENIED",
      );
    }
  });
});

describe("dashboard audit and query limits", () => {
  test("every read is audited with metadata only", async () => {
    const { service } = await fullFixture();
    service.summary(OWNER, BASE_QUERY, "req-21");
    service.costItems(OWNER, BASE_QUERY, "req-22");
    service.issueDrilldown(OWNER, "issue-1", BASE_QUERY, "req-23");
    service.exportBundle(OWNER, BASE_QUERY, "req-24");

    const exportEntries = service.auditTrail(OWNER, { operation: "export" }, "req-25");
    expect(exportEntries.total).toBe(1);
    expect(exportEntries.items[0]).toMatchObject({
      operation: "export",
      resource: "export",
      workspace_id: WS,
      subject: "tester",
      role: "owner",
    });

    const everything = service.auditTrail(ADMIN, {}, "req-26");
    expect(everything.items.map((entry) => entry.resource)).toEqual(
      expect.arrayContaining(["audit", "cost_items", "export", "issue_drilldown", "summary"]),
    );
    const summaryEntry = everything.items.find((entry) => entry.resource === "summary");
    expect(summaryEntry?.request_id).toBe("req-21");
    expect(summaryEntry?.record_count).toBe(5);
    // Audit records never carry token figures, cost amounts or content.
    for (const entry of everything.items) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "at",
          "audit_id",
          "enterprise_id",
          "issue_id",
          "operation",
          "query",
          "record_count",
          "request_id",
          "resource",
          "role",
          "subject",
          "workspace_id",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(everything.items);
    expect(serialized).not.toContain("model-a");
    expect(serialized).not.toContain("0.0105");
    expect(serialized).not.toContain("prompt");
  });

  test("workspace scope cannot be widened or substituted", async () => {
    const { service, ledger } = await fullFixture();
    // A record owned by another workspace is invisible to this scope.
    ledger.recordAttempt(
      observation({
        identity: { workspace_id: "ws-other", invocation_id: "inv-other" },
      }),
    );
    const summary = service.summary(OWNER, BASE_QUERY, "req-27");
    expect(summary.totals.requests.value).toBe(3);
    expect(summary.workspace_id).toBe(WS);

    // Reading with the other workspace's scope returns only that workspace.
    const other = service.summary({ ...OWNER, workspace_id: "ws-other" }, BASE_QUERY, "req-28");
    expect(other.totals.requests.value).toBe(1);
  });

  test("invalid periods, buckets, limits and cursors are refused", async () => {
    const { service } = await fullFixture();
    expectApiError(
      () => service.summary(OWNER, { ...BASE_QUERY, timezone: "Mars/Olympus" }, "req-29"),
      400,
      "INVALID_REQUEST",
    );
    expectApiError(
      () => service.summary(OWNER, { ...BASE_QUERY, bucket: "fortnight" }, "req-30"),
      400,
      "INVALID_REQUEST",
    );
    expectApiError(
      () => service.summary(OWNER, { from: TO, to: FROM }, "req-31"),
      400,
      "INVALID_REQUEST",
    );
    expectApiError(
      () => service.summary(OWNER, { from: "2024-01-01T00:00:00.000Z", to: TO }, "req-32"),
      400,
      "RANGE_TOO_LARGE",
    );
    expectApiError(
      () => service.summary(OWNER, { ...BASE_QUERY, limit: "0" }, "req-33"),
      400,
      "LIMIT_OUT_OF_RANGE",
    );
    expectApiError(
      () => service.summary(OWNER, { ...BASE_QUERY, limit: "201" }, "req-34"),
      400,
      "LIMIT_OUT_OF_RANGE",
    );
    expectApiError(
      () => service.summary(OWNER, { ...BASE_QUERY, cursor: "not-a-cursor" }, "req-35"),
      400,
      "INVALID_CURSOR",
    );
    expectApiError(
      () => service.summary(OWNER, { ...BASE_QUERY, breakdown: "region" }, "req-36"),
      400,
      "INVALID_REQUEST",
    );
  });
});
