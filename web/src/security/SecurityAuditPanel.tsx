import { useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  ForgePilotClient,
  SecurityAuditEntry,
  SecurityAuditEventType,
  SecurityAuditExport,
  SecurityAuditExportRequest,
  SecurityAuditQuery,
} from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import { Select } from "../ui/Select";
import { SecurityEmptyState, SecurityErrorNotice } from "./SecurityNotice";
import {
  describeSecurityError,
  formatSecurityTime,
  securityEventLabel,
  SECURITY_EVENT_OPTIONS,
} from "./security-format";
import type { SecurityErrorDescription } from "./security-format";

interface SecurityAuditPanelProps {
  client: ForgePilotClient;
  workspaceId: string;
  canAdminister: boolean;
}

interface AuditFilters {
  purpose: string;
  case_id: string;
  event_type: SecurityAuditEventType | "all";
  from: string;
  to: string;
}

/**
 * Purpose starts empty on purpose: the operator must state why this access
 * happens, and that statement is what the service records. A prefilled
 * generic value would make every read look like a stated intent.
 */
const EMPTY_FILTERS: AuditFilters = {
  purpose: "",
  case_id: "",
  event_type: "all",
  from: "",
  to: "",
};

function isoOrUndefined(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The tamper-evident, non-secret audit trail. Reads and exports are audited
 * themselves, so the panel never polls: each read is an explicit operator
 * action with a stated purpose. The service refuses to serve unverified data
 * when the hash chain fails, and this view repeats that refusal verbatim.
 */
export function SecurityAuditPanel({
  client,
  workspaceId,
  canAdminister,
}: SecurityAuditPanelProps): ReactElement {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [activeQuery, setActiveQuery] = useState<SecurityAuditQuery>();
  const [items, setItems] = useState<SecurityAuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [writeError, setWriteError] = useState<SecurityErrorDescription>();
  const [readError, setReadError] = useState<SecurityErrorDescription>();
  const [exportResult, setExportResult] = useState<SecurityAuditExport>();
  const [exportError, setExportError] = useState<SecurityErrorDescription>();
  const [busy, setBusy] = useState<string>();
  const requestRef = useRef(0);
  const exportKeys = useRef(new CreateIdempotencyKeys());

  function invalidQuery(message: string): void {
    setWriteError({
      code: "AUDIT_QUERY_INVALID",
      message,
      status: 0,
      retryable: false,
      nextAction: null,
    });
  }

  function queryFromFilters(cursor?: string): SecurityAuditQuery | undefined {
    const purpose = filters.purpose.trim();
    if (!purpose) {
      invalidQuery("A non-secret stated purpose is required; it is recorded with the read.");
      return undefined;
    }
    const from = isoOrUndefined(filters.from);
    if (filters.from && !from) {
      invalidQuery("The lower date bound is not a valid timestamp.");
      return undefined;
    }
    const to = isoOrUndefined(filters.to);
    if (filters.to && !to) {
      invalidQuery("The upper date bound is not a valid timestamp.");
      return undefined;
    }
    return {
      purpose,
      ...(filters.case_id.trim() ? { case_id: filters.case_id.trim() } : {}),
      ...(filters.event_type === "all" ? {} : { event_type: filters.event_type }),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(cursor ? { cursor } : {}),
    };
  }

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const query = queryFromFilters();
    if (!query) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setWriteError(undefined);
    setActiveQuery(query);
    client
      .readSecurityAuditTrail(workspaceId, query)
      .then((page) => {
        if (requestRef.current !== requestId) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
        setRead(true);
        setReadError(undefined);
      })
      .catch((caught: unknown) => {
        if (requestRef.current === requestId) setReadError(describeSecurityError(caught));
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || !activeQuery || loadingMore) return;
    const requestId = requestRef.current;
    setLoadingMore(true);
    try {
      const page = await client.readSecurityAuditTrail(workspaceId, {
        ...activeQuery,
        cursor: nextCursor,
      });
      if (requestId !== requestRef.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (requestId === requestRef.current) setReadError(describeSecurityError(caught));
    } finally {
      setLoadingMore(false);
    }
  }

  async function runExport(): Promise<void> {
    const purpose = filters.purpose.trim();
    if (!purpose) {
      setExportError({
        code: "AUDIT_QUERY_INVALID",
        message: "A stated purpose is required for an export.",
        status: 0,
        retryable: false,
        nextAction: null,
      });
      return;
    }
    const body: SecurityAuditExportRequest = {
      purpose,
      ...(filters.case_id.trim() ? { case_id: filters.case_id.trim() } : {}),
      ...(filters.event_type === "all" ? {} : { event_type: filters.event_type }),
      ...(isoOrUndefined(filters.from) ? { from: isoOrUndefined(filters.from) } : {}),
      ...(isoOrUndefined(filters.to) ? { to: isoOrUndefined(filters.to) } : {}),
    };
    const key = exportKeys.current.forInput(body);
    setBusy("export");
    setExportError(undefined);
    try {
      const result = await client.exportSecurityAuditTrail(workspaceId, body, key);
      exportKeys.current.complete(body);
      setExportResult(result);
      if (typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
        );
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = `security-audit-${workspaceId}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
    } catch (caught) {
      setExportError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="security-audit" aria-labelledby="security-audit-heading">
      <header className="detail-header">
        <div className="detail-heading">
          <span className="eyebrow">Tamper-evident · non-secret</span>
          <h2 id="security-audit-heading">Security audit trail</h2>
          <div className="detail-subline">
            <span>{items.length} events loaded</span>
            <span className="divider">/</span>
            <span>reads and exports are audited</span>
          </div>
        </div>
      </header>

      <section className="card security-card">
        <form className="security-form" onSubmit={applyFilters}>
          <div className="security-form-row">
            <label className="field-block security-grow">
              <span className="field-label">Stated purpose (required, non-secret)</span>
              <input
                className="security-input"
                value={filters.purpose}
                maxLength={500}
                placeholder="Why are you reading this trail?"
                onChange={(event) =>
                  setFilters((current) => ({ ...current, purpose: event.target.value }))
                }
              />
            </label>
            <label className="field-block">
              <span className="field-label">Case id (optional)</span>
              <input
                className="security-input mono"
                value={filters.case_id}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, case_id: event.target.value }))
                }
              />
            </label>
            <div className="field-block">
              <label className="field-label" htmlFor="audit-event-type">
                Event type
              </label>
              <Select
                id="audit-event-type"
                value={filters.event_type}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    event_type: value as SecurityAuditEventType | "all",
                  }))
                }
                options={[{ value: "all", label: "All events" }, ...SECURITY_EVENT_OPTIONS]}
              />
            </div>
          </div>
          <div className="security-form-row">
            <label className="field-block">
              <span className="field-label">From (optional)</span>
              <input
                className="security-input"
                type="datetime-local"
                value={filters.from}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, from: event.target.value }))
                }
              />
            </label>
            <label className="field-block">
              <span className="field-label">To (optional)</span>
              <input
                className="security-input"
                type="datetime-local"
                value={filters.to}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, to: event.target.value }))
                }
              />
            </label>
            <div className="transition-actions">
              <button
                type="submit"
                className="button button-secondary button-small"
                disabled={loading}
              >
                {loading ? "Reading…" : "Read trail"}
              </button>
              <button
                type="button"
                className="button button-quiet button-small"
                disabled={!canAdminister || busy !== undefined}
                title={
                  canAdminister
                    ? undefined
                    : "Audit export requires the enterprise security administrator duty."
                }
                onClick={() => void runExport()}
              >
                {busy === "export" ? "Exporting…" : "Export filtered slice"}
              </button>
            </div>
          </div>
        </form>
        {writeError && (
          <SecurityErrorNotice error={writeError} onDismiss={() => setWriteError(undefined)} />
        )}
        {exportError && (
          <SecurityErrorNotice error={exportError} onDismiss={() => setExportError(undefined)} />
        )}
        {exportResult && (
          <p className="security-notice" role="status">
            Exported {exportResult.event_count} events at{" "}
            {formatSecurityTime(exportResult.exported_at)}
            {canAdminister ? " · download started" : ""}. The export is itself an audited event.
          </p>
        )}
        {!canAdminister && (
          <p className="security-hint">
            Exporting the trail requires the enterprise security administrator duty. Reads remain
            available to handlers and independent reviewers in scope.
          </p>
        )}
      </section>

      {readError && (
        <SecurityErrorNotice error={readError} onDismiss={() => setReadError(undefined)} />
      )}

      {!read ? (
        <SecurityEmptyState>
          State a purpose and read the trail. Every read records its own audited event, so this
          panel never polls in the background.
        </SecurityEmptyState>
      ) : items.length === 0 ? (
        <SecurityEmptyState>No audited event matches these filters.</SecurityEmptyState>
      ) : (
        <section className="card security-card">
          <table className="security-audit-table">
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Event</th>
                <th scope="col">Actor</th>
                <th scope="col">Result</th>
                <th scope="col">Scope / case</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={`${entry.seq}:${entry.hash}`}>
                  <td className="mono">{entry.seq}</td>
                  <td>
                    <strong>{securityEventLabel(entry.event.event)}</strong>
                    <div className="identity-meta mono">{entry.event.event_id}</div>
                  </td>
                  <td>
                    {entry.event.actor ? (
                      <>
                        <span className="mono">{entry.event.actor.actor_id}</span>
                        <div className="identity-meta">
                          {entry.event.actor.actor_kind}
                          {entry.event.actor.role ? ` · ${entry.event.actor.role}` : ""}
                        </div>
                      </>
                    ) : (
                      <span className="identity-meta">service or unattributed</span>
                    )}
                  </td>
                  <td>
                    <span className="role-chip">{entry.event.result}</span>
                    {entry.event.reason && (
                      <div className="identity-meta">{entry.event.reason}</div>
                    )}
                  </td>
                  <td className="mono security-audit-scope">
                    {entry.event.case_id ?? "—"}
                    <div className="identity-meta">
                      run {entry.event.scope.run_id} · trace {entry.event.trace_id ?? "—"}
                    </div>
                  </td>
                  <td>
                    {formatSecurityTime(entry.event.at)}
                    <div className="identity-meta mono security-audit-hash">{entry.hash}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor ? (
            <button
              type="button"
              className="button button-quiet button-small load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more events"}
            </button>
          ) : (
            <p className="memory-list-end">End of trail · {items.length} events</p>
          )}
        </section>
      )}

      <p className="security-hint">
        Events are hash-chained and non-secret: identifiers, codes, versions, counters, and scrubbed
        text only. Approval and dispatch are distinct events; an unknown provider outcome is never
        reported as unsent.
      </p>
    </section>
  );
}
