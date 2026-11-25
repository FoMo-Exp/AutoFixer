import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IdentityClient, MemberCapabilityCeilingView } from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  CAPABILITY_LABELS,
  REPOSITORY_EVIDENCE_LABELS,
  ROLE_LABELS,
  describeError,
  formatTimestamp,
} from "./identity-format";
import { capabilityReasonLabel } from "../capabilities/projection";

interface MemberVerificationProps {
  client: IdentityClient;
  enterpriseId: string;
  workspaceId: string;
  userId: string;
  displayName: string;
}

/**
 * Per-member repository evidence and ceiling (DAT-276/DAT-280).
 *
 * Every repository is listed independently: a weaker repository never hides
 * behind a stronger one. The ceiling only moves down automatically; raising it
 * needs this explicit, audited reapproval and never exceeds what the provider
 * facts currently prove.
 */
export function MemberVerification({
  client,
  enterpriseId,
  workspaceId,
  userId,
  displayName,
}: MemberVerificationProps): ReactElement {
  const [view, setView] = useState<MemberCapabilityCeilingView>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<ErrorDescription>();
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await client.getMemberCapability(enterpriseId, workspaceId, userId);
      if (requestRef.current !== requestId) return;
      setView(next);
      setError(undefined);
    } catch (caught) {
      if (requestRef.current === requestId) setError(describeError(caught));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [client, enterpriseId, userId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reapprove(): Promise<void> {
    const ceiling = view?.capability_ceiling.ceiling;
    if (ceiling?.version === null || ceiling?.version === undefined) return;
    setBusy(true);
    try {
      await client.reapproveMemberCapability(enterpriseId, workspaceId, userId, {
        version: ceiling.version,
      });
      setNotice(`Ceiling reapproved for ${displayName} from the current verified intersection.`);
      setError(undefined);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading && view === undefined) {
    return <p className="card-empty">Reading repository evidence…</p>;
  }
  if (view === undefined) {
    return error ? <ErrorNotice error={error} onDismiss={() => setError(undefined)} /> : <></>;
  }
  const { evaluation, assigned_role, can_manage, ceiling } = view.capability_ceiling;
  return (
    <section className="identity-panel identity-verification" aria-label="Repository verification">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {notice && (
        <p className="identity-panel-status" role="status">
          {notice}
        </p>
      )}
      <div className="identity-row-title">
        <span className="eyebrow">Effective authority</span>
        <span className="identity-badge">{REPOSITORY_EVIDENCE_LABELS[evaluation.state]}</span>
        <span className="identity-badge">
          {assigned_role === null ? "No workspace role" : ROLE_LABELS[assigned_role]}
        </span>
        <span className="identity-meta">
          {`Checked ${formatTimestamp(evaluation.checked_at)}`}
          {evaluation.reason ? ` · ${capabilityReasonLabel(evaluation.reason)}` : ""}
        </span>
      </div>
      <span className="identity-meta">
        {`Effective capabilities: ${
          evaluation.capabilities.map((item) => CAPABILITY_LABELS[item] ?? item).join(", ") ||
          "none"
        }`}
      </span>
      <div className="identity-row-main">
        <span className="identity-meta">
          {`Ceiling ${ceiling.state ?? "unset"}${
            ceiling.version === null ? "" : ` · version ${ceiling.version}`
          }`}
          {ceiling.verified_at ? ` · verified ${formatTimestamp(ceiling.verified_at)}` : ""}
        </span>
        <span className="identity-meta">
          {`Approved: ${
            ceiling.capabilities.map((item) => CAPABILITY_LABELS[item] ?? item).join(", ") || "none"
          } · Available now: ${
            evaluation.available_capabilities
              .map((item) => CAPABILITY_LABELS[item] ?? item)
              .join(", ") || "none"
          }`}
        </span>
        {ceiling.reason && <span className="identity-meta">{ceiling.reason}</span>}
        {can_manage && ceiling.promotion_available && (
          <div className="identity-form-actions">
            <button
              className="button button-small button-secondary"
              disabled={busy}
              onClick={() => void reapprove()}
            >
              {busy ? "Reapproving…" : "Reapprove verified ceiling"}
            </button>
            <span className="identity-meta">
              Audited; never exceeds the current verified intersection and never changes the role.
            </span>
          </div>
        )}
        {can_manage && !ceiling.promotion_available && (
          <span className="identity-meta">
            No higher ceiling is available from the current provider facts.
          </span>
        )}
      </div>
      <div className="identity-list-heading">
        <span className="eyebrow">Repositories</span>
        <span className="event-count">{evaluation.repositories.length}</span>
      </div>
      {evaluation.repositories.length === 0 ? (
        <p className="card-empty">No repository evidence is available.</p>
      ) : (
        <ul className="identity-list">
          {evaluation.repositories.map((repository) => (
            <li className="identity-row" key={repository.repository_id}>
              <div className="identity-row-main">
                <div className="identity-row-title">
                  <strong className="mono">{repository.repository_id}</strong>
                  <span className="identity-badge">
                    {REPOSITORY_EVIDENCE_LABELS[repository.state]}
                  </span>
                </div>
                <span className="identity-meta">
                  {`${repository.provider_instance_id} · ${
                    repository.capabilities
                      .map((item) => CAPABILITY_LABELS[item] ?? item)
                      .join(", ") || "no proven capability"
                  }`}
                </span>
                <span className="identity-meta">
                  {repository.reason
                    ? capabilityReasonLabel(repository.reason)
                    : "No blocking reason reported."}
                  {repository.verified_at
                    ? ` · Verified ${formatTimestamp(repository.verified_at)}`
                    : " · Not verified"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
