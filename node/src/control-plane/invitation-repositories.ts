/**
 * Owner-created invitation repository (DAT-204).
 *
 * Same conventions as the other control-plane repositories: handlers consume
 * the interface and never write SQL. The bearer token is never stored or
 * looked up — callers present the token's keyed digest, and the digest is the
 * only locator. Redemption runs in one `BEGIN IMMEDIATE` transaction that
 * re-checks every storage-side condition and then adds the membership and
 * consumes the invitation together, so concurrent redeemers cannot both
 * succeed and a crash can never leave a consumed invitation without its
 * membership (or a member without the consumed invitation).
 */

import type { ControlPlaneDb } from "./db.js";
import { newId, nowIso } from "./db.js";
import { NotFoundError } from "./errors.js";
import type {
  CreateInvitationInput,
  Invitation,
  InvitationDenialReason,
  InvitationId,
  InvitationRedeemInput,
  InvitationRedemptionOutcome,
} from "./invitation-types.js";
import type { UserId, WorkspaceScope } from "./types.js";

// ---------------------------------------------------------------------------
// Redemption decision (shared by preview and the redeem transaction)
// ---------------------------------------------------------------------------

export type RedemptionDecision =
  | { kind: "join" }
  | { kind: "replay"; membership_id: string }
  | { kind: "deny"; reason: InvitationDenialReason };

/**
 * The one decision procedure for consuming an invitation.
 *
 * Preview evaluates it without side effects; the redeem transaction
 * re-evaluates it against freshly read state and acts on the result, so the
 * two can never disagree about which state an invitation is in. Ordering
 * matters only for the audit reason: every denial is served to the API as the
 * same non-enumerating INVITATION_NOT_ACCEPTED.
 */
export function evaluateRedemption(
  invitation: Invitation,
  context: {
    invitee_user_id: UserId;
    invitee_membership_id: string | null;
    invitee_provider_subject: string | null;
    inviter_authorized: boolean;
    invitee_eligible: boolean;
    workspace_status: "active" | "archived" | "missing";
    now: string;
  },
): RedemptionDecision {
  // A same-subject retry of its own redemption is an idempotent replay of that
  // join — even past expiry — never a second join.
  if (invitation.redeemed_by === context.invitee_user_id) {
    if (context.invitee_membership_id !== null) {
      return { kind: "replay", membership_id: context.invitee_membership_id };
    }
    // The redemption happened but its membership was removed later; the
    // one-time invitation cannot grant it again.
    return { kind: "deny", reason: "consumed" };
  }
  if (invitation.revoked_at !== null) {
    return { kind: "deny", reason: "revoked" };
  }
  if (Date.parse(invitation.expires_at) <= Date.parse(context.now)) {
    return { kind: "deny", reason: "expired" };
  }
  if (invitation.redeemed_at !== null) {
    return { kind: "deny", reason: "consumed" };
  }
  if (
    invitation.bound_provider_subject !== null &&
    invitation.bound_provider_subject !== context.invitee_provider_subject
  ) {
    return { kind: "deny", reason: "wrong_subject" };
  }
  // Invitations never outlive the inviter's authority (ADR-0006).
  if (!context.inviter_authorized) {
    return { kind: "deny", reason: "inviter_authority_lost" };
  }
  if (context.workspace_status !== "active") {
    return { kind: "deny", reason: "workspace_archived" };
  }
  if (!context.invitee_eligible) {
    return { kind: "deny", reason: "ineligible" };
  }
  if (context.invitee_membership_id !== null) {
    return { kind: "deny", reason: "already_member" };
  }
  return { kind: "join" };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface InvitationRepository {
  create(scope: WorkspaceScope, input: CreateInvitationInput): Invitation;
  getById(scope: WorkspaceScope, id: InvitationId): Invitation | undefined;
  /**
   * Locate the invitation for a presented token. The keyed digest is the only
   * lookup key: nothing here accepts, compares, or returns a bearer.
   */
  findByTokenDigest(tokenDigest: string): Invitation | undefined;
  /** Every invitation of one workspace, newest first. */
  list(scope: WorkspaceScope): Invitation[];
  /**
   * Owner revocation, idempotent: an already-revoked or already-consumed
   * invitation is returned unchanged, and revoking twice changes nothing.
   */
  revoke(scope: WorkspaceScope, id: InvitationId, actorId: UserId): Invitation | undefined;
  /**
   * Atomic one-time redemption. Inside one transaction: expiry, revocation,
   * remaining use (single-use guard), intended target, subject binding,
   * inviter authority, eligibility, and existing membership are checked, then
   * the `member` membership is inserted and the invitation consumed together.
   * A same-subject retry of its own redemption is an idempotent `replayed`
   * outcome — never a second join. Every other failure is `denied` with an
   * internal reason; the API maps all reasons to one uniform denial.
   */
  redeem(input: InvitationRedeemInput): InvitationRedemptionOutcome;
}

// ---------------------------------------------------------------------------
// Row → entity mapping
// ---------------------------------------------------------------------------

interface InvitationRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  role: string;
  token_digest: string;
  bound_provider_subject: string | null;
  expires_at: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  redeemed_at: string | null;
  redeemed_by: string | null;
  version: number;
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    role: "member",
    token_digest: row.token_digest,
    bound_provider_subject: row.bound_provider_subject,
    expires_at: row.expires_at,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    redeemed_at: row.redeemed_at,
    redeemed_by: row.redeemed_by,
    version: row.version,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class SqliteInvitationRepository implements InvitationRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  create(scope: WorkspaceScope, input: CreateInvitationInput): Invitation {
    const at = nowIso();
    const id = newId("inv");
    this.db
      .prepare(
        `INSERT INTO invitation
           (id, enterprise_id, workspace_id, role, token_digest, bound_provider_subject,
            expires_at, created_at, created_by, updated_at, updated_by, version)
         VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        id,
        scope.enterprise_id,
        scope.workspace_id,
        input.token_digest,
        input.bound_provider_subject ?? null,
        input.expires_at,
        at,
        input.actor_id,
        at,
        input.actor_id,
      );
    const created = this.getById(scope, id);
    if (created === undefined) {
      throw new NotFoundError("invitation", id);
    }
    return created;
  }

  getById(scope: WorkspaceScope, id: InvitationId): Invitation | undefined {
    const row = this.db
      .prepare(
        `SELECT i.* FROM invitation i JOIN workspace w ON i.workspace_id = w.id
         WHERE i.id = ? AND i.workspace_id = ? AND w.enterprise_id = ?`,
      )
      .get(id, scope.workspace_id, scope.enterprise_id) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  findByTokenDigest(tokenDigest: string): Invitation | undefined {
    const row = this.db
      .prepare("SELECT * FROM invitation WHERE token_digest = ?")
      .get(tokenDigest) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  list(scope: WorkspaceScope): Invitation[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM invitation i JOIN workspace w ON i.workspace_id = w.id
         WHERE i.workspace_id = ? AND w.enterprise_id = ?
         ORDER BY i.created_at DESC, i.id DESC`,
      )
      .all(scope.workspace_id, scope.enterprise_id) as unknown as InvitationRow[];
    return rows.map(toInvitation);
  }

  revoke(scope: WorkspaceScope, id: InvitationId, actorId: UserId): Invitation | undefined {
    const existing = this.getById(scope, id);
    if (existing === undefined) {
      return undefined;
    }
    // Idempotent and without effect on a consumed invitation: only an
    // outstanding (unrevoked, unconsumed) invitation ever changes state.
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE invitation SET revoked_at = ?, revoked_by = ?, updated_at = ?, updated_by = ?,
           version = version + 1
         WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL`,
      )
      .run(at, actorId, at, actorId, id, scope.workspace_id);
    return this.getById(scope, id);
  }

  redeem(input: InvitationRedeemInput): InvitationRedemptionOutcome {
    const at = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const outcome = this.#redeemInTransaction(input, at);
      if (outcome.status === "denied") {
        this.db.exec("ROLLBACK");
        return outcome;
      }
      this.db.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #redeemInTransaction(input: InvitationRedeemInput, at: string): InvitationRedemptionOutcome {
    const row = this.db
      .prepare("SELECT * FROM invitation WHERE token_digest = ?")
      .get(input.token_digest) as InvitationRow | undefined;
    if (row === undefined) {
      return { status: "denied", reason: "unknown_token" };
    }
    const invitation = toInvitation(row);
    const existing = this.db
      .prepare("SELECT id FROM membership WHERE workspace_id = ? AND user_id = ?")
      .get(invitation.workspace_id, input.invitee_user_id) as { id: string } | undefined;
    const workspace = this.db
      .prepare("SELECT status FROM workspace WHERE id = ?")
      .get(invitation.workspace_id) as { status: string } | undefined;
    let workspaceStatus: "active" | "archived" | "missing" = "missing";
    if (workspace !== undefined) {
      workspaceStatus = workspace.status === "active" ? "active" : "archived";
    }
    const decision = evaluateRedemption(invitation, {
      invitee_user_id: input.invitee_user_id,
      invitee_membership_id: existing?.id ?? null,
      invitee_provider_subject: input.invitee_provider_subject,
      inviter_authorized: input.inviter_authorized,
      invitee_eligible: input.invitee_eligible,
      workspace_status: workspaceStatus,
      now: at,
    });
    if (decision.kind === "deny") {
      return { status: "denied", reason: decision.reason };
    }
    if (decision.kind === "replay") {
      return { status: "replayed", invitation, membership_id: decision.membership_id };
    }

    // Membership insert and invitation consume commit or roll back together.
    try {
      this.db
        .prepare(
          `INSERT INTO membership
             (id, enterprise_id, workspace_id, user_id, role,
              created_at, updated_at, created_by, updated_by, version)
           VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?, 1)`,
        )
        .run(
          newId("mbr"),
          invitation.enterprise_id,
          invitation.workspace_id,
          input.invitee_user_id,
          at,
          at,
          input.invitee_user_id,
          input.invitee_user_id,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return { status: "denied", reason: "already_member" };
      }
      throw error;
    }
    const membership = this.db
      .prepare("SELECT id FROM membership WHERE workspace_id = ? AND user_id = ?")
      .get(invitation.workspace_id, input.invitee_user_id) as { id: string } | undefined;
    if (membership === undefined) {
      return { status: "denied", reason: "already_member" };
    }
    // Single-use guard: the one remaining use is consumed here or not at all.
    const consumed = this.db
      .prepare(
        `UPDATE invitation SET redeemed_at = ?, redeemed_by = ?, updated_at = ?, updated_by = ?,
           version = version + 1
         WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
      )
      .run(at, input.invitee_user_id, at, input.invitee_user_id, invitation.id);
    if (Number(consumed.changes) !== 1) {
      return { status: "denied", reason: "consumed" };
    }
    const updated = this.db
      .prepare("SELECT * FROM invitation WHERE id = ?")
      .get(invitation.id) as unknown as InvitationRow;
    return { status: "joined", invitation: toInvitation(updated), membership_id: membership.id };
  }
}

export function createInvitationRepository(db: ControlPlaneDb): InvitationRepository {
  return new SqliteInvitationRepository(db);
}
