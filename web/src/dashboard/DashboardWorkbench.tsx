import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  DashboardBreakdownDimension,
  DashboardBreakdownRow,
  DashboardBucket,
  DashboardSummary,
  ForgePilotClient,
  Workspace,
} from "../api/client";
import { formatDate } from "../ui/format";
import { redactText } from "../ui/redaction";
import { Select } from "../ui/Select";
import { CostLedgerPanel } from "./CostLedgerPanel";
import { TraceViewer } from "./TraceViewer";
import {
  barMaximum,
  breakdownBars,
  BREAKDOWN_DIMENSION_LABELS,
  chartLabel,
  describeDashboardError,
  formatCount,
  formatMoney,
  formatPercent,
  METRIC_NAMES,
} from "./dashboard-format";
import type { DashboardError } from "./dashboard-format";
import { SourceTable, StatusBadge, TotalsPanel } from "./dashboard-shared";

const WINDOW_PRESETS = [
  { value: "24h", label: "Last 24 hours", hours: 24, bucket: "hour" },
  { value: "7d", label: "Last 7 days", hours: 24 * 7, bucket: "day" },
  { value: "30d", label: "Last 30 days", hours: 24 * 30, bucket: "day" },
] as const;

type WindowPreset = (typeof WINDOW_PRESETS)[number]["value"];
type Pane = "overview" | "ledger" | "trace";

function windowRange(value: WindowPreset, now = new Date()): { from: string; to: string } {
  const preset = WINDOW_PRESETS.find((entry) => entry.value === value) ?? WINDOW_PRESETS[0];
  const toMs = Math.floor(now.getTime() / 1000) * 1000;
  return {
    from: new Date(toMs - preset.hours * 3_600_000).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

function summaryKey(
  workspaceId: string,
  from: string,
  to: string,
  timezone: string,
  bucket: DashboardBucket,
  breakdown: DashboardBreakdownDimension,
): string {
  return [workspaceId, from, to, timezone, bucket, breakdown].join("\u0000");
}

/**
 * Workspace observability surface (DAT-231): aggregates, priced postings with
 * their ledger drill-down, and one issue's execution trace. Every figure comes
 * from the DAT-230 dashboard contract; missing telemetry keeps its status and
 * a null figure instead of becoming zero.
 */
export function DashboardWorkbench({ client }: { client: ForgePilotClient }): ReactElement {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState<DashboardError | undefined>(undefined);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceToken, setWorkspaceToken] = useState(0);

  const [preset, setPreset] = useState<WindowPreset>("24h");
  const [range, setRange] = useState(() => windowRange("24h"));
  const [bucket, setBucket] = useState<DashboardBucket>("hour");
  const [breakdown, setBreakdown] = useState<DashboardBreakdownDimension>("model");
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const [pane, setPane] = useState<Pane>("overview");
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [traceSeed, setTraceSeed] = useState<string>();

  const [summaryState, setSummaryState] = useState<{
    key: string;
    summary: DashboardSummary;
  }>();
  const [summaryError, setSummaryError] = useState<{ key: string; error: DashboardError }>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [breakdownLoadingMore, setBreakdownLoadingMore] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const requestRef = useRef(0);

  const queryKey =
    workspaceId === undefined
      ? ""
      : summaryKey(workspaceId, range.from, range.to, timezone, bucket, breakdown);
  const summary = summaryState?.key === queryKey ? summaryState.summary : undefined;
  const visibleError = summaryError?.key === queryKey ? summaryError.error : undefined;

  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    client
      .listWorkspaces()
      .then((entries) => {
        if (!active) return;
        setWorkspaces(entries);
        setWorkspaceError(undefined);
        const activeEntries = entries.filter((workspace) => workspace.status === "active");
        setWorkspaceId((current) => {
          if (current && activeEntries.some((workspace) => workspace.id === current))
            return current;
          return activeEntries[0]?.id;
        });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setWorkspaceError(describeDashboardError(caught));
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceToken]);

  useEffect(() => {
    if (workspaceId === undefined) return;
    let active = true;
    const requestId = ++requestRef.current;
    const key = summaryKey(workspaceId, range.from, range.to, timezone, bucket, breakdown);
    setSummaryLoading(true);
    client
      .getDashboardSummary(workspaceId, {
        from: range.from,
        to: range.to,
        timezone,
        bucket,
        breakdown,
      })
      .then((next) => {
        if (!active || requestId !== requestRef.current) return;
        setSummaryState({ key, summary: next });
        setSummaryError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== requestRef.current) return;
        setSummaryError({ key, error: describeDashboardError(caught) });
      })
      .finally(() => {
        if (active && requestId === requestRef.current) setSummaryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, range.from, range.to, timezone, bucket, breakdown, refreshToken]);

  const loadMoreBreakdown = useCallback(async (): Promise<void> => {
    if (workspaceId === undefined || summary === undefined || breakdownLoadingMore) return;
    const cursor = summary.breakdown.next_cursor;
    if (cursor === null) return;
    const requestId = requestRef.current;
    setBreakdownLoadingMore(true);
    try {
      const next = await client.getDashboardSummary(workspaceId, {
        from: range.from,
        to: range.to,
        timezone,
        bucket,
        breakdown,
        cursor,
      });
      if (requestId !== requestRef.current) return;
      setSummaryState((current) => {
        if (current?.key !== queryKey) return current;
        const known = new Set(current.summary.breakdown.rows.map((row) => row.key));
        const rows: DashboardBreakdownRow[] = [
          ...current.summary.breakdown.rows,
          ...next.breakdown.rows.filter((row) => !known.has(row.key)),
        ];
        return {
          key: queryKey,
          summary: {
            ...current.summary,
            breakdown: {
              ...next.breakdown,
              rows,
            },
          },
        };
      });
    } catch (caught: unknown) {
      if (requestId === requestRef.current) {
        setSummaryError({ key: queryKey, error: describeDashboardError(caught) });
      }
    } finally {
      setBreakdownLoadingMore(false);
    }
  }, [
    client,
    workspaceId,
    summary,
    breakdownLoadingMore,
    range.from,
    range.to,
    timezone,
    bucket,
    breakdown,
    queryKey,
  ]);

  function refresh(): void {
    setRange(windowRange(preset));
    setRefreshToken((value) => value + 1);
  }

  function changePreset(next: WindowPreset): void {
    const profile = WINDOW_PRESETS.find((entry) => entry.value === next) ?? WINDOW_PRESETS[0];
    setPreset(next);
    setRange(windowRange(next));
    setBucket(profile.bucket);
  }

  function changeWorkspace(nextId: string): void {
    setWorkspaceId(nextId);
    setMobileView("list");
  }

  function openPane(next: Pane): void {
    setPane(next);
    setMobileView("detail");
  }

  function openIssueTrace(issueId: string): void {
    setTraceSeed(issueId);
    openPane("trace");
  }

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const selectedWorkspace = activeWorkspaces.find((workspace) => workspace.id === workspaceId);
  const workspaceUnavailable =
    workspaceError !== undefined && (workspaceError.status === 404 || workspaceError.status === 0);

  return (
    <div className="workspace dashboard-workspace" data-view={mobileView}>
      <aside className="sidebar dashboard-sidebar">
        <div className="sidebar-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Dashboard</h1>
          </div>
          <button
            type="button"
            className="button button-quiet button-small"
            aria-label="Refresh dashboard"
            onClick={refresh}
            disabled={workspaceId === undefined}
          >
            ↻
          </button>
        </div>

        {activeWorkspaces.length > 1 && (
          <div className="workspace-picker" role="group" aria-label="Workspace scope">
            <label className="field-label" htmlFor="dashboard-workspace">
              Workspace scope
            </label>
            <Select
              id="dashboard-workspace"
              value={workspaceId ?? ""}
              onChange={changeWorkspace}
              options={activeWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: `${workspace.name} · ${workspace.role}`,
              }))}
            />
          </div>
        )}

        {selectedWorkspace && (
          <div className="workspace-role">
            <span className="mono">{redactText(selectedWorkspace.name)}</span>
            <span className={`role-chip role-${selectedWorkspace.role}`}>
              {selectedWorkspace.role}
              {selectedWorkspace.role === "viewer" ? " · read-only" : ""}
            </span>
          </div>
        )}

        <div className="dashboard-controls">
          <div className="dashboard-control">
            <label className="field-label" htmlFor="dashboard-window">
              Period
            </label>
            <Select
              id="dashboard-window"
              value={preset}
              onChange={(value) => changePreset(value as WindowPreset)}
              options={WINDOW_PRESETS.map((entry) => ({
                value: entry.value,
                label: entry.label,
              }))}
            />
          </div>
          <div className="dashboard-control">
            <label className="field-label" htmlFor="dashboard-breakdown">
              Breakdown
            </label>
            <Select
              id="dashboard-breakdown"
              value={breakdown}
              onChange={(value) => setBreakdown(value as DashboardBreakdownDimension)}
              options={(
                Object.keys(BREAKDOWN_DIMENSION_LABELS) as DashboardBreakdownDimension[]
              ).map((dimension) => ({
                value: dimension,
                label: BREAKDOWN_DIMENSION_LABELS[dimension],
              }))}
            />
          </div>
          {breakdown === "date" && (
            <div className="dashboard-control">
              <label className="field-label" htmlFor="dashboard-bucket">
                Bucket
              </label>
              <Select
                id="dashboard-bucket"
                value={bucket}
                onChange={(value) => setBucket(value as DashboardBucket)}
                options={[
                  { value: "hour", label: "Hour" },
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                ]}
              />
            </div>
          )}
        </div>

        <nav className="dashboard-pane-nav" aria-label="Dashboard views">
          <button
            type="button"
            className={`dashboard-pane-tab ${pane === "overview" ? "dashboard-pane-tab-active" : ""}`}
            aria-current={pane === "overview" ? "page" : undefined}
            onClick={() => openPane("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={`dashboard-pane-tab ${pane === "ledger" ? "dashboard-pane-tab-active" : ""}`}
            aria-current={pane === "ledger" ? "page" : undefined}
            onClick={() => openPane("ledger")}
          >
            Cost ledger
          </button>
          <button
            type="button"
            className={`dashboard-pane-tab ${pane === "trace" ? "dashboard-pane-tab-active" : ""}`}
            aria-current={pane === "trace" ? "page" : undefined}
            onClick={() => openPane("trace")}
          >
            Trace
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="security-note">
            <span className="security-icon" aria-hidden="true">
              ◈
            </span>
            <div>
              <strong>Metadata only</strong>
              <span>
                Financial access, captured content and quarantine are separate grants. Missing
                telemetry is reported as missing, never as zero.
              </span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel dashboard-main">
        <button type="button" className="detail-back" onClick={() => setMobileView("list")}>
          ← Dashboard
        </button>

        {pane === "overview" && (
          <section className="dashboard-pane" aria-labelledby="dashboard-overview-heading">
            <div className="dashboard-pane-heading">
              <div>
                <span className="eyebrow">Observability</span>
                <h2 id="dashboard-overview-heading">Workspace dashboard</h2>
              </div>
              {summary && (
                <span className="dashboard-mono dashboard-subline">
                  {formatDate(summary.period.from)} → {formatDate(summary.period.to)} ·{" "}
                  {summary.period.timezone} · {summary.period.bucket} · generated{" "}
                  {formatDate(summary.generated_at)}
                </span>
              )}
            </div>

            {workspaceLoading ? (
              <p className="dashboard-unavailable">Resolving workspace scope…</p>
            ) : workspaceError ? (
              <div className="dashboard-gate dashboard-gate-error" role="alert">
                <strong>
                  {workspaceError.code} · case {workspaceError.requestId ?? "unavailable"}
                </strong>
                <p>{workspaceError.message}</p>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => setWorkspaceToken((value) => value + 1)}
                >
                  Retry
                </button>
              </div>
            ) : workspaceUnavailable || workspaceId === undefined ? (
              <div className="dashboard-gate" role="note">
                <strong>No workspace available</strong>
                <p>
                  No active workspace is visible to this credential, so no aggregate is readable.
                </p>
              </div>
            ) : visibleError ? (
              <div className="dashboard-gate dashboard-gate-error" role="alert">
                <strong>
                  {visibleError.code} · case {visibleError.requestId ?? "unavailable"}
                </strong>
                <p>{visibleError.message}</p>
                {visibleError.retryable && (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={refresh}
                  >
                    Retry
                  </button>
                )}
              </div>
            ) : summaryLoading && !summary ? (
              <p className="dashboard-unavailable">Reading dashboard aggregates…</p>
            ) : !summary ? (
              <p className="dashboard-unavailable">No dashboard aggregate is available.</p>
            ) : (
              <>
                <div className="dashboard-access-row">
                  <StatusBadge tone={summary.access.financial === "granted" ? "active" : "muted"}>
                    Financial: {summary.access.financial}
                  </StatusBadge>
                  <StatusBadge tone="muted">Content: separate grant required</StatusBadge>
                  <StatusBadge tone="muted">Quarantine: separate grant required</StatusBadge>
                </div>

                <SourceTable sources={summary.sources} />

                <TotalsPanel
                  totals={summary.totals}
                  {...(summary.access.financial === "granted"
                    ? { onOpenLedger: () => openPane("ledger") }
                    : {})}
                />

                <section
                  className="card dashboard-card"
                  aria-labelledby="dashboard-breakdown-heading"
                >
                  <div className="card-heading dashboard-card-heading">
                    <div>
                      <span className="eyebrow">Breakdown</span>
                      <h3 id="dashboard-breakdown-heading">
                        By {BREAKDOWN_DIMENSION_LABELS[summary.breakdown.dimension].toLowerCase()}
                      </h3>
                    </div>
                    <StatusBadge tone={summary.breakdown.status === "ok" ? "active" : "muted"}>
                      {summary.breakdown.status.replace(/_/g, " ")}
                    </StatusBadge>
                  </div>
                  {summary.breakdown.status === "empty" ? (
                    <p className="dashboard-unavailable">
                      No {summary.breakdown.dimension} row falls in this period.
                    </p>
                  ) : summary.breakdown.status !== "ok" ? (
                    <p className="dashboard-unavailable">
                      The {summary.breakdown.dimension} breakdown is not available for this period (
                      {summary.breakdown.status.replace(/_/g, " ")}).
                    </p>
                  ) : (
                    <>
                      <BreakdownChart
                        rows={summary.breakdown.rows}
                        dimension={summary.breakdown.dimension}
                      />
                      <div className="dashboard-table-scroll">
                        <table className="dashboard-table">
                          <caption>
                            Requests, tokens, latency and cost per {summary.breakdown.dimension}
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">Key</th>
                              <th scope="col">Requests</th>
                              <th scope="col">Invocations</th>
                              <th scope="col">Retries</th>
                              <th scope="col">Error rate</th>
                              <th scope="col">p50 / p95</th>
                              <th scope="col">Known tokens</th>
                              <th scope="col">Estimated tokens</th>
                              <th scope="col">Unknown attempts</th>
                              <th scope="col">Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {summary.breakdown.rows.map((row) => (
                              <tr key={row.key}>
                                <th scope="row" className="dashboard-mono">
                                  {redactText(row.key)}
                                </th>
                                <td className="dashboard-mono">{formatCount(row.request_count)}</td>
                                <td className="dashboard-mono">
                                  {formatCount(row.invocation_count)}
                                </td>
                                <td className="dashboard-mono">{formatCount(row.retry_count)}</td>
                                <td className="dashboard-mono">{formatPercent(row.error_rate)}</td>
                                <td className="dashboard-mono">
                                  {row.latency_ms === null || row.latency_ms.p50_ms === null
                                    ? "—"
                                    : `${row.latency_ms.p50_ms} / ${row.latency_ms.p95_ms ?? "—"} ms`}
                                </td>
                                <td className="dashboard-mono">
                                  {row.tokens === null
                                    ? "—"
                                    : formatCount(row.tokens.total_tokens.known_tokens)}
                                </td>
                                <td className="dashboard-mono">
                                  {row.tokens === null
                                    ? "—"
                                    : formatCount(row.tokens.total_tokens.estimated_tokens)}
                                </td>
                                <td className="dashboard-mono">
                                  {row.tokens === null
                                    ? "—"
                                    : formatCount(row.tokens.total_tokens.unknown_attempts)}
                                </td>
                                <td className="dashboard-cost-cell">
                                  {row.cost === null
                                    ? "—"
                                    : row.cost.length === 0
                                      ? "0 postings"
                                      : row.cost.map((line) => (
                                          <span
                                            key={`${line.currency ?? "none"}-${line.cost_class}`}
                                            className="dashboard-mono"
                                          >
                                            {line.currency ?? "No currency"}: known{" "}
                                            {formatMoney(line.currency, line.known_cost)}, est.{" "}
                                            {formatMoney(line.currency, line.estimated_cost)}
                                          </span>
                                        ))}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {summary.breakdown.truncated && (
                        <p className="dashboard-fineprint">
                          Aggregate totals remain exact;{" "}
                          {formatCount(summary.breakdown.omitted_keys)} further keys were omitted
                          from this breakdown.
                        </p>
                      )}
                      {summary.breakdown.next_cursor && (
                        <button
                          type="button"
                          className="button button-quiet button-small dashboard-load-more"
                          onClick={() => void loadMoreBreakdown()}
                          disabled={breakdownLoadingMore}
                        >
                          {breakdownLoadingMore ? "Loading…" : "Load more rows"}
                        </button>
                      )}
                    </>
                  )}
                </section>

                <section
                  className="card dashboard-card"
                  aria-labelledby="dashboard-unavailable-heading"
                >
                  <div className="card-heading dashboard-card-heading">
                    <div>
                      <span className="eyebrow">Limits</span>
                      <h3 id="dashboard-unavailable-heading">Unavailable metrics</h3>
                    </div>
                  </div>
                  {summary.unavailable_metrics.length === 0 ? (
                    <p className="dashboard-unavailable">Every metric has a wired source.</p>
                  ) : (
                    <ul className="dashboard-unavailable-list">
                      {summary.unavailable_metrics.map((entry) => (
                        <li key={entry.metric}>
                          <strong>{METRIC_NAMES[entry.metric] ?? entry.metric}</strong>
                          <span>{entry.reason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="dashboard-fineprint">
                    Empty means the source is wired and the period holds no rows; missing means the
                    source is not wired. The two are never rendered as the same zero.
                  </p>
                </section>
              </>
            )}
          </section>
        )}

        {pane === "ledger" &&
          (workspaceId === undefined ? (
            <p className="dashboard-unavailable">No workspace is available for the cost ledger.</p>
          ) : (
            <CostLedgerPanel
              client={client}
              workspaceId={workspaceId}
              from={range.from}
              to={range.to}
              timezone={timezone}
              granted={summary === undefined ? undefined : summary.access.financial === "granted"}
              onOpenIssue={openIssueTrace}
            />
          ))}

        {pane === "trace" &&
          (workspaceId === undefined ? (
            <p className="dashboard-unavailable">No workspace is available for the trace viewer.</p>
          ) : (
            <TraceViewer
              client={client}
              workspaceId={workspaceId}
              from={range.from}
              to={range.to}
              timezone={timezone}
              {...(traceSeed !== undefined ? { seedIssueId: traceSeed } : {})}
            />
          ))}
      </main>
    </div>
  );
}

function BreakdownChart({
  rows,
  dimension,
}: {
  rows: DashboardBreakdownRow[];
  dimension: DashboardBreakdownDimension;
}): ReactElement {
  const bars = breakdownBars(rows);
  const max = barMaximum(bars);
  const rowHeight = 32;
  const width = 760;
  const labelWidth = 190;
  const chartWidth = width - labelWidth - 8;
  const height = Math.max(bars.length * rowHeight, rowHeight);

  return (
    <figure className="dashboard-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chartLabel(dimension, bars)}>
        <defs>
          <pattern
            id="dashboard-estimated-hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" strokeWidth="2" />
          </pattern>
        </defs>
        {bars.map((bar, index) => {
          const y = index * rowHeight;
          const known = bar.known ?? 0;
          const estimated = bar.estimated ?? 0;
          const knownWidth = max > 0 ? (known / max) * chartWidth : 0;
          const estimatedWidth = max > 0 ? (estimated / max) * chartWidth : 0;
          return (
            <g key={bar.key}>
              <text x="0" y={y + 19} className="dashboard-chart-label">
                {redactText(bar.key).slice(0, 26)}
                {bar.key.length > 26 ? "…" : ""}
              </text>
              {bar.known === null && bar.estimated === null ? (
                <text x={labelWidth} y={y + 19} className="dashboard-chart-empty">
                  not reported
                </text>
              ) : (
                <>
                  <rect
                    x={labelWidth}
                    y={y + 8}
                    width={knownWidth}
                    height={14}
                    rx="3"
                    fill="var(--accent-text)"
                  />
                  <rect
                    x={labelWidth + knownWidth}
                    y={y + 8}
                    width={estimatedWidth}
                    height={14}
                    rx="3"
                    fill="url(#dashboard-estimated-hatch)"
                  />
                </>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption>
        Known and estimated tokens per {dimension}. Unknown attempts stay in the table; they are
        never drawn as a zero-length value.
      </figcaption>
    </figure>
  );
}
