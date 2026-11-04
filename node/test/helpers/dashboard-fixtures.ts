/**
 * Shared dashboard fixtures (DAT-230).
 *
 * Seeds the real upstream stores with a small, fully deterministic scenario:
 * one known provider-native attempt, one priced posting, one delivery trace
 * event and an empty budget journal. Ids come from the caller so both the
 * HTTP tests and the captured fixtures use the live scope.
 */

import { BudgetStore } from "../../src/budget/index.js";
import { CostStore } from "../../src/cost/index.js";
import type { DashboardSources } from "../../src/dashboard/index.js";
import { UsageLedgerStore } from "../../src/ledger/index.js";
import { TraceStore } from "../../src/trace/store.js";
import { invocationInput, rateInput } from "./cost-fixtures.js";

export const DASHBOARD_FROM = "2026-06-01T00:00:00.000Z";
export const DASHBOARD_TO = "2026-06-02T00:00:00.000Z";

export interface DashboardScopeIds {
  enterpriseId: string;
  workspaceId: string;
}

export interface DashboardFixture extends DashboardSources {
  ledger: UsageLedgerStore;
  cost: CostStore;
  budget: BudgetStore;
  trace: TraceStore;
}

const FIXED_NOW = "2026-06-01T10:30:00.000Z";

export function seedDashboard(scope: DashboardScopeIds): DashboardFixture {
  const ledger = new UsageLedgerStore({ now: () => new Date(FIXED_NOW) });
  ledger.recordAttempt({
    identity: {
      enterprise_id: scope.enterpriseId,
      workspace_id: scope.workspaceId,
      issue_id: "issue-1",
      run_id: "run-1",
      invocation_id: "inv-1",
      trace_id: "trace-1",
    },
    attempt: 1,
    destination: {
      endpoint_id: "ep-1",
      provider: "openai",
      model_id: "gpt-4o",
      internal: false,
    },
    api: "openai-completions",
    started_at: "2026-06-01T10:00:00.000Z",
    ended_at: "2026-06-01T10:00:02.000Z",
    finish_status: "stop",
    provider_request_id: "req-1",
    returned_model: null,
    usage_report: {
      source: "transport_reported",
      payload: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    },
  });

  const cost = new CostStore({ now: () => new Date(FIXED_NOW) });
  const categories = [
    ["input", "0.003"],
    ["output", "0.015"],
    ["cache_read", "0.000001"],
    ["cache_write", "0.000001"],
    ["reasoning", "0.000001"],
  ] as const;
  for (const [category, rate] of categories) {
    cost.addRateRevision(
      rateInput({
        revision_id: `rev-${category}`,
        enterprise_id: scope.enterpriseId,
        workspace_id: scope.workspaceId,
        endpoint_id: "ep-1",
        model_id: "gpt-4o",
        category,
        rate,
      }),
    );
  }
  cost.recordInvocationCost(
    invocationInput({
      enterprise_id: scope.enterpriseId,
      workspace_id: scope.workspaceId,
      invocation_id: "inv-1",
      attempt: 1,
      requested_model: "gpt-4o",
      started_at: "2026-06-01T10:00:00.000Z",
      ended_at: "2026-06-01T10:00:02.000Z",
    }),
  );

  // Wired but empty: an empty source is a real zero, distinct from a
  // missing one.
  const budget = new BudgetStore({ now: () => new Date(FIXED_NOW) });

  const trace = new TraceStore({ now: () => new Date(FIXED_NOW) });
  trace.append({
    source: "worker",
    event_id: "evt-1",
    sequence: 1,
    event_time: "2026-06-01T10:05:00.000Z",
    record_class: "operational_trace",
    kind: "delivery.finished",
    enterprise_id: scope.enterpriseId,
    workspace_id: scope.workspaceId,
    trace_id: "trace-1",
    span_id: "span-1",
    issue_id: "issue-1",
    task_id: "task-1",
    agent_id: "agent-a",
    delivery_id: "del-1",
    artifact_id: "art-1",
    evidence_refs: ["ev-1"],
    labels: { outcome: "succeeded" },
    payload: { content: "never served" },
  });

  return { ledger, cost, budget, trace, tasks: { list: () => [] } };
}
