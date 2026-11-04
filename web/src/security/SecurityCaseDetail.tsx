import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  ForgePilotClient,
  SecurityAuditEntry,
  SecurityCase,
  SecurityCaseState,
  SecurityQuarantineGrant,
  SecurityRecoveryApproval,
  SecurityRecoveryDispatch,
} from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import { shortId } from "../ui/format";
import { redactText } from "../ui/redaction";
import { Select } from "../ui/Select";
import { SecurityEmptyState, SecurityErrorNotice } from "./SecurityNotice";
import {
  approvalDispatchable,
  approvalIsExpired,
  approvalStateNote,
  auditEventSummary,
  caseReviewIndependence,
  describeSecurityError,
  formatSecurityTime,
  isReviewTransition,
  SECURITY_CASE_STATE_LABELS,
  SECURITY_CASE_STATE_TONES,
  securityEventLabel,
  transitionLabel,
} from "./security-format";
import type { SecurityErrorDescription } from "./security-format";

const CASE_HISTORY_PURPOSE = "case disposition: read the append-only security history";
const TTL_OPTIONS = [
  { value: "300", label: "5 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "60 minutes" },
];

interface SecurityCaseDetailProps {
  client: ForgePilotClient;
  workspaceId: string;
  caseId: string;
  seed: SecurityCase | undefined;
  userId: string | undefined;
  canAdminister: boolean;
  onBack: () => void;
  onChanged: (next: SecurityCase) => void;
}

/**
 * One redacted disposal case. The panel never renders quarantined content
 * unless an inspected grant returned it through an explicit, acknowledged
 * action, and it offers no route that sends blocked bytes without handling,
 * independent review, and a complete recheck.
 */
export function SecurityCaseDetail({
  client,
  workspaceId,
  caseId,
  seed,
  userId,
  canAdminister,
  onBack,
  onChanged,
}: SecurityCaseDetailProps): ReactElement {
  const [securityCase, setSecurityCase] = useState<SecurityCase | undefined>(seed);
  const [loading, setLoading] = useState(seed === undefined);
  const [loadError, setLoadError] = useState<SecurityErrorDescription>();
  const [reloadToken, setReloadToken] = useState(0);

  const [entries, setEntries] = useState<SecurityAuditEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState<SecurityErrorDescription>();
  const [timelineToken, setTimelineToken] = useState(0);

  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<SecurityErrorDescription>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [armedTermination, setArmedTermination] = useState(false);
  const transitionKeys = useRef(new CreateIdempotencyKeys());
  const ownerKeys = useRef(new CreateIdempotencyKeys());

  const [grantSubject, setGrantSubject] = useState("");
  const [grantQuarantineId, setGrantQuarantineId] = useState("");
  const [grants, setGrants] = useState<Record<string, SecurityQuarantineGrant>>({});
  const [viewGrantIds, setViewGrantIds] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [quarantineContent, setQuarantineContent] = useState<Record<string, string>>({});
  const [quarantineBusy, setQuarantineBusy] = useState<string>();
  const [quarantineError, setQuarantineError] = useState<SecurityErrorDescription>();
  const grantKeys = useRef(new CreateIdempotencyKeys());

  const [approval, setApproval] = useState<SecurityRecoveryApproval>();
  const [approvalLookup, setApprovalLookup] = useState("");
  const [recoveryDestination, setRecoveryDestination] = useState({
    endpoint_id: "",
    model_id: "",
    ttl_seconds: "900",
  });
  const [dispatchWorker, setDispatchWorker] = useState("");
  const [dispatchAcknowledged, setDispatchAcknowledged] = useState(false);
  const [dispatchResult, setDispatchResult] = useState<SecurityRecoveryDispatch>();
  const [recoveryError, setRecoveryError] = useState<SecurityErrorDescription>();
  const [recoveryBusy, setRecoveryBusy] = useState<string>();
  const recoveryKeys = useRef(new CreateIdempotencyKeys());

  useEffect(() => {
    let active = true;
    setLoading(true);
    client
      .getSecurityCase(workspaceId, caseId)
      .then((next) => {
        if (!active) return;
        setSecurityCase(next);
        setLoadError(undefined);
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(describeSecurityError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, caseId, reloadToken]);

  useEffect(() => {
    let active = true;
    setTimelineLoading(true);
    client
      .readSecurityAuditTrail(workspaceId, {
        purpose: CASE_HISTORY_PURPOSE,
        case_id: caseId,
      })
      .then((page) => {
        if (!active) return;
        setEntries(page.items);
        setTimelineError(undefined);
      })
      .catch((caught: unknown) => {
        if (active) setTimelineError(describeSecurityError(caught));
      })
      .finally(() => {
        if (active) setTimelineLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, caseId, timelineToken]);

  const independence = timelineError ? "unknown" : caseReviewIndependence(entries, userId);
  const canReview = independence === "independent";
  const reviewBlockedCopy =
    independence === "self"
      ? "You handled this review round. An independent reviewer must decide; self-review is never available."
      : "Independence cannot be verified while the append-only history is unavailable. Retry the history first.";

  async function submitTransition(to: SecurityCaseState): Promise<void> {
    if (!securityCase) return;
    if (to === "terminated" && !armedTermination) {
      setArmedTermination(true);
      return;
    }
    const body = { to, ...(note.trim() ? { note: note.trim() } : {}) };
    const key = transitionKeys.current.forInput(body);
    setBusy(`transition:${to}`);
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const next = await client.transitionSecurityCase(workspaceId, caseId, body, key);
      transitionKeys.current.complete(body);
      setSecurityCase(next);
      setNote("");
      setArmedTermination(false);
      setTimelineToken((value) => value + 1);
      onChanged(next);
      setActionNotice(
        to === "terminated"
          ? "Case terminated. The append-only history records the decision."
          : "Disposition recorded. The append-only history records the new state.",
      );
    } catch (caught) {
      setActionError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function submitOwnerRequest(kind: "termination" | "reassignment"): Promise<void> {
    const body = note.trim() ? { note: note.trim() } : {};
    const key = ownerKeys.current.forInput({ kind, body });
    setBusy(`owner:${kind}`);
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const next =
        kind === "termination"
          ? await client.requestSecurityCaseTermination(workspaceId, caseId, body, key)
          : await client.requestSecurityCaseReassignment(workspaceId, caseId, body, key);
      ownerKeys.current.complete({ kind, body });
      setSecurityCase(next);
      setActionNotice(
        "Request recorded. A request is never executed directly: handling or administration must still disposition the case.",
      );
      onChanged(next);
    } catch (caught) {
      setActionError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function submitGrant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!securityCase || !grantSubject.trim() || !grantQuarantineId) return;
    const body = { quarantine_id: grantQuarantineId, subject: grantSubject.trim() };
    const key = grantKeys.current.forInput(body);
    setQuarantineBusy(`grant:${grantQuarantineId}`);
    setQuarantineError(undefined);
    try {
      const grant = await client.grantSecurityQuarantineAccess(workspaceId, caseId, body, key);
      grantKeys.current.complete(body);
      setGrants((current) => ({ ...current, [grant.quarantine_id]: grant }));
      setViewGrantIds((current) => ({ ...current, [grant.quarantine_id]: grant.grant_id }));
      setGrantSubject("");
    } catch (caught) {
      setQuarantineError(describeSecurityError(caught));
    } finally {
      setQuarantineBusy(undefined);
    }
  }

  async function inspectQuarantine(quarantineId: string): Promise<void> {
    const grantId = (viewGrantIds[quarantineId] ?? "").trim();
    if (!grantId || !acknowledged[quarantineId]) return;
    setQuarantineBusy(`view:${quarantineId}`);
    setQuarantineError(undefined);
    try {
      const view = await client.viewQuarantinedContext(workspaceId, quarantineId, grantId);
      setQuarantineContent((current) => ({ ...current, [quarantineId]: view.content }));
      setAcknowledged((current) => ({ ...current, [quarantineId]: false }));
      setTimelineToken((value) => value + 1);
    } catch (caught) {
      setQuarantineError(describeSecurityError(caught));
    } finally {
      setQuarantineBusy(undefined);
    }
  }

  async function approveRecovery(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const ttl = Number(recoveryDestination.ttl_seconds);
    if (
      !recoveryDestination.endpoint_id.trim() ||
      !recoveryDestination.model_id.trim() ||
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > 3600
    ) {
      setRecoveryError({
        code: "RECOVERY_INPUT_INVALID",
        message: "Choose a destination endpoint, model, and an expiry between 1 and 3600 seconds.",
        status: 0,
        retryable: false,
        nextAction: null,
      });
      return;
    }
    const body = {
      destination: {
        endpoint_id: recoveryDestination.endpoint_id.trim(),
        model_id: recoveryDestination.model_id.trim(),
      },
      ttl_seconds: ttl,
    };
    const key = recoveryKeys.current.forInput(body);
    setRecoveryBusy("approve");
    setRecoveryError(undefined);
    try {
      const next = await client.approveSecurityRecovery(workspaceId, caseId, body, key);
      recoveryKeys.current.complete(body);
      setApproval(next);
      setDispatchResult(undefined);
      setDispatchAcknowledged(false);
      setTimelineToken((value) => value + 1);
    } catch (caught) {
      setRecoveryError(describeSecurityError(caught));
    } finally {
      setRecoveryBusy(undefined);
    }
  }

  async function loadApproval(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!approvalLookup.trim()) return;
    setRecoveryBusy("load");
    setRecoveryError(undefined);
    try {
      const next = await client.getSecurityRecoveryApproval(workspaceId, approvalLookup.trim());
      setApproval(next);
      setDispatchResult(undefined);
    } catch (caught) {
      setRecoveryError(describeSecurityError(caught));
    } finally {
      setRecoveryBusy(undefined);
    }
  }

  async function revokeApproval(): Promise<void> {
    if (!approval) return;
    const key = recoveryKeys.current.forInput({ revoke: approval.authorization_id });
    setRecoveryBusy("revoke");
    setRecoveryError(undefined);
    try {
      const next = await client.revokeSecurityRecoveryApproval(
        workspaceId,
        approval.authorization_id,
        key,
      );
      recoveryKeys.current.complete({ revoke: approval.authorization_id });
      setApproval(next);
      setTimelineToken((value) => value + 1);
    } catch (caught) {
      setRecoveryError(describeSecurityError(caught));
    } finally {
      setRecoveryBusy(undefined);
    }
  }

  async function dispatchRecovery(): Promise<void> {
    if (
      !approval ||
      !approvalDispatchable(approval) ||
      !dispatchWorker.trim() ||
      !dispatchAcknowledged
    )
      return;
    const body = { worker_id: dispatchWorker.trim() };
    const key = recoveryKeys.current.forInput({ dispatch: approval.authorization_id, body });
    setRecoveryBusy("dispatch");
    setRecoveryError(undefined);
    try {
      const result = await client.dispatchSecurityRecovery(
        workspaceId,
        approval.authorization_id,
        body,
        key,
      );
      recoveryKeys.current.complete({ dispatch: approval.authorization_id, body });
      setDispatchResult(result);
      setDispatchAcknowledged(false);
      setTimelineToken((value) => value + 1);
      try {
        setApproval(
          await client.getSecurityRecoveryApproval(workspaceId, approval.authorization_id),
        );
      } catch {
        // The dispatch result stands; the authorization refresh is informational.
      }
    } catch (caught) {
      setRecoveryError(describeSecurityError(caught));
    } finally {
      setRecoveryBusy(undefined);
    }
  }

  if (!securityCase) {
    return (
      <section className="detail-view" aria-labelledby="security-case-heading">
        <div className="breadcrumb">
          <button type="button" className="detail-back" onClick={onBack}>
            ← Security cases
          </button>
        </div>
        {loadError ? (
          <SecurityEmptyState
            icon="!"
            action={
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                Retry
              </button>
            }
          >
            {loadError.code}: {loadError.message}
          </SecurityEmptyState>
        ) : (
          <SecurityEmptyState>
            {loading ? "Reading the case…" : "Case not found."}
          </SecurityEmptyState>
        )}
      </section>
    );
  }

  const state = securityCase.state;
  const transitions = securityCase.allowed_transitions.filter((edge) => edge !== state);

  return (
    <section className="detail-view security-detail" aria-labelledby="security-case-heading">
      <div className="breadcrumb">
        <button type="button" className="detail-back" onClick={onBack}>
          ← Security cases
        </button>
      </div>

      <header className="detail-header">
        <div className="detail-heading">
          <span className="eyebrow">Security case · redacted status</span>
          <h2 id="security-case-heading" className="mono">
            {securityCase.case_id}
          </h2>
          <div className="detail-subline">
            <span className={`stage-pip stage-tone-${SECURITY_CASE_STATE_TONES[state]}`} />
            <span>{SECURITY_CASE_STATE_LABELS[state]}</span>
            <span className="divider">/</span>
            <span className="mono">run {securityCase.scope.run_id}</span>
            <span className="divider">/</span>
            <span>Updated {formatSecurityTime(securityCase.updated_at)}</span>
          </div>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={() => {
              setReloadToken((value) => value + 1);
              setTimelineToken((value) => value + 1);
            }}
          >
            Refresh case
          </button>
        </div>
      </header>

      {loadError && (
        <SecurityErrorNotice error={loadError} onDismiss={() => setLoadError(undefined)} />
      )}
      {actionError && (
        <SecurityErrorNotice error={actionError} onDismiss={() => setActionError(undefined)} />
      )}
      {actionNotice && (
        <p className="security-notice" role="status">
          {actionNotice}
        </p>
      )}

      <p className="security-principle">
        Redacted status only. There is no per-call exemption: the only route out of a block is
        handling, an independent review, and a complete request recheck under current rules.
      </p>

      <div className="detail-grid">
        <div className="detail-main-column">
          <section className="card security-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Why it blocked</span>
                <h3>Block records</h3>
              </div>
              <span className="task-count">{securityCase.blocks.length}</span>
            </div>
            {securityCase.blocks.length === 0 ? (
              <p className="card-empty compact">
                The service reported no block record for this case.
              </p>
            ) : (
              <ul className="security-block-list">
                {securityCase.blocks.map((block) => (
                  <li className="security-block" key={`${block.invocation_id}:${block.at}`}>
                    <div className="security-block-topline">
                      <span className="role-chip role-member">{block.reason}</span>
                      <span className="security-block-time">{formatSecurityTime(block.at)}</span>
                    </div>
                    <p>{redactText(block.safe_detail)}</p>
                    <div className="security-block-meta mono">
                      <span>invocation {block.invocation_id}</span>
                      <span>trace {block.trace_id}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card security-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Append-only</span>
                <h3>Case history</h3>
              </div>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setTimelineToken((value) => value + 1)}
                disabled={timelineLoading}
              >
                {timelineLoading ? "Reading…" : "Refresh history"}
              </button>
            </div>
            {timelineError ? (
              <>
                <SecurityErrorNotice
                  error={timelineError}
                  onDismiss={() => setTimelineError(undefined)}
                />
                <p className="security-hint">
                  History is unavailable, so this screen cannot prove who handled the current review
                  round. Review actions stay disabled until the history can be verified.
                </p>
              </>
            ) : entries.length === 0 ? (
              <p className="card-empty compact">
                {timelineLoading
                  ? "Reading the audited history…"
                  : "No audited event is visible for this case in the current scope."}
              </p>
            ) : (
              <ol className="security-timeline">
                {[...entries]
                  .sort((left, right) => left.seq - right.seq)
                  .map((entry) => (
                    <li className="security-timeline-row" key={`${entry.seq}:${entry.hash}`}>
                      <span className="event-sequence">#{entry.seq}</span>
                      <div>
                        <div className="security-timeline-title">
                          <strong>{securityEventLabel(entry.event.event)}</strong>
                          <span className="security-block-time">
                            {formatSecurityTime(entry.event.at)}
                          </span>
                        </div>
                        <span className="identity-meta">{auditEventSummary(entry.event)}</span>
                      </div>
                    </li>
                  ))}
              </ol>
            )}
            <p className="security-hint">
              History reads are themselves audited. This view never displays suspected secret
              values, only codes, identifiers, and scrubbed text.
            </p>
          </section>

          <section className="card security-card" aria-labelledby="case-actions-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Duty-gated</span>
                <h3 id="case-actions-heading">Disposition</h3>
              </div>
            </div>
            <label className="field-label" htmlFor="security-case-note">
              Disposition note (optional, non-secret, max 2000 characters)
            </label>
            <textarea
              id="security-case-note"
              className="security-textarea mono"
              value={note}
              maxLength={2000}
              rows={3}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What was removed, which source was rebuilt, or why the disposition is safe."
            />
            {state === "awaiting_review" && (
              <p className={canReview ? "security-hint" : "security-warning"} role="note">
                {canReview
                  ? "An independent reviewer must decide. Handling and review are different people."
                  : reviewBlockedCopy}
              </p>
            )}
            {transitions.length === 0 ? (
              <p className="card-empty compact">
                The service reports no allowed transition from this state.
              </p>
            ) : (
              <div className="transition-actions">
                {transitions.map((edge) => {
                  const reviewEdge = isReviewTransition(state, edge);
                  const disabled = busy !== undefined || (reviewEdge && !canReview);
                  const label = transitionLabel(state, edge);
                  if (edge === "terminated" && armedTermination) {
                    return (
                      <button
                        key={edge}
                        type="button"
                        className="button button-danger button-small"
                        disabled={disabled}
                        onClick={() => void submitTransition(edge)}
                      >
                        {busy === `transition:${edge}` ? "Terminating…" : "Confirm termination"}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={edge}
                      type="button"
                      className={
                        edge === "terminated"
                          ? "button button-quiet button-small"
                          : "button button-secondary button-small"
                      }
                      disabled={disabled}
                      title={reviewEdge && !canReview ? reviewBlockedCopy : undefined}
                      onClick={() => void submitTransition(edge)}
                    >
                      {busy === `transition:${edge}` ? "Recording…" : label}
                    </button>
                  );
                })}
              </div>
            )}
            {armedTermination && (
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setArmedTermination(false)}
              >
                Cancel termination
              </button>
            )}
            <div className="security-owner-requests">
              <span className="field-label">Task-owner request (recorded, never executed)</span>
              <div className="transition-actions">
                <button
                  type="button"
                  className="button button-quiet button-small"
                  disabled={busy !== undefined}
                  onClick={() => void submitOwnerRequest("termination")}
                >
                  {busy === "owner:termination" ? "Recording…" : "Request termination"}
                </button>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  disabled={busy !== undefined}
                  onClick={() => void submitOwnerRequest("reassignment")}
                >
                  {busy === "owner:reassignment" ? "Recording…" : "Request reassignment"}
                </button>
              </div>
            </div>
          </section>

          <section className="card security-card" aria-labelledby="case-quarantine-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Metadata only</span>
                <h3 id="case-quarantine-heading">Quarantine</h3>
              </div>
              <span className="task-count">{securityCase.quarantine_ids.length}</span>
            </div>
            {securityCase.quarantine_ids.length === 0 ? (
              <p className="card-empty compact">
                No quarantined record is attached. Nothing raw is retained for this case.
              </p>
            ) : (
              <>
                <p className="security-hint">
                  Raw context is encrypted and access-controlled. Every inspection needs a separate,
                  time-limited grant and is audited, whether it succeeds or is denied.
                </p>
                {quarantineError && (
                  <SecurityErrorNotice
                    error={quarantineError}
                    onDismiss={() => setQuarantineError(undefined)}
                  />
                )}
                <ul className="security-quarantine-list">
                  {securityCase.quarantine_ids.map((quarantineId) => {
                    const grant = grants[quarantineId];
                    const content = quarantineContent[quarantineId];
                    return (
                      <li className="security-quarantine" key={quarantineId}>
                        <div className="security-quarantine-head">
                          <span className="mono">{quarantineId}</span>
                          {grant ? (
                            <span className="role-chip role-admin">
                              grant {grant.grant_id} · expires{" "}
                              {formatSecurityTime(grant.expires_at)}
                            </span>
                          ) : (
                            <span className="role-chip role-viewer">no grant loaded</span>
                          )}
                        </div>
                        <div className="security-quarantine-controls">
                          <div className="field-block">
                            <label className="field-label" htmlFor={`grant-${quarantineId}`}>
                              Inspection grant id (issued by an enterprise security administrator)
                            </label>
                            <input
                              id={`grant-${quarantineId}`}
                              className="security-input mono"
                              value={viewGrantIds[quarantineId] ?? ""}
                              onChange={(event) =>
                                setViewGrantIds((current) => ({
                                  ...current,
                                  [quarantineId]: event.target.value,
                                }))
                              }
                              placeholder="qg_…"
                            />
                          </div>
                          <label className="security-check">
                            <input
                              type="checkbox"
                              checked={Boolean(acknowledged[quarantineId])}
                              onChange={(event) =>
                                setAcknowledged((current) => ({
                                  ...current,
                                  [quarantineId]: event.target.checked,
                                }))
                              }
                            />
                            <span>
                              I understand this view returns raw context, is audited, and the
                              content must not be copied, cached, or logged.
                            </span>
                          </label>
                          <div className="transition-actions">
                            <button
                              type="button"
                              className="button button-secondary button-small"
                              disabled={
                                quarantineBusy !== undefined ||
                                !(viewGrantIds[quarantineId] ?? "").trim() ||
                                !acknowledged[quarantineId]
                              }
                              onClick={() => void inspectQuarantine(quarantineId)}
                            >
                              {quarantineBusy === `view:${quarantineId}`
                                ? "Inspecting…"
                                : "Inspect quarantined context"}
                            </button>
                            {content !== undefined && (
                              <button
                                type="button"
                                className="button button-quiet button-small"
                                onClick={() =>
                                  setQuarantineContent((current) => {
                                    const next = { ...current };
                                    delete next[quarantineId];
                                    return next;
                                  })
                                }
                              >
                                Clear from screen
                              </button>
                            )}
                          </div>
                          {content !== undefined && (
                            <pre className="quarantine-content" tabIndex={0}>
                              {content}
                            </pre>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {canAdminister ? (
                  <form className="security-form" onSubmit={(event) => void submitGrant(event)}>
                    <span className="field-label">Administrator: issue one scoped grant</span>
                    <div className="security-form-row">
                      <div className="field-block security-grow">
                        <label className="field-label" htmlFor="grant-quarantine-id">
                          Quarantined record
                        </label>
                        <Select
                          id="grant-quarantine-id"
                          value={grantQuarantineId}
                          onChange={setGrantQuarantineId}
                          options={[
                            { value: "", label: "Choose quarantined record" },
                            ...securityCase.quarantine_ids.map((id) => ({ value: id, label: id })),
                          ]}
                        />
                      </div>
                      <input
                        className="security-input mono"
                        aria-label="Grant subject"
                        placeholder="subject principal id"
                        value={grantSubject}
                        onChange={(event) => setGrantSubject(event.target.value)}
                      />
                      <button
                        type="submit"
                        className="button button-secondary button-small"
                        disabled={
                          quarantineBusy !== undefined || !grantQuarantineId || !grantSubject.trim()
                        }
                      >
                        {quarantineBusy?.startsWith("grant:") ? "Issuing…" : "Issue grant"}
                      </button>
                    </div>
                    <p className="security-hint">
                      A grant is issued only to a handler or independent reviewer, for one record,
                      with an expiry. It is never a transferable credential for a case.
                    </p>
                  </form>
                ) : (
                  <p className="security-hint">
                    Issuing quarantine grants requires the enterprise security administrator duty.
                    The service still verifies every inspection.
                  </p>
                )}
              </>
            )}
          </section>

          <section className="card security-card" aria-labelledby="case-recovery-heading">
            <div className="card-heading">
              <div>
                <span className="eyebrow">One recheck, one attempt</span>
                <h3 id="case-recovery-heading">Recovery authorization</h3>
              </div>
            </div>
            <p className="security-hint">
              An approval authorizes one recheck of the complete rebuilt request. It is not a send
              control: sending is a separate, audited dispatch outcome. Unchanged uncertainty keeps
              the request blocked.
            </p>
            {recoveryError && (
              <SecurityErrorNotice
                error={recoveryError}
                onDismiss={() => setRecoveryError(undefined)}
              />
            )}

            {!approval && (
              <form className="security-form" onSubmit={(event) => void loadApproval(event)}>
                <label className="field-label" htmlFor="recovery-approval-lookup">
                  Load an existing authorization by id
                </label>
                <div className="security-form-row">
                  <input
                    id="recovery-approval-lookup"
                    className="security-input mono"
                    value={approvalLookup}
                    onChange={(event) => setApprovalLookup(event.target.value)}
                    placeholder="ra_…"
                  />
                  <button
                    type="submit"
                    className="button button-quiet button-small"
                    disabled={recoveryBusy !== undefined || !approvalLookup.trim()}
                  >
                    {recoveryBusy === "load" ? "Loading…" : "Load authorization"}
                  </button>
                </div>
              </form>
            )}

            {approval ? (
              <div className="security-approval">
                <div className="security-approval-head">
                  <span className="mono">{approval.authorization_id}</span>
                  <span className={`role-chip role-${approval.state}`}>{approval.state}</span>
                </div>
                <p
                  className={approvalDispatchable(approval) ? "security-hint" : "security-warning"}
                  role={approvalIsExpired(approval) ? "alert" : undefined}
                >
                  {approvalStateNote(approval)}
                </p>
                <dl className="security-facts">
                  <div>
                    <dt className="field-label">Destination</dt>
                    <dd className="mono">
                      {approval.destination.provider} · {approval.destination.endpoint_id} ·{" "}
                      {approval.destination.model_id}
                      {approval.destination.internal ? " · internal (still scanned)" : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="field-label">Context revision</dt>
                    <dd className="mono">{approval.context_revision}</dd>
                  </div>
                  <div>
                    <dt className="field-label">Policy / rules / scan</dt>
                    <dd className="mono">
                      {approval.policy_revision} · {approval.rules_revision} ·{" "}
                      {approval.scan_policy_revision}
                    </dd>
                  </div>
                  <div>
                    <dt className="field-label">Approved by</dt>
                    <dd>
                      {approval.approved_by} at {formatSecurityTime(approval.approved_at)}
                    </dd>
                  </div>
                  <div>
                    <dt className="field-label">Expires</dt>
                    <dd>{formatSecurityTime(approval.expires_at)}</dd>
                  </div>
                  {approval.consumed_at && (
                    <div>
                      <dt className="field-label">Consumed</dt>
                      <dd>
                        {approval.consumed_by ?? "unknown principal"} at{" "}
                        {formatSecurityTime(approval.consumed_at)}
                      </dd>
                    </div>
                  )}
                </dl>

                <label className="security-check">
                  <input
                    type="checkbox"
                    checked={dispatchAcknowledged}
                    onChange={(event) => setDispatchAcknowledged(event.target.checked)}
                  />
                  <span>
                    I understand the service rebuilds and rechecks the complete request under
                    current rules; nothing is added after scanning, and a failed check sends no
                    bytes.
                  </span>
                </label>
                <div className="security-form-row">
                  <input
                    className="security-input mono"
                    aria-label="Dispatch worker id"
                    placeholder="worker id"
                    value={dispatchWorker}
                    onChange={(event) => setDispatchWorker(event.target.value)}
                  />
                  <button
                    type="button"
                    className="button button-primary button-small"
                    disabled={
                      recoveryBusy !== undefined ||
                      !approvalDispatchable(approval) ||
                      !dispatchWorker.trim() ||
                      !dispatchAcknowledged
                    }
                    onClick={() => void dispatchRecovery()}
                  >
                    {recoveryBusy === "dispatch"
                      ? "Rechecking…"
                      : "Recheck complete request & dispatch once"}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={recoveryBusy !== undefined || approval.state !== "approved"}
                    onClick={() => void revokeApproval()}
                  >
                    {recoveryBusy === "revoke" ? "Withdrawing…" : "Withdraw approval"}
                  </button>
                </div>

                {dispatchResult && (
                  <div className="security-dispatch-result" role="status">
                    <strong>Dispatch outcome: {dispatchResult.outcome}</strong>
                    <span className="mono">
                      invocation {dispatchResult.invocation_id} · trace {dispatchResult.trace_id}
                    </span>
                    <span className="mono">request {dispatchResult.request_digest}</span>
                    {dispatchResult.outcome === "unknown" && (
                      <p className="security-warning">
                        The provider outcome is unknown. This authorization is consumed and the
                        request is never automatically replayed; reconcile it explicitly.
                      </p>
                    )}
                    {dispatchResult.detail && (
                      <p className="security-hint">{redactText(dispatchResult.detail)}</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <form className="security-form" onSubmit={(event) => void approveRecovery(event)}>
                <span className="field-label">
                  Record a recovery approval (independent reviewer)
                </span>
                <div className="security-form-row">
                  <input
                    className="security-input mono"
                    aria-label="Destination endpoint id"
                    placeholder="endpoint id"
                    value={recoveryDestination.endpoint_id}
                    onChange={(event) =>
                      setRecoveryDestination((current) => ({
                        ...current,
                        endpoint_id: event.target.value,
                      }))
                    }
                  />
                  <input
                    className="security-input mono"
                    aria-label="Destination model id"
                    placeholder="model id"
                    value={recoveryDestination.model_id}
                    onChange={(event) =>
                      setRecoveryDestination((current) => ({
                        ...current,
                        model_id: event.target.value,
                      }))
                    }
                  />
                  <div className="field-block">
                    <label className="field-label" htmlFor="recovery-ttl">
                      Authorization expiry
                    </label>
                    <Select
                      id="recovery-ttl"
                      value={recoveryDestination.ttl_seconds}
                      onChange={(value) =>
                        setRecoveryDestination((current) => ({ ...current, ttl_seconds: value }))
                      }
                      options={TTL_OPTIONS}
                    />
                  </div>
                  <button
                    type="submit"
                    className="button button-secondary button-small"
                    disabled={
                      recoveryBusy !== undefined || state !== "awaiting_review" || !canReview
                    }
                    title={
                      state !== "awaiting_review"
                        ? "Recovery approval requires a case awaiting independent review."
                        : canReview
                          ? undefined
                          : reviewBlockedCopy
                    }
                  >
                    {recoveryBusy === "approve" ? "Recording…" : "Record approval"}
                  </button>
                </div>
                {state !== "awaiting_review" && (
                  <p className="security-hint">
                    The case is not awaiting review, so no recovery approval is available.
                  </p>
                )}
                {state === "awaiting_review" && !canReview && (
                  <p className="security-warning">{reviewBlockedCopy}</p>
                )}
              </form>
            )}
          </section>
        </div>

        <aside className="detail-side-column">
          <section className="card security-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Scope</span>
                <h3>Bound identifiers</h3>
              </div>
            </div>
            <dl className="security-facts">
              <div>
                <dt className="field-label">Enterprise</dt>
                <dd className="mono">{securityCase.scope.enterprise_id}</dd>
              </div>
              <div>
                <dt className="field-label">Workspace</dt>
                <dd className="mono">{securityCase.scope.workspace_id}</dd>
              </div>
              <div>
                <dt className="field-label">Issue</dt>
                <dd className="mono">{securityCase.scope.issue_id}</dd>
              </div>
              <div>
                <dt className="field-label">Run</dt>
                <dd className="mono">{securityCase.scope.run_id}</dd>
              </div>
              <div>
                <dt className="field-label">Created</dt>
                <dd>{formatSecurityTime(securityCase.created_at)}</dd>
              </div>
              <div>
                <dt className="field-label">Case</dt>
                <dd className="mono">{shortId(securityCase.case_id, 24)}</dd>
              </div>
            </dl>
          </section>

          <section className="card security-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Authority</span>
                <h3>Separation of duties</h3>
              </div>
            </div>
            <ul className="security-duty-list">
              <li>
                <strong>Handler</strong> inspects authorized minimum context and proposes removal or
                rule correction. Cannot approve their own work.
              </li>
              <li>
                <strong>Independent reviewer</strong> decides over evidence, scope, and expiry. Must
                be a different human principal.
              </li>
              <li>
                <strong>Enterprise security administrator</strong> grants scoped roles and activates
                reviewed rule revisions. Administration never waives review.
              </li>
            </ul>
            <p className="security-hint">
              Role combinations never permit self-review. If no independent reviewer is available,
              the case stays blocked and escalates.
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
