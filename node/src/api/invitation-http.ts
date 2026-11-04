/**
 * HTTP surface for owner-created invitations (DAT-204).
 *
 *   GET    /api/v1/workspaces/{workspace_id}/invitations          list (owner/admin)
 *   POST   /api/v1/workspaces/{workspace_id}/invitations          create (owner/admin)
 *   DELETE /api/v1/workspaces/{workspace_id}/invitations/{id}     revoke (owner/admin)
 *   POST   /api/v1/invitations/preview                            join-confirmation preview
 *   POST   /api/v1/invitations/redeem                             explicit join confirmation
 *
 * The bearer travels only in these POST bodies (or the QR URL fragment that
 * the page captures and submits): there is no GET anywhere in this surface
 * that reads a token, so link previews and security scanners that fetch the
 * landing URL can neither learn nor consume an invitation. Errors never echo
 * a presented token.
 */

import type http from "node:http";

import type { AuthService, SessionContext } from "./auth-service.js";
import { requestOriginOf, requestSessionToken } from "./auth-http.js";
import { ApiError } from "./errors.js";
import type { InvitationRequestContext, InvitationService } from "./invitation-service.js";
import { readJsonBody, requireString, writeJson } from "./http-util.js";
import { CSRF_HEADER, csrfMatches } from "./sessions.js";

export interface InvitationHttpDeps {
  auth: AuthService;
  invitations: InvitationService;
  /** External origin override; loopback derives from the socket. */
  publicOrigin?: string;
}

export interface InvitationRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolve the session actor for an invitation request. The invitation surface
 * serves the identity-surface error exemplars: 401 UNAUTHENTICATED when no
 * usable session is presented, 403 CSRF_TOKEN_INVALID when an ambient cookie
 * credential does not echo its CSRF token.
 */
function requireInviteeSession(auth: AuthService, req: http.IncomingMessage): SessionContext {
  const presented = requestSessionToken(req);
  const ctx = presented !== undefined ? auth.resolveSession(presented.token) : undefined;
  if (ctx === undefined) {
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  if (presented?.via === "cookie" && !SAFE_METHODS.has(req.method ?? "GET")) {
    const header = req.headers[CSRF_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!csrfMatches(value, ctx.session.csrf_token)) {
      throw new ApiError(403, "CSRF_TOKEN_INVALID", "a valid CSRF token is required");
    }
  }
  return ctx;
}

function pathSegment(segments: string[], index: number, label: string): string {
  const value = segments[index];
  if (value === undefined || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${label} is required`);
  }
  return value;
}

function requestContextOf(
  deps: InvitationHttpDeps,
  res: http.ServerResponse,
  ctx: SessionContext,
): InvitationRequestContext {
  return { user_id: ctx.user.id, origin: requestOriginOf(deps, res) };
}

/** Always handles the request (or throws the mapped error) for the routes above. */
export async function handleInvitationRequest(
  deps: InvitationHttpDeps,
  ctx: InvitationRouteContext,
): Promise<void> {
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";

  // /api/v1/workspaces/{workspace_id}/invitations[/{invitation_id}]
  if (segments[2] === "workspaces" && segments[4] === "invitations") {
    // Route and method are matched before any credential is read, so an
    // unauthenticated GET on a write-only path is an ordinary 404 — a link
    // preview or scanner learns nothing about the surface.
    const isList = method === "GET" && segments.length === 5;
    const isCreate = method === "POST" && segments.length === 5;
    const isRevoke = method === "DELETE" && segments.length === 6;
    if (!isList && !isCreate && !isRevoke) {
      throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
    }
    const session = requireInviteeSession(deps.auth, req);
    const actor = requestContextOf(deps, res, session);
    const workspaceId = pathSegment(segments, 3, "workspace_id");

    if (isList) {
      writeJson(
        res,
        200,
        deps.invitations.listInvitations(actor, workspaceId, url.searchParams.get("cursor")),
      );
      return;
    }

    if (isCreate) {
      const body = await readJsonBody(req);
      writeJson(
        res,
        201,
        deps.invitations.createInvitation(actor, workspaceId, {
          ...(body["expires_in_seconds"] !== undefined
            ? { expires_in_seconds: body["expires_in_seconds"] }
            : {}),
          ...(body["bound_provider_subject"] !== undefined
            ? { bound_provider_subject: body["bound_provider_subject"] }
            : {}),
        }),
      );
      return;
    }

    deps.invitations.revokeInvitation(
      actor,
      workspaceId,
      pathSegment(segments, 5, "invitation_id"),
    );
    res.writeHead(204);
    res.end();
    return;
  }

  // /api/v1/invitations/preview|redeem — POST only; nothing here ever reads a
  // token from a URL, so a GET (link preview, scanner) learns and consumes
  // nothing.
  if (segments[2] === "invitations" && segments.length === 4) {
    const action = segments[3];
    const isPreview = method === "POST" && action === "preview";
    const isRedeem = method === "POST" && action === "redeem";
    if (!isPreview && !isRedeem) {
      throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
    }
    const session = requireInviteeSession(deps.auth, req);
    const actor = requestContextOf(deps, res, session);
    const body = await readJsonBody(req);
    const token = requireString(body, "token");
    // Redemption point-refreshes repository authority before its
    // transaction, so it is asynchronous; await it (a promise serialized by
    // writeJson would answer 200 with an empty object).
    const result = isPreview
      ? deps.invitations.previewInvitation(actor, token)
      : await deps.invitations.redeemInvitation(actor, token);
    writeJson(res, 200, result);
    return;
  }

  throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${url.pathname}`);
}
