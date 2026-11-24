import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IdentityClient, Workspace, WorkspaceSession } from "../api/identity";
import { AuditPanel } from "./AuditPanel";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import { ROLE_LABELS, describeError, isEnterpriseAdmin, formatTimestamp } from "./identity-format";
import { InvitationsPanel } from "./InvitationsPanel";
import { MembersPanel } from "./MembersPanel";
import { ServiceIntegrationPanel } from "./ServiceIntegrationPanel";
import { TeamsPanel } from "./TeamsPanel";
import { accessAllowed } from "../capabilities/projection";
import { useWorkspaceCapabilities } from "../capabilities/use-capabilities";

interface WorkspaceAdminDialogProps {
  client: IdentityClient;
  session: WorkspaceSession;
  onClose: () => void;
  initialTab?: AdminTab;
}

type AdminTab = "members" | "teams" | "invitations" | "audit" | "integration";

export function WorkspaceAdminDialog({
  client,
  session,
  onClose,
  initialTab = "members",
}: WorkspaceAdminDialogProps): ReactElement {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorDescription>();
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);
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
  // Every administration affordance is decided by the projection for the
  // selected workspace. The legacy local mode (no identity) never opens this
  // dialog. While the projection loads or fails, writes stay hidden.
  const capabilities = useWorkspaceCapabilities({
    client,
    workspaceId: selectedId ?? null,
    enabled: selectedId !== undefined,
  });
  const snapshot = capabilities.status === "ready" ? capabilities.snapshot : undefined;
  const members = snapshot?.modules.members;
  const service = snapshot?.modules.service_integration;
  const canManageMembers = accessAllowed(members, "manage_members");
  const canManageTeams = accessAllowed(members, "manage_teams");
  const canInvite = accessAllowed(members, "invite");
  const canManageRoles = accessAllowed(members, "manage_roles");
  const canViewMembers = accessAllowed(members, "view");
  const canViewIntegration = accessAllowed(service, "view_metadata");
  const canConfigureIntegration = accessAllowed(service, "configure");
  const enterpriseAdmin = workspace ? isEnterpriseAdmin(session, workspace.enterprise_id) : false;
  const tabAllowed = (tab: AdminTab): boolean => {
    switch (tab) {
      case "members":
      case "teams":
        return canViewMembers;
      case "invitations":
        return canInvite;
      case "audit":
        return enterpriseAdmin;
      case "integration":
        return canViewIntegration;
    }
  };
  const visibleTab: AdminTab = tabAllowed(activeTab)
    ? activeTab
    : ((["members", "teams", "invitations", "audit", "integration"] as AdminTab[]).find(
        tabAllowed,
      ) ?? "members");
  const canManage = canManageMembers || canManageTeams || canInvite || canManageRoles;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="modal modal-admin glass"
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
                {capabilities.status !== "ready" && (
                  <p className="identity-panel-status" role="status">
                    {capabilities.status === "error"
                      ? "The capability projection could not be read, so administration stays read-only."
                      : "Verifying workspace capabilities before showing administration…"}
                  </p>
                )}
                <div className="settings-tabs" role="tablist" aria-label="Workspace sections">
                  {canViewMembers && (
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
                  )}
                  {canViewMembers && (
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
                  )}
                  {canInvite && (
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
                  {enterpriseAdmin && (
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
                  {canViewIntegration && (
                    <button
                      id="admin-tab-integration"
                      type="button"
                      role="tab"
                      className={`settings-tab${visibleTab === "integration" ? " active" : ""}`}
                      aria-selected={visibleTab === "integration"}
                      onClick={() => setActiveTab("integration")}
                    >
                      Integration
                    </button>
                  )}
                </div>
                {capabilities.status === "ready" &&
                  !tabAllowed("members") &&
                  !tabAllowed("invitations") &&
                  !tabAllowed("audit") &&
                  !tabAllowed("integration") && (
                    <p className="card-empty" role="status">
                      No administration module is available from the current capability projection.
                    </p>
                  )}
                <div
                  className="admin-panel-scroll"
                  id={`admin-panel-${visibleTab}`}
                  role="tabpanel"
                  aria-labelledby={`admin-tab-${visibleTab}`}
                >
                  {visibleTab === "members" && canViewMembers && (
                    <MembersPanel
                      key={`members-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canManage={canManageMembers}
                      canManageRoles={canManageRoles}
                    />
                  )}
                  {visibleTab === "teams" && canViewMembers && (
                    <TeamsPanel
                      key={`teams-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canManage={canManageTeams}
                    />
                  )}
                  {visibleTab === "invitations" && canInvite && (
                    <InvitationsPanel
                      key={`invitations-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                    />
                  )}
                  {visibleTab === "audit" && enterpriseAdmin && (
                    <AuditPanel
                      key={`audit-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                    />
                  )}
                  {visibleTab === "integration" && canViewIntegration && (
                    <ServiceIntegrationPanel
                      key={`integration-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canConfigure={canConfigureIntegration}
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
