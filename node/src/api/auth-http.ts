import type http from "node:http";

import type { AdminActor, AuthService, SessionContext } from "./auth-service.js";
import { ApiError } from "./errors.js";
import { readJsonBody, requireString, writeJson, writeRedirect, writeText } from "./http-util.js";
import {
  CSRF_HEADER,
  OAUTH_BINDING_COOKIE,
  SESSION_COOKIE,
  bindingCookieValue,
  csrfMatches,
  expireCookieValue,
  parseCookies,
  sessionCookieValue,
} from "./sessions.js";

/**
 * HTTP surface for provider login, sessions, the desktop system-browser
 * flow, and administrator bootstrap.
 *
 * These routes authenticate themselves: the login/provider/desktop routes
 * are anonymous (the desktop exchange authenticates with its single-use
 * secret), the session/logout routes require a session, and the admin
 * routes require either the deployment bootstrap token or an enterprise
 * administrator session. Nothing here echoes a token, secret, code, state,
 * or verifier into a response body or redirect.
 */

export interface AuthHttpDeps {
  auth: AuthService;
  /** External origin override; loopback derives from the socket. */
  publicOrigin?: string;
}

export interface AuthRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

const BOOTSTRAP_HEADER = "x-bootstrap-token";

export function requestOriginOf(deps: AuthHttpDeps, res: http.ServerResponse): string {
  return deps.publicOrigin ?? `http://127.0.0.1:${res.socket?.localPort ?? 0}`;
}

function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}

export interface PresentedToken {
  token: string;
  via: "cookie" | "bearer";
}

/** Session credential: Authorization header first (desktop), else cookie. */
export function requestSessionToken(req: http.IncomingMessage): PresentedToken | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.startsWith("Bearer ")) {
    const token = value.slice("Bearer ".length);
    if (token.length > 0) {
      return { token, via: "bearer" };
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE];
  if (cookieToken !== undefined && cookieToken.length > 0) {
    return { token: cookieToken, via: "cookie" };
  }
  return undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolve the session actor for a request, enforcing CSRF on mutating
 * cookie-authenticated requests. Throws 401/403 rather than returning
 * partial results.
 */
export function requireSessionActor(auth: AuthService, req: http.IncomingMessage): SessionContext {
  const presented = requestSessionToken(req);
  const ctx = presented !== undefined ? auth.resolveSession(presented.token) : undefined;
  if (ctx === undefined) {
    throw new ApiError(401, "UNAUTHENTICATED", "a valid session is required");
  }
  if (presented?.via === "cookie" && !SAFE_METHODS.has(req.method ?? "GET")) {
    const header = req.headers[CSRF_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!csrfMatches(value, ctx.session.csrf_token)) {
      throw new ApiError(403, "FORBIDDEN", "a valid CSRF token is required");
    }
  }
  return ctx;
}

/** Optional actor: returns undefined when no session credential is presented. */
export function optionalSessionActor(
  auth: AuthService,
  req: http.IncomingMessage,
): SessionContext | undefined {
  const presented = requestSessionToken(req);
  return presented !== undefined ? auth.resolveSession(presented.token) : undefined;
}

function adminActorOf(auth: AuthService, req: http.IncomingMessage): AdminActor {
  const header = req.headers[BOOTSTRAP_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && value.length > 0) {
    if (!auth.verifyBootstrapToken(value)) {
      throw new ApiError(401, "UNAUTHENTICATED", "bootstrap token is not valid");
    }
    return { kind: "deployment" };
  }
  return { kind: "user", user_id: requireSessionActor(auth, req).user.id };
}

function pathSegment(segments: string[], index: number, label: string): string {
  const value = segments[index];
  if (value === undefined || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${label} is required`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// /api/v1/auth
// ---------------------------------------------------------------------------

async function handleAuth(deps: AuthHttpDeps, ctx: AuthRouteContext): Promise<void> {
  const { auth } = deps;
  const { req, res, url, segments } = ctx;
  const action = segments[3];
  const method = req.method ?? "GET";

  // GET /api/v1/auth/providers
  if (method === "GET" && action === "providers" && segments.length === 4) {
    writeJson(res, 200, { items: auth.listLoginProviders() });
    return;
  }

  // GET /api/v1/auth/login
  if (method === "GET" && action === "login" && segments.length === 4) {
    const providerInstanceId = url.searchParams.get("provider_instance_id") ?? "";
    const desktopFlowId = url.searchParams.get("desktop_flow") ?? undefined;
    const started = auth.startLogin({
      providerInstanceId,
      requestOrigin: requestOriginOf(deps, res),
      returnTo: url.searchParams.get("return_to") ?? undefined,
      ...(desktopFlowId !== undefined ? { desktopFlowId } : {}),
    });
    writeRedirect(res, started.authorization_url, [
      bindingCookieValue(started.binding, 600, isSecureOrigin(requestOriginOf(deps, res))),
    ]);
    return;
  }

  // GET /api/v1/auth/callback
  if (method === "GET" && action === "callback" && segments.length === 4) {
    const cookies = parseCookies(req.headers.cookie);
    const userAgent = req.headers["user-agent"];
    const completion = await auth.completeLogin({
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? "",
      binding: cookies[OAUTH_BINDING_COOKIE],
      requestOrigin: requestOriginOf(deps, res),
      ...(typeof userAgent === "string" ? { userAgent } : {}),
    });
    const secure = isSecureOrigin(requestOriginOf(deps, res));
    const expireBinding = expireCookieValue(OAUTH_BINDING_COOKIE, secure);
    if (completion.kind === "desktop") {
      // The desktop never sees this page's content beyond the status; its
      // credential arrives through the single-use exchange instead.
      res.setHeader("Set-Cookie", [expireBinding]);
      writeText(res, 200, "Sign-in complete. You can return to the application.");
      return;
    }
    writeRedirect(res, completion.return_to, [
      sessionCookieValue(completion.token, completion.max_age_seconds, secure),
      expireBinding,
    ]);
    return;
  }

  // GET /api/v1/auth/session
  if (method === "GET" && action === "session" && segments.length === 4) {
    writeJson(res, 200, auth.sessionInfo(requireSessionActor(auth, req)));
    return;
  }

  // POST /api/v1/auth/logout
  if (method === "POST" && action === "logout" && segments.length === 4) {
    const sessionCtx = requireSessionActor(auth, req);
    auth.logout(sessionCtx.session.id, sessionCtx.user.id);
    const secure = isSecureOrigin(requestOriginOf(deps, res));
    res.writeHead(204, { "Set-Cookie": expireCookieValue(SESSION_COOKIE, secure) });
    res.end();
    return;
  }

  // POST /api/v1/auth/desktop/flows
  if (
    method === "POST" &&
    action === "desktop" &&
    segments[4] === "flows" &&
    segments.length === 5
  ) {
    const body = await readJsonBody(req);
    const providerInstanceId = body["provider_instance_id"];
    const created = auth.createDesktopFlow({
      requestOrigin: requestOriginOf(deps, res),
      ...(typeof providerInstanceId === "string" && providerInstanceId.length > 0
        ? { providerInstanceId }
        : {}),
    });
    writeJson(res, 201, created);
    return;
  }

  // POST /api/v1/auth/desktop/flows/{flow_id}/exchange
  if (
    method === "POST" &&
    action === "desktop" &&
    segments[4] === "flows" &&
    segments[6] === "exchange" &&
    segments.length === 7
  ) {
    const body = await readJsonBody(req);
    const result = auth.exchangeDesktopFlow({
      flowId: pathSegment(segments, 5, "flow_id"),
      secret: requireString(body, "secret"),
    });
    if (result.status === "ok") {
      writeJson(res, 200, result);
      return;
    }
    if (result.status === "pending") {
      throw new ApiError(428, "AUTH_FLOW_NOT_READY", "sign-in has not completed in the browser");
    }
    if (result.status === "expired") {
      throw new ApiError(410, "AUTH_FLOW_EXPIRED", "desktop auth flow has expired");
    }
    throw new ApiError(410, "AUTH_FLOW_CONSUMED", "desktop auth flow was already exchanged");
  }

  throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// /api/v1/admin
// ---------------------------------------------------------------------------

async function handleAdmin(deps: AuthHttpDeps, ctx: AuthRouteContext): Promise<void> {
  const { auth } = deps;
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";

  // POST /api/v1/admin/enterprises/{enterprise_id}/bootstrap
  if (
    method === "POST" &&
    segments[3] === "enterprises" &&
    segments[5] === "bootstrap" &&
    segments.length === 6
  ) {
    const body = await readJsonBody(req);
    writeJson(
      res,
      200,
      auth.bootstrapAdmin(adminActorOf(auth, req), {
        enterprise_id: pathSegment(segments, 4, "enterprise_id"),
        provider_instance_id: requireString(body, "provider_instance_id"),
        subject: requireString(body, "subject"),
      }),
    );
    return;
  }

  // POST /api/v1/admin/enterprises/{enterprise_id}/provider-instances
  if (
    method === "POST" &&
    segments[3] === "enterprises" &&
    segments[5] === "provider-instances" &&
    segments.length === 6
  ) {
    const body = await readJsonBody(req);
    const providerType = requireString(body, "provider_type");
    if (providerType !== "github" && providerType !== "gitlab") {
      throw new ApiError(400, "INVALID_REQUEST", "provider_type must be github or gitlab");
    }
    writeJson(res, 201, {
      provider_instance: await auth.registerProviderInstance(adminActorOf(auth, req), {
        enterprise_id: pathSegment(segments, 4, "enterprise_id"),
        provider_type: providerType,
        origin_url: requireString(body, "origin_url"),
      }),
    });
    return;
  }

  // GET /api/v1/admin/enterprises/{enterprise_id}/auth-audit
  if (
    method === "GET" &&
    segments[3] === "enterprises" &&
    segments[5] === "auth-audit" &&
    segments.length === 6
  ) {
    const limit = url.searchParams.get("limit");
    writeJson(res, 200, {
      items: auth.listAudit(adminActorOf(auth, req), {
        enterprise_id: pathSegment(segments, 4, "enterprise_id"),
        ...(limit !== null && limit.length > 0 ? { limit: Number.parseInt(limit, 10) } : {}),
      }),
    });
    return;
  }

  // PUT/DELETE /api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/members/{user_id}
  if (
    (method === "PUT" || method === "DELETE") &&
    segments[3] === "enterprises" &&
    segments[5] === "workspaces" &&
    segments[7] === "members" &&
    segments.length === 9
  ) {
    const actor = adminActorOf(auth, req);
    const enterprise_id = pathSegment(segments, 4, "enterprise_id");
    const workspace_id = pathSegment(segments, 6, "workspace_id");
    const user_id = pathSegment(segments, 8, "user_id");
    if (method === "DELETE") {
      auth.revokeMembership(actor, { enterprise_id, workspace_id, user_id });
      res.writeHead(204);
      res.end();
      return;
    }
    const body = await readJsonBody(req);
    const role = requireString(body, "role");
    if (role !== "owner" && role !== "admin" && role !== "member" && role !== "viewer") {
      throw new ApiError(400, "INVALID_REQUEST", "role must be owner, admin, member, or viewer");
    }
    writeJson(
      res,
      200,
      auth.grantMembership(actor, {
        enterprise_id,
        workspace_id,
        user_id,
        role,
      }),
    );
    return;
  }

  // POST /api/v1/admin/users/{user_id}/suspend|activate
  if (
    method === "POST" &&
    segments[3] === "users" &&
    (segments[5] === "suspend" || segments[5] === "activate") &&
    segments.length === 6
  ) {
    const body = await readJsonBody(req);
    const enterpriseId = body["enterprise_id"];
    writeJson(
      res,
      200,
      auth.setUserStatus(adminActorOf(auth, req), {
        user_id: pathSegment(segments, 4, "user_id"),
        status: segments[5] === "suspend" ? "suspended" : "active",
        ...(typeof enterpriseId === "string" && enterpriseId.length > 0
          ? { enterprise_id: enterpriseId }
          : {}),
      }),
    );
    return;
  }

  throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Always handles the request (or throws the mapped error) for /auth|/admin. */
export async function handleAuthRequest(deps: AuthHttpDeps, ctx: AuthRouteContext): Promise<void> {
  if (ctx.segments[2] === "auth") {
    await handleAuth(deps, ctx);
    return;
  }
  await handleAdmin(deps, ctx);
}
