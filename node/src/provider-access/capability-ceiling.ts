/**
 * Repository capability ceiling evaluation (DAT-276, ADR-0011).
 *
 * ## The decision
 *
 * For one member and one workspace, every active repository binding is
 * verified independently, translated into capabilities, and then intersected.
 * Any repository that cannot produce verified evidence blocks the whole
 * workspace: a missing, unknown, stale, expired, unsupported, incomplete or
 * unapproved fact is never "the last known role is probably fine".
 *
 * ## What is persisted, and what is not
 *
 * - A **confirmed** reduction (the provider positively reports a lower
 *   capability set or lost access) is persisted with its reason, applies in
 *   every process, survives a restart, and stays in force after the provider
 *   recovers. Recovery is observable (`available_ceiling`) but never applied;
 *   an audited administrator reapproval is required to raise the ceiling.
 * - A **temporary** inability to verify is not a downgrade. It blocks access
 *   for its duration and clears itself when the same facts verify again; no
 *   authority, ceiling or audit decision is rewritten on a guess.
 *
 * ## Concurrency
 *
 * Every evaluation re-reads the store and the provider facts; there is no
 * cached verdict. A concurrent confirmed reduction is applied at most once
 * (`version` guard), and the loser re-reads the stricter stored value. A
 * confirmed reduction that cannot be written (or audited) blocks workspace
 * access instead of acting on an unauditable decision.
 */

import { SYSTEM_ACTOR } from "../control-plane/db.js";
import {
  CapabilityCeilingError,
  type CapabilityCeilingErrorCode,
} from "../control-plane/errors.js";
import type { IdentityRepositories } from "../control-plane/identity-repositories.js";
import type { MemberCapabilityRepository } from "../control-plane/member-capability-repositories.js";
import type {
  CapabilityBlockReason,
  CapabilityCeilingState,
  MemberCapabilityCeiling,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type {
  MembershipRepository,
  ProviderInstanceRepository,
} from "../control-plane/repositories.js";
import type { WorkspaceScope } from "../control-plane/types.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { AuthorityEpoch } from "./access-gate.js";
import {
  grantSupportedByCeiling,
  intersectRepositoryCapabilities,
  normalizeCapabilitySet,
  providerRoleCapabilities,
} from "./repository-capabilities.js";
import type { RepositoryCapabilityEvidence } from "./repository-capabilities.js";
import { WORKSPACE_ROLE_RANK } from "./types.js";

/** One day: the bound after which an `active` verification is not current. */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Fifteen minutes: the fresh window sensitive actions report in projections. */
const DEFAULT_FRESH_WINDOW_MS = 15 * 60 * 1000;

export interface CapabilityCeilingDeps {
  /** The authoritative, versioned repository set (DAT-281). */
  repositorySets: WorkspaceRepositorySetRepository;
  access: ProviderAccessRepositories;
  memberships: MembershipRepository;
  providerInstances: ProviderInstanceRepository;
  identity: IdentityRepositories;
  capabilities: MemberCapabilityRepository;
  /** Shared "authority changed" signal; a confirmed reduction bumps it. */
  epoch?: AuthorityEpoch;
  clock?: () => Date;
  staleAfterMs?: number;
  freshWindowMs?: number;
}

export interface CapabilityCeilingEvaluation {
  /** Effective state a decision may act on. */
  state: CapabilityCeilingState;
  /** Effective intersection (empty unless `verified`). */
  capabilities: RepositoryCapability[];
  reason: CapabilityBlockReason | null;
  /** Per-repository evidence, in binding order. */
  repositories: RepositoryCapabilityEvidence[];
  /** Intersection of the repositories that *did* verify (diagnostics only). */
  available_capabilities: RepositoryCapability[];
  /** Persisted ceiling row, after any confirmed change in this evaluation. */
  record: MemberCapabilityCeiling | null;
  /** True when a provider recovery exceeds the persisted ceiling (no auto-raise). */
  promotion_available: boolean;
  /** A confirmed reduction could not be persisted/audited; access must deny. */
  persistence_failed: boolean;
  set_version: number;
  /** Oldest verification timestamp among the repositories (safe bound). */
  verified_at: string | null;
  checked_at: string;
  repository_count: number;
}

export interface CapabilityCeilingView {
  evaluation: CapabilityCeilingEvaluation;
  assigned_role: string | null;
  /** True when the caller's own `manage` capability is currently proven. */
  can_manage: boolean;
  /** Persisted state/report fields; safe for the member to see. */
  ceiling: {
    state: MemberCapabilityCeiling["state"] | null;
    capabilities: RepositoryCapability[];
    reason: string | null;
    version: number | null;
    verified_at: string | null;
    promotion_available: boolean;
  };
}

export interface ReapproveCeilingRequest {
  workspace_id: string;
  user_id: string;
  /** `null` means: use the verified intersection as-is. */
  capabilities: readonly RepositoryCapability[] | null;
  /** Optimistic token of the persisted ceiling row. */
  version: number;
}

export interface CapabilityCeilingService {
  /** Evaluate (and, for confirmed changes, persist) one member's ceiling. */
  evaluate(
    scope: WorkspaceScope,
    userId: string,
    options?: { now?: Date; persist?: boolean },
  ): CapabilityCeilingEvaluation;
  /** Member-facing projection data (used by the access gate's projection). */
  view(scope: WorkspaceScope, userId: string, options?: { now?: Date }): CapabilityCeilingView;
  /**
   * Audited administrator reapproval inside the verified boundary. Enterprise
   * administration *and* verified repository management capability are both
   * required; the requested set may never exceed what the providers prove.
   */
  reapprove(
    scope: WorkspaceScope,
    actorUserId: string,
    input: ReapproveCeilingRequest,
  ): MemberCapabilityCeiling;
  /** Safe reason → API code mapping for callers. */
  freshness(): { fresh_window_ms: number; stale_after_ms: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oldest(timestamps: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of timestamps) {
    if (value === null) {
      continue;
    }
    if (best === null || Date.parse(value) < Date.parse(best)) {
      best = value;
    }
  }
  return best;
}

function isSubset(
  subset: readonly RepositoryCapability[],
  superset: readonly RepositoryCapability[],
): boolean {
  return subset.every((capability) => superset.includes(capability));
}

function sameSet(a: readonly RepositoryCapability[], b: readonly RepositoryCapability[]): boolean {
  return isSubset(a, b) && isSubset(b, a);
}

function blockedReasonSummary(
  state: CapabilityCeilingState,
  reason: CapabilityBlockReason | null,
): string {
  if (state === "unverified") {
    return "Repository capability evidence is not currently verifiable across every repository; workspace access fails closed until it is.";
  }
  if (state === "confirmed_loss") {
    return reason === "no_code_read"
      ? "Verified provider capabilities do not include code read on every repository, so workspace access is not eligible."
      : "The provider confirmed a loss of repository access; workspace access is blocked until an administrator reapproves it.";
  }
  return "Repository capabilities are verified.";
}

export function capabilityBlockSummary(
  evaluation: Pick<CapabilityCeilingEvaluation, "state" | "reason">,
): string {
  return blockedReasonSummary(evaluation.state, evaluation.reason);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createCapabilityCeilingService(
  deps: CapabilityCeilingDeps,
): CapabilityCeilingService {
  const {
    repositorySets,
    access,
    memberships,
    providerInstances,
    identity,
    capabilities,
    epoch,
    clock = () => new Date(),
  } = deps;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const freshWindowMs = deps.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;

  /**
   * Build one repository's evidence. Every branch that cannot prove a
   * capability returns `unverified` with a safe reason; only a positively
   * complete fact set returns `verified`.
   */
  function evidenceFor(
    scope: WorkspaceScope,
    binding: {
      repository_id: string;
      provider_instance_id: string;
      installation_ref: string | null;
    },
    userId: string,
    now: Date,
  ): RepositoryCapabilityEvidence {
    const base = {
      repository_id: binding.repository_id,
      provider_instance_id: binding.provider_instance_id,
      integration_id: binding.installation_ref,
      capabilities: [] as RepositoryCapability[],
      verified_at: null as string | null,
    };
    if (binding.installation_ref === null) {
      return { ...base, state: "unverified", reason: "installation_not_approved" };
    }
    const integration = access.integrations.getById(scope, binding.installation_ref);
    if (
      integration === undefined ||
      integration.install_status !== "active" ||
      integration.repository_id !== binding.repository_id
    ) {
      return { ...base, state: "unverified", reason: "installation_not_approved" };
    }
    if (integration.permission_visibility === "none") {
      return { ...base, state: "unverified", reason: "permission_visibility_none" };
    }
    if (integration.permission_visibility === "partial") {
      // A partial roster cannot enumerate every access path, so it cannot
      // establish admission or an action ceiling (ADR-0011).
      return { ...base, state: "unverified", reason: "permission_visibility_partial" };
    }
    const provider = providerInstances.getById(scope, binding.provider_instance_id);
    if (provider === undefined) {
      return { ...base, state: "unverified", reason: "provider_instance_unapproved" };
    }
    const subject =
      identity.identities
        .listByUser(userId)
        .find((identity) => identity.provider_instance_id === binding.provider_instance_id)
        ?.subject ?? null;
    if (subject === null) {
      return { ...base, state: "unverified", reason: "subject_missing" };
    }
    const authority = access.roster.getAuthority(scope, integration.id, subject);
    if (authority === undefined) {
      return { ...base, state: "unverified", reason: "authority_unknown" };
    }
    if (authority.state === "removed") {
      return { ...base, state: "removed", reason: "repository_access_removed" };
    }
    if (authority.state === "unknown") {
      return { ...base, state: "unverified", reason: "authority_unknown" };
    }
    if (authority.state === "stale") {
      return { ...base, state: "unverified", reason: "authority_stale" };
    }
    const verifiedAt = authority.last_verified_at;
    const verifiedMs = verifiedAt === null ? Number.NaN : Date.parse(verifiedAt);
    if (Number.isNaN(verifiedMs)) {
      return { ...base, state: "unverified", reason: "authority_unknown" };
    }
    if (now.getTime() - verifiedMs > staleAfterMs) {
      return {
        ...base,
        state: "unverified",
        reason: "verification_expired",
        verified_at: verifiedAt,
      };
    }
    const rows = access.roster
      .listRoles(scope, integration.id)
      .filter((row) => row.subject === subject);
    if (rows.length === 0) {
      return { ...base, state: "unverified", reason: "role_missing", verified_at: verifiedAt };
    }
    const proven: RepositoryCapability[] = [];
    for (const row of rows) {
      const mapped = providerRoleCapabilities(
        provider.provider_type,
        row.source_kind,
        row.provider_role,
      );
      if (!mapped.supported) {
        // Unknown or custom role vocabulary: never inferred into a capability.
        return {
          ...base,
          state: "unverified",
          reason: "unsupported_role",
          verified_at: verifiedAt,
        };
      }
      proven.push(...mapped.capabilities);
    }
    return {
      ...base,
      state: "verified",
      reason: null,
      capabilities: normalizeCapabilitySet(proven),
      verified_at: verifiedAt,
    };
  }

  /**
   * Revoke live capability grants a tightened ceiling no longer supports.
   * Runs after the confirmed reduction is persisted, so the grant cannot
   * outlive the capability even if this loop is interrupted: the next
   * authorization already denies.
   */
  function revokeUnsupportedGrants(
    scope: WorkspaceScope,
    userId: string,
    ceiling: readonly RepositoryCapability[],
    at: string,
  ): void {
    for (const integration of access.integrations.listByWorkspace(scope)) {
      const live = access.grants.listLive(scope, integration.id, {
        grantee_user_id: userId,
        now: at,
      });
      for (const grant of live) {
        if (!grantSupportedByCeiling(grant.capability, ceiling)) {
          access.grants.revoke(scope, grant.id, "capability ceiling reduced", at);
        }
      }
    }
  }

  function evaluate(
    scope: WorkspaceScope,
    userId: string,
    options: { now?: Date; persist?: boolean } = {},
  ): CapabilityCeilingEvaluation {
    const now = options.now ?? clock();
    const at = now.toISOString();
    const persist = options.persist ?? true;

    // The membership is the outer requirement: a ceiling is only meaningful for
    // someone the workspace has assigned a role to. Without one the gate denies
    // earlier and no row is created for a stranger.
    const membership = memberships.getByUser(scope, userId);

    let setVersion = 0;
    let bindings: Array<{
      repository_id: string;
      provider_instance_id: string;
      installation_ref: string | null;
    }> = [];
    let setBlocked: CapabilityBlockReason | null = null;
    try {
      const set = repositorySets.getSet(scope);
      setVersion = set.set_version;
      bindings = set.bindings.map((binding) => ({
        repository_id: binding.repository_id,
        provider_instance_id: binding.provider_instance_id,
        installation_ref: binding.installation_ref,
      }));
      if (set.blocked_reason === "WORKSPACE_ARCHIVED") {
        setBlocked = "workspace_archived";
      } else if (set.blocked_reason !== null) {
        // A multi-repository set this build cannot enforce: every repository is
        // still verified and intersected (the engine is general), but the
        // workspace scope itself authorizes nothing until the gate opens.
        setBlocked = "repository_set_unsupported";
      }
    } catch (error) {
      if (!(error instanceof WorkspaceRepositorySetError)) {
        throw error;
      }
      setBlocked =
        error.code === "REPOSITORY_BINDING_MISSING"
          ? "repository_missing"
          : error.code === "REPOSITORY_BINDING_INCONSISTENT"
            ? "repository_binding_inconsistent"
            : error.code === "WORKSPACE_ARCHIVED"
              ? "workspace_archived"
              : error.code === "INSTALLATION_NOT_APPROVED"
                ? "installation_not_approved"
                : error.code === "REPOSITORY_BINDING_UNAPPROVED"
                  ? "provider_instance_unapproved"
                  : "repository_set_unsupported";
    }

    const repositories = bindings.map((binding) => evidenceFor(scope, binding, userId, now));
    const verified = repositories.filter((repository) => repository.state === "verified");
    const removed = repositories.find((repository) => repository.state === "removed");
    const unverified = repositories.find((repository) => repository.state === "unverified");
    const available = intersectRepositoryCapabilities(
      verified.map((repository) => repository.capabilities),
    );

    let state: CapabilityCeilingState;
    let reason: CapabilityBlockReason | null = null;
    if (setBlocked !== null) {
      state = "unverified";
      reason = setBlocked;
    } else if (removed !== undefined) {
      state = "confirmed_loss";
      reason = "repository_access_removed";
    } else if (unverified !== undefined) {
      state = "unverified";
      reason = unverified.reason;
    } else if (repositories.length === 0) {
      state = "unverified";
      reason = "repository_missing";
    } else if (!available.includes("code_read")) {
      // Verified but not eligible: only a member with code read in every
      // repository may join or act.
      state = "confirmed_loss";
      reason = "no_code_read";
    } else {
      state = "verified";
    }

    const verifiedAt = oldest(repositories.map((repository) => repository.verified_at));
    let record = capabilities.get(scope, userId);
    let persistenceFailed = false;

    if (persist && membership !== undefined && setBlocked === null) {
      // Automatic consequences of provider facts are attributed to the
      // deployment in the append-only audit trail, never to the member whose
      // ceiling changed: the member did not decide this.
      const actor = { actor_id: SYSTEM_ACTOR, actor_kind: "deployment" as const };
      try {
        if (state === "verified" || state === "confirmed_loss") {
          const target = state === "verified" ? available : [];
          if (record === undefined) {
            record = capabilities.initialize(
              scope,
              userId,
              {
                ceiling: target,
                available_ceiling: target,
                set_version: setVersion,
                verified_at: verifiedAt ?? at,
                reason: state === "verified" ? "initial" : (reason ?? "confirmed_loss"),
              },
              actor,
            );
          } else if (!isSubset(record.ceiling, target)) {
            // A confirmed reduction: persist it, audit it, tighten grants.
            const result = capabilities.applyDowngrade(
              scope,
              userId,
              {
                ceiling: target,
                available_ceiling: target,
                expected_version: record.version,
                set_version: setVersion,
                verified_at: verifiedAt ?? at,
                reason: reason ?? "provider_downgrade",
              },
              actor,
            );
            record = result.record;
            revokeUnsupportedGrants(scope, userId, record.ceiling, at);
            epoch?.bump();
          } else if (
            !sameSet(target, record.available_ceiling) ||
            record.set_version !== setVersion
          ) {
            // A provider recovery (or a new set version) is recorded for
            // observability only. The ceiling is NOT raised: that needs an
            // audited administrator reapproval.
            try {
              record = capabilities.observeAvailability(
                scope,
                userId,
                {
                  available_ceiling: target,
                  expected_version: record.version,
                  set_version: setVersion,
                  verified_at: verifiedAt ?? at,
                },
                actor,
              );
            } catch {
              // A concurrent evaluator recorded a newer observation; re-read.
              record = capabilities.get(scope, userId) ?? record;
            }
          }
        }
      } catch (error) {
        if (error instanceof CapabilityCeilingError) {
          throw error;
        }
        persistenceFailed = true;
      }
    }

    const effective =
      state === "verified" && record !== undefined
        ? record.ceiling.filter((capability) => available.includes(capability))
        : state === "verified"
          ? available
          : [];
    const finalState: CapabilityCeilingState =
      persistenceFailed && state !== "unverified" ? "unverified" : state;

    return {
      state: finalState,
      capabilities: finalState === "verified" ? normalizeCapabilitySet(effective) : [],
      reason: persistenceFailed ? "capability_store_unavailable" : reason,
      repositories,
      available_capabilities: available,
      record: record ?? null,
      promotion_available:
        record !== undefined &&
        record.state === "downgraded" &&
        !sameSet(record.ceiling, available) &&
        isSubset(record.ceiling, available),
      persistence_failed: persistenceFailed,
      set_version: setVersion,
      verified_at: verifiedAt,
      checked_at: at,
      repository_count: repositories.length,
    };
  }

  function view(
    scope: WorkspaceScope,
    userId: string,
    options: { now?: Date } = {},
  ): CapabilityCeilingView {
    const evaluation = evaluate(scope, userId, options);
    const membership = memberships.getByUser(scope, userId);
    const callerCanManage =
      membership !== undefined &&
      WORKSPACE_ROLE_RANK[membership.role] >= WORKSPACE_ROLE_RANK.admin &&
      evaluation.state === "verified" &&
      evaluation.capabilities.includes("repository_manage");
    return {
      evaluation,
      assigned_role: membership?.role ?? null,
      can_manage: callerCanManage,
      ceiling: {
        state: evaluation.record?.state ?? null,
        capabilities: evaluation.record?.ceiling ?? [],
        reason: evaluation.record?.reason ?? null,
        version: evaluation.record?.version ?? null,
        verified_at: evaluation.record?.verified_at ?? null,
        promotion_available: evaluation.promotion_available,
      },
    };
  }

  function reapprove(
    scope: WorkspaceScope,
    actorUserId: string,
    input: ReapproveCeilingRequest,
  ): MemberCapabilityCeiling {
    const actor = { actor_id: actorUserId };

    function refuse(
      code: CapabilityCeilingErrorCode,
      message: string,
      status: 403 | 409 = 403,
    ): never {
      capabilities.auditDenial(scope, input.user_id, actor, {
        code,
        detail: message,
        ...(input.capabilities !== null ? { requested: input.capabilities } : {}),
      });
      throw new CapabilityCeilingError(code, message, status);
    }

    // 1. Enterprise administration is required — repository management alone
    //    does not reach this surface.
    const enterpriseUser = identity.enterpriseUsers.getByUser(scope.enterprise_id, actorUserId);
    const enterpriseRole = identity.enterpriseRoles.getByUser(scope.enterprise_id, actorUserId);
    if (
      enterpriseUser === undefined ||
      enterpriseUser.status !== "active" ||
      enterpriseRole?.role !== "admin"
    ) {
      return refuse(
        "CAPABILITY_ADMIN_REQUIRED",
        "an active enterprise administrator is required to reapprove a capability ceiling",
      );
    }

    // 2. The caller must also prove repository management capability in the
    //    target workspace: enterprise administration never becomes repository
    //    authority, and a legacy administrator entry cannot bypass this check.
    const caller = evaluate(scope, actorUserId, { persist: false });
    const callerMembership = memberships.getByUser(scope, actorUserId);
    if (
      callerMembership === undefined ||
      WORKSPACE_ROLE_RANK[callerMembership.role] < WORKSPACE_ROLE_RANK.admin ||
      caller.state !== "verified" ||
      !caller.capabilities.includes("repository_manage")
    ) {
      return refuse(
        "CAPABILITY_MANAGEMENT_REQUIRED",
        "the caller lacks verified repository management capability across the workspace's repositories",
      );
    }

    // 3. The target's facts must be verifiable right now.
    const target = evaluate(scope, input.user_id);
    if (target.state === "unverified" || target.persistence_failed) {
      return refuse(
        "CAPABILITY_CEILING_UNAVAILABLE",
        "the member's repository capabilities are not currently verifiable; reapproval is refused until they are",
        409,
      );
    }
    if (!target.available_capabilities.includes("code_read")) {
      return refuse(
        "CAPABILITY_CEILING_NOT_ELIGIBLE",
        "the member is not eligible for workspace access: verified capabilities lack code read on every repository",
      );
    }
    if (target.record === null) {
      return refuse(
        "CAPABILITY_CEILING_UNAVAILABLE",
        "no capability ceiling has been recorded for this member yet",
        409,
      );
    }
    if (target.record.version !== input.version) {
      return refuse(
        "CAPABILITY_CEILING_MISMATCH",
        `The member's capability ceiling was modified concurrently (expected version ${input.version}, found ${target.record.version})`,
        409,
      );
    }
    const requested = normalizeCapabilitySet(input.capabilities ?? target.available_capabilities);
    if (!isSubset(requested, target.available_capabilities)) {
      return refuse(
        "CAPABILITY_CEILING_EXCEEDS_VERIFIED",
        "the requested capabilities exceed what the providers currently prove",
      );
    }

    const updated = capabilities.reapprove(
      scope,
      input.user_id,
      {
        ceiling: requested,
        available_ceiling: target.available_capabilities,
        expected_version: input.version,
        set_version: target.set_version,
        verified_at: target.verified_at ?? target.checked_at,
      },
      actor,
    );
    epoch?.bump();
    return updated;
  }

  return {
    evaluate,
    view,
    reapprove,
    freshness: () => ({ fresh_window_ms: freshWindowMs, stale_after_ms: staleAfterMs }),
  };
}
