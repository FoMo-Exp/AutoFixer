import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  ForgePilotClient,
  SecurityRuleProposal,
  SecurityRuleRevision,
  SecurityRuleStatus,
} from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import {
  formatSecurityTime,
  ruleDiff,
  previousRevision,
  describeSecurityError,
} from "./security-format";
import type { SecurityErrorDescription } from "./security-format";
import { Select } from "../ui/Select";
import { SecurityEmptyState, SecurityErrorNotice } from "./SecurityNotice";
import {
  SECURITY_RULE_KIND_LABELS,
  SECURITY_RULE_STATUS_LABELS,
  SECURITY_RULE_STATUS_OPTIONS,
  SECURITY_RULE_STATUS_TONES,
} from "./security-format";

const RULE_LIST_LIMIT_COPY = "Revisions are newest-first; older pages are fetched only on request.";

interface SecurityRulesPanelProps {
  client: ForgePilotClient;
  workspaceId: string;
  userId: string | undefined;
  canAdminister: boolean;
}

interface RuleSelection {
  lineage: string;
  version: number;
}

const EMPTY_PROPOSAL = {
  detector_id: "",
  min_length: "",
  min_shannon_entropy: "",
  required_prefix: "",
  required_suffix: "",
  reason: "",
  expires_at: "",
  review_at: "",
};

/**
 * Versioned rule corrections: proposal, independent review, activation, and
 * rollback. The service computes regression evidence and rejects exemptions;
 * this panel renders exactly those facts and never offers a way to bypass a
 * detector or target one blocked request.
 */
export function SecurityRulesPanel({
  client,
  workspaceId,
  userId,
  canAdminister,
}: SecurityRulesPanelProps): ReactElement {
  const [status, setStatus] = useState<SecurityRuleStatus | "all">("all");
  const [detectorId, setDetectorId] = useState("");
  const [detectorDraft, setDetectorDraft] = useState("");
  const [items, setItems] = useState<SecurityRuleRevision[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<SecurityErrorDescription>();
  const [reloadToken, setReloadToken] = useState(0);
  const requestRef = useRef(0);

  const [selection, setSelection] = useState<RuleSelection>();
  const [actionError, setActionError] = useState<SecurityErrorDescription>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [showProposal, setShowProposal] = useState(false);
  const [proposal, setProposal] = useState(EMPTY_PROPOSAL);
  const [reviewDecision, setReviewDecision] = useState<"approve" | "reject">("approve");
  const [reviewReason, setReviewReason] = useState("");
  const [activationNote, setActivationNote] = useState("");
  const [rollbackNote, setRollbackNote] = useState("");
  const mutationKeys = useRef(new CreateIdempotencyKeys());

  const loadPage = useCallback(
    async (cursor?: string): Promise<void> => {
      const requestId = ++requestRef.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      try {
        const page = await client.listSecurityRuleRevisions(workspaceId, {
          ...(status === "all" ? {} : { status }),
          ...(detectorId ? { detector_id: detectorId } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (requestId !== requestRef.current) return;
        setItems((current) => {
          if (!cursor) return page.items;
          const known = new Set(current.map((entry) => `${entry.lineage}#${entry.version}`));
          return [
            ...current,
            ...page.items.filter((entry) => !known.has(`${entry.lineage}#${entry.version}`)),
          ];
        });
        setNextCursor(page.next_cursor);
        setListError(undefined);
      } catch (caught) {
        if (requestId === requestRef.current) setListError(describeSecurityError(caught));
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [client, workspaceId, status, detectorId],
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage, reloadToken]);

  const selected = selection
    ? items.find(
        (entry) => entry.lineage === selection.lineage && entry.version === selection.version,
      )
    : undefined;

  function upsert(next: SecurityRuleRevision): void {
    setItems((current) => {
      const index = current.findIndex(
        (entry) => entry.lineage === next.lineage && entry.version === next.version,
      );
      if (index < 0) return [next, ...current];
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
    setSelection({ lineage: next.lineage, version: next.version });
  }

  async function submitProposal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const expires = proposal.expires_at ? new Date(proposal.expires_at) : undefined;
    const reviewAt = proposal.review_at ? new Date(proposal.review_at) : undefined;
    const minLength = proposal.min_length.trim() === "" ? undefined : Number(proposal.min_length);
    const entropy =
      proposal.min_shannon_entropy.trim() === "" ? undefined : Number(proposal.min_shannon_entropy);
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(proposal.detector_id.trim()) ||
      !proposal.reason.trim() ||
      !expires ||
      Number.isNaN(expires.getTime()) ||
      (reviewAt !== undefined && Number.isNaN(reviewAt.getTime())) ||
      (minLength !== undefined && (!Number.isInteger(minLength) || minLength < 1)) ||
      (entropy !== undefined && (!Number.isFinite(entropy) || entropy < 0))
    ) {
      setActionError({
        code: "RULE_DRAFT_INVALID",
        message:
          "A detector id, a reason, and a valid expiry are required; numeric constraints must be within their contract ranges.",
        status: 0,
        retryable: false,
        nextAction: null,
      });
      return;
    }
    const constraints: SecurityRuleProposal["constraints"] = {
      ...(minLength !== undefined ? { min_length: minLength } : {}),
      ...(entropy !== undefined ? { min_shannon_entropy: entropy } : {}),
      ...(proposal.required_prefix.trim()
        ? { required_prefix: proposal.required_prefix.trim() }
        : {}),
      ...(proposal.required_suffix.trim()
        ? { required_suffix: proposal.required_suffix.trim() }
        : {}),
    };
    const body: SecurityRuleProposal = {
      detector_id: proposal.detector_id.trim(),
      constraints,
      reason: proposal.reason.trim(),
      expires_at: expires.toISOString(),
      ...(reviewAt ? { review_at: reviewAt.toISOString() } : {}),
    };
    const key = mutationKeys.current.forInput(body);
    setBusy("propose");
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const created = await client.proposeSecurityRuleCorrection(workspaceId, body, key);
      mutationKeys.current.complete(body);
      upsert(created);
      setProposal(EMPTY_PROPOSAL);
      setShowProposal(false);
      setActionNotice(
        "Proposal recorded. The service computed regression evidence; an independent reviewer must approve it before activation.",
      );
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setActionError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function submitReview(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected || !reviewReason.trim()) return;
    const body = { decision: reviewDecision, reason: reviewReason.trim() };
    const key = mutationKeys.current.forInput({
      review: selected.lineage,
      version: selected.version,
      body,
    });
    setBusy("review");
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const next = await client.reviewSecurityRuleCorrection(
        workspaceId,
        selected.lineage,
        selected.version,
        body,
        key,
      );
      mutationKeys.current.complete({
        review: selected.lineage,
        version: selected.version,
        body,
      });
      upsert(next);
      setReviewReason("");
      setActionNotice(
        "Review recorded. Activation still needs the enterprise security administrator.",
      );
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setActionError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function activate(): Promise<void> {
    if (!selected) return;
    const body = activationNote.trim() ? { note: activationNote.trim() } : {};
    const key = mutationKeys.current.forInput({
      activate: selected.lineage,
      version: selected.version,
      body,
    });
    setBusy("activate");
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const next = await client.activateSecurityRuleCorrection(
        workspaceId,
        selected.lineage,
        selected.version,
        body,
        key,
      );
      mutationKeys.current.complete({
        activate: selected.lineage,
        version: selected.version,
        body,
      });
      upsert(next);
      setActivationNote("");
      setActionNotice(
        "Revision activated. The complete-request checks still apply to every later call; this is a policy change, not a run grant.",
      );
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setActionError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function rollback(): Promise<void> {
    if (!selected) return;
    const body = rollbackNote.trim() ? { note: rollbackNote.trim() } : {};
    const key = mutationKeys.current.forInput({ rollback: selected.lineage, body });
    setBusy("rollback");
    setActionError(undefined);
    setActionNotice(undefined);
    try {
      const next = await client.rollbackSecurityRuleCorrection(
        workspaceId,
        selected.lineage,
        body,
        key,
      );
      mutationKeys.current.complete({ rollback: selected.lineage, body });
      upsert(next);
      setRollbackNote("");
      setActionNotice(
        "Rollback recorded as a new version. A superseded approval is never restored.",
      );
      setReloadToken((value) => value + 1);
    } catch (caught) {
      setActionError(describeSecurityError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  const lineageRevisions = selected
    ? items
        .filter((entry) => entry.lineage === selected.lineage)
        .sort((left, right) => right.version - left.version)
    : [];
  const previous = selected ? previousRevision(items, selected) : undefined;
  const diffRows = selected ? ruleDiff(previous, selected) : [];
  const authorIsSelf = Boolean(selected && userId && selected.author_id === userId);
  const reviewable = selected?.status === "proposed" && !selected.review && !authorIsSelf;
  const lineageHasActive = lineageRevisions.some(
    (entry) => entry.status === "activated" || entry.status === "applied",
  );

  return (
    <div className="workspace security-workspace" data-view={selected ? "detail" : "list"}>
      <aside className="sidebar security-sidebar">
        <div className="sidebar-heading">
          <div>
            <span className="eyebrow">Policy corrections</span>
            <h1>Rules</h1>
          </div>
          <div className="memory-heading-actions">
            <span className="task-count">{items.length}</span>
            <button
              type="button"
              className="button button-quiet button-small"
              aria-label="Refresh rule revisions"
              disabled={loading}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              ↻
            </button>
          </div>
        </div>

        <div className="memory-filters" role="group" aria-label="Rule filters">
          <div className="memory-filter">
            <label className="field-label" htmlFor="rule-detector-filter">
              Detector
            </label>
            <form
              className="security-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                setDetectorId(detectorDraft.trim());
                setSelection(undefined);
              }}
            >
              <input
                id="rule-detector-filter"
                className="security-input mono"
                value={detectorDraft}
                placeholder="openai_key"
                onChange={(event) => setDetectorDraft(event.target.value)}
              />
              <button type="submit" className="button button-quiet button-small">
                Apply
              </button>
            </form>
          </div>
          <div className="memory-filter">
            <label className="field-label" htmlFor="rule-status-filter">
              Status
            </label>
            <Select
              id="rule-status-filter"
              value={status}
              onChange={(value) => {
                setStatus(value as SecurityRuleStatus | "all");
                setSelection(undefined);
              }}
              options={[{ value: "all", label: "All statuses" }, ...SECURITY_RULE_STATUS_OPTIONS]}
            />
          </div>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => setShowProposal((current) => !current)}
          >
            {showProposal ? "Close proposal form" : "Propose correction"}
          </button>
        </div>

        <p className="security-list-note">{RULE_LIST_LIMIT_COPY}</p>

        <div className="task-list" data-scroll="normal">
          {loading ? (
            <SecurityEmptyState>Reading versioned rule corrections…</SecurityEmptyState>
          ) : listError ? (
            <SecurityEmptyState
              icon="!"
              action={
                listError.retryable ? (
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => setReloadToken((value) => value + 1)}
                  >
                    Retry
                  </button>
                ) : undefined
              }
            >
              {listError.code}: {listError.message}
            </SecurityEmptyState>
          ) : items.length === 0 ? (
            <SecurityEmptyState>
              No rule correction matches these filters in this workspace.
            </SecurityEmptyState>
          ) : (
            <>
              {items.map((entry) => (
                <article
                  className={`task-list-item security-rule-item ${
                    selected?.lineage === entry.lineage && selected.version === entry.version
                      ? "task-list-item-selected"
                      : ""
                  }`}
                  key={`${entry.lineage}#${entry.version}`}
                >
                  <button
                    type="button"
                    className="task-list-open"
                    onClick={() => setSelection({ lineage: entry.lineage, version: entry.version })}
                  >
                    <div className="task-list-item-topline">
                      <span
                        className={`stage-pip stage-tone-${SECURITY_RULE_STATUS_TONES[entry.status]}`}
                      />
                      <span className="task-list-status task-list-status-label">
                        {SECURITY_RULE_STATUS_LABELS[entry.status]}
                      </span>
                      <span className="task-list-time">
                        v{entry.version} · {formatSecurityTime(entry.proposed_at)}
                      </span>
                    </div>
                    <div className="task-list-summary mono">{entry.detector_id}</div>
                    <div className="task-list-repo">
                      <span>{SECURITY_RULE_KIND_LABELS[entry.kind]}</span>
                      <span className="divider">·</span>
                      <span>{entry.scope.workspace_id}</span>
                      <span className="divider">·</span>
                      <span>{entry.regression_evidence.length} evidence</span>
                    </div>
                  </button>
                </article>
              ))}
              {nextCursor && (
                <button
                  type="button"
                  className="button button-quiet button-small load-more"
                  disabled={loadingMore}
                  onClick={() => void loadPage(nextCursor)}
                >
                  {loadingMore ? "Loading…" : "Load older revisions"}
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <main className="main-panel">
        {actionError && (
          <SecurityErrorNotice error={actionError} onDismiss={() => setActionError(undefined)} />
        )}
        {actionNotice && (
          <p className="security-notice" role="status">
            {actionNotice}
          </p>
        )}

        {showProposal && (
          <section className="card security-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Bounded correction only</span>
                <h3>Propose a rule correction</h3>
              </div>
            </div>
            <p className="security-hint">
              A correction may only narrow matching (more entropy, more length, a fixed marker). It
              cannot disable a detector, widen matches, or target an invocation, case, digest, or
              secret value. The service computes the regression evidence; a proposal cannot submit
              its own.
            </p>
            <form className="security-form" onSubmit={(event) => void submitProposal(event)}>
              <div className="security-form-row">
                <input
                  className="security-input mono"
                  aria-label="Detector id"
                  placeholder="detector id"
                  value={proposal.detector_id}
                  onChange={(event) =>
                    setProposal((current) => ({ ...current, detector_id: event.target.value }))
                  }
                />
                <input
                  className="security-input"
                  aria-label="Minimum length"
                  type="number"
                  min={1}
                  placeholder="min length"
                  value={proposal.min_length}
                  onChange={(event) =>
                    setProposal((current) => ({ ...current, min_length: event.target.value }))
                  }
                />
                <input
                  className="security-input"
                  aria-label="Minimum Shannon entropy"
                  type="number"
                  min={0}
                  step="0.1"
                  placeholder="min entropy"
                  value={proposal.min_shannon_entropy}
                  onChange={(event) =>
                    setProposal((current) => ({
                      ...current,
                      min_shannon_entropy: event.target.value,
                    }))
                  }
                />
                <input
                  className="security-input mono"
                  aria-label="Required prefix"
                  placeholder="required prefix"
                  maxLength={24}
                  value={proposal.required_prefix}
                  onChange={(event) =>
                    setProposal((current) => ({ ...current, required_prefix: event.target.value }))
                  }
                />
                <input
                  className="security-input mono"
                  aria-label="Required suffix"
                  placeholder="required suffix"
                  maxLength={24}
                  value={proposal.required_suffix}
                  onChange={(event) =>
                    setProposal((current) => ({ ...current, required_suffix: event.target.value }))
                  }
                />
              </div>
              <label className="field-label" htmlFor="rule-proposal-reason">
                Reason (required, non-secret)
              </label>
              <textarea
                id="rule-proposal-reason"
                className="security-textarea"
                rows={3}
                maxLength={2000}
                value={proposal.reason}
                onChange={(event) =>
                  setProposal((current) => ({ ...current, reason: event.target.value }))
                }
              />
              <div className="security-form-row">
                <label className="field-block">
                  <span className="field-label">Expires at</span>
                  <input
                    className="security-input"
                    type="datetime-local"
                    value={proposal.expires_at}
                    onChange={(event) =>
                      setProposal((current) => ({ ...current, expires_at: event.target.value }))
                    }
                  />
                </label>
                <label className="field-block">
                  <span className="field-label">Review by (optional)</span>
                  <input
                    className="security-input"
                    type="datetime-local"
                    value={proposal.review_at}
                    onChange={(event) =>
                      setProposal((current) => ({ ...current, review_at: event.target.value }))
                    }
                  />
                </label>
                <button
                  type="submit"
                  className="button button-secondary button-small"
                  disabled={busy !== undefined}
                >
                  {busy === "propose" ? "Proposing…" : "Submit proposal"}
                </button>
              </div>
            </form>
          </section>
        )}

        {!selected ? (
          <section className="welcome-panel security-welcome">
            <span className="eyebrow">Versioned policy</span>
            <h2>Correct false positives without creating an exemption.</h2>
            <p>
              Every correction carries a bounded applicability, an expiry or review date, and
              regression evidence computed by the service. Activation needs a different human
              reviewer&apos;s approval, and rollback is itself a new version.
            </p>
            <div className="welcome-principles">
              <span>Narrowing only</span>
              <span>Evidence re-verified at activation</span>
              <span>No per-call exception</span>
            </div>
          </section>
        ) : (
          <section className="detail-view security-detail" aria-labelledby="rule-detail-heading">
            <header className="detail-header">
              <div className="detail-heading">
                <span className="eyebrow">
                  {SECURITY_RULE_KIND_LABELS[selected.kind]} · version {selected.version}
                </span>
                <h2 id="rule-detail-heading" className="mono">
                  {selected.detector_id}
                </h2>
                <div className="detail-subline">
                  <span
                    className={`stage-pip stage-tone-${SECURITY_RULE_STATUS_TONES[selected.status]}`}
                  />
                  <span>{SECURITY_RULE_STATUS_LABELS[selected.status]}</span>
                  <span className="divider">/</span>
                  <span className="mono">{selected.lineage}</span>
                </div>
              </div>
              <div className="detail-actions">
                <span className="role-chip">{selected.kind}</span>
                <span className="role-chip">{selected.scope.workspace_id}</span>
              </div>
            </header>

            <section className="card security-card">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">What changes</span>
                  <h3>Correction diff</h3>
                </div>
              </div>
              {!previous && (
                <p className="security-hint">
                  The earlier revision of this lineage is not in the loaded set. Clear or widen the
                  filters to compare it; unchanged rows are shown against an empty baseline.
                </p>
              )}
              <table className="security-diff-table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Previous</th>
                    <th scope="col">This revision</th>
                  </tr>
                </thead>
                <tbody>
                  {diffRows.map((row) => (
                    <tr
                      key={row.label}
                      className={row.changed ? "security-diff-changed" : undefined}
                    >
                      <th scope="row">{row.label}</th>
                      <td className="mono">{row.before}</td>
                      <td className="mono">{row.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="security-hint">{selected.reason}</p>
            </section>

            <div className="detail-grid">
              <div className="detail-main-column">
                <section className="card security-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">Computed by the service</span>
                      <h3>Regression evidence</h3>
                    </div>
                    <span className="task-count">{selected.regression_evidence.length}</span>
                  </div>
                  {selected.regression_evidence.length === 0 ? (
                    <p className="card-empty compact">
                      No regression evidence is attached. Activation cannot proceed without it.
                    </p>
                  ) : (
                    <ul className="security-evidence-list">
                      {selected.regression_evidence.map((evidence) => (
                        <li key={`${evidence.test_ref}:${evidence.detector_id}`}>
                          <span
                            className={`role-chip ${evidence.result === "pass" ? "role-admin" : "role-viewer"}`}
                          >
                            {evidence.result}
                          </span>
                          <div>
                            <span className="mono">{evidence.test_ref}</span>
                            <p>{evidence.description}</p>
                            <span className="identity-meta">
                              {evidence.detector_id} · {formatSecurityTime(evidence.at)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {selected.regression_binding && (
                    <dl className="security-facts">
                      <div>
                        <dt className="field-label">Rule digest</dt>
                        <dd className="mono">{selected.regression_binding.rule_digest}</dd>
                      </div>
                      <div>
                        <dt className="field-label">Corpus digest</dt>
                        <dd className="mono">{selected.regression_binding.corpus_digest}</dd>
                      </div>
                    </dl>
                  )}
                  <p className="security-hint">
                    Evidence is computed from the trusted corpus and re-verified at activation. A
                    proposal cannot supply its own evidence.
                  </p>
                </section>

                {selected.status === "proposed" && (
                  <section className="card security-card" aria-labelledby="rule-review-heading">
                    <div className="card-heading">
                      <div>
                        <span className="eyebrow">Different human principal</span>
                        <h3 id="rule-review-heading">Independent review</h3>
                      </div>
                    </div>
                    {authorIsSelf ? (
                      <p className="security-warning" role="note">
                        You authored this correction. Self-review is never available; another
                        independent reviewer must decide.
                      </p>
                    ) : selected.review ? (
                      <p className="security-hint">
                        Reviewed {selected.review.reviewer_id} ·{" "}
                        {selected.review.approved ? "approved" : "rejected"} ·{" "}
                        {formatSecurityTime(selected.review.at)}
                      </p>
                    ) : (
                      <form
                        className="security-form"
                        onSubmit={(event) => void submitReview(event)}
                      >
                        <div className="security-form-row">
                          <div className="field-block">
                            <label className="field-label" htmlFor="rule-review-decision">
                              Decision
                            </label>
                            <Select
                              id="rule-review-decision"
                              value={reviewDecision}
                              onChange={(value) => setReviewDecision(value as "approve" | "reject")}
                              options={[
                                { value: "approve", label: "Approve" },
                                { value: "reject", label: "Reject" },
                              ]}
                            />
                          </div>
                          <input
                            className="security-input"
                            aria-label="Review reason"
                            placeholder="reason (required)"
                            value={reviewReason}
                            onChange={(event) => setReviewReason(event.target.value)}
                          />
                          <button
                            type="submit"
                            className="button button-secondary button-small"
                            disabled={busy !== undefined || !reviewReason.trim() || !reviewable}
                          >
                            {busy === "review" ? "Recording…" : "Record review"}
                          </button>
                        </div>
                      </form>
                    )}
                  </section>
                )}

                <section className="card security-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">Administrator</span>
                      <h3>Activation &amp; rollback</h3>
                    </div>
                  </div>
                  {!canAdminister ? (
                    <p className="security-hint">
                      Activation and rollback require the enterprise security administrator duty.
                      They never waive independent review.
                    </p>
                  ) : (
                    <>
                      <div className="security-form-row">
                        <input
                          className="security-input"
                          aria-label="Activation note"
                          placeholder="activation note (optional)"
                          value={activationNote}
                          onChange={(event) => setActivationNote(event.target.value)}
                        />
                        <button
                          type="button"
                          className="button button-primary button-small"
                          disabled={busy !== undefined || selected.status !== "approved"}
                          onClick={() => void activate()}
                        >
                          {busy === "activate" ? "Activating…" : "Activate revision"}
                        </button>
                      </div>
                      <p className="security-hint">
                        Activation is available only after an independent approval and re-verifies
                        the computed evidence. It changes policy, not a blocked run.
                      </p>
                      <div className="security-form-row">
                        <input
                          className="security-input"
                          aria-label="Rollback note"
                          placeholder="rollback note (optional)"
                          value={rollbackNote}
                          onChange={(event) => setRollbackNote(event.target.value)}
                        />
                        <button
                          type="button"
                          className="button button-quiet button-small"
                          disabled={busy !== undefined || !lineageHasActive}
                          onClick={() => void rollback()}
                        >
                          {busy === "rollback" ? "Rolling back…" : "Roll back active correction"}
                        </button>
                      </div>
                      <p className="security-hint">
                        Rollback creates a new version. It cannot restore a superseded approval.
                      </p>
                    </>
                  )}
                </section>
              </div>

              <aside className="detail-side-column">
                <section className="card security-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">Lifecycle</span>
                      <h3>Dates &amp; decisions</h3>
                    </div>
                  </div>
                  <dl className="security-facts">
                    <div>
                      <dt className="field-label">Author</dt>
                      <dd className="mono">{selected.author_id}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Proposed</dt>
                      <dd>{formatSecurityTime(selected.proposed_at)}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Expires</dt>
                      <dd>{formatSecurityTime(selected.expires_at)}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Review by</dt>
                      <dd>{formatSecurityTime(selected.review_at ?? null)}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Activated</dt>
                      <dd>
                        {selected.activated_at
                          ? `${selected.activated_by ?? "unknown"} · ${formatSecurityTime(selected.activated_at)}`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="field-label">Superseded</dt>
                      <dd>{formatSecurityTime(selected.superseded_at ?? null)}</dd>
                    </div>
                    <div>
                      <dt className="field-label">Rolled back</dt>
                      <dd>
                        {selected.rolled_back_at
                          ? `${selected.rolled_back_by ?? "unknown"} · ${formatSecurityTime(selected.rolled_back_at)}`
                          : "—"}
                      </dd>
                    </div>
                    {selected.rolls_back_version !== null && (
                      <div>
                        <dt className="field-label">Rolls back version</dt>
                        <dd>v{selected.rolls_back_version}</dd>
                      </div>
                    )}
                    {selected.rejected_code && (
                      <div>
                        <dt className="field-label">Rejection code</dt>
                        <dd className="mono">{selected.rejected_code}</dd>
                      </div>
                    )}
                  </dl>
                  {selected.review && (
                    <div className="security-review-record">
                      <span className="field-label">Review decision</span>
                      <p>
                        {selected.review.approved ? "Approved" : "Rejected"} by{" "}
                        {selected.review.reviewer_id} · {formatSecurityTime(selected.review.at)}
                      </p>
                      <p className="security-hint">{selected.review.reason}</p>
                    </div>
                  )}
                </section>

                <section className="card security-card">
                  <div className="card-heading">
                    <div>
                      <span className="eyebrow">Same lineage</span>
                      <h3>Version history</h3>
                    </div>
                  </div>
                  <ol className="security-version-history">
                    {lineageRevisions.map((entry) => (
                      <li key={entry.version}>
                        <span className="mono">v{entry.version}</span>
                        <span
                          className={`stage-pip stage-tone-${SECURITY_RULE_STATUS_TONES[entry.status]}`}
                        />
                        <span>{SECURITY_RULE_STATUS_LABELS[entry.status]}</span>
                        <span className="identity-meta">
                          {formatSecurityTime(entry.proposed_at)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              </aside>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
