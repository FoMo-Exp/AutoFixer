/**
 * Production request authorization boundary (DAT-203).
 *
 * This is where the provider-authority gate meets real requests. Every
 * protected HTTP request — read, stream, artifact, approval, write — passes
 * {@link RequestAuthority.require} before the route runs, so provider member
 * removal, `subject_authority = removed`, and capability-grant revocation are
 * enforced on the request path, not just in the service layer.
 *
 * Enforcement policy, deliberately explicit:
 *
 * - **When provider authority is in play** (a repository-scoped service
 *   integration is installed for the workspace), session actors must pass
 *   the effective-access gate for every action class. A denial is a 403 from
 *   the boundary — the route never runs.
 * - **When no integration is installed**, there is no provider roster and no
 *   provider authority to enforce: the surface keeps its pre-existing
 *   session-role behavior unchanged (local-prototype mode, ADR-0006).
 * - The **local-operator bearer** is the deployment's own credential, not a
 *   provider subject; it is unchanged by provider membership.
 *
 * Decisions are never cached (see `access-gate.ts`), so revocation, grant
 * expiry, and verification-freshness deadlines take effect on the very next
 * request in any process. Live SSE streams additionally subscribe to the
 * authority-change signal and close the moment authority is lost.
 */

import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { IdentityRepository, UserRepository } from "../control-plane/identity-repositories.js";
import type { MembershipRepository, WorkspaceRepository } from "../control-plane/repositories.js";
import type { EnterpriseId, WorkspaceId, WorkspaceScope } from "../control-plane/types.js";
import {
  createAccessGate,
  createAuthorityEpoch,
  DEFAULT_ACTION_POLICY,
  type AccessDecision,
  type AccessGate,
  type ActionKind,
  type ActionPolicy,
  type AuthorityEpoch,
} from "../provider-access/index.js";
import { ApiError } from "./errors.js";

/**
 * Action policy for the HTTP surface. Identical to the provider-access
 * default except `write`: an API write is task-plane mutation (create task,
 * steer, cancel, archive), not a repository delivery write — delivery
 * writes demand the narrow expiring capability grants in the delivery
 * broker. Revocation still denies all five action classes and revokes the
 * grants in the same call.
 */
export const HTTP_ACTION_POLICY: Readonly<Record<ActionKind, ActionPolicy>> = Object.freeze({
  ...DEFAULT_ACTION_POLICY,
  write: { min_role: "member", sensitivity: "sensitive" },
});

export interface RequestAuthorityDeps {
  access: ProviderAccessRepositories;
  memberships: MembershipRepository;
  workspaces: WorkspaceRepository;
  users: UserRepository;
  identities: IdentityRepository;
  enterpriseId: EnterpriseId;
  workspaceId: WorkspaceId;
  clock?: () => Date;
  freshWindowMs?: number;
  staleAfterMs?: number;
}

export interface RequestAuthority {
  /**
   * Whether provider authority is enforced right now: a repository-scoped
   * service integration is installed for the workspace. Evaluated live —
   * installing or uninstalling an integration changes enforcement on the
   * next request.
   */
  isEnforcing(): boolean;
  /** Non-throwing decision (used by live streams re-checking on change). */
  check(userId: string, action: ActionKind): AccessDecision;
  /** Enforce one request action; throws {@link ApiError} 403 on denial. */
  require(userId: string, action: ActionKind): void;
  /** Subscribe to authority changes (revocation cuts live streams). */
  subscribe(listener: () => void): () => void;
  /** Shared authority-change signal; revoke/reconcile/events bump it. */
  readonly epoch: AuthorityEpoch;
}

/**
 * Map an API request to the gate action class. Returns null for shapes that
 * fall through to 404 — an unknown route needs no authorization decision.
 */
export function actionForRequest(method: string, segments: string[]): ActionKind | null {
  if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "tasks") {
    return null;
  }
  const sub = segments[4];
  const isReadMethod = method === "GET" || method === "HEAD";
  if (segments.length === 3) {
    if (isReadMethod) return "read";
    if (method === "POST") return "write";
    return null;
  }
  if (segments.length === 4) {
    return isReadMethod ? "read" : null;
  }
  if (segments.length === 5 && isReadMethod) {
    if (sub === "runs" || sub === "timeline") return "read";
    if (sub === "stream") return "stream";
    return null;
  }
  if (segments.length === 6 && isReadMethod && sub === "artifacts") {
    return "artifact_read";
  }
  if (segments.length === 5 && method === "POST") {
    if (sub === "approvals") return "approval";
    if (sub === "messages" || sub === "cancel" || sub === "archive" || sub === "recover") {
      return "write";
    }
    return null;
  }
  return null;
}

function apiErrorForDenial(decision: AccessDecision): ApiError {
  const action = decision.action;
  if (decision.requires_reconciliation) {
    // AUTHORITY_RECHECK_REQUIRED is the existing reconciliation-stage
    // envelope code: unknown or stale provider authority blocks the action
    // pending a successful reconciliation.
    return new ApiError(
      403,
      "AUTHORITY_RECHECK_REQUIRED",
      "Repository authority is not currently verifiable; this action is blocked pending reconciliation.",
      { action, ...(decision.reason ? { reason: decision.reason } : {}) },
      { next_action: "reconcile" },
    );
  }
  return new ApiError(
    403,
    "FORBIDDEN",
    "The caller's repository authority does not permit this action.",
    { action, ...(decision.reason ? { reason: decision.reason } : {}) },
    { next_action: "request_review" },
  );
}

export function createRequestAuthority(deps: RequestAuthorityDeps): RequestAuthority {
  const scopeBase = {
    enterprise_id: deps.enterpriseId,
    workspace_id: deps.workspaceId,
  };
  const epoch = createAuthorityEpoch();
  const gate: AccessGate = createAccessGate({
    access: deps.access,
    memberships: deps.memberships,
    workspaces: deps.workspaces,
    users: deps.users,
    identities: deps.identities,
    epoch,
    policy: HTTP_ACTION_POLICY,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.freshWindowMs !== undefined ? { freshWindowMs: deps.freshWindowMs } : {}),
    ...(deps.staleAfterMs !== undefined ? { staleAfterMs: deps.staleAfterMs } : {}),
  });

  function scopeFor(userId: string): WorkspaceScope {
    return { ...scopeBase, actor_id: userId };
  }

  // Live evaluation: an installed integration is what makes provider
  // authority exist at all. Without one there is no provider roster to
  // enforce, and the surface keeps its pre-existing session-role behavior.
  function isEnforcing(): boolean {
    return deps.access.integrations
      .listByWorkspace(scopeFor("system"))
      .some((integration) => integration.install_status === "active");
  }

  function check(userId: string, action: ActionKind): AccessDecision {
    if (!isEnforcing()) {
      // Nothing to enforce: provider authority is not in play for this
      // workspace, so the request stays bounded by the session-role checks.
      return {
        allowed: true,
        action,
        subject: null,
        authority_verified_at: null,
        checked_at: (deps.clock ? deps.clock() : new Date()).toISOString(),
      };
    }
    return gate.authorize({ scope: scopeFor(userId), user_id: userId, action });
  }

  return {
    epoch,
    isEnforcing,
    check,
    require(userId: string, action: ActionKind): void {
      const decision = check(userId, action);
      if (!decision.allowed) {
        throw apiErrorForDenial(decision);
      }
    },
    subscribe(listener: () => void): () => void {
      return epoch.subscribe(listener);
    },
  };
}
