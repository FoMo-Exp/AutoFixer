import { lookup as dnsLookup } from "node:dns/promises";

import { hashToken, secretEquals } from "../control-plane/identity-repositories.js";
import type {
  AppUser,
  AuthAuditRecord,
  AuthSession,
  CreateSessionInput,
  IdentityRepositories,
  LoginProvider,
  SessionKind,
  UserStatus,
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
 * - Logout, suspension, and membership revocation revoke sessions and emit
 *   invalidation events so live SSE subscriptions close immediately.
 */

/** Recorded as the actor for system provisioning rows. */
export const SYSTEM_ACTOR = "usr_auth_system";

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
}

// ---------------------------------------------------------------------------
// Invalidation events (SSE subscriptions react to these)
// ---------------------------------------------------------------------------

export type AuthInvalidation =
  | { type: "session.revoked"; session_id: string; user_id: string }
  | { type: "user.suspended"; user_id: string }
  | { type: "membership.revoked"; user_id: string; workspace_id: string };

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

export interface SessionInfo {
  user: UserView;
  kind: SessionKind;
  csrf_token: string;
  expires_at: string;
  enterprise_roles: Array<{ enterprise_id: string; role: string }>;
  memberships: Array<{ enterprise_id: string; workspace_id: string; role: string }>;
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

  constructor(deps: AuthServiceDeps) {
    this.#repos = deps.repos;
    this.#identity = deps.identity;
    this.#config = deps.config;
    this.#credentials = deps.credentials;
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
    let accessToken: string;
    try {
      const adapter = providerAdapters[provider.provider_type];
      accessToken = await this.#oauth.exchangeCode({
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

    // The one moment a provider credential exists server-side: verify the
    // user's current repository access against the provider while the token
    // is in hand, and record the verified fact (or none at all, fail closed).
    await this.#verifyRepositoryAccess(user, provider, profile, accessToken);

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
    return {
      user: { id: ctx.user.id, display_name: ctx.user.display_name, status: ctx.user.status },
      kind: ctx.session.kind,
      csrf_token: ctx.session.csrf_token,
      expires_at: ctx.session.expires_at,
      enterprise_roles: this.#identity.enterpriseRoles.listByUser(ctx.user.id).map((role) => ({
        enterprise_id: role.enterprise_id,
        role: role.role,
      })),
      memberships: memberships.map((membership) => ({
        enterprise_id: membership.enterprise_id,
        workspace_id: membership.workspace_id,
        role: membership.role,
      })),
    };
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
    const existing = this.#identity.enterpriseRoles.listByEnterprise(enterprise.id);
    if (existing.length > 0) {
      if (existing[0]?.user_id === identity.user_id) {
        return { enterprise_id: enterprise.id, user_id: identity.user_id, role: "admin" };
      }
      this.#audit({
        event: "admin.bootstrap",
        enterprise_id: enterprise.id,
        actor_kind: "deployment",
        subject_user_id: identity.user_id,
        details: { result: "denied", reason: "already_bootstrapped" },
      });
      throw new ApiError(409, "BOOTSTRAP_CONFLICT", "an enterprise administrator already exists");
    }
    this.#identity.enterpriseRoles.grant({
      enterprise_id: enterprise.id,
      user_id: identity.user_id,
      role: "admin",
      actor_id: SYSTEM_ACTOR,
    });
    this.#audit({
      event: "admin.bootstrap",
      enterprise_id: enterprise.id,
      actor_kind: "deployment",
      subject_user_id: identity.user_id,
      provider_instance_id: provider.id,
      details: { result: "granted" },
    });
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

  setUserStatus(
    actor: AdminActor,
    input: { user_id: UserId; status: UserStatus; enterprise_id?: EnterpriseId },
  ): AppUser {
    const target = this.#identity.users.getById(input.user_id);
    if (target === undefined) {
      throw new ApiError(404, "NOT_FOUND", "user not found");
    }
    if (actor.kind === "user") {
      const targetEnterprises = this.#identity.identities.enterprisesOf(input.user_id);
      const adminOf = new Set(
        this.#identity.enterpriseRoles.listByUser(actor.user_id).map((role) => role.enterprise_id),
      );
      const authorized = targetEnterprises.some((enterpriseId) => adminOf.has(enterpriseId));
      if (!authorized) {
        this.#audit({
          event: "admin.denied",
          actor_kind: "user",
          actor_user_id: actor.user_id,
          subject_user_id: input.user_id,
          details: { action: "setUserStatus" },
        });
        throw new ApiError(403, "FORBIDDEN", "administrator authority over this user is required");
      }
    }
    const updated = this.#identity.users.setStatus(input.user_id, input.status, actorIdOf(actor));
    if (input.status === "suspended") {
      const revoked = this.#identity.sessions.revokeAllForUser(input.user_id, "user.suspended");
      this.hub.emit({ type: "user.suspended", user_id: input.user_id });
      this.#audit({
        event: "user.suspended",
        actor_kind: actor.kind,
        ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
        subject_user_id: input.user_id,
        details: { revoked_sessions: revoked },
      });
    } else {
      this.#audit({
        event: "user.activated",
        actor_kind: actor.kind,
        ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
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

  /**
   * Trusted repository-access fact producer (DAT-204 eligibility).
   *
   * For every active workspace bound to the provider instance the user just
   * authenticated to, ask the provider — with the user's own access token —
   * whether they can currently reach the workspace's bound repository, and
   * record the verified fact. An unusable answer records nothing: a missing
   * fact keeps invitation redemption fail closed until a later verification
   * (re-login, or DAT-203's periodic reconciliation) succeeds. The token is
   * used only inside this call and never logged.
   */
  async #verifyRepositoryAccess(
    user: AppUser,
    provider: LoginProvider,
    profile: ProviderProfile,
    accessToken: string,
  ): Promise<void> {
    const scope = { enterprise_id: provider.enterprise_id, actor_id: SYSTEM_ACTOR };
    const workspaces = this.#repos.workspaces
      .list(scope)
      .filter(
        (workspace) =>
          workspace.provider_instance_id === provider.id && workspace.status === "active",
      );
    const adapter = providerAdapters[provider.provider_type];
    for (const workspace of workspaces) {
      let hasAccess: boolean | undefined;
      try {
        hasAccess = await this.#oauth.probeRepositoryAccess({
          adapter,
          origin: provider.origin_url,
          accessToken,
          repositoryId: workspace.repository_id,
          subject: profile.subject,
        });
      } catch {
        hasAccess = undefined;
      }
      const detail = { workspace_id: workspace.id, subject: profile.subject };
      if (hasAccess === undefined) {
        this.#audit({
          event: "repository_access.unverified",
          enterprise_id: provider.enterprise_id,
          actor_kind: "user",
          actor_user_id: user.id,
          subject_user_id: user.id,
          provider_instance_id: provider.id,
          details: { ...detail, reason: "provider_check_unavailable" },
        });
        continue;
      }
      this.#repos.repositoryAccess.record(
        { ...scope, workspace_id: workspace.id },
        {
          provider_instance_id: provider.id,
          subject: profile.subject,
          has_access: hasAccess,
          verified_by_source: "provider_api",
          actor_id: SYSTEM_ACTOR,
        },
      );
      this.#audit({
        event: "repository_access.verified",
        enterprise_id: provider.enterprise_id,
        actor_kind: "user",
        actor_user_id: user.id,
        subject_user_id: user.id,
        provider_instance_id: provider.id,
        details: { ...detail, has_access: hasAccess },
      });
    }
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
    const role = this.#identity.enterpriseRoles.getByUser(enterpriseId, actor.user_id);
    if (role === undefined) {
      this.#audit({
        event: "admin.denied",
        enterprise_id: enterpriseId,
        actor_kind: "user",
        actor_user_id: actor.user_id,
        details: { action: "admin" },
      });
      throw new ApiError(
        403,
        "FORBIDDEN",
        "administrator authority in this enterprise is required",
      );
    }
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
