/**
 * Workspace authorization status (DAT-296, ADR-0011).
 *
 * One read-only operational view for a workspace administrator, answering the
 * three questions an incident needs without exposing protected content:
 *
 * 1. **Which versions decided this?** The build schema, the database schema,
 *    the immutable rollout gate and the workspace's repository-set version.
 *    A database newer than the build is reported as `mixed_version: true`;
 *    authorization refuses on that state, and this view is how an operator
 *    sees why.
 * 2. **What authority exists right now?** The caller's own versioned
 *    authorization context — state, safe refusal code, per-repository
 *    evidence freshness and the effective capability intersection. It is the
 *    same evaluation a request would make, never a cached projection.
 * 3. **Are refusals abnormal?** Denial counts by safe code, action and
 *    capability reason inside a bounded window, from the append-only
 *    authorization audit. No actor identity, target URL, credential or
 *    resource content is disclosed.
 *
 * This endpoint is deliberately not a grant and not an authorization
 * projection: it is workspace-scoped evidence for someone already authorized
 * to administer the workspace. Every protected request still decides on its
 * own.
 */

import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { AuthorizationAuditRepository } from "../control-plane/authorization-audit-repositories.js";
import {
  AUTHORIZATION_DENIAL_WINDOW_MAX_MS,
  AUTHORIZATION_DENIAL_WINDOW_MIN_MS,
} from "../control-plane/authorization-audit-repositories.js";
import type {
  AuthorizationContext,
  AuthorizationContextService,
  RepositoryTarget,
} from "../provider-access/authorization-context.js";
import type {
  CapabilityBlockReason,
  RepositoryCapability,
} from "../control-plane/member-capability-types.js";
import type { WorkspaceScope } from "../control-plane/types.js";
import type { WorkspaceRepositorySetErrorCode } from "../control-plane/workspace-repository-types.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";

export const AUTHORIZATION_STATUS_SCHEMA_VERSION = "1";

/** Freshness class derived from the oldest verification bound. */
export type EvidenceFreshnessState = "fresh" | "stale" | "expired" | "unknown";

export interface AuthorizationStatusFreshness {
  verified_at: string | null;
  fresh_window_ms: number;
  stale_after_ms: number;
  /** Per-repository class; the set's class is the worst of these. */
  state: EvidenceFreshnessState;
}

export interface AuthorizationStatusRepository {
  repository_id: string;
  provider_instance_id: string;
  state: "verified" | "unverified" | "removed";
  capabilities: readonly RepositoryCapability[];
  reason: CapabilityBlockReason | null;
  verified_at: string | null;
  freshness: EvidenceFreshnessState;
  target: boolean;
}

export interface AuthorizationStatusCaller {
  /** False when the versioned context could not be evaluated at all. */
  evaluated: boolean;
  allowed: boolean;
  code: string | null;
  status: number | null;
  reason: string | null;
  capability_reason: CapabilityBlockReason | null;
  requires_reconciliation: boolean;
  required_capability: RepositoryCapability | null;
  target: RepositoryTarget | null;
  repository_set_version: number | null;
  context_schema_version: number | null;
  capabilities: readonly RepositoryCapability[];
  available_capabilities: readonly RepositoryCapability[];
  freshness: AuthorizationStatusFreshness;
  repositories: readonly AuthorizationStatusRepository[];
}

export interface AuthorizationStatusSet {
  readable: boolean;
  /** Safe refusal code when the set could not be read. */
  unreadable_reason: WorkspaceRepositorySetErrorCode | null;
  version: number | null;
  repository_count: number | null;
  multi_repository: boolean | null;
  usable: boolean | null;
  blocked_reason: WorkspaceRepositorySetErrorCode | null;
}

export interface AuthorizationStatusGate {
  key: string;
  state: "enabled" | "disabled" | "unreadable";
  min_schema_version: number | null;
  unreadable_code: string | null;
}

export interface AuthorizationStatusDenials {
  since: string;
  until: string;
  window_ms: number;
  total: number;
  by_code: ReadonlyArray<{ code: string; count: number }>;
  by_action: ReadonlyArray<{ action: string; count: number }>;
  by_capability_reason: ReadonlyArray<{ code: string; count: number }>;
  /** Sparse UTC hourly counts; a missing hour is a zero. */
  series: ReadonlyArray<{ bucket_start: string; count: number }>;
}

export interface WorkspaceAuthorizationStatus {
  schema_version: typeof AUTHORIZATION_STATUS_SCHEMA_VERSION;
  enterprise_id: string;
  workspace_id: string;
  checked_at: string;
  build: {
    schema_version: number;
    database_schema_version: number;
    /** True when another process migrated the database past this build. */
    mixed_version: boolean;
  };
  rollout: {
    gate: AuthorizationStatusGate;
    /** This build's complete-set enforcement mode (not a rollout switch). */
    enforcement: "complete" | "none";
  };
  repository_set: AuthorizationStatusSet;
  caller: AuthorizationStatusCaller;
  denials: AuthorizationStatusDenials;
}

export interface AuthorizationStatusViewOptions {
  /** Defaults to 24 hours; clamped to the bounded denial window. */
  window_ms?: number;
}

export interface AuthorizationStatusService {
  /**
   * The status of one workspace for one caller. The enterprise is the
   * deployment's configured one (never a client-supplied tenant), and the
   * workspace is resolved against it.
   */
  view(
    workspaceId: string,
    userId: string,
    options?: AuthorizationStatusViewOptions,
  ): WorkspaceAuthorizationStatus;
}

export interface AuthorizationStatusDeps {
  /** The deployment's enterprise; a client never names a tenant. */
  enterprise_id: string;
  repositorySets: WorkspaceRepositorySetRepository;
  /** Unset keeps the caller block unevaluated rather than inventing authority. */
  contexts?: AuthorizationContextService;
  audit: AuthorizationAuditRepository;
  buildSchemaVersion: number;
  databaseSchemaVersion: () => number;
  clock?: () => Date;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function clampWindow(windowMs: number | undefined): number {
  if (windowMs === undefined || !Number.isFinite(windowMs)) {
    return DEFAULT_WINDOW_MS;
  }
  return Math.min(
    Math.max(Math.trunc(windowMs), AUTHORIZATION_DENIAL_WINDOW_MIN_MS),
    AUTHORIZATION_DENIAL_WINDOW_MAX_MS,
  );
}

function freshnessOf(
  verifiedAt: string | null,
  now: Date,
  freshWindowMs: number,
  staleAfterMs: number,
): EvidenceFreshnessState {
  if (verifiedAt === null) {
    return "unknown";
  }
  const verifiedMs = Date.parse(verifiedAt);
  if (Number.isNaN(verifiedMs)) {
    return "unknown";
  }
  const age = now.getTime() - verifiedMs;
  if (age <= freshWindowMs) {
    return "fresh";
  }
  if (age <= staleAfterMs) {
    return "stale";
  }
  return "expired";
}

const FRESHNESS_RANK: Readonly<Record<EvidenceFreshnessState, number>> = Object.freeze({
  fresh: 0,
  stale: 1,
  expired: 2,
  unknown: 3,
});

function worstFreshness(states: readonly EvidenceFreshnessState[]): EvidenceFreshnessState {
  if (states.length === 0) {
    return "unknown";
  }
  let worst: EvidenceFreshnessState = "fresh";
  for (const state of states) {
    if (FRESHNESS_RANK[state] > FRESHNESS_RANK[worst]) {
      worst = state;
    }
  }
  return worst;
}

export function createAuthorizationStatusService(
  deps: AuthorizationStatusDeps,
): AuthorizationStatusService {
  const clock = deps.clock ?? (() => new Date());
  const bounds = deps.contexts?.freshness() ?? {
    fresh_window_ms: 15 * 60 * 1000,
    stale_after_ms: 24 * 60 * 60 * 1000,
  };

  /**
   * `ControlPlaneError.code` is a plain string; the set boundary only throws
   * its own typed codes. Unknown values stay visible but are not invented into
   * an authorization meaning.
   */
  function setCode(code: string): WorkspaceRepositorySetErrorCode | null {
    return code.length > 0 ? (code as WorkspaceRepositorySetErrorCode) : null;
  }

  function readSet(scope: WorkspaceScope): AuthorizationStatusSet {
    try {
      const set = deps.repositorySets.getSet(scope);
      return {
        readable: true,
        unreadable_reason: null,
        version: set.set_version,
        repository_count: set.bindings.length,
        multi_repository: set.multi_repository,
        usable: set.usable,
        blocked_reason: set.blocked_reason,
      };
    } catch (error) {
      if (error instanceof WorkspaceRepositorySetError) {
        return {
          readable: false,
          unreadable_reason: setCode(error.code),
          version: null,
          repository_count: null,
          multi_repository: null,
          usable: false,
          blocked_reason: setCode(error.code),
        };
      }
      throw error;
    }
  }

  function readGate(): AuthorizationStatusGate {
    try {
      const gate = deps.repositorySets.gate();
      return {
        key: gate.key,
        state: gate.state,
        min_schema_version: gate.min_schema_version,
        unreadable_code: null,
      };
    } catch (error) {
      if (error instanceof WorkspaceRepositorySetError) {
        return {
          key: "multi_repository_workspace",
          state: "unreadable",
          min_schema_version: null,
          unreadable_code: error.code,
        };
      }
      throw error;
    }
  }

  function readCaller(scope: WorkspaceScope, userId: string, now: Date): AuthorizationStatusCaller {
    const empty: AuthorizationStatusCaller = {
      evaluated: false,
      allowed: false,
      code: null,
      status: null,
      reason: null,
      capability_reason: null,
      requires_reconciliation: false,
      required_capability: null,
      target: null,
      repository_set_version: null,
      context_schema_version: null,
      capabilities: [],
      available_capabilities: [],
      freshness: {
        verified_at: null,
        fresh_window_ms: bounds.fresh_window_ms,
        stale_after_ms: bounds.stale_after_ms,
        state: "unknown",
      },
      repositories: [],
    };
    if (deps.contexts === undefined) {
      return empty;
    }
    let context: AuthorizationContext;
    try {
      context = deps.contexts.evaluate({
        scope,
        user_id: userId,
        action: "read",
        now,
      });
    } catch (error) {
      if (error instanceof WorkspaceRepositorySetError) {
        return { ...empty, code: error.code };
      }
      // An unexpected failure is still reported as "not evaluated": this
      // endpoint never invents authority it could not establish.
      return empty;
    }
    const repositories: AuthorizationStatusRepository[] = context.repositories.map(
      (repository) => ({
        repository_id: repository.repository_id,
        provider_instance_id: repository.provider_instance_id,
        state: repository.state,
        capabilities: repository.capabilities,
        reason: repository.reason,
        verified_at: repository.verified_at,
        freshness: freshnessOf(
          repository.verified_at,
          now,
          context.freshness.fresh_window_ms,
          context.freshness.stale_after_ms,
        ),
        target: repository.target,
      }),
    );
    return {
      evaluated: true,
      allowed: context.decision.allowed,
      code: context.decision.code,
      status: context.decision.status,
      reason: context.decision.reason,
      capability_reason: context.decision.capability_reason,
      requires_reconciliation: context.decision.requires_reconciliation,
      required_capability: context.decision.required_capability,
      target: context.repository_set.target,
      repository_set_version: context.repository_set.version,
      context_schema_version: context.schema_version,
      capabilities: context.capabilities,
      available_capabilities: context.available_capabilities,
      freshness: {
        verified_at: context.freshness.verified_at,
        fresh_window_ms: context.freshness.fresh_window_ms,
        stale_after_ms: context.freshness.stale_after_ms,
        state: worstFreshness(repositories.map((repository) => repository.freshness)),
      },
      repositories,
    };
  }

  return {
    view(workspaceId, userId, options = {}) {
      const scope: WorkspaceScope = {
        enterprise_id: deps.enterprise_id,
        workspace_id: workspaceId,
        actor_id: userId,
      };
      const now = clock();
      const windowMs = clampWindow(options.window_ms);
      const since = new Date(now.getTime() - windowMs).toISOString();
      const until = now.toISOString();
      const databaseVersion = deps.databaseSchemaVersion();
      const trend = deps.audit.denialTrend(scope, { since, until });
      return {
        schema_version: AUTHORIZATION_STATUS_SCHEMA_VERSION,
        enterprise_id: scope.enterprise_id,
        workspace_id: scope.workspace_id,
        checked_at: until,
        build: {
          schema_version: deps.buildSchemaVersion,
          database_schema_version: databaseVersion,
          mixed_version: databaseVersion > deps.buildSchemaVersion,
        },
        rollout: {
          gate: readGate(),
          enforcement: deps.contexts?.enforcement() ?? "none",
        },
        repository_set: readSet(scope),
        caller: readCaller(scope, userId, now),
        denials: {
          since: trend.since,
          until: trend.until,
          window_ms: trend.window_ms,
          total: trend.total,
          by_code: trend.by_code,
          by_action: trend.by_action,
          by_capability_reason: trend.by_capability_reason,
          series: trend.series,
        },
      };
    },
  };
}
