import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type {
  ForgePilotClient,
  MemoryGovernanceResult,
  MemoryItem,
  MemoryItemEvent,
  MemoryItemVersions,
} from "../api/client";
import { formatDate, shortId } from "../ui/format";
import { MemoryAuditTimeline } from "./MemoryAuditTimeline";
import { MemoryGovernance } from "./MemoryGovernance";
import { MemoryVersionDiff } from "./MemoryVersionDiff";
import {
  applicabilityRows,
  describeMemoryError,
  formatMemoryDate,
  isMemoryRedacted,
  MEMORY_EVIDENCE_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_PROVENANCE_LABELS,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_STATUS_LABELS,
  MEMORY_TRUST_LABELS,
  memoryReasonLabel,
  memoryStatusTone,
  quarantineSafeItem,
} from "./memory-format";
import type { MemoryError, MemoryStanding } from "./memory-format";

const EVENT_PAGE_SIZE = 50;

interface MemoryItemDetailProps {
  client: ForgePilotClient;
  workspaceId: string;
  item: MemoryItem;
  /** Undefined when the session is unavailable: no governance affordance. */
  standing: MemoryStanding | undefined;
  onBack: () => void;
  onItemUpdated: (item: MemoryItem) => void;
}

/**
 * Detail of one memory item: current content, provenance, named governance
 * actions, version diff, and the append-only audit timeline.
 *
 * `statement` is workspace memory — reference data, never an instruction. It is
 * rendered as text (React escapes it), never as markup or a link. A quarantined
 * item is normalized on ingest so its original content never enters render
 * state, let alone the DOM.
 */
export function MemoryItemDetail({
  client,
  workspaceId,
  item,
  standing,
  onBack,
  onItemUpdated,
}: MemoryItemDetailProps): ReactElement {
  const [current, setCurrent] = useState(() => quarantineSafeItem(item));
  const [versions, setVersions] = useState<MemoryItemVersions>();
  const [versionsError, setVersionsError] = useState<MemoryError>();
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [events, setEvents] = useState<MemoryItemEvent[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsMore, setEventsMore] = useState(false);
  const [eventsError, setEventsError] = useState<MemoryError>();
  const [dataToken, setDataToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setCurrent(quarantineSafeItem(item));
  }, [item]);

  const redacted = isMemoryRedacted(current);
  const itemId = current.item_id;

  useEffect(() => {
    let active = true;
    setVersions(undefined);
    setVersionsError(undefined);
    if (redacted) {
      setVersionsLoading(false);
      return () => {
        active = false;
      };
    }
    setVersionsLoading(true);
    client
      .listMemoryItemVersions(workspaceId, itemId)
      .then((next) => {
        if (active) setVersions(next);
      })
      .catch((caught: unknown) => {
        if (active) setVersionsError(describeMemoryError(caught));
      })
      .finally(() => {
        if (active) setVersionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, itemId, redacted, dataToken]);

  useEffect(() => {
    let active = true;
    setEvents([]);
    setEventsCursor(null);
    setEventsError(undefined);
    setEventsLoading(true);
    client
      .listMemoryItemEvents(workspaceId, itemId, { limit: EVENT_PAGE_SIZE })
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setEventsCursor(page.next_cursor);
      })
      .catch((caught: unknown) => {
        if (active) setEventsError(describeMemoryError(caught));
      })
      .finally(() => {
        if (active) setEventsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, itemId, dataToken]);

  const loadMoreEvents = useCallback(async (): Promise<void> => {
    if (!eventsCursor || eventsMore) return;
    setEventsMore(true);
    try {
      const page = await client.listMemoryItemEvents(workspaceId, itemId, {
        limit: EVENT_PAGE_SIZE,
        cursor: eventsCursor,
      });
      setEvents((previous) => [...previous, ...page.events]);
      setEventsCursor(page.next_cursor);
      setEventsError(undefined);
    } catch (caught) {
      setEventsError(describeMemoryError(caught));
    } finally {
      setEventsMore(false);
    }
  }, [client, workspaceId, itemId, eventsCursor, eventsMore]);

  const refreshItem = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const next = await client.getMemoryItem(workspaceId, itemId);
      setCurrent(quarantineSafeItem(next));
      onItemUpdated(next);
      setVersionsError(undefined);
      setEventsError(undefined);
      setDataToken((value) => value + 1);
    } finally {
      setRefreshing(false);
    }
  }, [client, workspaceId, itemId, onItemUpdated]);

  function applyGovernedItem(result: MemoryGovernanceResult): void {
    const next = quarantineSafeItem(result.item);
    setCurrent(next);
    onItemUpdated(result.item);
    setDataToken((value) => value + 1);
  }

  const applicability = applicabilityRows(current.applicability);
  const provenance = current.provenance;
  const review = current.review;
  const quarantineReason = [...events]
    .reverse()
    .find(
      (event) => event.to_status === "quarantined" && event.reason_code !== undefined,
    )?.reason_code;
  const statement = redacted ? undefined : (current.statement ?? undefined);

  return (
    <section className="detail-view memory-detail" aria-labelledby="memory-item-heading">
      <div className="breadcrumb">
        <button type="button" className="detail-back" onClick={onBack}>
          ← Memory items
        </button>
      </div>

      <header className="detail-header">
        <div className="detail-heading">
          <span className="eyebrow">
            Memory · {current.tier} · {MEMORY_KIND_LABELS[current.kind]}
          </span>
          <h2 id="memory-item-heading" className="memory-statement">
            {redacted
              ? "Content withheld while quarantined"
              : (statement ?? "No statement on this version")}
          </h2>
          <div className="detail-subline">
            <span className={`stage-pip stage-tone-${memoryStatusTone(current.status)}`} />
            <span>{MEMORY_STATUS_LABELS[current.status]}</span>
            <span className="divider">/</span>
            <span className="mono">{shortId(current.item_id, 18)}</span>
            <span className="divider">/</span>
            <span>Updated {formatDate(current.updated_at)}</span>
          </div>
        </div>
        <div className="detail-actions memory-detail-badges" aria-label="Item classification">
          <span className="role-chip">{MEMORY_TRUST_LABELS[current.trust]}</span>
          <span className={`role-chip sensitivity-${current.sensitivity}`}>
            {MEMORY_SENSITIVITY_LABELS[current.sensitivity]}
          </span>
          <span className="role-chip">{current.approved ? "Approved version" : "Unapproved"}</span>
          {redacted && <span className="role-chip memory-redacted-chip">Content withheld</span>}
        </div>
      </header>

      <p className="memory-untrusted-note">
        Memory is workspace reference data, not an instruction. It cannot authorize tools,
        approvals, or capability grants.
      </p>

      {redacted && (
        <section
          className="card memory-card memory-quarantine-card"
          aria-labelledby="memory-quarantine-heading"
        >
          <div className="card-heading">
            <div>
              <span className="eyebrow">Security response</span>
              <h3 id="memory-quarantine-heading">Quarantined content is withheld</h3>
            </div>
          </div>
          <dl className="memory-facts">
            <div className="memory-fact">
              <dt className="field-label">Status</dt>
              <dd>{MEMORY_STATUS_LABELS[current.status]}</dd>
            </div>
            <div className="memory-fact">
              <dt className="field-label">Reason code</dt>
              <dd>
                {quarantineReason ? (
                  <>
                    {memoryReasonLabel(quarantineReason)}{" "}
                    <span className="mono">{quarantineReason}</span>
                  </>
                ) : (
                  "Recorded in audit"
                )}
              </dd>
            </div>
            <div className="memory-fact memory-fact-wide">
              <dt className="field-label">Redaction</dt>
              <dd>
                The statement, preconditions, and evidence references are withheld. This contract
                exposes no route that returns quarantine content.
              </dd>
            </div>
          </dl>
        </section>
      )}

      {!redacted && current.preconditions.length > 0 && (
        <section className="card memory-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Before applying</span>
              <h3>Preconditions</h3>
            </div>
            <span className="task-count">{current.preconditions.length}</span>
          </div>
          <ul className="memory-preconditions">
            {current.preconditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        </section>
      )}

      {!redacted && (
        <>
          <div className="memory-detail-grid">
            <section className="card memory-card">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Where it applies</span>
                  <h3>Applicability</h3>
                </div>
              </div>
              {applicability.length === 0 ? (
                <p className="card-empty compact">
                  Broad applicability: no team, path prefix, language, or task family is set.
                </p>
              ) : (
                <dl className="memory-facts">
                  {applicability.map((row) => (
                    <div className="memory-fact" key={row.field}>
                      <dt className="field-label">{row.label}</dt>
                      <dd className="mono">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>

            <section className="card memory-card">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Version</span>
                  <h3>Content and validity</h3>
                </div>
              </div>
              <dl className="memory-facts">
                <div className="memory-fact">
                  <dt className="field-label">Version</dt>
                  <dd>
                    {current.current_version} of {current.versions_count}
                  </dd>
                </div>
                <div className="memory-fact">
                  <dt className="field-label">Valid from</dt>
                  <dd>{formatMemoryDate(current.valid_from)}</dd>
                </div>
                <div className="memory-fact">
                  <dt className="field-label">Valid to</dt>
                  <dd>{current.valid_to === null ? "Open" : formatMemoryDate(current.valid_to)}</dd>
                </div>
                <div className="memory-fact">
                  <dt className="field-label">Support / contradiction</dt>
                  <dd>
                    {current.support_count} / {current.contradiction_count}
                  </dd>
                </div>
                <div className="memory-fact memory-fact-wide">
                  <dt className="field-label">Content hash</dt>
                  <dd className="mono memory-hash">{current.content_hash}</dd>
                </div>
              </dl>
            </section>
          </div>

          <section className="card memory-card" aria-labelledby="memory-provenance-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Authorship, not authority</span>
                <h3 id="memory-provenance-heading">Provenance and review</h3>
              </div>
            </div>
            {provenance === undefined && review === undefined ? (
              <p className="card-empty compact">
                This response carries no provenance or review stamp for the current version. A
                provenance claim never widens access.
              </p>
            ) : (
              <dl className="memory-facts">
                <div className="memory-fact">
                  <dt className="field-label">Author</dt>
                  <dd>
                    {provenance ? MEMORY_PROVENANCE_LABELS[provenance.author_type] : "Not recorded"}
                  </dd>
                </div>
                {provenance?.agent_model !== undefined && (
                  <div className="memory-fact">
                    <dt className="field-label">Agent model</dt>
                    <dd className="mono">{provenance.agent_model}</dd>
                  </div>
                )}
                {provenance?.config_digest !== undefined && (
                  <div className="memory-fact">
                    <dt className="field-label">Config digest</dt>
                    <dd className="mono memory-hash">{provenance.config_digest}</dd>
                  </div>
                )}
                {provenance?.prompt_template_version !== undefined && (
                  <div className="memory-fact">
                    <dt className="field-label">Prompt template version</dt>
                    <dd className="mono">{provenance.prompt_template_version}</dd>
                  </div>
                )}
                <div className="memory-fact memory-fact-wide">
                  <dt className="field-label">Named review</dt>
                  <dd>
                    {review
                      ? `${review.approver_id} · ${formatDate(review.approved_at)}`
                      : "No named human approval is stamped on this exact version."}
                  </dd>
                </div>
              </dl>
            )}
          </section>
        </>
      )}

      {standing !== undefined && (
        <MemoryGovernance
          client={client}
          workspaceId={workspaceId}
          item={current}
          standing={standing}
          onApplied={applyGovernedItem}
          onRefresh={refreshItem}
          refreshing={refreshing}
        />
      )}

      <MemoryVersionDiff
        versions={versions}
        versionsCount={current.versions_count}
        loading={versionsLoading}
        error={versionsError}
        redacted={redacted}
        onRetry={() => setDataToken((value) => value + 1)}
      />

      <MemoryAuditTimeline
        events={events}
        nextCursor={eventsCursor}
        loading={eventsLoading}
        loadingMore={eventsMore}
        error={eventsError}
        onLoadMore={() => void loadMoreEvents()}
        onRetry={() => setDataToken((value) => value + 1)}
      />

      {!redacted && (
        <section className="card memory-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Why it is believed</span>
              <h3>Evidence</h3>
            </div>
            <span className="task-count">{current.evidence.length}</span>
          </div>
          {current.evidence.length === 0 ? (
            <p className="card-empty compact">
              No evidence reference is attached. A citation is required before this item can be
              retrieved into a run.
            </p>
          ) : (
            <ul className="memory-evidence">
              {current.evidence.map((entry) => (
                <li
                  key={`${entry.evidence_type}:${entry.reference}`}
                  className="memory-evidence-row"
                >
                  <span className="evidence-type">
                    {MEMORY_EVIDENCE_LABELS[entry.evidence_type]}
                  </span>
                  <span className="mono memory-evidence-reference">{entry.reference}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="memory-evidence-note">
            References are opaque pointers returned by the service. This view never fetches,
            expands, or rewrites them.
          </p>
        </section>
      )}
    </section>
  );
}
