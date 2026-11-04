import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiError } from "../api/client";
import type { Approval, Candidate, ForgePilotClient, IssueApprovalDecision } from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import {
  approvalDecisionGate,
  approvalStateLabel,
  approvalStateTone,
  approvalsForCandidate,
  digestLabel,
  invalidatedDetail,
  latestCandidate,
  riskClassLabel,
  riskTone,
} from "../ui/change-review";
import { formatDate, shortId } from "../ui/format";
import { redactText } from "../ui/redaction";
import { describeIssueError, errorLabel } from "./errors";
import type { IssueError } from "./errors";
import type { ApprovalDecisionGate } from "../ui/change-review";

export interface ChangeReviewCardProps {
  client: ForgePilotClient;
  workspaceId: string;
  issueId: string;
  currentUserId?: string;
  canMutate: boolean;
  candidates: Candidate[];
  approvals: Approval[];
  loading: boolean;
  error: IssueError | undefined;
  onRetry: () => void;
  onApprovalUpdated: (approval: Approval) => void;
  onChanged: () => void;
}

export function ChangeReviewCard({
  client,
  workspaceId,
  issueId,
  currentUserId,
  canMutate,
  candidates,
  approvals,
  loading,
  error,
  onRetry,
  onApprovalUpdated,
  onChanged,
}: ChangeReviewCardProps): ReactElement {
  const newest = useMemo(() => latestCandidate(candidates), [candidates]);
  const [selectedId, setSelectedId] = useState<string | undefined>(newest?.candidate_id);
  const [decisionMode, setDecisionMode] = useState<"approve" | "reject" | undefined>(undefined);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<IssueError | undefined>(undefined);
  const [cardError, setCardError] = useState<string | undefined>(undefined);
  const decisionKeys = useRef(new CreateIdempotencyKeys());

  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedId(undefined);
      return;
    }
    setSelectedId((current) => {
      if (current && candidates.some((candidate) => candidate.candidate_id === current)) {
        return current;
      }
      return newest?.candidate_id;
    });
  }, [candidates, newest]);

  const selected = candidates.find((candidate) => candidate.candidate_id === selectedId) ?? newest;
  const candidateApprovals = selected
    ? approvalsForCandidate(approvals, selected.candidate_id)
    : [];
  const approval = candidateApprovals[0];
  const gate = selected
    ? approvalDecisionGate({
        approval,
        candidate: selected,
        latestCandidateId: newest?.candidate_id,
        currentUserId,
        canMutate,
      })
    : undefined;

  // A reload can invalidate the request under an open dialog. Close it rather
  // than leave a submit button the service must refuse.
  useEffect(() => {
    if (decisionMode && gate && !gate.canDecide) setDecisionMode(undefined);
  }, [decisionMode, gate?.canDecide]);

  async function submitDecision(note: string): Promise<void> {
    if (!approval || !selected || !decisionMode) return;
    const input: IssueApprovalDecision = {
      decision: decisionMode,
      diff_digest: { algorithm: selected.diff.digest_algorithm, value: selected.diff.digest },
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const signature = { approval_id: approval.approval_id, ...input };
    setDecisionBusy(true);
    setDecisionError(undefined);
    try {
      const key = decisionKeys.current.forInput(signature);
      const updated = await client.decideIssueApproval(
        workspaceId,
        issueId,
        approval.approval_id,
        input,
        key,
      );
      decisionKeys.current.complete(signature);
      onApprovalUpdated(updated);
      setDecisionMode(undefined);
      onRetry();
      onChanged();
    } catch (caught) {
      const described = describeIssueError(caught);
      setDecisionError(described);
      // A conflict means the local projection is stale (binding, expiry, or
      // state changed). Re-read the authoritative record and close the dialog.
      if (caught instanceof ApiError && (caught.status === 409 || caught.status === 404)) {
        setCardError(errorLabel(described));
        setDecisionMode(undefined);
        onRetry();
        onChanged();
      }
    } finally {
      setDecisionBusy(false);
    }
  }

  return (
    <section className="card change-review-card" aria-labelledby="change-review-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Pre-PR gate</span>
          <h3 id="change-review-heading">Change review</h3>
        </div>
        {approval ? (
          <span className={`approval-state-pill review-tone-${approvalStateTone(approval.state)}`}>
            {approvalStateLabel(approval.state)}
          </span>
        ) : (
          <span className="review-state-pill review-tone-neutral">No approval request</span>
        )}
      </div>
      <p className="stage-description">
        A frozen candidate is reviewed here before any branch push or pull request. The approval is
        bound to this exact head commit and diff digest; the service records the named human
        approver and never accepts an agent, anonymous, or bearer approval.
      </p>

      {cardError && (
        <div className="inline-error" role="alert">
          <span>{cardError}</span>
          <button
            type="button"
            aria-label="Dismiss change review error"
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
            <strong>Change review could not be loaded</strong>
            <span>{errorLabel(error)}</span>
          </div>
          <button type="button" className="button button-quiet button-small" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {loading && candidates.length === 0 && !error && (
        <div className="card-empty compact">Reading candidates and approvals…</div>
      )}

      {!loading && !error && candidates.length === 0 && (
        <div className="card-empty">
          No candidate has been frozen for this issue. Review evidence appears only after a
          preparation run stops and the service freezes an immutable candidate.
        </div>
      )}

      {selected && (
        <>
          {candidates.length > 1 && (
            <div className="candidate-picker" role="group" aria-label="Frozen candidates">
              <span className="field-label">Frozen candidates</span>
              <div className="candidate-chips">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.candidate_id}
                    type="button"
                    className={`candidate-chip ${
                      candidate.candidate_id === selected.candidate_id
                        ? "candidate-chip-active"
                        : ""
                    }`}
                    aria-pressed={candidate.candidate_id === selected.candidate_id}
                    onClick={() => {
                      setSelectedId(candidate.candidate_id);
                      setDecisionError(undefined);
                      setCardError(undefined);
                    }}
                  >
                    <span className="mono">{candidate.candidate_id}</span>
                    <span>{riskClassLabel(candidate.risk.class)}</span>
                    <span>{formatDate(candidate.created_at)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <CandidateSummary
            candidate={selected}
            superseded={selected.candidate_id !== newest?.candidate_id}
          />

          <ApprovalPanel
            approval={approval}
            history={candidateApprovals.slice(1)}
            gate={gate}
            onDecide={(mode) => {
              setDecisionError(undefined);
              setDecisionMode(mode);
            }}
          />
        </>
      )}

      {decisionMode && selected && approval && (
        <ApprovalDecisionDialog
          mode={decisionMode}
          candidate={selected}
          approval={approval}
          busy={decisionBusy}
          error={decisionError}
          onCancel={() => {
            setDecisionMode(undefined);
            setDecisionError(undefined);
          }}
          onSubmit={(note) => void submitDecision(note)}
        />
      )}
    </section>
  );
}

function CandidateSummary({
  candidate,
  superseded,
}: {
  candidate: Candidate;
  superseded: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(true);
  const evidenceId = `candidate-evidence-${candidate.candidate_id}`;
  return (
    <article className="candidate-review" aria-labelledby="candidate-review-title">
      <div className="candidate-review-heading">
        <div>
          <span className="eyebrow">Frozen candidate</span>
          <h4 id="candidate-review-title" className="mono">
            {redactText(candidate.candidate_id)}
          </h4>
        </div>
        <div className="candidate-badges">
          <span className={`review-state-pill review-tone-${riskTone(candidate.risk.class)}`}>
            {riskClassLabel(candidate.risk.class)}
          </span>
          {superseded && <span className="review-state-pill review-tone-danger">Superseded</span>}
        </div>
      </div>
      <p className="candidate-summary">{redactText(candidate.summary)}</p>
      <div className="candidate-binding-facts">
        <div>
          <span className="metric-label">Base</span>
          <strong className="mono">{shortId(candidate.base_sha, 16)}</strong>
        </div>
        <div>
          <span className="metric-label">Candidate head</span>
          <strong className="mono">{shortId(candidate.head_sha, 16)}</strong>
        </div>
        <div>
          <span className="metric-label">Diff digest</span>
          <strong className="mono">
            {candidate.diff.digest_algorithm}:{shortId(candidate.diff.digest, 20)}
          </strong>
        </div>
        <div>
          <span className="metric-label">Frozen</span>
          <strong>{formatDate(candidate.created_at)}</strong>
        </div>
      </div>
      <button
        type="button"
        className="button button-quiet button-small review-expand"
        aria-expanded={expanded}
        aria-controls={evidenceId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide review evidence" : "Expand review evidence"}
      </button>
      {expanded && (
        <div id={evidenceId} className="review-evidence">
          <section aria-labelledby="review-diff-heading">
            <h5 id="review-diff-heading">Authorized diff</h5>
            <div className="info-row">
              <span>Digest</span>
              <strong className="mono">
                {candidate.diff.digest_algorithm}:{candidate.diff.digest}
              </strong>
            </div>
            <div className="info-row">
              <span>Change size</span>
              <strong>
                +{candidate.diff.insertions} / −{candidate.diff.deletions} across{" "}
                {candidate.diff.changed_paths.length}{" "}
                {candidate.diff.changed_paths.length === 1 ? "path" : "paths"}
              </strong>
            </div>
            {candidate.diff.changed_paths.length === 0 ? (
              <p className="muted-copy">The service reported no changed path.</p>
            ) : (
              <ul className="review-paths">
                {candidate.diff.changed_paths.map((changedPath) => (
                  <li key={changedPath} className="mono">
                    {redactText(changedPath)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="review-tests-heading">
            <h5 id="review-tests-heading">Validation evidence</h5>
            <div className="info-row">
              <span>Environment</span>
              <strong>{redactText(candidate.validation.environment)}</strong>
            </div>
            <div className="info-row">
              <span>Config digest</span>
              <strong className="mono">{redactText(candidate.validation.config_digest)}</strong>
            </div>
            {candidate.validation.results.length === 0 ? (
              <p className="muted-copy">No validation attempt was recorded for this candidate.</p>
            ) : (
              <div className="review-table-scroll">
                <table className="review-table">
                  <caption>Validation attempts against this exact candidate revision</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Exit</th>
                      <th scope="col">Output digest</th>
                      <th scope="col">Event reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidate.validation.results.map((result) => (
                      <tr key={`${result.tool}:${result.event_reference}`}>
                        <td>{result.tool}</td>
                        <td>
                          {result.exit_status === null ? (
                            <span className="review-exit review-exit-unknown">Unknown</span>
                          ) : (
                            <span
                              className={`review-exit ${
                                result.exit_status === 0 ? "review-exit-pass" : "review-exit-fail"
                              }`}
                            >
                              {result.exit_status === 0 ? "Pass" : `Exit ${result.exit_status}`}
                            </span>
                          )}
                        </td>
                        <td className="mono">{digestLabel(result.output_digest)}</td>
                        <td className="mono">{redactText(result.event_reference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="review-risk-heading">
            <h5 id="review-risk-heading">Risk</h5>
            <div className="info-row">
              <span>Class</span>
              <strong>{riskClassLabel(candidate.risk.class)}</strong>
            </div>
            <div className="info-row">
              <span>Decision code</span>
              <strong className="mono">{redactText(candidate.risk.decision_code)}</strong>
            </div>
            <div className="info-row">
              <span>Human approval required</span>
              <strong>{candidate.risk.requires_human_approval ? "Yes" : "No"}</strong>
            </div>
          </section>

          <section aria-labelledby="review-provenance-heading">
            <h5 id="review-provenance-heading">Provenance</h5>
            <div className="info-row">
              <span>Run</span>
              <strong className="mono">{redactText(candidate.run_id)}</strong>
            </div>
            <div className="info-row">
              <span>Repository</span>
              <strong>{redactText(candidate.repository.repository_id)}</strong>
            </div>
            <div className="info-row">
              <span>Base revision</span>
              <strong className="mono">{candidate.base_sha}</strong>
            </div>
            <div className="info-row">
              <span>Head revision</span>
              <strong className="mono">{candidate.head_sha}</strong>
            </div>
            <div className="info-row">
              <span>Tree</span>
              <strong className="mono">{candidate.tree_sha}</strong>
            </div>
            <span className="field-label">Artifacts</span>
            {candidate.artifacts.length === 0 ? (
              <p className="muted-copy">No artifact reference was attached.</p>
            ) : (
              <ul className="review-artifacts">
                {candidate.artifacts.map((artifact) => (
                  <li key={artifact.artifact_id}>
                    <strong>{redactText(artifact.kind)}</strong>
                    <span className="mono">{redactText(artifact.artifact_id)}</span>
                    <span className="mono">
                      {artifact.digest_algorithm}:{artifact.digest}
                    </span>
                    <span className="mono">
                      base {shortId(artifact.base_sha, 12)} · head {shortId(artifact.head_sha, 12)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <span className="field-label">Audit references</span>
            {candidate.audit_refs.length === 0 ? (
              <p className="muted-copy">No audit reference was attached.</p>
            ) : (
              <ul className="review-audit-refs">
                {candidate.audit_refs.map((reference) => (
                  <li key={reference} className="mono">
                    {redactText(reference)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

function ApprovalPanel({
  approval,
  history,
  gate,
  onDecide,
}: {
  approval: Approval | undefined;
  history: Approval[];
  gate: ApprovalDecisionGate | undefined;
  onDecide: (mode: "approve" | "reject") => void;
}): ReactElement {
  return (
    <section className="approval-panel" aria-labelledby="approval-panel-heading">
      <div className="approval-panel-heading">
        <h5 id="approval-panel-heading">Candidate-bound approval</h5>
        {approval && (
          <span className={`review-state-pill review-tone-${approvalStateTone(approval.state)}`}>
            {approvalStateLabel(approval.state)}
          </span>
        )}
      </div>
      {!approval ? (
        <p className="review-gate-note">
          No approval request exists for this candidate. The service names the eligible human
          approver; this workbench cannot create a request or approve on its behalf.
        </p>
      ) : (
        <>
          <div className="info-row">
            <span>Approval</span>
            <strong className="mono">{redactText(approval.approval_id)}</strong>
          </div>
          <div className="info-row">
            <span>Approver</span>
            <strong>
              {approval.approver
                ? `${redactText(approval.approver.display_name)} · ${redactText(approval.approver.id)}`
                : "No eligible named approver yet"}
            </strong>
          </div>
          <div className="info-row">
            <span>Requested</span>
            <strong>{formatDate(approval.requested_at)}</strong>
          </div>
          <div className="info-row">
            <span>Expires</span>
            <strong>{formatDate(approval.expires_at)}</strong>
          </div>
          <div className="info-row">
            <span>Bound diff digest</span>
            <strong className="mono">{digestLabel(approval.binding.diff_digest)}</strong>
          </div>
          {approval.state === "invalidated" && (
            <div className="reason-card approval-invalidated" role="status">
              <span className="reason-icon">!</span>
              <div>
                <strong>Approval invalidated</strong>
                <p>{invalidatedDetail(approval) ?? "The service invalidated this approval."}</p>
              </div>
            </div>
          )}
          {approval.decision && (
            <div className="approval-decision" role="status">
              <strong>
                {approval.decision.decision === "approve" ? "Approved" : "Rejected"} by{" "}
                {redactText(approval.decision.decided_by.display_name)} ·{" "}
                {formatDate(approval.decision.decided_at)}
              </strong>
              {approval.decision.note && <p>{redactText(approval.decision.note)}</p>}
            </div>
          )}
          {approval.consumed_by_delivery_id && (
            <p className="muted-copy mono">
              Consumed by delivery {redactText(approval.consumed_by_delivery_id)}
            </p>
          )}
          {gate && (
            <p
              className={`review-gate-note ${gate.canDecide ? "review-gate-ready" : ""}`}
              role="status"
            >
              {gate.canDecide
                ? "You are the named approver. Your authenticated identity and the reviewed diff digest are recorded with the decision."
                : gate.reason}
            </p>
          )}
          {gate?.canDecide && (
            <div className="approval-actions">
              <button
                type="button"
                className="button button-primary button-small"
                onClick={() => onDecide("approve")}
              >
                Approve candidate
              </button>
              <button
                type="button"
                className="button button-secondary button-small"
                onClick={() => onDecide("reject")}
              >
                Reject candidate
              </button>
            </div>
          )}
        </>
      )}
      {history.length > 0 && (
        <div className="approval-history">
          <span className="field-label">Earlier requests for this candidate</span>
          <ul>
            {history.map((entry) => (
              <li key={entry.approval_id}>
                <span className="mono">{redactText(entry.approval_id)}</span>
                <span>{approvalStateLabel(entry.state)}</span>
                <span>{formatDate(entry.requested_at)}</span>
                {entry.decision?.note && <span>{redactText(entry.decision.note)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ApprovalDecisionDialog({
  mode,
  candidate,
  approval,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  mode: "approve" | "reject";
  candidate: Candidate;
  approval: Approval;
  busy: boolean;
  error: IssueError | undefined;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}): ReactElement {
  const [note, setNote] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requiresNote = mode === "reject";
  const invalid = requiresNote && note.trim().length === 0;
  const headingId = `approval-${mode}-title`;
  const descriptionId = `approval-${mode}-description`;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (invalid || busy) return;
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
        className="modal approval-decision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <span className="eyebrow">Pre-PR approval · {approval.approval_id}</span>
        <h2 id={headingId}>
          {mode === "approve" ? "Approve frozen candidate" : "Reject frozen candidate"}
        </h2>
        <p id={descriptionId}>
          {mode === "approve"
            ? "Approval authorizes one broker delivery of this exact revision. It is not a merge, a review replacement, or a check waiver."
            : "A rejection refuses delivery for this candidate and is recorded with your reason. A new candidate requires a new request."}
        </p>
        <div className="approval-dialog-facts">
          <div className="info-row">
            <span>Candidate</span>
            <strong className="mono">{redactText(candidate.candidate_id)}</strong>
          </div>
          <div className="info-row">
            <span>Head commit</span>
            <strong className="mono">{candidate.head_sha}</strong>
          </div>
          <div className="info-row">
            <span>Reviewed diff digest</span>
            <strong className="mono">
              {candidate.diff.digest_algorithm}:{candidate.diff.digest}
            </strong>
          </div>
        </div>
        <label className="field-block">
          <span className="field-label">
            {requiresNote ? "Rejection reason (required)" : "Decision note (optional)"}
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            required={requiresNote}
            disabled={busy}
          />
        </label>
        {error && (
          <div className="inline-error approval-dialog-error" role="alert">
            <span>{errorLabel(error)}</span>
          </div>
        )}
        <p className="muted-copy">
          The approver is your authenticated session — never a field in this form or a bearer
          credential.
        </p>
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
          <button
            type="submit"
            className={`button ${mode === "approve" ? "button-primary" : "button-danger"}`}
            disabled={invalid || busy}
          >
            {busy
              ? "Recording…"
              : mode === "approve"
                ? "Approve this candidate"
                : "Reject candidate"}
          </button>
        </div>
      </form>
    </div>
  );
}
