import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiError } from "../api/client";
import type {
  Approval,
  Candidate,
  Delivery,
  ForgePilotClient,
  IssueDeliveryReconcile,
  IssueDeliveryRequest,
  PullRequestGovernanceObservation,
} from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import {
  GOVERNANCE_APPROVAL_LABELS,
  GOVERNANCE_CHECK_LABELS,
  GOVERNANCE_NOT_EVALUATED_LABELS,
  GOVERNANCE_UNMET_CONDITION_LABELS,
  GOVERNANCE_VALIDITY_LABELS,
  deliveryNeedsReconcile,
  deliveryOutcomeNote,
  deliveryRequestGate,
  deliveryStateLabel,
  deliveryStateTone,
  governanceDimensionLabel,
  governanceHeadline,
  governanceValidityTone,
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
  approvals: Approval[];
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
  approvals,
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
  const [requestTarget, setRequestTarget] = useState<Approval | undefined>(undefined);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<IssueError | undefined>(undefined);
  const [observation, setObservation] = useState<PullRequestGovernanceObservation | undefined>(
    undefined,
  );
  const [observing, setObserving] = useState(false);
  const [observationError, setObservationError] = useState<IssueError | undefined>(undefined);
  const [observeToken, setObserveToken] = useState(0);
  const [cardError, setCardError] = useState<string | undefined>(undefined);
  const reconcileKeys = useRef(new CreateIdempotencyKeys());
  const requestKeys = useRef(new CreateIdempotencyKeys());

  const ordered = [...deliveries].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidate_id));
  const requestGate = deliveryRequestGate({ approvals, candidates, deliveries, canMutate });
  // The newest delivery with a confirmed PR is the one whose head governs the
  // next merge decision. Older operations are history, not a second status.
  const governanceDelivery = ordered.find((delivery) => delivery.pr_url !== null);
  const governanceDeliveryId = governanceDelivery?.delivery_id;

  useEffect(() => {
    if (!governanceDeliveryId) {
      setObservation(undefined);
      setObservationError(undefined);
      return;
    }
    let active = true;
    setObserving(true);
    setObservation(undefined);
    setObservationError(undefined);
    void client
      .observeIssueDeliveryGovernance(workspaceId, issueId, governanceDeliveryId)
      .then((next) => {
        if (active) setObservation(next);
      })
      .catch((caught: unknown) => {
        if (active) setObservationError(describeIssueError(caught));
      })
      .finally(() => {
        if (active) setObserving(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, issueId, governanceDeliveryId, observeToken]);

  async function submitRequest(grantId: string): Promise<void> {
    if (!requestTarget) return;
    const input: IssueDeliveryRequest = {
      approval_id: requestTarget.approval_id,
      grant_id: grantId.trim(),
    };
    const signature = { ...input };
    setRequestBusy(true);
    setRequestError(undefined);
    try {
      const key = requestKeys.current.forInput(signature);
      const updated = await client.requestIssueDelivery(workspaceId, issueId, input, key);
      requestKeys.current.complete(signature);
      onDeliveryUpdated(updated);
      setRequestTarget(undefined);
      onRetry();
      onChanged();
    } catch (caught) {
      const described = describeIssueError(caught);
      setRequestError(described);
      // A conflict or a missing approval means this projection is stale. Re-read
      // rather than leaving a submit button the broker must refuse again.
      if (caught instanceof ApiError && (caught.status === 409 || caught.status === 404)) {
        setCardError(errorLabel(described));
        setRequestTarget(undefined);
        onRetry();
        onChanged();
      }
    } finally {
      setRequestBusy(false);
    }
  }

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

      {requestGate.approval && (
        <div className="delivery-request" role="group" aria-labelledby="delivery-request-heading">
          <div className="delivery-heading">
            <div>
              <span className="eyebrow">Approved candidate</span>
              <h4 id="delivery-request-heading">Delivery is available</h4>
            </div>
            <span className="review-state-pill review-tone-done">Approved</span>
          </div>
          <div className="info-row">
            <span>Approval</span>
            <strong className="mono">{redactText(requestGate.approval.approval_id)}</strong>
          </div>
          <div className="info-row">
            <span>Candidate</span>
            <strong className="mono">
              {shortId(
                requestGate.candidate?.candidate_id ?? requestGate.approval.candidate_id,
                22,
              )}
            </strong>
          </div>
          <div className="info-row">
            <span>Head</span>
            <strong className="mono">{shortId(requestGate.approval.binding.head_sha, 16)}</strong>
          </div>
          <div className="info-row">
            <span>Target branch</span>
            <strong className="mono">
              {redactText(requestGate.approval.binding.target_branch)}
            </strong>
          </div>
          {requestGate.canRequest ? (
            <div className="approval-actions">
              <button
                type="button"
                className="button button-primary button-small"
                onClick={() => {
                  setCardError(undefined);
                  setRequestError(undefined);
                  setRequestTarget(requestGate.approval);
                }}
              >
                Request controlled delivery
              </button>
            </div>
          ) : (
            <p className="review-gate-note">{requestGate.reason}</p>
          )}
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

      {governanceDelivery && (
        <GovernancePanel
          delivery={governanceDelivery}
          observation={observation}
          observing={observing}
          error={observationError}
          onRefresh={() => setObserveToken((value) => value + 1)}
        />
      )}

      {requestTarget && (
        <RequestDeliveryDialog
          approval={requestTarget}
          candidate={requestGate.candidate}
          busy={requestBusy}
          error={requestError}
          onCancel={() => {
            setRequestTarget(undefined);
            setRequestError(undefined);
          }}
          onSubmit={(grantId) => void submitRequest(grantId)}
        />
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

function RequestDeliveryDialog({
  approval,
  candidate,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  approval: Approval;
  candidate: Candidate | undefined;
  busy: boolean;
  error: IssueError | undefined;
  onCancel: () => void;
  onSubmit: (grantId: string) => void;
}): ReactElement {
  const [grantId, setGrantId] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const invalid = grantId.trim().length === 0;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (invalid || busy) return;
    onSubmit(grantId);
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
        className="modal delivery-request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-request-title"
        aria-describedby="delivery-request-description"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <span className="eyebrow">Broker delivery · {approval.approval_id}</span>
        <h2 id="delivery-request-title">Request controlled delivery</h2>
        <p id="delivery-request-description">
          The broker pushes only this issue&apos;s autofixer branch and opens a pull request. It
          never writes the base branch, merges, self-reviews, or waives a check. This approval is
          consumed by exactly this operation.
        </p>
        <div className="approval-dialog-facts">
          <div className="info-row">
            <span>Candidate</span>
            <strong className="mono">
              {redactText(candidate?.candidate_id ?? approval.candidate_id)}
            </strong>
          </div>
          <div className="info-row">
            <span>Approved head</span>
            <strong className="mono">{approval.binding.head_sha}</strong>
          </div>
          <div className="info-row">
            <span>Target branch</span>
            <strong className="mono">{redactText(approval.binding.target_branch)}</strong>
          </div>
        </div>
        <label className="field-block">
          <span className="label-text">
            Delivery grant ID<span className="required-dot">*</span>
          </span>
          <input
            type="text"
            value={grantId}
            onChange={(event) => setGrantId(event.target.value)}
            required
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder="grant_…"
          />
        </label>
        <p className="muted-copy">
          The grant is a separate delivery-role capability bound to this approved head. The
          workbench neither mints nor infers one; a missing, expired, revoked, or wrong-head grant
          leaves delivery blocked and no write is attempted.
        </p>
        {error && (
          <div className="inline-error delivery-request-error" role="alert">
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
          <button type="submit" className="button button-primary" disabled={invalid || busy}>
            {busy ? "Requesting delivery…" : "Request delivery"}
          </button>
        </div>
      </form>
    </div>
  );
}

function GovernancePanel({
  delivery,
  observation,
  observing,
  error,
  onRefresh,
}: {
  delivery: Delivery;
  observation: PullRequestGovernanceObservation | undefined;
  observing: boolean;
  error: IssueError | undefined;
  onRefresh: () => void;
}): ReactElement {
  return (
    <section className="governance-panel" aria-labelledby="governance-heading">
      <div className="delivery-heading">
        <div>
          <span className="eyebrow">Read-only observation</span>
          <h4 id="governance-heading">PR current-head governance</h4>
        </div>
        {observation ? (
          <span
            className={`review-state-pill review-tone-${governanceValidityTone(observation.validity)}`}
          >
            {GOVERNANCE_VALIDITY_LABELS[observation.validity]}
          </span>
        ) : (
          observing && <span className="review-state-pill review-tone-active">Observing</span>
        )}
      </div>
      <p className="stage-description">
        Checks, decisive reviews, and review conversations are read from the provider for one exact
        commit. This record never approves, merges, dismisses a review, or waives a check, and an
        unreadable answer is never treated as satisfied.
      </p>
      <div className="info-row">
        <span>Pull request</span>
        <strong className="mono">
          {delivery.pr_url
            ? redactText(delivery.pr_url)
            : delivery.pr_id
              ? `#${redactText(delivery.pr_id)}`
              : "None confirmed"}
        </strong>
      </div>
      <div className="info-row">
        <span>Delivered head</span>
        <strong className="mono">{shortId(delivery.head_sha, 16)}</strong>
      </div>

      {error && (
        <div className="connection-banner" role="alert">
          <span className="banner-dot" />
          <div>
            <strong>Governance observation failed</strong>
            <span>{errorLabel(error)}</span>
          </div>
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={onRefresh}
            disabled={observing}
          >
            Retry
          </button>
        </div>
      )}

      {!observation && observing && !error && (
        <div className="card-empty compact">Reading the pull request head…</div>
      )}

      {observation && (
        <>
          <p
            className={`governance-headline governance-tone-${governanceValidityTone(
              observation.validity,
            )}`}
            role="status"
          >
            {governanceHeadline(observation)}
          </p>
          <div className="governance-facts">
            <div>
              <span className="metric-label">Observed head</span>
              <strong className="mono">
                {observation.head_sha ? shortId(observation.head_sha, 16) : "Not read"}
              </strong>
            </div>
            <div>
              <span className="metric-label">PR state</span>
              <strong>{observation.pull_request_state ?? "Not read"}</strong>
            </div>
            <div>
              <span className="metric-label">Observed at</span>
              <strong>{formatDate(observation.observed_at)}</strong>
            </div>
            <div>
              <span className="metric-label">Observable conditions</span>
              <strong>{observation.conditions_satisfied ? "All hold" : "Not satisfied"}</strong>
            </div>
          </div>
          {observation.head_sha && observation.head_sha !== observation.delivery_head_sha && (
            <div className="reason-card approval-invalidated" role="status">
              <span className="reason-icon">!</span>
              <div>
                <strong>PR head differs from the delivered commit</strong>
                <p>
                  Delivered {shortId(observation.delivery_head_sha, 16)}, observed{" "}
                  {shortId(observation.head_sha, 16)}. Every dimension below applies to the observed
                  head only; the delivered approval covers another commit.
                </p>
              </div>
            </div>
          )}
          {observation.unmet_condition && (
            <div className="info-row">
              <span>First unmet condition</span>
              <strong>
                {GOVERNANCE_UNMET_CONDITION_LABELS[observation.unmet_condition] ??
                  observation.unmet_condition}
              </strong>
            </div>
          )}
          {observation.supersedes && (
            <p className="muted-copy">
              Supersedes observation {redactText(observation.supersedes.observation_id)} of head{" "}
              {shortId(observation.supersedes.head_sha, 12)} because the PR head changed. Its values
              are not carried into this observation.
            </p>
          )}

          <div className="governance-dimensions">
            <section aria-labelledby="governance-checks-heading">
              <div className="governance-dimension-heading">
                <h5 id="governance-checks-heading">Checks</h5>
                <span className="governance-dimension-state">
                  {governanceDimensionLabel(observation.checks)}
                </span>
              </div>
              {observation.checks.state === "observed" &&
                (observation.checks.items.length === 0 ? (
                  <p className="muted-copy">
                    No check result was observed on this head. An empty list is never a passing
                    gate.
                  </p>
                ) : (
                  <div className="review-table-scroll">
                    <table className="review-table">
                      <caption>Check results bound to the observed head</caption>
                      <thead>
                        <tr>
                          <th scope="col">Check</th>
                          <th scope="col">Status</th>
                          <th scope="col">Head</th>
                          <th scope="col">Observed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {observation.checks.items.map((check) => (
                          <tr key={`${check.name}:${check.head_sha}:${check.observed_at}`}>
                            <td>{redactText(check.name)}</td>
                            <td>
                              <span
                                className={`review-exit ${
                                  check.status === "passed"
                                    ? "review-exit-pass"
                                    : check.status === "failed"
                                      ? "review-exit-fail"
                                      : "review-exit-unknown"
                                }`}
                              >
                                {GOVERNANCE_CHECK_LABELS[check.status] ?? check.status}
                              </span>
                            </td>
                            <td className="mono">{shortId(check.head_sha, 12)}</td>
                            <td>{formatDate(check.observed_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </section>

            <section aria-labelledby="governance-approvals-heading">
              <div className="governance-dimension-heading">
                <h5 id="governance-approvals-heading">Decisive reviews</h5>
                <span className="governance-dimension-state">
                  {governanceDimensionLabel(observation.approvals)}
                </span>
              </div>
              {observation.approvals.state === "observed" && (
                <>
                  <div className="info-row">
                    <span>Required approvers</span>
                    <strong>{observation.approvals.required.join(", ")}</strong>
                  </div>
                  <div className="info-row">
                    <span>Quorum on this head</span>
                    <strong>
                      {observation.approvals.satisfied
                        ? "Satisfied by newest decisive reviews"
                        : "Not satisfied"}
                    </strong>
                  </div>
                  {observation.approvals.items.length === 0 ? (
                    <p className="muted-copy">No decisive review was observed on this head.</p>
                  ) : (
                    <ul className="governance-items">
                      {observation.approvals.items.map((item) => (
                        <li key={`${item.identity}:${item.submitted_at}`}>
                          <strong>{redactText(item.identity)}</strong>
                          <span
                            className={`review-state-pill review-tone-${
                              item.decision === "approved" ? "done" : "danger"
                            }`}
                          >
                            {GOVERNANCE_APPROVAL_LABELS[item.decision] ?? item.decision}
                          </span>
                          <span className="mono">head {shortId(item.head_sha, 12)}</span>
                          <span>{formatDate(item.submitted_at)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>

            <section aria-labelledby="governance-discussions-heading">
              <div className="governance-dimension-heading">
                <h5 id="governance-discussions-heading">Review conversations</h5>
                <span className="governance-dimension-state">
                  {governanceDimensionLabel(observation.review_discussions)}
                </span>
              </div>
              {observation.review_discussions.state === "observed" ? (
                <div className="info-row">
                  <span>Unresolved</span>
                  <strong>
                    {observation.review_discussions.unresolved === null
                      ? "Not readable — never treated as zero"
                      : observation.review_discussions.unresolved}
                  </strong>
                </div>
              ) : (
                <div className="info-row">
                  <span>Unresolved</span>
                  <strong>Not observed — never treated as zero</strong>
                </div>
              )}
            </section>
          </div>

          <div className="governance-not-evaluated">
            <span className="field-label">Not evaluated by this observation</span>
            <p className="muted-copy">
              {observation.not_evaluated.length === 0
                ? "The observation reports no unevaluated gate."
                : `${observation.not_evaluated
                    .map((item) => GOVERNANCE_NOT_EVALUATED_LABELS[item] ?? item)
                    .join(", ")}. Their absence from this record is not a pass.`}
            </p>
          </div>
        </>
      )}

      <div className="approval-actions">
        <button
          type="button"
          className="button button-secondary button-small"
          onClick={onRefresh}
          disabled={observing}
        >
          {observing ? "Observing…" : "Refresh observation"}
        </button>
      </div>
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
