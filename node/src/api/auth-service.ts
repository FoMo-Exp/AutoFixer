import { lookup as dnsLookup } from "node:dns/promises";

import { hashToken, secretEquals } from "../control-plane/identity-repositories.js";
import { SYSTEM_ACTOR } from "../control-plane/db.js";
import type {
  AppUser,
  AuthAuditRecord,
  AuthSession,
  CreateSessionInput,
  EnterpriseUser,
  EnterpriseUserActor,
  EnterpriseUserStatus,
  IdentityRepositories,
  LoginProvider,
  SessionKind,
  UserStatus,
  CreateWorkspaceInput,
} from "../control-plane/index.js";
import type {
  ControlPlaneRepositories,
  EnterpriseId,
  Membership,
  ProviderInstance,
  ProviderType,
  UserId,
  Workspace,
  WorkspaceId,
  WorkspaceRole,
} from "../control-plane/index.js";
import type {
  CapabilityCeilingService,
  CapabilityCeilingView,
} from "../provider-access/capability-ceiling.js";
import type {
  MemberCapabilityCeiling,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import { ApiError } from "./errors.js";
import {
  ProviderError,
  ProviderOAuth,
  providerAdapters,
  pkcePair,
  randomUrlSecret,
} from "./oauth.js";
import type { OAuthCredentialsByOrigin, ProviderProfile } from "./oauth.js";
import { assertPublicResolution, normalizeProviderOrigin } from "./provider-origin.js";
import type { OriginDnsLookup } from "./provider-origin.js";
import { mintSessionSecrets } from "./sessions.js";
import {
  InvalidRepositoryIdError,
  parseCanonicalRepositoryId,
} from "../provider-access/canonical-repository.js";

/**
 * Identity, session, and administrator-bootstrap domain service.
 *
 * Authorization rules implemented here:
 * - Accounts are matched only by (provider instance, stable subject); a
 *   profile email or login never merges two identities.
 * - The first enterprise administrator is granted through the
 *   deployment-owned bootstrap token, named by provider identity, audited,
 *   and only once — an ordinary login never becomes an administrator and the
 *   bootstrap cannot be captured by whoever signs in first.
 * - Enterprise membership is its own enterprise-scoped fact (DAT-275): an
 *   administrator adds an approved (provider instance, stable subject) and a
 *   matching login claims it once. Login alone never enrolls anyone, and a
 *   suspended membership blocks every enterprise-scoped request and stream
 *   without affecting another enterprise or the global account.
 * - Logout, global suspension, enterprise membership suspension, and
 *   membership revocation revoke sessions or emit invalidation events so live
 *   SSE subscriptions close immediately.
 */

/** Re-exported for the administrator surfaces that share the deployment actor. */
export { SYSTEM_ACTOR };

export interface AuthServiceConfig {
  /** Enterprise and workspace the task API surface is scoped to. */
  enterpriseId: EnterpriseId;
  workspaceId: WorkspaceId;
  sessionTtlSeconds: number;
  oauthFlowTtlSeconds: number;
  desktopFlowTtlSeconds: number;
  /** Deployment-owned bootstrap secret; unset disables bootstrap. */
  bootstrapToken?: string;
  /** Failed desktop-exchange attempts tolerated per flow. */
  desktopMaxAttempts: number;
}

export interface AuthServiceDeps {
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  config: AuthServiceConfig;
  credentials: OAuthCredentialsByOrigin;
  providerOAuth?: ProviderOAuth;
  lookup?: OriginDnsLookup;
  /**
   * Verified repository capability ceilings (DAT-276). When present, the
   * administrator reapproval surface and the member ceiling view are served;
   * without it those routes stay nonexistent rather than unaudited.
   */
  capabilityCeilings?: CapabilityCeilingService;
}

// ---------------------------------------------------------------------------
// Invalidation events (SSE subscriptions react to these)
// ---------------------------------------------------------------------------

export type AuthInvalidation =
  | { type: "session.revoked"; session_id: string; user_id: string }
  | { type: "user.suspended"; user_id: string }
  | { type: "membership.revoked"; user_id: string; workspace_id: string }
  | {
      /** Enterprise-scoped suspension/restoration; other enterprises unchanged. */
      type: "enterprise_user.status_changed";
      enterprise_id: string;
      user_id: string;
      status: EnterpriseUserStatus;
    };

export type AuthInvalidationListener = (event: AuthInvalidation) => void;

export class AuthEventHub {
  readonly #listeners = new Set<AuthInvalidationListener>();

  subscribe(listener: AuthInvalidationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: AuthInvalidation): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Views and actors
// ---------------------------------------------------------------------------

export interface UserView {
  id: string;
  display_name: string;
  status: UserStatus;
}

export interface LoginProviderView {
  provider_instance_id: string;
  provider_type: ProviderType;
  display_origin: string;
}

/** One workspace the caller holds a live membership in (DAT-244). */
export interface WorkspaceView {
  id: string;
  enterprise_id: string;
  name: string;
  status: Workspace["status"];
  repository: { repository_id: string; provider_instance_id: string; provider_type: ProviderType };
  role: WorkspaceRole;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspacePage {
  items: WorkspaceView[];
  next_cursor: string | null;
}

export interface StartLoginResult {
  authorization_url: string;
  /** Browser-binding secret; delivered as the OAuth binding cookie. */
  binding: string;
}

export type LoginCompletion =
  | {
      kind: "web";
      token: string;
      csrf_token: string;
      max_age_seconds: number;
      return_to: string;
      user: UserView;
    }
  | { kind: "desktop"; desktop_flow_id: string; return_to: string; user: UserView };

export interface DesktopFlowCreated {
  flow_id: string;
  /** Single-use desktop-held secret; returned exactly once. */
  secret: string;
  login_url: string;
  expires_at: string;
}

export type DesktopExchange =
  | { status: "ok"; token: string; csrf_token: string; expires_at: string; user: UserView }
  | { status: "pending" }
  | { status: "expired" }
  | { status: "consumed" };

export interface EnterpriseMembershipView {
  enterprise_id: string;
  status: EnterpriseUserStatus;
  role: "admin" | "member";
  version: number;
}

export interface SessionInfo {
  user: UserView;
  kind: SessionKind;
  csrf_token: string;
  expires_at: string;
  enterprise_roles: Array<{ enterprise_id: string; role: string }>;
  memberships: Array<{ enterprise_id: string; workspace_id: string; role: string }>;
  /** The deployment enterprise's membership; null for a pure login. */
  enterprise_membership: EnterpriseMembershipView | null;
}

/** Administrator view of one enterprise user (DAT-275). */
export interface EnterpriseUserView {
  id: string;
  enterprise_id: string;
  user_id: string | null;
  status: EnterpriseUserStatus;
  role: "admin" | "member";
  provider_instance_id: string;
  provider_type: ProviderType;
  subject: string;
  display_name: string | null;
  login: string | null;
  claimed_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface EnterpriseUserPageView {
  items: EnterpriseUserView[];
  next_cursor: string | null;
}

export interface AddEnterpriseUserRequest {
  enterprise_id: EnterpriseId;
  provider_instance_id: string;
  subject: string;
}

export interface SessionContext {
  session: AuthSession;
  user: AppUser;
}

/** Who performs an administrative action. */
export type AdminActor = { kind: "deployment" } | { kind: "user"; user_id: UserId };

export interface BootstrapAdminInput {
  enterprise_id: EnterpriseId;
  provider_instance_id: string;
  subject: string;
}

export interface BootstrapAdminResult {
  enterprise_id: EnterpriseId;
  user_id: UserId;
  role: "admin";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AuthService {
  readonly hub = new AuthEventHub();
  readonly #repos: ControlPlaneRepositories;
  readonly #identity: IdentityRepositories;
  readonly #config: AuthServiceConfig;
  readonly #credentials: OAuthCredentialsByOrigin;
  readonly #oauth: ProviderOAuth;
  readonly #lookup: OriginDnsLookup;
  readonly #capabilityCeilings: CapabilityCeilingService | undefined;

  constructor(deps: AuthServiceDeps) {
    this.#repos = deps.repos;
    this.#identity = deps.identity;
    this.#config = deps.config;
    this.#credentials = deps.credentials;
    this.#capabilityCeilings = deps.capabilityCeilings;
    this.#oauth = deps.providerOAuth ?? new ProviderOAuth();
    this.#lookup =
      deps.lookup ??
      (async (hostname) =>
        (await dnsLookup(hostname, { all: true })).map((entry) => entry.address));
  }

  // -------------------------------------------------------------------------
  // Login surface
  // -------------------------------------------------------------------------

  /** Approved provider instances that have configured OAuth credentials. */
  listLoginProviders(): LoginProviderView[] {
    return this.#identity.loginProviders
      .list()
      .filter((provider) => this.#credentials.has(provider.origin_url))
      .map((provider) => ({
        provider_instance_id: provider.id,
        provider_type: provider.provider_type,
        display_origin: provider.origin_url,
      }));
  }

  startLogin(input: {
    providerInstanceId: string;
    requestOrigin: string;
    returnTo?: string;
    desktopFlowId?: string;
  }): StartLoginResult {
    const provider = this.#requireLoginProvider(input.providerInstanceId);
    const credentials = this.#credentials.get(provider.origin_url);
    if (credentials === undefined) {
      throw new ApiError(400, "INVALID_REQUEST", "login is not configured for this provider");
    }
    let desktopFlowId: string | undefined;
    if (input.desktopFlowId !== undefined) {
      const flow = this.#identity.desktopFlows.getById(input.desktopFlowId);
      if (flow === undefined || flow.status !== "pending" || this.#expired(flow.expires_at)) {
        throw new ApiError(410, "AUTH_FLOW_EXPIRED", "desktop auth flow is not startable");
      }
      desktopFlowId = flow.id;
    }
    const state = randomUrlSecret(32);
    const binding = randomUrlSecret(32);
    const { verifier, challenge } = pkcePair();
    const redirectUri = `${input.requestOrigin}/api/v1/auth/callback`;
    this.#identity.oauthFlows.create({
      kind: desktopFlowId !== undefined ? "desktop" : "web",
      provider_instance_id: provider.id,
      state_hash: hashToken(state),
      binding_hash: hashToken(binding),
      pkce_verifier: verifier,
      redirect_uri: redirectUri,
      return_to: sanitizeReturnTo(input.returnTo),
      ...(desktopFlowId !== undefined ? { desktop_flow_id: desktopFlowId } : {}),
      expires_at: new Date(Date.now() + this.#config.oauthFlowTtlSeconds * 1000).toISOString(),
    });
    this.#audit({
      event: "login.started",
      enterprise_id: provider.enterprise_id,
      actor_kind: "anonymous",
      provider_instance_id: provider.id,
    });
    return {
      authorization_url: providerAdapters[provider.provider_type].authorizeUrl({
        origin: provider.origin_url,
        clientId: credentials.client_id,
        redirectUri,
        state,
        codeChallenge: challenge,
      }),
      binding,
    };
  }

  async completeLogin(input: {
    code: string;
    state: string;
    binding: string | undefined;
    requestOrigin: string;
    userAgent?: string;
  }): Promise<LoginCompletion> {
    const flow = this.#identity.oauthFlows.findByStateHash(hashToken(input.state));
    if (flow === undefined) {
      this.#audit({
        event: "login.rejected",
        actor_kind: "anonymous",
        details: { reason: "unknown_state" },
      });
      throw new ApiError(400, "AUTH_FLOW_INVALID", "authorization callback is not valid");
    }
    // Login-CSRF defense: the flow must belong to the browser completing it.
    const bindingDigest = hashToken(input.binding ?? "");
    if (!secretEquals(bindingDigest, flow.binding_hash)) {
      this.#audit({
        event: "login.rejected",
        actor_kind: "anonymous",
        details: { reason: "binding_mismatch" },
      });
      throw new ApiError(403, "FORBIDDEN", "authorization callback is not bound to this browser");
    }
    if (this.#expired(flow.expires_at)) {
      this.#identity.oauthFlows.consume(flow.id);
      throw new ApiError(410, "AUTH_FLOW_EXPIRED", "authorization flow has expired");
    }
    // Single-use: exactly one callback may consume a flow.
    if (!this.#identity.oauthFlows.consume(flow.id)) {
      this.#audit({
        event: "login.rejected",
        actor_kind: "anonymous",
        details: { reason: "replay" },
      });
      throw new ApiError(410, "AUTH_FLOW_CONSUMED", "authorization callback was already used");
    }
    const provider = this.#identity.loginProviders.get(flow.provider_instance_id);
    const credentials =
      provider !== undefined ? this.#credentials.get(provider.origin_url) : undefined;
    if (provider === undefined || credentials === undefined) {
      throw new ApiError(
        502,
        "PROVIDER_ERROR",
        "login provider is no longer configured",
        {},
        { retryable: true },
      );
    }
    let profile: ProviderProfile;
    try {
      const adapter = providerAdapters[provider.provider_type];
      const accessToken = await this.#oauth.exchangeCode({
        adapter,
        origin: provider.origin_url,
        credentials,
        code: input.code,
        redirectUri: flow.redirect_uri,
        codeVerifier: flow.pkce_verifier,
      });
      profile = await this.#oauth.fetchProfile({
        adapter,
        origin: provider.origin_url,
        accessToken,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (error instanceof ProviderError) {
        this.#audit({
          event: "login.rejected",
          actor_kind: "anonymous",
          provider_instance_id: provider.id,
          details: { reason: "provider_error" },
        });
        throw new ApiError(502, "PROVIDER_ERROR", error.message, {}, { retryable: true });
      }
      throw error;
    }

    const user = this.#resolveOrCreateUser(provider, profile);
    if (user.status === "suspended") {
      this.#audit({
        event: "login.rejected",
        actor_kind: "user",
        actor_user_id: user.id,
        provider_instance_id: provider.id,
        details: { reason: "suspended" },
      });
      throw new ApiError(403, "FORBIDDEN", "this account is suspended");
    }

    // Claim any administrator-added membership whose binding matches this
    // exact (provider instance, stable subject). Login proves the identity; it
    // never creates enterprise membership on its own, and a suspended
    // membership is claimed but stays suspended.
    this.#identity.enterpriseUsers.claim(provider.id, profile.subject, user.id);

    if (flow.kind === "desktop") {
      const desktopFlowId = flow.desktop_flow_id ?? "";
      try {
        this.#identity.desktopFlows.markReady(desktopFlowId, user.id);
      } catch {
        throw new ApiError(410, "AUTH_FLOW_CONSUMED", "desktop auth flow is no longer open");
      }
      this.#audit({
        event: "login.completed",
        actor_kind: "user",
        actor_user_id: user.id,
        provider_instance_id: provider.id,
        details: { kind: "desktop", desktop_flow_id: desktopFlowId },
      });
      return {
        kind: "desktop",
        desktop_flow_id: desktopFlowId,
        return_to: flow.return_to,
        user: { id: user.id, display_name: user.display_name, status: user.status },
      };
    }

    const session = this.#createSession({
      user_id: user.id,
      kind: "web",
      ...(input.userAgent !== undefined ? { user_agent: input.userAgent } : {}),
    });
    this.#audit({
      event: "login.completed",
      actor_kind: "user",
      actor_user_id: user.id,
      provider_instance_id: provider.id,
      details: { kind: "web" },
    });
    return {
      kind: "web",
      token: session.token,
      csrf_token: session.csrf_token,
      max_age_seconds: this.#config.sessionTtlSeconds,
      return_to: flow.return_to,
      user: { id: user.id, display_name: user.display_name, status: user.status },
    };
  }

  // -------------------------------------------------------------------------
  // Desktop system-browser flow
  // -------------------------------------------------------------------------

  createDesktopFlow(input: {
    requestOrigin: string;
    providerInstanceId?: string;
  }): DesktopFlowCreated {
    const secret = randomUrlSecret(32);
    const flow = this.#identity.desktopFlows.create({
      secret_hash: hashToken(secret),
      expires_at: new Date(Date.now() + this.#config.desktopFlowTtlSeconds * 1000).toISOString(),
    });
    const providerParam =
      input.providerInstanceId !== undefined
        ? `&provider_instance_id=${encodeURIComponent(input.providerInstanceId)}`
        : "";
    this.#audit({
      event: "desktop_flow.created",
      actor_kind: "anonymous",
      details: { flow_id: flow.id },
    });
    return {
      flow_id: flow.id,
      secret,
      login_url: `${input.requestOrigin}/api/v1/auth/login?desktop_flow=${flow.id}${providerParam}`,
      expires_at: flow.expires_at,
    };
  }

  exchangeDesktopFlow(input: { flowId: string; secret: string }): DesktopExchange {
    const flow = this.#identity.desktopFlows.getById(input.flowId);
    if (flow === undefined) {
      throw new ApiError(400, "AUTH_FLOW_INVALID", "desktop auth flow is not valid");
    }
    if (flow.attempts >= this.#config.desktopMaxAttempts) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "too many exchange attempts",
        {},
        { retryable: true },
      );
    }
    if (!secretEquals(hashToken(input.secret), flow.secret_hash)) {
      this.#identity.desktopFlows.recordFailedAttempt(flow.id);
      this.#audit({
        event: "login.rejected",
        actor_kind: "anonymous",
        details: { reason: "desktop_secret_mismatch", flow_id: flow.id },
      });
      throw new ApiError(401, "UNAUTHENTICATED", "desktop auth flow secret is not valid");
    }
    if (flow.status === "consumed") {
      throw new ApiError(410, "AUTH_FLOW_CONSUMED", "desktop auth flow was already exchanged");
    }
    if (this.#expired(flow.expires_at)) {
      throw new ApiError(410, "AUTH_FLOW_EXPIRED", "desktop auth flow has expired");
    }
    if (flow.status !== "ready" || flow.user_id === null) {
      return { status: "pending" };
    }
    // Single-use: exactly one exchange may consume the flow.
    if (!this.#identity.desktopFlows.consume(flow.id)) {
      throw new ApiError(410, "AUTH_FLOW_CONSUMED", "desktop auth flow was already exchanged");
    }
    const user = this.#identity.users.getById(flow.user_id);
    if (user === undefined || user.status !== "active") {
      this.#audit({
        event: "login.rejected",
        actor_kind: "user",
        ...(user !== undefined ? { actor_user_id: user.id } : {}),
        details: { reason: "suspended" },
      });
      throw new ApiError(403, "FORBIDDEN", "this account is suspended");
    }
    const session = this.#createSession({ user_id: user.id, kind: "desktop" });
    this.#audit({
      event: "desktop_flow.consumed",
      actor_kind: "user",
      actor_user_id: user.id,
      details: { flow_id: flow.id },
    });
    return {
      status: "ok",
      token: session.token,
      csrf_token: session.csrf_token,
      expires_at: session.expires_at,
      user: { id: user.id, display_name: user.display_name, status: user.status },
    };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  resolveSession(token: string | undefined): SessionContext | undefined {
    if (token === undefined || token.length === 0) {
      return undefined;
    }
    const session = this.#identity.sessions.findByTokenHash(hashToken(token));
    if (session === undefined || session.revoked_at !== null || this.#expired(session.expires_at)) {
      return undefined;
    }
    const user = this.#identity.users.getById(session.user_id);
    if (user === undefined || user.status !== "active") {
      return undefined;
    }
    return { session, user };
  }

  sessionInfo(ctx: SessionContext): SessionInfo {
    const memberships = this.#repos.memberships.listForUser(
      { enterprise_id: this.#config.enterpriseId, actor_id: ctx.user.id },
      ctx.user.id,
    );
    const enterpriseMembership = this.#enterpriseMembershipView(ctx.user.id);
    return {
      user: { id: ctx.user.id, display_name: ctx.user.display_name, status: ctx.user.status },
      kind: ctx.session.kind,
      csrf_token: ctx.session.csrf_token,
      expires_at: ctx.session.expires_at,
      enterprise_roles: this.#identity.enterpriseRoles
        .listByUser(ctx.user.id)
        .filter((role) => role.enterprise_id === this.#config.enterpriseId)
        .map((role) => ({ enterprise_id: role.enterprise_id, role: role.role })),
      memberships: memberships.map((membership) => ({
        enterprise_id: membership.enterprise_id,
        workspace_id: membership.workspace_id,
        role: membership.role,
      })),
      enterprise_membership: enterpriseMembership,
    };
  }

  /**
   * Authoritative enterprise membership for one person, if any. The row's
   * status (not a login, identity, or role) is the enterprise-access fact.
   */
  enterpriseMembership(userId: UserId, enterpriseId: EnterpriseId = this.#config.enterpriseId) {
    return this.#identity.enterpriseUsers.getByUser(enterpriseId, userId);
  }

  /**
   * Enterprise-authorization gate for an authenticated session. A missing or
   * suspended membership fails closed with distinct safe codes so the client
   * can explain the state without learning another tenant's data.
   */
  assertEnterpriseActive(
    userId: UserId,
    enterpriseId: EnterpriseId = this.#config.enterpriseId,
  ): EnterpriseUser {
    const membership = this.#identity.enterpriseUsers.getByUser(enterpriseId, userId);
    if (membership === undefined) {
      throw new ApiError(
        403,
        "ENTERPRISE_MEMBERSHIP_REQUIRED",
        "an active enterprise membership is required",
      );
    }
    if (membership.status !== "active") {
      throw new ApiError(
        403,
        "ENTERPRISE_MEMBERSHIP_SUSPENDED",
        "this enterprise membership is suspended",
      );
    }
    return membership;
  }

  logout(sessionId: string, userId: string): void {
    this.#identity.sessions.revoke(sessionId, "logout");
    this.hub.emit({ type: "session.revoked", session_id: sessionId, user_id: userId });
    this.#audit({
      event: "session.revoked",
      actor_kind: "user",
      actor_user_id: userId,
      details: { reason: "logout" },
    });
  }

  /** Membership of `userId` in the task surface's workspace, if any. */
  workspaceRole(userId: UserId): WorkspaceRole | undefined {
    return this.#repos.memberships.getByUser(
      {
        enterprise_id: this.#config.enterpriseId,
        workspace_id: this.#config.workspaceId,
        actor_id: userId,
      },
      userId,
    )?.role;
  }

  /**
   * Resolve a live workspace access from the authenticated user and a path
   * workspace locator (DAT-244). The workspace id selects which membership
   * to evaluate; it never grants anything on its own. Unknown, archived,
   * cross-enterprise, and revoked memberships are all `undefined`, so the
   * HTTP surface can answer them with one indistinguishable 404.
   *
   * The membership and workspace are re-read on every call: revocation and
   * suspension take effect on the very next request.
   */
  workspaceAccess(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): { membership: Membership; workspace: Workspace } | undefined {
    const enterprise = this.#identity.enterpriseUsers.getByUser(this.#config.enterpriseId, userId);
    if (enterprise === undefined || enterprise.status !== "active") {
      return undefined;
    }
    const enterpriseScope = {
      enterprise_id: this.#config.enterpriseId,
      actor_id: userId,
    };
    const workspaceScope = {
      ...enterpriseScope,
      workspace_id: workspaceId,
    };
    const membership = this.#repos.memberships.getByUser(workspaceScope, userId);
    if (membership === undefined) {
      return undefined;
    }
    if (
      membership.enterprise_id !== this.#config.enterpriseId ||
      membership.workspace_id !== workspaceId
    ) {
      return undefined;
    }
    const workspace = this.#repos.workspaces.getById(enterpriseScope, workspaceId);
    if (workspace === undefined || workspace.enterprise_id !== membership.enterprise_id) {
      return undefined;
    }
    return { membership, workspace };
  }

  /**
   * The workspaces the caller holds a live membership in, for the enterprise
   * switcher. Exactly the membership rows are the source; substituting a
   * workspace id anywhere cannot widen the list. Archived workspaces are
   * omitted, matching the workspace list contract.
   */
  listWorkspaces(userId: UserId, cursor: string | null): WorkspacePage {
    const enterpriseScope = {
      enterprise_id: this.#config.enterpriseId,
      actor_id: userId,
    };
    const items: WorkspaceView[] = [];
    for (const membership of this.#repos.memberships.listForUser(enterpriseScope, userId)) {
      const workspace = this.#repos.workspaces.getById(enterpriseScope, membership.workspace_id);
      if (workspace === undefined || workspace.status !== "active") {
        continue;
      }
      const provider = this.#repos.providerInstances.getById(
        enterpriseScope,
        workspace.provider_instance_id,
      );
      if (provider === undefined) {
        continue;
      }
      items.push({
        id: workspace.id,
        enterprise_id: workspace.enterprise_id,
        name: workspace.name,
        status: workspace.status,
        repository: {
          repository_id: workspace.repository_id,
          provider_instance_id: workspace.provider_instance_id,
          provider_type: provider.provider_type,
        },
        role: membership.role,
        version: workspace.version,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
      });
    }
    items.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    let startIndex = 0;
    if (cursor !== null) {
      const index = items.findIndex((item) => item.id === cursor);
      if (index === -1) {
        throw new ApiError(400, "INVALID_CURSOR", `Unknown cursor ${JSON.stringify(cursor)}`);
      }
      startIndex = index + 1;
    }
    const page = items.slice(startIndex, startIndex + 50);
    const last = page[page.length - 1];
    return {
      items: page,
      next_cursor: last && startIndex + page.length < items.length ? last.id : null,
    };
  }

  /** Create a workspace only for a bootstrap-provisioned enterprise admin. */
  createWorkspace(userId: UserId, input: CreateWorkspaceInput): WorkspaceView {
    const enterpriseId = this.#config.enterpriseId;
    this.#assertActiveEnterpriseAdmin(userId, enterpriseId, "workspace.create");
    const name = input.name.trim();
    const repositoryId = input.repository_id.trim();
    if (!name || !repositoryId) {
      throw new ApiError(400, "INVALID_REQUEST", "Workspace name and repository_id are required");
    }
    let repository;
    try {
      repository = parseCanonicalRepositoryId(repositoryId);
    } catch (error) {
      if (error instanceof InvalidRepositoryIdError) {
        throw new ApiError(400, "INVALID_REQUEST", error.message);
      }
      throw error;
    }
    const scope = { enterprise_id: enterpriseId, actor_id: userId };
    const provider = this.#repos.providerInstances.getById(scope, input.provider_instance_id);
    if (!provider || provider.provider_type !== repository.provider) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "The repository provider must match the selected provider instance",
      );
    }
    const { workspace, membership } = this.#repos.createWorkspaceWithOwner(
      scope,
      { name, repository_id: repository.canonical, provider_instance_id: provider.id },
      userId,
    );
    return {
      id: workspace.id,
      enterprise_id: workspace.enterprise_id,
      name: workspace.name,
      status: workspace.status,
      repository: {
        repository_id: workspace.repository_id,
        provider_instance_id: workspace.provider_instance_id,
        provider_type: provider.provider_type,
      },
      role: membership.role,
      version: workspace.version,
      created_at: workspace.created_at,
      updated_at: workspace.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // Bootstrap and administration
  // -------------------------------------------------------------------------

  /**
   * Deployment bootstrap authority: a constant-time check of the presented
   * secret. With no configured token every presentation fails (fail closed).
   */
  verifyBootstrapToken(presented: string | undefined): boolean {
    const token = this.#config.bootstrapToken;
    return (
      token !== undefined &&
      token.length > 0 &&
      typeof presented === "string" &&
      presented.length > 0 &&
      secretEquals(presented, token)
    );
  }

  /**
   * Deployment-owned, audited bootstrap of the first enterprise administrator.
   * Names the provider identity explicitly, so whoever signed in first cannot
   * capture the role; runs at most once per enterprise.
   */
  bootstrapAdmin(actor: AdminActor, input: BootstrapAdminInput): BootstrapAdminResult {
    if (actor.kind !== "deployment") {
      throw new ApiError(403, "FORBIDDEN", "deployment bootstrap authority is required");
    }
    const token = this.#config.bootstrapToken;
    // Checked by the HTTP layer from the X-Bootstrap-Token header; a missing
    // configuration disables the endpoint entirely (fail closed).
    if (token === undefined || token.length === 0) {
      throw new ApiError(
        503,
        "BOOTSTRAP_UNAVAILABLE",
        "bootstrap is not configured",
        {},
        { retryable: true },
      );
    }
    const enterprise = this.#repos.enterprises.getById(input.enterprise_id);
    if (enterprise === undefined) {
      throw new ApiError(404, "NOT_FOUND", "enterprise not found");
    }
    const provider = this.#identity.loginProviders.get(input.provider_instance_id);
    if (provider === undefined || provider.enterprise_id !== enterprise.id) {
      throw new ApiError(404, "NOT_FOUND", "provider instance not found");
    }
    const identity = this.#identity.identities.getByProviderSubject(provider.id, input.subject);
    if (identity === undefined) {
      this.#audit({
        event: "admin.bootstrap",
        enterprise_id: enterprise.id,
        actor_kind: "deployment",
        provider_instance_id: provider.id,
        details: { result: "denied", reason: "unknown_subject" },
      });
      throw new ApiError(404, "NOT_FOUND", "provider identity has not signed in yet");
    }
    // Membership, administrator grant, and the `admin.bootstrap` audit are
    // one transaction: a failed required audit leaves no administrator.
    const outcome = this.#identity.enterpriseUsers.bootstrapAdmin({
      enterprise_id: enterprise.id,
      user_id: identity.user_id,
      provider_instance_id: provider.id,
    });
    if (outcome.status === "conflict") {
      this.#audit({
        event: "admin.bootstrap",
        enterprise_id: enterprise.id,
        actor_kind: "deployment",
        subject_user_id: identity.user_id,
        details: { result: "denied", reason: "already_bootstrapped" },
      });
      throw new ApiError(409, "BOOTSTRAP_CONFLICT", "an enterprise administrator already exists");
    }
    if (outcome.status === "suspended") {
      this.#audit({
        event: "admin.bootstrap",
        enterprise_id: enterprise.id,
        actor_kind: "deployment",
        subject_user_id: identity.user_id,
        details: { result: "denied", reason: "enterprise_membership_suspended" },
      });
      throw new ApiError(
        409,
        "ENTERPRISE_MEMBERSHIP_SUSPENDED",
        "the enterprise user is suspended; deployment bootstrap does not lift it",
      );
    }
    return { enterprise_id: enterprise.id, user_id: identity.user_id, role: "admin" };
  }

  /** Admin (or deployment) approval of a provider instance origin. */
  async registerProviderInstance(
    actor: AdminActor,
    input: { enterprise_id: EnterpriseId; provider_type: ProviderType; origin_url: string },
  ): Promise<ProviderInstance> {
    this.#assertAdmin(actor, input.enterprise_id);
    const origin = normalizeProviderOrigin(input.origin_url);
    await assertPublicResolution(origin, this.#lookup);
    if (!this.#credentials.has(origin)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "no OAuth application is configured for this origin",
      );
    }
    const instance = this.#repos.providerInstances.create(
      { enterprise_id: input.enterprise_id, actor_id: actorIdOf(actor) },
      { provider_type: input.provider_type, origin_url: origin },
    );
    this.#audit({
      event: "provider_instance.registered",
      enterprise_id: input.enterprise_id,
      actor_kind: actor.kind,
      ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
      provider_instance_id: instance.id,
      details: { provider_type: input.provider_type, origin_url: origin },
    });
    return instance;
  }

  /**
   * Deployment-wide account suspension. This is an operator action by design:
   * an enterprise administrator never suspends an account that may belong to
   * another enterprise. Enterprise administrators use
   * {@link setEnterpriseUserStatus}, which is scoped to their own enterprise.
   */
  setUserStatus(actor: AdminActor, input: { user_id: UserId; status: UserStatus }): AppUser {
    const target = this.#identity.users.getById(input.user_id);
    if (target === undefined) {
      throw new ApiError(404, "NOT_FOUND", "user not found");
    }
    if (actor.kind !== "deployment") {
      this.#audit({
        event: "admin.denied",
        actor_kind: "user",
        actor_user_id: actor.user_id,
        subject_user_id: input.user_id,
        details: { action: "setUserStatus", reason: "deployment_only" },
      });
      throw new ApiError(
        403,
        "FORBIDDEN",
        "deployment operator authority is required for a global account suspension",
      );
    }
    const updated = this.#identity.users.setStatus(input.user_id, input.status, actorIdOf(actor));
    if (input.status === "suspended") {
      const revoked = this.#identity.sessions.revokeAllForUser(input.user_id, "user.suspended");
      this.hub.emit({ type: "user.suspended", user_id: input.user_id });
      this.#audit({
        event: "user.suspended",
        actor_kind: "deployment",
        subject_user_id: input.user_id,
        details: { revoked_sessions: revoked },
      });
    } else {
      this.#audit({
        event: "user.activated",
        actor_kind: "deployment",
        subject_user_id: input.user_id,
      });
    }
    return updated;
  }

  grantMembership(
    actor: AdminActor,
    input: {
      enterprise_id: EnterpriseId;
      workspace_id: WorkspaceId;
      user_id: UserId;
      role: WorkspaceRole;
    },
  ): Membership {
    this.#assertAdmin(actor, input.enterprise_id);
    const scope = { enterprise_id: input.enterprise_id, actor_id: actorIdOf(actor) };
    this.#repos.workspaces.getById(scope, input.workspace_id);
    if (this.#identity.users.getById(input.user_id) === undefined) {
      throw new ApiError(404, "NOT_FOUND", "user not found");
    }
    // A workspace grant is an explicit administrator act, so it establishes the
    // enterprise membership it depends on — but never reactivates a suspended
    // one (that would bypass the enterprise suspension boundary).
    const ensured = this.#identity.enterpriseUsers.ensureActive(
      input.enterprise_id,
      input.user_id,
      enterpriseActorOf(actor),
    );
    if (ensured.suspended) {
      throw new ApiError(
        409,
        "ENTERPRISE_MEMBERSHIP_SUSPENDED",
        "the target enterprise user is suspended; restore the membership first",
      );
    }
    const membership = this.#repos.memberships.create(
      { ...scope, workspace_id: input.workspace_id },
      { user_id: input.user_id, role: input.role },
    );
    this.#audit({
      event: "membership.granted",
      enterprise_id: input.enterprise_id,
      actor_kind: actor.kind,
      ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
      subject_user_id: input.user_id,
      details: { workspace_id: input.workspace_id, role: input.role },
    });
    return membership;
  }

  revokeMembership(
    actor: AdminActor,
    input: { enterprise_id: EnterpriseId; workspace_id: WorkspaceId; user_id: UserId },
  ): void {
    this.#assertAdmin(actor, input.enterprise_id);
    const scope = { enterprise_id: input.enterprise_id, actor_id: actorIdOf(actor) };
    this.#repos.workspaces.getById(scope, input.workspace_id);
    const membership = this.#repos.memberships.getByUser(
      { ...scope, workspace_id: input.workspace_id },
      input.user_id,
    );
    if (membership === undefined) {
      throw new ApiError(404, "NOT_FOUND", "membership not found");
    }
    this.#repos.memberships.remove({ ...scope, workspace_id: input.workspace_id }, membership.id);
    this.hub.emit({
      type: "membership.revoked",
      user_id: input.user_id,
      workspace_id: input.workspace_id,
    });
    this.#audit({
      event: "membership.revoked",
      enterprise_id: input.enterprise_id,
      actor_kind: actor.kind,
      ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
      subject_user_id: input.user_id,
      details: { workspace_id: input.workspace_id, role: membership.role },
    });
  }

  listAudit(
    actor: AdminActor,
    filter: { enterprise_id: EnterpriseId; limit?: number },
  ): AuthAuditRecord[] {
    this.#assertAdmin(actor, filter.enterprise_id);
    return this.#identity.authAudit.list(filter);
  }

  // -------------------------------------------------------------------------
  // Enterprise users (DAT-275)
  // -------------------------------------------------------------------------

  /**
   * Enterprise directory, newest first, cursor-paginated. The path enterprise
   * is a scope filter validated by the caller's administrator standing; it can
   * never return a row from another enterprise.
   */
  listEnterpriseUsers(
    actor: AdminActor,
    input: { enterprise_id: EnterpriseId; status?: string; cursor?: string | null },
  ): EnterpriseUserPageView {
    this.#assertAdmin(actor, input.enterprise_id);
    const status = input.status;
    if (
      status !== undefined &&
      status !== "pending_claim" &&
      status !== "active" &&
      status !== "suspended"
    ) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "status must be pending_claim, active, or suspended",
      );
    }
    const page = this.#identity.enterpriseUsers.list(input.enterprise_id, {
      ...(status !== undefined ? { status } : {}),
      cursor: input.cursor ?? null,
    });
    if (page.invalid_cursor === true) {
      throw new ApiError(400, "INVALID_CURSOR", "unknown enterprise user cursor");
    }
    return {
      items: page.items.map((row) => this.#enterpriseUserView(row)),
      next_cursor: page.next_cursor,
    };
  }

  getEnterpriseUser(
    actor: AdminActor,
    input: { enterprise_id: EnterpriseId; id: string },
  ): EnterpriseUserView {
    this.#assertAdmin(actor, input.enterprise_id);
    const row = this.#identity.enterpriseUsers.getById(input.enterprise_id, input.id);
    if (row === undefined) {
      throw new ApiError(404, "NOT_FOUND", "enterprise user not found");
    }
    return this.#enterpriseUserView(row);
  }

  /**
   * Add an approved provider subject to the enterprise. Idempotent for the
   * same (provider instance, stable subject); a subject that has not signed in
   * is recorded as `pending_claim` and no credential or login secret is
   * stored. Email is never an input, so two subjects sharing an email can
   * never merge.
   */
  addEnterpriseUser(
    actor: AdminActor,
    input: AddEnterpriseUserRequest,
  ): { enterprise_user: EnterpriseUserView; created: boolean } {
    this.#assertAdmin(actor, input.enterprise_id);
    const subject = input.subject.trim();
    if (subject.length === 0 || subject.length > 256) {
      throw new ApiError(400, "INVALID_REQUEST", "subject must be 1-256 characters");
    }
    const scope = { enterprise_id: input.enterprise_id, actor_id: actorIdOf(actor) };
    const provider = this.#repos.providerInstances.getById(scope, input.provider_instance_id);
    if (provider === undefined) {
      throw new ApiError(404, "NOT_FOUND", "provider instance not found in this enterprise");
    }
    const result = this.#identity.enterpriseUsers.add({
      enterprise_id: input.enterprise_id,
      provider_instance_id: provider.id,
      subject,
      actor: enterpriseActorOf(actor),
    });
    return {
      enterprise_user: this.#enterpriseUserView(result.user),
      created: result.created,
    };
  }

  /** Suspend or restore one enterprise membership; other enterprises unchanged. */
  setEnterpriseUserStatus(
    actor: AdminActor,
    input: {
      enterprise_id: EnterpriseId;
      id: string;
      status: "active" | "suspended";
      version: number;
    },
  ): EnterpriseUserView {
    this.#assertAdmin(actor, input.enterprise_id);
    const result = this.#identity.enterpriseUsers.setStatus(
      input.enterprise_id,
      input.id,
      input.status,
      input.version,
      enterpriseActorOf(actor),
    );
    const row = this.#enterpriseUserUpdateResult(result, input.id);
    if (row.user_id !== null) {
      this.hub.emit({
        type: "enterprise_user.status_changed",
        enterprise_id: input.enterprise_id,
        user_id: row.user_id,
        status: row.status,
      });
    }
    return this.#enterpriseUserView(row);
  }

  /** Grant or revoke enterprise administration; last admin is protected. */
  setEnterpriseUserRole(
    actor: AdminActor,
    input: {
      enterprise_id: EnterpriseId;
      id: string;
      role: "admin" | "member";
      version: number;
    },
  ): EnterpriseUserView {
    this.#assertAdmin(actor, input.enterprise_id);
    const result = this.#identity.enterpriseUsers.setRole(
      input.enterprise_id,
      input.id,
      input.role,
      input.version,
      enterpriseActorOf(actor),
    );
    const row = this.#enterpriseUserUpdateResult(result, input.id);
    return this.#enterpriseUserView(row);
  }

  // -------------------------------------------------------------------------
  // Repository capability ceilings (DAT-276, ADR-0011)
  // -------------------------------------------------------------------------

  /**
   * Administrator reapproval of a member's repository capability ceiling.
   *
   * Only an active enterprise administrator may reach this method, and the
   * capability service independently requires verified repository management
   * authority in the target workspace: enterprise administration never becomes
   * repository authority, and the legacy administrator membership route cannot
   * bypass the same ceiling. The deployment bootstrap credential is refused
   * here — it carries no enterprise membership, so it cannot prove either
   * condition (ADR-0011).
   */
  reapproveMemberCapability(
    actor: AdminActor,
    input: {
      enterprise_id: EnterpriseId;
      workspace_id: WorkspaceId;
      user_id: UserId;
      capabilities: readonly RepositoryCapability[] | null;
      version: number;
    },
  ): MemberCapabilityCeiling {
    this.#assertAdmin(actor, input.enterprise_id);
    if (actor.kind !== "user") {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "capability reapproval requires an enterprise administrator session, not the deployment credential",
      );
    }
    const ceilings = this.#requireCapabilityCeilings();
    this.#requireMembership(input.enterprise_id, input.workspace_id, input.user_id);
    return ceilings.reapprove(
      {
        enterprise_id: input.enterprise_id,
        workspace_id: input.workspace_id,
        actor_id: actor.user_id,
      },
      actor.user_id,
      {
        workspace_id: input.workspace_id,
        user_id: input.user_id,
        capabilities: input.capabilities,
        version: input.version,
      },
    );
  }

  /**
   * Administrator read of one member's ceiling and provider evidence.
   *
   * The same management-capability bar applies as to a reapproval: the view
   * names repository evidence, and enterprise administration is not
   * repository authority (ADR-0011). An enterprise administrator without
   * verified repository management in the workspace cannot read it.
   */
  getMemberCapability(
    actor: AdminActor,
    input: { enterprise_id: EnterpriseId; workspace_id: WorkspaceId; user_id: UserId },
  ): CapabilityCeilingView {
    this.#assertAdmin(actor, input.enterprise_id);
    const ceilings = this.#requireCapabilityCeilings();
    this.#requireMembership(input.enterprise_id, input.workspace_id, input.user_id);
    const scope = {
      enterprise_id: input.enterprise_id,
      workspace_id: input.workspace_id,
      actor_id: actor.kind === "user" ? actor.user_id : SYSTEM_ACTOR,
    };
    if (actor.kind !== "user" || !ceilings.view(scope, actor.user_id).can_manage) {
      throw new ApiError(
        403,
        "CAPABILITY_MANAGEMENT_REQUIRED",
        "the caller lacks verified repository management capability across the workspace's repositories",
      );
    }
    return ceilings.view(scope, input.user_id);
  }

  #requireCapabilityCeilings(): CapabilityCeilingService {
    if (this.#capabilityCeilings === undefined) {
      throw new ApiError(404, "NOT_FOUND", "capability ceilings are not served by this deployment");
    }
    return this.#capabilityCeilings;
  }

  #requireMembership(
    enterpriseId: EnterpriseId,
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Membership {
    const scope = {
      enterprise_id: enterpriseId,
      workspace_id: workspaceId,
      actor_id: SYSTEM_ACTOR,
    };
    this.#repos.workspaces.getById(scope, workspaceId);
    const membership = this.#repos.memberships.getByUser(scope, userId);
    if (membership === undefined) {
      throw new ApiError(404, "NOT_FOUND", "workspace membership not found");
    }
    return membership;
  }

  #enterpriseUserUpdateResult(
    result: Awaited<ReturnType<IdentityRepositories["enterpriseUsers"]["setStatus"]>>,
    id: string,
  ): EnterpriseUser {
    if (result.status === "ok") {
      return result.user;
    }
    if (result.status === "version_conflict") {
      throw new ApiError(409, "VERSION_CONFLICT", "enterprise user was modified concurrently", {
        enterprise_user_id: id,
        actual_version: result.actual_version,
      });
    }
    if (result.status === "last_admin") {
      throw new ApiError(
        409,
        "LAST_ENTERPRISE_ADMIN",
        "at least one active enterprise administrator must remain",
      );
    }
    if (result.status === "not_claimed") {
      throw new ApiError(
        409,
        "USER_NOT_CLAIMED",
        "the enterprise user has not signed in yet; the role can change after the identity is claimed",
      );
    }
    throw new ApiError(500, "INTERNAL_ERROR", "unexpected enterprise user update result");
  }

  #enterpriseUserView(row: EnterpriseUser): EnterpriseUserView {
    const identities = this.#identity.enterpriseUsers.listIdentities(row.id);
    const binding = identities[0];
    const provider =
      binding !== undefined
        ? this.#repos.providerInstances.getById(
            { enterprise_id: row.enterprise_id, actor_id: row.created_by },
            binding.provider_instance_id,
          )
        : undefined;
    const user = row.user_id !== null ? this.#identity.users.getById(row.user_id) : undefined;
    const login =
      binding !== undefined
        ? this.#identity.identities.getByProviderSubject(
            binding.provider_instance_id,
            binding.subject,
          )?.login
        : undefined;
    const role =
      row.user_id !== null
        ? this.#identity.enterpriseRoles.getByUser(row.enterprise_id, row.user_id)
        : undefined;
    return {
      id: row.id,
      enterprise_id: row.enterprise_id,
      user_id: row.user_id,
      status: row.status,
      role: role?.role === "admin" ? "admin" : "member",
      provider_instance_id: binding?.provider_instance_id ?? "",
      provider_type: provider?.provider_type ?? "github",
      subject: binding?.subject ?? "",
      display_name: user?.display_name ?? null,
      login: login ?? null,
      claimed_at: row.claimed_at,
      suspended_at: row.suspended_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #requireLoginProvider(providerInstanceId: string): LoginProvider {
    const provider = this.#identity.loginProviders.get(providerInstanceId);
    if (provider === undefined) {
      // Non-enumerating: an unknown and an unusable instance fail alike.
      throw new ApiError(400, "INVALID_REQUEST", "login provider is not available");
    }
    return provider;
  }

  #resolveOrCreateUser(provider: LoginProvider, profile: ProviderProfile): AppUser {
    const existing = this.#identity.identities.getByProviderSubject(provider.id, profile.subject);
    if (existing !== undefined) {
      const user = this.#identity.users.getById(existing.user_id);
      if (user === undefined) {
        throw new ApiError(500, "INTERNAL_ERROR", "identity references a missing user");
      }
      return user;
    }
    // Provisioning a new account: the provider subject is the only match key.
    // The profile's email is deliberately not consulted — two subjects with
    // one email stay two users.
    const user = this.#identity.users.create({
      display_name: profile.display_name,
      actor_id: SYSTEM_ACTOR,
    });
    this.#identity.identities.create({
      user_id: user.id,
      provider_instance_id: provider.id,
      subject: profile.subject,
      login: profile.login,
      actor_id: SYSTEM_ACTOR,
    });
    this.#audit({
      event: "user.provisioned",
      enterprise_id: provider.enterprise_id,
      actor_kind: "user",
      actor_user_id: user.id,
      provider_instance_id: provider.id,
      details: { subject: profile.subject },
    });
    return user;
  }

  #createSession(input: Omit<CreateSessionInput, "token_hash" | "csrf_token" | "expires_at">): {
    token: string;
    csrf_token: string;
    expires_at: string;
    id: string;
  } {
    const secrets = mintSessionSecrets();
    const expiresAt = new Date(Date.now() + this.#config.sessionTtlSeconds * 1000).toISOString();
    const session = this.#identity.sessions.create({
      ...input,
      token_hash: secrets.token_hash,
      csrf_token: secrets.csrf_token,
      expires_at: expiresAt,
    });
    this.#audit({
      event: "session.created",
      actor_kind: "user",
      actor_user_id: input.user_id,
      details: { session_id: session.id, kind: input.kind },
    });
    return {
      token: secrets.token,
      csrf_token: secrets.csrf_token,
      expires_at: session.expires_at,
      id: session.id,
    };
  }

  #assertAdmin(actor: AdminActor, enterpriseId: EnterpriseId): void {
    if (actor.kind === "deployment") {
      return;
    }
    this.#assertActiveEnterpriseAdmin(actor.user_id, enterpriseId, "admin");
  }

  /**
   * Enterprise administration requires BOTH the administrator grant and an
   * active enterprise membership: suspending a member also suspends the
   * authority they hold in that enterprise only.
   */
  #assertActiveEnterpriseAdmin(userId: UserId, enterpriseId: EnterpriseId, action: string): void {
    const role = this.#identity.enterpriseRoles.getByUser(enterpriseId, userId);
    const membership = this.#identity.enterpriseUsers.getByUser(enterpriseId, userId);
    if (role === undefined || membership === undefined || membership.status !== "active") {
      this.#audit({
        event: "admin.denied",
        enterprise_id: enterpriseId,
        actor_kind: "user",
        actor_user_id: userId,
        details: { action },
      });
      if (membership !== undefined && membership.status !== "active") {
        throw new ApiError(
          403,
          "ENTERPRISE_MEMBERSHIP_SUSPENDED",
          "this enterprise membership is suspended",
        );
      }
      throw new ApiError(
        403,
        "FORBIDDEN",
        "administrator authority in this enterprise is required",
      );
    }
  }

  #enterpriseMembershipView(userId: UserId): EnterpriseMembershipView | null {
    const membership = this.#identity.enterpriseUsers.getByUser(this.#config.enterpriseId, userId);
    if (membership === undefined) {
      return null;
    }
    const role = this.#identity.enterpriseRoles.getByUser(this.#config.enterpriseId, userId);
    return {
      enterprise_id: membership.enterprise_id,
      status: membership.status,
      role: role?.role === "admin" ? "admin" : "member",
      version: membership.version,
    };
  }

  #expired(expiresAt: string): boolean {
    return Date.parse(expiresAt) <= Date.now();
  }

  #audit(input: Parameters<IdentityRepositories["authAudit"]["append"]>[0]): void {
    this.#identity.authAudit.append(input);
  }
}

function actorIdOf(actor: AdminActor): UserId {
  return actor.kind === "deployment" ? SYSTEM_ACTOR : actor.user_id;
}

function enterpriseActorOf(actor: AdminActor): EnterpriseUserActor {
  return actor.kind === "deployment"
    ? { kind: "deployment" }
    : { kind: "user", user_id: actor.user_id };
}

/** Only same-deployment relative paths; never protocol-relative or absolute. */
function sanitizeReturnTo(returnTo: string | undefined): string {
  if (
    returnTo !== undefined &&
    returnTo.startsWith("/") &&
    !returnTo.startsWith("//") &&
    !returnTo.startsWith("/\\") &&
    !returnTo.includes("\\")
  ) {
    return returnTo;
  }
  return "/";
}
