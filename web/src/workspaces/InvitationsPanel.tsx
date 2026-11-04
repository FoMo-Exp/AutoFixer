import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { CreatedInvitation, IdentityClient, Invitation, Workspace } from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  INVITATION_STATUS_LABELS,
  INVITE_EXPIRY_OPTIONS,
  describeError,
  formatTimestamp,
} from "./identity-format";
import { InviteQrCode } from "./InviteQrCode";
import { groupInviteCode } from "./invite-token";
import { Select } from "../ui/Select";

interface InvitationsPanelProps {
  client: IdentityClient;
  workspace: Workspace;
}

interface RevealProps {
  created: CreatedInvitation;
  onDismiss: () => void;
}

function InvitationReveal({ created, onDismiss }: RevealProps): ReactElement {
  const [copied, setCopied] = useState(false);

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="invite-reveal" aria-label="New invitation">
      <InviteQrCode value={created.invite_url} label="Invitation QR code" />
      <div className="invite-reveal-body">
        <span className="eyebrow">Single-use invitation</span>
        <div className="invite-code mono">{groupInviteCode(created.token)}</div>
        <div className="invite-reveal-actions">
          <button className="button button-small button-secondary" onClick={() => void copyCode()}>
            Copy code
          </button>
          <button className="button button-small button-quiet" onClick={onDismiss}>
            Done
          </button>
        </div>
        <span className="identity-meta" role="status">
          {copied ? "Copied" : `Expires ${formatTimestamp(created.invitation.expires_at)}`}
        </span>
      </div>
    </section>
  );
}

export function InvitationsPanel({ client, workspace }: InvitationsPanelProps): ReactElement {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expiry, setExpiry] = useState(String(INVITE_EXPIRY_OPTIONS[2].value));
  const [boundSubject, setBoundSubject] = useState("");
  const [revealed, setRevealed] = useState<CreatedInvitation>();
  const [pendingRevoke, setPendingRevoke] = useState<string>();
  const [error, setError] = useState<ErrorDescription>();
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const page = await client.listInvitations(workspace.id);
      if (requestRef.current !== requestId) return;
      setInvitations(page.items);
      setError(undefined);
    } catch (caught) {
      if (requestRef.current === requestId) setError(describeError(caught));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [client, workspace.id]);

  useEffect(() => {
    setInvitations([]);
    setRevealed(undefined);
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await client.createInvitation(workspace.id, {
        expires_in_seconds: Number(expiry),
        ...(boundSubject.trim() === "" ? {} : { bound_provider_subject: boundSubject.trim() }),
      });
      setRevealed(created);
      setBoundSubject("");
      setError(undefined);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitation: Invitation): Promise<void> {
    setBusy(true);
    try {
      await client.revokeInvitation(workspace.id, invitation.id);
      setPendingRevoke(undefined);
      setError(undefined);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="identity-panel">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {revealed && <InvitationReveal created={revealed} onDismiss={() => setRevealed(undefined)} />}
      <form className="identity-form" onSubmit={(event) => void create(event)}>
        <div className="identity-form-grid">
          <label>
            <span className="label-text">Expires</span>
            <Select value={expiry} options={INVITE_EXPIRY_OPTIONS} onChange={setExpiry} />
          </label>
          <label>
            <span className="label-text">Bound provider subject</span>
            <input value={boundSubject} onChange={(event) => setBoundSubject(event.target.value)} />
          </label>
        </div>
        <div className="identity-form-actions">
          <button className="button button-small button-primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create invitation"}
          </button>
        </div>
      </form>
      <div className="identity-list-heading">
        <span className="eyebrow">Invitations</span>
        <span className="event-count">{invitations.length}</span>
      </div>
      {loading && invitations.length === 0 ? (
        <p className="card-empty">Loading invitations…</p>
      ) : invitations.length === 0 ? (
        <p className="card-empty">No invitations in this workspace.</p>
      ) : (
        <ul className="identity-list">
          {invitations.map((invitation) => (
            <li className="identity-row" key={invitation.id}>
              <div className="identity-row-main">
                <div className="identity-row-title">
                  <strong>{INVITATION_STATUS_LABELS[invitation.status]}</strong>
                  <span className="mono identity-id">{invitation.id}</span>
                  <span className={`identity-badge identity-badge-${invitation.status}`}>
                    {invitation.role}
                  </span>
                </div>
                <span className="identity-meta">
                  {`Created by ${invitation.created_by.display_name} · ${formatTimestamp(invitation.created_at)}`}
                  {` · Expires ${formatTimestamp(invitation.expires_at)}`}
                  {invitation.bound_provider_subject
                    ? ` · Bound to ${invitation.bound_provider_subject}`
                    : ""}
                </span>
              </div>
              {invitation.status === "active" && (
                <div className="identity-row-actions">
                  {pendingRevoke === invitation.id ? (
                    <div className="identity-confirm">
                      <button
                        className="button button-small button-danger"
                        disabled={busy}
                        onClick={() => void revoke(invitation)}
                      >
                        Revoke
                      </button>
                      <button
                        className="button button-small button-quiet"
                        onClick={() => setPendingRevoke(undefined)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="button button-small button-quiet identity-destructive"
                      onClick={() => setPendingRevoke(invitation.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
