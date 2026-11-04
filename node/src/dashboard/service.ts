/**
 * Workspace dashboard service (DAT-230).
 *
 * Reads only: it composes the authoritative domains (invocation ledger,
 * cost ledger, budget journal, trace, task events) into the ADR-0008
 * enterprise/workspace/task/agent/model/date views. It never writes to those
 * sources and never serves prompt content or quarantine material.
 *
 * Scope comes from the caller (the HTTP layer resolves it from the
 * authenticated session, never from the path or query). The domain stores
 * independently refuse a scope mismatch, so a substituted workspace fails
 * twice: at the request boundary and at the storage boundary.
 *
 * Role separation:
 * - Any role may read operational metrics.
 * - Financial metrics (cost, budget) are owner/admin only; other roles get
 *   `status: "restricted"` with null values, never a zero.
 * - The read/export audit trail is owner/admin only.
 *
 * Every successful read and export appends an audit entry. Audit append
 * happens on the answer's behalf only; an error response is audited by the
 * HTTP layer once the error code is known.
 */

import type { TaskRecord } from "../api/task-store.js";
import { ApiError } from "../api/errors.js";
import type { BudgetReservation, BudgetStore } from "../budget/index.js";
import type { CostLedgerEntry, CostStore, RateCardRevision } from "../cost/index.js";
import type { UsageLedgerStore, InvocationUsageRecord } from "../ledger/index.js";
import type { TraceStore } from "../trace/store.js";
import type { TraceEvent } from "../trace/schema.js";
import { projectTraceEvents } from "../trace/projection.js";
import { DashboardAuditLog } from "./audit.js";
import {
  MISSING_STATUS,
  approvalWaitSamplesMs,
  budgetMetric,
  buildBreakdown,
  costMetric,
  deliveryMetric,
  emptyTokenTotals,
  latencyFromSamples,
  ledgerTotals,
  missingBudgetMetric,
  missingCostMetric,
  missingLatency,
  missingTokenMetric,
  notMeasured,
  queueAgeSamplesMs,
  traceDecisionCounts,
  validationMetric,
} from "./aggregate.js";
import {
  decodeCursor,
  defaultPeriod,
  halfOpenPeriod,
  pageSlice,
  requireLimit,
  requireTimezone,
} from "./period.js";
import type {
  DashboardAccess,
  DashboardAuditOperation,
  DashboardAuditPage,
  DashboardAuditResource,
  DashboardBreakdown,
  DashboardBreakdownDimension,
  DashboardBudgetMetric,
  DashboardCostItem,
  DashboardCostItemPage,
  DashboardCostMetric,
  DashboardDateBucket,
  DashboardExportBundle,
  DashboardIssueDrilldown,
  DashboardLedgerEntryView,
  DashboardPeriod,
  DashboardSourceId,
  DashboardSourceState,
  DashboardSummary,
  DashboardTotals,
  DashboardTraceEvent,
  DashboardTraceView,
} from "./types.js";
import {
  DASHBOARD_AUDIT_LIMIT_DEFAULT,
  DASHBOARD_AUDIT_LIMIT_MAX,
  DASHBOARD_BREAKDOWN_DIMENSIONS,
  DASHBOARD_BREAKDOWN_LIMIT_DEFAULT,
  DASHBOARD_BREAKDOWN_LIMIT_MAX,
  DASHBOARD_COST_ITEMS_LIMIT_DEFAULT,
  DASHBOARD_COST_ITEMS_LIMIT_MAX,
  DASHBOARD_DATE_BUCKETS,
  DASHBOARD_DEFAULT_RANGE_HOURS,
  DASHBOARD_DEFAULT_TIMEZONE,
  DASHBOARD_EXPORT_MAX_ITEMS,
  DASHBOARD_MAX_RANGE_DAYS,
  DASHBOARD_REFERENCE_LIMIT,
  DASHBOARD_STALE_AFTER_SECONDS_DEFAULT,
  DASHBOARD_TRACE_LIMIT_DEFAULT,
  DASHBOARD_TRACE_LIMIT_MAX,
} from "./types.js";

export interface DashboardScope {
  enterprise_id: string;
  workspace_id: string;
  subject: string;
  role: string;
}

export interface DashboardSources {
  /** Invocation usage ledger (DAT-227). */
  ledger?: UsageLedgerStore;
  /** Priced cost ledger (DAT-228). */
  cost?: CostStore;
  /** Budget journal (DAT-229). */
  budget?: BudgetStore;
  /** Operational trace store (DAT-224, retention/access DAT-225). */
  trace?: TraceStore;
  /** Task projection/event log; the dashboard reads it and never mutates it. */
  tasks?: { list(): TaskRecord[] };
}

export interface DashboardServiceOptions {
  sources: DashboardSources;
  audit?: DashboardAuditLog;
  now?: () => Date;
}

/** Raw query strings from the HTTP layer; the service validates them. */
export interface DashboardQuery {
  from?: string;
  to?: string;
  timezone?: string;
  bucket?: string;
  breakdown?: string;
  limit?: string;
  cursor?: string;
  stale_after_seconds?: string;
  operation?: string;
  resource?: string;
}

interface ResolvedPeriod {
  period: DashboardPeriod;
  window: { from_ms: number; to_ms: number };
  until_inclusive: string;
  stale_after_seconds: number;
}

interface Snapshot {
  ledgerRecords: InvocationUsageRecord[];
  costEntries: CostLedgerEntry[];
  costRevisions: RateCardRevision[];
  budgetReservations: BudgetReservation[];
  traceEvents: TraceEvent[];
  tasks: TaskRecord[];
  taskEventsInWindow: Array<{ task: TaskRecord; event: TaskRecord["events"][number] }>;
}

const FINANCIAL_ROLES = new Set(["owner", "admin"]);

function isFinancial(scope: DashboardScope): boolean {
  return FINANCIAL_ROLES.has(scope.role);
}

function accessFor(scope: DashboardScope): DashboardAccess {
  return {
    financial: isFinancial(scope) ? "granted" : "restricted",
    content: "separate_authorization_required",
    quarantine: "separate_authorization_required",
  };
}

function restrictedCostMetric(): DashboardCostMetric {
  return {
    status: "restricted",
    source: "cost_ledger",
    lines: null,
    currencies: null,
    rate_revision_ids: null,
    completeness: null,
    updated_at: null,
  };
}

function restrictedBudgetMetric(): DashboardBudgetMetric {
  return {
    status: "restricted",
    source: "budget_journal",
    reservations: null,
    outstanding_bound: null,
    settled_known: null,
    settled_estimated: null,
    unknown_money_accounts: null,
    updated_at: null,
  };
}

function missingDelivery(): DashboardTotals["delivery_results"] {
  return {
    status: MISSING_STATUS,
    source: "trace",
    total: null,
    succeeded: null,
    failed: null,
    unknown: null,
  };
}

function missingValidation(): DashboardTotals["validation_outcomes"] {
  return {
    status: MISSING_STATUS,
    source: "task_events",
    total: null,
    passed: null,
    failed: null,
    unclassified: null,
  };
}

function missingRatio(source: DashboardSourceId): DashboardTotals["denial_rate"] {
  return {
    status: MISSING_STATUS,
    source,
    numerator: null,
    denominator: null,
    value: null,
  };
}

const DENOMINATORS: Record<string, string> = {
  requests: "all invocation-ledger attempts whose started_at is in [from, to)",
  invocations: "distinct invocation_id among the period's attempts",
  retries: "attempts minus distinct invocations; never below zero",
  retry_rate: "retries / invocations",
  error_rate:
    "attempts whose finish_status is error, transport_failed, unknown or aborted / all attempts",
  denial_rate:
    "trace events whose `outcome` label is an allow/deny decision (`allowed` or `denied`) with `denied` as the numerator; other outcome vocabulary is outside the denominator",
  tokens:
    "each reported token category; known and estimated sums stay separate and unknown figures are counted, never zero-filled",
  latency_ms: "attempts with parseable started_at and ended_at where end >= start",
  queue_age_ms:
    "tasks whose first transition out of `queued` occurred in [from, to); age = transition - task creation",
  approval_wait_ms:
    "approval.resolved events in [from, to) with a preceding approval.required on the same task",
  validation_outcomes: "validation.completed task events in [from, to)",
  delivery_results: "trace events of kind delivery.finished in [from, to)",
  cost: "sum of chargeable posting components grouped by currency and cost class; estimated amounts are never added to known",
  budget:
    "reservations created in [from, to); held and reconciling bounds stay committed, released bounds are refunded",
};

export class DashboardService {
  private readonly sources: DashboardSources;
  private readonly audit: DashboardAuditLog;
  private readonly now: () => Date;

  constructor(options: DashboardServiceOptions) {
    this.sources = options.sources;
    this.audit = options.audit ?? new DashboardAuditLog();
    this.now = options.now ?? (() => new Date());
  }

  /** Exposed for the composition root and tests. */
  get auditLog(): DashboardAuditLog {
    return this.audit;
  }

  summary(scope: DashboardScope, query: DashboardQuery, requestId: string): DashboardSummary {
    const period = this.resolvePeriod(query);
    const breakdownDimension = this.resolveDimension(query.breakdown);
    const page = this.resolvePage(
      query,
      DASHBOARD_BREAKDOWN_LIMIT_DEFAULT,
      DASHBOARD_BREAKDOWN_LIMIT_MAX,
    );
    const snapshot = this.snapshot(scope, period);
    const access = accessFor(scope);
    const totals = this.totalsFor(scope, period, snapshot, { issueScoped: false });
    const breakdown = this.breakdownFor(breakdownDimension, period, page, snapshot);
    const result: DashboardSummary = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      period: period.period,
      generated_at: this.now().toISOString(),
      access,
      sources: this.sourceStates(period, snapshot, !isFinancial(scope)),
      denominators: { ...DENOMINATORS },
      unavailable_metrics: this.unavailableMetrics(access),
      totals,
      breakdown,
    };
    this.audit.append({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
      role: scope.role,
      operation: "read",
      resource: "summary",
      issue_id: null,
      query: {
        from: period.period.from,
        to: period.period.to,
        timezone: period.period.timezone,
        bucket: period.period.bucket,
        breakdown: breakdownDimension,
        limit: page.limit,
      },
      record_count: snapshot.ledgerRecords.length + snapshot.costEntries.length,
      request_id: requestId,
    });
    return result;
  }

  costItems(
    scope: DashboardScope,
    query: DashboardQuery,
    requestId: string,
  ): DashboardCostItemPage {
    this.requireFinancial(scope, "cost items");
    const period = this.resolvePeriod(query);
    const page = this.resolvePage(
      query,
      DASHBOARD_COST_ITEMS_LIMIT_DEFAULT,
      DASHBOARD_COST_ITEMS_LIMIT_MAX,
    );
    const result = this.buildCostItems(scope, period, page);
    this.audit.append({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
      role: scope.role,
      operation: "read",
      resource: "cost_items",
      issue_id: null,
      query: {
        from: period.period.from,
        to: period.period.to,
        timezone: period.period.timezone,
        limit: page.limit,
      },
      record_count: result.total,
      request_id: requestId,
    });
    return result;
  }

  issueDrilldown(
    scope: DashboardScope,
    issueId: string,
    query: DashboardQuery,
    requestId: string,
  ): DashboardIssueDrilldown {
    const period = this.resolvePeriod(query);
    const page = this.resolvePage(query, DASHBOARD_TRACE_LIMIT_DEFAULT, DASHBOARD_TRACE_LIMIT_MAX);
    const full = this.snapshot(scope, period);
    const snapshot = this.scopeToIssue(full, issueId);
    const access = accessFor(scope);
    const totals = this.totalsFor(scope, period, snapshot, { issueScoped: true });
    const projected = projectTraceEvents(snapshot.traceEvents, {
      as_of: this.now().toISOString(),
    });
    const ordered = projected.events;
    const traceSlice = pageSlice(ordered, page.offset, page.limit);
    const traceView: DashboardTraceView =
      this.sources.trace === undefined
        ? {
            status: MISSING_STATUS,
            events: [],
            next_cursor: null,
            freshness: null,
            completeness: null,
          }
        : {
            status: ordered.length === 0 ? "empty" : "ok",
            events: traceSlice.items.map(toTraceEventView),
            next_cursor: traceSlice.next_cursor,
            freshness: {
              as_of: projected.freshness.as_of,
              event_time_watermark: projected.freshness.event_time_watermark,
            },
            completeness: {
              complete: projected.completeness.complete,
              missing_ranges: projected.completeness.missing.length,
              truncated_event_refs: projected.completeness.truncated_event_refs.length,
            },
          };
    const runs = new Map<
      string,
      {
        run_id: string;
        task_ids: Set<string>;
        event_count: number;
        first_event_at: string;
        last_event_at: string;
      }
    >();
    for (const event of snapshot.traceEvents) {
      if (event.run_id === null) {
        continue;
      }
      const existing = runs.get(event.run_id);
      if (existing === undefined) {
        runs.set(event.run_id, {
          run_id: event.run_id,
          task_ids: new Set(event.task_id === null ? [] : [event.task_id]),
          event_count: 1,
          first_event_at: event.event_time,
          last_event_at: event.event_time,
        });
        continue;
      }
      if (event.task_id !== null) {
        existing.task_ids.add(event.task_id);
      }
      existing.event_count += 1;
      if (Date.parse(event.event_time) < Date.parse(existing.first_event_at)) {
        existing.first_event_at = event.event_time;
      }
      if (Date.parse(event.event_time) > Date.parse(existing.last_event_at)) {
        existing.last_event_at = event.event_time;
      }
    }
    const references = collectReferences(snapshot.traceEvents);
    const result: DashboardIssueDrilldown = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      issue_id: issueId,
      period: period.period,
      generated_at: this.now().toISOString(),
      access,
      sources: this.sourceStates(
        period,
        snapshot,
        !isFinancial(scope),
        this.sources.trace === undefined,
      ),
      totals,
      runs: [...runs.values()]
        .map((run) => ({
          run_id: run.run_id,
          task_ids: [...run.task_ids].sort(),
          event_count: run.event_count,
          first_event_at: run.first_event_at,
          last_event_at: run.last_event_at,
        }))
        .sort((a, b) => (a.run_id < b.run_id ? -1 : 1)),
      trace: traceView,
      references,
      content: { access: "separate_authorization_required", payload_included: false },
    };
    this.audit.append({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
      role: scope.role,
      operation: "read",
      resource: "issue_drilldown",
      issue_id: issueId,
      query: {
        from: period.period.from,
        to: period.period.to,
        timezone: period.period.timezone,
        limit: page.limit,
      },
      record_count: snapshot.ledgerRecords.length + snapshot.traceEvents.length,
      request_id: requestId,
    });
    return result;
  }

  auditTrail(scope: DashboardScope, query: DashboardQuery, requestId: string): DashboardAuditPage {
    if (!isFinancial(scope)) {
      // The audit trail names employee activity and is restricted like
      // financial analytics; other roles cannot enumerate it.
      throw new ApiError(
        403,
        "AUDIT_ACCESS_DENIED",
        "reading the dashboard audit trail requires the owner or admin role",
      );
    }
    const operation = this.resolveAuditOperation(query.operation);
    const resource = this.resolveAuditResource(query.resource);
    const page = this.resolvePage(query, DASHBOARD_AUDIT_LIMIT_DEFAULT, DASHBOARD_AUDIT_LIMIT_MAX);
    const entries = this.audit.list(scope, {
      ...(operation !== undefined ? { operation } : {}),
      ...(resource !== undefined ? { resource } : {}),
    });
    const slice = pageSlice(entries, page.offset, page.limit);
    this.audit.append({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
      role: scope.role,
      operation: "read",
      resource: "audit",
      issue_id: null,
      query: {
        limit: page.limit,
        operation: operation ?? null,
        resource: resource ?? null,
      },
      record_count: slice.items.length,
      request_id: requestId,
    });
    return { items: slice.items, next_cursor: slice.next_cursor, total: entries.length };
  }

  exportBundle(
    scope: DashboardScope,
    query: DashboardQuery,
    requestId: string,
  ): DashboardExportBundle {
    this.requireFinancial(scope, "dashboard export");
    const period = this.resolvePeriod(query);
    const breakdownDimension = this.resolveDimension(query.breakdown);
    const exportPage = {
      limit: DASHBOARD_EXPORT_MAX_ITEMS,
      offset: 0,
    };
    const snapshot = this.snapshot(scope, period);
    const access = accessFor(scope);
    const totals = this.totalsFor(scope, period, snapshot, { issueScoped: false });
    const summary: DashboardSummary = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      period: period.period,
      generated_at: this.now().toISOString(),
      access,
      sources: this.sourceStates(period, snapshot, !isFinancial(scope)),
      denominators: { ...DENOMINATORS },
      unavailable_metrics: this.unavailableMetrics(access),
      totals,
      breakdown: this.breakdownFor(
        breakdownDimension,
        period,
        { limit: DASHBOARD_BREAKDOWN_LIMIT_MAX, offset: 0 },
        snapshot,
      ),
    };
    const costItems = this.buildCostItems(scope, period, exportPage);
    const result: DashboardExportBundle = {
      exported_at: this.now().toISOString(),
      summary,
      cost_items: costItems,
      cost_items_truncated: costItems.next_cursor !== null,
    };
    this.audit.append({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
      role: scope.role,
      operation: "export",
      resource: "export",
      issue_id: null,
      query: {
        from: period.period.from,
        to: period.period.to,
        timezone: period.period.timezone,
        breakdown: breakdownDimension,
        limit: DASHBOARD_EXPORT_MAX_ITEMS,
      },
      record_count: costItems.total,
      request_id: requestId,
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireFinancial(scope: DashboardScope, resource: string): void {
    if (!isFinancial(scope)) {
      throw new ApiError(
        403,
        "FINANCIAL_ACCESS_DENIED",
        `${resource} requires the owner or admin role`,
      );
    }
  }

  private resolvePeriod(query: DashboardQuery): ResolvedPeriod {
    const timezone = requireTimezone(query.timezone ?? DASHBOARD_DEFAULT_TIMEZONE);
    const bucket = (query.bucket ?? "day") as DashboardDateBucket;
    if (!DASHBOARD_DATE_BUCKETS.includes(bucket)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `bucket must be one of ${DASHBOARD_DATE_BUCKETS.join(", ")}`,
      );
    }
    let staleAfter = DASHBOARD_STALE_AFTER_SECONDS_DEFAULT;
    if (query.stale_after_seconds !== undefined) {
      if (!/^\d+$/.test(query.stale_after_seconds)) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "stale_after_seconds must be a non-negative integer",
        );
      }
      staleAfter = Number(query.stale_after_seconds);
    }
    const defaults = defaultPeriod(this.now(), DASHBOARD_DEFAULT_RANGE_HOURS);
    const from = query.from ?? defaults.from;
    const to = query.to ?? defaults.to;
    const window = halfOpenPeriod(from, to, DASHBOARD_MAX_RANGE_DAYS);
    return {
      period: { from, to, timezone, boundary: "half_open", bucket },
      window: { from_ms: window.from_ms, to_ms: window.to_ms },
      until_inclusive: window.until_inclusive,
      stale_after_seconds: staleAfter,
    };
  }

  private resolveDimension(value: string | undefined): DashboardBreakdownDimension {
    const dimension = (value ?? "model") as DashboardBreakdownDimension;
    if (!DASHBOARD_BREAKDOWN_DIMENSIONS.includes(dimension)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `breakdown must be one of ${DASHBOARD_BREAKDOWN_DIMENSIONS.join(", ")}`,
      );
    }
    return dimension;
  }

  private resolvePage(
    query: DashboardQuery,
    fallback: number,
    max: number,
  ): { limit: number; offset: number } {
    const limit = requireLimit(query.limit ?? null, fallback, max);
    const offset = decodeCursor(query.cursor ?? null);
    return { limit, offset };
  }

  private resolveAuditOperation(value: string | undefined): DashboardAuditOperation | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value !== "read" && value !== "export") {
      throw new ApiError(400, "INVALID_REQUEST", "operation must be read or export");
    }
    return value;
  }

  private resolveAuditResource(value: string | undefined): DashboardAuditResource | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (
      value !== "summary" &&
      value !== "cost_items" &&
      value !== "issue_drilldown" &&
      value !== "audit" &&
      value !== "export"
    ) {
      throw new ApiError(400, "INVALID_REQUEST", "resource is not a dashboard resource");
    }
    return value;
  }

  private snapshot(scope: DashboardScope, period: ResolvedPeriod): Snapshot {
    const access = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
    };
    const ledgerRecords =
      this.sources.ledger?.query(access, {
        since: period.period.from,
        until: period.until_inclusive,
      }) ?? [];
    const costEntries =
      this.sources.cost?.entries(access, {
        since: period.period.from,
        until: period.until_inclusive,
      }) ?? [];
    const costRevisions = this.sources.cost?.rateRevisions(access) ?? [];
    const budgetReservations =
      this.sources.budget?.list(access, {
        since: period.period.from,
        until: period.until_inclusive,
      }) ?? [];
    const traceEvents =
      this.sources.trace?.query(access, {
        since: period.period.from,
        until: period.until_inclusive,
      }) ?? [];
    const tasks = (this.sources.tasks?.list() ?? []).filter(
      (task) =>
        task.workspaceId === scope.workspace_id && task.enterpriseId === scope.enterprise_id,
    );
    const taskEventsInWindow: Snapshot["taskEventsInWindow"] = [];
    for (const task of tasks) {
      for (const event of task.events) {
        const at = Date.parse(event.occurred_at);
        if (!Number.isNaN(at) && at >= period.window.from_ms && at < period.window.to_ms) {
          taskEventsInWindow.push({ task, event });
        }
      }
    }
    return {
      ledgerRecords,
      costEntries,
      costRevisions,
      budgetReservations,
      traceEvents,
      tasks,
      taskEventsInWindow,
    };
  }

  /** Restrict a workspace snapshot to one issue (cost via its ledger join). */
  private scopeToIssue(full: Snapshot, issueId: string): Snapshot {
    const ledgerRecords = full.ledgerRecords.filter((record) => record.issue_id === issueId);
    const invocationIds = new Set(ledgerRecords.map((record) => record.invocation_id));
    const costEntries = full.costEntries.filter(
      (entry) =>
        entry.posting.invocation_id !== null && invocationIds.has(entry.posting.invocation_id),
    );
    const budgetReservations = full.budgetReservations.filter(
      (reservation) => reservation.identity.issue_id === issueId,
    );
    const traceEvents = full.traceEvents.filter((event) => event.issue_id === issueId);
    const taskIds = new Set<string>();
    for (const event of traceEvents) {
      if (event.task_id !== null) {
        taskIds.add(event.task_id);
      }
    }
    const tasks = full.tasks.filter((task) => taskIds.has(task.id));
    const taskEventsInWindow = full.taskEventsInWindow.filter(({ task }) => taskIds.has(task.id));
    return {
      ledgerRecords,
      costEntries,
      costRevisions: full.costRevisions,
      budgetReservations,
      traceEvents,
      tasks,
      taskEventsInWindow,
    };
  }

  private totalsFor(
    scope: DashboardScope,
    period: ResolvedPeriod,
    snapshot: Snapshot,
    options: { issueScoped: boolean },
  ): DashboardTotals {
    const ledgerWired = this.sources.ledger !== undefined;
    const ledgerStatus = snapshot.ledgerRecords.length === 0 ? "empty" : "ok";
    const ledger = ledgerTotals({
      records: snapshot.ledgerRecords,
      status: ledgerStatus,
    });

    const traceWired = this.sources.trace !== undefined;
    const tasksWired = this.sources.tasks !== undefined;
    // At workspace level the task projection is already scoped, so its events
    // are usable on their own. An issue drilldown can only attribute a task
    // through trace task identity; without the trace those metrics are not
    // measured for that issue, never a fabricated zero.
    const tasksCorrelated = tasksWired && (!options.issueScoped || traceWired);

    const denial = traceDecisionCounts(snapshot.traceEvents);
    const delivery = deliveryMetric(snapshot.traceEvents);
    const queueSamples = tasksCorrelated ? queueAgeSamplesMs(snapshot.tasks, period.window) : [];
    const approvalSamples = tasksCorrelated
      ? approvalWaitSamplesMs(snapshot.tasks, period.window)
      : [];
    const validation = tasksCorrelated
      ? validationMetric(snapshot.tasks, period.window)
      : missingValidation();

    const costAllowed = isFinancial(scope);
    const cost = !costAllowed
      ? restrictedCostMetric()
      : this.sources.cost === undefined
        ? missingCostMetric()
        : costMetric(snapshot.costEntries, snapshot.costRevisions);
    const budget = !costAllowed
      ? restrictedBudgetMetric()
      : this.sources.budget === undefined
        ? missingBudgetMetric()
        : budgetMetric(snapshot.budgetReservations);

    return {
      requests: {
        status: ledgerWired ? ledgerStatus : MISSING_STATUS,
        source: "invocation_ledger",
        value: ledgerWired ? ledger.requests : null,
      },
      invocations: {
        status: ledgerWired ? ledgerStatus : MISSING_STATUS,
        source: "invocation_ledger",
        value: ledgerWired ? ledger.invocations : null,
      },
      retries: {
        status: ledgerWired ? ledgerStatus : MISSING_STATUS,
        source: "invocation_ledger",
        value: ledgerWired ? ledger.retries : null,
      },
      retry_rate: {
        status: ledgerWired ? ledgerStatus : MISSING_STATUS,
        source: "invocation_ledger",
        numerator: ledgerWired ? ledger.retries : null,
        denominator: ledgerWired ? ledger.invocations : null,
        value: ledgerWired ? ledger.retry_rate : null,
      },
      error_rate: {
        status: ledgerWired ? ledgerStatus : MISSING_STATUS,
        source: "invocation_ledger",
        numerator: ledgerWired ? ledger.error_attempts : null,
        denominator: ledgerWired ? ledger.requests : null,
        value: ledgerWired ? ledger.error_rate : null,
      },
      denial_rate: traceWired
        ? {
            status: denial.decisions === 0 ? "empty" : "ok",
            source: "trace",
            numerator: denial.denials,
            denominator: denial.decisions,
            value: denial.rate,
          }
        : missingRatio("trace"),
      tokens: ledgerWired
        ? {
            status: ledgerStatus,
            source: "invocation_ledger",
            figures: ledgerStatus === "empty" ? emptyTokenTotals() : ledger.tokens,
          }
        : missingTokenMetric("invocation_ledger"),
      latency_ms: ledgerWired ? ledger.latency_ms : missingLatency("invocation_ledger"),
      queue_age_ms: tasksCorrelated
        ? latencyFromSamples("task_events", queueSamples)
        : missingLatency("task_events"),
      approval_wait_ms: tasksCorrelated
        ? latencyFromSamples("task_events", approvalSamples)
        : missingLatency("task_events"),
      validation_outcomes: validation,
      delivery_results: traceWired ? delivery : missingDelivery(),
      connector_lag_ms: notMeasured(
        "no connector-lag telemetry source is wired into this deployment",
      ),
      worker_utilization: notMeasured(
        "no worker-utilization telemetry source is wired into this deployment",
      ),
      cost,
      budget,
    };
  }

  private breakdownFor(
    dimension: DashboardBreakdownDimension,
    period: ResolvedPeriod,
    page: { limit: number; offset: number },
    snapshot: Snapshot,
  ): DashboardBreakdown {
    const agentByTraceId = new Map<string, string>();
    for (const event of snapshot.traceEvents) {
      if (event.agent_id !== null && !agentByTraceId.has(event.trace_id)) {
        agentByTraceId.set(event.trace_id, event.agent_id);
      }
    }
    const result = buildBreakdown({
      dimension,
      timezone: period.period.timezone,
      bucket: period.period.bucket,
      records: snapshot.ledgerRecords,
      costEntries: snapshot.costEntries,
      costRevisions: snapshot.costRevisions,
      agentByTraceId,
      costWired: this.sources.cost !== undefined,
    });
    if (result.status === MISSING_STATUS) {
      return {
        dimension,
        status: MISSING_STATUS,
        rows: [],
        next_cursor: null,
        truncated: false,
        omitted_keys: 0,
      };
    }
    const slice = pageSlice(result.rows, page.offset, page.limit);
    return {
      dimension,
      status: result.status,
      rows: slice.items,
      next_cursor: slice.next_cursor,
      truncated: result.truncated,
      omitted_keys: result.omitted_keys,
    };
  }

  private buildCostItems(
    scope: DashboardScope,
    period: ResolvedPeriod,
    page: { limit: number; offset: number },
  ): DashboardCostItemPage {
    const access = {
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
    };
    const entries =
      this.sources.cost?.entries(access, {
        since: period.period.from,
        until: period.until_inclusive,
      }) ?? [];
    const ledgerRecords =
      this.sources.ledger?.query(access, {
        since: period.period.from,
        until: period.until_inclusive,
      }) ?? [];
    const ledgerByKey = new Map<string, InvocationUsageRecord>();
    for (const record of ledgerRecords) {
      ledgerByKey.set(`${record.invocation_id}\u0000${record.attempt}`, record);
    }
    const ordered = [...entries].sort((a, b) => {
      const byTime = Date.parse(b.posting.applicable_time) - Date.parse(a.posting.applicable_time);
      if (byTime !== 0) {
        return byTime;
      }
      return a.posting.posting_id < b.posting.posting_id ? -1 : 1;
    });
    const slice = pageSlice(ordered, page.offset, page.limit);
    const items = slice.items.map((entry) =>
      toCostItem(entry, ledgerByKey, this.sources.ledger !== undefined, scope.workspace_id),
    );
    return {
      period: period.period,
      generated_at: this.now().toISOString(),
      access: accessFor(scope),
      ledger_lookup: this.sources.ledger !== undefined ? "ok" : "missing_source",
      items,
      next_cursor: slice.next_cursor,
      total: ordered.length,
    };
  }

  private sourceStates(
    period: ResolvedPeriod,
    snapshot: Snapshot,
    financialRestricted = false,
    traceUncorrelated = false,
  ): DashboardSourceState[] {
    const staleAfter = period.stale_after_seconds;
    const staleBefore = period.window.to_ms - staleAfter * 1000;
    const states: DashboardSourceState[] = [];
    const restricted = (source: DashboardSourceId): DashboardSourceState => ({
      source,
      status: "restricted",
      watermark: null,
      record_count: null,
      stale_after_seconds: staleAfter,
      note: "financial access requires the owner or admin role",
    });
    const state = (
      source: DashboardSourceId,
      wired: boolean,
      stamps: readonly string[],
      note: string | null = null,
    ): DashboardSourceState => {
      if (!wired) {
        return {
          source,
          status: "missing",
          watermark: null,
          record_count: null,
          stale_after_seconds: staleAfter,
          note: note ?? `${source} is not wired into this deployment`,
        };
      }
      if (stamps.length === 0) {
        return {
          source,
          status: "empty",
          watermark: null,
          record_count: 0,
          stale_after_seconds: staleAfter,
          note,
        };
      }
      let newest: string | null = null;
      for (const stamp of stamps) {
        if (newest === null || Date.parse(stamp) > Date.parse(newest)) {
          newest = stamp;
        }
      }
      const status: DashboardSourceState["status"] =
        newest !== null && Date.parse(newest) < staleBefore ? "stale" : "ok";
      return {
        source,
        status,
        watermark: newest,
        record_count: stamps.length,
        stale_after_seconds: staleAfter,
        note:
          status === "stale"
            ? `newest record is older than ${staleAfter}s before the period end`
            : note,
      };
    };

    states.push(
      state(
        "invocation_ledger",
        this.sources.ledger !== undefined,
        snapshot.ledgerRecords.map((record) => record.started_at),
      ),
    );
    states.push(
      financialRestricted
        ? restricted("cost_ledger")
        : state(
            "cost_ledger",
            this.sources.cost !== undefined,
            snapshot.costEntries.map((entry) => entry.posting.recorded_at),
          ),
    );
    states.push(
      financialRestricted
        ? restricted("budget_journal")
        : state(
            "budget_journal",
            this.sources.budget !== undefined,
            snapshot.budgetReservations.map((reservation) => reservation.updated_at),
          ),
    );
    states.push(
      state(
        "trace",
        this.sources.trace !== undefined,
        snapshot.traceEvents.map((event) => event.event_time),
      ),
    );
    states.push(
      traceUncorrelated
        ? {
            source: "task_events",
            status: "missing",
            watermark: null,
            record_count: null,
            stale_after_seconds: staleAfter,
            note: "task events cannot be correlated to an issue without trace task identity",
          }
        : state(
            "task_events",
            this.sources.tasks !== undefined,
            snapshot.taskEventsInWindow.map(({ event }) => event.occurred_at),
          ),
    );
    return states;
  }

  private unavailableMetrics(access: DashboardAccess): Array<{ metric: string; reason: string }> {
    const out: Array<{ metric: string; reason: string }> = [
      {
        metric: "connector_lag_ms",
        reason: "no connector-lag telemetry source is wired into this deployment",
      },
      {
        metric: "worker_utilization",
        reason: "no worker-utilization telemetry source is wired into this deployment",
      },
    ];
    if (access.financial === "restricted") {
      out.push(
        { metric: "cost", reason: "financial access requires the owner or admin role" },
        { metric: "budget", reason: "financial access requires the owner or admin role" },
      );
    }
    if (this.sources.ledger === undefined) {
      for (const metric of [
        "requests",
        "invocations",
        "retries",
        "retry_rate",
        "error_rate",
        "tokens",
        "latency_ms",
      ]) {
        out.push({ metric, reason: "invocation ledger is not wired" });
      }
    }
    if (this.sources.trace === undefined) {
      out.push(
        { metric: "denial_rate", reason: "trace store is not wired" },
        { metric: "delivery_results", reason: "trace store is not wired" },
      );
    }
    if (this.sources.tasks === undefined) {
      for (const metric of ["queue_age_ms", "approval_wait_ms", "validation_outcomes"]) {
        out.push({ metric, reason: "task event source is not wired" });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function toTraceEventView(event: TraceEvent & { late: boolean }): DashboardTraceEvent {
  return {
    source: event.source,
    event_id: event.event_id,
    version: event.version,
    sequence: event.sequence,
    event_time: event.event_time,
    ingest_time: event.ingest_time,
    record_class: event.record_class,
    kind: event.kind,
    issue_id: event.issue_id,
    task_id: event.task_id,
    run_id: event.run_id,
    attempt_id: event.attempt_id,
    agent_id: event.agent_id,
    agent_config_revision: event.agent_config_revision,
    invocation_id: event.invocation_id,
    tool_id: event.tool_id,
    artifact_id: event.artifact_id,
    delivery_id: event.delivery_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: event.parent_span_id,
    causation_id: event.causation_id,
    evidence_refs: [...event.evidence_refs],
    labels: { ...event.labels },
    truncated: event.truncated,
    late: event.late,
  };
}

function collectReferences(events: readonly TraceEvent[]): DashboardIssueDrilldown["references"] {
  const artifactIds = new Set<string>();
  const deliveryIds = new Set<string>();
  const evidenceRefs = new Set<string>();
  const taskIds = new Set<string>();
  let truncated = false;
  const push = (target: Set<string>, value: string): void => {
    if (target.size >= DASHBOARD_REFERENCE_LIMIT) {
      truncated = true;
      return;
    }
    target.add(value);
  };
  for (const event of events) {
    if (event.artifact_id !== null) {
      push(artifactIds, event.artifact_id);
    }
    if (event.delivery_id !== null) {
      push(deliveryIds, event.delivery_id);
    }
    if (event.task_id !== null) {
      push(taskIds, event.task_id);
    }
    for (const ref of event.evidence_refs) {
      push(evidenceRefs, ref);
    }
  }
  return {
    artifact_ids: [...artifactIds].sort(),
    delivery_ids: [...deliveryIds].sort(),
    evidence_refs: [...evidenceRefs].sort(),
    task_ids: [...taskIds].sort(),
    truncated,
  };
}

function toCostItem(
  entry: CostLedgerEntry,
  ledgerByKey: ReadonlyMap<string, InvocationUsageRecord>,
  ledgerWired: boolean,
  workspaceId: string,
): DashboardCostItem {
  const posting = entry.posting;
  let ledgerEntry: DashboardLedgerEntryView | null = null;
  let ledgerLookup: DashboardCostItem["ledger_lookup"];
  if (posting.kind === "infrastructure" || posting.invocation_id === null) {
    ledgerLookup = "infrastructure";
  } else if (!ledgerWired) {
    ledgerLookup = "missing_source";
  } else {
    const record = ledgerByKey.get(`${posting.invocation_id}\u0000${posting.attempt ?? 0}`);
    if (record === undefined) {
      ledgerLookup = "not_found";
    } else {
      ledgerLookup = "ok";
      ledgerEntry = {
        invocation_id: record.invocation_id,
        attempt: record.attempt,
        issue_id: record.issue_id,
        run_id: record.run_id,
        trace_id: record.trace_id,
        provider: record.provider,
        api: record.api,
        requested_model: record.requested_model,
        returned_model: record.returned_model,
        provider_request_id: record.provider_request_id,
        started_at: record.started_at,
        ended_at: record.ended_at,
        finish_status: record.finish_status,
        usage_completeness: record.usage.completeness,
        usage_provenance: record.usage.provenance,
        issue_drilldown_url:
          record.issue_id.length > 0
            ? `/api/v1/workspaces/${workspaceId}/dashboard/issues/${encodeURIComponent(record.issue_id)}`
            : null,
      };
    }
  }
  return {
    posting_id: posting.posting_id,
    kind: posting.kind,
    invocation_id: posting.invocation_id,
    attempt: posting.attempt,
    endpoint_id: posting.endpoint_id,
    model_id: posting.model_id,
    requested_model: posting.requested_model,
    returned_model: posting.returned_model,
    target: posting.target,
    applicable_time: posting.applicable_time,
    currency: posting.currency,
    completeness: posting.completeness,
    components: posting.components.map((component) => ({
      category: component.category,
      chargeable: component.chargeable,
      included_in: component.included_in,
      chargeable_units: component.chargeable_units,
      unit: component.unit,
      cost_class: component.cost_class,
      currency: component.currency,
      rate_revision_id: component.rate_revision_id,
      rate: component.rate,
      divisor: component.divisor,
      cost: component.cost,
      completeness: component.completeness,
      unknown_reason: component.unknown_reason,
    })),
    adjustments: entry.adjustments.map((adjustment) => ({
      adjustment_id: adjustment.adjustment_id,
      target_posting_id: adjustment.target_posting_id,
      reason: adjustment.reason,
      source: adjustment.source,
      created_at: adjustment.created_at,
      note: adjustment.note,
      components: adjustment.components.map((component) => ({
        category: component.category,
        completeness: component.completeness,
        corrected_units: component.corrected_units,
        corrected_rate_revision_id: component.corrected_rate_revision_id,
        corrected_cost: component.corrected_cost,
        corrected_currency: component.corrected_currency,
        note: component.note,
      })),
    })),
    ledger_entry: ledgerEntry,
    ledger_lookup: ledgerLookup,
    recorded_at: posting.recorded_at,
  };
}
