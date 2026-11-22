/**
 * Enterprise user entity types (DAT-275, ADR-0011).
 *
 * An enterprise user is the enterprise-scoped belonging of one person. It is
 * created by an administrator from an approved provider instance plus that
 * provider's stable subject, and it exists before the person ever signs in
 * (`pending_claim`). Login proves the same (provider instance, subject) and
 * claims the row; login alone never creates one. Status changes are
 * enterprise-scoped and carry a version for optimistic concurrency.
 */

import type { EnterpriseId, ProviderInstanceId, UserId } from "./types.js";

export type EnterpriseUserStatus = "pending_claim" | "active" | "suspended";

export interface EnterpriseUser {
  id: string;
  enterprise_id: EnterpriseId;
  /** Null until a matching OAuth login claims this membership. */
  user_id: UserId | null;
  status: EnterpriseUserStatus;
  version: number;
  claimed_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

/** One provider identity binding; the only match key for a claim. */
export interface EnterpriseUserIdentity {
  id: string;
  enterprise_id: EnterpriseId;
  enterprise_user_id: string;
  provider_instance_id: ProviderInstanceId;
  /** Stable provider-assigned subject. Never an email, login, or name. */
  subject: string;
  created_at: string;
  created_by: UserId;
}

/**
 * Who performs an enterprise-user change. Deployment bootstrap/operator
 * actions are recorded as `deployment` with no user id — never as a user.
 */
export type EnterpriseUserActor = { kind: "user"; user_id: UserId } | { kind: "deployment" };

export interface AddEnterpriseUserInput {
  enterprise_id: EnterpriseId;
  provider_instance_id: ProviderInstanceId;
  subject: string;
  actor: EnterpriseUserActor;
}

export interface BootstrapAdminInput {
  enterprise_id: EnterpriseId;
  user_id: UserId;
  /** Audited as the approved provider instance of the named identity. */
  provider_instance_id?: ProviderInstanceId;
}

export type BootstrapAdminOutcome =
  | { status: "granted" }
  | { status: "already_granted" }
  | { status: "conflict" }
  | { status: "suspended" };

export interface AddEnterpriseUserResult {
  user: EnterpriseUser;
  /** False for an idempotent re-add of the same subject. */
  created: boolean;
}

export type EnterpriseUserUpdateResult =
  | { status: "ok"; user: EnterpriseUser }
  | { status: "version_conflict"; actual_version: number }
  | { status: "last_admin" }
  | { status: "not_claimed" };

export interface EnsureEnterpriseUserResult {
  user: EnterpriseUser;
  created: boolean;
  /** True when an existing suspended membership was not reactivated. */
  suspended: boolean;
}
