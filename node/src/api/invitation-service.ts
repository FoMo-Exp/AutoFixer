/**
 * Owner-created invitation domain service (DAT-204, ADR-0006).
 *
 * Both presentations of an invitation — the QR (which encodes `invite_url`
 * with the bearer in the URL fragment) and the grouped copyable code — carry
 * the same opaque bearer. The bearer is minted here, returned exactly once by
 * creation, and stored only as an HMAC-SHA-256 keyed digest; no read, error,
 * audit record, or log ever carries it. Consumption happens only through the
 * explicit, authenticated join confirmation: preview and redemption submit the
 * bearer in a POST body, run the shared redemption decision, and redeem adds a
 * `member` membership and consumes the invitation in one transaction.
 *
 * Every non-consumable state is served as one uniform, non-enumerating
 * INVITATION_NOT_ACCEPTED; the internal reason is audited but never leaked.
 */

import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  AppUser,
  ControlPlaneRepositories,
  Enterprise,
  EnterpriseId,
  EnterpriseScope,
  Invitation,
  InvitationDenialReason,
  InvitationRedemptionOutcome,
  InvitationRepository,
  InvitationStatus,
  IdentityRepositories,
  UserId,
  Workspace,
  WorkspaceId,
  WorkspaceScope,
} from "../control-plane/index.js";
import { ApiError } from "./errors.js";
import type {
  EnterpriseRefView,
  MembershipView,
  UserRefView,
  WorkspaceRefView,
  WorkspaceView,
} from "./identity-views.js";
import {
  enterpriseRef,
  membershipView,
  userRef,
  workspaceRef,
  workspaceView,
} from "./identity-views.js";

// ---------------------------------------------------------------------------
// Token material
// ---------------------------------------------------------------------------

/** URL-safe display prefix; the bearer itself carries ≥128 bits of entropy. */
const TOKEN_PREFIX = "inv_";

/** Default and maximum lifetime: 24 hours. Owners may only shorten it. */
export const INVITATION_MAX_TTL_SECONDS = 86400;

/** Pagination contract: opaque cursor = last item id, 50 items per page. */
const PAGE_SIZE = 50;

/**
 * Mint a fresh opaque bearer: `inv_` plus 256 bits of URL-safe randomness.
 * The raw value exists only in the create response.
 */
export function mintInvitationToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The keyed digest form used as the only storage locator for a bearer. */
export function invitationTokenDigest(key: Buffer, token: string): string {
  return createHmac("sha256", key).update(token).digest("hex");
}

/**
 * Read the deployment-owned HMAC key for invitation digests, creating it once
 * if absent. The key is durable across restarts (invitations outlive
 * processes), owner-only, and never derived from anything a client can
 * influence. Losing it fails closed: outstanding invitations become
 * unredeemable rather than guessable.
 */
export function readOrCreateInvitationDigestKey(keyFile: string): Buffer {
  const dir = path.dirname(keyFile);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  let raw: string | undefined;
  try {
    const stat = fs.lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`refusing to read non-regular invitation digest key file ${keyFile}`);
    }
    raw = fs.readFileSync(keyFile, "utf8");
  } catch (error) {
    const missing =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
  }
  if (raw !== undefined) {
    const hex = raw.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(`invitation digest key file ${keyFile} must hold 64 hexadecimal characters`);
    }
    return Buffer.from(hex, "hex");
  }
  const key = randomBytes(32);
  fs.writeFileSync(keyFile, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  return key;
}

// ---------------------------------------------------------------------------
// Rate limiting (per actor and per request origin)
// ---------------------------------------------------------------------------

export interface InvitationRateLimits {
  windowSeconds: number;
  createPerWindow: number;
  previewPerWindow: number;
  redeemPerWindow: number;
  /** Origin budgets are this multiple of the per-actor budget (origins are shared). */
  originMultiplier: number;
}

export const DEFAULT_INVITATION_RATE_LIMITS: InvitationRateLimits = {
  windowSeconds: 900,
  createPerWindow: 20,
  previewPerWindow: 60,
  redeemPerWindow: 30,
  originMultiplier: 10,
};

interface RateWindow {
  count: number;
  resetAtMs: number;
}

/**
 * Fixed-window limiter. Abuse of creation, preview, or redemption is what
 * makes bearer guessing cheap to attempt, so both the actor and the request
 * origin carry budgets and exhaustion is 429 with a retry hint.
 */
class FixedWindowRateLimiter {
  readonly #windows = new Map<string, RateWindow>();

  consume(key: string, limit: number, windowSeconds: number): void {
    const nowMs = Date.now();
    const window = this.#windows.get(key);
    if (window === undefined || nowMs >= window.resetAtMs) {
      this.#windows.set(key, { count: 1, resetAtMs: nowMs + windowSeconds * 1000 });
      return;
    }
    window.count += 1;
    if (window.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAtMs - nowMs) / 1000));
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many attempts. Try again later.",
        {},
        { stage: "auth", retry_after_seconds: retryAfterSeconds },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Views (contract shapes)
// ---------------------------------------------------------------------------

export interface InvitationView {
  id: string;
  workspace_id: string;
  role: "member";
  expires_at: string;
  bound_provider_subject: string | null;
  status: InvitationStatus;
  created_by: UserRefView;
  created_at: string;
  revoked_at: string | null;
  redeemed_at: string | null;
  version: number;
}

export interface CreatedInvitationView {
  invitation: InvitationView;
  /** The bearer, shown exactly once, in this response only. */
  token: string;
  /** Landing URL carrying the bearer in the fragment, never the query. */
  invite_url: string;
}

export interface InvitationPreviewView {
  workspace: WorkspaceRefView;
  enterprise: EnterpriseRefView;
  role: "member";
  expires_at: string;
  inviter: UserRefView;
  /** True when the caller already redeemed this invitation (idempotent replay). */
  already_joined: boolean;
}

export interface InvitationRedemptionView {
  workspace: WorkspaceView;
  membership: MembershipView;
}

export interface InvitationPageView {
  items: InvitationView[];
  next_cursor: string | null;
}

/** The actor of an invitation-surface request. */
export interface InvitationRequestContext {
  user_id: UserId;
  /** Request origin: rate-limit key and `invite_url` base. */
  origin: string;
}

export interface CreateInvitationRequest {
  expires_in_seconds?: unknown;
  bound_provider_subject?: unknown;
}

export interface InvitationServiceConfig {
  /** Enterprise the stage-one deployment serves (DAT-241 generalizes scope). */
  enterpriseId: EnterpriseId;
  /** HMAC key for the keyed token digest; never leaves the service. */
  digestKey: Buffer;
  rateLimits?: InvitationRateLimits;
}

export interface InvitationServiceDeps {
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  invitations: InvitationRepository;
  config: InvitationServiceConfig;
}

const INVITATION_NOT_ACCEPTED_MESSAGE =
  "This invitation cannot be used. Ask the workspace owner for a new invitation.";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class InvitationService {
  readonly #repos: ControlPlaneRepositories;
  readonly #identity: IdentityRepositories;
  readonly #invitations: InvitationRepository;
  readonly #config: Required<InvitationServiceConfig>;
  readonly #limiter = new FixedWindowRateLimiter();

  constructor(deps: InvitationServiceDeps) {
    this.#repos = deps.repos;
    this.#identity = deps.identity;
    this.#invitations = deps.invitations;
    this.#config = {
      enterpriseId: deps.config.enterpriseId,
      digestKey: deps.config.digestKey,
      rateLimits: deps.config.rateLimits ?? DEFAULT_INVITATION_RATE_LIMITS,
    };
  }

  // -------------------------------------------------------------------------
  // Owner/admin surface
  // -------------------------------------------------------------------------

  createInvitation(
    actor: InvitationRequestContext,
    workspaceId: WorkspaceId,
    input: CreateInvitationRequest,
  ): CreatedInvitationView {
    const workspace = this.#requireWorkspaceAdmin(workspaceId, actor.user_id);
    if (workspace.status !== "active") {
      throw new ApiError(400, "INVALID_REQUEST", "workspace is not active");
    }
    this.#rateLimit("create", actor);
    const boundSubject = parseBoundSubject(input.bound_provider_subject);
    const ttlSeconds = parseTtlSeconds(input.expires_in_seconds);
    const token = mintInvitationToken();
    const invitation = this.#invitations.create(this.#workspaceScope(workspace, actor.user_id), {
      token_digest: invitationTokenDigest(this.#config.digestKey, token),
      ...(boundSubject !== undefined ? { bound_provider_subject: boundSubject } : {}),
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      actor_id: actor.user_id,
    });
    this.#audit({
      event: "invitation.created",
      enterprise_id: workspace.enterprise_id,
      actor_kind: "user",
      actor_user_id: actor.user_id,
      details: {
        invitation_id: invitation.id,
        workspace_id: workspace.id,
        role: invitation.role,
        expires_at: invitation.expires_at,
        bound_provider_subject: invitation.bound_provider_subject,
      },
    });
    return {
      invitation: this.#invitationView(invitation, workspace),
      token,
      // The bearer travels in the URL fragment: a GET of the landing page —
      // including link previews and security scanners — never sees it in
      // server-side request data and nothing server-side consumes it on GET.
      invite_url: `${actor.origin}/invite#${token}`,
    };
  }

  listInvitations(
    actor: InvitationRequestContext,
    workspaceId: WorkspaceId,
    cursor: string | null,
  ): InvitationPageView {
    const workspace = this.#requireWorkspaceAdmin(workspaceId, actor.user_id);
    const all = this.#invitations
      .list(this.#workspaceScope(workspace, actor.user_id))
      .map((invitation) => this.#invitationView(invitation, workspace));
    let startIndex = 0;
    if (cursor !== null) {
      const index = all.findIndex((invitation) => invitation.id === cursor);
      if (index === -1) {
        throw new ApiError(400, "INVALID_CURSOR", `Unknown cursor ${JSON.stringify(cursor)}`);
      }
      startIndex = index + 1;
    }
    const page = all.slice(startIndex, startIndex + PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      items: page,
      next_cursor: last !== undefined && startIndex + page.length < all.length ? last.id : null,
    };
  }

  revokeInvitation(
    actor: InvitationRequestContext,
    workspaceId: WorkspaceId,
    invitationId: string,
  ): void {
    const workspace = this.#requireWorkspaceAdmin(workspaceId, actor.user_id);
    const scope = this.#workspaceScope(workspace, actor.user_id);
    const before = this.#invitations.getById(scope, invitationId);
    if (before === undefined) {
      throw new ApiError(404, "NOT_FOUND", "invitation not found");
    }
    const after = this.#invitations.revoke(scope, invitationId, actor.user_id);
    if (after === undefined) {
      throw new ApiError(404, "NOT_FOUND", "invitation not found");
    }
    // Idempotent: audit only the state change, never the replay of a revoke.
    if (before.revoked_at === null && after.revoked_at !== null) {
      this.#audit({
        event: "invitation.revoked",
        enterprise_id: workspace.enterprise_id,
        actor_kind: "user",
        actor_user_id: actor.user_id,
        details: { invitation_id: after.id, workspace_id: workspace.id },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Join-confirmation surface
  // -------------------------------------------------------------------------

  previewInvitation(actor: InvitationRequestContext, token: string): InvitationPreviewView {
    this.#rateLimit("preview", actor);
    const { invitation, workspace, inviter } = this.#resolveByToken(
      token,
      "invitation.preview",
      actor.user_id,
    );
    // The same decision procedure the redeem transaction runs, with no side
    // effects: eligibility is the fresh repository-access verification the
    // policy requires, read from the control plane at this moment.
    const decision = this.#invitations.evaluate({
      token_digest: invitation.token_digest,
      invitee_user_id: actor.user_id,
    });
    if (decision.kind === "deny") {
      this.#auditAttempt(
        "invitation.preview",
        invitation,
        actor.user_id,
        "denied",
        decision.reason,
      );
      throw invitationNotAccepted();
    }
    this.#auditAttempt("invitation.preview", invitation, actor.user_id, "ok");
    return {
      workspace: workspaceRef(workspace),
      enterprise: enterpriseRef(this.#requireEnterprise(workspace.enterprise_id)),
      role: "member",
      expires_at: invitation.expires_at,
      inviter,
      already_joined: decision.kind === "replay",
    };
  }

  redeemInvitation(actor: InvitationRequestContext, token: string): InvitationRedemptionView {
    this.#rateLimit("redeem", actor);
    const { invitation, workspace } = this.#resolveByToken(
      token,
      "invitation.redeem",
      actor.user_id,
    );
    // The transaction re-reads every decision fact — including the invitee's
    // current repository access and the inviter's current authority — and
    // consumes atomically, so the decision is valid at redemption time.
    const outcome: InvitationRedemptionOutcome = this.#invitations.redeem({
      token_digest: invitation.token_digest,
      invitee_user_id: actor.user_id,
    });
    if (outcome.status === "denied") {
      this.#auditAttempt("invitation.redeem", invitation, actor.user_id, "denied", outcome.reason);
      throw invitationNotAccepted();
    }
    this.#auditAttempt(
      "invitation.redeem",
      outcome.invitation,
      actor.user_id,
      outcome.status,
      undefined,
    );
    return this.#redemptionView(outcome.membership_id, workspace, actor.user_id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Workspace administration gate for the owner surface. A caller without a
   * membership cannot distinguish an absent workspace from an inaccessible
   * one (non-enumerating 404); a member without owner/admin authority sees
   * exactly that (403).
   */
  #requireWorkspaceAdmin(workspaceId: WorkspaceId, actorUserId: UserId): Workspace {
    // Stage-one scope: the deployment's enterprise (DAT-241 generalizes
    // scope resolution). The path id is a locator; authority is the
    // authenticated membership — never the client-supplied identifier.
    const scope: WorkspaceScope = {
      enterprise_id: this.#config.enterpriseId,
      workspace_id: workspaceId,
      actor_id: actorUserId,
    };
    const membership = this.#repos.memberships.getByUser(scope, actorUserId);
    const workspace = this.#repos.workspaces.getById(scope, workspaceId);
    if (workspace === undefined || membership === undefined) {
      throw new ApiError(404, "NOT_FOUND", "workspace not found");
    }
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "workspace owner or admin authority is required");
    }
    return workspace;
  }

  #workspaceScope(workspace: Workspace, actorId: UserId): WorkspaceScope {
    return {
      enterprise_id: workspace.enterprise_id,
      workspace_id: workspace.id,
      actor_id: actorId,
    };
  }

  #enterpriseScope(enterpriseId: EnterpriseId, actorId: UserId): EnterpriseScope {
    return { enterprise_id: enterpriseId, actor_id: actorId };
  }

  #requireEnterprise(enterpriseId: EnterpriseId): Enterprise {
    const enterprise = this.#repos.enterprises.getById(enterpriseId);
    if (enterprise === undefined) {
      throw new ApiError(500, "INTERNAL_ERROR", "invitation references a missing enterprise");
    }
    return enterprise;
  }

  /** Token lookup: the keyed digest is the only locator; unknown is uniform. */
  #resolveByToken(
    token: string,
    event: "invitation.preview" | "invitation.redeem",
    actorUserId: UserId,
  ): {
    invitation: Invitation;
    workspace: Workspace;
    inviter: UserRefView;
  } {
    const digest = invitationTokenDigest(this.#config.digestKey, token);
    const invitation = this.#invitations.findByTokenDigest(digest);
    if (invitation === undefined) {
      this.#audit({
        event,
        enterprise_id: undefined,
        actor_kind: "user",
        actor_user_id: actorUserId,
        subject_user_id: actorUserId,
        details: { result: "denied", reason: "unknown_token" },
      });
      throw invitationNotAccepted();
    }
    const workspace = this.#repos.workspaces.getById(
      this.#enterpriseScope(invitation.enterprise_id, actorUserId),
      invitation.workspace_id,
    );
    if (workspace === undefined) {
      throw invitationNotAccepted();
    }
    const inviter = this.#identity.users.getById(invitation.created_by);
    return {
      invitation,
      workspace,
      inviter: userRefOrPlaceholder(invitation.created_by, inviter),
    };
  }

  #redemptionView(
    membershipId: string,
    workspace: Workspace,
    inviteeUserId: UserId,
  ): InvitationRedemptionView {
    const membership = this.#repos.memberships.getById(
      this.#workspaceScope(workspace, inviteeUserId),
      membershipId,
    );
    const member = this.#identity.users.getById(inviteeUserId);
    if (membership === undefined || member === undefined) {
      throw new ApiError(500, "INTERNAL_ERROR", "redemption references a missing membership");
    }
    const provider = this.#repos.providerInstances.getById(
      this.#enterpriseScope(workspace.enterprise_id, inviteeUserId),
      workspace.provider_instance_id,
    );
    if (provider === undefined) {
      throw new ApiError(500, "INTERNAL_ERROR", "workspace references a missing provider instance");
    }
    return {
      workspace: workspaceView(workspace, provider.provider_type, membership.role),
      membership: membershipView(membership, userRef(member)),
    };
  }

  /**
   * Server-computed invitation state. An invitation whose creator lost
   * administration authority, or whose workspace is archived, is presented as
   * `expired`: it can never be redeemed again (ADR-0006: "invitations never
   * outlive the inviter's authority").
   */
  #invitationView(invitation: Invitation, workspace: Workspace): InvitationView {
    const inviter = this.#identity.users.getById(invitation.created_by);
    return {
      id: invitation.id,
      workspace_id: invitation.workspace_id,
      role: "member",
      expires_at: invitation.expires_at,
      bound_provider_subject: invitation.bound_provider_subject,
      status: this.#statusOf(invitation, workspace),
      created_by: userRefOrPlaceholder(invitation.created_by, inviter),
      created_at: invitation.created_at,
      revoked_at: invitation.revoked_at,
      redeemed_at: invitation.redeemed_at,
      version: invitation.version,
    };
  }

  #statusOf(invitation: Invitation, workspace: Workspace): InvitationStatus {
    if (invitation.redeemed_at !== null) {
      return "consumed";
    }
    if (invitation.revoked_at !== null) {
      return "revoked";
    }
    if (Date.parse(invitation.expires_at) <= Date.now()) {
      return "expired";
    }
    if (workspace.status !== "active") {
      return "expired";
    }
    // Invitations never outlive the inviter's authority (ADR-0006): current
    // repository administration authority is a live owner/admin membership.
    const inviterRole = this.#repos.memberships.getByUser(
      this.#workspaceScope(workspace, invitation.created_by),
      invitation.created_by,
    )?.role;
    if (inviterRole !== "owner" && inviterRole !== "admin") {
      return "expired";
    }
    return "active";
  }

  #rateLimit(action: "create" | "preview" | "redeem", actor: InvitationRequestContext): void {
    const limits = this.#config.rateLimits;
    const actorLimit = {
      create: limits.createPerWindow,
      preview: limits.previewPerWindow,
      redeem: limits.redeemPerWindow,
    }[action];
    this.#limiter.consume(
      `invitation:${action}:actor:${actor.user_id}`,
      actorLimit,
      limits.windowSeconds,
    );
    this.#limiter.consume(
      `invitation:${action}:origin:${actor.origin}`,
      actorLimit * limits.originMultiplier,
      limits.windowSeconds,
    );
  }

  #auditAttempt(
    event: string,
    invitation: Invitation,
    actorUserId: UserId,
    result: "ok" | "joined" | "replayed" | "denied",
    reason?: InvitationDenialReason,
  ): void {
    this.#audit({
      event,
      enterprise_id: invitation.enterprise_id,
      actor_kind: "user",
      actor_user_id: actorUserId,
      subject_user_id: actorUserId,
      details: {
        invitation_id: invitation.id,
        workspace_id: invitation.workspace_id,
        result,
        // The effective role a successful redemption confers.
        ...(result === "joined" || result === "replayed" ? { role: invitation.role } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    });
  }

  #audit(input: Parameters<IdentityRepositories["authAudit"]["append"]>[0]): void {
    this.#identity.authAudit.append(input);
  }
}

function invitationNotAccepted(): ApiError {
  // One uniform denial for every non-consumable state: unknown, expired,
  // revoked, consumed, wrong-subject, ineligible, and already-member are
  // indistinguishable to the caller.
  return new ApiError(403, "INVITATION_NOT_ACCEPTED", INVITATION_NOT_ACCEPTED_MESSAGE);
}

/**
 * Display ref for the inviter. A creator that can no longer be resolved keeps
 * its id visible but never an invented name.
 */
function userRefOrPlaceholder(userId: UserId, user: AppUser | undefined): UserRefView {
  return user !== undefined ? userRef(user) : { id: userId, display_name: "" };
}

function parseTtlSeconds(value: unknown): number {
  if (value === undefined || value === null) {
    return INVITATION_MAX_TTL_SECONDS;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > INVITATION_MAX_TTL_SECONDS
  ) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `expires_in_seconds must be an integer between 1 and ${INVITATION_MAX_TTL_SECONDS}`,
    );
  }
  return value;
}

function parseBoundSubject(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "bound_provider_subject must be a non-empty string of at most 255 characters",
    );
  }
  return value;
}
