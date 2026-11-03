/**
 * Request-path access gate and revocation (DAT-203).
 *
 * Every read, stream, artifact, approval, and write goes through
 * {@link AccessGate.authorize}, which computes the effective-access
 * intersection from authoritative state. Two enforcement properties matter:
 *
 * - **Revocation takes effect in the same request path.** The gate's decision
 *   memo is stamped with an authority epoch; any revocation, event, or
 *   reconciliation bumps the epoch synchronously, so the very next check in
 *   the same request recomputes from the store and denies. A cached "allow"
 *   can never outlive the authority it was computed from.
 * - **Revocation stops everything and revokes capability grants.** Removing a
 *   subject stops read/stream/artifact/approval/write at once and revokes
 *   their live checkout/delivery grants in the same operation.
 *
 * Sensitive actions require fresh provider verification; unknown or stale
 * authority blocks them and marks the decision `requires_reconciliation`.
 */

import type { CapabilityGrant, CapabilityKind } from "../control-plane/provider-access-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { IdentityRepository, UserRepository } from "../control-plane/identity-repositories.js";
import type { MembershipRepository, WorkspaceRepository } from "../control-plane/repositories.js";
import type { UserId, WorkspaceRole, WorkspaceScope } from "../control-plane/types.js";
import { computeEffectiveAccess } from "./effective-access.js";
import { revokeAuthority, type RevocationEffects, type RevocationTarget } from "./revocation.js";
import {
  DEFAULT_ACTION_POLICY,
  type AccessDecision,
  type ActionKind,
  type ActionPolicy,
  type DenyReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Authority epoch — synchronous cache invalidation
// ---------------------------------------------------------------------------

/**
 * A monotonic counter bumped whenever repository authority may have changed.
 * The gate memoizes decisions only for the current epoch; revocation, provider
 * events, and reconciliation all bump it, so no stale allow survives a
 * revocation by even one request step.
 */
export interface AuthorityEpoch {
  current(): number;
  bump(): void;
}

export function createAuthorityEpoch(): AuthorityEpoch {
  let epoch = 0;
  return {
    current: () => epoch,
    bump: () => {
      epoch += 1;
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
  /** Shared with revocation/reconcile so memoization dies with revocation. */
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
   * Revoke a subject's repository authority: mark it `removed`, revoke live
   * capability grants, and invalidate the decision memo in the same call.
   */
  revoke(
    scope: WorkspaceScope,
    target: RevocationTarget,
    reason: string,
    at: string,
  ): RevocationEffects;
  /** Current epoch (observability/tests). */
  epoch(): number;
}

interface MemoEntry {
  epoch: number;
  decision: AccessDecision;
}

export function createAccessGate(deps: AccessGateDeps): AccessGate {
  const {
    access,
    memberships,
    workspaces,
    users,
    identities,
    epoch,
    clock = () => new Date(),
    freshWindowMs,
    staleAfterMs,
    policy = DEFAULT_ACTION_POLICY,
  } = deps;

  const memo = new Map<string, MemoEntry>();

  function resolveIntegration(
    scope: WorkspaceScope,
    integrationId: string | undefined,
  ): { integration_id: string; provider_instance_id: string; repository_id: string } | null {
    if (integrationId) {
      const integration = access.integrations.getById(scope, integrationId);
      return integration
        ? {
            integration_id: integration.id,
            provider_instance_id: integration.provider_instance_id,
            repository_id: integration.repository_id,
          }
        : null;
    }
    // One integration per workspace is the normal shape; pick the first
    // active one. Workspaces without an installed integration have no
    // repository authority at all.
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

    const cacheKey = `${integration.integration_id}|${request.user_id}|${request.action}`;
    const currentEpoch = epoch.current();
    const cached = memo.get(cacheKey);
    if (cached && cached.epoch === currentEpoch) {
      return cached.decision;
    }

    const user = users.getById(request.user_id);
    const workspace = workspaces.getById(scope, scope.workspace_id);
    const membership = memberships.getByUser(scope, request.user_id);

    // Enterprise membership: any recorded membership inside the enterprise,
    // or a provider identity registered against the enterprise's provider
    // instances. Enterprise administration is deliberately not consulted —
    // it never grants repository data access by itself.
    const isEnterpriseMember =
      identities.enterprisesOf(request.user_id).includes(scope.enterprise_id) ||
      memberships.listForUser(scope, request.user_id).length > 0;

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
      now,
      ...(freshWindowMs !== undefined ? { fresh_window_ms: freshWindowMs } : {}),
      ...(staleAfterMs !== undefined ? { stale_after_ms: staleAfterMs } : {}),
      policy,
    });

    memo.set(cacheKey, { epoch: currentEpoch, decision });
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
    const effects = revokeAuthority(access, epoch, scope, target, reason, at);
    memo.clear();
    return effects;
  }

  return { authorize, assert, revoke, epoch: () => epoch.current() };
}
