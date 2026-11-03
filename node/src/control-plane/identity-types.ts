/**
 * Identity, session, and authentication-audit entity types.
 *
 * The identity model deliberately separates people ({@link AppUser}) from
 * provider identities ({@link UserIdentity}): an account match is only ever
 * (provider instance, stable provider subject). Email addresses, display
 * names, and blame author names are never linking keys — two provider
 * subjects sharing an email stay two users.
 */

import type { EnterpriseId, ProviderInstanceId, ProviderType, UserId } from "./types.js";

export type UserStatus = "active" | "suspended";
export type SessionKind = "web" | "desktop";
export type EnterpriseRoleName = "admin";
export type DesktopFlowStatus = "pending" | "ready" | "consumed";
export type AuthActorKind = "user" | "deployment" | "anonymous";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface AppUser {
  id: UserId;
  display_name: string;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
  version: number;
}

export interface UserIdentity {
  id: string;
  user_id: UserId;
  provider_instance_id: ProviderInstanceId;
  /** Stable provider-assigned subject (e.g. the numeric GitHub user id). */
  subject: string;
  /** Provider handle, display-only; never a linking key. */
  login: string;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

export interface EnterpriseRole {
  id: string;
  enterprise_id: EnterpriseId;
  user_id: UserId;
  role: EnterpriseRoleName;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

export interface AuthSession {
  id: string;
  user_id: UserId;
  kind: SessionKind;
  /** SHA-256 hex digest of the bearer token; the token itself is never stored. */
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  user_agent: string | null;
}

export interface OauthFlow {
  id: string;
  kind: SessionKind;
  provider_instance_id: ProviderInstanceId;
  /** SHA-256 hex digest of the OAuth `state` parameter. */
  state_hash: string;
  /** SHA-256 hex digest of the browser-binding secret (login-CSRF defense). */
  binding_hash: string;
  pkce_verifier: string;
  /** Exact redirect URI sent to the provider and reused at token exchange. */
  redirect_uri: string;
  return_to: string;
  desktop_flow_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface DesktopAuthFlow {
  id: string;
  /** SHA-256 hex digest of the desktop-held single-use secret. */
  secret_hash: string;
  status: DesktopFlowStatus;
  user_id: UserId | null;
  attempts: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface AuthAuditRecord {
  id: string;
  at: string;
  event: string;
  enterprise_id: EnterpriseId | null;
  actor_kind: AuthActorKind;
  actor_user_id: UserId | null;
  subject_user_id: UserId | null;
  provider_instance_id: ProviderInstanceId | null;
  /** JSON-encoded, secret-free detail object. */
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Create inputs
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  display_name: string;
  /** System actor id performing the provisioning (audit column). */
  actor_id: UserId;
}

export interface CreateIdentityInput {
  user_id: UserId;
  provider_instance_id: ProviderInstanceId;
  subject: string;
  login: string;
  actor_id: UserId;
}

export interface GrantEnterpriseRoleInput {
  enterprise_id: EnterpriseId;
  user_id: UserId;
  role: EnterpriseRoleName;
  actor_id: UserId;
}

export interface CreateSessionInput {
  user_id: UserId;
  kind: SessionKind;
  token_hash: string;
  csrf_token: string;
  expires_at: string;
  user_agent?: string;
}

export interface CreateOauthFlowInput {
  kind: SessionKind;
  provider_instance_id: ProviderInstanceId;
  state_hash: string;
  binding_hash: string;
  pkce_verifier: string;
  redirect_uri: string;
  return_to: string;
  desktop_flow_id?: string;
  expires_at: string;
}

export interface CreateDesktopFlowInput {
  secret_hash: string;
  expires_at: string;
}

export interface AppendAuthAuditInput {
  event: string;
  enterprise_id?: EnterpriseId;
  actor_kind: AuthActorKind;
  actor_user_id?: UserId;
  subject_user_id?: UserId;
  provider_instance_id?: ProviderInstanceId;
  details?: Record<string, unknown>;
}

export interface AuthAuditFilter {
  enterprise_id?: EnterpriseId;
  event?: string;
  limit?: number;
}

/**
 * Approved provider instance as seen by the anonymous login surface: the
 * admin-registered origin plus its provider type. The directory is the only
 * unscoped read in the identity layer — before a session exists there is no
 * authenticated scope, and authority to log in is exactly "this instance was
 * approved and has configured OAuth credentials".
 */
export interface LoginProvider {
  id: ProviderInstanceId;
  enterprise_id: EnterpriseId;
  provider_type: ProviderType;
  origin_url: string;
}
