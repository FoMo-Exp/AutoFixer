import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { IdentityClient, Membership, Team, Workspace } from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import { describeError, formatTimestamp } from "./identity-format";
import { Select } from "../ui/Select";

interface TeamsPanelProps {
  client: IdentityClient;
  workspace: Workspace;
  canManage: boolean;
}

interface TeamDraft {
  id?: string;
  version?: number;
  name: string;
  leaderUserId: string;
  responsibility: string;
}

const EMPTY_DRAFT: TeamDraft = { name: "", leaderUserId: "", responsibility: "" };

export function TeamsPanel({ client, workspace, canManage }: TeamsPanelProps): ReactElement {
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<TeamDraft>();
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const [error, setError] = useState<ErrorDescription>();
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const [teamPage, memberPage] = await Promise.all([
        client.listWorkspaceTeams(workspace.id),
        client.listWorkspaceMembers(workspace.id),
      ]);
      if (requestRef.current !== requestId) return;
      setTeams(teamPage.items);
      setMembers(memberPage.items);
      setError(undefined);
    } catch (caught) {
      if (requestRef.current === requestId) setError(describeError(caught));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [client, workspace.id]);

  useEffect(() => {
    setTeams([]);
    setMembers([]);
    setDraft(undefined);
    void load();
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      if (draft.id !== undefined && draft.version !== undefined) {
        await client.updateWorkspaceTeam(workspace.id, draft.id, {
          name: draft.name,
          leader_user_id: draft.leaderUserId,
          responsibility: draft.responsibility === "" ? null : draft.responsibility,
          version: draft.version,
        });
      } else {
        await client.createWorkspaceTeam(workspace.id, {
          name: draft.name,
          leader_user_id: draft.leaderUserId,
          responsibility: draft.responsibility === "" ? undefined : draft.responsibility,
        });
      }
      setDraft(undefined);
      await load();
    } catch (caught) {
      const described = describeError(caught);
      setError(described);
      if (described.code === "VERSION_CONFLICT") await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(team: Team): Promise<void> {
    setBusy(true);
    try {
      await client.deleteWorkspaceTeam(workspace.id, team.id);
      setPendingRemoval(undefined);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  const leaderOptions = [
    { value: "", label: "Select leader" },
    ...members.map((membership) => ({
      value: membership.user_id,
      label: membership.user?.display_name ?? membership.user_id,
    })),
  ];

  return (
    <div className="identity-panel">
      {!canManage && <p className="identity-panel-status">Read-only teams</p>}
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {canManage && !draft && (
        <button
          className="button button-small button-secondary identity-create"
          onClick={() => setDraft(EMPTY_DRAFT)}
        >
          New team
        </button>
      )}
      {draft && (
        <form className="identity-form" onSubmit={(event) => void save(event)}>
          <div className="identity-form-grid">
            <label>
              <span className="label-text">
                Name<span className="required-dot">*</span>
              </span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
                autoFocus
              />
            </label>
            <label>
              <span className="label-text">
                Leader<span className="required-dot">*</span>
              </span>
              <Select
                value={draft.leaderUserId}
                options={leaderOptions}
                onChange={(leaderUserId) => setDraft({ ...draft, leaderUserId })}
              />
            </label>
          </div>
          <label>
            <span className="label-text">Responsibility</span>
            <input
              value={draft.responsibility}
              onChange={(event) => setDraft({ ...draft, responsibility: event.target.value })}
              placeholder="src/payments/**"
            />
          </label>
          <div className="identity-form-actions">
            <button
              className="button button-small button-primary"
              type="submit"
              disabled={
                busy || draft.name.trim() === "" || (!draft.id && draft.leaderUserId === "")
              }
            >
              {draft.id ? "Save team" : "Create team"}
            </button>
            <button
              className="button button-small button-quiet"
              type="button"
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {loading && teams.length === 0 ? (
        <p className="card-empty">Loading teams…</p>
      ) : teams.length === 0 ? (
        <p className="card-empty">No teams in this workspace.</p>
      ) : (
        <ul className="identity-list">
          {teams.map((team) => (
            <li className="identity-row" key={team.id}>
              <div className="identity-row-main">
                <div className="identity-row-title">
                  <strong>{team.name}</strong>
                  <span className="mono identity-id">{team.id}</span>
                </div>
                <span className="identity-meta">
                  {`Leader ${team.leader?.display_name ?? team.leader_user_id}`}
                  {team.responsibility ? ` · ${team.responsibility}` : " · No responsibility"}
                  {` · Updated ${formatTimestamp(team.updated_at)}`}
                </span>
              </div>
              {canManage && (
                <div className="identity-row-actions">
                  <button
                    className="button button-small button-quiet"
                    onClick={() =>
                      setDraft({
                        id: team.id,
                        version: team.version,
                        name: team.name,
                        leaderUserId: team.leader_user_id,
                        responsibility: team.responsibility ?? "",
                      })
                    }
                  >
                    Edit
                  </button>
                  {pendingRemoval === team.id ? (
                    <div className="identity-confirm">
                      <button
                        className="button button-small button-danger"
                        disabled={busy}
                        onClick={() => void remove(team)}
                      >
                        Delete
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
                      onClick={() => setPendingRemoval(team.id)}
                    >
                      Delete
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
