/**
 * Owner-created invitation entity types (DAT-204, ADR-0006).
 *
 * An invitation is an opaque one-time bearer. The raw token exists only in the
 * create response; storage keeps the HMAC-SHA-256 keyed digest
 * ({@link Invitation.token_digest}), and no read, error, log, or audit record
 * ever carries the bearer. An invitation grants nothing by itself: redemption
 * adds a `member`-role workspace membership after login, explicit join
 * confirmation, and live eligibility checks.
 */

import type { EnterpriseId, UserId, WorkspaceId } from "./types.js";

export type InvitationId = string;

/** Server-computed state of this one-time invitation. */
export type InvitationStatus = "active" | "consumed" | "revoked" | "expired";

/** The only role an invitation may ever confer (ADR-0006). */
export type InvitationRole = "member";

/**
 * Why a redemption or preview was denied. Internal vocabulary only: the API
 * serves one uniform INVITATION_NOT_ACCEPTED for every reason so a caller
 * cannot enumerate which condition failed.
 */
export type InvitationDenialReason =
  | "unknown_token"
  | "expired"
  | "revoked"
  | "consumed"
  | "wrong_subject"
  | "inviter_authority_lost"
  | "workspace_archived"
  | "ineligible"
  | "already_member";

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export interface Invitation {
  id: InvitationId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  role: InvitationRole;
  /** HMAC-SHA-256 keyed digest (hex) of the bearer; the bearer is never stored. */
  token_digest: string;
  /**
   * When set, only a verified identity carrying this provider subject on the
   * workspace's provider instance may redeem; forwarded use stays denied.
   */
  bound_provider_subject: string | null;
  expires_at: string;
  created_at: string;
  created_by: UserId;
  updated_at: string;
  updated_by: UserId;
  revoked_at: string | null;
  revoked_by: UserId | null;
  /** Set exactly once, atomically with the membership insert. */
  redeemed_at: string | null;
  /** The subject whose redemption consumed this invitation (replay key). */
  redeemed_by: UserId | null;
  version: number;
}

// ---------------------------------------------------------------------------
// Create inputs
// ---------------------------------------------------------------------------

export interface CreateInvitationInput {
  /** Keyed digest of the freshly minted bearer; the bearer never reaches storage. */
  token_digest: string;
  bound_provider_subject?: string;
  /** Absolute expiry; the service caps it at the 24-hour default maximum. */
  expires_at: string;
  actor_id: UserId;
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

/**
 * Facts the repository cannot see for itself. They are decided by the service
 * (authority and eligibility sources) and enforced inside the same
 * transaction as the storage-side checks.
 */
export interface InvitationRedeemFacts {
  /**
   * Whether the creator still holds current repository administration
   * authority over the workspace. Invitations never outlive the inviter's
   * authority (ADR-0006).
   */
  inviter_authorized: boolean;
  /** Whether the invitee is currently eligible for repository access. */
  invitee_eligible: boolean;
  /**
   * The invitee's verified provider subject on the workspace's provider
   * instance, if any; compared against `bound_provider_subject`.
   */
  invitee_provider_subject: string | null;
}

export interface InvitationRedeemInput extends InvitationRedeemFacts {
  token_digest: string;
  invitee_user_id: UserId;
}

export interface InvitationRedemptionSuccess {
  status: "joined" | "replayed";
  invitation: Invitation;
  membership_id: string;
}

export interface InvitationRedemptionDenied {
  status: "denied";
  reason: InvitationDenialReason;
}

/**
 * `joined` and `replayed` are both 200: a same-subject retry is an idempotent
 * replay of its own join, never a second join. Every other outcome is denied
 * and maps to one uniform INVITATION_NOT_ACCEPTED.
 */
export type InvitationRedemptionOutcome = InvitationRedemptionSuccess | InvitationRedemptionDenied;
