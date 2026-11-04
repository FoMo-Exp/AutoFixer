import { ApiError } from "../api/client";
import type {
  DashboardBreakdownRow,
  DashboardCompleteness,
  DashboardMetricStatus,
  DashboardSourceState,
  DashboardTokenTotals,
  DashboardTraceEvent,
} from "../api/client";

/**
 * Every label below maps a merged-contract enum exactly. A value the contract
 * adds later fails the exhaustive record type instead of becoming an invented
 * UI category.
 */
export const METRIC_STATUS_LABELS: Record<DashboardMetricStatus, string> = {
  ok: "Measured",
  empty: "No data in period",
  missing_source: "Source not wired",
  not_measured: "Not measured",
  restricted: "Restricted",
};

export const SOURCE_LABELS: Record<DashboardSourceState["source"], string> = {
  invocation_ledger: "Invocation ledger",
  cost_ledger: "Cost ledger",
  budget_journal: "Budget journal",
  trace: "Trace",
  task_events: "Task events",
};

export const SOURCE_STATUS_LABELS: Record<DashboardSourceState["status"], string> = {
  ok: "Wired",
  empty: "Wired · no rows",
  stale: "Stale",
  missing: "Not wired",
  restricted: "Restricted",
};

export const COMPLETENESS_LABELS: Record<DashboardCompleteness, string> = {
  known: "Known",
  estimated: "Estimated (provisional)",
  unknown: "Unknown",
};

/** Display names for the metric keys the contract publishes. */
export const METRIC_NAMES: Record<string, string> = {
  requests: "Requests",
  invocations: "Invocations",
  retries: "Retries",
  retry_rate: "Retry rate",
  error_rate: "Error rate",
  denial_rate: "Denial rate",
  tokens: "Tokens",
  latency_ms: "Latency",
  queue_age_ms: "Queue age",
  approval_wait_ms: "Approval wait",
  validation_outcomes: "Validation outcomes",
  delivery_results: "Delivery results",
  connector_lag_ms: "Connector lag",
  worker_utilization: "Worker utilization",
  cost: "Cost",
  budget: "Budget",
};

export const BREAKDOWN_DIMENSION_LABELS: Record<"task" | "agent" | "model" | "date", string> = {
  task: "Task",
  agent: "Agent",
  model: "Model",
  date: "Date",
};

export type DashboardTone = "neutral" | "active" | "attention" | "danger" | "muted";

/**
 * Source freshness tone. `stale` is actionable (amber), `missing` is a visible
 * telemetry gap, and `restricted` never turns into a zero figure.
 */
export function sourceTone(status: DashboardSourceState["status"]): DashboardTone {
  switch (status) {
    case "ok":
      return "active";
    case "empty":
      return "neutral";
    case "stale":
      return "attention";
    case "missing":
      return "danger";
    case "restricted":
      return "muted";
  }
}

export function completenessTone(completeness: DashboardCompleteness): DashboardTone {
  switch (completeness) {
    case "known":
      return "active";
    case "estimated":
      return "attention";
    case "unknown":
      return "danger";
  }
}

const countFormatter = new Intl.NumberFormat();

export function formatCount(value: number | null): string {
  return value === null ? "—" : countFormatter.format(value);
}

/** Percent from the contract's ratio, which is already rounded to 6 decimals. */
export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** A rate always shows what it is a rate of; null is never rendered as 0%. */
export function formatRatio(
  numerator: number | null,
  denominator: number | null,
  value: number | null,
): string {
  if (value === null) {
    return denominator === null
      ? "—"
      : `— (${formatCount(numerator)} of ${formatCount(denominator)})`;
  }
  return formatPercent(value);
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

/**
 * Trim a canonical fixed-precision decimal for display without rounding it.
 * Monetary values keep at least two fraction digits so a zero is an explicit
 * zero, and extra precision is preserved up to the contract's exact value.
 */
export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * Money is always rendered with its own ISO currency code. Currencies are
 * never merged and no FX conversion is applied, so a total is only a total
 * within one currency.
 */
export function formatMoney(currency: string | null, amount: string): string {
  return `${currency ?? "No currency"} ${trimDecimal(amount)}`;
}

const TOKEN_CATEGORIES: Array<[keyof DashboardTokenTotals, string]> = [
  ["input", "Input"],
  ["output", "Output"],
  ["cache_read", "Cache read"],
  ["cache_write", "Cache write"],
  ["reasoning", "Reasoning"],
  ["total_tokens", "Total"],
];

export interface TokenRow {
  category: string;
  known: string;
  estimated: string;
  unknown: string;
}

/**
 * Known, estimated and unknown stay in separate columns. An unknown attempt
 * contributes to no sum, so it is counted here instead of being displayed as
 * zero tokens.
 */
export function tokenRows(figures: DashboardTokenTotals): TokenRow[] {
  return TOKEN_CATEGORIES.map(([key, label]) => ({
    category: label,
    known: formatCount(figures[key].known_tokens),
    estimated: formatCount(figures[key].estimated_tokens),
    unknown: formatCount(figures[key].unknown_attempts),
  }));
}

export interface BreakdownBar {
  key: string;
  known: number | null;
  estimated: number | null;
  unknownAttempts: number | null;
}

/**
 * Chart series are read from each row's `total_tokens`. A null figure means
 * the token source is not wired and is omitted from the axis rather than being
 * drawn as a zero-length bar.
 */
export function breakdownBars(rows: DashboardBreakdownRow[]): BreakdownBar[] {
  return rows.map((row) => ({
    key: row.key,
    known: row.tokens === null ? null : row.tokens.total_tokens.known_tokens,
    estimated: row.tokens === null ? null : row.tokens.total_tokens.estimated_tokens,
    unknownAttempts: row.tokens === null ? null : row.tokens.total_tokens.unknown_attempts,
  }));
}

export function barMaximum(bars: BreakdownBar[]): number {
  let maximum = 0;
  for (const bar of bars) {
    maximum = Math.max(maximum, (bar.known ?? 0) + (bar.estimated ?? 0));
  }
  return maximum;
}

/** Chart label: names the dimension, the scale and the completeness split. */
export function chartLabel(dimension: string, bars: BreakdownBar[], currencyNote?: string): string {
  const measured = bars.filter((bar) => bar.known !== null || bar.estimated !== null);
  if (measured.length === 0) {
    return `${dimension} token chart: no token figures in this period.`;
  }
  const top = [...measured]
    .sort((a, b) => (b.known ?? 0) + (b.estimated ?? 0) - ((a.known ?? 0) + (a.estimated ?? 0)))
    .slice(0, 3)
    .map((bar) => {
      const parts = [`${formatCount(bar.known)} known`];
      if ((bar.estimated ?? 0) > 0) parts.push(`${formatCount(bar.estimated)} estimated`);
      if ((bar.unknownAttempts ?? 0) > 0) parts.push(`${formatCount(bar.unknownAttempts)} unknown`);
      return `${bar.key}: ${parts.join(", ")}`;
    });
  return `${dimension} token chart by known and estimated tokens. ${top.join("; ")}${
    currencyNote ?? ""
  }`;
}

/** Trace labels that the server could not confirm as complete. */
export function traceFlags(event: DashboardTraceEvent): string[] {
  const flags: string[] = [];
  if (event.truncated) flags.push("Truncated");
  if (event.late) flags.push("Late");
  return flags;
}

export interface DashboardError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  requestId?: string;
  nextAction?: string | null;
}

/**
 * Maps a failed dashboard read to operator-facing guidance. Authorization and
 * content/quarantine refusals keep the service's stable code and message; the
 * UI never retries a denial and never rewrites it as a not-found.
 */
export function describeDashboardError(caught: unknown): DashboardError {
  if (caught instanceof ApiError) {
    const base = {
      code: caught.code,
      status: caught.status,
      retryable: caught.retryable,
      ...(caught.requestId ? { requestId: caught.requestId } : {}),
      nextAction: caught.nextAction,
    };
    switch (caught.status) {
      case 401:
        return {
          ...base,
          message: "Your session expired. Sign in again to read the workspace dashboard.",
          retryable: false,
        };
      case 403:
        if (caught.code === "FINANCIAL_ACCESS_DENIED") {
          return {
            ...base,
            message:
              "Financial metrics are readable by workspace owners and admins only. Ask an owner for the financial role.",
            retryable: false,
          };
        }
        if (caught.code === "AUDIT_ACCESS_DENIED") {
          return {
            ...base,
            message: "The dashboard audit trail is readable by workspace owners and admins only.",
            retryable: false,
          };
        }
        if (caught.code === "CONTENT_ACCESS_DENIED" || caught.code === "QUARANTINE_ACCESS_DENIED") {
          return {
            ...base,
            message: `${caught.message} Captured content and quarantine material need separate grants.`,
            retryable: false,
          };
        }
        return {
          ...base,
          message:
            "Your workspace role cannot read this dashboard. Ask a workspace owner for access.",
          retryable: false,
        };
      case 404:
        return {
          ...base,
          message:
            "This workspace is not visible to your credential, or it no longer exists. Dashboard data is never readable across workspaces.",
          retryable: false,
        };
      case 400:
        return {
          ...base,
          message: `${caught.message} The service rejected the query before returning any aggregate.`,
        };
      default:
        return { ...base, message: caught.message };
    }
  }
  if (caught instanceof Error) {
    return { code: "REQUEST_FAILED", message: caught.message, status: 0, retryable: true };
  }
  return {
    code: "REQUEST_FAILED",
    message: "The dashboard request failed before the service answered.",
    status: 0,
    retryable: true,
  };
}
