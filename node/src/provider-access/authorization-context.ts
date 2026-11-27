/**
 * Versioned authorization context (DAT-291, ADR-0011).
 *
 * ## What this module is
 *
 * One evaluation produces **the whole authorization fact** for one member and
 * one action: enterprise membership, workspace role, the workspace's complete
 * active repository set at one version, per-repository verified capability
 * evidence, the intersected ceiling, freshness, and the requested target. Every
 * consumer (request gate, worker step, delivery, later task dispatch) can make
 * its decision from this object instead of re-deriving part of it — which is
 * what makes "the intersection over *every* repository" a single rule rather
 * than one rule per route.
 *
 * ## The rules it encodes
 *
 * - **Set intersection, not role ranking.** Write on repository A and read on B
 *   yields read: no capability on one repository is compensated by another.
 *   Any repository without verified code read denies admission.
 * - **Unknown is not loss.** Missing, stale, expired, unavailable, partial or
 *   unsupported evidence denies the action for as long as it lasts but never
 *   persists a downgrade. A positively confirmed loss *is* persisted by the
 *   capability ceiling, and only an audited administrator reapproval raises it
 *   again.
 * - **Versioned.** The context names the `repository_set_version` it was formed
 *   against. A caller that observed version N is refused against N+1
 *   (`expected_set_version`, or `isCurrent`). No decision is cached, so every
 *   evaluation re-reads storage and provider facts.
 * - **Targeted, never guessed.** A target repository must be exactly one active
 *   binding of the set, matched by immutable `(provider_instance_id,
 *   repository_id)`. There is no "first repository" or deployment-default
 *   fallback.
 * - **Enforcement is explicit.** A multi-repository set is evaluated only when
 *   the capability engine is configured for complete-set enforcement *and* the
 *   immutable rollout gate is `enabled`. Otherwise it remains an unsupported
 *   shape that authorizes nothing. The feature gate is never bypassed here.
 *
 * ## What it deliberately is not
 *
 * Role, policy and repository capability are included; *security duties*,
 * module visibility and object-level resource checks are separate dimensions
 * owned by their own modules and stay in force. This context never becomes a
 * bearer token: callers re-evaluate for each new action.
 */

import type { EnterpriseUserRepository } from "../control-plane/enterprise-user-repositories.js";
import type { UserRepository } from "../control-plane/identity-repositories.js";
import type {
  CapabilityBlockReason,
  CapabilityCeilingState,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { MembershipRepository } from "../control-plane/repositories.js";
import type { UserId, WorkspaceRole, WorkspaceScope } from "../control-plane/types.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { WorkspaceRepositorySet } from "../control-plane/workspace-repository-types.js";
import type {
  CapabilityCeilingEvaluation,
  CapabilityCeilingService,
} from "./capability-ceiling.js";
import { requiredCapabilityForAction } from "./repository-capabilities.js";
import {
  DEFAULT_ACTION_POLICY,
  WORKSPACE_ROLE_RANK,
  type ActionKind,
  type ActionPolicy,
  type DenyReason,
} from "./types.js";

/** The context schema a consumer may rely on; additive fields bump it. */
export const AUTHORIZATION_CONTEXT_SCHEMA_VERSION = 1;

const DEFAULT_FRESH_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling reasons that describe the *set* (or its configuration), not the
 * member's provider evidence. Reconciliation cannot fix them by itself, so the
 * decision reports a set refusal instead of asking for a recheck.
 */
const SET_LEVEL_BLOCK_REASONS: ReadonlySet<CapabilityBlockReason> = new Set([
  "workspace_archived",
  "repository_missing",
  "repository_set_unsupported",
  "repository_binding_inconsistent",
  "installation_not_approved",
  "provider_instance_unapproved",
]);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * One repository a caller names as the resource of the action (a run's target,
 * a delivery's destination). Identity is the immutable pair; names and URLs are
 * metadata and never appear here.
 */
export interface RepositoryTarget {
  provider_instance_id: string;
  repository_id: string;
}

export interface AuthorizationContextRequest {
  /** Enterprise + workspace scope. The workspace is never client-authored. */
  scope: WorkspaceScope;
  user_id: UserId;
  action: ActionKind;
  /** Optional target repository of the action. */
  target?: RepositoryTarget | null;
  /**
   * The repository-set version the caller observed. A mismatch refuses with
   * `REPOSITORY_SET_VERSION_CONFLICT`; omit only where the caller is forming
   * the first decision (a new request re-reads the set anyway).
   */
  expected_set_version?: number;
  /** Override "now" for freshness evaluation (tests, replay). */
  now?: Date;
}

export interface AuthorizationRepositoryEvidence {
  repository_id: string;
  provider_instance_id: string;
  installation_id: string | null;
  state: "verified" | "unverified" | "removed";
  capabilities: RepositoryCapability[];
  reason: CapabilityBlockReason | null;
  verified_at: string | null;
  /** True when this binding is the requested target. */
  target: boolean;
}

/**
 * Stable decision codes. They are additive to the request gate's `DenyReason`
 * vocabulary: `code` is the caller-facing classification, `reason` remains the
 * shared access-decision reason for existing consumers.
 */
export type AuthorizationDecisionCode =
  | "ALLOWED"
  | "ENTERPRISE_MEMBERSHIP_REQUIRED"
  | "USER_SUSPENDED"
  | "WORKSPACE_ROLE_REQUIRED"
  | "REPOSITORY_SET_UNAVAILABLE"
  | "REPOSITORY_SET_VERSION_CONFLICT"
  | "TARGET_REPOSITORY_UNAVAILABLE"
  | "AUTHORITY_RECHECK_REQUIRED"
  | "CAPABILITY_REQUIRED"
  | "CAPABILITY_LOSS"
  | "CAPABILITY_GRANT_REQUIRED";

export interface AuthorizationContextDecision {
  allowed: boolean;
  code: AuthorizationDecisionCode;
  /** HTTP status a route should surface for this decision. */
  status: 200 | 403 | 409;
  /** Shared access-decision reason (null when allowed). */
  reason: DenyReason | null;
  /** Precise capability-layer cause, safe to expose. */
  capability_reason: CapabilityBlockReason | null;
  /** True when a recheck after reconciliation may restore the action. */
  requires_reconciliation: boolean;
  /** The capability the action needs on every repository. */
  required_capability: RepositoryCapability;
}

export type AuthorizationContextState = "not_applicable" | CapabilityCeilingState;

export interface AuthorizationContext {
  schema_version: typeof AUTHORIZATION_CONTEXT_SCHEMA_VERSION;
  enterprise_id: string;
  workspace_id: string;
  user_id: string;
  action: ActionKind;
  enterprise: {
    member: boolean;
    user_status: "active" | "suspended";
  };
  workspace: {
    role: WorkspaceRole | null;
    member: boolean;
  };
  /**
   * `not_applicable` is the local-prototype shape (no service integration in
   * the workspace): the action stays bounded by enterprise membership, the
   * assigned role and policy, exactly as the request gate has always treated
   * it. Every other value is the verified repository capability state.
   */
  repository_authority: AuthorizationContextState;
  repository_set: {
    /** Storage version the context was formed against (0 when unreadable). */
    version: number;
    /** False when the set could not be read at all. */
    readable: boolean;
    repository_count: number;
    multi_repository: boolean;
    gate: "enabled" | "disabled" | "unreadable";
    /** True when the evaluation covered every binding of a multi-repo set. */
    enforced: boolean;
    target: RepositoryTarget | null;
    /** True when `expected_set_version` did not match the stored version. */
    version_conflict: boolean;
  };
  /** Per-repository evidence, in binding order. */
  repositories: readonly AuthorizationRepositoryEvidence[];
  /** Verified intersection before the persisted (approved) ceiling. */
  available_capabilities: readonly RepositoryCapability[];
  /** Effective capabilities the decision was made with. */
  capabilities: readonly RepositoryCapability[];
  ceiling: {
    /** Persisted ceiling state (`approved` may be raised by an administrator). */
    state: "approved" | "downgraded" | null;
    capabilities: readonly RepositoryCapability[];
    /** Persisted, human-readable reason (never provider secrets). */
    reason: string | null;
    version: number | null;
    verified_at: string | null;
    promotion_available: boolean;
  };
  freshness: {
    checked_at: string;
    /** Oldest verification across every repository (the safe bound). */
    verified_at: string | null;
    fresh_window_ms: number;
    stale_after_ms: number;
    fresh: boolean;
  };
  decision: AuthorizationContextDecision;
  checked_at: string;
}

/** Thrown by {@link AuthorizationContextService.assert}. */
export class AuthorizationContextError extends Error {
  constructor(
    readonly code: AuthorizationDecisionCode,
    readonly status: 403 | 409,
    readonly decision: AuthorizationContextDecision,
    message = `authorization denied: ${code}`,
  ) {
    super(message);
    this.name = "AuthorizationContextError";
  }
}

export interface AuthorizationContextDeps {
  /** The versioned repository set (DAT-281). */
  repositorySets: WorkspaceRepositorySetRepository;
  /**
   * The capability engine. Its `enforcement()` decides whether a
   * multi-repository set is evaluated as a whole; the immutable rollout gate
   * remains the outer decision.
   */
  capabilityCeilings: CapabilityCeilingService;
  memberships: MembershipRepository;
  enterpriseUsers: EnterpriseUserRepository;
  users: UserRepository;
  /** Integrations and live capability grants. */
  access: ProviderAccessRepositories;
  /**
   * Action policy. Defaults to {@link DEFAULT_ACTION_POLICY}; the HTTP surface
   * passes its own variant (an API write is not a repository delivery write).
   */
  policy?: Readonly<Record<ActionKind, ActionPolicy>>;
  clock?: () => Date;
  freshWindowMs?: number;
  staleAfterMs?: number;
}

export interface AuthorizationContextService {
  /** Compute (and, on confirmed change, persist) one versioned context. */
  evaluate(request: AuthorizationContextRequest): AuthorizationContext;
  /** Evaluate and throw {@link AuthorizationContextError} when denied. */
  assert(request: AuthorizationContextRequest): AuthorizationContext;
  /** True when the context still matches the workspace's current set version. */
  isCurrent(context: AuthorizationContext): boolean;
  freshness(): { fresh_window_ms: number; stale_after_ms: number };
  /** Whether this deployment evaluates a multi-repository set as a whole. */
  enforcement(): "complete" | "none";
  /**
   * Resolve the immutable target identity of an **active** binding by its
   * provider-assigned repository id (DAT-294). Consumers that hold a resource
   * naming a repository (an issue, a delivery) pass that id and get the one
   * binding that may authorize it — or `null` when the repository is not an
   * active binding of the workspace's current set, which a caller must refuse
   * rather than treat as "no target". The provider instance is read from the
   * set, never guessed from a deployment default.
   */
  targetFor(scope: WorkspaceScope, repositoryId: string): RepositoryTarget | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Freeze the context and every nested object/array.
 *
 * A shallow freeze would leave `decision.allowed`, `capabilities` or a
 * repository's evidence writable after the fact: a consumer that mutated them
 * would be passing an authorization fact the server never decided. The walk is
 * over plain data only (no class instances), uses a `WeakSet` so a shared or
 * cyclic reference cannot loop, and still descends into already-frozen
 * containers so no child escapes.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const nested of Object.values(object as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

interface DecisionFacts {
  action: ActionKind;
  enterprise_member: boolean;
  user_status: "active" | "suspended";
  role: WorkspaceRole | null;
  authority_in_play: boolean;
  evaluation: CapabilityCeilingEvaluation | null;
  target_bound: boolean;
  required_capability: RepositoryCapability;
  config: {
    policy: Readonly<Record<ActionKind, ActionPolicy>>;
    now: Date;
    freshWindowMs: number;
    staleAfterMs: number;
  };
  /** Live capability kinds proven for the action's scope (target-aware). */
  grants: "not_required" | "granted" | "missing";
  version_conflict: boolean;
  /** Set-level state independent of the ceiling (archived/gate shape). */
  set_unavailable: CapabilityBlockReason | null;
}

function deny(
  facts: DecisionFacts,
  code: AuthorizationDecisionCode,
  reason: DenyReason | null,
  options: {
    capability_reason?: CapabilityBlockReason | null;
    requires_reconciliation?: boolean;
    status?: 403 | 409;
  } = {},
): AuthorizationContextDecision {
  return {
    allowed: false,
    code,
    status: options.status ?? 403,
    reason,
    capability_reason: options.capability_reason ?? null,
    requires_reconciliation: options.requires_reconciliation === true,
    required_capability: facts.required_capability,
  };
}

function allowedDecision(facts: DecisionFacts): AuthorizationContextDecision {
  return {
    allowed: true,
    code: "ALLOWED",
    status: 200,
    reason: null,
    capability_reason: null,
    requires_reconciliation: false,
    required_capability: facts.required_capability,
  };
}

/**
 * The decision is a pure function of the evaluated facts, so the ordering is
 * auditable: identity and role first, then the version and the set, then the
 * target, then the ceiling, freshness and grants.
 */
function decide(facts: DecisionFacts): AuthorizationContextDecision {
  // 1. Enterprise membership. A suspended account loses everything; an
  //    enterprise administrator holding no membership gains nothing.
  if (facts.user_status !== "active") {
    return deny(facts, "USER_SUSPENDED", "user_suspended");
  }
  if (!facts.enterprise_member) {
    return deny(facts, "ENTERPRISE_MEMBERSHIP_REQUIRED", "enterprise_membership");
  }

  // 2. Workspace role and action policy.
  const policy = facts.config.policy[facts.action];
  if (
    facts.role === null ||
    WORKSPACE_ROLE_RANK[facts.role] < WORKSPACE_ROLE_RANK[policy.min_role]
  ) {
    return deny(facts, "WORKSPACE_ROLE_REQUIRED", "workspace_role");
  }

  // 3. The decision is bound to the version it observed.
  if (facts.version_conflict) {
    return deny(facts, "REPOSITORY_SET_VERSION_CONFLICT", "repository_set_version", {
      status: 409,
    });
  }

  // 4. Local-prototype shape: no provider authority is in play, so the action
  //    stays bounded by enterprise membership, role and policy. This is the
  //    unchanged legacy behavior, not an authorization bypass: the workspace
  //    has no integration row at all.
  if (!facts.authority_in_play) {
    return allowedDecision(facts);
  }

  // 5. Set-level unavailability (archived workspace, unsupported multi-repo
  //    shape, missing/inconsistent binding, unapproved instance/installation).
  if (facts.set_unavailable !== null) {
    return deny(facts, "REPOSITORY_SET_UNAVAILABLE", "capability_unverified", {
      capability_reason: facts.set_unavailable,
    });
  }

  // 6. The named target must be exactly one active binding of this set,
  //    matched by immutable identity. No fallback to another repository.
  if (!facts.target_bound) {
    return deny(facts, "TARGET_REPOSITORY_UNAVAILABLE", "target_repository");
  }

  const evaluation = facts.evaluation;
  if (evaluation === null) {
    // Defensive: authority in play always produces an evaluation.
    return deny(facts, "AUTHORITY_RECHECK_REQUIRED", "authority_unknown", {
      requires_reconciliation: true,
    });
  }

  // 7. The capability ceiling.
  if (evaluation.persistence_failed) {
    return deny(facts, "AUTHORITY_RECHECK_REQUIRED", "capability_persistence", {
      capability_reason: "capability_store_unavailable",
      requires_reconciliation: true,
    });
  }
  if (evaluation.state === "unverified") {
    // Unknown, stale, expired, partial or unsupported evidence: block the
    // action, record nothing as a downgrade, and allow a recheck to recover.
    return deny(facts, "AUTHORITY_RECHECK_REQUIRED", "capability_unverified", {
      capability_reason: evaluation.reason,
      requires_reconciliation: true,
    });
  }
  if (evaluation.state === "confirmed_loss") {
    return deny(facts, "CAPABILITY_LOSS", "capability_loss", {
      capability_reason: evaluation.reason,
    });
  }
  if (!evaluation.capabilities.includes(facts.required_capability)) {
    return deny(facts, "CAPABILITY_REQUIRED", "capability_ceiling", {
      capability_reason: evaluation.reason,
    });
  }

  // 8. Sensitive actions need a fresh verification *on every repository*. The
  //    oldest verification timestamp is the safe bound, so one stale
  //    repository cannot be carried by another's fresh one.
  if (policy.sensitivity === "sensitive") {
    const verifiedAt = evaluation.verified_at;
    const verifiedMs = verifiedAt === null ? Number.NaN : Date.parse(verifiedAt);
    if (Number.isNaN(verifiedMs)) {
      return deny(facts, "AUTHORITY_RECHECK_REQUIRED", "authority_unknown", {
        requires_reconciliation: true,
      });
    }
    const age = facts.config.now.getTime() - verifiedMs;
    if (age > facts.config.staleAfterMs) {
      return deny(facts, "AUTHORITY_RECHECK_REQUIRED", "authority_stale", {
        requires_reconciliation: true,
      });
    }
    if (age > facts.config.freshWindowMs) {
      return deny(facts, "AUTHORITY_RECHECK_REQUIRED", "verification_stale", {
        requires_reconciliation: true,
      });
    }
  }

  // 9. A capability-grant action needs a live grant scoped to the repository
  //    the action will touch. Without a target on a multi-repository set the
  //    grant must hold on every binding; a grant on one repository never
  //    authorizes a whole-set action.
  if (facts.grants === "missing") {
    return deny(facts, "CAPABILITY_GRANT_REQUIRED", "capability_grant");
  }

  return allowedDecision(facts);
}

export function createAuthorizationContextService(
  deps: AuthorizationContextDeps,
): AuthorizationContextService {
  const {
    repositorySets,
    capabilityCeilings,
    memberships,
    enterpriseUsers,
    users,
    access,
    clock = () => new Date(),
  } = deps;
  const policy = deps.policy ?? DEFAULT_ACTION_POLICY;
  const freshWindowMs = deps.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  function authorityInPlay(scope: WorkspaceScope): boolean {
    return access.integrations.listByWorkspace(scope).length > 0;
  }

  /**
   * Set summary for the local-prototype path and for reporting when the
   * capability engine refused the set. Never throws: the refusal itself is the
   * answer, and an unreadable set is reported as unreadable, never as empty.
   */
  function readSetSummary(scope: WorkspaceScope): {
    version: number;
    readable: boolean;
    count: number;
    multi: boolean;
    gate: "enabled" | "disabled" | "unreadable";
  } {
    let gate: "enabled" | "disabled" | "unreadable" = "unreadable";
    try {
      gate = repositorySets.gate().state;
    } catch {
      gate = "unreadable";
    }
    try {
      const set = repositorySets.getSet(scope);
      return {
        version: set.set_version,
        readable: true,
        count: set.bindings.length,
        multi: set.multi_repository,
        gate: set.gate.state,
      };
    } catch {
      return { version: 0, readable: false, count: 0, multi: false, gate };
    }
  }

  /** Live grant kinds for the action's scope, target-aware. */
  function grantScope(
    scope: WorkspaceScope,
    userId: string,
    target: RepositoryTarget | null,
    repositories: readonly AuthorizationRepositoryEvidence[],
    now: Date,
  ): string[] | "missing" {
    const integrationIds =
      target !== null
        ? repositories
            .filter(
              (repository) =>
                repository.repository_id === target.repository_id &&
                repository.provider_instance_id === target.provider_instance_id,
            )
            .map((repository) => repository.installation_id)
        : repositories.map((repository) => repository.installation_id);
    if (integrationIds.length === 0 || integrationIds.some((id) => id === null)) {
      return "missing";
    }
    // A grant must be live on every repository the action may touch; without a
    // target that is the whole set.
    const kindSets: Set<string>[] = [];
    for (const integrationId of integrationIds as string[]) {
      kindSets.push(
        new Set(
          access.grants
            .listLive(scope, integrationId, {
              grantee_user_id: userId,
              now: now.toISOString(),
            })
            .map((grant) => grant.capability),
        ),
      );
    }
    let common = kindSets[0] ?? new Set<string>();
    for (const kinds of kindSets.slice(1)) {
      common = new Set([...common].filter((kind) => kinds.has(kind)));
    }
    return [...common];
  }

  function evaluate(request: AuthorizationContextRequest): AuthorizationContext {
    const now = request.now ?? clock();
    const scope = request.scope;
    const at = now.toISOString();
    const user = users.getById(request.user_id);
    const enterpriseUser = enterpriseUsers.getByUser(scope.enterprise_id, request.user_id);
    const membership = memberships.getByUser(scope, request.user_id);
    const inPlay = authorityInPlay(scope);
    const requiredCapability = requiredCapabilityForAction(request.action);

    const summary = inPlay ? null : readSetSummary(scope);

    const evaluation = inPlay ? capabilityCeilings.evaluate(scope, request.user_id, { now }) : null;

    const readable =
      evaluation !== null ? evaluation.set_version > 0 : (summary?.readable ?? false);
    const setVersion = evaluation !== null ? evaluation.set_version : (summary?.version ?? 0);
    const multiRepository =
      evaluation !== null ? evaluation.multi_repository : (summary?.multi ?? false);
    const gate = evaluation !== null ? evaluation.gate_state : (summary?.gate ?? "unreadable");
    const versionConflict =
      request.expected_set_version !== undefined &&
      readable &&
      request.expected_set_version !== setVersion;

    const target = request.target ?? null;
    const repositories: AuthorizationRepositoryEvidence[] =
      evaluation === null
        ? []
        : evaluation.repositories.map((repository) => ({
            repository_id: repository.repository_id,
            provider_instance_id: repository.provider_instance_id,
            installation_id: repository.integration_id,
            state: repository.state,
            capabilities: repository.capabilities,
            reason: repository.reason,
            verified_at: repository.verified_at,
            target:
              target !== null &&
              target.repository_id === repository.repository_id &&
              target.provider_instance_id === repository.provider_instance_id,
          }));

    const targetMatches =
      target === null
        ? []
        : repositories.filter(
            (repository) =>
              repository.repository_id === target.repository_id &&
              repository.provider_instance_id === target.provider_instance_id,
          );
    // Exactly one active binding is required. A target that matches none is
    // foreign, retired or simply not this workspace's; two matches would be
    // ambiguous identity and are refused the same way.
    const targetBound = target === null || targetMatches.length === 1;

    const policyForAction = policy[request.action];
    let grants: DecisionFacts["grants"] = "not_required";
    if (policyForAction.requires_capability !== undefined && inPlay && evaluation !== null) {
      const live = grantScope(scope, request.user_id, target, repositories, now);
      grants =
        live !== "missing" && live.includes(policyForAction.requires_capability)
          ? "granted"
          : "missing";
    }

    // A set-level refusal (archived set, unsupported shape, unusable binding)
    // is not a provider-evidence outage: it is reported as such rather than as
    // "reconcile and retry".
    const setUnavailable: CapabilityBlockReason | null =
      evaluation !== null &&
      evaluation.state === "unverified" &&
      evaluation.reason !== null &&
      SET_LEVEL_BLOCK_REASONS.has(evaluation.reason)
        ? evaluation.reason
        : null;

    const facts: DecisionFacts = {
      action: request.action,
      enterprise_member: enterpriseUser?.status === "active",
      user_status:
        user === undefined ? "suspended" : user.status === "active" ? "active" : "suspended",
      role: membership?.role ?? null,
      authority_in_play: inPlay,
      evaluation,
      target_bound: targetBound,
      required_capability: requiredCapability,
      config: { policy, now, freshWindowMs, staleAfterMs },
      grants,
      version_conflict: versionConflict,
      set_unavailable: setUnavailable,
    };

    // A target mismatch is checked before the ceiling in `decide`; the ceiling
    // itself already reports an unusable set through its state.
    const decision = decide(facts);

    const repositoryAuthority: AuthorizationContextState = !inPlay
      ? "not_applicable"
      : (evaluation?.state ?? "unverified");

    const verifiedAt = evaluation?.verified_at ?? null;
    const verifiedMs = verifiedAt === null ? Number.NaN : Date.parse(verifiedAt);
    const fresh = !Number.isNaN(verifiedMs) && now.getTime() - verifiedMs <= freshWindowMs;

    const context: AuthorizationContext = {
      schema_version: AUTHORIZATION_CONTEXT_SCHEMA_VERSION,
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      user_id: request.user_id,
      action: request.action,
      enterprise: {
        member: enterpriseUser?.status === "active",
        user_status:
          user === undefined ? "suspended" : user.status === "active" ? "active" : "suspended",
      },
      workspace: {
        role: membership?.role ?? null,
        member: membership !== undefined,
      },
      repository_authority: repositoryAuthority,
      repository_set: {
        version: setVersion,
        readable,
        repository_count: evaluation?.repository_count ?? summary?.count ?? 0,
        multi_repository: multiRepository,
        gate,
        enforced: evaluation?.set_enforced ?? false,
        target,
        version_conflict: versionConflict,
      },
      repositories,
      available_capabilities: evaluation?.available_capabilities ?? [],
      capabilities: evaluation?.capabilities ?? [],
      ceiling: {
        state: evaluation?.record?.state ?? null,
        capabilities: evaluation?.record?.ceiling ?? [],
        reason: evaluation?.record?.reason ?? null,
        version: evaluation?.record?.version ?? null,
        verified_at: evaluation?.record?.verified_at ?? null,
        promotion_available: evaluation?.promotion_available ?? false,
      },
      freshness: {
        checked_at: at,
        verified_at: verifiedAt,
        fresh_window_ms: freshWindowMs,
        stale_after_ms: staleAfterMs,
        fresh,
      },
      decision,
      checked_at: at,
    };

    // Deep-freeze: every nested decision field and array is read-only, so a
    // context handed to another component cannot be rewritten into a decision
    // the server did not make.
    return deepFreeze(context);
  }

  return {
    evaluate,
    assert(request: AuthorizationContextRequest): AuthorizationContext {
      const context = evaluate(request);
      if (!context.decision.allowed) {
        throw new AuthorizationContextError(
          context.decision.code,
          context.decision.status === 409 ? 409 : 403,
          context.decision,
        );
      }
      return context;
    },
    isCurrent(context: AuthorizationContext): boolean {
      if (!context.repository_set.readable) {
        return false;
      }
      try {
        return (
          repositorySets.currentSetVersion({
            enterprise_id: context.enterprise_id,
            workspace_id: context.workspace_id,
            actor_id: context.user_id,
          }) === context.repository_set.version
        );
      } catch {
        return false;
      }
    },
    freshness: () => ({ fresh_window_ms: freshWindowMs, stale_after_ms: staleAfterMs }),
    enforcement: () => capabilityCeilings.enforcement(),
    targetFor(scope: WorkspaceScope, repositoryId: string): RepositoryTarget | null {
      let set: WorkspaceRepositorySet;
      try {
        set = repositorySets.getSet(scope);
      } catch {
        // An unreadable or unusable set proves no target: the caller refuses.
        return null;
      }
      const matches = set.bindings.filter(
        (binding) => binding.repository_id === repositoryId && binding.status === "active",
      );
      // Exactly one active binding per repository identity; two would be an
      // ambiguous identity and are refused rather than resolved.
      if (matches.length !== 1) {
        return null;
      }
      return {
        provider_instance_id: matches[0]!.provider_instance_id,
        repository_id: matches[0]!.repository_id,
      };
    },
  };
}
