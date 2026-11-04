import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  DashboardCostComponent,
  DashboardCostItem,
  DashboardCostItemPage,
  ForgePilotClient,
} from "../api/client";
import { formatDate } from "../ui/format";
import { redactText } from "../ui/redaction";
import {
  COMPLETENESS_LABELS,
  completenessTone,
  describeDashboardError,
  formatCount,
  formatMoney,
} from "./dashboard-format";
import type { DashboardError } from "./dashboard-format";
import { StatusBadge } from "./dashboard-shared";

interface CostLedgerPanelProps {
  client: ForgePilotClient;
  workspaceId: string;
  from: string;
  to: string;
  timezone: string;
  /** `undefined` means the summary has not settled yet; `false` is a role gate. */
  granted: boolean | undefined;
  onOpenIssue: (issueId: string) => void;
}

function ledgerKey(workspaceId: string, from: string, to: string, timezone: string): string {
  return [workspaceId, from, to, timezone].join("\u0000");
}

/**
 * Cost item page with its invocation-ledger drill-down (DAT-230). Every item is
 * one immutable posting: components keep their bound rate revision, unknown
 * costs stay null, and currencies are never merged.
 */
export function CostLedgerPanel({
  client,
  workspaceId,
  from,
  to,
  timezone,
  granted,
  onOpenIssue,
}: CostLedgerPanelProps): ReactElement {
  const queryKey = ledgerKey(workspaceId, from, to, timezone);
  const [page, setPage] = useState<{ key: string; page: DashboardCostItemPage }>();
  const [error, setError] = useState<{ key: string; error: DashboardError }>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [requestToken, setRequestToken] = useState(0);
  const [selectedPostingId, setSelectedPostingId] = useState<string>();
  const requestRef = useRef(0);

  const visiblePage = page?.key === queryKey ? page.page : undefined;
  const visibleError = error?.key === queryKey ? error.error : undefined;
  const items = visiblePage?.items ?? [];
  const selected = items.find((item) => item.posting_id === selectedPostingId);

  useEffect(() => {
    if (granted !== true) {
      setPage(undefined);
      return;
    }
    let active = true;
    const requestId = ++requestRef.current;
    setLoading(true);
    client
      .listDashboardCostItems(workspaceId, { from, to, timezone })
      .then((next) => {
        if (!active || requestId !== requestRef.current) return;
        setPage({ key: queryKey, page: next });
        setError(undefined);
        setSelectedPostingId(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== requestRef.current) return;
        setError({ key: queryKey, error: describeDashboardError(caught) });
      })
      .finally(() => {
        if (active && requestId === requestRef.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, from, to, timezone, granted, queryKey, requestToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (granted !== true || !visiblePage?.next_cursor || loadingMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const next = await client.listDashboardCostItems(workspaceId, {
        from,
        to,
        timezone,
        cursor: visiblePage.next_cursor,
      });
      if (requestId !== requestRef.current) return;
      setPage((current) => {
        if (current?.key !== queryKey) return current;
        const known = new Set(current.page.items.map((item) => item.posting_id));
        return {
          key: queryKey,
          page: {
            ...current.page,
            items: [
              ...current.page.items,
              ...next.items.filter((item) => !known.has(item.posting_id)),
            ],
            next_cursor: next.next_cursor,
            total: next.total,
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
  }, [client, workspaceId, from, to, timezone, granted, visiblePage, loadingMore, queryKey]);

  return (
    <section className="dashboard-pane" aria-labelledby="dashboard-ledger-heading">
      <div className="dashboard-pane-heading">
        <div>
          <span className="eyebrow">Financial</span>
          <h2 id="dashboard-ledger-heading">Cost ledger</h2>
        </div>
        {visiblePage && (
          <span className="dashboard-mono dashboard-subline">
            {formatDate(visiblePage.period.from)} → {formatDate(visiblePage.period.to)} ·{" "}
            {formatCount(visiblePage.total)} postings
          </span>
        )}
      </div>
      <p className="dashboard-fineprint">
        Each item is one immutable cost posting. Unknown components stay null, rate revisions are
        the ones bound at posting time, and currencies are never merged.
      </p>

      {granted === undefined ? (
        <p className="dashboard-unavailable">Resolving financial access…</p>
      ) : granted === false ? (
        <div className="dashboard-gate" role="note">
          <strong>Financial access restricted</strong>
          <p>
            Financial metrics are readable by workspace owners and admins only. Cost and budget
            figures are omitted, not shown as zero.
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
      ) : loading && !visiblePage ? (
        <p className="dashboard-unavailable">Reading cost postings…</p>
      ) : visiblePage && visiblePage.ledger_lookup === "missing_source" ? (
        <div className="dashboard-gate" role="note">
          <strong>Invocation ledger not wired</strong>
          <p>
            Cost postings exist, but no invocation ledger is wired to join them to an attempt. The
            drill-down stays empty rather than guessed.
          </p>
        </div>
      ) : !visiblePage ? (
        <p className="dashboard-unavailable">No cost page is available for this period.</p>
      ) : items.length === 0 ? (
        <p className="dashboard-unavailable">No priced posting falls in this period.</p>
      ) : (
        <>
          <div className="dashboard-ledger-grid">
            <ul className="dashboard-ledger-list" aria-label="Cost postings">
              {items.map((item) => (
                <li key={item.posting_id}>
                  <button
                    type="button"
                    className={`dashboard-ledger-item ${
                      item.posting_id === selectedPostingId ? "dashboard-ledger-item-selected" : ""
                    }`}
                    onClick={() => setSelectedPostingId(item.posting_id)}
                    aria-pressed={item.posting_id === selectedPostingId}
                  >
                    <span className="dashboard-ledger-topline">
                      <StatusBadge tone={completenessTone(item.completeness)}>
                        {COMPLETENESS_LABELS[item.completeness]}
                      </StatusBadge>
                      <span className="dashboard-mono">{item.currency ?? "No currency"}</span>
                      <span className="dashboard-mono">{formatDate(item.applicable_time)}</span>
                    </span>
                    <span className="dashboard-ledger-model dashboard-mono">
                      {redactText(item.model_id ?? item.requested_model ?? item.kind)}
                    </span>
                    <span className="dashboard-ledger-meta">
                      {item.kind} · {item.target.replace(/_/g, " ")} ·{" "}
                      {formatCount(item.components.length)} components ·{" "}
                      {formatCount(item.adjustments.length)} adjustments
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="dashboard-ledger-detail">
              {selected ? (
                <CostItemDetail item={selected} onOpenIssue={onOpenIssue} />
              ) : (
                <p className="dashboard-unavailable">Select a posting to inspect its components.</p>
              )}
            </div>
          </div>
          {visiblePage.next_cursor && (
            <button
              type="button"
              className="button button-quiet button-small dashboard-load-more"
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more postings"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ComponentRow({ component }: { component: DashboardCostComponent }): ReactElement {
  return (
    <tr>
      <th scope="row">{component.category.replace(/_/g, " ")}</th>
      <td>{component.cost_class.replace(/_/g, " ")}</td>
      <td className="dashboard-mono">
        {component.chargeable_units === null
          ? "—"
          : `${formatCount(component.chargeable_units)} ${component.unit}`}
      </td>
      <td className="dashboard-mono">
        {component.rate === null ? "—" : component.rate}
        {component.rate_revision_id !== null && (
          <span className="dashboard-rate-revision">{component.rate_revision_id}</span>
        )}
      </td>
      <td className="dashboard-mono">{component.divisor === null ? "—" : component.divisor}</td>
      <td className="dashboard-mono">
        {component.cost === null ? (
          <>
            Unknown
            {component.unknown_reason !== null && (
              <span className="dashboard-rate-revision">{component.unknown_reason}</span>
            )}
          </>
        ) : (
          formatMoney(component.currency, component.cost)
        )}
      </td>
      <td>
        <StatusBadge tone={completenessTone(component.completeness)}>
          {COMPLETENESS_LABELS[component.completeness]}
        </StatusBadge>
      </td>
    </tr>
  );
}

function CostItemDetail({
  item,
  onOpenIssue,
}: {
  item: DashboardCostItem;
  onOpenIssue: (issueId: string) => void;
}): ReactElement {
  const entry = item.ledger_entry;
  return (
    <section className="card dashboard-card" aria-labelledby="dashboard-posting-heading">
      <div className="card-heading dashboard-card-heading">
        <div>
          <span className="eyebrow">Posting</span>
          <h3 id="dashboard-posting-heading" className="dashboard-mono">
            {item.posting_id}
          </h3>
        </div>
        <StatusBadge tone={completenessTone(item.completeness)}>
          {COMPLETENESS_LABELS[item.completeness]}
        </StatusBadge>
      </div>
      <div className="dashboard-table-scroll">
        <table className="dashboard-table">
          <caption>Chargeable components with their bound rate revision</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Class</th>
              <th scope="col">Units</th>
              <th scope="col">Rate / revision</th>
              <th scope="col">Divisor</th>
              <th scope="col">Cost</th>
              <th scope="col">Completeness</th>
            </tr>
          </thead>
          <tbody>
            {item.components.map((component) => (
              <ComponentRow key={component.category} component={component} />
            ))}
          </tbody>
        </table>
      </div>

      {item.adjustments.length > 0 && (
        <div className="dashboard-adjustments">
          <h4>Linked adjustments</h4>
          <ul>
            {item.adjustments.map((adjustment) => (
              <li key={adjustment.adjustment_id}>
                <div className="dashboard-adjustment-heading">
                  <strong>{adjustment.reason.replace(/_/g, " ")}</strong>
                  <span className="dashboard-mono">{adjustment.source}</span>
                  <span className="dashboard-mono">{formatDate(adjustment.created_at)}</span>
                </div>
                {adjustment.note !== null && <p>{adjustment.note}</p>}
                <ul className="dashboard-adjustment-components">
                  {adjustment.components.map((component) => (
                    <li key={component.category} className="dashboard-mono">
                      {component.category}:{" "}
                      {component.corrected_cost === null
                        ? "unknown"
                        : formatMoney(component.corrected_currency, component.corrected_cost)}
                      {component.corrected_rate_revision_id !== null &&
                        ` · ${component.corrected_rate_revision_id}`}
                      {` · ${COMPLETENESS_LABELS[component.completeness]}`}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="dashboard-fineprint">
            A correction is a linked entry, never a rewrite of the historical charge.
          </p>
        </div>
      )}

      <div className="dashboard-ledger-entry">
        <h4>Invocation ledger entry</h4>
        {item.ledger_lookup !== "ok" || entry === null ? (
          <p className="dashboard-unavailable">
            {item.ledger_lookup === "missing_source"
              ? "The invocation ledger is not wired, so this posting has no ledger entry."
              : item.ledger_lookup === "infrastructure"
                ? "An infrastructure posting has no invocation attempt."
                : "No matching (invocation_id, attempt) in the selected period."}
          </p>
        ) : (
          <>
            <dl className="dashboard-facts">
              <div>
                <dt>Invocation</dt>
                <dd className="dashboard-mono">
                  {entry.invocation_id} · attempt {entry.attempt}
                </dd>
              </div>
              <div>
                <dt>Issue</dt>
                <dd className="dashboard-mono">{redactText(entry.issue_id)}</dd>
              </div>
              <div>
                <dt>Run</dt>
                <dd className="dashboard-mono">{entry.run_id}</dd>
              </div>
              <div>
                <dt>Trace</dt>
                <dd className="dashboard-mono">{entry.trace_id}</dd>
              </div>
              <div>
                <dt>Provider / API</dt>
                <dd className="dashboard-mono">
                  {entry.provider} · {entry.api}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd className="dashboard-mono">
                  {redactText(entry.requested_model)}
                  {entry.returned_model !== null && ` → ${redactText(entry.returned_model)}`}
                </dd>
              </div>
              <div>
                <dt>Finish status</dt>
                <dd className="dashboard-mono">{entry.finish_status}</dd>
              </div>
              <div>
                <dt>Usage</dt>
                <dd>
                  {COMPLETENESS_LABELS[entry.usage_completeness]} ·{" "}
                  <span className="dashboard-mono">{entry.usage_provenance}</span>
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd className="dashboard-mono">{formatDate(entry.started_at)}</dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd className="dashboard-mono">{formatDate(entry.ended_at)}</dd>
              </div>
              <div>
                <dt>Provider request</dt>
                <dd className="dashboard-mono">{entry.provider_request_id ?? "—"}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => onOpenIssue(entry.issue_id)}
            >
              Open issue trace
            </button>
          </>
        )}
      </div>
    </section>
  );
}
