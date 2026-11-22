/**
 * Per-action repository capability ceilings (DAT-276, ADR-0011).
 *
 * ## What a capability is (and is not)
 *
 * A capability is a *repository-derived, action-scoped fact*: "the provider
 * proves this person may read repository code here". It is deliberately not a
 * workspace role, not an enterprise role, and not a grant. The assigned
 * workspace role stays the assigned role; the capability ceiling is the
 * maximum a provider fact can support, and it is intersected across **every**
 * repository of the workspace.
 *
 * The vocabulary is provider-neutral on purpose. Provider role *names* are
 * evidence, never authority: `maintain` on GitHub and `maintainer` on GitLab
 * are mapped by an explicit policy table (see
 * `provider-access/repository-capabilities.ts`), and a role outside that table
 * fails closed instead of being ranked by name.
 *
 * ## Persistence
 *
 * The ceiling an administrator approved, and any confirmed reduction the
 * providers forced, are persisted (`workspace_member_capability`) so they
 * survive a restart and are shared by every process. A *temporary* inability
 * to verify (unknown, stale, unavailable, incomplete) is never written here:
 * it blocks workspace access for the duration and clears itself once the same
 * facts verify again (ADR-0011 "unknown is not a confirmed downgrade").
 */

import type { EnterpriseId, UserId, WorkspaceId } from "./types.js";

// ---------------------------------------------------------------------------
// Capability vocabulary
// ---------------------------------------------------------------------------

/**
 * Repository capabilities AutoFixer can prove and act on. There is no
 * "admin"/"owner" capability: workspace administration and repository
 * management are separate from the workspace role, and enterprise
 * administration/security duties are never derived from repository facts.
 */
export type RepositoryCapability =
  "code_read" | "issue_write" | "repository_write" | "repository_manage";

/** All capabilities, in ascending order of privilege. */
export const REPOSITORY_CAPABILITIES: readonly RepositoryCapability[] = Object.freeze([
  "code_read",
  "issue_write",
  "repository_write",
  "repository_manage",
]);

/** Capability grants the provider-access layer may hold for a member. */
export const CAPABILITY_GRANT_KINDS = ["checkout_read", "delivery_write"] as const;

/**
 * Why a workspace access decision could not be established. Every code is a
 * *refusal*: none of them degrade to "the last role is probably still fine".
 *
 * - `workspace_archived` — the workspace is archived; its set authorizes
 *   nothing.
 * - `repository_missing` — the workspace has no active binding (fail closed;
 *   absence of evidence is not "no repositories yet").
 * - `repository_set_unsupported` — the set is a multi-repository scope this
 *   build cannot enforce yet, so it authorizes nothing (DAT-281 gate).
 * - `repository_binding_inconsistent` — bindings disagree with the workspace's
 *   immutable repository identity; reported, never resolved by guessing.
 * - `installation_not_approved` — a binding's installation is missing,
 *   suspended or uninstalled.
 * - `provider_instance_unapproved` — a binding names an unregistered provider
 *   instance.
 * - `subject_missing` — the member has no provider subject on the binding's
 *   provider instance (login alone is not repository authority).
 * - `authority_unknown` / `authority_stale` — provider authority was never
 *   verified or has aged past the stale bound.
 * - `verification_expired` — an `active` verification is older than the
 *   configured reconciliation bound.
 * - `permission_visibility_none` / `permission_visibility_partial` — the
 *   installation cannot prove the roster (partially is not enough: an
 *   incomplete roster cannot establish admission).
 * - `role_missing` — the provider roster has no row for this subject, so no
 *   capability can be proven.
 * - `unsupported_role` — the provider reports a role outside AutoFixer's
 *   explicit capability policy (guest, unknown or custom vocabulary).
 * - `repository_access_removed` — the provider says access was lost.
 * - `no_code_read` — the intersection lacks code read, so the member is not
 *   eligible for workspace access at all.
 * - `capability_store_unavailable` — the confirmed reduction could not be
 *   persisted/audited; access fails closed rather than acting on an
 *   unauditable decision.
 */
export type CapabilityBlockReason =
  | "workspace_archived"
  | "repository_missing"
  | "repository_set_unsupported"
  | "repository_binding_inconsistent"
  | "installation_not_approved"
  | "provider_instance_unapproved"
  | "subject_missing"
  | "authority_unknown"
  | "authority_stale"
  | "verification_expired"
  | "permission_visibility_none"
  | "permission_visibility_partial"
  | "role_missing"
  | "unsupported_role"
  | "repository_access_removed"
  | "no_code_read"
  | "capability_store_unavailable";

/**
 * State of the ceiling a decision can act on.
 *
 * - `verified` — every repository produced verified capability evidence and
 *   the intersection supports code read.
 * - `unverified` — at least one repository's evidence is missing, stale,
 *   unavailable, unsupported or incomplete. Workspace access fails closed for
 *   the duration; nothing is recorded as a confirmed downgrade.
 * - `confirmed_loss` — the provider positively says access is gone, or the
 *   verified intersection lacks code read. Persisted as a reduction with its
 *   reason; only an audited administrator reapproval can raise it again.
 */
export type CapabilityCeilingState = "verified" | "unverified" | "confirmed_loss";

/** Persisted ceiling state: `approved` may be raised by an administrator. */
export type PersistedCeilingState = "approved" | "downgraded";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * One member's persisted capability ceiling in one workspace.
 *
 * `ceiling` is the effective maximum: it starts at the first verified
 * intersection and only ever moves down automatically. `available_ceiling` is
 * the most recent verified intersection, recorded for observability so a
 * provider recovery is visible ("promotion available") without ever being
 * applied on its own.
 */
export interface MemberCapabilityCeiling {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  user_id: UserId;
  ceiling: RepositoryCapability[];
  available_ceiling: RepositoryCapability[];
  state: PersistedCeilingState;
  reason: string | null;
  /** Repository-set version the stored facts were formed against. */
  set_version: number;
  verified_at: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

export interface InitializeMemberCapabilityInput {
  ceiling: readonly RepositoryCapability[];
  available_ceiling: readonly RepositoryCapability[];
  set_version: number;
  verified_at: string;
  reason: string;
}

export interface ApplyMemberCapabilityDowngradeInput {
  ceiling: readonly RepositoryCapability[];
  available_ceiling: readonly RepositoryCapability[];
  expected_version: number;
  set_version: number;
  verified_at: string;
  reason: string;
}

export interface ObserveMemberCapabilityInput {
  available_ceiling: readonly RepositoryCapability[];
  expected_version: number;
  set_version: number;
  verified_at: string;
}

export interface ReapproveMemberCapabilityInput {
  ceiling: readonly RepositoryCapability[];
  available_ceiling: readonly RepositoryCapability[];
  expected_version: number;
  set_version: number;
  verified_at: string;
}

/** Audit events written to the append-only `auth_audit` trail. */
export const MEMBER_CAPABILITY_AUDIT_EVENTS = Object.freeze({
  initialized: "capability_ceiling.initialized",
  downgraded: "capability_ceiling.downgraded",
  promotionObserved: "capability_ceiling.promotion_observed",
  reapproved: "capability_ceiling.reapproved",
  reapprovalDenied: "capability_ceiling.reapproval_denied",
});
