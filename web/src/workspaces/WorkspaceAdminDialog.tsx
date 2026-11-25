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
import { EnterpriseUsersPanel } from "./EnterpriseUsersPanel";
import { accessAllowed } from "../capabilities/projection";
import { useWorkspaceCapabilities } from "../capabilities/use-capabilities";
import { enterpriseActionAllowed, enterpriseModuleVisible } from "../capabilities/enterprise";
import { useEnterpriseCapabilities } from "../capabilities/use-enterprise-capabilities";

interface WorkspaceAdminDialogProps {
  client: IdentityClient;
  session: WorkspaceSession;
  onClose: () => void;
  initialTab?: AdminTab;
}

type AdminTab = "members" | "teams" | "invitations" | "audit" | "integration" | "enterprise";

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
  // The directory is enterprise-scoped: with no selected workspace an
  // administrator can still reach it through an administrator enterprise role.
  const enterpriseId = workspace?.enterprise_id ?? session.enterprise_roles[0]?.enterprise_id;
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
  const enterpriseAdmin = enterpriseId ? isEnterpriseAdmin(session, enterpriseId) : false;
  // Enterprise directory entry and actions come from the enterprise projection,
  // never from the session's role list; the role only decides whether the
  // surface is offered at all.
  const enterpriseCapabilities = useEnterpriseCapabilities({
    client,
    enterpriseId: enterpriseId ?? null,
    enabled: enterpriseAdmin && enterpriseId !== undefined,
  });
  const enterpriseSnapshot =
    enterpriseCapabilities.status === "ready" ? enterpriseCapabilities.snapshot : undefined;
  const canViewEnterprise =
    enterpriseModuleVisible(enterpriseSnapshot, "enterprise_directory") &&
    enterpriseActionAllowed(enterpriseSnapshot, "enterprise_directory", "view");
  const canAddEnterpriseUser = enterpriseActionAllowed(
    enterpriseSnapshot,
    "enterprise_directory",
    "add_user",
  );
  const canSuspendEnterpriseUser = enterpriseActionAllowed(
    enterpriseSnapshot,
    "enterprise_directory",
    "suspend_user",
  );
  const canRestoreEnterpriseUser = enterpriseActionAllowed(
    enterpriseSnapshot,
    "enterprise_directory",
    "restore_user",
  );
  const canChangeEnterpriseRole = enterpriseActionAllowed(
    enterpriseSnapshot,
    "enterprise_directory",
    "change_role",
  );
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
      case "enterprise":
        return canViewEnterprise;
    }
  };
  const visibleTab: AdminTab = tabAllowed(activeTab)
    ? activeTab
    : ((
        ["members", "teams", "invitations", "audit", "integration", "enterprise"] as AdminTab[]
      ).find(tabAllowed) ?? "members");
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
        {loading && workspaces.length === 0 && !canViewEnterprise ? (
          <p className="card-empty">Loading workspaces…</p>
        ) : workspaces.length === 0 && !canViewEnterprise ? (
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
              {workspaces.length === 0 && (
                <p className="card-empty">No workspaces are visible to your memberships.</p>
              )}
              {canViewEnterprise && (
                <button
                  className={`admin-workspace${selectedId === undefined ? " active" : ""}`}
                  aria-current={selectedId === undefined ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(undefined);
                    setActiveTab("enterprise");
                  }}
                >
                  <span className="admin-workspace-name">Enterprise people</span>
                  <span className="admin-workspace-meta">
                    <span className="identity-badge">Directory</span>
                  </span>
                </button>
              )}
            </nav>
            {(workspace !== undefined || (canViewEnterprise && visibleTab === "enterprise")) && (
              <div className="admin-detail">
                <div className="admin-detail-heading">
                  <div>
                    <h3>{workspace?.name ?? "Enterprise people"}</h3>
                    <span className="identity-meta">
                      {workspace
                        ? `${workspace.repository.provider_type} · ${workspace.repository.repository_id} · Updated ${formatTimestamp(workspace.updated_at)}`
                        : "Enterprise directory, roles, enterprise-scoped suspension, and explicit workspace access."}
                    </span>
                  </div>
                  {workspace !== undefined && !canManage && (
                    <span className="identity-badge">Read-only</span>
                  )}
                </div>
                {workspace !== undefined && capabilities.status !== "ready" && (
                  <p className="identity-panel-status" role="status">
                    {capabilities.status === "error"
                      ? "The capability projection could not be read, so administration stays read-only."
                      : "Verifying workspace capabilities before showing administration…"}
                  </p>
                )}
                <div className="settings-tabs" role="tablist" aria-label="Workspace sections">
                  {workspace !== undefined && canViewMembers && (
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
                  {workspace !== undefined && canViewMembers && (
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
                  {workspace !== undefined && canInvite && (
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
                  {workspace !== undefined && enterpriseAdmin && (
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
                  {workspace !== undefined && canViewIntegration && (
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
                  {canViewEnterprise && (
                    <button
                      id="admin-tab-enterprise"
                      type="button"
                      role="tab"
                      className={`settings-tab${visibleTab === "enterprise" ? " active" : ""}`}
                      aria-selected={visibleTab === "enterprise"}
                      onClick={() => setActiveTab("enterprise")}
                    >
                      Enterprise people
                    </button>
                  )}
                </div>
                {workspace !== undefined &&
                  capabilities.status === "ready" &&
                  !tabAllowed("members") &&
                  !tabAllowed("invitations") &&
                  !tabAllowed("audit") &&
                  !tabAllowed("integration") &&
                  !tabAllowed("enterprise") && (
                    <p className="card-empty" role="status">
                      No administration module is available from the current capability projection.
                    </p>
                  )}
                {visibleTab === "enterprise" &&
                  canViewEnterprise &&
                  enterpriseCapabilities.status !== "ready" && (
                    <p className="identity-panel-status" role="status">
                      {enterpriseCapabilities.status === "error"
                        ? "The enterprise capability projection could not be read, so no directory data is shown."
                        : "Verifying enterprise capabilities before showing the directory…"}
                    </p>
                  )}
                <div
                  className="admin-panel-scroll"
                  id={`admin-panel-${visibleTab}`}
                  role="tabpanel"
                  aria-labelledby={`admin-tab-${visibleTab}`}
                >
                  {workspace !== undefined && visibleTab === "members" && canViewMembers && (
                    <MembersPanel
                      key={`members-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canManage={canManageMembers}
                      canManageRoles={canManageRoles}
                      canViewVerification={enterpriseAdmin && canManageMembers}
                    />
                  )}
                  {workspace !== undefined && visibleTab === "teams" && canViewMembers && (
                    <TeamsPanel
                      key={`teams-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                      canManage={canManageTeams}
                    />
                  )}
                  {workspace !== undefined && visibleTab === "invitations" && canInvite && (
                    <InvitationsPanel
                      key={`invitations-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                    />
                  )}
                  {workspace !== undefined && visibleTab === "audit" && enterpriseAdmin && (
                    <AuditPanel
                      key={`audit-${workspace.id}`}
                      client={client}
                      workspace={workspace}
                    />
                  )}
                  {workspace !== undefined &&
                    visibleTab === "integration" &&
                    canViewIntegration && (
                      <ServiceIntegrationPanel
                        key={`integration-${workspace.id}`}
                        client={client}
                        workspace={workspace}
                        canConfigure={canConfigureIntegration}
                      />
                    )}
                  {visibleTab === "enterprise" &&
                    canViewEnterprise &&
                    enterpriseId !== undefined && (
                      <EnterpriseUsersPanel
                        key={`enterprise-${enterpriseId}`}
                        client={client}
                        enterpriseId={enterpriseId}
                        workspaces={workspaces}
                        canAddUser={canAddEnterpriseUser}
                        canSuspendUser={canSuspendEnterpriseUser}
                        canRestoreUser={canRestoreEnterpriseUser}
                        canChangeRole={canChangeEnterpriseRole}
                        canGrantWorkspace={canViewEnterprise}
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
