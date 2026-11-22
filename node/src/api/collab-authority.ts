import { digestOf } from "../collab/audit.js";
import type { ApprovalDirectory, ApprovalMemberFact } from "../collab/approval-service.js";
import type { CollabMachine } from "../collab/machine.js";
import type { WorkspaceScope } from "../collab/types.js";
import type { IdentityRepository, UserRepository } from "../control-plane/identity-repositories.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { MembershipRepository, WorkspaceRepository } from "../control-plane/repositories.js";
import type { WorkspaceRole } from "../control-plane/types.js";
import type { ServiceIntegration } from "../control-plane/provider-access-types.js";

/**
 * Serving-side authority facts for the collaboration delivery surface
 * (DAT-259).
 *
 * The candidate-bound approval service and the delivery broker never read the
 * control plane themselves: they ask a trusted caller for *current* facts. This
 * module is that caller in the running service, so the API inherits exactly
 * DAT-203's evidence instead of accepting client claims:
 *
 * - **Workspace scope** comes from the issue (enterprise + workspace), never
 *   from a client-supplied enterprise id.
 * - **Membership** is the live control-plane row; role `owner`/`admin` is the
 *   explicit delivery-approval authority (ADR-0007's "workspace-configured
 *   maintainers"). Assignee/blame/team-leader status is never consulted.
 * - **Repository access** is the current provider roster authority for the
 *   member's provider subject on the issue's repository. `removed`, `unknown`,
 *   a missing subject, or a verification older than the stale bound is not
 *   current access.
 * - **Delivery permission** (the broker's per-write `delivery_authorized`
 *   fact) is the live repository integration that still holds a delivery
 *   credential and declares it can observe effective permissions. No
 *   integration means delivery is blocked, never assumed.
 *
 * Nothing is cached: every fact is re-read at the moment it is needed, so a
 * revocation, role change, expired verification or suspended install takes
 * effect on the next request/write without an invalidation path.
 */

export const DEFAULT_APPROVAL_ROLES: readonly WorkspaceRole[] = Object.freeze(["owner", "admin"]);

/** One day: the bound after which a stored `active` verification is not current. */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ApprovalDirectoryDeps {
  enterprise_id: string;
  memberships: MembershipRepository;
  users: UserRepository;
  identities: IdentityRepository;
  access: ProviderAccessRepositories;
  /** Roles carrying explicit delivery-approval authority (default owner/admin). */
  approvalRoles?: readonly WorkspaceRole[];
  /** Verification age beyond which repository access is no longer current. */
  staleAfterMs?: number;
  clock?: () => Date;
}

function controlPlaneScope(scope: WorkspaceScope): WorkspaceScope & { actor_id: string } {
  return {
    enterprise_id: scope.enterprise_id,
    workspace_id: scope.workspace_id,
    actor_id: "collab-approval-directory",
  };
}

export function createApprovalDirectory(deps: ApprovalDirectoryDeps): ApprovalDirectory {
  const approvalRoles = deps.approvalRoles ?? DEFAULT_APPROVAL_ROLES;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = deps.clock ?? (() => new Date());

  function activeIntegrations(scope: WorkspaceScope, repositoryId: string): ServiceIntegration[] {
    return deps.access.integrations
      .listByWorkspace(controlPlaneScope(scope))
      .filter(
        (integration) =>
          integration.install_status === "active" && integration.repository_id === repositoryId,
      );
  }

  /**
   * Current repository access for one user: an active provider subject with a
   * verification inside the stale bound on an active integration bound to the
   * issue's repository. A partial or unverifiable roster grants nothing.
   */
  function repositoryAccess(scope: WorkspaceScope, repositoryId: string, userId: string): boolean {
    const identities = deps.identities.listByUser(userId);
    const at = now();
    for (const integration of activeIntegrations(scope, repositoryId)) {
      const subject = identities.find(
        (identity) => identity.provider_instance_id === integration.provider_instance_id,
      )?.subject;
      if (subject === undefined) {
        continue;
      }
      const authority = deps.access.roster.getAuthority(
        controlPlaneScope(scope),
        integration.id,
        subject,
      );
      if (authority === undefined || authority.state !== "active") {
        continue;
      }
      const verifiedAt =
        authority.last_verified_at === null ? Number.NaN : Date.parse(authority.last_verified_at);
      if (Number.isNaN(verifiedAt) || at.getTime() - verifiedAt > staleAfterMs) {
        continue;
      }
      return true;
    }
    return false;
  }

  function factFor(
    scope: WorkspaceScope,
    repositoryId: string,
    userId: string,
  ): ApprovalMemberFact | null {
    const user = deps.users.getById(userId);
    if (user === undefined) {
      return null;
    }
    const membership = deps.memberships.getByUser(controlPlaneScope(scope), userId);
    if (membership === undefined) {
      return null;
    }
    return {
      user_id: user.id,
      display_name: user.display_name,
      role: membership.role,
      status: user.status,
      repository_access: repositoryAccess(scope, repositoryId, userId),
      approval_authority: approvalRoles.includes(membership.role),
    };
  }

  function memberFacts(scope: WorkspaceScope, repositoryId: string): ApprovalMemberFact[] {
    return deps.memberships
      .list(controlPlaneScope(scope))
      .map((membership) => factFor(scope, repositoryId, membership.user_id))
      .filter((fact): fact is ApprovalMemberFact => fact !== null)
      .sort((a, b) => a.user_id.localeCompare(b.user_id));
  }

  return {
    /**
     * Digest over the exact directory facts, recorded on every approval
     * decision. It changes when authority changes, so a replayed or late
     * decision against different facts is distinguishable in the audit log.
     */
    authorityVersion(scope: WorkspaceScope, repositoryId: string): string {
      const integrations = activeIntegrations(scope, repositoryId).map((integration) => ({
        integration_id: integration.id,
        permission_visibility: integration.permission_visibility,
        delivery_credential: integration.delivery_credential_ref !== null,
      }));
      return digestOf({
        directory: "provider-access-v1",
        enterprise_id: scope.enterprise_id,
        workspace_id: scope.workspace_id,
        repository_id: repositoryId,
        integrations,
        members: memberFacts(scope, repositoryId),
      });
    },

    members(scope: WorkspaceScope, repositoryId: string): ApprovalMemberFact[] {
      return memberFacts(scope, repositoryId);
    },

    member(scope: WorkspaceScope, repositoryId: string, userId: string): ApprovalMemberFact | null {
      return factFor(scope, repositoryId, userId);
    },
  };
}

export interface DeliveryPermissionDeps {
  machine: CollabMachine;
  access: ProviderAccessRepositories;
  workspaces: WorkspaceRepository;
  enterprise_id: string;
  /**
   * Live re-check of the *requester's* repository capability (DAT-276). The
   * delivery request recorded `requester_authorized`, but a recorded boolean is
   * not a durable fact: every provider write asks again, so a confirmed
   * downgrade between request and write stops the delivery instead of pushing
   * a change the requester can no longer read the repository for.
   *
   * Returns `true` only when the requester's ceiling still supports repository
   * write in this workspace. Absent, delivery uses the pre-DAT-276 behavior
   * (delivery-grant-only), which is why the deployment wires it.
   */
  requesterCapability?: (input: { workspace_id: string; user_id: string }) => boolean;
}

/**
 * The broker's per-write delivery-permission fact.
 *
 * It is evaluated immediately before each provider write (and each recorded
 * state transition) and answers one question: does this workspace still hold a
 * live, delivery-capable integration for the delivered repository? A
 * suspended/uninstalled install, an archived workspace, a repository the
 * integration no longer binds, `permission_visibility: none`, or a missing
 * delivery credential all answer `false`, which blocks the write rather than
 * guessing.
 *
 * The *requester's* authority was verified when the delivery operation was
 * requested (the API's `delivery` action gate + the recorded
 * `requester_authorized` flag), and the addressed approver's authority is
 * re-observed separately by the broker on every write.
 */
export function createDeliveryPermission(
  deps: DeliveryPermissionDeps,
): (input: {
  issue_id: string;
  repository_id: string;
  delivery_id: string;
  grant_id: string;
}) => boolean {
  return (input) => {
    const issue = deps.machine.getIssue(input.issue_id);
    if (issue === undefined || issue.repository.repository_id !== input.repository_id) {
      return false;
    }
    const workspaceScope = {
      enterprise_id: deps.enterprise_id,
      workspace_id: issue.workspace.workspace_id,
      actor_id: "collab-delivery-permission",
    };
    const workspace = deps.workspaces.getById(workspaceScope, workspaceScope.workspace_id);
    if (workspace === undefined || workspace.status !== "active") {
      return false;
    }
    const integrations = deps.access.integrations
      .listByWorkspace(workspaceScope)
      .filter(
        (integration) =>
          integration.install_status === "active" &&
          integration.repository_id === input.repository_id,
      );
    const workspaceAuthorized = integrations.some(
      (integration) =>
        integration.delivery_credential_ref !== null &&
        integration.permission_visibility !== "none",
    );
    if (!workspaceAuthorized) {
      return false;
    }
    if (deps.requesterCapability === undefined) {
      return true;
    }
    // The grant names the requester the delivery was authorized for. Without a
    // resolved requester there is nothing to re-check, so delivery fails closed.
    const grant = deps.access.grants.getById(workspaceScope, input.grant_id);
    if (grant === undefined || grant.grantee_user_id === null) {
      return false;
    }
    return deps.requesterCapability({
      workspace_id: workspaceScope.workspace_id,
      user_id: grant.grantee_user_id,
    });
  };
}
