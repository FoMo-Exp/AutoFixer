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
 * caller observed. The task records that target.
 *
 * DAT-293 adds the runtime path ({@link createAsyncWorkspaceRunBindingResolver}):
 * the target's trusted baseline is resolved from provider truth through its
 * approved checkout capability, and a workspace whose installation or
 * credentials cannot be proven is refused. The synchronous resolver stays the
 * legacy single-repository seam (issue sync, local operator) and is never used
 * to dispatch a multi-repository run.
 */

import type { OrchestratorConfig } from "../config.js";
import type {
  ProviderInstanceRepository,
  WorkspaceRepository,
} from "../control-plane/repositories.js";
import type { ServiceIntegrationRepository } from "../control-plane/provider-access-repositories.js";
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
  matchTaskTargetBinding,
  mintTaskTarget,
  pinnedTaskTargetBaselines,
  resolveTaskTargetSelection,
  type TaskTarget,
  type TaskTargetBaselines,
  type TaskTargetSelection,
  type TrustedBaselineResult,
  type TrustedBaselineResolver,
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
  assertSetExecutable(set);
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

/**
 * Refuse a set this build cannot execute against.
 *
 * The target may be perfectly valid; the refusal names the deployment decision
 * (the rollout gate or the set shape), never the caller's selection, so a stale
 * or partial client choice is not blamed for it (DAT-288 blocker 1).
 */
function assertSetExecutable(set: WorkspaceRepositorySet): void {
  if (set.usable) {
    return;
  }
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

// ---------------------------------------------------------------------------
// Runtime target resolution (DAT-293)
// ---------------------------------------------------------------------------

/**
 * The runtime resolver: the async counterpart of
 * {@link createWorkspaceRunBindingResolver} used by the workspace-scoped task
 * create path.
 *
 * It performs every check the synchronous resolver performs and then resolves
 * the selected binding's **trusted baseline** from provider truth: the
 * deployment pin for its own repository, the approved integration's checkout
 * capability for anything else. A multi-repository set additionally requires
 * the target's delivery capability, because a run against one repository of
 * several still has to deliver through that repository's own approval.
 */
export interface AsyncWorkspaceRunBindingDeps extends Omit<WorkspaceRunBindingDeps, "baselines"> {
  /** Provider-verified baselines (DAT-293). */
  trustedBaselines: TrustedBaselineResolver;
  /**
   * The workspace's service integrations, used to prove the target's delivery
   * capability for a multi-repository run. Unset keeps the delivery check off
   * (deployments without provider authority).
   */
  integrations?: ServiceIntegrationRepository;
}

export interface AsyncWorkspaceRunBindingResolver {
  resolve(workspaceId: string, selection?: TaskTargetSelection): Promise<WorkspaceRunBinding>;
}

/** Map an unavailable baseline onto the stable refusal it deserves. */
function baselineRefusal(baseline: TrustedBaselineResult): ApiError {
  if (baseline.state === "trusted") {
    throw new Error("baselineRefusal called with a trusted baseline");
  }
  const repositoryId = {
    base_ref: baseline.base_ref,
  };
  switch (baseline.reason) {
    case "integration_missing":
    case "installation_not_approved":
      return new ApiError(
        409,
        "TARGET_INSTALLATION_NOT_APPROVED",
        "The selected repository has no active approved installation for this workspace",
        repositoryId,
      );
    case "checkout_credential_missing":
      return new ApiError(
        409,
        "CHECKOUT_CREDENTIAL_UNAVAILABLE",
        "The selected repository has no approved checkout credential this deployment can use",
        repositoryId,
      );
    case "provider_unavailable":
      return new ApiError(
        503,
        "PROVIDER_UNAVAILABLE",
        "The provider could not be read to prove the selected base revision; nothing was bound",
        repositoryId,
        { retryable: true, next_action: "retry" },
      );
    case "ref_not_found":
      return new ApiError(
        409,
        "BASE_REF_NOT_SUPPORTED",
        "The selected base revision does not resolve in the target repository",
        repositoryId,
      );
    case "baseline_not_pinned":
    default:
      return new ApiError(
        409,
        "REPOSITORY_BINDING_UNAVAILABLE",
        "This deployment has no trusted pinned baseline for the selected repository and base revision",
        repositoryId,
      );
  }
}

/**
 * Prove the target's delivery capability for a multi-repository run.
 *
 * Single-repository workspaces keep their pre-DAT-293 behavior: an installation
 * without a delivery credential can still prepare a change (delivery is
 * refused later by the broker). A run that selects one repository of several
 * must have that repository's own delivery capability, because the workspace's
 * other repositories are not a substitute and the broker never falls back.
 */
function requireDeliveryCapability(
  deps: AsyncWorkspaceRunBindingDeps,
  set: WorkspaceRepositorySet,
  binding: WorkspaceRepositoryBinding,
): void {
  if (!set.multi_repository || deps.integrations === undefined) {
    return;
  }
  const integration = deps.integrations.getByRepository(
    {
      enterprise_id: deps.config.enterpriseId,
      actor_id: deps.config.actorId,
    },
    binding.repository_id,
  );
  if (
    integration !== undefined &&
    integration.workspace_id === binding.workspace_id &&
    integration.provider_instance_id === binding.provider_instance_id &&
    integration.install_status === "active" &&
    integration.delivery_credential_ref !== null &&
    integration.delivery_credential_ref.trim() !== ""
  ) {
    return;
  }
  throw new ApiError(
    409,
    "DELIVERY_CREDENTIAL_UNAVAILABLE",
    "The selected repository has no approved delivery capability in this workspace",
    { repository_id: binding.repository_id },
  );
}

/**
 * Resolve one workspace-scoped run binding, including its trusted baseline.
 *
 * Ordering is deliberate: workspace, approved provider instance, the set's
 * shape and gate, the selected immutable identity at the observed version, the
 * trusted baseline, the delivery capability, and a final re-read of the set
 * version. A failure at any step refuses the create — nothing is dispatched
 * against a repository the decision did not prove.
 */
export function createAsyncWorkspaceRunBindingResolver(
  deps: AsyncWorkspaceRunBindingDeps,
): AsyncWorkspaceRunBindingResolver {
  const enterpriseScope = {
    enterprise_id: deps.config.enterpriseId,
    actor_id: deps.config.actorId,
  };
  return {
    async resolve(workspaceId, selection): Promise<WorkspaceRunBinding> {
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
        throw new ApiError(
          409,
          "PROVIDER_INSTANCE_NOT_APPROVED",
          "The workspace's provider instance is not registered for this enterprise",
        );
      }

      const set = readSet(deps, workspace);
      let binding: WorkspaceRepositoryBinding;
      if (selection === undefined) {
        // No selection: the legacy single-repository shape. A multi-repository
        // set refuses with TARGET_REPOSITORY_REQUIRED instead of choosing one.
        binding = requireSingleRepositoryBinding(deps, workspace).binding;
      } else {
        binding = matchTaskTargetBinding(set, selection);
        assertSetExecutable(set);
      }

      const baseline = await deps.trustedBaselines.resolve(binding, selection?.base_ref);
      if (baseline.state !== "trusted") {
        throw baselineRefusal(baseline);
      }
      if (
        selection?.expected_base_sha !== undefined &&
        selection.expected_base_sha !== baseline.base_sha
      ) {
        throw new ApiError(
          409,
          "TARGET_BASELINE_MISMATCH",
          "The selected base revision no longer resolves to the observed commit; re-read the targets",
          {
            expected_base_sha: selection.expected_base_sha,
            actual_base_sha: baseline.base_sha,
          },
        );
      }
      requireDeliveryCapability(deps, set, binding);
      // The set may have moved while the provider answered. Re-read at the
      // version this decision was formed against; a concurrent change makes it
      // unrepresentable and refuses now rather than dispatching stale scope.
      reassertSetVersion(deps, set.workspace_id, set.set_version);

      return {
        enterpriseId: set.enterprise_id,
        workspaceId: set.workspace_id,
        repositoryId: binding.repository_id,
        repositoryUrl: baseline.repository_url,
        baseRef: baseline.base_ref,
        baseSha: baseline.base_sha,
        setVersion: set.set_version,
        target: mintTaskTarget(
          binding,
          { base_ref: baseline.base_ref, base_sha: baseline.base_sha },
          set.set_version,
        ),
      };
    },
  };
}
