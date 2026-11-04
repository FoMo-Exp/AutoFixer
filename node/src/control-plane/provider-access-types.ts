/**
 * Provider access entity types: service integrations, normalized provider
 * roster rows, subject authority, capability grants, provider events, and
 * reconciliation runs (DAT-203).
 *
 * Two rules are encoded in the types themselves:
 *
 * - Integrations carry credential *references* only. Secret values live in
 *   the server credential boundary and are never part of any entity, input,
 *   or audit payload — so a serialized row can be logged, shown to a
 *   renderer, or handed to Pi without scrubbing.
 * - Provider subjects are stable provider-assigned identifiers. Email,
 *   display name, and blame author names are never authority keys.
 */

import type { EnterpriseId, ProviderInstanceId, UserId, WorkspaceId } from "./types.js";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type ServiceIntegrationId = string;

/**
 * Whether the installed integration can see effective permissions at all.
 * Declared by the provider adapter at install time.
 *
 * - `full` — the adapter enumerates every subject that currently has access,
 *   so absence from a successful roster means access was lost.
 * - `partial` — the adapter enumerates the sources it can query, but at least
 *   one access path is not observable. A successful roster is still applied;
 *   absence from it is never treated as removal (the stored authority is kept
 *   and marked stale, capability grants survive, provenance is not pruned).
 * - `none` — the service cannot verify repository authority at all and must
 *   refuse to treat the roster as known.
 */
export type PermissionVisibility = "full" | "partial" | "none";

export type InstallStatus = "active" | "suspended" | "uninstalled";

/**
 * Normalized provenance of one provider role row.
 *
 * - `org_owner` — organization-level owner authority (GitHub org owner,
 *   GitLab group owner). The authority belongs to the organization; a GitHub
 *   repository never gets a fabricated "owner" user.
 * - `org_member` — plain organization membership (baseline; repository access
 *   still needs a team/direct grant on GitHub).
 * - `group` — GitLab group membership granting project access.
 * - `inherited_role` — repository permission inherited through a team (GitHub)
 *   or a parent group (GitLab subgroups).
 * - `direct_collaborator` — direct repository/project collaborator.
 * - `effective_access` — the provider reports that this subject currently has
 *   effective access to the repository, but the endpoint mixes direct
 *   collaborators, team/group inheritance, organization default permissions,
 *   and organization owners, so the response cannot be attributed to one
 *   source. The row records *effective access only* and never claims a direct
 *   grant. GitHub's collaborator list is exactly this case: its documentation
 *   states there is presently no way to differentiate an organization-level
 *   grant from a repository-level grant in the response.
 */
export type ProviderRoleSourceKind =
  | "org_owner"
  | "org_member"
  | "group"
  | "inherited_role"
  | "direct_collaborator"
  | "effective_access";

/**
 * Authority state of one provider subject on one repository.
 *
 * - `active` — verified present in the provider roster.
 * - `stale` — verification aged out; sensitive actions are blocked pending
 *   reconciliation, ordinary reads stay possible.
 * - `unknown` — never verified, or the authority source moved (repository
 *   transfer); every action is blocked pending reconciliation.
 * - `removed` — the provider says access was lost; every action is blocked
 *   and capability grants are revoked.
 */
export type AuthorityState = "active" | "stale" | "unknown" | "removed";

export type CapabilityKind = "checkout_read" | "delivery_write";

export type ProviderEventType =
  | "member_added"
  | "member_removed"
  | "role_changed"
  | "repository_renamed"
  | "repository_transferred"
  | "integration_suspended"
  | "permission_changed";

export type ReconcileRunStatus = "running" | "completed" | "incomplete";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface ServiceIntegration {
  id: ServiceIntegrationId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  provider_instance_id: ProviderInstanceId;
  /** Immutable provider-assigned repository identifier. */
  repository_id: string;
  /** Display metadata; renames update this without touching authority. */
  repository_name: string;
  install_status: InstallStatus;
  /** Credential references — never secret values. */
  source_credential_ref: string;
  checkout_credential_ref: string | null;
  delivery_credential_ref: string | null;
  permission_visibility: PermissionVisibility;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
  version: number;
}

export interface ProviderMemberRole {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  integration_id: ServiceIntegrationId;
  subject: string;
  /** Provider handle; display only, never a linking or authority key. */
  login: string;
  source_kind: ProviderRoleSourceKind;
  /** Provider-native role vocabulary (e.g. GitHub `maintain`). */
  provider_role: string;
  /** Organization / team / group / repository id the authority comes from. */
  authority_ref: string;
  /** Parent group for subgroup-inherited roles; else null. */
  inherited_from: string | null;
  observed_at: string;
  last_verified_at: string;
}

export interface SubjectAuthority {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  integration_id: ServiceIntegrationId;
  subject: string;
  user_id: UserId | null;
  state: AuthorityState;
  last_verified_at: string | null;
  updated_at: string;
}

export interface CapabilityGrant {
  id: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  integration_id: ServiceIntegrationId;
  grantee_user_id: UserId | null;
  capability: CapabilityKind;
  /** Narrow branch restriction for delivery writes; null for checkout reads. */
  branch_scope: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

export interface ProviderEvent {
  id: string;
  enterprise_id: EnterpriseId;
  provider_instance_id: ProviderInstanceId;
  integration_id: ServiceIntegrationId | null;
  repository_id: string | null;
  event_type: ProviderEventType;
  /** Secret-free JSON metadata. */
  payload: Record<string, unknown>;
  /** Provider delivery id for idempotent event application. */
  delivery_id: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface ReconcileRun {
  id: string;
  enterprise_id: EnterpriseId;
  integration_id: ServiceIntegrationId;
  started_at: string;
  finished_at: string | null;
  status: ReconcileRunStatus;
  pages_seen: number;
  roster_size: number;
  members_added: number;
  members_removed: number;
  roles_changed: number;
  authority_reset: number;
  failure_code: string | null;
}

// ---------------------------------------------------------------------------
// Create / update inputs
// ---------------------------------------------------------------------------

export interface CreateServiceIntegrationInput {
  provider_instance_id: ProviderInstanceId;
  repository_id: string;
  repository_name: string;
  /** Read-only source credential reference (the installed integration). */
  source_credential_ref: string;
  /** Read capability for checkout; delivery write is separate and expiring. */
  checkout_credential_ref?: string;
  delivery_credential_ref?: string;
  permission_visibility: PermissionVisibility;
  actor_id: UserId;
}

/** Repository transfer: rebinding only — credentials are never expanded here. */
export interface TransferIntegrationInput {
  repository_id: string;
  repository_name: string;
  provider_instance_id: ProviderInstanceId;
  actor_id: UserId;
}

export interface RenameIntegrationInput {
  repository_name: string;
  actor_id: UserId;
}

export interface SetInstallStatusInput {
  install_status: InstallStatus;
  actor_id: UserId;
}

/** One normalized roster row as written by the reconcile pipeline. */
export interface NormalizedRoleRow {
  subject: string;
  login: string;
  source_kind: ProviderRoleSourceKind;
  provider_role: string;
  authority_ref: string;
  inherited_from: string | null;
}

export interface ReplaceRosterInput {
  roles: NormalizedRoleRow[];
  /** Verification timestamp applied to every row and authority record. */
  verified_at: string;
  /** App user bound to each subject when known (from user_identity). */
  subject_users?: Readonly<Record<string, UserId>>;
}

export interface CreateCapabilityGrantInput {
  grantee_user_id: UserId | null;
  capability: CapabilityKind;
  branch_scope?: string;
  expires_at: string;
  actor_id: UserId;
}

export interface AppendProviderEventInput {
  provider_instance_id: ProviderInstanceId;
  integration_id?: ServiceIntegrationId;
  repository_id?: string;
  event_type: ProviderEventType;
  payload?: Record<string, unknown>;
  delivery_id?: string;
  received_at: string;
}

export interface StartReconcileRunInput {
  integration_id: ServiceIntegrationId;
  started_at: string;
}

export interface FinishReconcileRunInput {
  status: ReconcileRunStatus;
  pages_seen: number;
  roster_size: number;
  members_added?: number;
  members_removed?: number;
  roles_changed?: number;
  authority_reset?: number;
  failure_code?: string;
  finished_at: string;
}
