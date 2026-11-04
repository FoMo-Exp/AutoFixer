import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiError } from "../api/client";
import type { Candidate, Delivery, ForgePilotClient, IssueDeliveryReconcile } from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import {
  deliveryNeedsReconcile,
  deliveryOutcomeNote,
  deliveryStateLabel,
  deliveryStateTone,
} from "../ui/change-review";
import { formatDate, shortId } from "../ui/format";
import { redactText } from "../ui/redaction";
import { describeIssueError, errorLabel } from "./errors";
import type { IssueError } from "./errors";

interface DeliveryStatusCardProps {
  client: ForgePilotClient;
  workspaceId: string;
  issueId: string;
  deliveries: Delivery[];
  candidates: Candidate[];
  loading: boolean;
  error: IssueError | undefined;
  canMutate: boolean;
  onRetry: () => void;
  onDeliveryUpdated: (delivery: Delivery) => void;
  onChanged: () => void;
}

export function DeliveryStatusCard({
  client,
  workspaceId,
  issueId,
  deliveries,
  candidates,
  loading,
  error,
  canMutate,
  onRetry,
  onDeliveryUpdated,
  onChanged,
}: DeliveryStatusCardProps): ReactElement {
  const [reconcileTarget, setReconcileTarget] = useState<Delivery | undefined>(undefined);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState<IssueError | undefined>(undefined);
  const [cardError, setCardError] = useState<string | undefined>(undefined);
  const reconcileKeys = useRef(new CreateIdempotencyKeys());

  const ordered = [...deliveries].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidate_id));

  async function submitReconcile(note: string): Promise<void> {
    if (!reconcileTarget) return;
    const input: IssueDeliveryReconcile = note.trim() ? { note: note.trim() } : {};
    const signature = { delivery_id: reconcileTarget.delivery_id, ...input };
    setReconcileBusy(true);
    setReconcileError(undefined);
    try {
      const key = reconcileKeys.current.forInput(signature);
      const updated = await client.reconcileIssueDelivery(
        workspaceId,
        issueId,
        reconcileTarget.delivery_id,
        input,
        key,
      );
      reconcileKeys.current.complete(signature);
      onDeliveryUpdated(updated);
      setReconcileTarget(undefined);
      onRetry();
      onChanged();
    } catch (caught) {
      const described = describeIssueError(caught);
      setReconcileError(described);
      // A state conflict means the delivery moved on; re-read it instead of
      // leaving a stale remedy on screen. A retryable provider error keeps the
      // dialog open with the safe message.
      if (caught instanceof ApiError && (caught.status === 409 || caught.status === 404)) {
        setCardError(errorLabel(described));
        setReconcileTarget(undefined);
        onRetry();
        onChanged();
      }
    } finally {
      setReconcileBusy(false);
    }
  }

  return (
    <section className="card delivery-status-card" aria-labelledby="delivery-status-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Controlled delivery</span>
          <h3 id="delivery-status-heading">Delivery status</h3>
        </div>
        <span className="event-count">
          {ordered.length} {ordered.length === 1 ? "operation" : "operations"}
        </span>
      </div>
      <p className="stage-description">
        Only the trusted delivery broker writes to the provider. A delivered state means a pull
        request exists — never a merge, a self-review, or a check waiver.
      </p>

      {cardError && (
        <div className="inline-error" role="alert">
          <span>{cardError}</span>
          <button
            type="button"
            aria-label="Dismiss delivery status error"
            onClick={() => setCardError(undefined)}
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div className="connection-banner" role="alert">
          <span className="banner-dot" />
          <div>
            <strong>Delivery status could not be loaded</strong>
            <span>{errorLabel(error)}</span>
          </div>
          <button type="button" className="button button-quiet button-small" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {loading && ordered.length === 0 && !error && (
        <div className="card-empty compact">Reading delivery operations…</div>
      )}

      {!loading && !error && ordered.length === 0 && (
        <div className="card-empty">
          No delivery operation exists yet. Delivery requires a current candidate-bound human
          approval; nothing is pushed or opened before it.
        </div>
      )}

      {ordered.length > 0 && (
        <ul className="delivery-list">
          {ordered.map((delivery) => {
            const note = deliveryOutcomeNote(delivery.state);
            const knownCandidate = candidateIds.has(delivery.candidate_id);
            return (
              <li key={delivery.delivery_id} className="delivery-row">
                <article aria-labelledby={`delivery-${delivery.delivery_id}-title`}>
                  <div className="delivery-heading">
                    <div>
                      <span className="eyebrow">Delivery operation</span>
                      <h4 id={`delivery-${delivery.delivery_id}-title`} className="mono">
                        {redactText(delivery.delivery_id)}
                      </h4>
                    </div>
                    <span
                      className={`review-state-pill review-tone-${deliveryStateTone(delivery.state)}`}
                    >
                      {deliveryStateLabel(delivery.state)}
                    </span>
                  </div>
                  <div className="delivery-facts">
                    <div>
                      <span className="metric-label">Candidate</span>
                      <strong className="mono">
                        {shortId(delivery.candidate_id, 20)}
                        {knownCandidate ? "" : " · not in this candidate list"}
                      </strong>
                    </div>
                    <div>
                      <span className="metric-label">Approval</span>
                      <strong className="mono">{shortId(delivery.approval_id, 20)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Provider</span>
                      <strong>{redactText(delivery.provider)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Target</span>
                      <strong className="mono">{redactText(delivery.target_branch)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Head</span>
                      <strong className="mono">{shortId(delivery.head_sha, 16)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Operation</span>
                      <strong className="mono">{redactText(delivery.operation_id)}</strong>
                    </div>
                  </div>
                  <div className="info-row">
                    <span>Branch</span>
                    <strong className="mono">
                      {delivery.branch ? redactText(delivery.branch) : "Not pushed"}
                    </strong>
                  </div>
                  <div className="info-row">
                    <span>Pull request</span>
                    <strong className="mono">
                      {delivery.pr_url
                        ? `${redactText(delivery.pr_url)}${
                            delivery.pr_id ? ` · #${redactText(delivery.pr_id)}` : ""
                          }`
                        : "None confirmed"}
                    </strong>
                  </div>
                  {delivery.error_code && (
                    <div className="info-row">
                      <span>Last error</span>
                      <strong className="mono">{redactText(delivery.error_code)}</strong>
                    </div>
                  )}
                  <div className="info-row">
                    <span>Updated</span>
                    <strong>{formatDate(delivery.updated_at)}</strong>
                  </div>
                  {delivery.reconciled_at && (
                    <div className="info-row">
                      <span>Reconciled</span>
                      <strong>{formatDate(delivery.reconciled_at)}</strong>
                    </div>
                  )}
                  {note && (
                    <p
                      className={`delivery-outcome-note delivery-note-${delivery.state}`}
                      role="status"
                    >
                      {note}
                    </p>
                  )}
                  {deliveryNeedsReconcile(delivery.state) &&
                    (canMutate ? (
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => {
                          setCardError(undefined);
                          setReconcileError(undefined);
                          setReconcileTarget(delivery);
                        }}
                      >
                        Reconcile outcome
                      </button>
                    ) : (
                      <p className="muted-copy">
                        Your workspace role is read-only. A named delivery operator must reconcile
                        this outcome.
                      </p>
                    ))}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {reconcileTarget && (
        <ReconcileDialog
          delivery={reconcileTarget}
          busy={reconcileBusy}
          error={reconcileError}
          onCancel={() => {
            setReconcileTarget(undefined);
            setReconcileError(undefined);
          }}
          onSubmit={(note) => void submitReconcile(note)}
        />
      )}
    </section>
  );
}

function ReconcileDialog({
  delivery,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  delivery: Delivery;
  busy: boolean;
  error: IssueError | undefined;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}): ReactElement {
  const [note, setNote] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    onSubmit(note);
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="modal delivery-reconcile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-reconcile-title"
        aria-describedby="delivery-reconcile-description"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <span className="eyebrow">Provider evidence · {delivery.delivery_id}</span>
        <h2 id="delivery-reconcile-title">Reconcile delivery outcome</h2>
        <p id="delivery-reconcile-description">
          The service re-reads the branch and provider operation evidence for this exact operation
          and records the reconciled state before any further write. This is an unknown-outcome
          remedy, not a bounded retry; it never creates a duplicate branch or pull request.
        </p>
        <div className="info-row">
          <span>Current state</span>
          <strong>{deliveryStateLabel(delivery.state)}</strong>
        </div>
        <div className="info-row">
          <span>Operation</span>
          <strong className="mono">{redactText(delivery.operation_id)}</strong>
        </div>
        <label className="field-block">
          <span className="field-label">Reconciliation note (optional)</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            disabled={busy}
          />
        </label>
        {error && (
          <div className="inline-error delivery-reconcile-error" role="alert">
            <span>{errorLabel(error)}</span>
          </div>
        )}
        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Reconciling…" : "Record reconciliation"}
          </button>
        </div>
      </form>
    </div>
  );
}
