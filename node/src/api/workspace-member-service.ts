/**
 * Workspace membership and member-candidate domain service (DAT-277, ADR-0006,
 * ADR-0011).
 *
 * This is the one implementation behind both the workspace member routes and
 * the legacy enterprise-administrator membership entry. It never trusts a
 * client-supplied scope: the path workspace only locates which live membership
 * to evaluate, and every mutation is decided from the authenticated actor's
 * own role plus the *provider-proven* repository capabilities of the target.
 *
 * ## Rules encoded here
 *
 * - **Real provider authority.** Administering a workspace requires an active
 *   repository-scoped integration and verified `repository_manage` capability
 *   across the whole repository set. Enterprise administration alone is not a
 *   repository authority, and a deployment without a roster cannot manage
 *   members at all — there is no role-only fallback.
 * - **Admission is provider-proven.** A user may join only when their verified
 *   capability intersection over every repository contains code read. A
 *   missing, stale, unknown, incomplete, unsupported or removed fact fails
 *   closed; it is never treated as an empty roster or an eligible candidate.
 * - **Role ceiling.** Viewer/member grants are bounded by the intersection:
 *   `repository_write` on every repository is required for `member`, otherwise
 *   the maximum is `viewer`. `admin`/`owner` are never derived from provider
 *   facts; they remain a separate, audited owner action.
 * - **Anti-escalation.** A workspace `admin` never grants, changes or removes
 *   an `admin`/`owner` membership. An `owner` may, subject to verified
 *   repository management capability and the last-owner rule.
 * - **Last owner.** Removing or demoting the final *effective* owner (active
 *   account and active enterprise membership) is refused (409) inside the same
 *   transaction as the write, so concurrent attempts cannot both succeed; the
 *   refusal itself is audited in that transaction.
 * - **Atomic audit and revocation.** The membership change, its `auth_audit`
 *   row, the last-owner refusal audit and the capability-grant revocation all
 *   commit together; any failure rolls the whole change back.
 * - **Revocation.** Removal revokes every live capability grant for that user
 *   in that workspace, bumps the shared authority epoch (closing live
 *   subscriptions) and emits the membership invalidation; a downgrade to
 *   `viewer` revokes delivery grants. Other workspaces are untouched.
 * - **Non-enumeration.** A caller without a live membership in the path
 *   workspace gets the same 404 as an unknown workspace, and a target user or
 *   candidate outside the enterprise is indistinguishable from a missing one.
 */

import { SYSTEM_ACTOR } from "../control-plane/db.js";
import {
  CapabilityCeilingError,
  ConflictError,
  ControlPlaneError,
  LastOwnerError,
  WorkspaceRepositorySetError,
} from "../control-plane/errors.js";
import type { IdentityRepositories } from "../control-plane/identity-repositories.js";
import type {
  CapabilityBlockReason,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { ProviderRoleSourceKind } from "../control-plane/provider-access-types.js";
import type { ServiceIntegration } from "../control-plane/provider-access-types.js";
import type { ControlPlaneRepositories } from "../control-plane/repositories.js";
import type {
  EnterpriseId,
  Membership,
  MembershipId,
  ProviderInstance,
  ProviderType,
  UserId,
  Workspace,
  WorkspaceRole,
  WorkspaceScope,
} from "../control-plane/types.js";
import type { WorkspaceRepositoryBinding } from "../control-plane/workspace-repository-types.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { AuthorityEpoch } from "../provider-access/access-gate.js";
import type { CapabilityCeilingService } from "../provider-access/capability-ceiling.js";
import type {
  MemberAdmissionService,
  OwnerRemovalCheck,
} from "../provider-access/member-admission.js";
import { memberRoleCeiling as admissionRoleCeiling } from "../provider-access/member-admission.js";
import {
  intersectRepositoryCapabilities,
  providerRoleCapabilities,
} from "../provider-access/repository-capabilities.js";
import { WORKSPACE_ROLE_RANK } from "../provider-access/types.js";
import type { AuthEventHub } from "./auth-service.js";
import type { AdminActor } from "./auth-service.js";
import { ApiError } from "./errors.js";
import type { MemberProvenance, MembershipView, UserRefView } from "./identity-views.js";
import type { MemberIneligibleReason, MemberRoleCeiling } from "./member-candidate-types.js";
import { membershipView, userRef } from "./identity-views.js";
import type { RequestAuthority } from "./request-authority.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Memberships and candidates per page; the cursor is the last item's key. */
export const WORKSPACE_MEMBER_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface UserIdentityView {
  provider_instance_id: string;
  provider_type: ProviderType;
  subject_id: string;
}

/** One provider-roster candidate for workspace membership (DAT-277). */
export interface MemberCandidateView {
  user: { display_name: string; identities: UserIdentityView[] };
  provider_role: string | null;
  provenance: MemberProvenance;
  already_member: boolean;
  eligible: boolean;
  ineligible_reason: MemberIneligibleReason | null;
  /** Highest viewer/member role the verified intersection supports. */
  max_role: MemberRoleCeiling | null;
  /** Roles the calling actor may grant to this candidate through add. */
  assignable_roles: WorkspaceRole[];
}

export interface MemberPageView {
  items: MembershipView[];
  next_cursor: string | null;
}

export interface MemberCandidatePageView {
  items: MemberCandidateView[];
  next_cursor: string | null;
}

export interface AddMemberRequest {
  user_id: UserId;
  /** Validated by the service; an unknown value is a 400, never a default. */
  role: string;
}

export interface UpdateMemberRequest {
  role: string;
  version: number;
}

export interface LegacyMembershipRequest {
  enterprise_id: EnterpriseId;
  workspace_id: string;
  user_id: UserId;
  role?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface WorkspaceMemberServiceDeps {
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  access: ProviderAccessRepositories;
  repositorySets: WorkspaceRepositorySetRepository;
  capabilityCeilings: CapabilityCeilingService;
  /** Admission and effective-owner evaluation (DAT-283). */
  admission: MemberAdmissionService;
  /** Provider-authority request boundary; the `manage`/`read` checks use it. */
  authority: RequestAuthority;
  hub: AuthEventHub;
  /** Shared authority signal; a removal/downgrade kills live subscriptions. */
  epoch: AuthorityEpoch;
  enterpriseId: EnterpriseId;
  clock?: () => Date;
}

interface ResolvedWorkspace {
  workspace: Workspace;
  membership: Membership;
  scope: WorkspaceScope;
}

interface TargetEligibility {
  /** The user has an identity on a provider instance the workspace binds. */
  linked: boolean;
  /** Verified provider intersection, empty when not verifiable. */
  capabilities: RepositoryCapability[];
  reason: CapabilityBlockReason | null;
  verified: boolean;
}

interface CandidateSeed {
  key: string;
  user_id: UserId | null;
  subjects: Array<{
    subject: string;
    login: string;
    provider_instance_id: string;
    provider_type: ProviderType;
    rows: Array<{ source_kind: ProviderRoleSourceKind; provider_role: string; score: number }>;
  }>;
}

/** One repository binding with the integration and provider it points at. */
interface RosterEntry {
  binding: WorkspaceRepositoryBinding;
  integration: ServiceIntegration;
  provider: Pick<ProviderInstance, "provider_type">;
}

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member", "viewer"];

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * The provider-derived role ceiling. `repository_write` on every repository
 * (i.e. in the verified intersection) supports at most `member`; anything less
 * supports `viewer` only. `admin`/`owner` are deliberately absent: they are a
 * separate owner decision, never a provider role.
 */
export function memberRoleCeiling(
  capabilities: readonly RepositoryCapability[],
): MemberRoleCeiling {
  // One rule, defined next to the admission decision it bounds.
  return admissionRoleCeiling(capabilities);
}

/**
 * The roles a calling actor may grant to a candidate through the add action.
 * Empty for an already-member or ineligible candidate (existing members are
 * changed through PATCH, where the last-owner and current-role rules apply).
 */
export function assignableRolesFor(input: {
  actor_role: WorkspaceRole;
  ceiling: MemberRoleCeiling | null;
  already_member: boolean;
  current_role: WorkspaceRole | null;
}): WorkspaceRole[] {
  if (input.already_member || input.ceiling === null) {
    return [];
  }
  if (
    input.actor_role === "admin" &&
    (input.current_role === "admin" || input.current_role === "owner")
  ) {
    return [];
  }
  const roles: WorkspaceRole[] = ["viewer"];
  if (input.ceiling === "member") {
    roles.push("member");
  }
  if (input.actor_role === "owner") {
    roles.push("admin", "owner");
  }
  return roles;
}

/** Function form used by both the routes and the legacy administrator entry. */
export class WorkspaceMemberService {
  readonly #repos: ControlPlaneRepositories;
  readonly #identity: IdentityRepositories;
  readonly #access: ProviderAccessRepositories;
  readonly #repositorySets: WorkspaceRepositorySetRepository;
  readonly #capabilityCeilings: CapabilityCeilingService;
  readonly #admission: MemberAdmissionService;
  readonly #authority: RequestAuthority;
  readonly #hub: AuthEventHub;
  readonly #epoch: AuthorityEpoch;
  readonly #enterpriseId: EnterpriseId;
  readonly #clock: () => Date;

  constructor(deps: WorkspaceMemberServiceDeps) {
    this.#repos = deps.repos;
    this.#identity = deps.identity;
    this.#access = deps.access;
    this.#repositorySets = deps.repositorySets;
    this.#capabilityCeilings = deps.capabilityCeilings;
    this.#admission = deps.admission;
    this.#authority = deps.authority;
    this.#hub = deps.hub;
    this.#epoch = deps.epoch;
    this.#enterpriseId = deps.enterpriseId;
    this.#clock = deps.clock ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Workspace member surface
  // -------------------------------------------------------------------------

  /** Members of one workspace, visible to every live member (DAT-277). */
  listMembers(actorUserId: UserId, workspaceId: string, cursor: string | null): MemberPageView {
    const ctx = this.#resolve(actorUserId, workspaceId);
    this.#requireRead(ctx);
    const items = this.#repos.memberships
      .list(ctx.scope)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const { page, next } = paginate(items, cursor, (membership) => membership.id);
    return {
      items: page.map((membership) => this.#membershipView(ctx, membership)),
      next_cursor: next,
    };
  }

  /** Add a provider-proven candidate to exactly the selected workspace. */
  addMember(actorUserId: UserId, workspaceId: string, input: AddMemberRequest): MembershipView {
    const ctx = this.#requireManager(actorUserId, workspaceId);
    const role = this.#requireRole(input.role);
    const target = this.#identity.users.getById(input.user_id);
    if (target === undefined || target.status !== "active") {
      // Non-enumerating: a user outside this deployment's directory and a
      // missing one are the same refusal.
      throw new ApiError(404, "NOT_FOUND", "candidate is not visible in this enterprise");
    }
    const enterpriseUser = this.#identity.enterpriseUsers.getByUser(
      this.#enterpriseId,
      input.user_id,
    );
    if (enterpriseUser === undefined) {
      throw new ApiError(404, "NOT_FOUND", "candidate is not visible in this enterprise");
    }
    if (enterpriseUser.status !== "active") {
      throw new ApiError(
        409,
        "ENTERPRISE_MEMBERSHIP_SUSPENDED",
        "the candidate's enterprise membership is suspended; restore it first",
      );
    }
    if (this.#repos.memberships.getByUser(ctx.scope, input.user_id) !== undefined) {
      throw new ApiError(
        409,
        "MEMBERSHIP_CONFLICT",
        "the user is already a member of this workspace",
      );
    }
    const eligibility = this.#targetEligibility(ctx, input.user_id);
    this.#requireEligible(eligibility);
    this.#assertRoleAssignable({
      actorRole: ctx.membership.role,
      desired: role,
      currentRole: null,
      eligibility,
    });

    let membership: Membership;
    try {
      membership = this.#repos.memberships.createAudited(
        ctx.scope,
        { user_id: input.user_id, role },
        {
          event: "membership.granted",
          enterprise_id: this.#enterpriseId,
          actor_kind: "user",
          actor_user_id: actorUserId,
          subject_user_id: input.user_id,
          details: {
            role,
            source: "workspace_member_api",
            verified_capabilities: eligibility.capabilities,
          },
        },
      );
    } catch (error) {
      throw this.#mapMutationError(error);
    }
    return this.#membershipView(ctx, membership);
  }

  /** Change one member's role (version-guarded, last-owner guarded). */
  updateMember(
    actorUserId: UserId,
    workspaceId: string,
    membershipId: MembershipId,
    input: UpdateMemberRequest,
  ): MembershipView {
    const ctx = this.#requireManager(actorUserId, workspaceId);
    const role = this.#requireRole(input.role);
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new ApiError(400, "INVALID_REQUEST", "version must be a positive integer");
    }
    const target = this.#repos.memberships.getById(ctx.scope, membershipId);
    if (target === undefined) {
      throw new ApiError(404, "NOT_FOUND", "membership not found");
    }
    this.#assertCanManageTarget(ctx.membership.role, target.role);
    this.#assertRoleAssignable({
      actorRole: ctx.membership.role,
      desired: role,
      currentRole: target.role,
      eligibility:
        WORKSPACE_ROLE_RANK[role] > WORKSPACE_ROLE_RANK[target.role]
          ? this.#targetEligibility(ctx, target.user_id)
          : null,
    });

    const downgraded = WORKSPACE_ROLE_RANK[role] < WORKSPACE_ROLE_RANK[target.role];
    let updated: Membership;
    try {
      updated = this.#repos.memberships.updateRoleAudited(
        ctx.scope,
        target.id,
        role,
        input.version,
        {
          event: "membership.role_changed",
          enterprise_id: this.#enterpriseId,
          actor_kind: "user",
          actor_user_id: actorUserId,
          subject_user_id: target.user_id,
          details: { previous_role: target.role, role },
        },
        {
          blockedAudit: {
            enterprise_id: this.#enterpriseId,
            actor_kind: "user",
            actor_user_id: actorUserId,
            action: "demote",
          },
          // A demotion out of `owner` may not leave the workspace without an
          // owner who can actually administer it (DAT-283). Evaluated inside
          // the membership transaction, so concurrent changes cannot both
          // observe a second effective owner.
          verifyOwnerRemoval: (scope, existing) =>
            this.#verifyOwnerRemoval(scope, existing.user_id),
          ...(downgraded
            ? {
                applyEffects: (): void => {
                  this.#revokeUnsupportedGrants(ctx.scope, target.user_id, role);
                },
              }
            : {}),
        },
      );
    } catch (error) {
      throw this.#mapMutationError(error);
    }

    if (downgraded) {
      this.#epoch.bump();
      this.#hub.emit({
        type: "membership.changed",
        user_id: target.user_id,
        workspace_id: ctx.workspace.id,
        role,
        downgraded: true,
      });
    }
    return this.#membershipView(ctx, updated);
  }

  /** Remove one membership and every authority derived from it. */
  removeMember(actorUserId: UserId, workspaceId: string, membershipId: MembershipId): void {
    const ctx = this.#requireManager(actorUserId, workspaceId);
    const target = this.#repos.memberships.getById(ctx.scope, membershipId);
    if (target === undefined) {
      throw new ApiError(404, "NOT_FOUND", "membership not found");
    }
    this.#assertCanManageTarget(ctx.membership.role, target.role);
    this.#removeMembership(ctx, target, actorUserId);
  }

  /** Provider-roster candidates for the add flow; complete roster or an error. */
  listCandidates(
    actorUserId: UserId,
    workspaceId: string,
    cursor: string | null,
  ): MemberCandidatePageView {
    const ctx = this.#requireManager(actorUserId, workspaceId);
    const roster = this.#completeRoster(ctx);
    const seeds = this.#candidateSeeds(ctx, roster);
    const candidates = seeds
      .map((seed) => this.#candidateView(ctx, seed))
      .sort(
        (a, b) =>
          a.user.display_name.localeCompare(b.user.display_name) ||
          a.user.identities[0]?.subject_id.localeCompare(b.user.identities[0]?.subject_id ?? "") ||
          0,
      );
    const page = paginate(candidates, cursor, (candidate) => candidateKey(candidate));
    return { items: page.page, next_cursor: page.next };
  }

  // -------------------------------------------------------------------------
  // Legacy enterprise-administrator entry (same rules, no bypass)
  // -------------------------------------------------------------------------

  /**
   * The legacy `PUT .../members/{user_id}` entry.
   *
   * A user session must clear the enterprise-administrator check *and* the
   * exact workspace-management rules above; it cannot mutate a membership the
   * workspace surface would refuse. The deployment bootstrap credential is the
   * explicitly scoped local-operator mode: it keeps its seed semantics (it may
   * establish the enterprise membership it depends on) but the last-owner and
   * atomic-audit invariants still apply.
   */
  legacyGrant(actor: AdminActor, input: LegacyMembershipRequest): MembershipView {
    if (actor.kind === "deployment") {
      return this.#deploymentGrant(actor, input);
    }
    this.#assertEnterpriseAdmin(actor.user_id);
    const ctx = this.#requireManager(actor.user_id, input.workspace_id);
    if (ctx.workspace.enterprise_id !== input.enterprise_id) {
      throw new ApiError(404, "NOT_FOUND", "workspace not found");
    }
    // The workspace surface takes the membership by user id; the legacy route
    // is the same decision with the same body.
    return this.addMember(actor.user_id, input.workspace_id, {
      user_id: input.user_id,
      role: input.role ?? "member",
    });
  }

  /** The legacy `DELETE .../members/{user_id}` entry. */
  legacyRevoke(actor: AdminActor, input: Omit<LegacyMembershipRequest, "role">): void {
    if (actor.kind === "deployment") {
      const scope = this.#deploymentScope(input.enterprise_id, input.workspace_id, SYSTEM_ACTOR);
      const membership = this.#repos.memberships.getByUser(scope, input.user_id);
      if (membership === undefined) {
        throw new ApiError(404, "NOT_FOUND", "membership not found");
      }
      this.#removeMembership(
        { workspace: this.#requireWorkspace(scope), membership, scope },
        membership,
        null,
      );
      return;
    }
    this.#assertEnterpriseAdmin(actor.user_id);
    const ctx = this.#resolve(actor.user_id, input.workspace_id);
    if (ctx.workspace.enterprise_id !== input.enterprise_id) {
      throw new ApiError(404, "NOT_FOUND", "workspace not found");
    }
    this.#requireManager(actor.user_id, input.workspace_id);
    const target = this.#repos.memberships.getByUser(ctx.scope, input.user_id);
    if (target === undefined) {
      throw new ApiError(404, "NOT_FOUND", "membership not found");
    }
    this.#assertCanManageTarget(ctx.membership.role, target.role);
    this.#removeMembership(ctx, target, actor.user_id);
  }

  // -------------------------------------------------------------------------
  // Authorization core
  // -------------------------------------------------------------------------

  /** Path workspace is a locator; only a live membership resolves it. */
  #resolve(actorUserId: UserId, workspaceId: string): ResolvedWorkspace {
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
    return { workspace, membership, scope };
  }

  /** Roster reads follow the same provider-authority gate as other reads. */
  #requireRead(ctx: ResolvedWorkspace): void {
    if (this.#authority.isEnforcing(ctx.workspace.id)) {
      this.#authority.require(ctx.membership.user_id, "read", ctx.workspace.id);
    }
  }

  /**
   * Member management requires an assigned owner/admin role *and* verified
   * repository management capability across every repository. Without an
   * active integration there is no way to prove the latter, so the surface
   * refuses instead of falling back to role-only authority.
   */
  #requireManager(actorUserId: UserId, workspaceId: string): ResolvedWorkspace {
    const ctx = this.#resolve(actorUserId, workspaceId);
    if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "workspace owner or admin authority is required");
    }
    if (!this.#authority.isEnforcing(ctx.workspace.id)) {
      throw new ApiError(
        403,
        "CAPABILITY_MANAGEMENT_REQUIRED",
        "workspace administration requires an active repository-scoped integration that verifies repository management authority",
      );
    }
    this.#authority.require(actorUserId, "manage", ctx.workspace.id);
    return ctx;
  }

  #assertEnterpriseAdmin(userId: UserId): void {
    const membership = this.#identity.enterpriseUsers.getByUser(this.#enterpriseId, userId);
    const role = this.#identity.enterpriseRoles.getByUser(this.#enterpriseId, userId);
    if (membership === undefined || membership.status !== "active" || role?.role !== "admin") {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "enterprise administrator authority in this enterprise is required",
      );
    }
  }

  /**
   * A workspace admin never handles an admin/owner membership, and never
   * grants one. An owner may, subject to the repository-management check the
   * caller already passed and the last-owner rule.
   */
  #assertCanManageTarget(actorRole: WorkspaceRole, targetRole: WorkspaceRole): void {
    if (actorRole === "admin" && (targetRole === "admin" || targetRole === "owner")) {
      throw new ApiError(
        403,
        "ROLE_NOT_ASSIGNABLE",
        "a workspace admin cannot change an admin or owner membership",
      );
    }
  }

  #assertRoleAssignable(input: {
    actorRole: WorkspaceRole;
    desired: WorkspaceRole;
    currentRole: WorkspaceRole | null;
    /** Evaluated only when the change raises the role. */
    eligibility: TargetEligibility | null;
  }): void {
    const { actorRole, desired, currentRole, eligibility } = input;
    if (actorRole === "admin" && (desired === "admin" || desired === "owner")) {
      throw new ApiError(
        403,
        "ROLE_NOT_ASSIGNABLE",
        "a workspace admin cannot grant the admin or owner role",
      );
    }
    const raising =
      currentRole === null || WORKSPACE_ROLE_RANK[desired] > WORKSPACE_ROLE_RANK[currentRole];
    if (!raising) {
      // Downgrades and no-ops need no target eligibility: revoking or
      // retaining access never depends on a positive provider fact.
      return;
    }
    if (desired === "admin" || desired === "owner") {
      // Explicit owner elevation above the provider-derived ceiling remains a
      // separate audited administrative decision (ADR-0011), but the target
      // must still be a verifiable, code-read-eligible member.
      this.#requireEligible(eligibility);
      return;
    }
    if (desired === "member") {
      if (eligibility === null || !eligibility.verified) {
        this.#requireEligible(eligibility);
      } else if (!eligibility.capabilities.includes("repository_write")) {
        throw new ApiError(
          403,
          "ROLE_NOT_ASSIGNABLE",
          "the verified repository capability intersection does not support the member role on every repository; the maximum is viewer",
          { max_role: memberRoleCeiling(eligibility.capabilities) },
        );
      }
      return;
    }
    // viewer: code read on every repository is the admission requirement.
    this.#requireEligible(eligibility);
  }

  #requireEligible(eligibility: TargetEligibility | null): void {
    if (eligibility === null) {
      throw new ApiError(409, "TARGET_NOT_ELIGIBLE", "the candidate is not eligible", {
        reason: "authority_unknown",
      });
    }
    if (!eligibility.linked) {
      throw new ApiError(
        409,
        "TARGET_NOT_ELIGIBLE",
        "the candidate has not signed in, so there is no account to grant a role to",
        { reason: "identity_unlinked" },
      );
    }
    if (!eligibility.verified || !eligibility.capabilities.includes("code_read")) {
      throw new ApiError(
        409,
        "TARGET_NOT_ELIGIBLE",
        "the candidate's repository access is not currently verifiable with code read on every repository",
        { reason: eligibility.reason ?? "no_code_read" },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Eligibility and provenance
  // -------------------------------------------------------------------------

  /**
   * Evaluate the target's verified intersection across the workspace's whole
   * repository set without writing a ceiling row (the row is created by the
   * first authorized request after the membership exists). Every refusal branch
   * keeps its DAT-276 reason so the caller can explain the state safely.
   */
  #targetEligibility(ctx: ResolvedWorkspace, userId: UserId): TargetEligibility {
    let bindings;
    try {
      bindings = this.#repositorySets.listBindings(ctx.scope);
    } catch {
      return { linked: false, capabilities: [], reason: "repository_missing", verified: false };
    }
    const instanceIds = new Set(bindings.map((binding) => binding.provider_instance_id));
    const identities = this.#identity.identities
      .listByUser(userId)
      .filter((identity) => instanceIds.has(identity.provider_instance_id));
    if (identities.length === 0) {
      return {
        linked: false,
        capabilities: [],
        reason: "subject_missing",
        verified: false,
      };
    }
    try {
      const evaluation = this.#capabilityCeilings.evaluate(ctx.scope, userId, {
        persist: false,
        now: this.#clock(),
      });
      return {
        linked: true,
        capabilities: evaluation.capabilities,
        reason: evaluation.reason,
        verified: evaluation.state === "verified",
      };
    } catch (error) {
      if (error instanceof CapabilityCeilingError) {
        return {
          linked: true,
          capabilities: [],
          reason: "capability_store_unavailable",
          verified: false,
        };
      }
      throw error;
    }
  }

  /** Roster rows and their provenance for one member (fail-closed display). */
  #authorityView(ctx: ResolvedWorkspace, userId: UserId) {
    let bindings;
    try {
      bindings = this.#repositorySets.listBindings(ctx.scope);
    } catch {
      return {
        provider_role: null,
        provenance: "unknown" as MemberProvenance,
        verified_at: null,
        stale: true,
      };
    }
    const identities = this.#identity.identities.listByUser(userId);
    let best:
      { provider_role: string; source_kind: ProviderRoleSourceKind; score: number } | undefined;
    for (const binding of bindings) {
      const integration = this.#activeIntegration(ctx, binding.installation_ref);
      if (integration === undefined) {
        continue;
      }
      const provider = this.#repos.providerInstances.getById(
        { enterprise_id: ctx.scope.enterprise_id, actor_id: ctx.scope.actor_id },
        binding.provider_instance_id,
      );
      if (provider === undefined) {
        continue;
      }
      const subject = identities.find(
        (identity) => identity.provider_instance_id === binding.provider_instance_id,
      )?.subject;
      if (subject === undefined) {
        continue;
      }
      for (const row of this.#access.roster
        .listRoles(ctx.scope, integration.id)
        .filter((entry) => entry.subject === subject)) {
        const mapped = providerRoleCapabilities(
          provider.provider_type,
          row.source_kind,
          row.provider_role,
        );
        const score = mapped.supported ? mapped.capabilities.length : -1;
        if (best === undefined || score > best.score) {
          best = {
            provider_role: row.provider_role,
            source_kind: row.source_kind,
            score,
          };
        }
      }
    }
    let verifiedAt: string | null = null;
    let stale = true;
    try {
      const evaluation = this.#capabilityCeilings.evaluate(ctx.scope, userId, {
        persist: false,
        now: this.#clock(),
      });
      verifiedAt = evaluation.verified_at;
      stale = evaluation.state !== "verified";
    } catch {
      stale = true;
    }
    return {
      provider_role: best?.provider_role ?? null,
      provenance: provenanceOf(best?.source_kind),
      verified_at: verifiedAt,
      stale,
    };
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  /**
   * The workspace's complete provider roster, or the stable
   * PROVIDER_ROSTER_INCOMPLETE refusal. A partial, unobservable or never
   * fully-reconciled roster is never presented as a (possibly empty) candidate
   * list: only a completed reconcile run is evidence that every subject was
   * enumerated.
   */
  #completeRoster(ctx: ResolvedWorkspace): RosterEntry[] {
    let set;
    try {
      set = this.#repositorySets.getSet(ctx.scope);
    } catch (error) {
      throw this.#mapRepositorySetError(error);
    }
    if (!set.usable) {
      throw new ApiError(
        409,
        set.blocked_reason ?? "REPOSITORY_SET_UNSUPPORTED",
        "the workspace repository set cannot currently authorize membership",
      );
    }
    return set.bindings.map((binding) => {
      const integration = this.#activeIntegration(ctx, binding.installation_ref);
      if (integration === undefined) {
        throw rosterIncomplete("installation_not_active", binding.repository_id);
      }
      if (integration.permission_visibility !== "full") {
        throw rosterIncomplete(
          `permission_visibility_${integration.permission_visibility}`,
          binding.repository_id,
        );
      }
      // A static permission declaration is not enough: only a completed full
      // reconciliation proves the local roster is complete. A missing run, a
      // run still in progress, or a failed run all mean the roster may be a
      // partial subject refresh, so candidates cannot be presented as a
      // complete list.
      const latestRun = this.#access.reconcileRuns.list(ctx.scope, integration.id, 1)[0];
      if (latestRun === undefined) {
        throw rosterIncomplete("reconcile_missing", binding.repository_id);
      }
      if (latestRun.status !== "completed") {
        throw rosterIncomplete(
          latestRun.status === "running" ? "reconcile_in_progress" : "reconcile_incomplete",
          binding.repository_id,
          latestRun.failure_code !== null ? { failure_code: latestRun.failure_code } : {},
        );
      }
      const provider = this.#repos.providerInstances.getById(
        { enterprise_id: ctx.scope.enterprise_id, actor_id: ctx.scope.actor_id },
        binding.provider_instance_id,
      );
      if (provider === undefined) {
        throw rosterIncomplete("provider_instance_unapproved", binding.repository_id);
      }
      return { binding, integration, provider };
    });
  }

  #candidateSeeds(ctx: ResolvedWorkspace, roster: readonly RosterEntry[]): CandidateSeed[] {
    const seeds = new Map<string, CandidateSeed>();
    for (const { integration, provider } of roster) {
      for (const row of this.#access.roster.listRoles(ctx.scope, integration.id)) {
        const identity = this.#identity.identities.getByProviderSubject(
          integration.provider_instance_id,
          row.subject,
        );
        const key = identity?.user_id ?? `${integration.provider_instance_id}:${row.subject}`;
        let seed = seeds.get(key);
        if (seed === undefined) {
          seed = { key, user_id: identity?.user_id ?? null, subjects: [] };
          seeds.set(key, seed);
        }
        let subject = seed.subjects.find(
          (entry) =>
            entry.subject === row.subject &&
            entry.provider_instance_id === integration.provider_instance_id,
        );
        if (subject === undefined) {
          subject = {
            subject: row.subject,
            login: row.login,
            provider_instance_id: integration.provider_instance_id,
            provider_type: provider.provider_type,
            rows: [],
          };
          seed.subjects.push(subject);
        }
        const mapped = providerRoleCapabilities(
          provider.provider_type,
          row.source_kind,
          row.provider_role,
        );
        subject.rows.push({
          source_kind: row.source_kind,
          provider_role: row.provider_role,
          score: mapped.supported ? mapped.capabilities.length : -1,
        });
      }
    }
    return [...seeds.values()];
  }

  #candidateView(ctx: ResolvedWorkspace, seed: CandidateSeed): MemberCandidateView {
    const identities: UserIdentityView[] = [];
    for (const subject of seed.subjects) {
      const provider = this.#repos.providerInstances.getById(
        { enterprise_id: ctx.scope.enterprise_id, actor_id: ctx.scope.actor_id },
        subject.provider_instance_id,
      );
      identities.push({
        provider_instance_id: subject.provider_instance_id,
        provider_type: provider?.provider_type ?? subject.provider_type,
        subject_id: subject.subject,
      });
    }
    const best = seed.subjects
      .flatMap((subject) => subject.rows)
      .sort((a, b) => b.score - a.score)[0];
    const displayName =
      (seed.user_id !== null ? this.#identity.users.getById(seed.user_id)?.display_name : null) ??
      seed.subjects[0]?.login ??
      "";

    const membership =
      seed.user_id !== null
        ? this.#repos.memberships.getByUser(ctx.scope, seed.user_id)
        : undefined;
    const evaluation =
      seed.user_id !== null && membership === undefined
        ? this.#targetEligibility(ctx, seed.user_id)
        : null;
    let reason: MemberIneligibleReason | null = null;
    let ceiling: MemberRoleCeiling | null = null;
    if (membership !== undefined) {
      reason = "already_member";
    } else if (seed.user_id === null) {
      reason = "identity_unlinked";
    } else if (evaluation === null) {
      reason = "authority_unknown";
    } else if (!evaluation.linked) {
      reason = "identity_unlinked";
    } else if (evaluation.verified && evaluation.capabilities.includes("code_read")) {
      ceiling = memberRoleCeiling(evaluation.capabilities);
    } else {
      reason = evaluation.reason ?? "authority_unknown";
    }

    return {
      user: { display_name: displayName, identities },
      provider_role: best?.provider_role ?? null,
      provenance: provenanceOf(best?.source_kind),
      already_member: membership !== undefined,
      eligible: ceiling !== null,
      ineligible_reason: reason,
      max_role: ceiling,
      assignable_roles: assignableRolesFor({
        actor_role: ctx.membership.role,
        ceiling: membership === undefined ? ceiling : null,
        already_member: membership !== undefined,
        current_role: membership?.role ?? null,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  #deploymentGrant(actor: AdminActor, input: LegacyMembershipRequest): MembershipView {
    const role = this.#requireRole(input.role ?? "member");
    const scope = this.#deploymentScope(input.enterprise_id, input.workspace_id, actorIdOf(actor));
    const workspace = this.#requireWorkspace(scope);
    if (this.#identity.users.getById(input.user_id) === undefined) {
      throw new ApiError(404, "NOT_FOUND", "user not found");
    }
    const ensured = this.#identity.enterpriseUsers.ensureActive(
      input.enterprise_id,
      input.user_id,
      { kind: "deployment" },
    );
    if (ensured.suspended) {
      throw new ApiError(
        409,
        "ENTERPRISE_MEMBERSHIP_SUSPENDED",
        "the target enterprise user is suspended; restore the membership first",
      );
    }
    if (this.#repos.memberships.getByUser(scope, input.user_id) !== undefined) {
      throw new ApiError(409, "MEMBERSHIP_CONFLICT", "the user is already a member");
    }
    let membership: Membership;
    try {
      membership = this.#repos.memberships.createAudited(
        scope,
        { user_id: input.user_id, role },
        {
          event: "membership.granted",
          enterprise_id: input.enterprise_id,
          actor_kind: "deployment",
          actor_user_id: null,
          subject_user_id: input.user_id,
          details: { role, source: "legacy_administrator_entry" },
        },
      );
    } catch (error) {
      throw this.#mapMutationError(error);
    }
    return this.#membershipView(
      {
        workspace: workspace!,
        membership: membership,
        scope,
      },
      membership,
    );
  }

  #removeMembership(ctx: ResolvedWorkspace, target: Membership, actorUserId: UserId | null): void {
    let removed: Membership;
    try {
      removed = this.#repos.memberships.removeAudited(
        ctx.scope,
        target.id,
        {
          event: "membership.revoked",
          enterprise_id: ctx.scope.enterprise_id,
          actor_kind: actorUserId === null ? "deployment" : "user",
          actor_user_id: actorUserId,
          subject_user_id: target.user_id,
          details: { role: target.role, source: "workspace_member_api" },
        },
        {
          blockedAudit: {
            enterprise_id: ctx.scope.enterprise_id,
            actor_kind: actorUserId === null ? "deployment" : "user",
            ...(actorUserId !== null ? { actor_user_id: actorUserId } : {}),
            action: "remove",
          },
          // Removing an owner is only allowed when another *effective* owner
          // remains; verified inside the same transaction as the delete.
          verifyOwnerRemoval: (scope, existing) =>
            this.#verifyOwnerRemoval(scope, existing.user_id),
          // Grants and their cleanup audit belong to the same transaction as
          // the membership removal: the request path already denies without
          // the membership, and no live grant may outlive it.
          applyEffects: (removedMembership): void => {
            const revoked = this.#revokeAllGrants(ctx.scope, removedMembership.user_id);
            this.#auditCleanup(ctx, removedMembership, revoked, actorUserId);
          },
        },
      );
    } catch (error) {
      throw this.#mapMutationError(error);
    }
    this.#epoch.bump();
    this.#hub.emit({
      type: "membership.revoked",
      user_id: removed.user_id,
      workspace_id: ctx.workspace.id,
    });
  }

  /**
   * The effective-owner probe handed to the membership transaction.
   *
   * Runs inside the transaction and is read-only on purpose: an admission
   * evaluation never persists a ceiling, so a refusal cannot itself change
   * authority. A thrown evaluation has already been answered "no other
   * effective owner" by the store, because unknown authority is not proof of an
   * owner (ADR-0011).
   */
  #verifyOwnerRemoval(scope: WorkspaceScope, userId: UserId): OwnerRemovalCheck {
    return this.#admission.verifyOwnerRemoval(scope, userId, { now: this.#clock() });
  }

  #revokeAllGrants(scope: WorkspaceScope, userId: UserId): number {
    const at = this.#clock().toISOString();
    let revoked = 0;
    for (const integration of this.#access.integrations.listByWorkspace(scope)) {
      for (const grant of this.#access.grants.listLive(scope, integration.id, {
        grantee_user_id: userId,
        now: at,
      })) {
        this.#access.grants.revoke(scope, grant.id, "workspace membership removed", at);
        revoked += 1;
      }
    }
    return revoked;
  }

  #revokeUnsupportedGrants(scope: WorkspaceScope, userId: UserId, role: WorkspaceRole): void {
    if (role !== "viewer") {
      return;
    }
    const at = this.#clock().toISOString();
    for (const integration of this.#access.integrations.listByWorkspace(scope)) {
      for (const grant of this.#access.grants.listLive(scope, integration.id, {
        grantee_user_id: userId,
        now: at,
      })) {
        // A viewer keeps read authority; every write-derived grant dies.
        if (grant.capability === "delivery_write") {
          this.#access.grants.revoke(scope, grant.id, "workspace role downgraded to viewer", at);
        }
      }
    }
  }

  /**
   * Observability for derived-authority cleanup, written inside the same
   * transaction as the removal and the grant revocation it describes.
   */
  #auditCleanup(
    ctx: ResolvedWorkspace,
    membership: Membership,
    revokedGrants: number,
    actorUserId: UserId | null,
  ): void {
    this.#identity.authAudit.append({
      event: "membership.revocation_effects",
      enterprise_id: ctx.scope.enterprise_id,
      actor_kind: actorUserId === null ? "deployment" : "user",
      ...(actorUserId !== null ? { actor_user_id: actorUserId } : {}),
      subject_user_id: membership.user_id,
      details: {
        workspace_id: ctx.workspace.id,
        revoked_grants: revokedGrants,
        actions: ["read", "stream", "artifact_read", "approval", "delivery", "write"],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Views and helpers
  // -------------------------------------------------------------------------

  #membershipView(ctx: ResolvedWorkspace, membership: Membership): MembershipView {
    const user = this.#identity.users.getById(membership.user_id);
    const ref: UserRefView =
      user !== undefined ? userRef(user) : { id: membership.user_id, display_name: "" };
    return {
      ...membershipView(membership, ref),
      authority: this.#authorityView(ctx, membership.user_id),
    };
  }

  #activeIntegration(ctx: ResolvedWorkspace, installationRef: string | null) {
    if (installationRef === null) {
      return undefined;
    }
    const integration = this.#access.integrations.getById(ctx.scope, installationRef);
    if (
      integration === undefined ||
      integration.install_status !== "active" ||
      integration.workspace_id !== ctx.workspace.id
    ) {
      return undefined;
    }
    return integration;
  }

  #requireRole(value: unknown): WorkspaceRole {
    if (!isWorkspaceRole(value)) {
      throw new ApiError(400, "INVALID_REQUEST", "role must be owner, admin, member, or viewer");
    }
    return value;
  }

  #deploymentScope(
    enterpriseId: EnterpriseId,
    workspaceId: string,
    actorId: UserId,
  ): WorkspaceScope {
    if (enterpriseId !== this.#enterpriseId) {
      throw new ApiError(404, "NOT_FOUND", "workspace not found");
    }
    return { enterprise_id: this.#enterpriseId, workspace_id: workspaceId, actor_id: actorId };
  }

  #requireWorkspace(scope: WorkspaceScope): Workspace {
    const workspace = this.#repos.workspaces.getById(scope, scope.workspace_id);
    if (workspace === undefined) {
      throw new ApiError(404, "NOT_FOUND", "workspace not found");
    }
    return workspace;
  }

  #mapRepositorySetError(error: unknown): ApiError {
    if (error instanceof WorkspaceRepositorySetError) {
      return new ApiError(error.status, error.code, error.message, error.details);
    }
    return new ApiError(
      409,
      "REPOSITORY_SET_UNSUPPORTED",
      "the workspace repository set cannot currently authorize membership",
    );
  }

  /**
   * A membership change that could not commit together with its audit row,
   * last-owner refusal audit and revocation effects is blocked as a whole: the
   * transaction rolled back and nothing was applied.
   */
  #mapMutationError(error: unknown): ApiError {
    if (error instanceof LastOwnerError) {
      return new ApiError(409, error.code, error.message, {
        workspace_id: error.workspaceId,
        action: error.action,
        ...error.details,
      });
    }
    if (error instanceof ApiError) {
      return error;
    }
    if (error instanceof ConflictError) {
      return new ApiError(409, "MEMBERSHIP_CONFLICT", error.message, error.details);
    }
    if (error instanceof ControlPlaneError) {
      // Version conflicts and the other typed control-plane refusals keep
      // their own mapping at the API envelope boundary.
      throw error;
    }
    // Anything else means the membership write and its audit row did not
    // commit: the transaction rolled back, so nothing was applied and the
    // caller may retry the same idempotent request.
    return new ApiError(
      503,
      "MEMBERSHIP_AUDIT_UNAVAILABLE",
      "the membership change could not be committed together with its audit record and revocation effects; nothing was applied",
      {},
      { retryable: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function provenanceOf(kind: ProviderRoleSourceKind | undefined): MemberProvenance {
  switch (kind) {
    case "org_owner":
      return "organization_owner";
    case "group":
      return "group";
    case "inherited_role":
      return "inherited_role";
    case "direct_collaborator":
      return "direct_collaborator";
    default:
      return "unknown";
  }
}

function rosterIncomplete(
  reason: string,
  repositoryId: string,
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError(
    503,
    "PROVIDER_ROSTER_INCOMPLETE",
    "the provider roster cannot be enumerated completely, so candidates are unavailable",
    { reason, repository_id: repositoryId, ...details },
    { retryable: true },
  );
}

function actorIdOf(actor: AdminActor): UserId {
  return actor.kind === "deployment" ? SYSTEM_ACTOR : actor.user_id;
}

function paginate<T>(
  items: readonly T[],
  cursor: string | null,
  keyOf: (item: T) => string,
): { page: T[]; next: string | null } {
  let start = 0;
  if (cursor !== null) {
    const index = items.findIndex((item) => keyOf(item) === cursor);
    if (index === -1) {
      throw new ApiError(400, "INVALID_CURSOR", `Unknown cursor ${JSON.stringify(cursor)}`);
    }
    start = index + 1;
  }
  const page = items.slice(start, start + WORKSPACE_MEMBER_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    page,
    next: last !== undefined && start + page.length < items.length ? keyOf(last) : null,
  };
}

function candidateKey(candidate: MemberCandidateView): string {
  const identity = candidate.user.identities[0];
  return identity !== undefined
    ? `candidate:${identity.provider_instance_id}:${identity.subject_id}`
    : `candidate:${candidate.user.display_name}`;
}

/**
 * The verified intersection helper exported for tests and diagnostics: write
 * on repository A and read on B yields read, so the honest maximum role is
 * `viewer` (ADR-0011: a set intersection, never a role-name ranking).
 */
export function ceilingAcrossRepositories(
  perRepository: readonly (readonly RepositoryCapability[])[],
): MemberRoleCeiling {
  return memberRoleCeiling(intersectRepositoryCapabilities(perRepository));
}
