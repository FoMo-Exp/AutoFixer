import type { ReactElement } from "react";
import type { MemoryItemEvent } from "../api/client";
import { formatDate, shortId } from "../ui/format";
import {
  MEMORY_EVENT_SOURCE_LABELS,
  MEMORY_STATUS_LABELS,
  memoryEventActionLabel,
  memoryEventDetailRows,
  memoryReasonLabel,
  memoryStatusTone,
} from "./memory-format";
import type { MemoryError } from "./memory-format";

interface MemoryAuditTimelineProps {
  events: MemoryItemEvent[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: MemoryError | undefined;
  onLoadMore: () => void;
  onRetry: () => void;
}

function EventRow({ event }: { event: MemoryItemEvent }): ReactElement {
  const detailRows = memoryEventDetailRows(event.detail);
  return (
    <li className="memory-audit-row">
      <span className="memory-audit-time">{formatDate(event.at)}</span>
      <div className="memory-audit-body">
        <div className="memory-audit-heading">
          <strong>{memoryEventActionLabel(event.action)}</strong>
          <span className="memory-audit-source">
            {MEMORY_EVENT_SOURCE_LABELS[event.source] ?? event.source}
          </span>
        </div>
        <div className="memory-audit-meta">
          <span>
            {event.actor.type === "user" ? "Human actor" : "System actor"}{" "}
            <span className="mono">{shortId(event.actor.id, 18)}</span>
          </span>
          <span>{event.item_version === null ? "No version" : `v${event.item_version}`}</span>
          {event.from_status !== undefined && event.to_status !== undefined && (
            <span className="memory-audit-transition">
              <span className={`stage-pip stage-tone-${memoryStatusTone(event.from_status)}`} />
              {MEMORY_STATUS_LABELS[event.from_status]} →{" "}
              <span className={`stage-pip stage-tone-${memoryStatusTone(event.to_status)}`} />
              {MEMORY_STATUS_LABELS[event.to_status]}
            </span>
          )}
          {event.reason_code !== undefined && (
            <span className="memory-audit-reason">
              {memoryReasonLabel(event.reason_code)}{" "}
              <span className="mono">{event.reason_code}</span>
            </span>
          )}
        </div>
        {detailRows.length > 0 && (
          <div className="memory-audit-detail" aria-label="Recorded detail">
            {detailRows.map((row) => (
              <span key={row.key} className="memory-audit-chip">
                <span className="mono">{row.key}</span> {row.value}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The merged, append-only audit timeline. It is paginated by `next_cursor`
 * rather than truncated, so a bounded page is never presented as the complete
 * history. Only fixed codes, statuses, actor ids, versions, and normalized
 * detail tokens are rendered; the contract carries no free-text reason.
 */
export function MemoryAuditTimeline({
  events,
  nextCursor,
  loading,
  loadingMore,
  error,
  onLoadMore,
  onRetry,
}: MemoryAuditTimelineProps): ReactElement {
  return (
    <section className="card memory-card" aria-labelledby="memory-audit-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Append-only</span>
          <h3 id="memory-audit-heading">Audit timeline</h3>
        </div>
        <span className="task-count">{events.length}</span>
      </div>

      {error ? (
        <div className="inline-error" role="alert">
          <span>
            {error.code}: {error.message}
          </span>
          <button type="button" className="button button-quiet button-small" onClick={onRetry}>
            Retry timeline
          </button>
        </div>
      ) : loading && events.length === 0 ? (
        <p className="card-empty">Reading the audit timeline…</p>
      ) : events.length === 0 ? (
        <p className="card-empty">No audit entry is visible for this item.</p>
      ) : (
        <>
          <ol className="memory-audit-list">
            {events.map((event, index) => (
              <EventRow
                key={`${event.at}:${event.source}:${event.action}:${index}`}
                event={event}
              />
            ))}
          </ol>
          {nextCursor === null ? (
            <p className="memory-list-end">
              End of timeline · {events.length} {events.length === 1 ? "entry" : "entries"}
            </p>
          ) : (
            <button
              type="button"
              className="button button-quiet button-small load-more"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more audit entries"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
