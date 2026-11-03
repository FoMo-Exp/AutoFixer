import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IdentityClient, SessionInfo, Workspace } from "../api/identity";
import { AuditPanel } from "./AuditPanel";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  ROLE_LABELS,
  canManageWorkspace,
  describeError,
  isEnterpriseAdmin,
  formatTimestamp,
} from "./identity-format";
import { InvitationsPanel } from "./InvitationsPanel";
import { MembersPanel } from "./MembersPanel";
import { TeamsPanel } from "./TeamsPanel";

interface WorkspaceAdminDialogProps {
  client: IdentityClient;
  session: SessionInfo;
  onClose: () => void;
}

type AdminTab = "members" | "teams" | "invitations" | "audit";

export function WorkspaceAdminDialog({
  client,
  session,
  onClose,
}: WorkspaceAdminDialogProps): ReactElement {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorDescription>();
  const [activeTab, setActiveTab] = useState<AdminTab>("members");
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const page = await client.listWorkspaces();
      setWorkspaces(page.items);
      setSelectedId((current) =>
        current && page.items.some((item) => item.id === current)
          ? current
          : (page.items[0]?.id ?? undefined),
      );
      setError(undefined);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    const focusable = (): HTMLElement[] =>
      dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.closest("[hidden]") === null)
        : [];

    (focusable()[0] ?? dialog)?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const workspace = workspaces.find((item) => item.id === selectedId);
  const canManage = canManageWorkspace(workspace, session);
  const auditAllowed = workspace ? isEnterpriseAdmin(session, workspace.enterprise_id) : false;
  const visibleTab: AdminTab =
    (activeTab === "invitations" && !canManage) || (activeTab === "audit" && !auditAllowed)
      ? "members"
      : activeTab;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="modal modal-admin"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-admin-title"
        tabIndex={-1}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Enterprise</span>
            <h2 id="workspace-admin-title">Workspaces</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close workspaces">
            ×
          </button>
        </div>
        {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
        {loading && workspaces.length === 0 ? (
          <p className="card-empty">Loading workspaces…</p>
        ) : workspaces.length === 0 ? (
          <p className="card-empty">No workspaces are visible to your memberships.</p>
        ) : (
          <div className="admin-layout">
            <nav className="admin-workspaces" aria-label="Workspaces">
              {workspaces.map((item) => (
                <button
                  key={item.id}
                  className={`admin-workspace${item.id === selectedId ? " active" : ""}`}
                  aria-current={item.id === selectedId ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(item.id);
                    setActiveTab("members");
                  }}
                >
                  <span className="admin-workspace-name">{item.name}</span>
                  <span className="admin-workspace-meta">
                    <span className="identity-badge">{ROLE_LABELS[item.role]}</span>
                    {item.status === "archived" && (
                      <span className="identity-badge identity-badge-warn">Archived</span>
                    )}
                  </span>
                </button>
              ))}
            </nav>
            {workspace && (
              <div className="admin-detail">
                <div className="admin-detail-heading">
                  <div>
                    <h3>{workspace.name}</h3>
                    <span className="identity-meta">
                      {`${workspace.repository.provider_type} · ${workspace.repository.repository_id}`}
                      {` · Updated ${formatTimestamp(workspace.updated_at)}`}
                    </span>
                  </div>
                  {!canManage && <span className="identity-badge">Read-only</span>}
                </div>
                <div className="settings-tabs" role="tablist" aria-label="Workspace sections">
                  <button
                    id="admin-tab-members"
                    type="button"
                    role="tab"
                    className={`settings-tab${visibleTab === "members" ? " active" : ""}`}
                    aria-selected={visibleTab === "members"}
                    onClick={() => setActiveTab("members")}
                  >
                    Members
                  </button>
                  <button
                    id="admin-tab-teams"
                    type="button"
                    role="tab"
                    className={`settings-tab${visibleTab === "teams" ? " active" : ""}`}
                    aria-selected={visibleTab === "teams"}
                    onClick={() => setActiveTab("teams")}
                  >
                    Teams
                  </button>
                  {canManage && (
                    <button
                      id="admin-tab-invitations"
                      type="button"
                      role="tab"
                      className={`settings-tab${visibleTab === "invitations" ? " active" : ""}`}
                      aria-selected={visibleTab === "invitations"}
                      onClick={() => setActiveTab("invitations")}
                    >
                      Invitations
                    </button>
                  )}
                  {auditAllowed && (
                    <button
                      id="admin-tab-audit"
                      type="button"
                      role="tab"
                      className={`settings-tab${visibleTab === "audit" ? " active" : ""}`}
                      aria-selected={visibleTab === "audit"}
                      onClick={() => setActiveTab("audit")}
                    >
                      Audit
                    </button>
                  )}
                </div>
                <div
                  className="admin-panel-scroll"
                  id={`admin-panel-${visibleTab}`}
                  role="tabpanel"
                  aria-labelledby={`admin-tab-${visibleTab}`}
                >
                  {visibleTab === "members" && (
                    <MembersPanel
                      key={`members-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canManage={canManage}
                    />
                  )}
                  {visibleTab === "teams" && (
                    <TeamsPanel
                      key={`teams-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canManage={canManage}
                    />
                  )}
                  {visibleTab === "invitations" && canManage && (
                    <InvitationsPanel
                      key={`invitations-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                    />
                  )}
                  {visibleTab === "audit" && auditAllowed && (
                    <AuditPanel
                      key={`audit-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
