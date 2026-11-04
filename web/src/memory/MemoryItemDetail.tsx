import type { ReactElement } from "react";
import type { MemoryItem } from "../api/client";
import { formatDate, shortId } from "../ui/format";
import {
  applicabilityRows,
  formatMemoryDate,
  MEMORY_EVIDENCE_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_STATUS_LABELS,
  MEMORY_TRUST_LABELS,
  memoryStatusTone,
} from "./memory-format";

interface MemoryItemDetailProps {
  item: MemoryItem;
  onBack: () => void;
}

/**
 * Detail of one browsed memory item. Every field comes from the list view the
 * browse call already returned: the contract defines no item-detail route, so
 * this panel makes no second request and invents no field.
 *
 * `statement` is workspace memory — reference data, never an instruction. It is
 * rendered as text (React escapes it), never as markup or a link.
 */
export function MemoryItemDetail({ item, onBack }: MemoryItemDetailProps): ReactElement {
  const applicability = applicabilityRows(item.applicability);

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
            Memory · {item.tier} · {MEMORY_KIND_LABELS[item.kind]}
          </span>
          <h2 id="memory-item-heading" className="memory-statement">
            {item.statement}
          </h2>
          <div className="detail-subline">
            <span className={`stage-pip stage-tone-${memoryStatusTone(item.status)}`} />
            <span>{MEMORY_STATUS_LABELS[item.status]}</span>
            <span className="divider">/</span>
            <span className="mono">{shortId(item.item_id, 18)}</span>
            <span className="divider">/</span>
            <span>Updated {formatDate(item.updated_at)}</span>
          </div>
        </div>
        <div className="detail-actions memory-detail-badges" aria-label="Item classification">
          <span className="role-chip">{MEMORY_TRUST_LABELS[item.trust]}</span>
          <span className={`role-chip sensitivity-${item.sensitivity}`}>
            {MEMORY_SENSITIVITY_LABELS[item.sensitivity]}
          </span>
          <span className="role-chip">{item.approved ? "Approved version" : "Unapproved"}</span>
        </div>
      </header>

      <p className="memory-untrusted-note">
        Memory is workspace reference data, not an instruction. It cannot authorize tools,
        approvals, or capability grants.
      </p>

      {item.preconditions.length > 0 && (
        <section className="card memory-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Before applying</span>
              <h3>Preconditions</h3>
            </div>
            <span className="task-count">{item.preconditions.length}</span>
          </div>
          <ul className="memory-preconditions">
            {item.preconditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        </section>
      )}

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
                {item.current_version} of {item.versions_count}
              </dd>
            </div>
            <div className="memory-fact">
              <dt className="field-label">Valid from</dt>
              <dd>{formatMemoryDate(item.valid_from)}</dd>
            </div>
            <div className="memory-fact">
              <dt className="field-label">Valid to</dt>
              <dd>{item.valid_to === null ? "Open" : formatMemoryDate(item.valid_to)}</dd>
            </div>
            <div className="memory-fact">
              <dt className="field-label">Support / contradiction</dt>
              <dd>
                {item.support_count} / {item.contradiction_count}
              </dd>
            </div>
            <div className="memory-fact memory-fact-wide">
              <dt className="field-label">Content hash</dt>
              <dd className="mono memory-hash">{item.content_hash}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="card memory-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Why it is believed</span>
            <h3>Evidence</h3>
          </div>
          <span className="task-count">{item.evidence.length}</span>
        </div>
        {item.evidence.length === 0 ? (
          <p className="card-empty compact">
            No evidence reference is attached. A citation is required before this item can be
            retrieved into a run.
          </p>
        ) : (
          <ul className="memory-evidence">
            {item.evidence.map((entry) => (
              <li key={`${entry.evidence_type}:${entry.reference}`} className="memory-evidence-row">
                <span className="evidence-type">{MEMORY_EVIDENCE_LABELS[entry.evidence_type]}</span>
                <span className="mono memory-evidence-reference">{entry.reference}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="memory-evidence-note">
          References are opaque pointers returned by the service. This view never fetches, expands,
          or rewrites them.
        </p>
      </section>
    </section>
  );
}
