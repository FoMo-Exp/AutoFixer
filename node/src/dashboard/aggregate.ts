/**
 * Pure aggregation for the workspace dashboard (DAT-230).
 *
 * Every function here takes records the caller already read inside an
 * authenticated enterprise/workspace scope; nothing in this module filters by
 * scope itself, and nothing writes. The rules that matter:
 *
 * - A missing figure is counted as unknown, never added as zero.
 * - Currencies and cost classes are never merged; token cost is not worker
 *   cost.
 * - Rates are `numerator / denominator` with both terms published.
 * - Unavailable sources produce `null` values, not fabricated zeros.
 */

import { summarizeCosts } from "../cost/index.js";
import type { CostLedgerEntry, RateCardRevision } from "../cost/index.js";
import { formatAmount, parseAmount } from "../budget/index.js";
import type { BudgetReservation } from "../budget/index.js";
import type { InvocationUsageRecord } from "../ledger/index.js";
import type { TraceEvent } from "../trace/schema.js";
import type { TaskRecord } from "../api/task-store.js";
import { dateBucketKey, nearestRank, roundRatio } from "./period.js";
import type {
  DashboardBreakdownDimension,
  DashboardBreakdownRow,
  DashboardBudgetMetric,
  DashboardCostCompleteness,
  DashboardCostLine,
  DashboardCostMetric,
  DashboardCurrencyAmount,
  DashboardDateBucket,
  DashboardDeliveryMetric,
  DashboardLatencyMetric,
  DashboardTokenMetric,
  DashboardValidationMetric,
  FigureTotals,
  TokenTotals,
} from "./types.js";
import { DASHBOARD_BREAKDOWN_MAX_DISTINCT_KEYS } from "./types.js";

export interface HalfOpenWindow {
  from_ms: number;
  to_ms: number;
}

/** Sources that are structurally absent report `missing_source`, never 0. */
export const MISSING_STATUS = "missing_source" as const;

function emptyFigureTotals(): FigureTotals {
  return { known_tokens: 0, estimated_tokens: 0, unknown_attempts: 0 };
}

/** Empty token totals are a real zero only when the ledger is wired. */
export function emptyTokenTotals(): TokenTotals {
  return {
    input: emptyFigureTotals(),
    output: emptyFigureTotals(),
    cache_read: emptyFigureTotals(),
    cache_write: emptyFigureTotals(),
    reasoning: emptyFigureTotals(),
    total_tokens: emptyFigureTotals(),
  };
}

/**
 * Per-category completeness is the *less* complete of the record rollup and
 * the figure itself: a non-native adapter reports figures without inventing
 * provider precision, so its whole record is `estimated` even though the
 * individual count is not null.
 */
function effectiveCompleteness(
  recordCompleteness: string,
  figureCompleteness: string,
): "known" | "estimated" | "unknown" {
  if (recordCompleteness === "unknown" || figureCompleteness === "unknown") {
    return "unknown";
  }
  if (recordCompleteness === "estimated" || figureCompleteness === "estimated") {
    return "estimated";
  }
  return "known";
}

function addFigure(
  target: FigureTotals,
  figure: { tokens: number | null; completeness: string },
  recordCompleteness: string,
): void {
  const completeness = effectiveCompleteness(recordCompleteness, figure.completeness);
  if (figure.tokens === null || completeness === "unknown") {
    target.unknown_attempts += 1;
    return;
  }
  if (completeness === "estimated") {
    target.estimated_tokens += figure.tokens;
    return;
  }
  target.known_tokens += figure.tokens;
}

export function tokenTotals(records: readonly InvocationUsageRecord[]): TokenTotals {
  const totals = emptyTokenTotals();
  for (const record of records) {
    const recordCompleteness = record.usage.completeness;
    addFigure(totals.input, record.usage.input, recordCompleteness);
    addFigure(totals.output, record.usage.output, recordCompleteness);
    addFigure(totals.cache_read, record.usage.cache_read, recordCompleteness);
    addFigure(totals.cache_write, record.usage.cache_write, recordCompleteness);
    addFigure(totals.reasoning, record.usage.reasoning, recordCompleteness);
    if (record.usage.total_tokens === null || recordCompleteness === "unknown") {
      totals.total_tokens.unknown_attempts += 1;
    } else if (recordCompleteness === "estimated") {
      totals.total_tokens.estimated_tokens += record.usage.total_tokens;
    } else {
      totals.total_tokens.known_tokens += record.usage.total_tokens;
    }
  }
  return totals;
}

const ERROR_FINISHES = new Set(["error", "transport_failed", "unknown", "aborted"]);

export function latencySamplesMs(records: readonly InvocationUsageRecord[]): number[] {
  const samples: number[] = [];
  for (const record of records) {
    const start = Date.parse(record.started_at);
    const end = Date.parse(record.ended_at);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
      continue;
    }
    samples.push(end - start);
  }
  return samples;
}

function latencyMetric(
  source: "invocation_ledger",
  records: readonly InvocationUsageRecord[],
  status: DashboardLatencyMetric["status"],
): DashboardLatencyMetric {
  const samples = latencySamplesMs(records);
  return {
    status,
    source,
    p50_ms: nearestRank(samples, 0.5),
    p95_ms: nearestRank(samples, 0.95),
    sample_size: samples.length,
  };
}

export interface LedgerTotalsInput {
  records: readonly InvocationUsageRecord[];
  status: "ok" | "empty";
}

/**
 * Ledger-derived totals. `invocations` is the distinct `invocation_id` count;
 * a retry is any attempt after the first of that invocation, so
 * `retries = attempts - invocations` (never negative).
 */
export function ledgerTotals(input: LedgerTotalsInput): {
  requests: number;
  invocations: number;
  retries: number;
  retry_rate: number | null;
  error_attempts: number;
  error_rate: number | null;
  tokens: TokenTotals;
  latency_ms: DashboardLatencyMetric;
} {
  const { records, status } = input;
  const invocationIds = new Set<string>();
  let errorAttempts = 0;
  for (const record of records) {
    invocationIds.add(record.invocation_id);
    if (ERROR_FINISHES.has(record.finish_status)) {
      errorAttempts += 1;
    }
  }
  const invocations = invocationIds.size;
  const retries = Math.max(0, records.length - invocations);
  const latency = latencyMetric("invocation_ledger", records, status);
  return {
    requests: records.length,
    invocations,
    retries,
    retry_rate: roundRatio(retries, invocations),
    error_attempts: errorAttempts,
    error_rate: roundRatio(errorAttempts, records.length),
    tokens: status === "empty" ? emptyTokenTotals() : tokenTotals(records),
    latency_ms: latency,
  };
}

export function costMetric(
  entries: readonly CostLedgerEntry[],
  revisions: readonly RateCardRevision[],
): DashboardCostMetric {
  const summary = summarizeCosts(entries, revisions);
  const lines: DashboardCostLine[] = summary.lines.map((line) => ({
    currency: line.currency,
    cost_class: line.cost_class,
    known_cost: line.known_cost,
    estimated_cost: line.estimated_cost,
    unknown_components: line.unknown_components,
    components: line.components,
    postings: line.postings,
  }));
  const currencies = new Set<string>();
  const revisionIds = new Set<string>();
  const completeness: DashboardCostCompleteness = { known: 0, estimated: 0, unknown: 0 };
  let updatedAt: string | null = null;
  for (const entry of entries) {
    const posting = entry.posting;
    completeness[posting.completeness] += 1;
    if (posting.currency !== null) {
      currencies.add(posting.currency);
    }
    for (const component of posting.components) {
      if (component.currency !== null) {
        currencies.add(component.currency);
      }
      if (component.rate_revision_id !== null) {
        revisionIds.add(component.rate_revision_id);
      }
    }
    if (updatedAt === null || Date.parse(posting.recorded_at) > Date.parse(updatedAt)) {
      updatedAt = posting.recorded_at;
    }
  }
  for (const revision of revisions) {
    if (updatedAt === null || Date.parse(revision.recorded_at) > Date.parse(updatedAt)) {
      updatedAt = revision.recorded_at;
    }
  }
  return {
    status: entries.length === 0 ? "empty" : "ok",
    source: "cost_ledger",
    lines: entries.length === 0 ? [] : lines,
    currencies: [...currencies].sort(),
    rate_revision_ids: [...revisionIds].sort().slice(0, 100),
    completeness,
    updated_at: updatedAt,
  };
}

export function missingCostMetric(): DashboardCostMetric {
  return {
    status: MISSING_STATUS,
    source: "cost_ledger",
    lines: null,
    currencies: null,
    rate_revision_ids: null,
    completeness: null,
    updated_at: null,
  };
}

function addCurrency(target: Map<string, bigint>, currency: string, amount: string): void {
  target.set(currency, (target.get(currency) ?? 0n) + parseAmount(amount));
}

function currencyAmounts(map: Map<string, bigint>): DashboardCurrencyAmount[] {
  return [...map.entries()]
    .map(([currency, amount]) => ({ currency, amount: formatAmount(amount) }))
    .sort((a, b) => (a.currency < b.currency ? -1 : 1));
}

/**
 * Budget journal totals. A released reservation refunds its bound; a held or
 * reconciling one keeps the whole bound committed, including a monetary
 * account whose settlement is still unknown.
 */
export function budgetMetric(reservations: readonly BudgetReservation[]): DashboardBudgetMetric {
  const counts = { held: 0, settled: 0, reconciling: 0, released: 0 };
  const outstanding = new Map<string, bigint>();
  const settledKnown = new Map<string, bigint>();
  const settledEstimated = new Map<string, bigint>();
  let unknownMoneyAccounts = 0;
  let updatedAt: string | null = null;

  for (const reservation of reservations) {
    counts[reservation.status] += 1;
    if (reservation.status === "held" || reservation.status === "reconciling") {
      for (const account of reservation.money) {
        addCurrency(outstanding, account.currency, account.bound);
        if (account.used === null) {
          unknownMoneyAccounts += 1;
        }
      }
    } else if (reservation.status === "settled") {
      for (const account of reservation.money) {
        if (account.used === null) {
          // A settled reservation with an unobserved dimension is unknown, not
          // zero; the bound stays visible.
          unknownMoneyAccounts += 1;
          continue;
        }
        if (account.completeness === "estimated") {
          addCurrency(settledEstimated, account.currency, account.used);
        } else {
          addCurrency(settledKnown, account.currency, account.used);
        }
      }
    }
    if (updatedAt === null || Date.parse(reservation.updated_at) > Date.parse(updatedAt)) {
      updatedAt = reservation.updated_at;
    }
  }

  return {
    status: reservations.length === 0 ? "empty" : "ok",
    source: "budget_journal",
    reservations: counts,
    outstanding_bound: currencyAmounts(outstanding),
    settled_known: currencyAmounts(settledKnown),
    settled_estimated: currencyAmounts(settledEstimated),
    unknown_money_accounts: unknownMoneyAccounts,
    updated_at: updatedAt,
  };
}

export function missingBudgetMetric(): DashboardBudgetMetric {
  return {
    status: MISSING_STATUS,
    source: "budget_journal",
    reservations: null,
    outstanding_bound: null,
    settled_known: null,
    settled_estimated: null,
    unknown_money_accounts: null,
    updated_at: null,
  };
}

const DENIED = "denied";
/** The closed allow/deny vocabulary of an authorization decision. */
const DECISION_OUTCOMES = new Set(["allowed", "denied"]);

/**
 * Trace denial rate: decisions are trace events whose `outcome` label is an
 * allow/deny decision (`allowed` or `denied`). Events carrying other outcome
 * vocabulary — a delivery's `succeeded`, for example — are outside the
 * denominator entirely, so a delivery result never dilutes the deny rate.
 */
export function traceDecisionCounts(events: readonly TraceEvent[]): {
  decisions: number;
  denials: number;
  rate: number | null;
} {
  let decisions = 0;
  let denials = 0;
  for (const event of events) {
    const outcome = event.labels["outcome"];
    if (outcome === undefined || !DECISION_OUTCOMES.has(outcome)) {
      continue;
    }
    decisions += 1;
    if (outcome === DENIED) {
      denials += 1;
    }
  }
  return { decisions, denials, rate: roundRatio(denials, decisions) };
}

export function deliveryMetric(events: readonly TraceEvent[]): DashboardDeliveryMetric {
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let unknown = 0;
  for (const event of events) {
    if (event.kind !== "delivery.finished") {
      continue;
    }
    total += 1;
    switch (event.labels["outcome"]) {
      case "succeeded":
        succeeded += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "unknown":
        unknown += 1;
        break;
      default:
        break;
    }
  }
  return {
    status: total === 0 ? "empty" : "ok",
    source: "trace",
    total,
    succeeded,
    failed,
    unknown,
  };
}

function insideWindow(instant: string, window: HalfOpenWindow): boolean {
  const parsed = Date.parse(instant);
  return !Number.isNaN(parsed) && parsed >= window.from_ms && parsed < window.to_ms;
}

/** Time from task creation to the first transition out of `queued`. */
export function queueAgeSamplesMs(tasks: readonly TaskRecord[], window: HalfOpenWindow): number[] {
  const samples: number[] = [];
  for (const task of tasks) {
    const created = Date.parse(task.createdAt);
    if (Number.isNaN(created)) {
      continue;
    }
    const transition = task.events.find((event) => {
      if (event.type !== "task.status_changed") {
        return false;
      }
      return event.data["from"] === "queued" && event.data["to"] !== "queued";
    });
    if (transition === undefined || !insideWindow(transition.occurred_at, window)) {
      continue;
    }
    const at = Date.parse(transition.occurred_at);
    if (!Number.isNaN(at) && at >= created) {
      samples.push(at - created);
    }
  }
  return samples;
}

/** Time from each `approval.required` to the next `approval.resolved`. */
export function approvalWaitSamplesMs(
  tasks: readonly TaskRecord[],
  window: HalfOpenWindow,
): number[] {
  const samples: number[] = [];
  for (const task of tasks) {
    let pending: number | null = null;
    const ordered = [...task.events].sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
    );
    for (const event of ordered) {
      if (event.type === "approval.required") {
        if (pending === null) {
          pending = Date.parse(event.occurred_at);
        }
      } else if (event.type === "approval.resolved" && pending !== null) {
        const resolved = Date.parse(event.occurred_at);
        if (
          !Number.isNaN(pending) &&
          !Number.isNaN(resolved) &&
          resolved >= pending &&
          insideWindow(event.occurred_at, window)
        ) {
          samples.push(resolved - pending);
        }
        pending = null;
      }
    }
  }
  return samples;
}

export function validationMetric(
  tasks: readonly TaskRecord[],
  window: HalfOpenWindow,
): DashboardValidationMetric {
  let total = 0;
  let passed = 0;
  let failed = 0;
  let unclassified = 0;
  for (const task of tasks) {
    for (const event of task.events) {
      if (event.type !== "validation.completed" || !insideWindow(event.occurred_at, window)) {
        continue;
      }
      total += 1;
      if (event.data["passed"] === true) {
        passed += 1;
      } else if (event.data["passed"] === false) {
        failed += 1;
      } else {
        unclassified += 1;
      }
    }
  }
  return {
    status: total === 0 ? "empty" : "ok",
    source: "task_events",
    total,
    passed,
    failed,
    unclassified,
  };
}

export function latencyFromSamples(
  source: DashboardLatencyMetric["source"],
  samples: readonly number[],
): DashboardLatencyMetric {
  return {
    status: samples.length === 0 ? "empty" : "ok",
    source,
    p50_ms: nearestRank(samples, 0.5),
    p95_ms: nearestRank(samples, 0.95),
    sample_size: samples.length,
  };
}

export function missingLatency(source: DashboardLatencyMetric["source"]): DashboardLatencyMetric {
  return { status: MISSING_STATUS, source, p50_ms: null, p95_ms: null, sample_size: null };
}

export function missingTokenMetric(source: DashboardTokenMetric["source"]): DashboardTokenMetric {
  return { status: MISSING_STATUS, source, figures: null };
}

export function notMeasured(note: string): {
  status: "not_measured";
  source: null;
  value: null;
  note: string;
} {
  return { status: "not_measured", source: null, value: null, note };
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

export interface BreakdownInput {
  dimension: DashboardBreakdownDimension;
  timezone: string;
  bucket: DashboardDateBucket;
  records: readonly InvocationUsageRecord[];
  costEntries: readonly CostLedgerEntry[];
  costRevisions: readonly RateCardRevision[];
  /** Trace-derived trace_id -> agent_id map; empty when trace is not wired. */
  agentByTraceId: ReadonlyMap<string, string>;
  costWired: boolean;
}

export interface BreakdownResult {
  status: "ok" | "empty" | "missing_source";
  rows: DashboardBreakdownRow[];
  truncated: boolean;
  omitted_keys: number;
}

interface Accumulator {
  records: InvocationUsageRecord[];
  entries: CostLedgerEntry[];
}

function ledgerKey(
  dimension: DashboardBreakdownDimension,
  record: InvocationUsageRecord,
  input: BreakdownInput,
): string | null {
  switch (dimension) {
    case "task":
      return record.issue_id;
    case "model":
      return record.returned_model ?? record.requested_model;
    case "agent":
      return input.agentByTraceId.get(record.trace_id) ?? "unattributed";
    case "date":
      return dateBucketKey(record.started_at, input.timezone, input.bucket);
  }
}

function postingKey(
  dimension: DashboardBreakdownDimension,
  entry: CostLedgerEntry,
  input: BreakdownInput,
  issueByInvocation: ReadonlyMap<string, string>,
  traceByInvocation: ReadonlyMap<string, string>,
): string | null {
  const posting = entry.posting;
  switch (dimension) {
    case "task": {
      if (posting.invocation_id === null) {
        return "unattributed";
      }
      return issueByInvocation.get(posting.invocation_id) ?? "unattributed";
    }
    case "model":
      return posting.model_id ?? "unattributed";
    case "agent": {
      if (posting.invocation_id === null) {
        return "unattributed";
      }
      const traceId = traceByInvocation.get(posting.invocation_id);
      if (traceId === undefined) {
        return "unattributed";
      }
      return input.agentByTraceId.get(traceId) ?? "unattributed";
    }
    case "date":
      return dateBucketKey(posting.applicable_time, input.timezone, input.bucket);
  }
}

function rowFor(
  key: string,
  accumulator: Accumulator,
  input: BreakdownInput,
): DashboardBreakdownRow {
  const totals = ledgerTotals({
    records: accumulator.records,
    status: accumulator.records.length === 0 ? "empty" : "ok",
  });
  const cost =
    input.costWired && accumulator.entries.length > 0
      ? costMetric(accumulator.entries, input.costRevisions).lines
      : input.costWired
        ? []
        : null;
  return {
    key,
    request_count: accumulator.records.length > 0 ? totals.requests : null,
    invocation_count: accumulator.records.length > 0 ? totals.invocations : null,
    retry_count: accumulator.records.length > 0 ? totals.retries : null,
    error_rate: accumulator.records.length > 0 ? totals.error_rate : null,
    tokens: accumulator.records.length > 0 ? totals.tokens : null,
    cost,
    latency_ms:
      accumulator.records.length > 0
        ? {
            p50_ms: totals.latency_ms.p50_ms,
            p95_ms: totals.latency_ms.p95_ms,
            sample_size: totals.latency_ms.sample_size,
          }
        : null,
  };
}

/**
 * One pass over the period's ledger and cost records, grouped by the requested
 * dimension. Distinct keys are capped; beyond the cap the aggregates stay
 * exact but the omitted keys are only counted.
 */
export function buildBreakdown(input: BreakdownInput): BreakdownResult {
  if (input.dimension === "agent" && input.agentByTraceId.size === 0) {
    return { status: MISSING_STATUS, rows: [], truncated: false, omitted_keys: 0 };
  }
  const groups = new Map<string, Accumulator>();
  let omitted = 0;

  const bucket = (key: string | null): Accumulator | null => {
    if (key === null) {
      return null;
    }
    const existing = groups.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (groups.size >= DASHBOARD_BREAKDOWN_MAX_DISTINCT_KEYS) {
      omitted += 1;
      return null;
    }
    const created: Accumulator = { records: [], entries: [] };
    groups.set(key, created);
    return created;
  };

  const issueByInvocation = new Map<string, string>();
  const traceByInvocation = new Map<string, string>();
  for (const record of input.records) {
    issueByInvocation.set(record.invocation_id, record.issue_id);
    traceByInvocation.set(record.invocation_id, record.trace_id);
    const key = ledgerKey(input.dimension, record, input);
    bucket(key)?.records.push(record);
  }
  for (const entry of input.costEntries) {
    const key = postingKey(input.dimension, entry, input, issueByInvocation, traceByInvocation);
    bucket(key)?.entries.push(entry);
  }

  const rows = [...groups.entries()].map(([key, accumulator]) => rowFor(key, accumulator, input));
  rows.sort((a, b) => {
    const left = a.request_count ?? 0;
    const right = b.request_count ?? 0;
    if (left !== right) {
      return right - left;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return {
    status: rows.length === 0 ? "empty" : "ok",
    rows,
    truncated: omitted > 0,
    omitted_keys: omitted,
  };
}
