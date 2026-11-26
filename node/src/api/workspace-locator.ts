/**
 * The workspace locator shared by the repository-administration surfaces
 * (DAT-286/289).
 *
 * A path workspace id is never authority: it only selects which live membership
 * to evaluate. An unknown workspace, another enterprise's workspace and a
 * workspace the caller holds no membership in are one indistinguishable 404, so
 * no route can be used to enumerate workspaces or discover that a foreign one
 * exists.
 *
 * The domain refusals those surfaces raise keep their stable codes and
 * 403/409/500 semantics; this module maps them onto the HTTP error without
 * reinterpreting them, so a refusal can never become a partial success.
 */

import { RepositorySetChangeError, WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { ControlPlaneRepositories } from "../control-plane/repositories.js";
import type { EnterpriseId, UserId, WorkspaceScope } from "../control-plane/types.js";
import { ApiError } from "./errors.js";

export function resolveWorkspaceScope(
  repos: ControlPlaneRepositories,
  enterpriseId: EnterpriseId,
  actorUserId: UserId,
  workspaceId: string,
): WorkspaceScope {
  if (workspaceId.length === 0) {
    throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
  }
  const scope: WorkspaceScope = {
    enterprise_id: enterpriseId,
    workspace_id: workspaceId,
    actor_id: actorUserId,
  };
  const workspace = repos.workspaces.getById(scope, workspaceId);
  const membership = repos.memberships.getByUser(scope, actorUserId);
  if (workspace === undefined || membership === undefined) {
    throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
  }
  return scope;
}

/** Re-raise a domain repository refusal as its HTTP equivalent. */
export function rethrowRepositoryDomainError(error: unknown): never {
  if (error instanceof ApiError) {
    throw error;
  }
  if (error instanceof RepositorySetChangeError) {
    throw new ApiError(error.status, error.code, error.message, error.details);
  }
  if (error instanceof WorkspaceRepositorySetError) {
    throw new ApiError(error.status, error.code, error.message, error.details);
  }
  throw error;
}
