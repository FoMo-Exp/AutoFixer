import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  IdentityClient,
  MemberCandidate,
  Membership,
  Workspace,
  WorkspaceRole,
} from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  INELIGIBLE_REASON_LABELS,
  PROVENANCE_LABELS,
  ROLE_LABELS,
  ROLE_OPTIONS,
  authoritySummary,
  describeError,
  isStaleAuthority,
} from "./identity-format";
import { Select } from "../ui/Select";
import { MemberVerification } from "./MemberVerification";

interface MembersPanelProps {
  client: IdentityClient;
  workspace: Workspace;
  canManage: boolean;
  /** Role changes are a separate capability from member removal. */
  canManageRoles?: boolean;
  /** Per-repository evidence is an enterprise-administrator view. */
  canViewVerification?: boolean;
}

export function MembersPanel({
  client,
  workspace,
  canManage,
  canManageRoles = canManage,
  canViewVerification = false,
}: MembersPanelProps): ReactElement {
  const [members, setMembers] = useState<Membership[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const [error, setError] = useState<ErrorDescription>();
  const [verificationUserId, setVerificationUserId] = useState<string>();
  const [mode, setMode] = useState<"members" | "candidates">("members");
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<ErrorDescription>();
  const [accountId, setAccountId] = useState("");
  const [grantRole, setGrantRole] = useState<WorkspaceRole>("member");
  const [granting, setGranting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const requestRef = useRef(0);
  const candidateRequestRef = useRef(0);

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      const requestId = ++requestRef.current;
      setLoading(true);
      try {
        const page = await client.listWorkspaceMembers(workspace.id, cursor);
        if (requestRef.current !== requestId) return;
        setMembers((current) => (cursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.next_cursor);
        setError(undefined);
      } catch (caught) {
        if (requestRef.current === requestId) setError(describeError(caught));
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    },
    [client, workspace.id],
  );

  const loadCandidates = useCallback(
    async (cursor?: string): Promise<void> => {
      const requestId = ++candidateRequestRef.current;
      setCandidateLoading(true);
      try {
        const page = await client.listMemberCandidates(workspace.id, cursor);
        if (candidateRequestRef.current !== requestId) return;
        setCandidates((current) => (cursor ? [...current, ...page.items] : page.items));
        setCandidateCursor(page.next_cursor);
        setCandidateError(undefined);
      } catch (caught) {
        if (candidateRequestRef.current === requestId) {
          setCandidateError(describeError(caught));
        }
      } finally {
        if (candidateRequestRef.current === requestId) setCandidateLoading(false);
      }
    },
    [client, workspace.id],
  );

  useEffect(() => {
    setMembers([]);
    setNextCursor(null);
    setVerificationUserId(undefined);
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== "candidates" || !canManage || candidates.length > 0) return;
    void loadCandidates();
  }, [canManage, candidates.length, loadCandidates, mode]);

  async function changeRole(membership: Membership, role: WorkspaceRole): Promise<void> {
    if (role === membership.role || membership.version === undefined) return;
    setBusyId(membership.id);
    try {
      const updated = await client.updateWorkspaceMember(workspace.id, membership.id, {
        role,
        version: membership.version,
      });
      setMembers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setError(undefined);
    } catch (caught) {
      const described = describeError(caught);
      // A version conflict means the roster is stale; reload so the retry uses
      // the server's current version instead of repeating the failed write.
      // The reload clears the notice, so the conflict is set afterwards.
      if (described.code === "VERSION_CONFLICT") await load();
      setError(described);
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove(membership: Membership): Promise<void> {
    setBusyId(membership.id);
    try {
      await client.removeWorkspaceMember(workspace.id, membership.id);
      setMembers((current) => current.filter((item) => item.id !== membership.id));
      setPendingRemoval(undefined);
      setError(undefined);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusyId(undefined);
    }
  }

  async function grant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (accountId.trim() === "") return;
    setGranting(true);
    try {
      await client.addWorkspaceMember(workspace.id, {
        user_id: accountId.trim(),
        role: grantRole,
      });
      setNotice(`Granted ${ROLE_LABELS[grantRole]} to ${accountId.trim()}.`);
      setAccountId("");
      setError(undefined);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="identity-panel">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {notice && (
        <p className="identity-panel-status" role="status">
          {notice}
        </p>
      )}
      {canManage && (
        <div className="identity-form-actions" role="group" aria-label="Member views">
          <button
            className={`button button-small ${mode === "members" ? "button-secondary" : "button-quiet"}`}
            aria-pressed={mode === "members"}
            onClick={() => setMode("members")}
          >
            Members
          </button>
          <button
            className={`button button-small ${mode === "candidates" ? "button-secondary" : "button-quiet"}`}
            aria-pressed={mode === "candidates"}
            onClick={() => setMode("candidates")}
          >
            Provider candidates
          </button>
        </div>
      )}
      {mode === "members" && (
        <>
          {!canManage && <p className="identity-panel-status">Read-only roster</p>}
          {loading && members.length === 0 ? (
            <p className="card-empty">Loading members…</p>
          ) : members.length === 0 ? (
            <p className="card-empty">No members in this workspace.</p>
          ) : (
            <ul className="identity-list">
              {members.map((membership) => {
                const stale = isStaleAuthority(membership);
                const expanded = verificationUserId === membership.user_id;
                return (
                  <li className="identity-row" key={membership.id}>
                    <div className="identity-row-main">
                      <div className="identity-row-title">
                        <strong>{membership.user?.display_name ?? membership.user_id}</strong>
                        <span className="mono identity-id">{membership.user_id}</span>
                        {stale && <span className="identity-badge identity-badge-warn">Stale</span>}
                      </div>
                      <span className="identity-meta">{authoritySummary(membership)}</span>
                    </div>
                    <div className="identity-row-actions">
                      {canViewVerification && (
                        <button
                          className="button button-small button-quiet"
                          aria-expanded={expanded}
                          onClick={() =>
                            setVerificationUserId(expanded ? undefined : membership.user_id)
                          }
                        >
                          Verification
                        </button>
                      )}
                      {canManageRoles ? (
                        <Select
                          value={membership.role}
                          options={ROLE_OPTIONS}
                          onChange={(value) => void changeRole(membership, value as WorkspaceRole)}
                          disabled={busyId === membership.id || membership.version === undefined}
                          className="identity-role-select"
                        />
                      ) : (
                        <span className="identity-badge">{ROLE_LABELS[membership.role]}</span>
                      )}
                      {canManage &&
                        (pendingRemoval === membership.id ? (
                          <div className="identity-confirm">
                            <button
                              className="button button-small button-danger"
                              disabled={busyId === membership.id}
                              onClick={() => void remove(membership)}
                            >
                              Remove
                            </button>
                            <button
                              className="button button-small button-quiet"
                              onClick={() => setPendingRemoval(undefined)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="button button-small button-quiet identity-destructive"
                            onClick={() => setPendingRemoval(membership.id)}
                          >
                            Remove
                          </button>
                        ))}
                    </div>
                    {expanded && (
                      <MemberVerification
                        client={client}
                        enterpriseId={workspace.enterprise_id}
                        workspaceId={workspace.id}
                        userId={membership.user_id}
                        displayName={membership.user?.display_name ?? membership.user_id}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {nextCursor && (
            <button
              className="button button-small button-quiet identity-load-more"
              disabled={loading}
              onClick={() => void load(nextCursor)}
            >
              {loading ? "Loading…" : "Load more members"}
            </button>
          )}
        </>
      )}
      {mode === "candidates" && canManage && (
        <>
          {candidateError && (
            <ErrorNotice error={candidateError} onDismiss={() => setCandidateError(undefined)} />
          )}
          <form className="identity-form" onSubmit={(event) => void grant(event)}>
            <span className="label-text">Grant an existing account</span>
            <div className="identity-form-grid">
              <label>
                <span className="label-text">Account id</span>
                <input
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  placeholder="usr_…"
                  required
                />
              </label>
              <label>
                <span className="label-text">Role</span>
                <Select
                  value={grantRole}
                  options={ROLE_OPTIONS}
                  onChange={(value) => setGrantRole(value as WorkspaceRole)}
                  ariaLabel="Role to grant"
                />
              </label>
            </div>
            <span className="identity-meta">
              The account must have signed in and be an eligible candidate: code read proven on
              every repository. The provider intersection caps viewer/member; admin and owner stay a
              separate owner decision. The service refuses any field it cannot verify.
            </span>
            <div className="identity-form-actions">
              <button
                className="button button-small button-primary"
                type="submit"
                disabled={granting || accountId.trim() === ""}
              >
                {granting ? "Granting…" : "Grant membership"}
              </button>
            </div>
          </form>
          <div className="identity-list-heading">
            <span className="eyebrow">Provider candidates</span>
            <span className="event-count">{candidates.length}</span>
          </div>
          {candidateLoading && candidates.length === 0 ? (
            <p className="card-empty">Reading the provider roster…</p>
          ) : candidates.length === 0 ? (
            <p className="card-empty">The provider roster has no candidates for this workspace.</p>
          ) : (
            <ul className="identity-list">
              {candidates.map((candidate) => {
                const identity = candidate.user.identities[0];
                const key = `${candidate.user.display_name}:${identity?.provider_instance_id ?? ""}:${identity?.subject_id ?? ""}`;
                return (
                  <li className="identity-row" key={key}>
                    <div className="identity-row-main">
                      <div className="identity-row-title">
                        <strong>{candidate.user.display_name || "Unnamed provider subject"}</strong>
                        {identity && (
                          <span className="mono identity-id">
                            {`${identity.provider_type}:${identity.subject_id}`}
                          </span>
                        )}
                        {candidate.eligible ? (
                          <span className="identity-badge identity-badge-active">
                            Eligible up to{" "}
                            {candidate.max_role ? ROLE_LABELS[candidate.max_role] : "no role"}
                          </span>
                        ) : (
                          <span className="identity-badge identity-badge-warn">
                            {candidate.already_member
                              ? "Already a member"
                              : candidate.ineligible_reason
                                ? INELIGIBLE_REASON_LABELS[candidate.ineligible_reason]
                                : "Ineligible"}
                          </span>
                        )}
                      </div>
                      <span className="identity-meta">
                        {`Provider role ${candidate.provider_role ?? "none"} · ${
                          PROVENANCE_LABELS[candidate.provenance]
                        }`}
                        {candidate.assignable_roles.length > 0
                          ? ` · Assignable: ${candidate.assignable_roles
                              .map((role) => ROLE_LABELS[role])
                              .join(", ")}`
                          : ""}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {candidateCursor && (
            <button
              className="button button-small button-quiet identity-load-more"
              disabled={candidateLoading}
              onClick={() => void loadCandidates(candidateCursor)}
            >
              {candidateLoading ? "Loading…" : "Load more candidates"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
