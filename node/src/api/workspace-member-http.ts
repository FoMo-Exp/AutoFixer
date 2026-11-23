/**
 * Workspace member and member-candidate HTTP routes (DAT-277).
 *
 * - `GET  /api/v1/workspaces/{workspace_id}/members`
 * - `POST /api/v1/workspaces/{workspace_id}/members`
 * - `PATCH/DELETE /api/v1/workspaces/{workspace_id}/members/{membership_id}`
 * - `GET  /api/v1/workspaces/{workspace_id}/member-candidates`
 *
 * Authentication is the session cookie (or desktop bearer token); the path
 * workspace is only a locator and the domain service decides every request
 * from the caller's live membership and verified provider capabilities. Every
 * unknown or cross-tenant workspace, and every membership the caller may not
 * see, produces the same 404.
 */

import type http from "node:http";

import type { AuthService } from "./auth-service.js";
import { requireEnterpriseSessionActor } from "./auth-http.js";
import { ApiError } from "./errors.js";
import { readJsonBody, requireString, writeJson } from "./http-util.js";
import type { WorkspaceMemberService } from "./workspace-member-service.js";

export interface WorkspaceMemberHttpDeps {
  auth: AuthService;
  members: WorkspaceMemberService;
}

export interface WorkspaceMemberRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

function pathSegment(segments: string[], index: number, label: string): string {
  const value = segments[index];
  if (value === undefined || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${label} is required`);
  }
  return value;
}

export function isWorkspaceMemberRoute(segments: string[]): boolean {
  return (
    segments[2] === "workspaces" &&
    (segments[4] === "members" || segments[4] === "member-candidates")
  );
}

export async function handleWorkspaceMemberRequest(
  deps: WorkspaceMemberHttpDeps,
  ctx: WorkspaceMemberRouteContext,
): Promise<void> {
  const { members, auth } = deps;
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";
  const workspaceId = pathSegment(segments, 3, "workspace_id");
  const session = requireEnterpriseSessionActor(auth, req);
  const actorUserId = session.user.id;

  // GET/POST /api/v1/workspaces/{workspace_id}/members
  if (segments[4] === "members" && segments.length === 5) {
    if (method === "GET") {
      writeJson(
        res,
        200,
        members.listMembers(actorUserId, workspaceId, url.searchParams.get("cursor")),
      );
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      writeJson(
        res,
        201,
        members.addMember(actorUserId, workspaceId, {
          user_id: requireString(body, "user_id"),
          role: requireString(body, "role"),
        }),
      );
      return;
    }
    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
  }

  // PATCH/DELETE /api/v1/workspaces/{workspace_id}/members/{membership_id}
  if (segments[4] === "members" && segments.length === 6) {
    const membershipId = pathSegment(segments, 5, "membership_id");
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      const version = body["version"];
      if (typeof version !== "number" || !Number.isInteger(version)) {
        throw new ApiError(400, "INVALID_REQUEST", "version is required and must be an integer");
      }
      writeJson(
        res,
        200,
        members.updateMember(actorUserId, workspaceId, membershipId, {
          role: requireString(body, "role"),
          version,
        }),
      );
      return;
    }
    if (method === "DELETE") {
      members.removeMember(actorUserId, workspaceId, membershipId);
      res.writeHead(204);
      res.end();
      return;
    }
    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
  }

  // GET /api/v1/workspaces/{workspace_id}/member-candidates
  if (segments[4] === "member-candidates" && segments.length === 5) {
    if (method !== "GET") {
      throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
    }
    writeJson(
      res,
      200,
      members.listCandidates(actorUserId, workspaceId, url.searchParams.get("cursor")),
    );
    return;
  }

  throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
}
