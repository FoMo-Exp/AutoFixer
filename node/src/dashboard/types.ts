/**
 * Workspace dashboard contract (DAT-230, ADR-0008 "Dashboards, access, and
 * operational signals").
 *
 * The dashboard is a read-only projection over four already-authoritative
 * sources plus the task event log. It never writes to them, never rewrites
 * dsh evidence, and never invents a figure those sources did not report:
 *
 * - `invocation_ledger` (DAT-227) is the request/token/latency authority.
 * - `cost_ledger` (DAT-228) is the priced-cost authority; currencies and cost
 *   classes stay separated and keep their bound rate revisions.
 * - `budget_journal` (DAT-229) is the reservation/settlement authority.
 * - `trace` (DAT-224/225) is the operational-event authority for denials,
 *   delivery results, and issue drill-down.
 * - `task_events` is the queue/approval/validation authority.
 *
 * Honesty rules encoded in the types below:
 *
 * - A metric from a source that is not wired is `null` with
 *   `status: "missing_source"`; a wired source with no rows in the period is
 *   `status: "empty"` and a real zero. The two states are never conflated.
 * - `not_measured` means no source for the metric exists at all (connector lag,
 *   worker utilization); it is also never zero.
 * - `restricted` means the caller's role may not see the section; the value is
 *   `null`, not a redacted zero.
 * - Every denominator is published in `denominators`, so a rate always says
 *   what it is a rate of. Periods are half-open `[from, to)` in `timezone`.
 */

/** Metric availability. `value` is null unless the status is `ok` or `empty`. */
export const DASHBOARD_METRIC_STATUSES = [
  "ok",
  "empty",
  "missing_source",
  "not_measured",
  "restricted",
] as const;

export type DashboardMetricStatus = (typeof DASHBOARD_METRIC_STATUSES)[number];

/** The sources a dashboard response can be built from. */
export const DASHBOARD_SOURCE_IDS = [
  "invocation_ledger",
  "cost_ledger",
  "budget_journal",
  "trace",
  "task_events",
] as const;

export type DashboardSourceId = (typeof DASHBOARD_SOURCE_IDS)[number];

/**
 * Health of one source over the requested period. `restricted` keeps even the
 * record count and watermark of a financial source away from a role that may
 * not read it.
 */
export const DASHBOARD_SOURCE_STATUSES = ["ok", "empty", "stale", "missing", "restricted"] as const;

export type DashboardSourceStatus = (typeof DASHBOARD_SOURCE_STATUSES)[number];

/** Breakdown dimensions from ADR-0008: enterprise/workspace are the scope
 * itself, so only the lower-cardinality projections are queryable. */
export const DASHBOARD_BREAKDOWN_DIMENSIONS = ["task", "agent", "model", "date"] as const;

export type DashboardBreakdownDimension = (typeof DASHBOARD_BREAKDOWN_DIMENSIONS)[number];

/** Time buckets for `breakdown=date`; the bucket is interpreted in `timezone`. */
export const DASHBOARD_DATE_BUCKETS = ["hour", "day", "week", "month"] as const;

export type DashboardDateBucket = (typeof DASHBOARD_DATE_BUCKETS)[number];

/** Audit operation classes: reads and exports are audited separately. */
export const DASHBOARD_AUDIT_OPERATIONS = ["read", "export"] as const;

export type DashboardAuditOperation = (typeof DASHBOARD_AUDIT_OPERATIONS)[number];

/** Resources the audit trail can name. */
export const DASHBOARD_AUDIT_RESOURCES = [
  "summary",
  "cost_items",
  "issue_drilldown",
  "audit",
  "export",
] as const;

export type DashboardAuditResource = (typeof DASHBOARD_AUDIT_RESOURCES)[number];

// ---------------------------------------------------------------------------
// Bounds. Every query is range-capped and page-capped so one request cannot
// enumerate an unbounded workspace or fan out into a high-cardinality scan.
// ---------------------------------------------------------------------------

export const DASHBOARD_MAX_RANGE_DAYS = 366;
export const DASHBOARD_DEFAULT_RANGE_HOURS = 24;
export const DASHBOARD_DEFAULT_TIMEZONE = "UTC";
export const DASHBOARD_STALE_AFTER_SECONDS_DEFAULT = 3600;

export const DASHBOARD_BREAKDOWN_LIMIT_DEFAULT = 50;
export const DASHBOARD_BREAKDOWN_LIMIT_MAX = 200;
export const DASHBOARD_BREAKDOWN_MAX_DISTINCT_KEYS = 5000;

export const DASHBOARD_COST_ITEMS_LIMIT_DEFAULT = 50;
export const DASHBOARD_COST_ITEMS_LIMIT_MAX = 200;

export const DASHBOARD_TRACE_LIMIT_DEFAULT = 100;
export const DASHBOARD_TRACE_LIMIT_MAX = 500;

export const DASHBOARD_AUDIT_LIMIT_DEFAULT = 50;
export const DASHBOARD_AUDIT_LIMIT_MAX = 200;

export const DASHBOARD_EXPORT_MAX_ITEMS = 1000;

/** Maximum number of references a drill-down lists; the rest are counted. */
export const DASHBOARD_REFERENCE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Request parameters (already validated by the HTTP layer)
// ---------------------------------------------------------------------------

export interface DashboardPeriodInput {
  from: string;
  to: string;
  timezone: string;
  bucket: DashboardDateBucket;
  stale_after_seconds: number;
}

export interface DashboardPageInput {
  limit: number;
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Source health and access
// ---------------------------------------------------------------------------

export interface DashboardSourceState {
  source: DashboardSourceId;
  status: DashboardSourceStatus;
  /** Newest observed timestamp across the source's records in the period. */
  watermark: string | null;
  /** Rows read from the source inside the period; null when not wired. */
  record_count: number | null;
  stale_after_seconds: number;
  /** Provider rationale for `missing`/`stale`; null otherwise. */
  note: string | null;
}

export interface DashboardAccess {
  /** Financial metrics are granted to owner/admin only. */
  financial: "granted" | "restricted";
  /** The dashboard never serves captured model content. */
  content: "separate_authorization_required";
  /** The dashboard never serves ADR-0005 quarantine material. */
  quarantine: "separate_authorization_required";
}

export interface DashboardPeriod {
  /** RFC 3339, inclusive lower bound. */
  from: string;
  /** RFC 3339, exclusive upper bound. */
  to: string;
  /** IANA timezone used for date bucketing and calendar boundaries. */
  timezone: string;
  boundary: "half_open";
  bucket: DashboardDateBucket;
}

// ---------------------------------------------------------------------------
// Metric shapes
// ---------------------------------------------------------------------------

export interface DashboardCountMetric {
  status: DashboardMetricStatus;
  source: DashboardSourceId | null;
  /** Null unless measured; a measured empty period is a real 0. */
  value: number | null;
}

export interface DashboardRatioMetric {
  status: DashboardMetricStatus;
  source: DashboardSourceId | null;
  numerator: number | null;
  denominator: number | null;
  /** numerator / denominator with 6 decimal places; null when unmeasured or
   * when the denominator is 0. */
  value: number | null;
}

export interface DashboardLatencyMetric {
  status: DashboardMetricStatus;
  source: DashboardSourceId | null;
  /** Nearest-rank percentiles from observed samples. */
  p50_ms: number | null;
  p95_ms: number | null;
  sample_size: number | null;
}

export interface DashboardNotMeasuredMetric {
  status: "not_measured";
  source: null;
  value: null;
  note: string;
}

export interface FigureTotals {
  /** Sum of figures the source reported as known. */
  known_tokens: number;
  /** Sum of figures the source reported as estimated — provisional, never a
   * reconciled amount. */
  estimated_tokens: number;
  /** Attempts whose figure was absent/unknown; they contribute to no sum. */
  unknown_attempts: number;
}

export interface TokenTotals {
  input: FigureTotals;
  output: FigureTotals;
  cache_read: FigureTotals;
  cache_write: FigureTotals;
  reasoning: FigureTotals;
  /**
   * Record-level `total_tokens` where the provider reported one. Figures are
   * added only to their own completeness bucket; unknown records are counted,
   * never zero-filled.
   */
  total_tokens: FigureTotals;
}

export interface DashboardTokenMetric {
  status: DashboardMetricStatus;
  source: DashboardSourceId | null;
  figures: TokenTotals | null;
}

export interface DashboardCostCompleteness {
  known: number;
  estimated: number;
  unknown: number;
}

export interface DashboardCostMetric {
  status: DashboardMetricStatus;
  source: "cost_ledger";
  /** Per (currency, cost class) totals; never merged across currencies. */
  lines: DashboardCostLine[] | null;
  /** Every currency present in the period. */
  currencies: string[] | null;
  /** Rate revisions bound by the period's postings (bounded, sorted). */
  rate_revision_ids: string[] | null;
  /** Posting-level completeness counts. */
  completeness: DashboardCostCompleteness | null;
  /** Newest posting/rate-revision timestamp in the period. */
  updated_at: string | null;
}

/** Mirrors `CostClassTotals` from the cost domain (DAT-228). */
export interface DashboardCostLine {
  currency: string | null;
  cost_class: "provider_tokens" | "self_hosted_tokens" | "infrastructure";
  /** Canonical fixed-precision decimal. */
  known_cost: string;
  /** Provisional; never presented as a billed amount. */
  estimated_cost: string;
  unknown_components: number;
  components: number;
  postings: number;
}

export interface DashboardCurrencyAmount {
  currency: string;
  /** Canonical fixed-precision decimal. */
  amount: string;
}

export interface DashboardBudgetMetric {
  status: DashboardMetricStatus;
  source: "budget_journal";
  reservations: Record<"held" | "settled" | "reconciling" | "released", number> | null;
  /** Still-committed bounds per currency (held + reconciling). */
  outstanding_bound: DashboardCurrencyAmount[] | null;
  /** Settled amounts per currency, known and estimated kept apart. */
  settled_known: DashboardCurrencyAmount[] | null;
  settled_estimated: DashboardCurrencyAmount[] | null;
  /** Monetary accounts whose usage is still unknown (bound retained). */
  unknown_money_accounts: number | null;
  updated_at: string | null;
}

export interface DashboardValidationMetric {
  status: DashboardMetricStatus;
  source: "task_events";
  total: number | null;
  passed: number | null;
  failed: number | null;
  /** Events without a boolean `passed` field; never guessed. */
  unclassified: number | null;
}

export interface DashboardDeliveryMetric {
  status: DashboardMetricStatus;
  source: "trace";
  total: number | null;
  succeeded: number | null;
  failed: number | null;
  unknown: number | null;
}

export interface DashboardTotals {
  /** All invocation attempts in the period, including failures and retries. */
  requests: DashboardCountMetric;
  /** Distinct `invocation_id` values. */
  invocations: DashboardCountMetric;
  /** Attempts beyond the first for their invocation. */
  retries: DashboardCountMetric;
  /** retries / invocations. */
  retry_rate: DashboardRatioMetric;
  /** Attempts whose finish_status is error, transport_failed, unknown or
   * aborted, over all attempts. */
  error_rate: DashboardRatioMetric;
  /** Trace decisions with outcome `denied` over all trace decisions with an
   * `outcome` label. */
  denial_rate: DashboardRatioMetric;
  tokens: DashboardTokenMetric;
  latency_ms: DashboardLatencyMetric;
  /** Time from task creation to the first transition out of `queued`. */
  queue_age_ms: DashboardLatencyMetric;
  /** Time from `approval.required` to the next `approval.resolved`. */
  approval_wait_ms: DashboardLatencyMetric;
  validation_outcomes: DashboardValidationMetric;
  delivery_results: DashboardDeliveryMetric;
  /** Not measured: no connector-lag telemetry is wired into this deployment. */
  connector_lag_ms: DashboardNotMeasuredMetric;
  /** Not measured: no worker-utilization telemetry is wired into this
   * deployment. */
  worker_utilization: DashboardNotMeasuredMetric;
  cost: DashboardCostMetric;
  budget: DashboardBudgetMetric;
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

export interface DashboardBreakdownRow {
  /** The dimension value (issue id, agent id, model id, or bucket start). */
  key: string;
  request_count: number | null;
  invocation_count: number | null;
  retry_count: number | null;
  error_rate: number | null;
  tokens: TokenTotals | null;
  cost: DashboardCostLine[] | null;
  latency_ms: { p50_ms: number | null; p95_ms: number | null; sample_size: number | null } | null;
}

export interface DashboardBreakdown {
  dimension: DashboardBreakdownDimension;
  /** `missing_source` when the dimension needs a source that is not wired. */
  status: DashboardMetricStatus;
  /** Explicit tag for the token figures in the rows (`null` when absent). */
  rows: DashboardBreakdownRow[];
  next_cursor: string | null;
  /** True when distinct keys exceeded the scan cap; aggregates stay exact,
   * but the omitted keys are not listed. */
  truncated: boolean;
  omitted_keys: number;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  enterprise_id: string;
  workspace_id: string;
  period: DashboardPeriod;
  generated_at: string;
  access: DashboardAccess;
  sources: DashboardSourceState[];
  /** Metric name -> exact denominator definition. */
  denominators: Record<string, string>;
  /** Metrics that are structurally unavailable, with the reason. */
  unavailable_metrics: Array<{ metric: string; reason: string }>;
  totals: DashboardTotals;
  breakdown: DashboardBreakdown;
}

// ---------------------------------------------------------------------------
// Cost items and their ledger drill-down
// ---------------------------------------------------------------------------

export interface DashboardLedgerEntryView {
  invocation_id: string;
  attempt: number;
  issue_id: string;
  run_id: string;
  trace_id: string;
  provider: string;
  api: string;
  requested_model: string;
  returned_model: string | null;
  provider_request_id: string | null;
  started_at: string;
  ended_at: string;
  finish_status: string;
  usage_completeness: string;
  usage_provenance: string;
  /** Where the drill-down can be read; no content is served by this surface. */
  issue_drilldown_url: string | null;
}

export interface DashboardCostItem {
  posting_id: string;
  kind: "invocation" | "infrastructure";
  invocation_id: string | null;
  attempt: number | null;
  endpoint_id: string | null;
  model_id: string | null;
  requested_model: string | null;
  returned_model: string | null;
  target: string;
  applicable_time: string;
  currency: string | null;
  completeness: string;
  components: Array<{
    category: string;
    chargeable: boolean;
    included_in: string | null;
    chargeable_units: number | null;
    unit: string;
    cost_class: string;
    currency: string | null;
    rate_revision_id: string | null;
    rate: string | null;
    divisor: number | null;
    cost: string | null;
    completeness: string;
    unknown_reason: string | null;
  }>;
  adjustments: Array<{
    adjustment_id: string;
    target_posting_id: string;
    reason: string;
    source: string;
    created_at: string;
    note: string | null;
    components: Array<{
      category: string;
      completeness: string;
      corrected_units: number | null;
      corrected_rate_revision_id: string | null;
      corrected_cost: string | null;
      corrected_currency: string | null;
      note: string | null;
    }>;
  }>;
  /** The invocation ledger entry this posting prices; null when the posting is
   * infrastructure or the ledger is not wired. */
  ledger_entry: DashboardLedgerEntryView | null;
  /** Why `ledger_entry` is absent: `not_found`, `missing_source`, or
   * `infrastructure`. */
  ledger_lookup: "ok" | "not_found" | "missing_source" | "infrastructure";
  recorded_at: string;
}

export interface DashboardCostItemPage {
  period: DashboardPeriod;
  generated_at: string;
  access: DashboardAccess;
  ledger_lookup: "ok" | "missing_source";
  items: DashboardCostItem[];
  next_cursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// Issue drill-down
// ---------------------------------------------------------------------------

/** Trace metadata as served by the dashboard; payload is never included. */
export interface DashboardTraceEvent {
  source: string;
  event_id: string;
  version: number;
  sequence: number;
  event_time: string;
  ingest_time: string;
  record_class: string;
  kind: string;
  issue_id: string | null;
  task_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  agent_id: string | null;
  agent_config_revision: string | null;
  invocation_id: string | null;
  tool_id: string | null;
  artifact_id: string | null;
  delivery_id: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  causation_id: string | null;
  evidence_refs: string[];
  labels: Record<string, string>;
  truncated: boolean;
  late: boolean;
}

export interface DashboardTraceView {
  status: DashboardMetricStatus;
  events: DashboardTraceEvent[];
  next_cursor: string | null;
  freshness: { as_of: string | null; event_time_watermark: string | null } | null;
  /** Missing-sequence and truncation evidence from the trace projection. */
  completeness: {
    complete: boolean;
    missing_ranges: number;
    truncated_event_refs: number;
  } | null;
}

export interface DashboardIssueDrilldown {
  enterprise_id: string;
  workspace_id: string;
  issue_id: string;
  period: DashboardPeriod;
  generated_at: string;
  access: DashboardAccess;
  sources: DashboardSourceState[];
  totals: DashboardTotals;
  runs: Array<{
    run_id: string;
    task_ids: string[];
    event_count: number;
    first_event_at: string;
    last_event_at: string;
  }>;
  trace: DashboardTraceView;
  references: {
    artifact_ids: string[];
    delivery_ids: string[];
    evidence_refs: string[];
    task_ids: string[];
    truncated: boolean;
  };
  /** This surface never serves captured content or quarantine material. */
  content: {
    access: "separate_authorization_required";
    payload_included: false;
  };
}

// ---------------------------------------------------------------------------
// Audit trail and export
// ---------------------------------------------------------------------------

export interface DashboardAuditEntry {
  audit_id: string;
  at: string;
  enterprise_id: string;
  workspace_id: string;
  subject: string;
  role: string;
  operation: DashboardAuditOperation;
  resource: DashboardAuditResource;
  issue_id: string | null;
  query: Record<string, string | number | null>;
  record_count: number;
  request_id: string;
}

export interface DashboardAuditPage {
  items: DashboardAuditEntry[];
  next_cursor: string | null;
  total: number;
}

export interface DashboardExportBundle {
  exported_at: string;
  summary: DashboardSummary;
  cost_items: DashboardCostItemPage;
  /** True when cost items were capped at {@link DASHBOARD_EXPORT_MAX_ITEMS}. */
  cost_items_truncated: boolean;
}
