import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createIdentityRepositories,
  createInvitationRepository,
  createProviderAccessRepositories,
  createRepositories,
  evaluateRedemption,
  hasCurrentRepositoryAccess,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  ControlPlaneRepositories,
  IdentityRepositories,
  InvitationRepository,
  ProviderAccessRepositories,
  RedemptionFacts,
  ServiceIntegration,
  UserId,
  Workspace,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import {
  invitationTokenDigest,
  mintInvitationToken,
  readOrCreateInvitationDigestKey,
} from "../src/api/invitation-service.js";

/**
 * Storage-level behavior of owner-created invitations (DAT-204): keyed
 * digests, atomic one-time redemption, idempotent same-subject replay, every
 * denial reason (including the repository-authority eligibility policy), and
 * idempotent revocation.
 *
 * Authority facts are produced through DAT-203's authority store — the same
 * API reconciliation and the DAT-247 point refresh use — never by writing
 * `subject_authority` rows directly. The HTTP point refresh itself is
 * exercised end to end in invitation-api.test.ts.
 */

const KEY = randomBytes(32);
const ACTOR = "usr_owner";

interface World {
  db: ControlPlaneDb;
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  access: ProviderAccessRepositories;
  invitations: InvitationRepository;
  workspace: Workspace;
  integration: ServiceIntegration;
  scope: WorkspaceScope;
  providerInstanceId: string;
  /** A user with a verified identity on the workspace's provider instance. */
  makeUser(subject: string): UserId;
  /**
   * Record repository authority through DAT-203's store — the same write
   * reconciliation and DAT-247's subject refresh perform.
   *
   * `verified_at` controls freshness: DAT-247's read model treats anything
   * older than its freshness window as not current.
   */
  verifyAccess(
    subject: string,
    overrides?: { has_access?: boolean; verified_at?: string; subjectOverride?: string },
  ): void;
  redeem(userId: UserId, token: string): ReturnType<InvitationRepository["redeem"]>;
}

function world(): World {
  const db = openControlPlaneDb();
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const access = createProviderAccessRepositories(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: `test-ent-${randomBytes(4).toString("hex")}`,
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: "repo-1",
    provider_instance_id: provider.id,
  });
  const scope: WorkspaceScope = {
    enterprise_id: enterprise.id,
    workspace_id: workspace.id,
    actor_id: ACTOR,
  };
  const integration = access.integrations.create(scope, {
    provider_instance_id: provider.id,
    repository_id: "github:Luthiel/AutoFixer",
    repository_name: "Luthiel/AutoFixer",
    source_credential_ref: "svc-source-1",
    permission_visibility: "full",
    actor_id: ACTOR,
  });
  const invitations = createInvitationRepository(db, access);
  // The invitation creator holds current repository administration authority.
  repos.memberships.create(scope, { user_id: ACTOR, role: "owner" });
  return {
    db,
    repos,
    identity,
    access,
    invitations,
    workspace,
    integration,
    scope,
    providerInstanceId: provider.id,
    makeUser(subject: string): UserId {
      const user = identity.users.create({ display_name: `User ${subject}`, actor_id: ACTOR });
      identity.identities.create({
        user_id: user.id,
        provider_instance_id: provider.id,
        subject,
        login: `login-${subject}`,
        actor_id: ACTOR,
      });
      return user.id;
    },
    verifyAccess(subject, overrides = {}) {
      const recordedSubject = overrides.subjectOverride ?? subject;
      const verifiedAt = overrides.verified_at ?? new Date().toISOString();
      if (overrides.has_access === false) {
        access.roster.setAuthorityState(
          scope,
          integration.id,
          recordedSubject,
          "removed",
          verifiedAt,
        );
        return;
      }
      access.roster.applySnapshot(scope, integration.id, {
        roles: [
          {
            subject: recordedSubject,
            login: `login-${recordedSubject}`,
            source_kind: "direct_collaborator",
            provider_role: "push",
            authority_ref: "repository:Luthiel/AutoFixer",
            inherited_from: null,
          },
        ],
        verified_at: verifiedAt,
      });
    },
    redeem(userId: UserId, token: string) {
      return invitations.redeem({
        token_digest: invitationTokenDigest(KEY, token),
        invitee_user_id: userId,
      });
    },
  };
}

function mint(w: World, overrides: { ttlSeconds?: number; bound?: string } = {}) {
  const token = mintInvitationToken();
  const invitation = w.invitations.create(w.scope, {
    token_digest: invitationTokenDigest(KEY, token),
    ...(overrides.bound !== undefined ? { bound_provider_subject: overrides.bound } : {}),
    expires_at: new Date(Date.now() + (overrides.ttlSeconds ?? 3600) * 1000).toISOString(),
    actor_id: ACTOR,
  });
  return { token, invitation };
}

function expectDenied(outcome: ReturnType<InvitationRepository["redeem"]>, reason: string): void {
  expect(outcome.status).toBe("denied");
  if (outcome.status === "denied") {
    expect(outcome.reason).toBe(reason);
  }
}

describe("invitation tokens", () => {
  test("minted bearers are URL-safe, prefixed, and carry ≥128 bits of entropy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const token = mintInvitationToken();
      expect(token.startsWith("inv_")).toBe(true);
      expect(token).toMatch(/^inv_[A-Za-z0-9_-]+$/);
      // 32 random bytes in base64url = 43 characters = 256 bits of entropy.
      expect(token.slice("inv_".length).length).toBeGreaterThanOrEqual(22);
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  test("storage holds only the keyed digest, never the bearer", () => {
    const w = world();
    const { token, invitation } = mint(w);
    expect(invitation.token_digest).not.toContain(token);
    expect(invitation.token_digest).not.toBe(invitationTokenDigest(randomBytes(32), token));
    expect(invitation.token_digest).toBe(invitationTokenDigest(KEY, token));
    const row = w.db.prepare("SELECT * FROM invitation WHERE id = ?").get(invitation.id);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(w.invitations.findByTokenDigest(invitationTokenDigest(KEY, token))?.id).toBe(
      invitation.id,
    );
    w.db.close();
  });

  test("digest key files are created once and read back identically", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "forgepilot-invite-key-"));
    const keyFile = path.join(dir, "invitation.key");
    const first = readOrCreateInvitationDigestKey(keyFile);
    const second = readOrCreateInvitationDigestKey(keyFile);
    expect(first.equals(second)).toBe(true);
    expect(first.length).toBe(32);
  });
});

describe("atomic redemption", () => {
  test("redeem adds a member membership and consumes the invitation together", () => {
    const w = world();
    const invitee = w.makeUser("2002");
    w.verifyAccess("2002");
    const { token, invitation } = mint(w);
    const outcome = w.redeem(invitee, token);
    expect(outcome.status).toBe("joined");
    if (outcome.status !== "joined") return;
    expect(outcome.invitation.redeemed_at).not.toBeNull();
    expect(outcome.invitation.redeemed_by).toBe(invitee);
    expect(outcome.invitation.version).toBe(invitation.version + 1);
    const membership = w.repos.memberships.getByUser({ ...w.scope, actor_id: invitee }, invitee);
    expect(membership?.id).toBe(outcome.membership_id);
    expect(membership?.role).toBe("member");
    w.db.close();
  });

  test("concurrent redeemers: the one-time use admits exactly one join", () => {
    const w = world();
    const { token } = mint(w);
    const first = w.makeUser("3001");
    const second = w.makeUser("3002");
    w.verifyAccess("3001");
    w.verifyAccess("3002");
    // The guarded consume inside the redemption transaction admits exactly
    // one join whatever the interleaving (true concurrent HTTP redemption is
    // exercised in invitation-api.test.ts); the loser sees the used state.
    const outcomes = [first, second].map((invitee) => w.redeem(invitee, token));
    const joined = outcomes.filter((outcome) => outcome.status === "joined");
    const denied = outcomes.filter((outcome) => outcome.status === "denied");
    expect(joined).toHaveLength(1);
    expect(denied).toHaveLength(1);
    if (denied[0]?.status === "denied") {
      expect(denied[0].reason).toBe("consumed");
    }
    w.db.close();
  });

  test("same-subject retry is an idempotent replay of its own join", () => {
    const w = world();
    const invitee = w.makeUser("4004");
    w.verifyAccess("4004");
    const { token } = mint(w);
    const first = w.redeem(invitee, token);
    const second = w.redeem(invitee, token);
    expect(first.status).toBe("joined");
    expect(second.status).toBe("replayed");
    if (first.status === "joined" && second.status === "replayed") {
      expect(second.membership_id).toBe(first.membership_id);
      expect(second.invitation.redeemed_by).toBe(invitee);
    }
    // Still one membership of the invitee: a retry is never a second join.
    expect(
      w.repos.memberships.list(w.scope).filter((membership) => membership.user_id === invitee),
    ).toHaveLength(1);
    w.db.close();
  });

  test("a replay whose membership was later removed cannot rejoin", () => {
    const w = world();
    const invitee = w.makeUser("5005");
    w.verifyAccess("5005");
    const { token } = mint(w);
    const first = w.redeem(invitee, token);
    expect(first.status).toBe("joined");
    if (first.status !== "joined") return;
    w.repos.memberships.remove(w.scope, first.membership_id);
    expectDenied(w.redeem(invitee, token), "consumed");
    expect(
      w.repos.memberships.list(w.scope).filter((membership) => membership.user_id === invitee),
    ).toHaveLength(0);
    w.db.close();
  });
});

describe("repository-authority eligibility policy", () => {
  /** DAT-247's default sensitive-action freshness window is 15 minutes. */
  const STALE_AFTER_MS = 15 * 60 * 1000;

  test("a verified identity without repository authority is ineligible", () => {
    const w = world();
    // The QA scenario: the invitee has a provider identity on the workspace's
    // provider instance but DAT-203's authority store knows nothing about
    // them for the workspace's active integration.
    const invitee = w.makeUser("6001");
    expectDenied(w.redeem(invitee, mint(w).token), "ineligible");
    w.db.close();
  });

  test("removed and stale authority both deny; a fresh refresh opens the invitation", () => {
    const w = world();
    const invitee = w.makeUser("6002");
    // The provider positively says the subject is not a member.
    w.verifyAccess("6002", { has_access: false });
    expectDenied(w.redeem(invitee, mint(w).token), "ineligible");

    // `active` but verified outside DAT-247's freshness window is stale.
    const staleAt = new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString();
    w.verifyAccess("6002", { verified_at: staleAt });
    expectDenied(w.redeem(invitee, mint(w).token), "ineligible");

    // A fresh re-verification (the DAT-247 point refresh at redemption)
    // opens the same invitation again — the denial never consumed it.
    w.verifyAccess("6002");
    expect(w.redeem(invitee, mint(w).token).status).toBe("joined");
    w.db.close();
  });

  test("authority for another subject or integration does not count", () => {
    const w = world();
    const invitee = w.makeUser("6003");
    // Authority for a different subject…
    w.verifyAccess("6003", { subjectOverride: "someone-else" });
    expectDenied(w.redeem(invitee, mint(w).token), "ineligible");
    // …and for the same subject under a different workspace integration.
    const otherIntegration = w.access.integrations.create(w.scope, {
      provider_instance_id: w.providerInstanceId,
      repository_id: "github:Luthiel/Other",
      repository_name: "Luthiel/Other",
      source_credential_ref: "svc-source-2",
      permission_visibility: "full",
      actor_id: ACTOR,
    });
    w.access.roster.applySnapshot(w.scope, otherIntegration.id, {
      roles: [
        {
          subject: "6003",
          login: "login-6003",
          source_kind: "direct_collaborator",
          provider_role: "push",
          authority_ref: "repository:Luthiel/Other",
          inherited_from: null,
        },
      ],
      verified_at: new Date().toISOString(),
    });
    expectDenied(w.redeem(invitee, mint(w).token), "ineligible");
    w.verifyAccess("6003");
    expect(w.redeem(invitee, mint(w).token).status).toBe("joined");
    w.db.close();
  });

  test("a workspace without an active integration is ineligible (fail closed)", () => {
    const w = world();
    const invitee = w.makeUser("6006");
    w.verifyAccess("6006");
    w.access.integrations.setStatus(
      w.scope,
      w.integration.id,
      { install_status: "suspended", actor_id: ACTOR },
      w.integration.version,
    );
    expectDenied(w.redeem(invitee, mint(w).token), "ineligible");
    w.db.close();
  });

  test("the invitation consumes DAT-247's verdict, not its own freshness policy", () => {
    expect(hasCurrentRepositoryAccess(null)).toBe(false);
    expect(hasCurrentRepositoryAccess({ current: false })).toBe(false);
    expect(hasCurrentRepositoryAccess({ current: true })).toBe(true);
  });
});

describe("denial reasons", () => {
  test("unknown, expired, and revoked invitations are rejected", () => {
    const w = world();
    const invitee = w.makeUser("6101");
    w.verifyAccess("6101");
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, "inv_unknown"),
        invitee_user_id: invitee,
      }),
      "unknown_token",
    );
    expectDenied(w.redeem(invitee, mint(w, { ttlSeconds: -10 }).token), "expired");
    const live = mint(w);
    w.invitations.revoke(w.scope, live.invitation.id, ACTOR);
    expectDenied(w.redeem(invitee, live.token), "revoked");
    w.db.close();
  });

  test("a bound invitation rejects wrong-subject use and forwards", () => {
    const w = world();
    const { token } = mint(w, { bound: "subject-intended" });
    const wrongUser = w.makeUser("6102");
    w.verifyAccess("6102");
    expectDenied(w.redeem(wrongUser, token), "wrong_subject");
    const rightUser = w.makeUser("subject-intended");
    w.verifyAccess("subject-intended");
    expect(w.redeem(rightUser, token).status).toBe("joined");
    w.db.close();
  });

  test("lost inviter authority and existing members are rejected", () => {
    const w = world();
    const invitee = w.makeUser("6103");
    w.verifyAccess("6103");
    // The creator loses their administration authority before redemption.
    const inviterMembership = w.repos.memberships.getByUser(w.scope, ACTOR);
    w.repos.memberships.updateRole(
      w.scope,
      inviterMembership?.id ?? "",
      "viewer",
      inviterMembership?.version ?? 0,
    );
    expectDenied(w.redeem(invitee, mint(w).token), "inviter_authority_lost");
    // Restore authority; an existing member cannot consume another invitation.
    const current = w.repos.memberships.getByUser(w.scope, ACTOR);
    w.repos.memberships.updateRole(w.scope, current?.id ?? "", "owner", current?.version ?? 0);
    w.repos.memberships.create(w.scope, { user_id: invitee, role: "member" });
    const alreadyMember = mint(w);
    expectDenied(w.redeem(invitee, alreadyMember.token), "already_member");
    // The denial never consumes the invitation.
    expect(w.invitations.getById(w.scope, alreadyMember.invitation.id)?.redeemed_at).toBeNull();
    w.db.close();
  });

  test("archived workspaces reject redemption", () => {
    const w = world();
    const invitee = w.makeUser("6104");
    w.verifyAccess("6104");
    const { token, invitation } = mint(w);
    w.repos.workspaces.archive(
      { enterprise_id: w.scope.enterprise_id, actor_id: ACTOR },
      w.workspace.id,
      w.workspace.version,
    );
    expectDenied(w.redeem(invitee, token), "workspace_archived");
    expect(w.invitations.getById(w.scope, invitation.id)?.redeemed_at).toBeNull();
    w.db.close();
  });

  test("evaluateRedemption orders replay before every denial", () => {
    const w = world();
    const invitee = w.makeUser("6105");
    const base = mint(w, { ttlSeconds: -5 }).invitation;
    const facts: RedemptionFacts = {
      invitee_user_id: invitee,
      invitee_membership_id: "mbr_x",
      invitee_provider_subject: null,
      inviter_role: null,
      repository_access: { current: false },
      workspace_status: "archived",
      now: new Date().toISOString(),
    };
    const replayed = evaluateRedemption(
      { ...base, redeemed_at: "2026-01-01T00:00:00Z", redeemed_by: invitee },
      facts,
    );
    expect(replayed).toEqual({ kind: "replay", membership_id: "mbr_x" });
    // The same facts without the replay key deny instead.
    expect(evaluateRedemption(base, facts)).toEqual({ kind: "deny", reason: "expired" });
    w.db.close();
  });
});

describe("revocation", () => {
  test("revocation is idempotent and never disturbs a consumed invitation", () => {
    const w = world();
    const { invitation } = mint(w);
    const first = w.invitations.revoke(w.scope, invitation.id, ACTOR);
    const second = w.invitations.revoke(w.scope, invitation.id, ACTOR);
    expect(first?.revoked_at).not.toBeNull();
    expect(second?.revoked_at).toBe(first?.revoked_at);
    expect(second?.version).toBe(first?.version);

    const invitee = w.makeUser("7001");
    w.verifyAccess("7001");
    const consumed = mint(w);
    const joined = w.redeem(invitee, consumed.token);
    expect(joined.status).toBe("joined");
    const after = w.invitations.revoke(w.scope, consumed.invitation.id, ACTOR);
    expect(after?.revoked_at).toBeNull();
    expect(after?.redeemed_at).not.toBeNull();
    w.db.close();
  });

  test("cross-scope reads cannot see or revoke another scope's invitations", () => {
    const w = world();
    const { invitation } = mint(w);
    const foreignScope: WorkspaceScope = {
      enterprise_id: "ent_foreign",
      workspace_id: w.workspace.id,
      actor_id: ACTOR,
    };
    expect(w.invitations.getById(foreignScope, invitation.id)).toBeUndefined();
    expect(w.invitations.list(foreignScope)).toEqual([]);
    expect(w.invitations.revoke(foreignScope, invitation.id, ACTOR)).toBeUndefined();
    expect(w.invitations.getById(w.scope, invitation.id)?.revoked_at).toBeNull();
    w.db.close();
  });
});

describe("listing", () => {
  test("lists newest first and stays inside one workspace", () => {
    const w = world();
    const created = [mint(w).invitation.id, mint(w).invitation.id, mint(w).invitation.id];
    const listed = w.invitations.list(w.scope).map((invitation) => invitation.id);
    expect(listed).toHaveLength(3);
    expect(new Set(listed)).toEqual(new Set(created));
    const timestamps = w.invitations.list(w.scope).map((invitation) => invitation.created_at);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
    w.db.close();
  });
});
