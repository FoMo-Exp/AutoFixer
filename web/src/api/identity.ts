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
export type WorkspaceRole = Workspace["role"];
export type MembershipRole = Membership["role"];
export type InvitationStatus = Invitation["status"];

export type WorkspacePage =
  operations["listWorkspaces"]["responses"][200]["content"]["application/json"];
export type MembershipPage =
  operations["listWorkspaceMembers"]["responses"][200]["content"]["application/json"];
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
export type UpdateTeamBody =
  operations["updateWorkspaceTeam"]["requestBody"]["content"]["application/json"];
export type UpdateMemberBody =
  operations["updateWorkspaceMember"]["requestBody"]["content"]["application/json"];

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
