/**
 * Request-path access gate and revocation (DAT-203).
 *
 * Every read, stream, artifact, approval, and write goes through
 * {@link AccessGate.authorize}, which computes the effective-access
 * intersection from authoritative state. Two enforcement properties matter:
 *
 * - **Decisions are never cached.** Every authorize call re-reads user
 *   status, membership, workspace role, subject authority, and live
 *   capability grants at call time, so grant expiry, verification-freshness
 *   deadlines, membership changes, and revocations take effect on the very
 *   next check — in this process or any other. There is deliberately no
 *   decision memo: a cached allow could outlive the evidence it was computed
 *   from (an expired delivery grant, a stale verification window) and would
 *   need cross-process invalidation it cannot get.
 * - **Revocation stops everything and revokes capability grants.** Removing a
 *   subject stops read/stream/artifact/approval/write at once and revokes
 *   their live checkout/delivery grants in the same operation.
 *
 * Sensitive actions require fresh provider verification; unknown or stale
 * authority blocks them and marks the decision `requires_reconciliation`.
 *
 * The repository capability ceiling (DAT-276) is a required dependency, not an
 * optional extra: with it wired, every decision is additionally bounded by the
 * intersection of verified provider capabilities over the workspace's whole
 * repository set, and an unverifiable ceiling blocks the workspace instead of
 * falling back to the last known role.
 */

import type { CapabilityGrant, CapabilityKind } from "../control-plane/provider-access-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { IdentityRepository, UserRepository } from "../control-plane/identity-repositories.js";
import type { EnterpriseUserRepository } from "../control-plane/enterprise-user-repositories.js";
import type { MembershipRepository, WorkspaceRepository } from "../control-plane/repositories.js";
import type { UserId, WorkspaceRole, WorkspaceScope } from "../control-plane/types.js";
import type { CapabilityCeilingService, CapabilityCeilingView } from "./capability-ceiling.js";
import { computeEffectiveAccess } from "./effective-access.js";
import { requiredCapabilityForAction } from "./repository-capabilities.js";
import { revokeAuthority, type RevocationEffects, type RevocationTarget } from "./revocation.js";
import {
  DEFAULT_ACTION_POLICY,
  type AccessDecision,
  type ActionKind,
  type ActionPolicy,
  type DenyReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Authority epoch — change signal
// ---------------------------------------------------------------------------

/**
 * A monotonic counter bumped whenever repository authority may have changed
 * (revocation, provider event, reconciliation). The gate itself caches
 * nothing — every decision is recomputed from the store — but the epoch is
 * the shared "authority changed" signal: the request boundary subscribes to
 * cut live streams on revocation, and tests observe it.
 */
export interface AuthorityEpoch {
  current(): number;
  bump(): void;
  /** Subscribe to authority changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createAuthorityEpoch(): AuthorityEpoch {
  let epoch = 0;
  const listeners = new Set<() => void>();
  return {
    current: () => epoch,
    bump: () => {
      epoch += 1;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// Access gate
// ---------------------------------------------------------------------------

export interface AccessGateDeps {
  access: ProviderAccessRepositories;
  memberships: MembershipRepository;
  workspaces: WorkspaceRepository;
  users: UserRepository;
  identities: IdentityRepository;
  /** Enterprise-scoped membership/status (DAT-275); the only member evidence. */
  enterpriseUsers: EnterpriseUserRepository;
  /** Verified, intersected repository capability ceiling (DAT-276). */
  capabilityCeilings: CapabilityCeilingService;
  /** Shared with revocation/reconcile as the "authority changed" signal. */
  epoch: AuthorityEpoch;
  clock?: () => Date;
  freshWindowMs?: number;
  staleAfterMs?: number;
  policy?: Readonly<Record<ActionKind, ActionPolicy>>;
}

export interface AccessRequest {
  scope: WorkspaceScope;
  user_id: UserId;
  action: ActionKind;
  /** Override the integration when a workspace has more than one. */
  integration_id?: string;
  /** Override "now" for freshness evaluation (tests, replay). */
  now?: Date;
}

export type { RevocationEffects, RevocationTarget };

/** Thrown by {@link AccessGate.assert}; carries the machine decision. */
export class AccessDeniedError extends Error {
  constructor(
    readonly decision: AccessDecision,
    message = `access denied for ${decision.action} (${decision.reason ?? "unknown"})`,
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }

  get code(): string {
    return this.decision.requires_reconciliation ? "AUTHORITY_RECONCILE_REQUIRED" : "FORBIDDEN";
  }

  get reason(): DenyReason | undefined {
    return this.decision.reason;
  }
}

export interface AccessGate {
  /** Compute one decision from current authoritative state. */
  authorize(request: AccessRequest): AccessDecision;
  /** Authorize or throw {@link AccessDeniedError}. */
  assert(request: AccessRequest): AccessDecision;
  /**
   * Revoke a subject's repository authority: mark it `removed` and revoke
   * live capability grants in the same call.
   */
  revoke(
    scope: WorkspaceScope,
    target: RevocationTarget,
    reason: string,
    at: string,
  ): RevocationEffects;
  /** Current authority-change epoch (observability/tests). */
  epoch(): number;
  /**
   * The member's workspace capability projection (DAT-276): module/action
   * decisions, the verified ceiling, per-repository evidence freshness and any
   * confirmed reduction. Fails closed for a non-member workspace.
   */
  projection(scope: WorkspaceScope, userId: UserId, now?: Date): CapabilityProjection;
}

export interface CapabilityProjection {
  schema_version: "workspace-capability-v1";
  enterprise_id: string;
  workspace_id: string;
  assigned_role: WorkspaceRole | null;
  state: "verified" | "unverified" | "confirmed_loss";
  blocked_reason: string | null;
  capabilities: readonly string[];
  actions: Record<
    string,
    { allowed: boolean; required: string; reason?: string; requires_reconciliation?: boolean }
  >;
  repositories: readonly {
    repository_id: string;
    provider_instance_id: string;
    state: string;
    capabilities: readonly string[];
    reason: string | null;
    verified_at: string | null;
  }[];
  ceiling: {
    state: string | null;
    capabilities: readonly string[];
    reason: string | null;
    version: number | null;
    verified_at: string | null;
    promotion_available: boolean;
  };
  authority: {
    verified_at: string | null;
    fresh_window_ms: number;
    stale_after_ms: number;
    set_version: number;
    repository_count: number;
  };
  checked_at: string;
}

export function createAccessGate(deps: AccessGateDeps): AccessGate {
  const {
    access,
    memberships,
    workspaces,
    users,
    identities,
    enterpriseUsers,
    capabilityCeilings,
    epoch,
    clock = () => new Date(),
    freshWindowMs,
    staleAfterMs,
    policy = DEFAULT_ACTION_POLICY,
  } = deps;

  function resolveIntegration(
    scope: WorkspaceScope,
    integrationId: string | undefined,
  ): { integration_id: string; provider_instance_id: string; repository_id: string } | null {
    if (integrationId) {
      // A non-active integration resolves to null exactly like a missing
      // one: suspended or uninstalled installs fail closed (authority_unknown
      // + reconciliation required), they are never a way back in.
      const integration = access.integrations.getById(scope, integrationId);
      return integration && integration.install_status === "active"
        ? {
            integration_id: integration.id,
            provider_instance_id: integration.provider_instance_id,
            repository_id: integration.repository_id,
          }
        : null;
    }
    // One integration per workspace is the normal shape; pick the first
    // active one. A workspace whose only integrations are suspended or
    // uninstalled has no verifiable repository authority and fails closed.
    const [integration] = access.integrations
      .listByWorkspace(scope)
      .filter((row) => row.install_status === "active");
    return integration
      ? {
          integration_id: integration.id,
          provider_instance_id: integration.provider_instance_id,
          repository_id: integration.repository_id,
        }
      : null;
  }

  function liveGrantKinds(
    scope: WorkspaceScope,
    integrationId: string,
    userId: UserId,
    now: Date,
  ): CapabilityKind[] {
    const live: CapabilityGrant[] = access.grants.listLive(scope, integrationId, {
      grantee_user_id: userId,
      now: now.toISOString(),
    });
    return live.map((grant) => grant.capability);
  }

  function ceilingInput(
    scope: WorkspaceScope,
    userId: UserId,
    now: Date,
  ): CapabilityCeilingView["evaluation"] | null {
    const membership = memberships.getByUser(scope, userId);
    const enterpriseUser = enterpriseUsers.getByUser(scope.enterprise_id, userId);
    if (membership === undefined || enterpriseUser?.status !== "active") {
      // The earlier dimensions deny this request; no ceiling row is created for
      // a stranger or a suspended member.
      return null;
    }
    return capabilityCeilings.evaluate(scope, userId, { now });
  }

  function authorize(request: AccessRequest): AccessDecision {
    const now = request.now ?? clock();
    const scope = request.scope;
    const integration = resolveIntegration(scope, request.integration_id);

    // Subjects and authority are integration-scoped; without an installed
    // integration nobody has repository access.
    if (!integration) {
      return {
        allowed: false,
        action: request.action,
        subject: null,
        reason: "authority_unknown",
        requires_reconciliation: true,
        authority_verified_at: null,
        checked_at: now.toISOString(),
      };
    }

    // Every decision is recomputed from authoritative state at call time.
    // Nothing is memoized: grant expiry, verification freshness, membership
    // changes, and revocations must all take effect on the next check without
    // relying on any invalidation path.
    const user = users.getById(request.user_id);
    const workspace = workspaces.getById(scope, scope.workspace_id);
    const membership = memberships.getByUser(scope, request.user_id);

    // Enterprise membership is the authoritative enterprise_user row, not a
    // provider identity: login alone never enrolled anyone, and an
    // enterprise-suspended member has no access even while their workspace
    // membership and provider identity still exist. Enterprise administration
    // is deliberately not consulted — it never grants repository data access.
    const enterpriseUser = enterpriseUsers.getByUser(scope.enterprise_id, request.user_id);
    const isEnterpriseMember = enterpriseUser?.status === "active";

    // The provider subject behind this user for the integration's provider
    // instance. Identity linking is (provider instance, stable subject) only.
    const subject =
      identities
        .listByUser(request.user_id)
        .find((identity) => identity.provider_instance_id === integration.provider_instance_id)
        ?.subject ?? null;

    const authority = subject
      ? access.roster.getAuthority(scope, integration.integration_id, subject)
      : undefined;

    // A workspace outside the scope's enterprise is never visible here: the
    // scope-filtered reads above return nothing for ID substitution.
    const workspaceRole: WorkspaceRole | null = workspace && membership ? membership.role : null;

    const ceiling = ceilingInput(scope, request.user_id, now);

    const decision = computeEffectiveAccess({
      action: request.action,
      enterprise: {
        member: isEnterpriseMember,
        user_status: user ? (user.status === "active" ? "active" : "suspended") : "suspended",
      },
      workspace_role: workspaceRole,
      repository: {
        subject,
        state: authority ? authority.state : "absent",
        last_verified_at: authority?.last_verified_at ?? null,
      },
      capability_grants: liveGrantKinds(scope, integration.integration_id, request.user_id, now),
      ...(ceiling !== null
        ? {
            capability_ceiling: {
              state: ceiling.state,
              capabilities: ceiling.capabilities,
              reason: ceiling.reason,
              persistence_failed: ceiling.persistence_failed,
            },
          }
        : {}),
      now,
      ...(freshWindowMs !== undefined ? { fresh_window_ms: freshWindowMs } : {}),
      ...(staleAfterMs !== undefined ? { stale_after_ms: staleAfterMs } : {}),
      policy,
    });

    return decision;
  }

  function assert(request: AccessRequest): AccessDecision {
    const decision = authorize(request);
    if (!decision.allowed) {
      throw new AccessDeniedError(decision);
    }
    return decision;
  }

  function revoke(
    scope: WorkspaceScope,
    target: RevocationTarget,
    reason: string,
    at: string,
  ): RevocationEffects {
    return revokeAuthority(access, epoch, scope, target, reason, at);
  }

  function projection(
    scope: WorkspaceScope,
    userId: UserId,
    now: Date = clock(),
  ): CapabilityProjection {
    const view = capabilityCeilings.view(scope, userId, { now });
    const actions: CapabilityProjection["actions"] = {};
    for (const action of Object.keys(policy) as ActionKind[]) {
      const decision = authorize({ scope, user_id: userId, action, now });
      actions[action] = {
        allowed: decision.allowed,
        required: requiredCapabilityForAction(action),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        ...(decision.requires_reconciliation === true ? { requires_reconciliation: true } : {}),
      };
    }
    const freshness = capabilityCeilings.freshness();
    return {
      schema_version: "workspace-capability-v1",
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      assigned_role: (view.assigned_role as WorkspaceRole | null) ?? null,
      state: view.evaluation.state,
      blocked_reason: view.evaluation.reason,
      capabilities: view.evaluation.capabilities,
      actions,
      repositories: view.evaluation.repositories.map((repository) => ({
        repository_id: repository.repository_id,
        provider_instance_id: repository.provider_instance_id,
        state: repository.state,
        capabilities: repository.capabilities,
        reason: repository.reason,
        verified_at: repository.verified_at,
      })),
      ceiling: view.ceiling,
      authority: {
        verified_at: view.evaluation.verified_at,
        fresh_window_ms: freshness.fresh_window_ms,
        stale_after_ms: freshness.stale_after_ms,
        set_version: view.evaluation.set_version,
        repository_count: view.evaluation.repository_count,
      },
      checked_at: view.evaluation.checked_at,
    };
  }

  return {
    authorize,
    assert,
    revoke,
    epoch: () => epoch.current(),
    projection,
  };
}
