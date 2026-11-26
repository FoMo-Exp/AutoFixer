import { ApiTransport } from "./client";
import type { ApiTransportOptions } from "./client";
import type { components, operations } from "./contracts/schema";

/**
 * The identity/workspace surface of `forgepilot-api/v1` (DAT-205 contract,
 * OpenAPI 0.7.0). Every path, parameter, request body, and response type below
 * is taken from the generated schema; no field is invented.
 *
 * Invitation tokens are bearer credentials: they travel only in a POST body
 * (`previewInvitation`, `redeemInvitation`) and only the create response ever
 * returns one. No list endpoint here can read a token back.
 */

export type SessionInfo = components["schemas"]["SessionInfo"];
/** The renderer-safe projection used for role gating: no CSRF token. */
export type WorkspaceSession = Pick<SessionInfo, "user" | "enterprise_roles" | "memberships">;
export type Workspace = components["schemas"]["Workspace"];
export type Membership = components["schemas"]["Membership"];
export type MemberAuthority = components["schemas"]["MemberAuthority"];
export type Team = components["schemas"]["Team"];
export type Invitation = components["schemas"]["Invitation"];
export type CreatedInvitation = components["schemas"]["CreatedInvitation"];
export type InvitationPreview = components["schemas"]["InvitationPreview"];
export type InvitationRedemption = components["schemas"]["InvitationRedemption"];
export type AuthAuditRecord = components["schemas"]["AuthAuditRecord"];
export type LoginProvider = components["schemas"]["LoginProvider"];
export type ServiceIntegration = components["schemas"]["ServiceIntegration"];
export type WorkspaceCapabilityProjection = components["schemas"]["WorkspaceCapabilityProjection"];
export type ServiceIntegrationStatus = ServiceIntegration["install_status"];
export type ServicePermissionVisibility = ServiceIntegration["permission_visibility"];
export type WorkspaceRole = Workspace["role"];
export type MembershipRole = Membership["role"];
export type InvitationStatus = Invitation["status"];

export type EnterpriseUser = components["schemas"]["EnterpriseUser"];
export type EnterpriseUserStatus = EnterpriseUser["status"];
export type EnterpriseUserRole = EnterpriseUser["role"];
export type MemberCandidate = components["schemas"]["MemberCandidate"];
export type MemberCapabilityCeiling = components["schemas"]["MemberCapabilityCeiling"];
export type MemberCapabilityCeilingView = components["schemas"]["MemberCapabilityCeilingView"];
export type EnterpriseCapabilityProjection =
  components["schemas"]["EnterpriseCapabilityProjection"];

export type RepositorySetAdditionRepository =
  components["schemas"]["RepositorySetAdditionRepository"];
export type RepositorySetAdditionPreview = components["schemas"]["RepositorySetAdditionPreview"];
export type RepositorySetAdditionPreviewMember =
  components["schemas"]["RepositorySetAdditionPreviewMember"];
export type RepositorySetAdditionPreviewOwner =
  components["schemas"]["RepositorySetAdditionPreviewOwner"];
export type ConfirmedReduction = components["schemas"]["ConfirmedReduction"];
export type RepositorySetAdditionConfirmation =
  components["schemas"]["RepositorySetAdditionConfirmation"];
export type RepositorySetAdditionConfirmationMember =
  components["schemas"]["RepositorySetAdditionConfirmationMember"];
export type RepositorySetAdditionCommitResult =
  components["schemas"]["RepositorySetAdditionCommitResult"];

export type WorkspacePage =
  operations["listWorkspaces"]["responses"][200]["content"]["application/json"];
export type MembershipPage =
  operations["listWorkspaceMembers"]["responses"][200]["content"]["application/json"];
export type EnterpriseUserPage =
  operations["listEnterpriseUsers"]["responses"][200]["content"]["application/json"];
export type MemberCandidatePage =
  operations["listMemberCandidates"]["responses"][200]["content"]["application/json"];
export type AddEnterpriseUserBody =
  operations["addEnterpriseUser"]["requestBody"]["content"]["application/json"];
export type CreatedEnterpriseUser =
  operations["addEnterpriseUser"]["responses"][201]["content"]["application/json"];
export type SetEnterpriseUserRoleBody =
  operations["setEnterpriseUserRole"]["requestBody"]["content"]["application/json"];
export type AddWorkspaceMemberBody =
  operations["addWorkspaceMember"]["requestBody"]["content"]["application/json"];
export type GrantWorkspaceMemberBody =
  operations["grantMembership"]["requestBody"]["content"]["application/json"];
export type ReapproveCapabilityCeilingBody =
  operations["reapproveMemberCapabilityCeiling"]["requestBody"]["content"]["application/json"];
export type TeamPage =
  operations["listWorkspaceTeams"]["responses"][200]["content"]["application/json"];
export type InvitationPage =
  operations["listInvitations"]["responses"][200]["content"]["application/json"];
export type AuthAuditPage =
  operations["listAuthAudit"]["responses"][200]["content"]["application/json"];

export type CreateInvitationBody =
  operations["createInvitation"]["requestBody"]["content"]["application/json"];
export type CreateTeamBody =
  operations["createWorkspaceTeam"]["requestBody"]["content"]["application/json"];
export type CreateWorkspaceBody =
  operations["createWorkspace"]["requestBody"]["content"]["application/json"];
export type UpdateTeamBody =
  operations["updateWorkspaceTeam"]["requestBody"]["content"]["application/json"];
export type UpdateMemberBody =
  operations["updateWorkspaceMember"]["requestBody"]["content"]["application/json"];
export type InitializeServiceIntegrationBody =
  operations["initializeServiceIntegration"]["requestBody"]["content"]["application/json"];
export type RepositorySetAdditionPreviewBody =
  operations["previewRepositorySetAddition"]["requestBody"]["content"]["application/json"];
export type RepositorySetAdditionConfirmBody =
  operations["confirmRepositorySetAddition"]["requestBody"]["content"]["application/json"];

interface RequestOptions {
  signal?: AbortSignal;
}

export class IdentityClient extends ApiTransport {
  constructor(options: ApiTransportOptions) {
    super(options);
  }

  async getSession(options: RequestOptions = {}): Promise<SessionInfo> {
    return this.request<SessionInfo>("/api/v1/auth/session", { signal: options.signal });
  }

  async listLoginProviders(options: RequestOptions = {}): Promise<LoginProvider[]> {
    const page = await this.request<{ items: LoginProvider[] }>("/api/v1/auth/providers", {
      signal: options.signal,
    });
    return page.items;
  }

  async listWorkspaces(cursor?: string, options: RequestOptions = {}): Promise<WorkspacePage> {
    return this.request<WorkspacePage>(`/api/v1/workspaces${cursorQuery(cursor)}`, {
      signal: options.signal,
    });
  }

  async createWorkspace(
    body: CreateWorkspaceBody,
    options: RequestOptions = {},
  ): Promise<Workspace> {
    return this.request<Workspace>("/api/v1/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  /**
   * Every workspace the caller's live memberships grant. The switcher must see
   * the complete set, so every page is read; a repeated cursor ends the walk
   * instead of looping on a malformed server response.
   */
  async listAllWorkspaces(options: RequestOptions = {}): Promise<Workspace[]> {
    const workspaces: Workspace[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listWorkspaces(cursor, options);
      workspaces.push(...page.items);
      const next = page.next_cursor ?? undefined;
      // A cursor that repeats a page already read ends the walk instead of
      // looping on a malformed server response.
      if (next === undefined || seenCursors.has(next)) return workspaces;
      seenCursors.add(next);
      cursor = next;
    }
  }

  async listWorkspaceMembers(
    workspaceId: string,
    cursor?: string,
    options: RequestOptions = {},
  ): Promise<MembershipPage> {
    return this.request<MembershipPage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members${cursorQuery(cursor)}`,
      { signal: options.signal },
    );
  }

  async updateWorkspaceMember(
    workspaceId: string,
    membershipId: string,
    body: UpdateMemberBody,
    options: RequestOptions = {},
  ): Promise<Membership> {
    return this.request<Membership>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  async removeWorkspaceMember(
    workspaceId: string,
    membershipId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    return this.requestNoContent(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  async listWorkspaceTeams(
    workspaceId: string,
    cursor?: string,
    options: RequestOptions = {},
  ): Promise<TeamPage> {
    return this.request<TeamPage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams${cursorQuery(cursor)}`,
      { signal: options.signal },
    );
  }

  /** Every team page; team leadership gating must not stop at the first page. */
  async listAllWorkspaceTeams(workspaceId: string, options: RequestOptions = {}): Promise<Team[]> {
    const teams: Team[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listWorkspaceTeams(workspaceId, cursor, options);
      teams.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return teams;
  }

  async createWorkspaceTeam(
    workspaceId: string,
    body: CreateTeamBody,
    options: RequestOptions = {},
  ): Promise<Team> {
    return this.request<Team>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  async updateWorkspaceTeam(
    workspaceId: string,
    teamId: string,
    body: UpdateTeamBody,
    options: RequestOptions = {},
  ): Promise<Team> {
    return this.request<Team>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  async deleteWorkspaceTeam(
    workspaceId: string,
    teamId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    return this.requestNoContent(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(teamId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  /**
   * Session-scoped capability projection for one workspace (DAT-278). This is
   * the only source for module-entry and action gating; the response is
   * validated by `capabilities/projection.ts` before any decision.
   */
  async getWorkspaceCapabilities(
    workspaceId: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceCapabilityProjection> {
    return this.request<WorkspaceCapabilityProjection>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities`,
      { signal: options.signal },
    );
  }

  /**
   * Session-scoped enterprise projection (DAT-278). It is the only source for
   * the enterprise-directory entry and its per-action decisions; the response
   * is validated by `capabilities/enterprise.ts` before any decision.
   */
  async getEnterpriseCapabilities(
    enterpriseId: string,
    options: RequestOptions = {},
  ): Promise<EnterpriseCapabilityProjection> {
    return this.request<EnterpriseCapabilityProjection>(
      `/api/v1/enterprises/${encodeURIComponent(enterpriseId)}/capabilities`,
      { signal: options.signal },
    );
  }

  async listEnterpriseUsers(
    enterpriseId: string,
    filters: { status?: EnterpriseUserStatus; cursor?: string } = {},
    options: RequestOptions = {},
  ): Promise<EnterpriseUserPage> {
    const params = new URLSearchParams();
    if (filters.status !== undefined) params.set("status", filters.status);
    if (filters.cursor !== undefined) params.set("cursor", filters.cursor);
    const query = params.toString();
    return this.request<EnterpriseUserPage>(
      `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/users${query ? `?${query}` : ""}`,
      { signal: options.signal },
    );
  }

  async addEnterpriseUser(
    enterpriseId: string,
    body: AddEnterpriseUserBody,
    options: RequestOptions = {},
  ): Promise<CreatedEnterpriseUser> {
    return this.request<CreatedEnterpriseUser>(
      `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/users`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  /** Enterprise-scoped suspension; the global account is never changed. */
  async setEnterpriseUserStatus(
    enterpriseId: string,
    enterpriseUserId: string,
    status: "active" | "suspended",
    version: number,
    options: RequestOptions = {},
  ): Promise<EnterpriseUser> {
    const action = status === "suspended" ? "suspend" : "restore";
    return this.request<EnterpriseUser>(
      `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/users/${encodeURIComponent(enterpriseUserId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
        signal: options.signal,
      },
    );
  }

  async setEnterpriseUserRole(
    enterpriseId: string,
    enterpriseUserId: string,
    body: SetEnterpriseUserRoleBody,
    options: RequestOptions = {},
  ): Promise<EnterpriseUser> {
    return this.request<EnterpriseUser>(
      `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/users/${encodeURIComponent(enterpriseUserId)}/role`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  async listMemberCandidates(
    workspaceId: string,
    cursor?: string,
    options: RequestOptions = {},
  ): Promise<MemberCandidatePage> {
    return this.request<MemberCandidatePage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/member-candidates${cursorQuery(cursor)}`,
      { signal: options.signal },
    );
  }

  async addWorkspaceMember(
    workspaceId: string,
    body: AddWorkspaceMemberBody,
    options: RequestOptions = {},
  ): Promise<Membership> {
    return this.request<Membership>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  /**
   * Enterprise-administrator grant of one workspace membership. The caller
   * chooses the workspace explicitly; the service still enforces repository
   * verification, the capability ceiling and the last-owner rule.
   */
  async grantWorkspaceMember(
    enterpriseId: string,
    workspaceId: string,
    userId: string,
    body: GrantWorkspaceMemberBody,
    options: RequestOptions = {},
  ): Promise<Membership> {
    return this.request<Membership>(
      `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  async getMemberCapability(
    enterpriseId: string,
    workspaceId: string,
    userId: string,
    options: RequestOptions = {},
  ): Promise<MemberCapabilityCeilingView> {
    return this.request<MemberCapabilityCeilingView>(
      memberCapabilityPath(enterpriseId, workspaceId, userId),
      { signal: options.signal },
    );
  }

  /** Audited reapproval inside the current verified intersection. */
  async reapproveMemberCapability(
    enterpriseId: string,
    workspaceId: string,
    userId: string,
    body: ReapproveCapabilityCeilingBody,
    options: RequestOptions = {},
  ): Promise<MemberCapabilityCeiling> {
    return this.request<MemberCapabilityCeiling>(
      memberCapabilityPath(enterpriseId, workspaceId, userId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  async listInvitations(
    workspaceId: string,
    cursor?: string,
    options: RequestOptions = {},
  ): Promise<InvitationPage> {
    return this.request<InvitationPage>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations${cursorQuery(cursor)}`,
      { signal: options.signal },
    );
  }

  async createInvitation(
    workspaceId: string,
    body: CreateInvitationBody,
    options: RequestOptions = {},
  ): Promise<CreatedInvitation> {
    return this.request<CreatedInvitation>(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  async revokeInvitation(
    workspaceId: string,
    invitationId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    return this.requestNoContent(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  /** Non-consuming eligibility check. The token stays in the POST body. */
  async previewInvitation(token: string, options: RequestOptions = {}): Promise<InvitationPreview> {
    return this.request<InvitationPreview>("/api/v1/invitations/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: options.signal,
    });
  }

  /** The explicit join confirmation; consumes the invitation atomically. */
  async redeemInvitation(
    token: string,
    options: RequestOptions = {},
  ): Promise<InvitationRedemption> {
    return this.request<InvitationRedemption>("/api/v1/invitations/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: options.signal,
    });
  }

  async listAuthAudit(
    enterpriseId: string,
    limit?: number,
    options: RequestOptions = {},
  ): Promise<AuthAuditPage> {
    const query = limit === undefined ? "" : `?${new URLSearchParams({ limit: String(limit) })}`;
    return this.request<AuthAuditPage>(
      `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/auth-audit${query}`,
      { signal: options.signal },
    );
  }

  /**
   * The workspace's active integration. A 404 `SERVICE_INTEGRATION_NOT_FOUND`
   * means no active integration — after deactivation the uninstalled row keeps
   * the workspace failing closed but is not readable here.
   */
  async getServiceIntegration(
    enterpriseId: string,
    workspaceId: string,
    options: RequestOptions = {},
  ): Promise<ServiceIntegration> {
    return this.request<ServiceIntegration>(serviceIntegrationPath(enterpriseId, workspaceId), {
      signal: options.signal,
    });
  }

  /** Administrator-only, replay-safe: an identical retry returns the same row. */
  async initializeServiceIntegration(
    enterpriseId: string,
    workspaceId: string,
    body: InitializeServiceIntegrationBody,
    options: RequestOptions = {},
  ): Promise<ServiceIntegration> {
    return this.request<ServiceIntegration>(serviceIntegrationPath(enterpriseId, workspaceId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  /** Idempotent; leaves the fail-closed authority marker in place. */
  async deactivateServiceIntegration(
    enterpriseId: string,
    workspaceId: string,
    options: RequestOptions = {},
  ): Promise<void> {
    return this.requestNoContent(serviceIntegrationPath(enterpriseId, workspaceId), {
      method: "DELETE",
      signal: options.signal,
    });
  }

  /**
   * The full-set member impact of adding repositories. It writes nothing and
   * never authorizes access; a caller who cannot see the whole impact is
   * refused instead of shown a redacted preview.
   */
  async previewRepositorySetAddition(
    workspaceId: string,
    body: RepositorySetAdditionPreviewBody,
    options: RequestOptions = {},
  ): Promise<RepositorySetAdditionPreview> {
    return this.request<RepositorySetAdditionPreview>(
      `${repositorySetAdditionsPath(workspaceId)}/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  /**
   * Records the actor-bound, expiring confirmation of exactly this previewed
   * impact. No binding is written: a confirmation is evidence of a decision.
   */
  async confirmRepositorySetAddition(
    workspaceId: string,
    body: RepositorySetAdditionConfirmBody,
    options: RequestOptions = {},
  ): Promise<RepositorySetAdditionConfirmation> {
    return this.request<RepositorySetAdditionConfirmation>(
      `${repositorySetAdditionsPath(workspaceId)}/confirmations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
  }

  /**
   * Commits one confirmed addition atomically. A conflict, expiry or changed
   * fact refuses the whole change, so a stale confirmation never commits.
   */
  async commitRepositorySetAddition(
    workspaceId: string,
    confirmationId: string,
    options: RequestOptions = {},
  ): Promise<RepositorySetAdditionCommitResult> {
    return this.request<RepositorySetAdditionCommitResult>(
      `${repositorySetAdditionsPath(workspaceId)}/confirmations/${encodeURIComponent(confirmationId)}/commit`,
      { method: "POST", signal: options.signal },
    );
  }

  /**
   * Absolute sign-in URL on the configured API origin. The workbench and a
   * loopback API may live on different origins; a relative `/api/v1/auth/login`
   * would navigate the renderer's origin and never reach the auth service.
   * `return_to` stays a relative same-deployment path.
   */
  loginUrl(providerInstanceId: string, returnTo = "/"): string {
    const params = new URLSearchParams({
      provider_instance_id: providerInstanceId,
      return_to: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/",
    });
    return `${this.baseUrl}/api/v1/auth/login?${params.toString()}`;
  }
}

function cursorQuery(cursor?: string): string {
  return cursor ? `?${new URLSearchParams({ cursor })}` : "";
}

function serviceIntegrationPath(enterpriseId: string, workspaceId: string): string {
  return `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/workspaces/${encodeURIComponent(workspaceId)}/service-integration`;
}

function repositorySetAdditionsPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/repository-set-additions`;
}

function memberCapabilityPath(enterpriseId: string, workspaceId: string, userId: string): string {
  return `/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/capability-ceiling`;
}
