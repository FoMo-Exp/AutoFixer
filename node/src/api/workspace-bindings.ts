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
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { Workspace } from "../control-plane/types.js";
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
  /**
   * The workspace's versioned repository set (DAT-281). A deployment that
   * cannot prove a workspace binds exactly one repository must not dispatch a
   * run against it, so this is a required dependency, not an optional check.
   */
  repositorySets: WorkspaceRepositorySetRepository;
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
      // The set is the authority from here on, not the snapshot above: a
      // repository transfer on another connection can commit between the two
      // reads, and the verified binding is the only value that is guaranteed to
      // match the set version the authorization is formed against. The stale
      // snapshot is never used to decide which repository to dispatch.
      const scoped = requireSingleRepositoryBinding(deps, workspace);
      if (scoped.binding.repository_id !== deps.config.repositoryId) {
        throw new ApiError(
          409,
          "REPOSITORY_BINDING_UNAVAILABLE",
          "This deployment has no pinned base revision for the workspace's repository",
        );
      }
      // Re-read the set at the version just validated: if a transfer committed
      // while this binding was resolved, the decision is stale and refused
      // rather than dispatched against either repository.
      try {
        deps.repositorySets.getSetAtVersion(
          {
            enterprise_id: deps.config.enterpriseId,
            actor_id: deps.config.actorId,
            workspace_id: scoped.workspace_id,
          },
          scoped.set_version,
        );
      } catch (error) {
        if (error instanceof WorkspaceRepositorySetError) {
          throw new ApiError(error.status, error.code, error.message);
        }
        throw error;
      }
      return {
        enterpriseId: scoped.enterprise_id,
        workspaceId: scoped.workspace_id,
        repositoryId: scoped.binding.repository_id,
        repositoryUrl: deps.config.repositoryUrl,
        baseRef: deps.config.baseRef,
        baseSha: deps.config.baseSha,
        // The verified set version is part of the binding: every later worker
        // step re-reads it, so the run cannot outlive a set change (DAT-285).
        setVersion: scoped.set_version,
      };
    },
  };
}

/**
 * Cross-check the workspace against its versioned repository set.
 *
 * The legacy single-repository path is unchanged for a workspace that binds
 * exactly one repository, but it is no longer the only evidence: a missing
 * binding, a binding that disagrees with the workspace's immutable identity, an
 * unapproved provider instance or installation, and a multi-repository set all
 * refuse here rather than letting a run proceed against one repository of
 * several (ADR-0011, DAT-281).
 *
 * The returned scope — set version plus verified binding — is what the caller
 * must dispatch against; the earlier workspace snapshot carries no authority.
 */
function requireSingleRepositoryBinding(deps: WorkspaceRunBindingDeps, workspace: Workspace) {
  try {
    return deps.repositorySets.requireSingleRepository({
      enterprise_id: deps.config.enterpriseId,
      actor_id: deps.config.actorId,
      workspace_id: workspace.id,
    });
  } catch (error) {
    if (error instanceof WorkspaceRepositorySetError) {
      // The read boundary's code and status are already the answer the caller
      // needs; nothing is rewritten into a generic failure.
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
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
