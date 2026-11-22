/**
 * Workspace repository set types (DAT-281, ADR-0011).
 *
 * A workspace owns a *versioned set* of repository bindings. Each binding
 * names the approved provider instance, the approved server installation that
 * observes the repository, and the immutable provider-assigned repository id.
 * Names and URLs are metadata and never authority.
 *
 * The boundary encoded here is deliberately narrow: this storage and read
 * layer exists so later work has an authoritative repository set, but the
 * multi-repository scope itself is not usable. Anything that would create,
 * change, or authorize against a multi-repository set fails closed while the
 * immutable `multi_repository_workspace` gate is `disabled`.
 */

import type { EnterpriseId, ProviderInstanceId, UserId, WorkspaceId } from "./types.js";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type WorkspaceRepositoryBindingId = string;
export type WorkspaceRepositoryBindingStatus = "active" | "retired";

/**
 * Why a repository-set read or authorization was refused.
 *
 * These codes are stable and each one is a *refusal*, never a degraded
 * success: there is no fallback binding, no "first repository wins", and no
 * empty set that reads as "no repositories yet".
 *
 * - `REPOSITORY_BINDING_MISSING` — the workspace has no active binding. Fail
 *   closed: absence of evidence is not a single-repository workspace.
 * - `REPOSITORY_BINDING_INCONSISTENT` — the binding set disagrees with the
 *   workspace's immutable `(provider_instance_id, repository_id)` pair.
 *   Historical rows are reported, never reinterpreted.
 * - `REPOSITORY_BINDING_UNAPPROVED` — a binding names a provider instance that
 *   is not registered for the workspace's enterprise.
 * - `INSTALLATION_NOT_APPROVED` — a binding's installation reference is
 *   unknown, belongs to another workspace/repository, or is uninstalled.
 * - `REPOSITORY_SET_VERSION_CONFLICT` — the caller's observed set version is
 *   not the stored one; the decision was formed against a stale set.
 * - `MULTI_REPOSITORY_SCOPE_DISABLED` — the set has more than one active
 *   binding while the multi-repository gate is disabled. Every consumer fails
 *   closed rather than picking one repository.
 * - `MULTI_REPOSITORY_SCOPE_UNSUPPORTED` — the gate is enabled but this build
 *   still has no enforcement for a multi-repository set; enabling the gate is
 *   a rollout decision, not an implementation.
 * - `WORKSPACE_ARCHIVED` — the workspace is archived, so its retired binding
 *   set is reported but never usable.
 * - `SCOPE_MUTATION_DISABLED` — creating or changing a binding is refused.
 * - `FEATURE_GATE_UNREADABLE` — the gate row is missing or its schema version
 *   is newer than this build; authority cannot be established.
 */
export type WorkspaceRepositorySetErrorCode =
  | "REPOSITORY_BINDING_MISSING"
  | "REPOSITORY_BINDING_INCONSISTENT"
  | "REPOSITORY_BINDING_UNAPPROVED"
  | "INSTALLATION_NOT_APPROVED"
  | "REPOSITORY_SET_VERSION_CONFLICT"
  | "WORKSPACE_ARCHIVED"
  | "MULTI_REPOSITORY_SCOPE_DISABLED"
  | "MULTI_REPOSITORY_SCOPE_UNSUPPORTED"
  | "SCOPE_MUTATION_DISABLED"
  | "FEATURE_GATE_UNREADABLE";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * One repository bound into a workspace.
 *
 * `installation_ref` is the approved, repository-scoped server integration
 * (`service_integration.id`) through which provider authority is observed. It
 * is nullable because a workspace backfilled from pre-DAT-281 rows may not
 * have an integration registered for that repository yet; a null installation
 * never grants observation authority, and it does not block the legacy
 * single-repository path that predates this table.
 */
export interface WorkspaceRepositoryBinding {
  id: WorkspaceRepositoryBindingId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  provider_instance_id: ProviderInstanceId;
  installation_ref: string | null;
  /** Immutable provider-assigned repository identifier. */
  repository_id: string;
  /** Display metadata only. */
  repository_url: string | null;
  /** Display metadata only; renames never change authority. */
  repository_name: string | null;
  /** 1-based position in the set; 1 is the workspace's legacy binding. */
  position: number;
  status: WorkspaceRepositoryBindingStatus;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
  version: number;
}

/**
 * A workspace's repository set as read from storage.
 *
 * `set_version` is the value an access decision is formed against; a decision
 * is only valid for the version it observed. `usable` is the single answer for
 * authorization paths: false means no consumer may treat this set as
 * authority, and `blocked_reason` says why.
 */
export interface WorkspaceRepositorySet {
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  set_version: number;
  bindings: WorkspaceRepositoryBinding[];
  /** True when more than one repository is bound. */
  multi_repository: boolean;
  usable: boolean;
  blocked_reason: WorkspaceRepositorySetErrorCode | null;
  gate: DeploymentFeatureGate;
}

/** A single-repository scope, the only shape authorization may consume today. */
export interface SingleRepositoryWorkspaceScope {
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  set_version: number;
  binding: WorkspaceRepositoryBinding;
  gate: DeploymentFeatureGate;
}

export type DeploymentFeatureGateKey = "multi_repository_workspace";

/**
 * One immutable deployment feature-gate row.
 *
 * Rows are append-only. The effective state is the row with the highest
 * `min_schema_version`; turning a gate on means adding a *new* row in a new
 * forward migration, which is why `min_schema_version` doubles as the
 * mixed-version marker: a build older than that migration refuses to serve.
 */
export interface DeploymentFeatureGate {
  key: DeploymentFeatureGateKey;
  state: "enabled" | "disabled";
  reason: string;
  min_schema_version: number;
  created_at: string;
  created_by: string;
}

// ---------------------------------------------------------------------------
// Mutation inputs
// ---------------------------------------------------------------------------

/**
 * Input for binding another repository into a workspace.
 *
 * Accepted by the repository interface only so the refusal is explicit and
 * testable: while the gate is disabled there is no path that stores a second
 * binding.
 */
export interface AddWorkspaceRepositoryBindingInput {
  provider_instance_id: ProviderInstanceId;
  installation_ref?: string | null;
  repository_id: string;
  repository_url?: string | null;
  repository_name?: string | null;
  expected_set_version?: number;
}

/** Input used internally when a workspace is created or transferred. */
export interface WritePrimaryBindingInput {
  provider_instance_id: ProviderInstanceId;
  repository_id: string;
  installation_ref?: string | null;
  repository_url?: string | null;
  repository_name?: string | null;
}
