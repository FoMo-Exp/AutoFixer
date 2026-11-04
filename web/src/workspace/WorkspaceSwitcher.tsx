import type { ReactElement } from "react";
import type { Workspace, WorkspaceRole } from "../api/client";
import { Select } from "../ui/Select";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export function WorkspaceSwitcher({
  workspace,
  workspaces,
  onSelect,
}: {
  workspace: Workspace;
  workspaces: Workspace[];
  onSelect: (workspaceId: string) => void;
}): ReactElement {
  return (
    <div className="workspace-switcher">
      <span className="eyebrow">Workspace</span>
      <Select
        id="workspace-switcher"
        ariaLabel="Workspace"
        value={workspace.id}
        options={workspaces.map((item) => ({ value: item.id, label: item.name }))}
        onChange={onSelect}
        disabled={workspaces.length < 2}
      />
      <div className="workspace-binding">
        <span className="workspace-repository" title={workspace.repository.repository_id}>
          {workspace.repository.repository_id}
        </span>
        <span className={`role-chip role-${workspace.role}`}>{ROLE_LABEL[workspace.role]}</span>
      </div>
    </div>
  );
}

export function WorkspaceChooser({
  workspaces,
  displayName,
  onSelect,
  onSignOut,
}: {
  workspaces: Workspace[];
  displayName?: string;
  onSelect: (workspaceId: string) => void;
  onSignOut: () => Promise<void>;
}): ReactElement {
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <span className="eyebrow">Workspace access</span>
        <h1>Choose a workspace</h1>
        <p className="auth-lede">
          {displayName ? `${displayName}, your` : "Your"} account can enter more than one workspace.
          Tasks, evidence, and live runs stay inside the one you select.
        </p>
        <div className="workspace-choices">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className="workspace-choice"
              onClick={() => onSelect(workspace.id)}
            >
              <span className="workspace-choice-name">{workspace.name}</span>
              <span className="workspace-choice-meta">{workspace.repository.repository_id}</span>
              <span className={`role-chip role-${workspace.role}`}>
                {ROLE_LABEL[workspace.role]}
              </span>
            </button>
          ))}
        </div>
        <div className="auth-actions">
          <button className="button button-quiet" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </main>
    </div>
  );
}

export function WorkspaceUnavailableScreen({
  message,
  onRetry,
  onSignOut,
}: {
  message?: string;
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
}): ReactElement {
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <span className="eyebrow">Workspace access</span>
        <h1>Workspaces could not be loaded</h1>
        <p className="auth-lede">
          {message ?? "The local ForgePilot service did not return your workspace list."}
        </p>
        <div className="auth-actions">
          <button className="button button-primary" onClick={() => void onRetry()}>
            Check again
          </button>
          <button className="button button-quiet" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </main>
    </div>
  );
}
