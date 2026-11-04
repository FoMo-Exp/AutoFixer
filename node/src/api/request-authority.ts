/**
 * Production request authorization boundary (DAT-203).
 *
 * This is where the provider-authority gate meets real requests. Every
 * protected HTTP request — read, stream, artifact, approval, write — passes
 * {@link RequestAuthority.require} before the route runs, so provider member
 * removal, `subject_authority = removed`, and capability-grant revocation are
 * enforced on the request path, not just in the service layer.
 *
 * Enforcement policy, deliberately explicit (Architect ruling, round 3):
 *
 * - **"Authority in play" is decided by existence, not by current status.**
 *   Any `service_integration` row for the workspace — `active`, `suspended`,
 *   or `uninstalled` — means this workspace has a provider roster and
 *   subject authority, so every request goes through the gate. Only a
 *   workspace with **zero rows** falls back to the pre-existing session-role
 *   behavior (local-prototype mode, ADR-0006).
 * - **A suspended or uninstalled integration fails closed.** The gate
 *   resolves no active integration and denies everything with
 *   `authority_unknown` + reconciliation required — the moment trust is
 *   lowest is not the moment to fall open. Deliberate deactivation back to
 *   prototype mode is a future, audited decision, never a status flip.
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
   * Whether provider authority is in play: the workspace has at least one
   * `service_integration` row, whatever its status. Only zero rows falls
   * back to the pre-existing session-role behavior; a suspended or
   * uninstalled integration fails closed through the gate. This is the
   * single predicate {@link RequestAuthority.check} uses — there is no
   * second, weaker meaning of enforcement.
   */
  isEnforcing(workspaceId?: WorkspaceId): boolean;
  /** Non-throwing decision (used by live streams re-checking on change). */
  check(userId: string, action: ActionKind, workspaceId?: WorkspaceId): AccessDecision;
  /** Enforce one request action; throws {@link ApiError} 403 on denial. */
  require(userId: string, action: ActionKind, workspaceId?: WorkspaceId): void;
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
  if (segments[0] !== "api" || segments[1] !== "v1") {
    return null;
  }
  // Two task route families share one action vocabulary: the legacy
  // `/api/v1/tasks...` seam and the workspace-scoped
  // `/api/v1/workspaces/{workspace_id}/tasks...` family (DAT-244).
  let tail: string[];
  if (segments[2] === "tasks") {
    tail = segments.slice(3);
  } else if (segments[2] === "workspaces" && segments[3] !== undefined && segments[4] === "tasks") {
    tail = segments.slice(5);
  } else {
    return null;
  }
  const taskId = tail[0];
  const sub = tail[1];
  const isReadMethod = method === "GET" || method === "HEAD";
  if (tail.length === 0) {
    if (isReadMethod) return "read";
    if (method === "POST") return "write";
    return null;
  }
  if (taskId === undefined) {
    return null;
  }
  if (tail.length === 1) {
    return isReadMethod ? "read" : null;
  }
  if (tail.length === 2 && isReadMethod) {
    if (sub === "runs" || sub === "timeline") return "read";
    if (sub === "stream") return "stream";
    return null;
  }
  if (tail.length === 3 && isReadMethod && sub === "artifacts" && tail[2] !== undefined) {
    return "artifact_read";
  }
  if (tail.length === 2 && method === "POST") {
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

  function scopeFor(userId: string, workspaceId?: WorkspaceId): WorkspaceScope {
    return {
      enterprise_id: deps.enterpriseId,
      // The path workspace selects the scope to evaluate; it is not a grant.
      // Only the membership read inside the gate can allow the action.
      workspace_id: workspaceId ?? deps.workspaceId,
      actor_id: userId,
    };
  }

  // Authority in play = at least one integration row exists (any status).
  // Existence, not current status: a suspended or uninstalled integration is
  // exactly when authority is least trustworthy and must fail closed — the
  // gate resolves no active integration and denies everything pending
  // reconciliation. Only a workspace with zero rows is a local prototype.
  function authorityInPlay(workspaceId?: WorkspaceId): boolean {
    return deps.access.integrations.listByWorkspace(scopeFor("system", workspaceId)).length > 0;
  }

  function check(userId: string, action: ActionKind, workspaceId?: WorkspaceId): AccessDecision {
    if (!authorityInPlay(workspaceId)) {
      // Zero integration rows: no provider roster exists anywhere for this
      // workspace, so the request stays bounded by the session-role checks.
      return {
        allowed: true,
        action,
        subject: null,
        authority_verified_at: null,
        checked_at: (deps.clock ? deps.clock() : new Date()).toISOString(),
      };
    }
    return gate.authorize({ scope: scopeFor(userId, workspaceId), user_id: userId, action });
  }

  return {
    epoch,
    isEnforcing: authorityInPlay,
    check,
    require(userId: string, action: ActionKind, workspaceId?: WorkspaceId): void {
      const decision = check(userId, action, workspaceId);
      if (!decision.allowed) {
        throw apiErrorForDenial(decision);
      }
    },
    subscribe(listener: () => void): () => void {
      return epoch.subscribe(listener);
    },
  };
}
