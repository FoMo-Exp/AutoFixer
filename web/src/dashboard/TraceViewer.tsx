import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { DashboardIssueDrilldown, DashboardTraceEvent, ForgePilotClient } from "../api/client";
import { formatDate } from "../ui/format";
import { redactText } from "../ui/redaction";
import { describeDashboardError, formatCount, traceFlags } from "./dashboard-format";
import type { DashboardError } from "./dashboard-format";
import { metricTone, SourceTable, StatusBadge, TotalsPanel } from "./dashboard-shared";
import { METRIC_STATUS_LABELS } from "./dashboard-format";

interface TraceViewerProps {
  client: ForgePilotClient;
  workspaceId: string;
  from: string;
  to: string;
  timezone: string;
  /** Set when another surface (a cost entry) asks to follow its issue. */
  seedIssueId?: string;
}

function traceKey(workspaceId: string, issueId: string, from: string, to: string): string {
  return [workspaceId, issueId, from, to].join("\u0000");
}

/**
 * Issue → execution trace → evidence references (DAT-230). The service serves
 * metadata only (`payload_included: false`); this view never asks for captured
 * content or quarantine material and labels missing, late and truncated
 * records explicitly.
 */
export function TraceViewer({
  client,
  workspaceId,
  from,
  to,
  timezone,
  seedIssueId,
}: TraceViewerProps): ReactElement {
  const [issueInput, setIssueInput] = useState(seedIssueId ?? "");
  const [submitted, setSubmitted] = useState<string | undefined>(seedIssueId);
  const [state, setState] = useState<{
    key: string;
    drilldown: DashboardIssueDrilldown;
  }>();
  const [error, setError] = useState<{ key: string; error: DashboardError }>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [requestToken, setRequestToken] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (seedIssueId === undefined || seedIssueId.length === 0) return;
    setIssueInput(seedIssueId);
    setSubmitted(seedIssueId);
  }, [seedIssueId]);

  const queryKey = submitted === undefined ? "" : traceKey(workspaceId, submitted, from, to);
  const drilldown = state?.key === queryKey ? state.drilldown : undefined;
  const visibleError = error?.key === queryKey ? error.error : undefined;

  useEffect(() => {
    if (submitted === undefined || submitted.length === 0) return;
    let active = true;
    const requestId = ++requestRef.current;
    const key = traceKey(workspaceId, submitted, from, to);
    setLoading(true);
    client
      .getDashboardIssueDrilldown(workspaceId, submitted, { from, to, timezone })
      .then((next) => {
        if (!active || requestId !== requestRef.current) return;
        setState({ key, drilldown: next });
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== requestRef.current) return;
        setError({ key, error: describeDashboardError(caught) });
      })
      .finally(() => {
        if (active && requestId === requestRef.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, submitted, from, to, timezone, requestToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (submitted === undefined || drilldown?.trace.next_cursor == null || loadingMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const next = await client.getDashboardIssueDrilldown(workspaceId, submitted, {
        from,
        to,
        timezone,
        cursor: drilldown.trace.next_cursor,
      });
      if (requestId !== requestRef.current) return;
      setState((current) => {
        if (current?.key !== queryKey) return current;
        const seen = new Set(
          current.drilldown.trace.events.map((event) => `${event.source}\u0000${event.event_id}`),
        );
        const merged = next.trace.events.filter(
          (event) => !seen.has(`${event.source}\u0000${event.event_id}`),
        );
        return {
          key: queryKey,
          drilldown: {
            ...current.drilldown,
            trace: {
              ...current.drilldown.trace,
              events: [...current.drilldown.trace.events, ...merged],
              next_cursor: next.trace.next_cursor,
            },
          },
        };
      });
    } catch (caught: unknown) {
      if (requestId === requestRef.current) {
        setError({ key: queryKey, error: describeDashboardError(caught) });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [client, workspaceId, submitted, from, to, timezone, drilldown, loadingMore, queryKey]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const issueId = issueInput.trim();
    if (issueId.length === 0) return;
    setSubmitted(issueId);
  }

  const events = drilldown?.trace.events ?? [];

  return (
    <section className="dashboard-pane" aria-labelledby="dashboard-trace-heading">
      <div className="dashboard-pane-heading">
        <div>
          <span className="eyebrow">Execution</span>
          <h2 id="dashboard-trace-heading">Trace viewer</h2>
        </div>
        {drilldown && (
          <span className="dashboard-mono dashboard-subline">
            {redactText(drilldown.issue_id)} · {formatDate(drilldown.period.from)} →{" "}
            {formatDate(drilldown.period.to)}
          </span>
        )}
      </div>
      <p className="dashboard-fineprint">
        Trace events are metadata only. Payloads, captured content and quarantine material need
        separate grants and are never served by this view.
      </p>

      <form className="dashboard-trace-form" onSubmit={handleSubmit}>
        <div className="dashboard-trace-field">
          <label className="field-label" htmlFor="dashboard-issue-id">
            Issue
          </label>
          <input
            id="dashboard-issue-id"
            className="dashboard-input dashboard-mono"
            value={issueInput}
            onChange={(event) => setIssueInput(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="button button-primary button-small">
          Open trace
        </button>
      </form>

      {submitted === undefined ? (
        <div className="dashboard-gate" role="note">
          <strong>Follow one issue</strong>
          <p>
            Enter an issue id from this workspace to follow its runs, causal trace, artifact and
            delivery references. An issue with no record in the period is shown as empty, not
            inferred.
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
              onClick={() => setRequestToken((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      ) : loading && !drilldown ? (
        <p className="dashboard-unavailable">Reading issue trace…</p>
      ) : !drilldown ? (
        <p className="dashboard-unavailable">No trace is available for this issue.</p>
      ) : (
        <>
          <div className="dashboard-access-row">
            <StatusBadge tone="muted">Content: separate grant required</StatusBadge>
            <StatusBadge tone="muted">Quarantine: separate grant required</StatusBadge>
            <StatusBadge tone="neutral">
              Payload included: {drilldown.content.payload_included ? "yes" : "no"}
            </StatusBadge>
          </div>

          <SourceTable sources={drilldown.sources} />

          <section className="card dashboard-card" aria-labelledby="dashboard-trace-events-heading">
            <div className="card-heading dashboard-card-heading">
              <div>
                <span className="eyebrow">Causal trace</span>
                <h3 id="dashboard-trace-events-heading">
                  {formatCount(events.length)} event{events.length === 1 ? "" : "s"}
                </h3>
              </div>
              <StatusBadge tone={metricTone(drilldown.trace.status)}>
                {METRIC_STATUS_LABELS[drilldown.trace.status]}
              </StatusBadge>
            </div>

            {drilldown.trace.status === "missing_source" ? (
              <p className="dashboard-unavailable">
                The trace source is not wired, so no execution path is reported for this issue.
              </p>
            ) : drilldown.trace.status === "empty" ? (
              <p className="dashboard-unavailable">
                No trace event for this issue falls in the selected period.
              </p>
            ) : (
              <>
                <div className="dashboard-trace-freshness">
                  <span>
                    Watermark{" "}
                    <span className="dashboard-mono">
                      {drilldown.trace.freshness?.event_time_watermark === null ||
                      drilldown.trace.freshness === null
                        ? "—"
                        : formatDate(drilldown.trace.freshness.event_time_watermark)}
                    </span>
                  </span>
                  <span>
                    As of{" "}
                    <span className="dashboard-mono">
                      {drilldown.trace.freshness?.as_of === null ||
                      drilldown.trace.freshness === null
                        ? "—"
                        : formatDate(drilldown.trace.freshness.as_of)}
                    </span>
                  </span>
                  {drilldown.trace.completeness === null ? (
                    <StatusBadge tone="muted">Completeness not reported</StatusBadge>
                  ) : drilldown.trace.completeness.complete ? (
                    <StatusBadge tone="active">Complete</StatusBadge>
                  ) : (
                    <StatusBadge tone="attention">
                      Incomplete · {formatCount(drilldown.trace.completeness.missing_ranges)}{" "}
                      missing ranges ·{" "}
                      {formatCount(drilldown.trace.completeness.truncated_event_refs)} truncated
                      refs
                    </StatusBadge>
                  )}
                </div>

                <ol className="dashboard-trace-list">
                  {events.map((event) => (
                    <TraceEventItem key={`${event.source}\u0000${event.event_id}`} event={event} />
                  ))}
                </ol>
                {drilldown.trace.next_cursor && (
                  <button
                    type="button"
                    className="button button-quiet button-small dashboard-load-more"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading…" : "Load more events"}
                  </button>
                )}
              </>
            )}
          </section>

          <section className="card dashboard-card" aria-labelledby="dashboard-runs-heading">
            <div className="card-heading dashboard-card-heading">
              <div>
                <span className="eyebrow">Execution</span>
                <h3 id="dashboard-runs-heading">Runs</h3>
              </div>
              <span className="dashboard-mono">{formatCount(drilldown.runs.length)}</span>
            </div>
            {drilldown.runs.length === 0 ? (
              <p className="dashboard-unavailable">No run carries a trace event in this period.</p>
            ) : (
              <div className="dashboard-table-scroll">
                <table className="dashboard-table">
                  <caption>Runs observed for this issue</caption>
                  <thead>
                    <tr>
                      <th scope="col">Run</th>
                      <th scope="col">Tasks</th>
                      <th scope="col">Events</th>
                      <th scope="col">First event</th>
                      <th scope="col">Last event</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drilldown.runs.map((run) => (
                      <tr key={run.run_id}>
                        <th scope="row" className="dashboard-mono">
                          {run.run_id}
                        </th>
                        <td className="dashboard-mono">{run.task_ids.join(", ") || "—"}</td>
                        <td className="dashboard-mono">{formatCount(run.event_count)}</td>
                        <td className="dashboard-mono">{formatDate(run.first_event_at)}</td>
                        <td className="dashboard-mono">{formatDate(run.last_event_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card dashboard-card" aria-labelledby="dashboard-references-heading">
            <div className="card-heading dashboard-card-heading">
              <div>
                <span className="eyebrow">Evidence</span>
                <h3 id="dashboard-references-heading">References</h3>
              </div>
              {drilldown.references.truncated && (
                <StatusBadge tone="attention">Truncated</StatusBadge>
              )}
            </div>
            <dl className="dashboard-facts">
              <div>
                <dt>Artifacts</dt>
                <dd className="dashboard-chip-list">
                  {drilldown.references.artifact_ids.length === 0
                    ? "—"
                    : drilldown.references.artifact_ids.map((id) => (
                        <span key={id} className="dashboard-chip dashboard-mono">
                          {id}
                        </span>
                      ))}
                </dd>
              </div>
              <div>
                <dt>Deliveries</dt>
                <dd className="dashboard-chip-list">
                  {drilldown.references.delivery_ids.length === 0
                    ? "—"
                    : drilldown.references.delivery_ids.map((id) => (
                        <span key={id} className="dashboard-chip dashboard-mono">
                          {id}
                        </span>
                      ))}
                </dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd className="dashboard-chip-list">
                  {drilldown.references.evidence_refs.length === 0
                    ? "—"
                    : drilldown.references.evidence_refs.map((id) => (
                        <span key={id} className="dashboard-chip dashboard-mono">
                          {id}
                        </span>
                      ))}
                </dd>
              </div>
              <div>
                <dt>Tasks</dt>
                <dd className="dashboard-chip-list">
                  {drilldown.references.task_ids.length === 0
                    ? "—"
                    : drilldown.references.task_ids.map((id) => (
                        <span key={id} className="dashboard-chip dashboard-mono">
                          {id}
                        </span>
                      ))}
                </dd>
              </div>
            </dl>
            <p className="dashboard-fineprint">
              References are identifiers only. The viewer never fetches artifact content, expands
              evidence, or reconstructs quarantine material.
            </p>
          </section>

          <TotalsPanel totals={drilldown.totals} />
        </>
      )}
    </section>
  );
}

function TraceEventItem({ event }: { event: DashboardTraceEvent }): ReactElement {
  const flags = traceFlags(event);
  return (
    <li className="dashboard-trace-event">
      <div className="dashboard-trace-event-topline">
        <span className="dashboard-trace-kind dashboard-mono">{event.kind}</span>
        <span className="dashboard-mono">{event.source}</span>
        <span className="dashboard-mono">{formatDate(event.event_time)}</span>
        {flags.map((flag) => (
          <StatusBadge key={flag} tone={flag === "Truncated" ? "attention" : "neutral"}>
            {flag}
          </StatusBadge>
        ))}
      </div>
      <dl className="dashboard-trace-facts">
        <div>
          <dt>Ingested</dt>
          <dd className="dashboard-mono">{formatDate(event.ingest_time)}</dd>
        </div>
        <div>
          <dt>Trace / span</dt>
          <dd className="dashboard-mono">
            {event.trace_id} · {event.span_id}
          </dd>
        </div>
        <div>
          <dt>Event</dt>
          <dd className="dashboard-mono">
            {event.event_id} · v{event.version} · seq {event.sequence}
          </dd>
        </div>
        <div>
          <dt>Issue / task / run</dt>
          <dd className="dashboard-mono">
            {event.issue_id ?? "—"} · {event.task_id ?? "—"} · {event.run_id ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd className="dashboard-mono">
            {event.agent_id ?? "—"}
            {event.agent_config_revision !== null && ` @ ${event.agent_config_revision}`}
          </dd>
        </div>
        <div>
          <dt>Invocation</dt>
          <dd className="dashboard-mono">{event.invocation_id ?? "—"}</dd>
        </div>
        <div>
          <dt>Tool / artifact / delivery</dt>
          <dd className="dashboard-mono">
            {event.tool_id ?? "—"} · {event.artifact_id ?? "—"} · {event.delivery_id ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Evidence refs</dt>
          <dd className="dashboard-mono">{event.evidence_refs.join(", ") || "—"}</dd>
        </div>
      </dl>
      {Object.keys(event.labels).length > 0 && (
        <ul className="dashboard-label-list" aria-label="Metric-safe labels">
          {Object.entries(event.labels).map(([key, value]) => (
            <li key={key} className="dashboard-mono">
              {key}={value}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
