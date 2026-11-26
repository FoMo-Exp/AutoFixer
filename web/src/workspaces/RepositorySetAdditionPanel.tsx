import { useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  IdentityClient,
  RepositorySetAdditionCommitResult,
  RepositorySetAdditionConfirmation,
  RepositorySetAdditionPreview,
  RepositorySetAdditionRepository,
  Workspace,
} from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import { ROLE_LABELS, describeError, formatTimestamp } from "./identity-format";
import {
  BLOCKED_REASON_LABELS,
  CURRENT_SET_REASON_LABELS,
  GATE_LABELS,
  OWNER_REASON_LABELS,
  admissionView,
  capabilityLabel,
  capabilityList,
  evidenceList,
  newRepositoryDraft,
  requiresFreshPreview,
  validateRepositoryDrafts,
} from "./repository-set";
import type { RepositoryDraft } from "./repository-set";

interface RepositorySetAdditionPanelProps {
  client: IdentityClient;
  workspace: Workspace;
  /** The projection's `manage_members` decision: repository management plus admin. */
  canManage: boolean;
}

type BusyAction = "preview" | "confirm" | "commit";

const IMPACT_ID = "repository-set-impact";
const IMPACT_HEADING_ID = "repository-set-impact-heading";
const CONFIRMATION_ID = "repository-set-confirmation";
const CONFIRMATION_HEADING_ID = "repository-set-confirmation-heading";
const COMMIT_ID = "repository-set-commit";
const COMMIT_HEADING_ID = "repository-set-commit-heading";

interface RepositoryFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}

function RepositoryField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  disabled = false,
}: RepositoryFieldProps): ReactElement {
  const describedBy =
    error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className="repository-set-field">
      <label htmlFor={id}>
        <span className="label-text">{label}</span>
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
        />
      </label>
      {hint !== undefined && (
        <span className="identity-meta" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span className="identity-field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Preview, confirmation and commit for adding repositories (DAT-287).
 *
 * The panel never decides admission, a capability or an effective owner: it
 * renders the server's preview, requires an explicit acknowledgement of every
 * `reductions_required` entry and then confirms exactly that response. Editing
 * the proposal or receiving a conflict drops the preview and the confirmation,
 * so a change can never be committed against facts the operator did not see.
 */
export function RepositorySetAdditionPanel({
  client,
  workspace,
  canManage,
}: RepositorySetAdditionPanelProps): ReactElement {
  const nextRowId = useRef(2);
  const requestSeq = useRef(0);
  const [rows, setRows] = useState<RepositoryDraft[]>(() => [
    newRepositoryDraft("repo-1", workspace.repository.provider_instance_id),
  ]);
  const [preview, setPreview] = useState<RepositorySetAdditionPreview>();
  const [previewedProposal, setPreviewedProposal] = useState<RepositorySetAdditionRepository[]>();
  const [confirmation, setConfirmation] = useState<RepositorySetAdditionConfirmation>();
  const [commitResult, setCommitResult] = useState<RepositorySetAdditionCommitResult>();
  const [acknowledged, setAcknowledged] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState<BusyAction>();
  const [showValidation, setShowValidation] = useState(false);
  const [error, setError] = useState<ErrorDescription>();

  const validation = validateRepositoryDrafts(rows);
  const requiredReductions = preview?.reductions_required ?? [];
  const acknowledgedAll = requiredReductions.every(
    (reduction) => acknowledged[reduction.membership_id] === true,
  );
  const canSubmit = canManage && busy === undefined;
  const canConfirm =
    canManage &&
    preview?.committable === true &&
    acknowledgedAll &&
    confirmation === undefined &&
    busy === undefined;
  const canCommit = canManage && confirmation !== undefined && busy === undefined;

  /** Drop every decision-shaped piece of state and invalidate in-flight calls. */
  function startNewProposal(): void {
    requestSeq.current += 1;
    setBusy(undefined);
    setPreview(undefined);
    setPreviewedProposal(undefined);
    setConfirmation(undefined);
    setCommitResult(undefined);
    setAcknowledged({});
  }

  function updateRow(id: string, patch: Partial<RepositoryDraft>): void {
    setError(undefined);
    startNewProposal();
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow(): void {
    setError(undefined);
    startNewProposal();
    const id = `repo-${nextRowId.current}`;
    nextRowId.current += 1;
    setRows((current) => [
      ...current,
      newRepositoryDraft(id, workspace.repository.provider_instance_id),
    ]);
  }

  function removeRow(id: string): void {
    setError(undefined);
    startNewProposal();
    setRows((current) => current.filter((row) => row.id !== id));
  }

  async function runPreview(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    setShowValidation(true);
    if (!canSubmit || !validation.valid) return;
    const sequence = ++requestSeq.current;
    setBusy("preview");
    setError(undefined);
    setPreview(undefined);
    setPreviewedProposal(undefined);
    setConfirmation(undefined);
    setCommitResult(undefined);
    setAcknowledged({});
    try {
      const result = await client.previewRepositorySetAddition(workspace.id, {
        additional_repositories: validation.proposals,
      });
      if (requestSeq.current !== sequence) return;
      setPreview(result);
      setPreviewedProposal(validation.proposals);
    } catch (caught) {
      if (requestSeq.current === sequence) setError(describeError(caught));
    } finally {
      if (requestSeq.current === sequence) setBusy(undefined);
    }
  }

  async function runConfirm(): Promise<void> {
    if (!canConfirm || preview === undefined || previewedProposal === undefined) return;
    const sequence = ++requestSeq.current;
    setBusy("confirm");
    setError(undefined);
    try {
      const result = await client.confirmRepositorySetAddition(workspace.id, {
        expected_set_version: preview.set_version,
        additional_repositories: previewedProposal,
        confirmed_reductions: preview.reductions_required,
      });
      if (requestSeq.current !== sequence) return;
      setConfirmation(result);
    } catch (caught) {
      if (requestSeq.current !== sequence) return;
      const described = describeError(caught);
      setError(described);
      // The preview and its acknowledgement are bound to facts the server no
      // longer accepts; a new preview is required before another confirmation.
      if (requiresFreshPreview(described.code)) startNewProposal();
    } finally {
      if (requestSeq.current === sequence) setBusy(undefined);
    }
  }

  async function runCommit(): Promise<void> {
    if (!canCommit || confirmation === undefined) return;
    const sequence = ++requestSeq.current;
    setBusy("commit");
    setError(undefined);
    try {
      const result = await client.commitRepositorySetAddition(
        workspace.id,
        confirmation.confirmation_id,
      );
      if (requestSeq.current !== sequence) return;
      startNewProposal();
      setShowValidation(false);
      setRows([
        newRepositoryDraft(`repo-${nextRowId.current}`, workspace.repository.provider_instance_id),
      ]);
      nextRowId.current += 1;
      setCommitResult(result);
    } catch (caught) {
      if (requestSeq.current !== sequence) return;
      const described = describeError(caught);
      setError(described);
      // A stale, expired or conflicting confirmation never commits and is
      // never reused: force a fresh preview of the current facts.
      if (requiresFreshPreview(described.code)) startNewProposal();
    } finally {
      if (requestSeq.current === sequence) setBusy(undefined);
    }
  }

  return (
    <div className="identity-panel">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {!canManage && (
        <p className="identity-panel-status">
          Your current capabilities do not allow repository-set changes. The service refuses every
          write without verified repository management across the current set.
        </p>
      )}
      <p className="identity-panel-status">
        Adding a repository changes every current member&apos;s capability intersection. Nothing is
        written until you preview the whole impact, confirm exactly that impact, and commit.
      </p>
      <ul className="identity-list" aria-label="Current repository binding">
        <li className="identity-row">
          <div className="identity-row-main">
            <span className="identity-meta">Current repository</span>
            <div className="identity-row-title">
              <strong className="mono">{workspace.repository.repository_id}</strong>
              <span className="identity-badge">{workspace.repository.provider_type}</span>
            </div>
            <span className="identity-meta mono">{workspace.repository.provider_instance_id}</span>
          </div>
        </li>
      </ul>

      <form className="identity-form" onSubmit={(event) => void runPreview(event)}>
        <span className="label-text">Repositories to add</span>
        {rows.map((row, index) => {
          const rowIssues = showValidation ? (validation.issues[row.id] ?? {}) : {};
          return (
            <fieldset className="repository-set-row" key={row.id} disabled={!canManage}>
              <legend>Repository {index + 1}</legend>
              <div className="identity-form-grid">
                <RepositoryField
                  id={`${row.id}-provider`}
                  label="Provider instance"
                  value={row.providerInstanceId}
                  onChange={(value) => updateRow(row.id, { providerInstanceId: value })}
                  hint="Must be an instance this enterprise approved."
                  error={rowIssues.providerInstanceId}
                  disabled={!canManage}
                />
                <RepositoryField
                  id={`${row.id}-installation`}
                  label="Installation reference"
                  value={row.installationRef}
                  onChange={(value) => updateRow(row.id, { installationRef: value })}
                  hint="The approved, active installation that observes this repository."
                  error={rowIssues.installationRef}
                  disabled={!canManage}
                />
                <RepositoryField
                  id={`${row.id}-repository`}
                  label="Repository id"
                  value={row.repositoryId}
                  onChange={(value) => updateRow(row.id, { repositoryId: value })}
                  hint="The provider-assigned immutable id; a URL is not an identity."
                  error={rowIssues.repositoryId}
                  disabled={!canManage}
                />
                <RepositoryField
                  id={`${row.id}-name`}
                  label="Display name (optional)"
                  value={row.repositoryName}
                  onChange={(value) => updateRow(row.id, { repositoryName: value })}
                  disabled={!canManage}
                />
                <RepositoryField
                  id={`${row.id}-url`}
                  label="Repository URL (optional)"
                  value={row.repositoryUrl}
                  onChange={(value) => updateRow(row.id, { repositoryUrl: value })}
                  disabled={!canManage}
                />
              </div>
              {rows.length > 1 && (
                <div className="identity-form-actions">
                  <button
                    type="button"
                    className="button button-small button-quiet identity-destructive"
                    onClick={() => removeRow(row.id)}
                  >
                    Remove repository
                  </button>
                </div>
              )}
            </fieldset>
          );
        })}
        <div className="identity-form-actions">
          <button
            type="button"
            className="button button-small button-quiet"
            disabled={!canManage || busy !== undefined}
            onClick={addRow}
          >
            Add another repository
          </button>
          <button
            type="submit"
            className="button button-small button-primary"
            disabled={!canSubmit}
          >
            {busy === "preview" ? "Previewing…" : "Preview impact"}
          </button>
        </div>
      </form>

      {preview && (
        <section
          className="repository-set-section"
          id={IMPACT_ID}
          aria-labelledby={IMPACT_HEADING_ID}
        >
          <div className="identity-row-title">
            <h4 id={IMPACT_HEADING_ID}>Impact preview</h4>
            <span
              className={
                preview.committable
                  ? "identity-badge identity-badge-active"
                  : "identity-badge identity-badge-warn"
              }
            >
              {preview.committable ? "Committable after confirmation" : "Cannot commit"}
            </span>
            <span
              className={
                preview.multi_repository_gate === "enabled"
                  ? "identity-badge"
                  : "identity-badge identity-badge-warn"
              }
            >
              {GATE_LABELS[preview.multi_repository_gate]}
            </span>
          </div>
          <p className="identity-panel-status" role="status">
            {`Preview only — this authorizes no access. Set version ${preview.set_version}, checked ${formatTimestamp(preview.checked_at)}.`}
          </p>
          {preview.current_set_blocked_reason && (
            <p className="identity-panel-status">
              {`The current repository set is already unusable: ${CURRENT_SET_REASON_LABELS[preview.current_set_blocked_reason]}`}
            </p>
          )}
          <dl className="repository-set-summary">
            <div>
              <dt>Repositories after change</dt>
              <dd>{preview.impact.proposed_repository_count}</dd>
            </div>
            <div>
              <dt>Protected members</dt>
              <dd>{preview.impact.protected_members}</dd>
            </div>
            <div>
              <dt>Members reduced</dt>
              <dd>{preview.impact.reduced_members}</dd>
            </div>
            <div>
              <dt>Capabilities removed</dt>
              <dd>{preview.impact.removed_capabilities}</dd>
            </div>
            <div>
              <dt>Effective owners</dt>
              <dd>{preview.impact.effective_owners}</dd>
            </div>
            <div>
              <dt>Last owner survives</dt>
              <dd>{preview.impact.last_owner_survives ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>All members keep admission</dt>
              <dd>{preview.all_members_retain_admission ? "Yes" : "No"}</dd>
            </div>
          </dl>
          {preview.commit_blocked_reasons.length > 0 && (
            <div className="repository-set-blocked" role="alert">
              <strong>This addition cannot be committed.</strong>
              <ul>
                {preview.commit_blocked_reasons.map((reason) => (
                  <li key={reason}>{BLOCKED_REASON_LABELS[reason]}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h5>Members</h5>
            {preview.members.length === 0 ? (
              <p className="card-empty">No current effective members are reported.</p>
            ) : (
              <ul className="identity-list" aria-label="Member impact">
                {preview.members.map((member) => {
                  const admission = admissionView(member);
                  return (
                    <li className="identity-row repository-set-member" key={member.membership_id}>
                      <div className="identity-row-main">
                        <div className="identity-row-title">
                          <strong className="mono">{member.user_id}</strong>
                          <span className="identity-badge">
                            {`Assigned role: ${ROLE_LABELS[member.role]}`}
                          </span>
                          <span
                            className={
                              admission.tone === "active"
                                ? "identity-badge identity-badge-active"
                                : admission.tone === "danger"
                                  ? "identity-badge identity-badge-warn"
                                  : "identity-badge identity-badge-warn"
                            }
                          >
                            {admission.label}
                          </span>
                        </div>
                        <span className="identity-meta">
                          {`Current capabilities: ${capabilityList(member.current_capabilities)}`}
                        </span>
                        <span className="identity-meta">
                          {member.evidence_complete
                            ? `Proposed capabilities: ${capabilityList(member.proposed_capabilities)}`
                            : "Proposed capabilities: not verified"}
                        </span>
                        {member.reduction.length > 0 && (
                          <span className="identity-meta">
                            {`Removes: ${capabilityList(member.reduction)}`}
                          </span>
                        )}
                        <span className="identity-meta">{`Evidence: ${evidenceList(member)}`}</span>
                        {member.reason && (
                          <span className="identity-meta">
                            {`Verification: ${CURRENT_SET_REASON_LABELS[member.reason]}`}
                          </span>
                        )}
                        <span className="identity-meta">
                          {member.verified_at
                            ? `Oldest verification: ${formatTimestamp(member.verified_at)}`
                            : "Oldest verification: not available"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div>
            <h5>Owners</h5>
            {preview.owners.length === 0 ? (
              <p className="identity-panel-status">No owner assignments are reported.</p>
            ) : (
              <ul className="identity-list" aria-label="Owner impact">
                {preview.owners.map((owner) => (
                  <li className="identity-row" key={owner.user_id}>
                    <div className="identity-row-main">
                      <div className="identity-row-title">
                        <strong className="mono">{owner.user_id}</strong>
                        <span
                          className={
                            owner.effective
                              ? "identity-badge identity-badge-active"
                              : "identity-badge identity-badge-warn"
                          }
                        >
                          {owner.effective ? "Effective owner" : "Not effective"}
                        </span>
                      </div>
                      {owner.reason && (
                        <span className="identity-meta">{OWNER_REASON_LABELS[owner.reason]}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {preview.committable && (
            <fieldset
              className="repository-set-section repository-set-ack"
              disabled={!canManage || confirmation !== undefined}
            >
              <legend>Confirm the impact</legend>
              {requiredReductions.length === 0 ? (
                <p className="identity-panel-status">
                  No member loses a capability or verified access. Confirming records that you
                  accepted this specific impact; it grants nothing.
                </p>
              ) : (
                <>
                  <p className="identity-panel-status">
                    Every marked capability must be acknowledged. The assigned workspace role is
                    preserved; only the effective capability ceiling is reduced.
                  </p>
                  {requiredReductions.map((reduction) => {
                    const member = preview.members.find(
                      (candidate) => candidate.membership_id === reduction.membership_id,
                    );
                    const label = member?.user_id ?? reduction.user_id;
                    const role = member ? ROLE_LABELS[member.role] : "their assigned role";
                    return (
                      <label key={reduction.membership_id}>
                        <input
                          type="checkbox"
                          checked={acknowledged[reduction.membership_id] === true}
                          onChange={(event) =>
                            setAcknowledged((current) => {
                              if (event.target.checked) {
                                return { ...current, [reduction.membership_id]: true };
                              }
                              const next = { ...current };
                              delete next[reduction.membership_id];
                              return next;
                            })
                          }
                        />
                        <span>
                          {`I acknowledge that ${label} keeps the ${role} role but loses `}
                          <strong>
                            {reduction.capabilities
                              .map((capability) => capabilityLabel(capability))
                              .join(", ")}
                          </strong>
                          {" on the proposed set."}
                        </span>
                      </label>
                    );
                  })}
                </>
              )}
              <div className="identity-form-actions">
                <button
                  type="button"
                  className="button button-small button-primary"
                  disabled={!canConfirm}
                  onClick={() => void runConfirm()}
                >
                  {busy === "confirm" ? "Confirming…" : "Confirm impact"}
                </button>
              </div>
            </fieldset>
          )}
        </section>
      )}

      {confirmation && (
        <section
          className="repository-set-section"
          id={CONFIRMATION_ID}
          aria-labelledby={CONFIRMATION_HEADING_ID}
        >
          <div className="identity-row-title">
            <h4 id={CONFIRMATION_HEADING_ID}>Confirmation recorded</h4>
            <span className="identity-badge identity-badge-active">Bound to this impact</span>
          </div>
          <p className="identity-panel-status" role="status">
            {`Expires ${formatTimestamp(confirmation.expires_at)}. The commit revalidates membership, roles, provider evidence and the set version; the confirmation authorizes no access.`}
          </p>
          <p className="identity-meta mono">{confirmation.confirmation_id}</p>
          <div className="identity-form-actions">
            <button
              type="button"
              className="button button-small button-primary"
              disabled={!canCommit}
              onClick={() => void runCommit()}
            >
              {busy === "commit" ? "Committing…" : "Commit addition"}
            </button>
          </div>
        </section>
      )}

      {commitResult && (
        <section
          className="repository-set-section"
          id={COMMIT_ID}
          aria-labelledby={COMMIT_HEADING_ID}
        >
          <div className="identity-row-title">
            <h4 id={COMMIT_HEADING_ID}>Addition committed</h4>
            <span className="identity-badge identity-badge-active">Audited</span>
          </div>
          <p className="identity-panel-status" role="status">
            {`Set version ${commitResult.set_version_before} → ${commitResult.set_version_after}, committed ${formatTimestamp(commitResult.committed_at)}.`}
          </p>
          <ul className="identity-list" aria-label="Committed addition">
            {commitResult.repositories.map((repository) => (
              <li
                className="identity-row"
                key={`${repository.provider_instance_id}:${repository.repository_id}`}
              >
                <div className="identity-row-main">
                  <span className="identity-meta">Repository</span>
                  <strong className="mono">{repository.repository_id}</strong>
                  <span className="identity-meta mono">{repository.provider_instance_id}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="identity-panel-status">
            {`Members reduced: ${commitResult.members_reduced.length} · grants revoked: ${commitResult.grants_revoked} · effective owners: ${commitResult.effective_owners.length}`}
          </p>
          {commitResult.members_reduced.length > 0 && (
            <ul className="identity-list" aria-label="Reduced members">
              {commitResult.members_reduced.map((member) => (
                <li className="identity-row" key={member.user_id}>
                  <div className="identity-row-main">
                    <strong className="mono">{member.user_id}</strong>
                    <span className="identity-meta">
                      {`Lost: ${member.capabilities
                        .map((capability) => capabilityLabel(capability))
                        .join(", ")}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="identity-panel-status">
            Reopen Workspaces to re-read the binding. The multi-repository rollout gate still
            decides whether access paths use the new set.
          </p>
        </section>
      )}
    </div>
  );
}
