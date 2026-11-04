import type { ReactElement, ReactNode } from "react";
import type {
  DashboardBudgetMetric,
  DashboardCostMetric,
  DashboardDeliveryMetric,
  DashboardLatencyMetric,
  DashboardNotMeasuredMetric,
  DashboardSourceState,
  DashboardTokenMetric,
  DashboardTokenTotals,
  DashboardTotals,
  DashboardValidationMetric,
} from "../api/client";
import {
  formatCount,
  formatDuration,
  formatMoney,
  formatRatio,
  METRIC_NAMES,
  METRIC_STATUS_LABELS,
  SOURCE_LABELS,
  SOURCE_STATUS_LABELS,
  sourceTone,
  tokenRows,
} from "./dashboard-format";
import type { DashboardTone } from "./dashboard-format";

export function StatusBadge({
  tone,
  children,
}: {
  tone: DashboardTone;
  children: ReactNode;
}): ReactElement {
  return <span className={`dashboard-status dashboard-tone-${tone}`}>{children}</span>;
}

/** Metric tone: a missing source is a visible gap, while an empty period is a real zero. */
export function metricTone(status: DashboardTotals["requests"]["status"]): DashboardTone {
  switch (status) {
    case "ok":
      return "active";
    case "empty":
      return "neutral";
    case "missing_source":
      return "danger";
    case "not_measured":
    case "restricted":
      return "muted";
  }
}

/**
 * Source freshness is part of the answer: a dashboard that hides a stale or
 * unwired source turns "we do not know" into a plausible-looking total.
 */
export function SourceTable({ sources }: { sources: DashboardSourceState[] }): ReactElement {
  return (
    <div className="dashboard-table-scroll">
      <table className="dashboard-table">
        <caption>Telemetry sources in this period</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
            <th scope="col">Newest record</th>
            <th scope="col">Rows</th>
            <th scope="col">Stale after</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.source}>
              <th scope="row">{SOURCE_LABELS[source.source]}</th>
              <td>
                <StatusBadge tone={sourceTone(source.status)}>
                  {SOURCE_STATUS_LABELS[source.status]}
                </StatusBadge>
              </td>
              <td className="dashboard-mono">
                {source.watermark === null ? "—" : new Date(source.watermark).toLocaleString()}
              </td>
              <td className="dashboard-mono">{formatCount(source.record_count)}</td>
              <td className="dashboard-mono">{source.stale_after_seconds}s</td>
              <td className="dashboard-note-cell">{source.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricCard({
  label,
  status,
  value,
  detail,
}: {
  label: string;
  status: DashboardTotals["requests"]["status"];
  value: string;
  detail: string;
}): ReactElement {
  return (
    <article className="dashboard-metric">
      <div className="dashboard-metric-head">
        <h4>{label}</h4>
        <StatusBadge tone={metricTone(status)}>{METRIC_STATUS_LABELS[status]}</StatusBadge>
      </div>
      <strong className={value === "—" ? "dashboard-metric-empty" : undefined}>{value}</strong>
      <span className="dashboard-metric-detail">{detail}</span>
    </article>
  );
}

function countCard(
  label: string,
  metric: { status: DashboardTotals["requests"]["status"]; value: number | null },
  detail: string,
): ReactElement {
  return (
    <MetricCard
      label={label}
      status={metric.status}
      value={metric.value === null ? "—" : formatCount(metric.value)}
      detail={metric.value === null ? METRIC_STATUS_LABELS[metric.status] : detail}
    />
  );
}

function LatencyCard({
  label,
  metric,
}: {
  label: string;
  metric: DashboardLatencyMetric;
}): ReactElement {
  const measured = metric.p50_ms !== null || metric.p95_ms !== null;
  return (
    <MetricCard
      label={label}
      status={metric.status}
      value={measured ? formatDuration(metric.p50_ms) : "—"}
      detail={
        measured
          ? `p95 ${formatDuration(metric.p95_ms)} · ${formatCount(metric.sample_size)} samples`
          : METRIC_STATUS_LABELS[metric.status]
      }
    />
  );
}

function NotMeasuredCard({
  label,
  metric,
}: {
  label: string;
  metric: DashboardNotMeasuredMetric;
}): ReactElement {
  return <MetricCard label={label} status={metric.status} value="—" detail={metric.note} />;
}

function ValidationCard({ metric }: { metric: DashboardValidationMetric }): ReactElement {
  const measured = metric.total !== null;
  return (
    <MetricCard
      label="Validation outcomes"
      status={metric.status}
      value={measured ? formatCount(metric.total) : "—"}
      detail={
        measured
          ? `${formatCount(metric.passed)} passed · ${formatCount(metric.failed)} failed · ${formatCount(
              metric.unclassified,
            )} unclassified`
          : METRIC_STATUS_LABELS[metric.status]
      }
    />
  );
}

function DeliveryCard({ metric }: { metric: DashboardDeliveryMetric }): ReactElement {
  const measured = metric.total !== null;
  return (
    <MetricCard
      label="Delivery results"
      status={metric.status}
      value={measured ? formatCount(metric.total) : "—"}
      detail={
        measured
          ? `${formatCount(metric.succeeded)} succeeded · ${formatCount(
              metric.failed,
            )} failed · ${formatCount(metric.unknown)} unknown`
          : METRIC_STATUS_LABELS[metric.status]
      }
    />
  );
}

export function TokenTable({
  figures,
  caption,
}: {
  figures: DashboardTokenTotals;
  caption: string;
}): ReactElement {
  return (
    <div className="dashboard-table-scroll">
      <table className="dashboard-table dashboard-token-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Known</th>
            <th scope="col">Estimated (provisional)</th>
            <th scope="col">Unknown attempts</th>
          </tr>
        </thead>
        <tbody>
          {tokenRows(figures).map((row) => (
            <tr key={row.category}>
              <th scope="row">{row.category}</th>
              <td className="dashboard-mono">{row.known}</td>
              <td className="dashboard-mono">{row.estimated}</td>
              <td className="dashboard-mono">{row.unknown}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dashboard-fineprint">
        Unknown attempts contribute to no sum; they are counted here, never displayed as zero
        tokens. Estimated figures are provisional and never an invoiced quantity.
      </p>
    </div>
  );
}

function TokenSection({ metric }: { metric: DashboardTokenMetric }): ReactElement {
  return (
    <section className="card dashboard-card" aria-labelledby="dashboard-tokens-heading">
      <div className="card-heading dashboard-card-heading">
        <div>
          <span className="eyebrow">Invocations</span>
          <h3 id="dashboard-tokens-heading">Tokens</h3>
        </div>
        <StatusBadge tone={metricTone(metric.status)}>
          {METRIC_STATUS_LABELS[metric.status]}
        </StatusBadge>
      </div>
      {metric.figures === null ? (
        <p className="dashboard-unavailable">
          {metric.status === "restricted"
            ? "Token figures are restricted for this role."
            : "No token figures are available from the invocation ledger."}
        </p>
      ) : (
        <TokenTable figures={metric.figures} caption="Tokens by category" />
      )}
    </section>
  );
}

export function CostSection({
  cost,
  onOpenLedger,
}: {
  cost: DashboardCostMetric;
  onOpenLedger?: () => void;
}): ReactElement {
  return (
    <section className="card dashboard-card" aria-labelledby="dashboard-cost-heading">
      <div className="card-heading dashboard-card-heading">
        <div>
          <span className="eyebrow">Financial</span>
          <h3 id="dashboard-cost-heading">Cost</h3>
        </div>
        <div className="dashboard-card-actions">
          <StatusBadge tone={metricTone(cost.status)}>
            {METRIC_STATUS_LABELS[cost.status]}
          </StatusBadge>
          {onOpenLedger && cost.status === "ok" && (
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={onOpenLedger}
            >
              Open ledger
            </button>
          )}
        </div>
      </div>
      {cost.status !== "ok" && cost.status !== "empty" ? (
        <p className="dashboard-unavailable">
          {cost.status === "restricted"
            ? "Financial figures need the owner or admin role; cost is omitted, not shown as zero."
            : "The cost ledger is not wired, so no priced amount is reported."}
        </p>
      ) : cost.lines === null || cost.lines.length === 0 ? (
        <p className="dashboard-unavailable">No priced posting falls in this period.</p>
      ) : (
        <>
          <div className="dashboard-table-scroll">
            <table className="dashboard-table">
              <caption>Known and estimated cost by currency and cost class</caption>
              <thead>
                <tr>
                  <th scope="col">Currency</th>
                  <th scope="col">Class</th>
                  <th scope="col">Known</th>
                  <th scope="col">Estimated (provisional)</th>
                  <th scope="col">Unknown components</th>
                  <th scope="col">Components</th>
                  <th scope="col">Postings</th>
                </tr>
              </thead>
              <tbody>
                {cost.lines.map((line) => (
                  <tr key={`${line.currency ?? "none"}-${line.cost_class}`}>
                    <th scope="row" className="dashboard-mono">
                      {line.currency ?? "No currency"}
                    </th>
                    <td>{line.cost_class.replace(/_/g, " ")}</td>
                    <td className="dashboard-mono">
                      {formatMoney(line.currency, line.known_cost)}
                    </td>
                    <td className="dashboard-mono">
                      {formatMoney(line.currency, line.estimated_cost)}
                    </td>
                    <td className="dashboard-mono">{formatCount(line.unknown_components)}</td>
                    <td className="dashboard-mono">{formatCount(line.components)}</td>
                    <td className="dashboard-mono">{formatCount(line.postings)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="dashboard-facts">
            <div>
              <dt>Currencies</dt>
              <dd>{cost.currencies?.join(", ") ?? "—"}</dd>
            </div>
            <div>
              <dt>Rate revisions</dt>
              <dd className="dashboard-chip-list">
                {(cost.rate_revision_ids ?? []).length === 0
                  ? "—"
                  : cost.rate_revision_ids?.map((revision) => (
                      <span key={revision} className="dashboard-chip dashboard-mono">
                        {revision}
                      </span>
                    ))}
              </dd>
            </div>
            <div>
              <dt>Completeness</dt>
              <dd>
                {cost.completeness === null
                  ? "—"
                  : `${formatCount(cost.completeness.known)} known · ${formatCount(
                      cost.completeness.estimated,
                    )} estimated · ${formatCount(cost.completeness.unknown)} unknown`}
              </dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{cost.updated_at === null ? "—" : new Date(cost.updated_at).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="dashboard-fineprint">
            Currencies are never merged. Estimated amounts are provisional; they are not an invoiced
            amount.
          </p>
        </>
      )}
    </section>
  );
}

export function BudgetSection({ budget }: { budget: DashboardBudgetMetric }): ReactElement {
  return (
    <section className="card dashboard-card" aria-labelledby="dashboard-budget-heading">
      <div className="card-heading dashboard-card-heading">
        <div>
          <span className="eyebrow">Financial</span>
          <h3 id="dashboard-budget-heading">Budget</h3>
        </div>
        <StatusBadge tone={metricTone(budget.status)}>
          {METRIC_STATUS_LABELS[budget.status]}
        </StatusBadge>
      </div>
      {budget.status !== "ok" && budget.status !== "empty" ? (
        <p className="dashboard-unavailable">
          {budget.status === "restricted"
            ? "Budget figures need the owner or admin role; the journal is omitted, not shown as zero."
            : "The budget journal is not wired, so no reservation is reported."}
        </p>
      ) : budget.reservations === null ? (
        <p className="dashboard-unavailable">No budget reservation is reported for this period.</p>
      ) : (
        <>
          <dl className="dashboard-facts">
            <div>
              <dt>Reservations</dt>
              <dd>
                {formatCount(budget.reservations.held)} held ·{" "}
                {formatCount(budget.reservations.settled)} settled ·{" "}
                {formatCount(budget.reservations.reconciling)} reconciling ·{" "}
                {formatCount(budget.reservations.released)} released
              </dd>
            </div>
            <div>
              <dt>Outstanding bound</dt>
              <dd className="dashboard-amount-list">
                {(budget.outstanding_bound ?? []).length === 0
                  ? "—"
                  : budget.outstanding_bound?.map((entry) => (
                      <span key={entry.currency} className="dashboard-mono">
                        {formatMoney(entry.currency, entry.amount)}
                      </span>
                    ))}
              </dd>
            </div>
            <div>
              <dt>Settled known</dt>
              <dd className="dashboard-amount-list">
                {(budget.settled_known ?? []).length === 0
                  ? "—"
                  : budget.settled_known?.map((entry) => (
                      <span key={entry.currency} className="dashboard-mono">
                        {formatMoney(entry.currency, entry.amount)}
                      </span>
                    ))}
              </dd>
            </div>
            <div>
              <dt>Settled estimated</dt>
              <dd className="dashboard-amount-list">
                {(budget.settled_estimated ?? []).length === 0
                  ? "—"
                  : budget.settled_estimated?.map((entry) => (
                      <span key={entry.currency} className="dashboard-mono">
                        {formatMoney(entry.currency, entry.amount)}
                      </span>
                    ))}
              </dd>
            </div>
            <div>
              <dt>Unknown money accounts</dt>
              <dd>{formatCount(budget.unknown_money_accounts)}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                {budget.updated_at === null ? "—" : new Date(budget.updated_at).toLocaleString()}
              </dd>
            </div>
          </dl>
          <p className="dashboard-fineprint">
            Held and reconciling bounds stay committed; an unknown outcome never silently releases
            budget. Ceiling-derived settlement is an internal estimate, not a provider invoice.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The totals block shared by the workspace summary and one issue drill-down.
 * Every rate carries its own numerator and denominator, and an unmeasured
 * metric keeps its status instead of a zero.
 */
export function TotalsPanel({
  totals,
  onOpenLedger,
}: {
  totals: DashboardTotals;
  onOpenLedger?: () => void;
}): ReactElement {
  return (
    <>
      <div className="dashboard-metric-grid">
        {countCard("Requests", totals.requests, "Invocation-ledger attempts")}
        {countCard("Invocations", totals.invocations, "Distinct invocation ids")}
        {countCard("Retries", totals.retries, "Attempts beyond the first invocation")}
        <MetricCard
          label="Retry rate"
          status={totals.retry_rate.status}
          value={formatRatio(
            totals.retry_rate.numerator,
            totals.retry_rate.denominator,
            totals.retry_rate.value,
          )}
          detail={
            totals.retry_rate.denominator === null
              ? METRIC_STATUS_LABELS[totals.retry_rate.status]
              : `${formatCount(totals.retry_rate.numerator)} of ${formatCount(
                  totals.retry_rate.denominator,
                )}`
          }
        />
        <MetricCard
          label="Error rate"
          status={totals.error_rate.status}
          value={formatRatio(
            totals.error_rate.numerator,
            totals.error_rate.denominator,
            totals.error_rate.value,
          )}
          detail={
            totals.error_rate.denominator === null
              ? METRIC_STATUS_LABELS[totals.error_rate.status]
              : `${formatCount(totals.error_rate.numerator)} of ${formatCount(
                  totals.error_rate.denominator,
                )}`
          }
        />
        <MetricCard
          label="Denial rate"
          status={totals.denial_rate.status}
          value={formatRatio(
            totals.denial_rate.numerator,
            totals.denial_rate.denominator,
            totals.denial_rate.value,
          )}
          detail={
            totals.denial_rate.denominator === null
              ? METRIC_STATUS_LABELS[totals.denial_rate.status]
              : `${formatCount(totals.denial_rate.numerator)} of ${formatCount(
                  totals.denial_rate.denominator,
                )} decisions`
          }
        />
        <LatencyCard label="Latency" metric={totals.latency_ms} />
        <LatencyCard label="Queue age" metric={totals.queue_age_ms} />
        <LatencyCard label="Approval wait" metric={totals.approval_wait_ms} />
        <ValidationCard metric={totals.validation_outcomes} />
        <DeliveryCard metric={totals.delivery_results} />
        <NotMeasuredCard
          label={METRIC_NAMES.connector_lag_ms ?? "Connector lag"}
          metric={totals.connector_lag_ms}
        />
        <NotMeasuredCard
          label={METRIC_NAMES.worker_utilization ?? "Worker utilization"}
          metric={totals.worker_utilization}
        />
      </div>
      <TokenSection metric={totals.tokens} />
      <div className="dashboard-two-column">
        <CostSection cost={totals.cost} {...(onOpenLedger ? { onOpenLedger } : {})} />
        <BudgetSection budget={totals.budget} />
      </div>
    </>
  );
}
