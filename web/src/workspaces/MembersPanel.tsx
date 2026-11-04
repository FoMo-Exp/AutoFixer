import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IdentityClient, Membership, Workspace } from "../api/identity";
import type { WorkspaceRole } from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  ROLE_LABELS,
  ROLE_OPTIONS,
  authoritySummary,
  describeError,
  isStaleAuthority,
} from "./identity-format";
import { Select } from "../ui/Select";

interface MembersPanelProps {
  client: IdentityClient;
  workspace: Workspace;
  canManage: boolean;
}

export function MembersPanel({ client, workspace, canManage }: MembersPanelProps): ReactElement {
  const [members, setMembers] = useState<Membership[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const [error, setError] = useState<ErrorDescription>();
  const requestRef = useRef(0);

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

  useEffect(() => {
    setMembers([]);
    setNextCursor(null);
    void load();
  }, [load]);

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
      setError(described);
      // A version conflict means the roster is stale; reload so the retry uses
      // the server's current version instead of repeating the failed write.
      if (described.code === "VERSION_CONFLICT") await load();
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

  return (
    <div className="identity-panel">
      {!canManage && <p className="identity-panel-status">Read-only roster</p>}
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {loading && members.length === 0 ? (
        <p className="card-empty">Loading members…</p>
      ) : members.length === 0 ? (
        <p className="card-empty">No members in this workspace.</p>
      ) : (
        <ul className="identity-list">
          {members.map((membership) => {
            const stale = isStaleAuthority(membership);
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
                  {canManage ? (
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
    </div>
  );
}
