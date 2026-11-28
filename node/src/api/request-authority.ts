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
import type { EnterpriseUserRepository } from "../control-plane/enterprise-user-repositories.js";
import type {
  MembershipRepository,
  TeamRepository,
  WorkspaceRepository,
} from "../control-plane/repositories.js";
import type { EnterpriseId, WorkspaceId, WorkspaceScope } from "../control-plane/types.js";
import type { CapabilityCeilingService } from "../provider-access/capability-ceiling.js";
import { requiredCapabilityForAction } from "../provider-access/repository-capabilities.js";
import { CURRENT_SCHEMA_VERSION } from "../control-plane/db.js";
import type { AuthorizationAuditRepository } from "../control-plane/authorization-audit-repositories.js";
import type {
  AuthorizationContextService,
  AuthorizationDecisionCode,
  RepositoryTarget,
} from "../provider-access/authorization-context.js";
import type { SecurityDutyDirectory } from "../security/duties.js";
import {
  createAccessGate,
  createAuthorityEpoch,
  DEFAULT_ACTION_POLICY,
  type AccessDecision,
  type AccessGate,
  type ActionKind,
  type ActionPolicy,
  type AuthorityEpoch,
  type CapabilityProjection,
} from "../provider-access/index.js";
import { ApiError } from "./errors.js";

/**
 * Action policy for the HTTP surface. Identical to the provider-access
 * default except `write`: an API write is task-plane mutation (create task,
 * steer, cancel, archive), not a repository delivery write — delivery
 * writes demand the narrow expiring capability grants in the delivery
 * broker. The collaboration delivery surface uses the additive `delivery`
 * class: a sensitive member action whose separate delivery grant and
 * candidate-bound approval the broker re-checks before every provider write.
 * Revocation still denies every action class and revokes the grants in the
 * same call.
 */
export const HTTP_ACTION_POLICY: Readonly<Record<ActionKind, ActionPolicy>> = Object.freeze({
  ...DEFAULT_ACTION_POLICY,
  write: { min_role: "member", sensitivity: "sensitive" },
  issue_sync: { min_role: "member", sensitivity: "sensitive" },
});

export interface RequestAuthorityDeps {
  access: ProviderAccessRepositories;
  memberships: MembershipRepository;
  workspaces: WorkspaceRepository;
  users: UserRepository;
  identities: IdentityRepository;
  /** Enterprise membership/status gate evaluated before provider authority. */
  enterpriseUsers: EnterpriseUserRepository;
  /**
   * Verified repository capability ceilings (DAT-276). Required, not optional:
   * every request is additionally bounded by the intersection of provider
   * capabilities over the workspace's repository set.
   */
  capabilityCeilings: CapabilityCeilingService;
  /**
   * The versioned authorization context (DAT-291, DAT-294). When set, every
   * request is decided by one evaluation over the **complete** active
   * repository set — enterprise status, assigned role, action policy, the set
   * at its current version, the applicable target and the persisted ceiling —
   * instead of the single-integration access gate. This is the same engine the
   * run-start and worker-step boundary uses, so a route cannot authorize a
   * multi-repository workspace from one repository's roster. Unset keeps the
   * pre-DAT-294 single-integration decision.
   */
  contexts?: AuthorizationContextService;
  /** Workspace teams, for the memory team-leader exception (DAT-278). */
  teams?: Pick<TeamRepository, "list">;
  /** Enterprise administrator grant; metadata surfaces only, never repository data. */
  isEnterpriseAdmin?: (userId: string) => boolean;
  /** Human-only security duties; unset grants no security module access. */
  securityDuties?: SecurityDutyDirectory;
  enterpriseId: EnterpriseId;
  workspaceId: WorkspaceId;
  /**
   * Shared authority epoch. Supplying the deployment's epoch (DAT-276) means a
   * confirmed capability reduction signaled by the ceiling service closes live
   * SSE subscriptions in this process; decisions themselves are never cached.
   */
  epoch?: AuthorityEpoch;
  /**
   * Append-only denial audit (DAT-296). Every refusal on a protected request
   * path appends one safe record (actor, workspace, action, target identity,
   * set/context/build versions, decision code). Allowed requests are not
   * recorded here: their own domain transaction carries the required audit
   * row, and the authorization boundary adds the fact domains never see — the
   * refusal. Unset keeps the boundary unaudited (test/legacy wiring only).
   */
  authorizations?: AuthorizationAuditRepository;
  clock?: () => Date;
  freshWindowMs?: number;
  staleAfterMs?: number;
}

/**
 * What a request acts on, beyond its workspace (DAT-294).
 *
 * A route that serves one resource names the repository that resource belongs
 * to (an issue, a delivery) or the target the run was bound to (a task, its
 * stream, its artifacts). A workspace-level route names nothing: the complete
 * set is then the bound, and a capability grant must hold on every binding.
 */
export interface RequestAuthorityScope {
  /** Immutable target identity, when the caller already holds it. */
  target?: RepositoryTarget | null;
  /**
   * A repository id the resource names. The authority resolves it against the
   * current set and denies when it is not an active binding — an unbound
   * repository is never treated as "no target".
   */
  repository_id?: string;
  /**
   * The set version the caller's decision observed (a live subscription, a
   * queued action). A mismatch is a 409 and never a stale allow; omit for a
   * fresh read, which evaluates the current set.
   */
  expected_set_version?: number;
}

/** One request decision, with the stable code a route surfaces. */
export interface RequestAuthorityDecision extends AccessDecision {
  /** Stable decision code (context code, or the legacy classification). */
  code: AuthorizationDecisionCode | "FORBIDDEN";
  /**
   * The repository-set version and context schema the decision was formed
   * against (DAT-296). Present when the versioned context decided; absent for
   * the legacy single-integration path. Recorded with a denial so evidence
   * names the exact facts that were refused, never a later re-read.
   */
  repository_set_version?: number | null;
  target?: RepositoryTarget | null;
  context_schema_version?: number | null;
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
  check(
    userId: string,
    action: ActionKind,
    workspaceId?: WorkspaceId,
    scope?: RequestAuthorityScope,
  ): RequestAuthorityDecision;
  /** Enforce one request action; throws {@link ApiError} on denial. */
  require(
    userId: string,
    action: ActionKind,
    workspaceId?: WorkspaceId,
    scope?: RequestAuthorityScope,
  ): void;
  /** Subscribe to authority changes (revocation cuts live streams). */
  subscribe(listener: () => void): () => void;
  /** Shared authority-change signal; revoke/reconcile/events bump it. */
  readonly epoch: AuthorityEpoch;
  /**
   * The caller's workspace capability projection (DAT-278): advisory snapshot
   * for navigation only — every request is still checked object by object.
   */
  projection(userId: string, workspaceId?: WorkspaceId): CapabilityProjection;
  /** Freshness bounds used by both workspace and enterprise projections. */
  freshness(): { fresh_window_ms: number; stale_after_ms: number };
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
  } else if (
    segments[2] === "workspaces" &&
    segments[3] !== undefined &&
    segments[4] === "task-targets"
  ) {
    // The target-selection read is an ordinary workspace read (DAT-292): the
    // caller's membership and verified repository authority bound it, exactly
    // like listing task history.
    return segments.length === 5 && (method === "GET" || method === "HEAD") ? "read" : null;
  } else if (
    segments[2] === "workspaces" &&
    segments[3] !== undefined &&
    segments[4] === "issues"
  ) {
    tail = segments.slice(5);
    if (tail.length === 0) {
      if (method === "GET" || method === "HEAD") return "read";
      if (method === "POST") return "issue_sync";
      return null;
    }
    if (tail.length === 1) return method === "GET" || method === "HEAD" ? "read" : null;
    if (tail.length === 2 && (method === "GET" || method === "HEAD")) {
      if (tail[1] === "stream") return "stream";
      return "read";
    }
    if (tail.length === 2 && method === "POST") {
      if (tail[1] === "rollback" || tail[1] === "comments") return "issue_sync";
      // Candidate-bound approval requests and broker-controlled deliveries are
      // sensitive member actions; the approval gate itself is `approval`
      // (admin + fresh repository authority) below.
      if (tail[1] === "approvals" || tail[1] === "deliveries") return "delivery";
      return null;
    }
    if (tail.length === 3 && (method === "GET" || method === "HEAD")) {
      return "read";
    }
    // Docker-style nested reads (the PR governance observation) carry one more
    // segment; they are reads too and must never skip the authority gate.
    if (tail.length === 4 && (method === "GET" || method === "HEAD")) {
      return "read";
    }
    if (tail.length === 4 && method === "POST") {
      if (tail[1] === "approvals" && tail[3] === "decision") return "approval";
      if (tail[1] === "deliveries" && tail[3] === "reconcile") return "delivery";
      return null;
    }
    if (tail.length === 1 && method === "PATCH") return "issue_sync";
    return null;
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

function apiErrorForDenial(decision: RequestAuthorityDecision): ApiError {
  const action = decision.action;
  const details = {
    action,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(decision.capability_reason !== null && decision.capability_reason !== undefined
      ? { capability_reason: decision.capability_reason }
      : {}),
  };
  if (decision.code === "REPOSITORY_SET_VERSION_CONFLICT") {
    // The decision was formed against a repository-set version that moved.
    // Nothing is authorized against the stale scope: the caller re-reads.
    return new ApiError(
      409,
      "REPOSITORY_SET_VERSION_CONFLICT",
      "The workspace repository set changed after this decision was formed; re-read it before retrying.",
      details,
    );
  }
  if (decision.requires_reconciliation === true || decision.code === "REPOSITORY_SET_UNAVAILABLE") {
    // AUTHORITY_RECHECK_REQUIRED is the existing reconciliation-stage
    // envelope code: unknown or stale provider authority blocks the action
    // pending a successful reconciliation. A set-level refusal (unsupported
    // shape, archived workspace, inconsistent binding) keeps the same
    // envelope: this build cannot establish authority over that set, and the
    // precise capability reason travels in `details`.
    return new ApiError(
      403,
      "AUTHORITY_RECHECK_REQUIRED",
      "Repository authority is not currently verifiable; this action is blocked pending reconciliation.",
      details,
      { next_action: "reconcile" },
    );
  }
  return new ApiError(
    403,
    "FORBIDDEN",
    "The caller's repository authority does not permit this action.",
    details,
    { next_action: "request_review" },
  );
}

export function createRequestAuthority(deps: RequestAuthorityDeps): RequestAuthority {
  const epoch = deps.epoch ?? createAuthorityEpoch();
  const gate: AccessGate = createAccessGate({
    access: deps.access,
    memberships: deps.memberships,
    workspaces: deps.workspaces,
    users: deps.users,
    identities: deps.identities,
    enterpriseUsers: deps.enterpriseUsers,
    capabilityCeilings: deps.capabilityCeilings,
    ...(deps.teams !== undefined ? { teams: deps.teams } : {}),
    ...(deps.isEnterpriseAdmin !== undefined ? { isEnterpriseAdmin: deps.isEnterpriseAdmin } : {}),
    ...(deps.securityDuties !== undefined ? { securityDuties: deps.securityDuties } : {}),
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

  function nowIso(): string {
    return (deps.clock ? deps.clock() : new Date()).toISOString();
  }

  /**
   * The target a request acts on. A resource that names a repository is
   * resolved against the current set: an unbound repository is refused with
   * `TARGET_REPOSITORY_UNAVAILABLE`, never downgraded to a workspace-wide
   * decision that would let a removed repository keep authorizing its
   * resources. Two differing explicit identities are refused the same way.
   */
  function resolveScopeTarget(
    userId: string,
    workspaceId: WorkspaceId | undefined,
    scope: RequestAuthorityScope,
  ): { target: RepositoryTarget | null } | { denial: RequestAuthorityDecision["code"] } {
    let target = scope.target ?? null;
    if (scope.repository_id !== undefined) {
      const resolved = deps.contexts?.targetFor(scopeFor(userId, workspaceId), scope.repository_id);
      if (resolved === null || resolved === undefined) {
        return { denial: "TARGET_REPOSITORY_UNAVAILABLE" };
      }
      if (target !== null && target.repository_id !== resolved.repository_id) {
        return { denial: "TARGET_REPOSITORY_UNAVAILABLE" };
      }
      target = resolved;
    }
    return { target };
  }

  function decideWithContext(
    userId: string,
    action: ActionKind,
    workspaceId: WorkspaceId | undefined,
    scope: RequestAuthorityScope,
  ): RequestAuthorityDecision {
    const at = nowIso();
    const resolved = resolveScopeTarget(userId, workspaceId, scope);
    if ("denial" in resolved) {
      return {
        allowed: false,
        action,
        subject: null,
        reason: "target_repository",
        requires_reconciliation: false,
        capability_reason: null,
        authority_verified_at: null,
        checked_at: at,
        code: resolved.denial,
        repository_set_version: scope.expected_set_version ?? null,
        target: scope.target ?? null,
        context_schema_version: null,
      };
    }
    const context = deps.contexts!.evaluate({
      scope: scopeFor(userId, workspaceId),
      user_id: userId,
      action,
      target: resolved.target,
      ...(scope.expected_set_version !== undefined
        ? { expected_set_version: scope.expected_set_version }
        : {}),
      ...(deps.clock !== undefined ? { now: deps.clock() } : {}),
    });
    const decision = context.decision;
    return {
      allowed: decision.allowed,
      action,
      subject: null,
      ...(decision.reason !== null ? { reason: decision.reason } : {}),
      requires_reconciliation: decision.requires_reconciliation,
      capability_reason: decision.capability_reason,
      authority_verified_at: context.freshness.verified_at,
      checked_at: context.checked_at,
      code: decision.code,
      repository_set_version: context.repository_set.version,
      target: resolved.target,
      context_schema_version: context.schema_version,
    };
  }

  function check(
    userId: string,
    action: ActionKind,
    workspaceId?: WorkspaceId,
    scope: RequestAuthorityScope = {},
  ): RequestAuthorityDecision {
    if (deps.contexts !== undefined && authorityInPlay(workspaceId)) {
      // One evaluation over the complete active set, with the applicable
      // target and observed version — the same rule the run-start and
      // worker-step boundary applies. Never cached: a set or permission
      // change in any process applies to the very next request.
      //
      // A workspace with zero integration rows has no repository authority to
      // intersect (ADR-0006 local-prototype shape): it keeps the pre-existing
      // abstention below, where the route's own role/object checks decide.
      // The context still reports that shape as `not_applicable` for its other
      // consumers.
      return decideWithContext(userId, action, workspaceId, scope);
    }
    // Pre-DAT-294 single-integration decision (kept for deployments that have
    // not configured the complete-set engine).
    // Enterprise status is the outer boundary: a missing or suspended
    // membership fails closed for every action, including workspaces with no
    // provider integration (local-prototype mode is not an enterprise
    // suspension bypass).
    const enterpriseUser = deps.enterpriseUsers.getByUser(deps.enterpriseId, userId);
    if (enterpriseUser === undefined || enterpriseUser.status !== "active") {
      return {
        allowed: false,
        action,
        subject: null,
        reason: enterpriseUser?.status === "suspended" ? "user_suspended" : "enterprise_membership",
        authority_verified_at: null,
        checked_at: nowIso(),
        code:
          enterpriseUser?.status === "suspended"
            ? "USER_SUSPENDED"
            : "ENTERPRISE_MEMBERSHIP_REQUIRED",
      };
    }
    if (!authorityInPlay(workspaceId)) {
      // Zero integration rows: no provider roster exists anywhere for this
      // workspace, so the request stays bounded by the session-role checks.
      return {
        allowed: true,
        action,
        subject: null,
        authority_verified_at: null,
        checked_at: nowIso(),
        code: "ALLOWED",
      };
    }
    const decision = gate.authorize({
      scope: scopeFor(userId, workspaceId),
      user_id: userId,
      action,
    });
    return {
      ...decision,
      code: decision.allowed
        ? "ALLOWED"
        : decision.requires_reconciliation === true
          ? "AUTHORITY_RECHECK_REQUIRED"
          : "FORBIDDEN",
    };
  }

  return {
    epoch,
    isEnforcing: authorityInPlay,
    check,
    require(
      userId: string,
      action: ActionKind,
      workspaceId?: WorkspaceId,
      scope: RequestAuthorityScope = {},
    ): void {
      const decision = check(userId, action, workspaceId, scope);
      if (!decision.allowed) {
        // Required evidence: append the refusal before it is surfaced. A
        // failure to record propagates (the action stays refused); it is never
        // swallowed into an allow.
        deps.authorizations?.recordDenial({
          enterprise_id: deps.enterpriseId,
          workspace_id: workspaceId ?? deps.workspaceId,
          actor_kind: "user",
          actor_user_id: userId,
          action,
          decision_code: decision.code,
          reason: decision.reason ?? null,
          capability_reason: decision.capability_reason ?? null,
          required_capability: requiredCapabilityForAction(action),
          requires_reconciliation: decision.requires_reconciliation === true,
          target: decision.target ?? null,
          repository_set_version: decision.repository_set_version ?? null,
          context_schema_version: decision.context_schema_version ?? null,
          build_schema_version: CURRENT_SCHEMA_VERSION,
        });
        throw apiErrorForDenial(decision);
      }
    },
    subscribe(listener: () => void): () => void {
      return epoch.subscribe(listener);
    },
    projection(userId: string, workspaceId?: WorkspaceId): CapabilityProjection {
      return gate.projection(scopeFor(userId, workspaceId), userId);
    },
    freshness(): { fresh_window_ms: number; stale_after_ms: number } {
      return deps.capabilityCeilings.freshness();
    },
  };
}
