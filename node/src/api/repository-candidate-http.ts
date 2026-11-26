/**
 * Approved-repository discovery route (DAT-289, ADR-0011).
 *
 * - `GET /api/v1/workspaces/{workspace_id}/repository-candidates`
 *
 * One read, no side effects: the route never creates an installation, a
 * binding, a confirmation or a grant, and it never opens the multi-repository
 * gate. The path workspace is a locator; authorization, tenant isolation,
 * restriction classification and the bounded-coverage disclosure are decided by
 * the service, never here.
 */

import type http from "node:http";

import type { AuthService } from "./auth-service.js";
import { requireEnterpriseSessionActor } from "./auth-http.js";
import { ApiError } from "./errors.js";
import { writeJson } from "./http-util.js";
import type { RepositoryCandidateService } from "./repository-candidate-service.js";

export interface RepositoryCandidateHttpDeps {
  auth: AuthService;
  candidates: RepositoryCandidateService;
}

export interface RepositoryCandidateRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  segments: string[];
  requestId: string;
}

export function isRepositoryCandidateRoute(segments: string[]): boolean {
  return (
    segments[2] === "workspaces" && segments.length === 5 && segments[4] === "repository-candidates"
  );
}

export async function handleRepositoryCandidateRequest(
  deps: RepositoryCandidateHttpDeps,
  ctx: RepositoryCandidateRouteContext,
): Promise<void> {
  const { candidates, auth } = deps;
  const { req, res, url, segments } = ctx;
  const method = req.method ?? "GET";
  if (method !== "GET") {
    throw new ApiError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
  }
  const workspaceId = segments[3];
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "workspace_id is required");
  }
  const actorUserId = requireEnterpriseSessionActor(auth, req).user.id;
  writeJson(
    res,
    200,
    candidates.discover(actorUserId, workspaceId, url.searchParams.get("cursor")),
  );
}
