/**
 * Authoritative workspace → run-binding resolution (DAT-245).
 *
 * A task's repository, base revision, and gateway scope come from the
 * workspace that owns it. This module is the one place that derives those
 * values for the workspace-scoped create route; a workspace whose binding
 * cannot be fully resolved fails closed with a stable error instead of
 * falling back to the deployment's configured repository or workspace.
 */

import type { OrchestratorConfig } from "../config.js";
import type {
  ProviderInstanceRepository,
  WorkspaceRepository,
} from "../control-plane/repositories.js";
import { ApiError } from "./errors.js";
import {
  deploymentRunBinding,
  type WorkspaceRunBinding,
  type WorkspaceRunBindingResolver,
} from "./task-service.js";

export interface WorkspaceRunBindingDeps {
  config: OrchestratorConfig;
  workspaces: WorkspaceRepository;
  providerInstances: ProviderInstanceRepository;
}

/**
 * Resolve from the control-plane binding. The workspace row is the authority
 * for repository and provider instance; the deployment supplies the pinned
 * base revision only for the repository it actually pins. Another repository
 * has no known base revision here, so creation is refused rather than
 * dispatching a run against a fabricated revision.
 */
export function createWorkspaceRunBindingResolver(
  deps: WorkspaceRunBindingDeps,
): WorkspaceRunBindingResolver {
  const enterpriseScope = {
    enterprise_id: deps.config.enterpriseId,
    actor_id: deps.config.actorId,
  };
  return {
    resolve(workspaceId: string): WorkspaceRunBinding {
      const workspace = deps.workspaces.getById(enterpriseScope, workspaceId);
      if (workspace === undefined || workspace.status !== "active") {
        // Unknown, archived, and cross-enterprise are one answer: the
        // workspace locator itself never reveals another scope.
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      }
      const provider = deps.providerInstances.getById(
        enterpriseScope,
        workspace.provider_instance_id,
      );
      if (provider === undefined) {
        // A workspace may only bind an administrator-registered instance; a
        // missing instance means the binding is no longer approved.
        throw new ApiError(
          409,
          "PROVIDER_INSTANCE_NOT_APPROVED",
          "The workspace's provider instance is not registered for this enterprise",
        );
      }
      if (workspace.repository_id !== deps.config.repositoryId) {
        throw new ApiError(
          409,
          "REPOSITORY_BINDING_UNAVAILABLE",
          "This deployment has no pinned base revision for the workspace's repository",
        );
      }
      return {
        enterpriseId: workspace.enterprise_id,
        workspaceId: workspace.id,
        repositoryId: deps.config.repositoryId,
        repositoryUrl: deps.config.repositoryUrl,
        baseRef: deps.config.baseRef,
        baseSha: deps.config.baseSha,
      };
    },
  };
}

/**
 * Identity-less deployments (local operator only) have exactly one workspace
 * and one repository: the configured pair. Any other locator is unknown.
 */
export function createConfiguredWorkspaceRunBindingResolver(
  config: OrchestratorConfig,
): WorkspaceRunBindingResolver {
  const binding = deploymentRunBinding(config);
  return {
    resolve(workspaceId: string): WorkspaceRunBinding {
      if (workspaceId !== binding.workspaceId) {
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      }
      return binding;
    },
  };
}
