/**
 * Explicit task target repository (DAT-292, ADR-0011).
 *
 * A multi-repository workspace no longer has "the" repository: a task must
 * select one of the workspace's active bindings by immutable identity — the
 * provider instance, the approved installation and the provider-assigned
 * repository id — at the repository-set version the caller observed, and pin a
 * trusted base revision for it. Names, URLs, the first binding and the
 * deployment's configured repository are metadata or deployment defaults, never
 * selection authority.
 *
 * This module owns the selection contract only. It validates a request against
 * the verified set and returns the immutable target; it does not dispatch a
 * run, resolve checkout/delivery credentials or relax the rollout gate. The
 * workspace-scoped create path records the returned target on the task and
 * refuses any set this build cannot execute against, so the gate stays closed
 * until DAT-293 wires the execution path.
 */

import type { OrchestratorConfig } from "../config.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type {
  WorkspaceRepositoryBinding,
  WorkspaceRepositorySet,
  WorkspaceRepositorySetErrorCode,
} from "../control-plane/workspace-repository-types.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import { ApiError } from "./errors.js";

/**
 * The immutable target a task and every run it opens are bound to.
 *
 * Recorded at creation and never re-derived: `binding_id` names the exact
 * workspace binding row, the provider/installation/repository triple is the
 * immutable identity the binding was verified through, and `base_ref`/`base_sha`
 * are the trusted baseline pinned for that repository. `set_version` makes the
 * decision representable only against the set it was formed under.
 */
export interface TaskTarget {
  binding_id: string;
  repository_id: string;
  provider_instance_id: string;
  /** Approved active installation, or null in the local-prototype binding. */
  installation_ref: string | null;
  base_ref: string;
  base_sha: string;
  set_version: number;
  /** When the binding and its baseline were last verified for this selection. */
  verified_at: string;
}

/**
 * A client's explicit selection on the workspace-scoped create route.
 *
 * Every identity field is required. `installation_ref` is null only for a
 * binding with no installation (local-prototype mode). `expected_set_version`
 * is the version the client observed when it listed targets; a create against
 * any other version is refused rather than re-resolved from a newer set.
 */
export interface TaskTargetSelection {
  repository_id: string;
  provider_instance_id: string;
  installation_ref: string | null;
  base_ref: string;
  expected_set_version: number;
  /**
   * Optional assertion of the baseline the client observed. It never supplies
   * the baseline: a mismatch with the trusted value is a conflict, and the
   * trusted value is what the task records.
   */
  expected_base_sha?: string;
}

/** One selectable target and the availability of its trusted baseline. */
export interface TaskTargetCandidate {
  binding_id: string;
  repository_id: string;
  provider_instance_id: string;
  installation_ref: string | null;
  /** Display metadata only; null when the binding has no recorded name. */
  repository_name: string | null;
  /** 1-based position in the workspace set; never selection authority. */
  position: number;
  baseline:
    | {
        state: "trusted";
        base_ref: string;
        base_sha: string;
      }
    | {
        state: "unavailable";
        base_ref: null;
        base_sha: null;
        reason: "baseline_not_pinned";
      };
}

/** The read surface a client uses to offer an explicit selection. */
export interface TaskTargetList {
  workspace_id: string;
  repository_set_version: number;
  multi_repository: boolean;
  /** True when the create route requires an explicit target selection. */
  selection_required: boolean;
  /** False while this build cannot execute against the set (rollout gate). */
  usable: boolean;
  blocked_reason: WorkspaceRepositorySetErrorCode | null;
  targets: TaskTargetCandidate[];
}

/**
 * The trusted baseline for one binding.
 *
 * DAT-292 ships the deployment's pinned repository only. Resolving a baseline
 * for another repository needs the provider checkout path and belongs to
 * DAT-293; returning null here is the honest "this deployment cannot pin it",
 * never a fabricated SHA.
 */
export interface TaskTargetBaselines {
  resolve(
    binding: WorkspaceRepositoryBinding,
    requestedBaseRef?: string,
  ): { base_ref: string; base_sha: string; repository_url: string } | null;
}

/** The deployment pin, for the one repository this process can pin. */
export function pinnedTaskTargetBaselines(config: OrchestratorConfig): TaskTargetBaselines {
  return {
    resolve(binding, requestedBaseRef) {
      if (binding.repository_id !== config.repositoryId) {
        return null;
      }
      if (requestedBaseRef !== undefined && requestedBaseRef !== config.baseRef) {
        return null;
      }
      return {
        base_ref: config.baseRef,
        base_sha: config.baseSha,
        repository_url: config.repositoryUrl,
      };
    },
  };
}

export interface ResolvedTaskTarget {
  binding: WorkspaceRepositoryBinding;
  baseline: { base_ref: string; base_sha: string; repository_url: string };
  target: TaskTarget;
}

/**
 * Validate one explicit selection against the verified set and mint the
 * immutable target.
 *
 * Refuses (never falls back):
 * - unknown or retired repository → `REPOSITORY_NOT_IN_WORKSPACE` (400);
 * - a provider instance or installation that is not the binding's own
 *   immutable identity → `TARGET_IDENTITY_MISMATCH` (409);
 * - a set version other than the observed one → `REPOSITORY_SET_VERSION_CONFLICT`
 *   (409);
 * - a base ref the deployment cannot pin, or a baseline assertion that
 *   disagrees with the trusted value → `REPOSITORY_BINDING_UNAVAILABLE` /
 *   `BASE_REF_NOT_SUPPORTED` / `TARGET_BASELINE_MISMATCH` (409).
 *
 * The caller still decides whether the set is usable for execution; this
 * function deliberately reports the target of a set whose gate is closed so
 * the refusal can name the gate instead of pretending the target is invalid.
 */
export function resolveTaskTargetSelection(
  set: WorkspaceRepositorySet,
  selection: TaskTargetSelection,
  baselines: TaskTargetBaselines,
  now: () => Date = () => new Date(),
): ResolvedTaskTarget {
  const binding = set.bindings.find(
    (candidate) =>
      candidate.status === "active" && candidate.repository_id === selection.repository_id,
  );
  if (binding === undefined) {
    throw new ApiError(
      400,
      "REPOSITORY_NOT_IN_WORKSPACE",
      "repository_id is not an active repository of this workspace",
      { repository_id: selection.repository_id },
    );
  }
  if (binding.provider_instance_id !== selection.provider_instance_id) {
    throw new ApiError(
      409,
      "TARGET_IDENTITY_MISMATCH",
      "provider_instance_id is not the provider instance of this repository binding",
    );
  }
  if (binding.installation_ref !== selection.installation_ref) {
    throw new ApiError(
      409,
      "TARGET_IDENTITY_MISMATCH",
      "installation_ref is not the approved installation of this repository binding",
    );
  }
  if (set.set_version !== selection.expected_set_version) {
    throw new ApiError(
      409,
      "REPOSITORY_SET_VERSION_CONFLICT",
      `Workspace repository set changed (expected version ${selection.expected_set_version}, found ${set.set_version}); re-read the targets before creating`,
      {
        expected_set_version: selection.expected_set_version,
        actual_set_version: set.set_version,
      },
    );
  }
  const baseline = baselines.resolve(binding, selection.base_ref);
  if (baseline === null) {
    throw new ApiError(
      409,
      "REPOSITORY_BINDING_UNAVAILABLE",
      "This deployment has no trusted pinned baseline for the selected repository and base revision",
      { repository_id: binding.repository_id },
    );
  }
  if (
    selection.expected_base_sha !== undefined &&
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
  return {
    binding,
    baseline,
    target: {
      binding_id: binding.id,
      repository_id: binding.repository_id,
      provider_instance_id: binding.provider_instance_id,
      installation_ref: binding.installation_ref,
      base_ref: baseline.base_ref,
      base_sha: baseline.base_sha,
      set_version: set.set_version,
      verified_at: now().toISOString(),
    },
  };
}

/** Project the set's active bindings into the selection read contract. */
export function listTaskTargetCandidates(
  set: WorkspaceRepositorySet,
  baselines: TaskTargetBaselines,
): TaskTargetList {
  return {
    workspace_id: set.workspace_id,
    repository_set_version: set.set_version,
    multi_repository: set.multi_repository,
    selection_required: set.multi_repository,
    usable: set.usable,
    blocked_reason: set.blocked_reason,
    targets: set.bindings
      .filter((binding) => binding.status === "active")
      .map((binding) => {
        const baseline = baselines.resolve(binding);
        return {
          binding_id: binding.id,
          repository_id: binding.repository_id,
          provider_instance_id: binding.provider_instance_id,
          installation_ref: binding.installation_ref,
          repository_name: binding.repository_name,
          position: binding.position,
          baseline:
            baseline === null
              ? {
                  state: "unavailable" as const,
                  base_ref: null,
                  base_sha: null,
                  reason: "baseline_not_pinned" as const,
                }
              : {
                  state: "trusted" as const,
                  base_ref: baseline.base_ref,
                  base_sha: baseline.base_sha,
                },
        };
      }),
  };
}

export interface TaskTargetServiceDeps {
  config: OrchestratorConfig;
  repositorySets: WorkspaceRepositorySetRepository;
}

/** Read the workspace's selectable targets behind the authenticated route. */
export class TaskTargetService {
  private readonly deps: TaskTargetServiceDeps;
  private readonly baselines: TaskTargetBaselines;

  constructor(deps: TaskTargetServiceDeps) {
    this.deps = deps;
    this.baselines = pinnedTaskTargetBaselines(deps.config);
  }

  list(workspaceId: string): TaskTargetList {
    const scope = {
      enterprise_id: this.deps.config.enterpriseId,
      actor_id: this.deps.config.actorId,
      workspace_id: workspaceId,
    };
    try {
      const set = this.deps.repositorySets.getSet(scope);
      // An archived workspace's retired set describes history, not something a
      // task can target. Refuse the selection read instead of offering rows
      // whose create would be refused later.
      if (set.blocked_reason === "WORKSPACE_ARCHIVED") {
        throw new ApiError(403, "WORKSPACE_ARCHIVED", "This workspace is archived");
      }
      return listTaskTargetCandidates(set, this.baselines);
    } catch (error) {
      if (error instanceof WorkspaceRepositorySetError) {
        throw new ApiError(error.status, error.code, error.message);
      }
      throw error;
    }
  }
}
