/**
 * Workspace repository-addition surface: preview, confirmation and commit
 * (DAT-286, ADR-0011).
 *
 * This is the API half of the DAT-284 change service. It owns exactly two
 * things the domain service does not:
 *
 * 1. **Locator resolution.** The path workspace is only a locator: it selects
 *    which live membership to evaluate. An unknown workspace and a workspace
 *    the caller holds no membership in are the same 404, so the route cannot
 *    enumerate workspaces.
 * 2. **Disclosure.** Every response is a safe projection: no credentials,
 *    provider subjects, repository URLs or repository names. The preview is
 *    only produced for an actor the change service authorizes as a manager
 *    with verified repository management across the whole current set; a
 *    caller who cannot see the full impact is refused rather than shown a
 *    redacted preview, because a redacted preview is not informed consent.
 *
 * What it deliberately does not do: it never decides admissibility itself, and
 * it never commits outside the domain service's single revalidating
 * transaction. Dispatch, expiry, staleness, last-owner protection, audit
 * atomicity and the rollout gate all stay in the domain layer.
 */

import { RepositorySetChangeError, WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { RepositoryCapability } from "../control-plane/member-capability-types.js";
import type { ControlPlaneRepositories } from "../control-plane/repositories.js";
import type {
  CommitRepositorySetAdditionResult,
  ConfirmedReduction,
  RepositorySetAdditionBinding,
  RepositorySetAdditionConfirmation,
} from "../control-plane/repository-set-change-types.js";
import type {
  EnterpriseId,
  UserId,
  WorkspaceRole,
  WorkspaceScope,
} from "../control-plane/types.js";
import { ApiError } from "./errors.js";
import type {
  RepositorySetAdditionPreview,
  RepositorySetChangeService,
} from "../provider-access/repository-set-change.js";

// ---------------------------------------------------------------------------
// Requests and views
// ---------------------------------------------------------------------------

export interface RepositorySetAdditionProposalRequest {
  /** The set version the caller observed, when it has one. */
  expected_set_version: number | null;
  additional_repositories: RepositorySetAdditionBinding[];
}

export interface RepositorySetAdditionConfirmRequest extends RepositorySetAdditionProposalRequest {
  /** Exactly the reductions the preview showed the actor. */
  confirmed_reductions: ConfirmedReduction[];
  /** Optional bounded validity override for the recorded confirmation. */
  ttl_ms?: number;
}

/**
 * One member's confirmed impact, as returned by the confirm endpoint.
 *
 * The assigned role is reported separately from the capability ceiling, and a
 * non-retaining member is never confirmed (the confirmation is refused), so
 * this view always describes a member who keeps admission.
 */
export interface RepositorySetAdditionConfirmationMemberView {
  membership_id: string;
  user_id: UserId;
  role: WorkspaceRole;
  retains_admission: boolean;
  proposed_capabilities: RepositoryCapability[];
  reduction: RepositoryCapability[];
}

export interface RepositorySetAdditionConfirmationView {
  confirmation_id: string;
  workspace_id: string;
  set_version: number;
  proposed_repositories: Array<{
    provider_instance_id: string;
    repository_id: string;
  }>;
  members: RepositorySetAdditionConfirmationMemberView[];
  owners: Array<{ user_id: UserId; effective: boolean }>;
  last_owner_survives: boolean;
  all_members_retain_admission: boolean;
  evidence_complete: boolean;
  impact: RepositorySetAdditionConfirmation["impact"];
  checked_at: string;
  expires_at: string;
  created_at: string;
  /** Always false: a confirmation is evidence of a decision, not a grant. */
  authorizes_access: false;
  consumed_at: string | null;
}

export interface CommitRepositorySetAdditionView {
  workspace_id: string;
  confirmation_id: string;
  set_version_before: number;
  set_version_after: number;
  repositories: Array<{ provider_instance_id: string; repository_id: string }>;
  members_reduced: Array<{ user_id: UserId; capabilities: RepositoryCapability[] }>;
  grants_revoked: number;
  effective_owners: UserId[];
  committed_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RepositorySetChangeApiDeps {
  repos: ControlPlaneRepositories;
  changes: RepositorySetChangeService;
  enterpriseId: EnterpriseId;
}

export class WorkspaceRepositorySetChangeService {
  readonly #repos: ControlPlaneRepositories;
  readonly #changes: RepositorySetChangeService;
  readonly #enterpriseId: EnterpriseId;

  constructor(deps: RepositorySetChangeApiDeps) {
    this.#repos = deps.repos;
    this.#changes = deps.changes;
    this.#enterpriseId = deps.enterpriseId;
  }

  /** Preview one proposed addition. Writes nothing. */
  preview(
    actorUserId: UserId,
    workspaceId: string,
    input: RepositorySetAdditionProposalRequest,
  ): RepositorySetAdditionPreview {
    const scope = this.#scope(actorUserId, workspaceId);
    return this.#guard(() =>
      this.#changes.previewAddition(scope, {
        actor_user_id: actorUserId,
        ...(input.expected_set_version !== null
          ? { expected_set_version: input.expected_set_version }
          : {}),
        additional_repositories: input.additional_repositories,
      }),
    );
  }

  /** Record the actor's explicit confirmation of the exact previewed impact. */
  confirm(
    actorUserId: UserId,
    workspaceId: string,
    input: RepositorySetAdditionConfirmRequest,
  ): RepositorySetAdditionConfirmationView {
    const scope = this.#scope(actorUserId, workspaceId);
    const expectedSetVersion = input.expected_set_version;
    if (expectedSetVersion === null) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "expected_set_version is required to confirm a repository addition",
      );
    }
    const confirmation = this.#guard(() =>
      this.#changes.recordAdditionConfirmation(scope, {
        actor_user_id: actorUserId,
        expected_set_version: expectedSetVersion,
        additional_repositories: input.additional_repositories,
        confirmed_reductions: input.confirmed_reductions,
        ...(input.ttl_ms !== undefined ? { ttl_ms: input.ttl_ms } : {}),
      }),
    );
    return confirmationView(confirmation);
  }

  /** Commit the confirmation atomically after re-authorizing and revalidating. */
  commit(
    actorUserId: UserId,
    workspaceId: string,
    confirmationId: string,
  ): CommitRepositorySetAdditionView {
    const scope = this.#scope(actorUserId, workspaceId);
    if (confirmationId.length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", "confirmation_id is required");
    }
    const result = this.#guard(() =>
      this.#changes.commitAddition(scope, {
        actor_user_id: actorUserId,
        confirmation_id: confirmationId,
      }),
    );
    return commitView(result);
  }

  /**
   * The path workspace is a locator: an unknown workspace, a workspace in
   * another enterprise and a workspace the caller holds no membership in are
   * one indistinguishable 404.
   */
  #scope(actorUserId: UserId, workspaceId: string): WorkspaceScope {
    if (workspaceId.length === 0) {
      throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
    }
    const scope: WorkspaceScope = {
      enterprise_id: this.#enterpriseId,
      workspace_id: workspaceId,
      actor_id: actorUserId,
    };
    const workspace = this.#repos.workspaces.getById(scope, workspaceId);
    const membership = this.#repos.memberships.getByUser(scope, actorUserId);
    if (workspace === undefined || membership === undefined) {
      throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
    }
    return scope;
  }

  /**
   * Domain refusals keep their stable codes and 403/409/500 semantics. A
   * refusal never partially commits: the domain transaction rolled back.
   */
  #guard<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
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
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * A recorded confirmation as the API reports it. The stored confirmation holds
 * the proposed repositories' immutable identities only, so this projection
 * cannot leak a repository URL or name.
 */
export function confirmationView(
  confirmation: RepositorySetAdditionConfirmation,
): RepositorySetAdditionConfirmationView {
  return {
    confirmation_id: confirmation.id,
    workspace_id: confirmation.workspace_id,
    set_version: confirmation.set_version,
    proposed_repositories: confirmation.proposed_bindings.map((binding) => ({
      provider_instance_id: binding.provider_instance_id,
      repository_id: binding.repository_id,
    })),
    members: confirmation.members.map((member) => ({
      membership_id: member.membership_id,
      user_id: member.user_id,
      role: member.role,
      retains_admission: member.retains_admission,
      proposed_capabilities: member.proposed_capabilities,
      reduction: member.reduction,
    })),
    owners: confirmation.owners.map((owner) => ({
      user_id: owner.user_id,
      effective: owner.effective,
    })),
    last_owner_survives: confirmation.last_owner_survives,
    all_members_retain_admission: confirmation.all_members_retain_admission,
    evidence_complete: confirmation.evidence_complete,
    impact: confirmation.impact,
    checked_at: confirmation.checked_at,
    expires_at: confirmation.expires_at,
    created_at: confirmation.created_at,
    authorizes_access: false,
    consumed_at: confirmation.consumed_at,
  };
}

export function commitView(
  result: CommitRepositorySetAdditionResult,
): CommitRepositorySetAdditionView {
  return {
    workspace_id: result.workspace_id,
    confirmation_id: result.confirmation_id,
    set_version_before: result.set_version_before,
    set_version_after: result.set_version_after,
    repositories: result.repositories,
    members_reduced: result.members_reduced,
    grants_revoked: result.grants_revoked,
    effective_owners: result.effective_owners,
    committed_at: result.committed_at,
  };
}
