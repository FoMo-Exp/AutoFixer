/**
 * Control-plane entity types, scope types, and domain errors.
 *
 * The control plane owns enterprise, workspace, team, membership, and
 * provider-instance state. Every repository read and write is scoped: a
 * {@link EnterpriseScope} or {@link WorkspaceScope} derived from authenticated
 * membership, never from a client-supplied identifier. Cross-enterprise and
 * cross-workspace ID substitution is rejected at the storage layer.
 */

// ---------------------------------------------------------------------------
// Branded ID aliases (documentation-level; runtime values are plain strings).
// ---------------------------------------------------------------------------

export type EnterpriseId = string;
export type ProviderInstanceId = string;
export type WorkspaceId = string;
export type TeamId = string;
export type MembershipId = string;
export type UserId = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type ProviderType = "github" | "gitlab";
export type WorkspaceStatus = "active" | "archived";
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

// ---------------------------------------------------------------------------
// Audit columns shared by every table
// ---------------------------------------------------------------------------

export interface AuditFields {
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Enterprise extends AuditFields {
  id: EnterpriseId;
  name: string;
  /** URL-safe unique slug. */
  slug: string;
  /** Optimistic-concurrency token. */
  version: number;
}

export interface ProviderInstance extends AuditFields {
  id: ProviderInstanceId;
  enterprise_id: EnterpriseId;
  provider_type: ProviderType;
  /** Administrator-approved origin; arbitrary self-hosted URLs are rejected. */
  origin_url: string;
  version: number;
}

export interface Workspace extends AuditFields {
  id: WorkspaceId;
  enterprise_id: EnterpriseId;
  name: string;
  /**
   * Immutable provider-assigned repository identifier (e.g. the numeric GitHub
   * repository ID). Once set it is never mutated; a transfer replaces the
   * binding through a dedicated, authority-revalidated operation.
   */
  repository_id: string;
  provider_instance_id: ProviderInstanceId;
  status: WorkspaceStatus;
  version: number;
}

export interface Team extends AuditFields {
  id: TeamId;
  workspace_id: WorkspaceId;
  name: string;
  leader_user_id: UserId;
  responsibility: string | null;
  version: number;
}

export interface Membership extends AuditFields {
  id: MembershipId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  user_id: UserId;
  role: WorkspaceRole;
  version: number;
}

// ---------------------------------------------------------------------------
// Scope contexts
// ---------------------------------------------------------------------------

/**
 * Enterprise-level scope derived from authenticated membership.
 *
 * `actor_id` is the authenticated user performing the operation; it is
 * recorded in audit columns but never grants authority on its own.
 */
export interface EnterpriseScope {
  enterprise_id: EnterpriseId;
  actor_id: UserId;
}

/** Workspace-level scope; a workspace always belongs to exactly one enterprise. */
export interface WorkspaceScope extends EnterpriseScope {
  workspace_id: WorkspaceId;
}

// ---------------------------------------------------------------------------
// Create / update inputs
// ---------------------------------------------------------------------------

export interface CreateEnterpriseInput {
  name: string;
  slug: string;
  /** Bootstrap actor; becomes created_by/updated_by on the enterprise row. */
  actor_id: UserId;
}

export interface UpdateEnterpriseInput {
  name?: string;
}

export interface CreateProviderInstanceInput {
  provider_type: ProviderType;
  origin_url: string;
}

export interface CreateWorkspaceInput {
  name: string;
  repository_id: string;
  provider_instance_id: ProviderInstanceId;
}

export interface UpdateWorkspaceInput {
  name?: string;
}

export interface TransferWorkspaceInput {
  repository_id: string;
  provider_instance_id: ProviderInstanceId;
}

export interface CreateTeamInput {
  name: string;
  leader_user_id: UserId;
  responsibility?: string;
}

export interface UpdateTeamInput {
  name?: string;
  leader_user_id?: UserId;
  responsibility?: string;
}

export interface CreateMembershipInput {
  user_id: UserId;
  role: WorkspaceRole;
}

export interface UpdateMembershipInput {
  role?: WorkspaceRole;
}
