/**
 * Authoritative workspace → run-binding resolution (DAT-245, DAT-292).
 *
 * A task's repository, base revision, target and gateway scope come from the
 * workspace that owns it. This module is the one place that derives those
 * values for the workspace-scoped create route; a workspace whose binding
 * cannot be fully resolved fails closed with a stable error instead of
 * falling back to the deployment's configured repository or workspace.
 *
 * DAT-292 adds the explicit target: a multi-repository workspace must select
 * one of its active bindings by immutable identity, at the set version the
 * caller observed. The task records that target; execution against it still
 * requires the rollout gate to be opened by a release that enforces it
 * (DAT-293).
 */

import type { OrchestratorConfig } from "../config.js";
import type {
  ProviderInstanceRepository,
  WorkspaceRepository,
} from "../control-plane/repositories.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type {
  WorkspaceRepositoryBinding,
  WorkspaceRepositorySet,
} from "../control-plane/workspace-repository-types.js";
import type { Workspace } from "../control-plane/types.js";
import { ApiError } from "./errors.js";
import {
  deploymentRunBinding,
  type WorkspaceRunBinding,
  type WorkspaceRunBindingResolver,
} from "./task-service.js";
import {
  pinnedTaskTargetBaselines,
  resolveTaskTargetSelection,
  type TaskTarget,
  type TaskTargetBaselines,
  type TaskTargetSelection,
} from "./task-targets.js";

export interface WorkspaceRunBindingDeps {
  config: OrchestratorConfig;
  workspaces: WorkspaceRepository;
  providerInstances: ProviderInstanceRepository;
  /**
   * The workspace's versioned repository set (DAT-281). A deployment that
   * cannot prove the selected target against the set must not dispatch a run
   * against it, so this is a required dependency, not an optional check.
   */
  repositorySets: WorkspaceRepositorySetRepository;
  /**
   * Trusted baseline resolution (DAT-292). Defaults to the deployment pin;
   * DAT-293 supplies the provider checkout path for other repositories.
   */
  baselines?: TaskTargetBaselines;
}

/**
 * Resolve from the control-plane binding.
 *
 * Without a selection the legacy single-repository path applies: exactly one
 * verified binding, which must be the deployment's pinned repository (the only
 * baseline this build can prove). With a selection the target is validated by
 * immutable identity and observed set version, and the set must still be one
 * this build can execute against — the multi-repository gate stays closed.
 */
export function createWorkspaceRunBindingResolver(
  deps: WorkspaceRunBindingDeps,
): WorkspaceRunBindingResolver {
  const enterpriseScope = {
    enterprise_id: deps.config.enterpriseId,
    actor_id: deps.config.actorId,
  };
  const baselines = deps.baselines ?? pinnedTaskTargetBaselines(deps.config);
  return {
    resolve(workspaceId: string, selection?: TaskTargetSelection): WorkspaceRunBinding {
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
      if (selection !== undefined) {
        return resolveExplicitTarget(deps, baselines, workspace, selection);
      }
      return resolveLegacySingleRepository(deps, baselines, workspace);
    },
  };
}

/** The legacy path: one verified binding, the deployment's pinned baseline. */
function resolveLegacySingleRepository(
  deps: WorkspaceRunBindingDeps,
  baselines: TaskTargetBaselines,
  workspace: Workspace,
): WorkspaceRunBinding {
  // The set is the authority from here on, not the snapshot above: a
  // repository transfer on another connection can commit between the two
  // reads, and the verified binding is the only value that is guaranteed to
  // match the set version the authorization is formed against. The stale
  // snapshot is never used to decide which repository to dispatch.
  const scoped = requireSingleRepositoryBinding(deps, workspace);
  const baseline = baselines.resolve(scoped.binding);
  if (baseline === null || scoped.binding.repository_id !== deps.config.repositoryId) {
    throw new ApiError(
      409,
      "REPOSITORY_BINDING_UNAVAILABLE",
      "This deployment has no pinned base revision for the workspace's repository",
    );
  }
  // Re-read the set at the version just validated: if a transfer committed
  // while this binding was resolved, the decision is stale and refused rather
  // than dispatched against either repository.
  reassertSetVersion(deps, scoped.workspace_id, scoped.set_version);
  return {
    enterpriseId: scoped.enterprise_id,
    workspaceId: scoped.workspace_id,
    repositoryId: scoped.binding.repository_id,
    repositoryUrl: baseline.repository_url,
    baseRef: baseline.base_ref,
    baseSha: baseline.base_sha,
    // The verified set version is part of the binding: every later worker
    // step re-reads it, so the run cannot outlive a set change (DAT-285).
    setVersion: scoped.set_version,
    target: taskTargetFrom(scoped.binding, baseline, scoped.set_version),
  };
}

/** The explicit path: immutable identity at the observed set version. */
function resolveExplicitTarget(
  deps: WorkspaceRunBindingDeps,
  baselines: TaskTargetBaselines,
  workspace: Workspace,
  selection: TaskTargetSelection,
): WorkspaceRunBinding {
  const set = readSet(deps, workspace);
  const resolved = resolveTaskTargetSelection(set, selection, baselines);
  // The target is valid, but this build can only execute against a set whose
  // rollout gate and enforcement are open. The refusal names the gate, never
  // the target, so a stale or partial client selection is not blamed for a
  // deployment decision (DAT-288 blocker 1).
  if (!set.usable) {
    throw new ApiError(
      403,
      set.blocked_reason ?? "MULTI_REPOSITORY_SCOPE_DISABLED",
      "This workspace's repository set is not executable by this build; the multi-repository gate is closed",
      {
        workspace_id: set.workspace_id,
        binding_count: set.bindings.length,
        set_version: set.set_version,
        gate_state: set.gate.state,
      },
    );
  }
  // Re-read at the version just validated for the same reason as the legacy
  // path: a concurrent set change makes this decision unrepresentable.
  reassertSetVersion(deps, set.workspace_id, set.set_version);
  return {
    enterpriseId: set.enterprise_id,
    workspaceId: set.workspace_id,
    repositoryId: resolved.binding.repository_id,
    repositoryUrl: resolved.baseline.repository_url,
    baseRef: resolved.baseline.base_ref,
    baseSha: resolved.baseline.base_sha,
    setVersion: resolved.target.set_version,
    target: resolved.target,
  };
}

function readSet(deps: WorkspaceRunBindingDeps, workspace: Workspace): WorkspaceRepositorySet {
  try {
    return deps.repositorySets.getSet({
      enterprise_id: deps.config.enterpriseId,
      actor_id: deps.config.actorId,
      workspace_id: workspace.id,
    });
  } catch (error) {
    if (error instanceof WorkspaceRepositorySetError) {
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
}

function reassertSetVersion(
  deps: WorkspaceRunBindingDeps,
  workspaceId: string,
  setVersion: number,
): void {
  try {
    deps.repositorySets.getSetAtVersion(
      {
        enterprise_id: deps.config.enterpriseId,
        actor_id: deps.config.actorId,
        workspace_id: workspaceId,
      },
      setVersion,
    );
  } catch (error) {
    if (error instanceof WorkspaceRepositorySetError) {
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
}

function taskTargetFrom(
  binding: WorkspaceRepositoryBinding,
  baseline: { base_ref: string; base_sha: string },
  setVersion: number,
): TaskTarget {
  return {
    binding_id: binding.id,
    repository_id: binding.repository_id,
    provider_instance_id: binding.provider_instance_id,
    installation_ref: binding.installation_ref,
    base_ref: baseline.base_ref,
    base_sha: baseline.base_sha,
    set_version: setVersion,
    verified_at: new Date().toISOString(),
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
      // A multi-repository set without a selection is not a gate refusal the
      // caller can resolve by retrying: it must choose one active binding
      // (DAT-292). Every other read-boundary code/status is already the answer.
      if (
        error.code === "MULTI_REPOSITORY_SCOPE_DISABLED" ||
        error.code === "MULTI_REPOSITORY_SCOPE_UNSUPPORTED"
      ) {
        throw new ApiError(
          400,
          "TARGET_REPOSITORY_REQUIRED",
          "This workspace binds more than one repository; select an explicit target",
          { workspace_id: workspace.id },
        );
      }
      throw new ApiError(error.status, error.code, error.message);
    }
    throw error;
  }
}

/**
 * Identity-less deployments (local operator only) have exactly one workspace
 * and one repository: the configured pair. Any other locator is unknown, and
 * an explicit target selection has no versioned set to validate against.
 */
export function createConfiguredWorkspaceRunBindingResolver(
  config: OrchestratorConfig,
): WorkspaceRunBindingResolver {
  const binding = deploymentRunBinding(config);
  return {
    resolve(workspaceId: string, selection?: TaskTargetSelection): WorkspaceRunBinding {
      if (selection !== undefined) {
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "target selection requires the workspace-scoped task route",
        );
      }
      if (workspaceId !== binding.workspaceId) {
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      }
      return binding;
    },
  };
}
