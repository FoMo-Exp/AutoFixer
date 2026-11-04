/**
 * OpenAPI contract for the workspace dashboard v1 surface (DAT-230).
 *
 * Kept beside the implementation so the contract test can compare closed
 * vocabularies against the same constants the service uses. Merge this into
 * the main document from `openapi.ts`.
 *
 * The contract is deliberately explicit about absence: every metric status
 * vocabulary published here is closed, `null` never means "zero", and the
 * sources / denominators blocks are required on every summary so a client can
 * render "not measured" without inventing a number.
 */

import type { JsonObject } from "./openapi-types.js";
import {
  DASHBOARD_AUDIT_OPERATIONS,
  DASHBOARD_AUDIT_RESOURCES,
  DASHBOARD_BREAKDOWN_DIMENSIONS,
  DASHBOARD_BREAKDOWN_MAX_DISTINCT_KEYS,
  DASHBOARD_COST_ITEMS_LIMIT_MAX,
  DASHBOARD_DATE_BUCKETS,
  DASHBOARD_METRIC_STATUSES,
  DASHBOARD_SOURCE_IDS,
  DASHBOARD_SOURCE_STATUSES,
} from "../dashboard/types.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

const workspaceIdParameter: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description:
    "Workspace locator. It must equal the workspace resolved from the caller's live membership; " +
    "any other id is 404 (indistinguishable from a missing workspace).",
};

const fromParameter: JsonObject = {
  name: "from",
  in: "query",
  required: false,
  schema: { type: "string", format: "date-time" },
  description:
    "Inclusive lower bound (RFC 3339). Default: 24 hours before `to`. The period is half-open " +
    "[from, to) and may span at most 366 days; a longer range is 400 RANGE_TOO_LARGE.",
};

const toParameter: JsonObject = {
  name: "to",
  in: "query",
  required: false,
  schema: { type: "string", format: "date-time" },
  description: "Exclusive upper bound (RFC 3339). Default: the current instant.",
};

const timezoneParameter: JsonObject = {
  name: "timezone",
  in: "query",
  required: false,
  schema: { type: "string", default: "UTC" },
  description:
    "IANA timezone used for date buckets and calendar boundaries. An unknown zone is 400.",
};

const bucketParameter: JsonObject = {
  name: "bucket",
  in: "query",
  required: false,
  schema: { type: "string", enum: [...DASHBOARD_DATE_BUCKETS], default: "day" },
  description:
    "Bucket size for `breakdown=date`. Bucket keys are local wall-clock labels in `timezone` " +
    "(`2026-11-03`, `2026-11-03T14:00`, `2026-W45` style Monday week start, `2026-11`).",
};

const breakdownParameter: JsonObject = {
  name: "breakdown",
  in: "query",
  required: false,
  schema: { type: "string", enum: [...DASHBOARD_BREAKDOWN_DIMENSIONS], default: "model" },
  description:
    "Aggregate dimension. Enterprise/workspace are the scope itself and are not queryable as " +
    "rows. `agent` requires the trace source (ledger `trace_id` joined to trace `agent_id`) and is " +
    "reported as `missing_source` when trace is not wired.",
};

const limitParameter: JsonObject = {
  name: "limit",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: DASHBOARD_COST_ITEMS_LIMIT_MAX, default: 50 },
  description:
    "Page size. The maximum is endpoint-specific; a larger value is 400 LIMIT_OUT_OF_RANGE.",
};

const cursorParameter: JsonObject = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string" },
  description:
    "Opaque cursor copied from a previous page's `next_cursor`. Clients must not construct or " +
    "parse it; a malformed cursor is 400 INVALID_CURSOR.",
};

const staleAfterParameter: JsonObject = {
  name: "stale_after_seconds",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: 0, default: 3600 },
  description:
    "A wired source whose newest record is older than `to - stale_after_seconds` is reported " +
    "`stale`; staleness never removes the data, and never turns it into a zero.",
};

const notFoundResponse = errorResponse(
  "NOT_FOUND — the path names a workspace other than the caller's live membership; the answer is " +
    "identical to a workspace that does not exist.",
);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const dashboardAccessSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["financial", "content", "quarantine"],
  properties: {
    financial: {
      type: "string",
      enum: ["granted", "restricted"],
      description:
        "Financial metrics are granted to owner/admin. Any other role gets `restricted` with null " +
        "cost/budget values — never zeros.",
    },
    content: {
      type: "string",
      enum: ["separate_authorization_required"],
      description:
        "This surface never serves captured model content. Content access is a separate grant " +
        "held by the trace viewer (DAT-225).",
    },
    quarantine: {
      type: "string",
      enum: ["separate_authorization_required"],
      description:
        "This surface never serves ADR-0005 quarantine material. Quarantine access is a " +
        "separate grant held by the security case surface.",
    },
  },
};

const dashboardPeriodSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "timezone", "boundary", "bucket"],
  properties: {
    from: { type: "string", format: "date-time" },
    to: { type: "string", format: "date-time" },
    timezone: { type: "string" },
    boundary: { type: "string", enum: ["half_open"] },
    bucket: { type: "string", enum: [...DASHBOARD_DATE_BUCKETS] },
  },
};

const dashboardSourceStateSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["source", "status", "watermark", "record_count", "stale_after_seconds", "note"],
  properties: {
    source: { type: "string", enum: [...DASHBOARD_SOURCE_IDS] },
    status: {
      type: "string",
      enum: [...DASHBOARD_SOURCE_STATUSES],
      description:
        "missing = source not wired (counts are null); empty = wired with no rows in the period " +
        "(a real zero); stale = wired, newest record older than stale_after_seconds; " +
        "restricted = the caller may not read this financial source, so even its count and " +
        "watermark are null; ok otherwise.",
    },
    watermark: {
      oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      description: "Newest observed timestamp in the period; null when missing or empty.",
    },
    record_count: {
      type: ["integer", "null"],
      minimum: 0,
      description: "Rows read in the period; null when the source is not wired.",
    },
    stale_after_seconds: { type: "integer", minimum: 0 },
    note: { type: ["string", "null"] },
  },
};

const metricStatusProperties = {
  status: { type: "string", enum: [...DASHBOARD_METRIC_STATUSES] },
  source: {
    oneOf: [{ type: "string", enum: [...DASHBOARD_SOURCE_IDS] }, { type: "null" }],
  },
} as const;

const dashboardCountMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "value"],
  properties: {
    ...metricStatusProperties,
    value: {
      type: ["integer", "null"],
      minimum: 0,
      description: "Null unless measured; a measured empty period is a real 0.",
    },
  },
};

const dashboardRatioMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "numerator", "denominator", "value"],
  properties: {
    ...metricStatusProperties,
    numerator: { type: ["integer", "null"], minimum: 0 },
    denominator: { type: ["integer", "null"], minimum: 0 },
    value: {
      type: ["number", "null"],
      description:
        "numerator / denominator rounded to 6 decimals; null when unmeasured or when the denominator is 0.",
    },
  },
};

const dashboardLatencyMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "p50_ms", "p95_ms", "sample_size"],
  properties: {
    ...metricStatusProperties,
    p50_ms: { type: ["number", "null"], minimum: 0 },
    p95_ms: { type: ["number", "null"], minimum: 0 },
    sample_size: { type: ["integer", "null"], minimum: 0 },
  },
};

const dashboardNotMeasuredMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "value", "note"],
  properties: {
    status: { type: "string", enum: ["not_measured"] },
    source: { type: "null" },
    value: { type: "null" },
    note: { type: "string", description: "Why the deployment has no source for this metric." },
  },
};

const figureTotalsSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["known_tokens", "estimated_tokens", "unknown_attempts"],
  properties: {
    known_tokens: { type: "integer", minimum: 0 },
    estimated_tokens: {
      type: "integer",
      minimum: 0,
      description: "Provisional; never a reconciled or invoiced quantity.",
    },
    unknown_attempts: {
      type: "integer",
      minimum: 0,
      description: "Attempts whose figure was absent/unknown; they contribute to no sum.",
    },
  },
};

const tokenTotalsSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["input", "output", "cache_read", "cache_write", "reasoning", "total_tokens"],
  properties: {
    input: { $ref: "#/components/schemas/DashboardFigureTotals" },
    output: { $ref: "#/components/schemas/DashboardFigureTotals" },
    cache_read: { $ref: "#/components/schemas/DashboardFigureTotals" },
    cache_write: { $ref: "#/components/schemas/DashboardFigureTotals" },
    reasoning: { $ref: "#/components/schemas/DashboardFigureTotals" },
    total_tokens: { $ref: "#/components/schemas/DashboardFigureTotals" },
  },
};

const dashboardTokenMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "figures"],
  properties: {
    ...metricStatusProperties,
    figures: {
      oneOf: [{ $ref: "#/components/schemas/DashboardTokenTotals" }, { type: "null" }],
    },
  },
};

const dashboardCostLineSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "currency",
    "cost_class",
    "known_cost",
    "estimated_cost",
    "unknown_components",
    "components",
    "postings",
  ],
  properties: {
    currency: {
      type: ["string", "null"],
      description: "ISO 4217 currency; null when the line holds no priced component.",
    },
    cost_class: {
      type: "string",
      enum: ["provider_tokens", "self_hosted_tokens", "infrastructure"],
    },
    known_cost: { type: "string", description: "Canonical fixed-precision decimal." },
    estimated_cost: { type: "string", description: "Provisional; never a billed amount." },
    unknown_components: { type: "integer", minimum: 0 },
    components: { type: "integer", minimum: 0 },
    postings: { type: "integer", minimum: 0 },
  },
};

const dashboardCostMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "source",
    "lines",
    "currencies",
    "rate_revision_ids",
    "completeness",
    "updated_at",
  ],
  properties: {
    ...metricStatusProperties,
    source: { type: "string", enum: ["cost_ledger"] },
    lines: {
      oneOf: [
        { type: "array", items: { $ref: "#/components/schemas/DashboardCostLine" } },
        { type: "null" },
      ],
    },
    currencies: {
      oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      description: "Every currency present in the period; currencies are never merged.",
    },
    rate_revision_ids: {
      oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      description: "Rate revisions bound by the period's postings (sorted, capped at 100).",
    },
    completeness: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["known", "estimated", "unknown"],
          properties: {
            known: { type: "integer", minimum: 0 },
            estimated: { type: "integer", minimum: 0 },
            unknown: { type: "integer", minimum: 0 },
          },
        },
        { type: "null" },
      ],
    },
    updated_at: {
      oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
};

const dashboardCurrencyAmountSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["currency", "amount"],
  properties: {
    currency: { type: "string" },
    amount: { type: "string", description: "Canonical fixed-precision decimal." },
  },
};

const dashboardBudgetMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "source",
    "reservations",
    "outstanding_bound",
    "settled_known",
    "settled_estimated",
    "unknown_money_accounts",
    "updated_at",
  ],
  properties: {
    ...metricStatusProperties,
    source: { type: "string", enum: ["budget_journal"] },
    reservations: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["held", "settled", "reconciling", "released"],
          properties: {
            held: { type: "integer", minimum: 0 },
            settled: { type: "integer", minimum: 0 },
            reconciling: { type: "integer", minimum: 0 },
            released: { type: "integer", minimum: 0 },
          },
        },
        { type: "null" },
      ],
    },
    outstanding_bound: {
      oneOf: [
        { type: "array", items: { $ref: "#/components/schemas/DashboardCurrencyAmount" } },
        { type: "null" },
      ],
      description: "Held plus reconciling bounds; an unknown outcome keeps its bound committed.",
    },
    settled_known: {
      oneOf: [
        { type: "array", items: { $ref: "#/components/schemas/DashboardCurrencyAmount" } },
        { type: "null" },
      ],
    },
    settled_estimated: {
      oneOf: [
        { type: "array", items: { $ref: "#/components/schemas/DashboardCurrencyAmount" } },
        { type: "null" },
      ],
      description:
        "Ceiling-derived settlement; labelled internal estimate, not a provider invoice.",
    },
    unknown_money_accounts: { type: ["integer", "null"], minimum: 0 },
    updated_at: {
      oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
};

const dashboardValidationMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "total", "passed", "failed", "unclassified"],
  properties: {
    ...metricStatusProperties,
    source: { type: "string", enum: ["task_events"] },
    total: { type: ["integer", "null"], minimum: 0 },
    passed: { type: ["integer", "null"], minimum: 0 },
    failed: { type: ["integer", "null"], minimum: 0 },
    unclassified: {
      type: ["integer", "null"],
      minimum: 0,
      description: "Events without a boolean `passed` field; never guessed.",
    },
  },
};

const dashboardDeliveryMetricSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "source", "total", "succeeded", "failed", "unknown"],
  properties: {
    ...metricStatusProperties,
    source: { type: "string", enum: ["trace"] },
    total: { type: ["integer", "null"], minimum: 0 },
    succeeded: { type: ["integer", "null"], minimum: 0 },
    failed: { type: ["integer", "null"], minimum: 0 },
    unknown: { type: ["integer", "null"], minimum: 0 },
  },
};

const dashboardTotalsSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "requests",
    "invocations",
    "retries",
    "retry_rate",
    "error_rate",
    "denial_rate",
    "tokens",
    "latency_ms",
    "queue_age_ms",
    "approval_wait_ms",
    "validation_outcomes",
    "delivery_results",
    "connector_lag_ms",
    "worker_utilization",
    "cost",
    "budget",
  ],
  properties: {
    requests: { $ref: "#/components/schemas/DashboardCountMetric" },
    invocations: { $ref: "#/components/schemas/DashboardCountMetric" },
    retries: { $ref: "#/components/schemas/DashboardCountMetric" },
    retry_rate: { $ref: "#/components/schemas/DashboardRatioMetric" },
    error_rate: { $ref: "#/components/schemas/DashboardRatioMetric" },
    denial_rate: { $ref: "#/components/schemas/DashboardRatioMetric" },
    tokens: { $ref: "#/components/schemas/DashboardTokenMetric" },
    latency_ms: { $ref: "#/components/schemas/DashboardLatencyMetric" },
    queue_age_ms: { $ref: "#/components/schemas/DashboardLatencyMetric" },
    approval_wait_ms: { $ref: "#/components/schemas/DashboardLatencyMetric" },
    validation_outcomes: { $ref: "#/components/schemas/DashboardValidationMetric" },
    delivery_results: { $ref: "#/components/schemas/DashboardDeliveryMetric" },
    connector_lag_ms: { $ref: "#/components/schemas/DashboardNotMeasuredMetric" },
    worker_utilization: { $ref: "#/components/schemas/DashboardNotMeasuredMetric" },
    cost: { $ref: "#/components/schemas/DashboardCostMetric" },
    budget: { $ref: "#/components/schemas/DashboardBudgetMetric" },
  },
};

const dashboardBreakdownRowSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "key",
    "request_count",
    "invocation_count",
    "retry_count",
    "error_rate",
    "tokens",
    "cost",
    "latency_ms",
  ],
  properties: {
    key: { type: "string" },
    request_count: { type: ["integer", "null"], minimum: 0 },
    invocation_count: { type: ["integer", "null"], minimum: 0 },
    retry_count: { type: ["integer", "null"], minimum: 0 },
    error_rate: { type: ["number", "null"] },
    tokens: {
      oneOf: [{ $ref: "#/components/schemas/DashboardTokenTotals" }, { type: "null" }],
    },
    cost: {
      oneOf: [
        { type: "array", items: { $ref: "#/components/schemas/DashboardCostLine" } },
        { type: "null" },
      ],
      description:
        "Empty array = cost source wired with no postings for this key (a real zero); null = " +
        "cost source not wired.",
    },
    latency_ms: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["p50_ms", "p95_ms", "sample_size"],
          properties: {
            p50_ms: { type: ["number", "null"], minimum: 0 },
            p95_ms: { type: ["number", "null"], minimum: 0 },
            sample_size: { type: ["integer", "null"], minimum: 0 },
          },
        },
        { type: "null" },
      ],
    },
  },
};

const dashboardBreakdownSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["dimension", "status", "rows", "next_cursor", "truncated", "omitted_keys"],
  properties: {
    dimension: { type: "string", enum: [...DASHBOARD_BREAKDOWN_DIMENSIONS] },
    status: { type: "string", enum: [...DASHBOARD_METRIC_STATUSES] },
    rows: { type: "array", items: { $ref: "#/components/schemas/DashboardBreakdownRow" } },
    next_cursor: { type: ["string", "null"] },
    truncated: {
      type: "boolean",
      description:
        `True when the scan exceeded ${DASHBOARD_BREAKDOWN_MAX_DISTINCT_KEYS} distinct keys; ` +
        "aggregate totals stay exact, but omitted keys are only counted.",
    },
    omitted_keys: { type: "integer", minimum: 0 },
  },
};

const dashboardSummarySchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "enterprise_id",
    "workspace_id",
    "period",
    "generated_at",
    "access",
    "sources",
    "denominators",
    "unavailable_metrics",
    "totals",
    "breakdown",
  ],
  properties: {
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    period: { $ref: "#/components/schemas/DashboardPeriod" },
    generated_at: { type: "string", format: "date-time" },
    access: { $ref: "#/components/schemas/DashboardAccess" },
    sources: {
      type: "array",
      items: { $ref: "#/components/schemas/DashboardSourceState" },
    },
    denominators: {
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Metric name -> exact denominator definition. A published rate always says what it is a rate of.",
    },
    unavailable_metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "reason"],
        properties: {
          metric: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    totals: { $ref: "#/components/schemas/DashboardTotals" },
    breakdown: { $ref: "#/components/schemas/DashboardBreakdown" },
  },
};

const dashboardLedgerEntryViewSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "invocation_id",
    "attempt",
    "issue_id",
    "run_id",
    "trace_id",
    "provider",
    "api",
    "requested_model",
    "returned_model",
    "provider_request_id",
    "started_at",
    "ended_at",
    "finish_status",
    "usage_completeness",
    "usage_provenance",
    "issue_drilldown_url",
  ],
  properties: {
    invocation_id: { type: "string" },
    attempt: { type: "integer", minimum: 1 },
    issue_id: { type: "string" },
    run_id: { type: "string" },
    trace_id: { type: "string" },
    provider: { type: "string" },
    api: { type: "string" },
    requested_model: { type: "string" },
    returned_model: { type: ["string", "null"] },
    provider_request_id: { type: ["string", "null"] },
    started_at: { type: "string", format: "date-time" },
    ended_at: { type: "string", format: "date-time" },
    finish_status: { type: "string" },
    usage_completeness: { type: "string", enum: ["known", "estimated", "unknown"] },
    usage_provenance: { type: "string" },
    issue_drilldown_url: { type: ["string", "null"] },
  },
};

const costComponentSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "category",
    "chargeable",
    "included_in",
    "chargeable_units",
    "unit",
    "cost_class",
    "currency",
    "rate_revision_id",
    "rate",
    "divisor",
    "cost",
    "completeness",
    "unknown_reason",
  ],
  properties: {
    category: { type: "string" },
    chargeable: { type: "boolean" },
    included_in: { type: ["string", "null"] },
    chargeable_units: { type: ["integer", "null"], minimum: 0 },
    unit: { type: "string" },
    cost_class: { type: "string" },
    currency: { type: ["string", "null"] },
    rate_revision_id: { type: ["string", "null"] },
    rate: { type: ["string", "null"] },
    divisor: { type: ["integer", "null"] },
    cost: {
      type: ["string", "null"],
      description: "Canonical decimal; null means unknown (never a stand-in zero).",
    },
    completeness: { type: "string", enum: ["known", "estimated", "unknown"] },
    unknown_reason: { type: ["string", "null"] },
  },
};

const adjustmentComponentSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "category",
    "completeness",
    "corrected_units",
    "corrected_rate_revision_id",
    "corrected_cost",
    "corrected_currency",
    "note",
  ],
  properties: {
    category: { type: "string" },
    completeness: { type: "string", enum: ["known", "estimated", "unknown"] },
    corrected_units: { type: ["integer", "null"], minimum: 0 },
    corrected_rate_revision_id: { type: ["string", "null"] },
    corrected_cost: { type: ["string", "null"] },
    corrected_currency: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
  },
};

const adjustmentSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "adjustment_id",
    "target_posting_id",
    "reason",
    "source",
    "created_at",
    "note",
    "components",
  ],
  properties: {
    adjustment_id: { type: "string" },
    target_posting_id: { type: "string" },
    reason: { type: "string", enum: ["provider_correction", "administrator_correction"] },
    source: { type: "string", enum: ["provider", "administrator"] },
    created_at: { type: "string", format: "date-time" },
    note: { type: ["string", "null"] },
    components: {
      type: "array",
      items: { $ref: "#/components/schemas/DashboardAdjustmentComponent" },
    },
  },
};

const dashboardCostItemSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "posting_id",
    "kind",
    "invocation_id",
    "attempt",
    "endpoint_id",
    "model_id",
    "requested_model",
    "returned_model",
    "target",
    "applicable_time",
    "currency",
    "completeness",
    "components",
    "adjustments",
    "ledger_entry",
    "ledger_lookup",
    "recorded_at",
  ],
  properties: {
    posting_id: { type: "string" },
    kind: { type: "string", enum: ["invocation", "infrastructure"] },
    invocation_id: { type: ["string", "null"] },
    attempt: { type: ["integer", "null"], minimum: 1 },
    endpoint_id: { type: ["string", "null"] },
    model_id: { type: ["string", "null"] },
    requested_model: { type: ["string", "null"] },
    returned_model: { type: ["string", "null"] },
    target: { type: "string", enum: ["provider", "self_hosted"] },
    applicable_time: { type: "string", format: "date-time" },
    currency: { type: ["string", "null"] },
    completeness: { type: "string", enum: ["known", "estimated", "unknown"] },
    components: {
      type: "array",
      items: { $ref: "#/components/schemas/DashboardCostComponent" },
    },
    adjustments: {
      type: "array",
      items: { $ref: "#/components/schemas/DashboardAdjustment" },
    },
    ledger_entry: {
      oneOf: [{ $ref: "#/components/schemas/DashboardLedgerEntryView" }, { type: "null" }],
    },
    ledger_lookup: {
      type: "string",
      enum: ["ok", "not_found", "missing_source", "infrastructure"],
      description:
        "Cost item -> invocation ledger entry drill-down state. `missing_source` means the ledger " +
        "is not wired; `not_found` means no matching (invocation_id, attempt) in the period.",
    },
    recorded_at: { type: "string", format: "date-time" },
  },
};

const dashboardCostItemPageSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["period", "generated_at", "access", "ledger_lookup", "items", "next_cursor", "total"],
  properties: {
    period: { $ref: "#/components/schemas/DashboardPeriod" },
    generated_at: { type: "string", format: "date-time" },
    access: { $ref: "#/components/schemas/DashboardAccess" },
    ledger_lookup: { type: "string", enum: ["ok", "missing_source"] },
    items: { type: "array", items: { $ref: "#/components/schemas/DashboardCostItem" } },
    next_cursor: { type: ["string", "null"] },
    total: { type: "integer", minimum: 0 },
  },
};

const dashboardTraceEventSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "source",
    "event_id",
    "version",
    "sequence",
    "event_time",
    "ingest_time",
    "record_class",
    "kind",
    "issue_id",
    "task_id",
    "run_id",
    "attempt_id",
    "agent_id",
    "agent_config_revision",
    "invocation_id",
    "tool_id",
    "artifact_id",
    "delivery_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "causation_id",
    "evidence_refs",
    "labels",
    "truncated",
    "late",
  ],
  properties: {
    source: { type: "string" },
    event_id: { type: "string" },
    version: { type: "integer", minimum: 1 },
    sequence: { type: "integer", minimum: 1 },
    event_time: { type: "string", format: "date-time" },
    ingest_time: { type: "string", format: "date-time" },
    record_class: { type: "string" },
    kind: { type: "string" },
    issue_id: { type: ["string", "null"] },
    task_id: { type: ["string", "null"] },
    run_id: { type: ["string", "null"] },
    attempt_id: { type: ["string", "null"] },
    agent_id: { type: ["string", "null"] },
    agent_config_revision: { type: ["string", "null"] },
    invocation_id: { type: ["string", "null"] },
    tool_id: { type: ["string", "null"] },
    artifact_id: { type: ["string", "null"] },
    delivery_id: { type: ["string", "null"] },
    trace_id: { type: "string" },
    span_id: { type: "string" },
    parent_span_id: { type: ["string", "null"] },
    causation_id: { type: ["string", "null"] },
    evidence_refs: { type: "array", items: { type: "string" } },
    labels: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Metric-safe labels only; payload is never included by this surface.",
    },
    truncated: { type: "boolean" },
    late: { type: "boolean" },
  },
};

const dashboardIssueDrilldownSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "enterprise_id",
    "workspace_id",
    "issue_id",
    "period",
    "generated_at",
    "access",
    "sources",
    "totals",
    "runs",
    "trace",
    "references",
    "content",
  ],
  properties: {
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    issue_id: { type: "string" },
    period: { $ref: "#/components/schemas/DashboardPeriod" },
    generated_at: { type: "string", format: "date-time" },
    access: { $ref: "#/components/schemas/DashboardAccess" },
    sources: { type: "array", items: { $ref: "#/components/schemas/DashboardSourceState" } },
    totals: { $ref: "#/components/schemas/DashboardTotals" },
    runs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["run_id", "task_ids", "event_count", "first_event_at", "last_event_at"],
        properties: {
          run_id: { type: "string" },
          task_ids: { type: "array", items: { type: "string" } },
          event_count: { type: "integer", minimum: 0 },
          first_event_at: { type: "string", format: "date-time" },
          last_event_at: { type: "string", format: "date-time" },
        },
      },
    },
    trace: {
      type: "object",
      additionalProperties: false,
      required: ["status", "events", "next_cursor", "freshness", "completeness"],
      properties: {
        status: { type: "string", enum: [...DASHBOARD_METRIC_STATUSES] },
        events: {
          type: "array",
          items: { $ref: "#/components/schemas/DashboardTraceEvent" },
        },
        next_cursor: { type: ["string", "null"] },
        freshness: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["as_of", "event_time_watermark"],
              properties: {
                as_of: { type: ["string", "null"], format: "date-time" },
                event_time_watermark: { type: ["string", "null"], format: "date-time" },
              },
            },
            { type: "null" },
          ],
        },
        completeness: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["complete", "missing_ranges", "truncated_event_refs"],
              properties: {
                complete: { type: "boolean" },
                missing_ranges: { type: "integer", minimum: 0 },
                truncated_event_refs: { type: "integer", minimum: 0 },
              },
            },
            { type: "null" },
          ],
        },
      },
    },
    references: {
      type: "object",
      additionalProperties: false,
      required: ["artifact_ids", "delivery_ids", "evidence_refs", "task_ids", "truncated"],
      properties: {
        artifact_ids: { type: "array", items: { type: "string" } },
        delivery_ids: { type: "array", items: { type: "string" } },
        evidence_refs: { type: "array", items: { type: "string" } },
        task_ids: { type: "array", items: { type: "string" } },
        truncated: { type: "boolean" },
      },
    },
    content: {
      type: "object",
      additionalProperties: false,
      required: ["access", "payload_included"],
      properties: {
        access: { type: "string", enum: ["separate_authorization_required"] },
        payload_included: { type: "boolean", enum: [false] },
      },
    },
  },
};

const dashboardAuditEntrySchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "audit_id",
    "at",
    "enterprise_id",
    "workspace_id",
    "subject",
    "role",
    "operation",
    "resource",
    "issue_id",
    "query",
    "record_count",
    "request_id",
  ],
  properties: {
    audit_id: { type: "string" },
    at: { type: "string", format: "date-time" },
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    subject: { type: "string" },
    role: { type: "string" },
    operation: { type: "string", enum: [...DASHBOARD_AUDIT_OPERATIONS] },
    resource: { type: "string", enum: [...DASHBOARD_AUDIT_RESOURCES] },
    issue_id: { type: ["string", "null"] },
    query: {
      type: "object",
      additionalProperties: { type: ["string", "number", "null"] },
      description: "Request metadata only; never content, amounts, or token figures.",
    },
    record_count: { type: "integer", minimum: 0 },
    request_id: { type: "string" },
  },
};

const dashboardAuditPageSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["items", "next_cursor", "total"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/DashboardAuditEntry" } },
    next_cursor: { type: ["string", "null"] },
    total: { type: "integer", minimum: 0 },
  },
};

const dashboardExportBundleSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["exported_at", "summary", "cost_items", "cost_items_truncated"],
  properties: {
    exported_at: { type: "string", format: "date-time" },
    summary: { $ref: "#/components/schemas/DashboardSummary" },
    cost_items: { $ref: "#/components/schemas/DashboardCostItemPage" },
    cost_items_truncated: { type: "boolean" },
  },
};

export const DASHBOARD_OPENAPI_SCHEMAS: Record<string, JsonObject> = {
  DashboardAccess: dashboardAccessSchema,
  DashboardPeriod: dashboardPeriodSchema,
  DashboardSourceState: dashboardSourceStateSchema,
  DashboardCountMetric: dashboardCountMetricSchema,
  DashboardRatioMetric: dashboardRatioMetricSchema,
  DashboardLatencyMetric: dashboardLatencyMetricSchema,
  DashboardNotMeasuredMetric: dashboardNotMeasuredMetricSchema,
  DashboardFigureTotals: figureTotalsSchema,
  DashboardTokenTotals: tokenTotalsSchema,
  DashboardTokenMetric: dashboardTokenMetricSchema,
  DashboardCostLine: dashboardCostLineSchema,
  DashboardCostMetric: dashboardCostMetricSchema,
  DashboardCurrencyAmount: dashboardCurrencyAmountSchema,
  DashboardBudgetMetric: dashboardBudgetMetricSchema,
  DashboardValidationMetric: dashboardValidationMetricSchema,
  DashboardDeliveryMetric: dashboardDeliveryMetricSchema,
  DashboardTotals: dashboardTotalsSchema,
  DashboardBreakdownRow: dashboardBreakdownRowSchema,
  DashboardBreakdown: dashboardBreakdownSchema,
  DashboardSummary: dashboardSummarySchema,
  DashboardLedgerEntryView: dashboardLedgerEntryViewSchema,
  DashboardCostComponent: costComponentSchema,
  DashboardAdjustmentComponent: adjustmentComponentSchema,
  DashboardAdjustment: adjustmentSchema,
  DashboardCostItem: dashboardCostItemSchema,
  DashboardCostItemPage: dashboardCostItemPageSchema,
  DashboardTraceEvent: dashboardTraceEventSchema,
  DashboardIssueDrilldown: dashboardIssueDrilldownSchema,
  DashboardAuditEntry: dashboardAuditEntrySchema,
  DashboardAuditPage: dashboardAuditPageSchema,
  DashboardExportBundle: dashboardExportBundleSchema,
};

const forbiddenResponse = (description: string): JsonObject => errorResponse(description);

export function dashboardOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/api/v1/workspaces/{workspace_id}/dashboard/summary": {
      get: {
        operationId: "getDashboardSummary",
        summary: "Workspace usage, cost, latency and operational aggregates",
        description:
          "Read-only aggregate over the invocation ledger, cost ledger, budget journal, trace and " +
          "task event log. The period is half-open and timezone-explicit; every rate publishes " +
          "its denominator; a metric from an unwired source is null with an explicit status and is " +
          "never rendered as zero. Financial sections are owner/admin only and appear as " +
          "`restricted` for other roles. This surface never returns prompt content or quarantine " +
          "material. Every read is audited.",
        parameters: [
          workspaceIdParameter,
          fromParameter,
          toParameter,
          timezoneParameter,
          bucketParameter,
          breakdownParameter,
          limitParameter,
          cursorParameter,
          staleAfterParameter,
        ],
        responses: {
          200: {
            description: "Workspace dashboard summary",
            ...jsonRef("#/components/schemas/DashboardSummary"),
          },
          400: errorResponse(
            "INVALID_REQUEST, INVALID_CURSOR, RANGE_TOO_LARGE or LIMIT_OUT_OF_RANGE",
          ),
          403: forbiddenResponse(
            "FORBIDDEN, SCOPE_MISSING, SCOPE_AMBIGUOUS, SCOPE_CROSS_TENANT, ACCOUNT_SUSPENDED, " +
              "or CONTENT_ACCESS_DENIED / QUARANTINE_ACCESS_DENIED when content/quarantine is requested",
          ),
          404: notFoundResponse,
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/dashboard/cost-items": {
      get: {
        operationId: "listDashboardCostItems",
        summary: "Priced cost items with their invocation ledger drill-down",
        description:
          "Owner/admin only. Each item is one immutable cost posting with its chargeable " +
          "components, linked adjustments, the bound rate revision per component, and the " +
          "invocation ledger entry it prices (`ledger_entry` + `ledger_lookup`). Unknown cost " +
          "components stay null; estimates are labelled and never presented as invoiced amounts. " +
          "Currencies are never merged. Every read is audited.",
        parameters: [
          workspaceIdParameter,
          fromParameter,
          toParameter,
          timezoneParameter,
          limitParameter,
          cursorParameter,
        ],
        responses: {
          200: {
            description: "Cost item page",
            ...jsonRef("#/components/schemas/DashboardCostItemPage"),
          },
          400: errorResponse(
            "INVALID_REQUEST, INVALID_CURSOR, RANGE_TOO_LARGE or LIMIT_OUT_OF_RANGE",
          ),
          403: forbiddenResponse(
            "FINANCIAL_ACCESS_DENIED for roles other than owner/admin, or a scope failure",
          ),
          404: notFoundResponse,
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/dashboard/issues/{issue_id}": {
      get: {
        operationId: "getDashboardIssueDrilldown",
        summary: "Issue drill-down: execution trace, runs, artifact/delivery references",
        description:
          "Follows one issue from its ledger/cost/budget entries to its causal trace, runs, and " +
          "artifact, delivery and evidence references. Trace events are metadata only: `payload` " +
          "is never included, and the response states `payload_included: false`. Approval waiting, " +
          "queue age and validation outcomes need the trace to correlate task identity; without " +
          "it they report `missing_source`. Financial sections follow the caller's role. Every " +
          "read is audited.",
        parameters: [
          workspaceIdParameter,
          {
            name: "issue_id",
            in: "path",
            required: true,
            schema: { type: "string", maxLength: 200 },
            description: "Issue locator; it is matched inside the authenticated workspace scope.",
          },
          fromParameter,
          toParameter,
          timezoneParameter,
          limitParameter,
          cursorParameter,
        ],
        responses: {
          200: {
            description: "Issue drill-down",
            ...jsonRef("#/components/schemas/DashboardIssueDrilldown"),
          },
          400: errorResponse(
            "INVALID_REQUEST, INVALID_CURSOR, RANGE_TOO_LARGE or LIMIT_OUT_OF_RANGE",
          ),
          403: forbiddenResponse(
            "FORBIDDEN or a scope failure; CONTENT_ACCESS_DENIED / QUARANTINE_ACCESS_DENIED when " +
              "content or quarantine is requested",
          ),
          404: notFoundResponse,
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/dashboard/audit": {
      get: {
        operationId: "listDashboardAudit",
        summary: "Dashboard read/export audit trail",
        description:
          "Owner/admin only. Newest-first metadata about every dashboard read and export in the " +
          "caller's workspace: subject, role, resource, period/paging parameters, record count and " +
          "request id. It contains no content, amounts, or token figures. Reading the trail is " +
          "itself audited.",
        parameters: [
          workspaceIdParameter,
          {
            name: "operation",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...DASHBOARD_AUDIT_OPERATIONS] },
          },
          {
            name: "resource",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...DASHBOARD_AUDIT_RESOURCES] },
          },
          limitParameter,
          cursorParameter,
        ],
        responses: {
          200: {
            description: "Audit page",
            ...jsonRef("#/components/schemas/DashboardAuditPage"),
          },
          400: errorResponse("INVALID_REQUEST, INVALID_CURSOR or LIMIT_OUT_OF_RANGE"),
          403: forbiddenResponse("AUDIT_ACCESS_DENIED for roles other than owner/admin"),
          404: notFoundResponse,
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/dashboard/export": {
      get: {
        operationId: "exportDashboard",
        summary: "Export the workspace summary and cost items as JSON",
        description:
          "Owner/admin only. The bundle contains the same summary and cost-item page shapes the " +
          "read endpoints serve; cost items are capped and `cost_items_truncated` says when the " +
          "cap was hit. An export is audited as its own operation class. It never includes prompt " +
          "content, quarantine material, or a currency-merged total.",
        parameters: [
          workspaceIdParameter,
          fromParameter,
          toParameter,
          timezoneParameter,
          bucketParameter,
          breakdownParameter,
        ],
        responses: {
          200: {
            description: "Export bundle",
            ...jsonRef("#/components/schemas/DashboardExportBundle"),
          },
          400: errorResponse("INVALID_REQUEST, RANGE_TOO_LARGE or an invalid bucket/timezone"),
          403: forbiddenResponse(
            "FINANCIAL_ACCESS_DENIED for roles other than owner/admin, or a scope failure",
          ),
          404: notFoundResponse,
        },
      },
    },
  };
}
