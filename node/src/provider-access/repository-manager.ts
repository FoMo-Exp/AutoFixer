/**
 * Who may administer a workspace's repositories (DAT-289, ADR-0011).
 *
 * Two surfaces ask the same question — the repository-addition preview /
 * confirmation / commit (DAT-284/286) and the approved-repository discovery
 * (DAT-289) — so the answer lives here once. Duplicating it would let a
 * disclosure surface authorize a broader caller than the change surface it
 * feeds.
 *
 * A repository manager is, all at once:
 *
 * - an **active account** (a suspended user is not an administrator),
 * - an **active enterprise membership** (workspace authority never outlives
 *   the enterprise relationship that granted it),
 * - a workspace **`owner` or `admin`** assignment (the assigned role is the
 *   administrative authority; `member`/`viewer` never decide a set change), and
 * - **verified `repository_manage` across every current repository** — the
 *   provider-proven capability, never a role name and never an enterprise
 *   administrator claim. Enterprise administration alone is not repository
 *   authority (ADR-0011).
 *
 * A caller that fails any condition is refused as `403
 * REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED` on both surfaces: one code for one
 * rule, so a client cannot learn a different story from each endpoint.
 *
 * The evaluation never persists a capability record (`persist: false`): reading
 * who may administer is not an action that may downgrade anyone.
 */

import { RepositorySetChangeError } from "../control-plane/errors.js";
import type { IdentityRepositories } from "../control-plane/identity-repositories.js";
import type { MembershipRepository } from "../control-plane/repositories.js";
import type { UserId, WorkspaceScope } from "../control-plane/types.js";
import type { CapabilityCeilingService } from "./capability-ceiling.js";

export interface RepositoryManagerDeps {
  memberships: MembershipRepository;
  identity: IdentityRepositories;
  capabilityCeilings: CapabilityCeilingService;
}

export interface RepositoryManagerGuard {
  /**
   * Refuse unless the actor may administer this workspace's repository set
   * right now. Throws
   * {@link RepositorySetChangeError} `REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED`.
   */
  require(scope: WorkspaceScope, actorUserId: UserId, now: Date): void;
}

export function createRepositoryManagerGuard(deps: RepositoryManagerDeps): RepositoryManagerGuard {
  const { memberships, identity, capabilityCeilings } = deps;

  function refuse(message: string): never {
    throw new RepositorySetChangeError("REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED", message, 403);
  }

  return {
    require(scope, actorUserId, now) {
      const user = identity.users.getById(actorUserId);
      if (user === undefined || user.status !== "active") {
        refuse("an active account is required to change a workspace repository set");
      }
      const enterpriseUser = identity.enterpriseUsers.getByUser(scope.enterprise_id, actorUserId);
      if (enterpriseUser === undefined || enterpriseUser.status !== "active") {
        refuse("an active enterprise membership is required to change a workspace repository set");
      }
      const membership = memberships.getByUser(scope, actorUserId);
      if (
        membership === undefined ||
        (membership.role !== "owner" && membership.role !== "admin")
      ) {
        refuse("workspace owner or admin authority is required to change the repository set");
      }
      const evaluation = capabilityCeilings.evaluate(scope, actorUserId, {
        now,
        persist: false,
      });
      if (
        evaluation.state !== "verified" ||
        !evaluation.capabilities.includes("repository_manage")
      ) {
        refuse(
          "the caller lacks verified repository management capability across every current repository",
        );
      }
    },
  };
}
