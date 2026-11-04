/**
 * Provider access service types (DAT-203).
 *
 * The provider adapter contract forces two declarations the rest of the
 * system depends on:
 *
 * - **Effective permission visibility.** Whether the adapter can see who
 *   currently has repository access at all. `none` means authority cannot be
 *   verified — that is an error state, never an empty roster.
 * - **Pagination and rate limits.** Roster collection enforces them: a
 *   truncated or exhausted fetch is an {@link IncompleteRosterError}, never a
 *   silently shortened member list.
 */

import type {
  AuthorityState,
  CapabilityKind,
  NormalizedRoleRow,
  PermissionVisibility,
  ProviderRoleSourceKind,
  ServiceIntegrationId,
} from "../control-plane/provider-access-types.js";
import type { ProviderType, WorkspaceId, WorkspaceRole } from "../control-plane/types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for provider-integration failures. */
export class ProviderIntegrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The adapter cannot see effective permissions (or the configured token lost
 * the scope). The roster is NOT treated as empty — callers must surface this
 * as an error and keep prior authority state until reconciliation succeeds.
 */
export class MissingPermissionError extends ProviderIntegrationError {
  constructor(
    readonly detail: "visibility" | "token_scope" | "permission_query",
    message = "provider adapter cannot observe effective repository permissions",
  ) {
    super("PROVIDER_PERMISSION_MISSING", message);
  }
}

/**
 * The roster fetch did not complete: truncated pages, pagination past the
 * declared limit, an exhausted rate limit before completion, or a missing
 * continuation cursor. Callers must never apply a partial roster as if it
 * were the complete truth — absence from an incomplete fetch is not removal.
 */
export class IncompleteRosterError extends ProviderIntegrationError {
  constructor(
    readonly reason:
      "truncated" | "pagination_limit" | "rate_limited" | "missing_cursor" | "empty_page",
    message = `provider roster fetch incomplete (${reason})`,
  ) {
    super("PROVIDER_ROSTER_INCOMPLETE", message);
  }
}

/**
 * The provider could not be observed at all: rate limited (HTTP 429), server
 * error, network failure, or an unexpected status.
 *
 * This is *unavailable*, not *empty*: the last verified fact is retained and
 * reconciliation marks existing authority `stale` (sensitive actions blocked
 * pending a successful verification). It never becomes `removed` — an
 * unreachable provider says nothing about who lost access.
 */
export class ProviderUnavailableError extends ProviderIntegrationError {
  constructor(
    readonly reason: "rate_limited" | "server_error" | "network" | "unexpected_status",
    message = `provider unavailable (${reason})`,
  ) {
    super("PROVIDER_UNAVAILABLE", message);
  }
}

/**
 * A raw provider record cannot be normalized without inventing authority —
 * for example a GitHub repository-level "owner" user, which does not exist.
 */
export class NormalizationError extends ProviderIntegrationError {
  constructor(message: string) {
    super("PROVIDER_ROLE_INVALID", message);
  }
}

// ---------------------------------------------------------------------------
// Provider adapter contract
// ---------------------------------------------------------------------------

export interface RepositoryRef {
  /** Immutable provider-assigned repository identifier. */
  repository_id: string;
  /** Display metadata only. */
  repository_name: string;
  provider_type: ProviderType;
}

/** Secret-free context for one provider call batch. */
export interface ProviderCallContext {
  enterprise_id: string;
  workspace_id: WorkspaceId;
  integration_id: ServiceIntegrationId;
  /** Monotonic hook the adapter uses to wait out rate limits. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RawProviderRole {
  /** Stable provider-assigned subject id; never an email or display name. */
  subject: string;
  /** Provider handle; display only. */
  login: string;
  kind: ProviderRoleSourceKind;
  /** Provider-native role vocabulary (e.g. GitHub `maintain`). */
  provider_role: string;
  /** Organization / team / group / repository id the authority comes from. */
  authority_ref: string;
  /** Parent group for subgroup-inherited roles; else null. */
  inherited_from?: string | null;
}

export interface RosterPage {
  entries: RawProviderRole[];
  next_cursor: string | null;
  /** The provider reports more data beyond this page. */
  has_more: boolean;
  /** The provider cut the response short (e.g. an internal row cap). */
  truncated?: boolean;
  /** Observed rate-limit state; `remaining <= 0` with has_more is incomplete. */
  rate_limit?: { remaining: number; reset_at?: string } | null;
}

/**
 * What the adapter can and cannot do. Declared statically so the service can
 * refuse to run with silent gaps instead of discovering them in production.
 */
export interface ProviderAdapterCapabilities {
  effective_permission_visibility: PermissionVisibility;
  pagination: {
    /** Largest page the provider accepts. */
    per_page_max: number;
    /** Most pages the adapter will fetch in one collection. */
    pages_max: number;
  };
  rate_limit: {
    requests_per_minute: number;
    /** Whether the provider honors Retry-After / reset_at. */
    retry_after_supported: boolean;
  };
  /** Token scopes the service credential must hold for roster visibility. */
  required_token_scope: readonly string[];
  /** Checkout gets read; delivery write is a separate, expiring capability. */
  checkout_capability: "read";
  delivery_capability: "scoped_write" | "none";
}

export interface ProviderAdapter {
  readonly provider_type: ProviderType;
  readonly capabilities: ProviderAdapterCapabilities;
  fetchRosterPage(
    ctx: ProviderCallContext,
    repository: RepositoryRef,
    cursor: string | null,
  ): Promise<RosterPage>;
  /**
   * Effective repository permission of one subject as the provider reports
   * it, or null when the provider says there is none. Throws
   * {@link MissingPermissionError} when visibility does not extend to this
   * query — never silently returns null for "cannot tell".
   */
  fetchEffectivePermission(
    ctx: ProviderCallContext,
    repository: RepositoryRef,
    subject: string,
  ): Promise<RawProviderRole | null>;
}

// ---------------------------------------------------------------------------
// Actions and access decisions
// ---------------------------------------------------------------------------

/**
 * The action classes revocation must stop. One gate decision covers each of
 * them; a revoked subject loses all five at once.
 */
export type ActionKind = "read" | "stream" | "artifact_read" | "approval" | "write";

/** All action kinds, in request-path order (used by revocation effects). */
export const ACTION_KINDS: readonly ActionKind[] = [
  "read",
  "stream",
  "artifact_read",
  "approval",
  "write",
];

export interface ActionPolicy {
  /** Minimum workspace role required for the action. */
  min_role: WorkspaceRole;
  /**
   * Sensitive actions require fresh provider verification: authority must be
   * `active` and verified within the freshness window. Unknown or stale
   * authority blocks them pending reconciliation.
   */
  sensitivity: "ordinary" | "sensitive";
  /** A live capability grant is additionally required. */
  requires_capability?: CapabilityKind;
}

export const WORKSPACE_ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = Object.freeze({
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
});

/**
 * Default action policy. Enterprise administration deliberately appears
 * nowhere: it does not grant repository data access by itself.
 */
export const DEFAULT_ACTION_POLICY: Readonly<Record<ActionKind, ActionPolicy>> = Object.freeze({
  read: { min_role: "viewer", sensitivity: "ordinary" },
  stream: { min_role: "viewer", sensitivity: "ordinary" },
  artifact_read: { min_role: "viewer", sensitivity: "ordinary" },
  approval: { min_role: "admin", sensitivity: "sensitive" },
  write: { min_role: "member", sensitivity: "sensitive", requires_capability: "delivery_write" },
});

export type DenyReason =
  | "enterprise_membership"
  | "user_suspended"
  | "workspace_role"
  | "repository_access"
  | "authority_unknown"
  | "authority_stale"
  | "verification_stale"
  | "capability_grant"
  | "action_policy";

export interface AccessDecision {
  allowed: boolean;
  action: ActionKind;
  subject: string | null;
  /** Machine reason when denied. */
  reason?: DenyReason;
  /** Sensitive actions blocked pending reconciliation say so explicitly. */
  requires_reconciliation?: boolean;
  /** Authority verification timestamp the decision was based on. */
  authority_verified_at: string | null;
  checked_at: string;
}

/** Inputs of the effective-access intersection. */
export interface EffectiveAccessInput {
  action: ActionKind;
  /** The user is a current enterprise member and not suspended. */
  enterprise: { member: boolean; user_status: "active" | "suspended" };
  /** Workspace role from an assigned membership; null when unassigned. */
  workspace_role: WorkspaceRole | null;
  /** Current repository authority for the user's provider subject. */
  repository: {
    subject: string | null;
    state: AuthorityState | "absent";
    last_verified_at: string | null;
  };
  /** Live delivery/checkout capability grants held at decision time. */
  capability_grants: readonly CapabilityKind[];
  now: Date;
  /** Sensitive actions need verification at most this old (default 15 min). */
  fresh_window_ms?: number;
  /** Authority older than this is `stale` even if last state said active. */
  stale_after_ms?: number;
  policy?: Readonly<Record<ActionKind, ActionPolicy>>;
}

// ---------------------------------------------------------------------------
// Normalization output
// ---------------------------------------------------------------------------

export interface NormalizedRosterEntry extends NormalizedRoleRow {
  /**
   * Explicit provenance for admins inspecting effective provider roles.
   * Records provider vocabulary and where the authority came from.
   */
  provenance: {
    provider: ProviderType;
    source_kind: ProviderRoleSourceKind;
    authority_ref: string;
    inherited_from: string | null;
    provider_role: string;
  };
}

export type { NormalizedRoleRow, ProviderRoleSourceKind };
