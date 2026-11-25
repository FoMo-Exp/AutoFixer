import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type {
  EnterpriseUser,
  IdentityClient,
  MemberCandidate,
  Workspace,
  WorkspaceRole,
} from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  INELIGIBLE_REASON_LABELS,
  PROVENANCE_LABELS,
  ROLE_LABELS,
  describeError,
} from "./identity-format";
import { Select } from "../ui/Select";

interface EnterpriseWorkspaceGrantProps {
  client: IdentityClient;
  enterpriseId: string;
  user: EnterpriseUser;
  workspaces: Workspace[];
  onGranted: (workspaceName: string) => void;
  onError: (caught: unknown) => void;
}

/**
 * Explicit enterprise-administrator workspace join (DAT-280).
 *
 * The administrator chooses one workspace at a time. The workspace's provider
 * roster decides whether the person can join and which roles are assignable;
 * the service re-verifies every repository and the capability ceiling, and no
 * other workspace is touched by a grant.
 */
export function EnterpriseWorkspaceGrant({
  client,
  enterpriseId,
  user,
  workspaces,
  onGranted,
  onError,
}: EnterpriseWorkspaceGrantProps): ReactElement {
  const [workspaceId, setWorkspaceId] = useState("");
  const [candidate, setCandidate] = useState<MemberCandidate>();
  const [role, setRole] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription>();

  const matchingCandidate = useCallback(
    (items: MemberCandidate[]): MemberCandidate | undefined =>
      items.find((item) =>
        item.user.identities.some(
          (identity) =>
            identity.provider_instance_id === user.provider_instance_id &&
            identity.subject_id === user.subject,
        ),
      ),
    [user.provider_instance_id, user.subject],
  );

  useEffect(() => {
    if (workspaceId === "") {
      setCandidate(undefined);
      setRole("");
      return;
    }
    let active = true;
    setLoading(true);
    setCandidate(undefined);
    setRole("");
    setError(undefined);
    void client
      .listMemberCandidates(workspaceId)
      .then((page) => {
        if (!active) return;
        const match = matchingCandidate(page.items);
        setCandidate(match);
        if (match !== undefined && match.eligible) {
          setRole(match.max_role ?? match.assignable_roles[0] ?? "");
        }
      })
      .catch((caught) => {
        if (active) setError(describeError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, matchingCandidate, workspaceId]);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const roleOptions = (candidate?.assignable_roles ?? []).map((value) => ({
    value,
    label: ROLE_LABELS[value],
  }));

  async function grant(): Promise<void> {
    if (workspace === undefined || user.user_id === null || role === "") return;
    setBusy(true);
    try {
      await client.grantWorkspaceMember(enterpriseId, workspace.id, user.user_id, {
        role: role as WorkspaceRole,
      });
      setCandidate(undefined);
      setWorkspaceId("");
      setRole("");
      setError(undefined);
      onGranted(workspace.name);
    } catch (caught) {
      setError(describeError(caught));
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="identity-panel identity-grant" aria-label="Workspace access">
      <div className="identity-list-heading">
        <span className="eyebrow">Grant workspace access</span>
      </div>
      <p className="identity-meta">
        Choose exactly one workspace. Every repository of that workspace must prove code read, and
        the verified intersection caps the role. No other workspace is granted implicitly.
      </p>
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      <label>
        <span className="label-text">Workspace</span>
        <Select
          value={workspaceId}
          options={workspaces.map((item) => ({
            value: item.id,
            label: item.status === "archived" ? `${item.name} (archived)` : item.name,
          }))}
          onChange={setWorkspaceId}
          ariaLabel="Workspace to grant"
        />
      </label>
      {workspace !== undefined && (
        <span className="identity-meta">
          {`${workspace.repository.provider_type} · ${workspace.repository.repository_id}`}
          {workspace.status === "archived" ? " · Archived workspaces cannot take new members" : ""}
        </span>
      )}
      {loading && <p className="card-empty">Reading this workspace&apos;s provider roster…</p>}
      {!loading && workspace !== undefined && candidate === undefined && (
        <p className="card-empty" role="status">
          This person is not in the workspace&apos;s provider roster, so no verified eligibility
          exists. Nothing is granted.
        </p>
      )}
      {!loading && candidate !== undefined && workspace !== undefined && (
        <div className="identity-row-main">
          <span className="identity-meta">
            {`Provider role ${candidate.provider_role ?? "none"} · ${
              PROVENANCE_LABELS[candidate.provenance]
            }`}
          </span>
          {candidate.already_member ? (
            <span className="identity-badge">Already a member</span>
          ) : candidate.eligible ? (
            <span className="identity-badge identity-badge-active">
              Eligible up to {candidate.max_role ? ROLE_LABELS[candidate.max_role] : "no role"}
            </span>
          ) : (
            <span className="identity-badge identity-badge-warn">
              {candidate.ineligible_reason
                ? INELIGIBLE_REASON_LABELS[candidate.ineligible_reason]
                : "Ineligible"}
            </span>
          )}
          {candidate.eligible && !candidate.already_member && (
            <div className="identity-row-actions">
              <Select
                value={role}
                options={roleOptions}
                onChange={setRole}
                ariaLabel="Role to grant"
              />
              <button
                className="button button-small button-primary"
                disabled={busy || role === "" || workspace.status === "archived"}
                onClick={() => void grant()}
              >
                {busy ? "Granting…" : `Grant ${ROLE_LABELS[role as WorkspaceRole] ?? "role"}`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
