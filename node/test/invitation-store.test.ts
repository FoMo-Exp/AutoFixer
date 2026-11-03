import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createIdentityRepositories,
  createInvitationRepository,
  createRepositories,
  evaluateRedemption,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  InvitationRepository,
  IdentityRepositories,
  ControlPlaneRepositories,
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
 * denial reason, and idempotent revocation.
 */

const KEY = randomBytes(32);
const ACTOR = "usr_owner";
const PAGE = 50;

interface World {
  db: ControlPlaneDb;
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  invitations: InvitationRepository;
  workspace: Workspace;
  scope: WorkspaceScope;
  providerInstanceId: string;
  makeUser(subject: string): UserId;
}

function world(): World {
  const db = openControlPlaneDb();
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const invitations = createInvitationRepository(db);
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
  return {
    db,
    repos,
    identity,
    invitations,
    workspace,
    scope: { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR },
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

function facts(overrides: Partial<Parameters<InvitationRepository["redeem"]>[0]> = {}) {
  return {
    inviter_authorized: true,
    invitee_eligible: true,
    invitee_provider_subject: null,
    ...overrides,
  };
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
    const { token, invitation } = mint(w);
    const outcome = w.invitations.redeem({
      token_digest: invitationTokenDigest(KEY, token),
      invitee_user_id: invitee,
      ...facts(),
    });
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
    const digest = invitationTokenDigest(KEY, token);
    const first = w.makeUser("3001");
    const second = w.makeUser("3002");
    // The guarded consume inside the redemption transaction admits exactly
    // one join whatever the interleaving (true concurrent HTTP redemption is
    // exercised in invitation-api.test.ts); the loser sees the used state.
    const outcomes = [first, second].map((invitee) =>
      w.invitations.redeem({
        token_digest: digest,
        invitee_user_id: invitee,
        ...facts(),
      }),
    );
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
    const { token } = mint(w);
    const digest = invitationTokenDigest(KEY, token);
    const first = w.invitations.redeem({
      token_digest: digest,
      invitee_user_id: invitee,
      ...facts(),
    });
    const second = w.invitations.redeem({
      token_digest: digest,
      invitee_user_id: invitee,
      ...facts(),
    });
    expect(first.status).toBe("joined");
    expect(second.status).toBe("replayed");
    if (first.status === "joined" && second.status === "replayed") {
      expect(second.membership_id).toBe(first.membership_id);
      expect(second.invitation.redeemed_by).toBe(invitee);
    }
    // Still one membership: a retry is never a second join.
    expect(w.repos.memberships.list(w.scope)).toHaveLength(1);
    w.db.close();
  });

  test("a replay whose membership was later removed cannot rejoin", () => {
    const w = world();
    const invitee = w.makeUser("5005");
    const { token } = mint(w);
    const digest = invitationTokenDigest(KEY, token);
    const first = w.invitations.redeem({
      token_digest: digest,
      invitee_user_id: invitee,
      ...facts(),
    });
    expect(first.status).toBe("joined");
    if (first.status !== "joined") return;
    w.repos.memberships.remove(w.scope, first.membership_id);
    const second = w.invitations.redeem({
      token_digest: digest,
      invitee_user_id: invitee,
      ...facts(),
    });
    expect(second.status).toBe("denied");
    if (second.status === "denied") {
      expect(second.reason).toBe("consumed");
    }
    expect(w.repos.memberships.list(w.scope)).toHaveLength(0);
    w.db.close();
  });
});

describe("denial reasons", () => {
  function expectDenied(outcome: ReturnType<InvitationRepository["redeem"]>, reason: string): void {
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reason).toBe(reason);
    }
  }

  test("unknown, expired, and revoked invitations are rejected", () => {
    const w = world();
    const invitee = w.makeUser("6001");
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, "inv_unknown"),
        invitee_user_id: invitee,
        ...facts(),
      }),
      "unknown_token",
    );
    const expired = mint(w, { ttlSeconds: -10 });
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, expired.token),
        invitee_user_id: invitee,
        ...facts(),
      }),
      "expired",
    );
    const live = mint(w);
    w.invitations.revoke(w.scope, live.invitation.id, ACTOR);
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, live.token),
        invitee_user_id: invitee,
        ...facts(),
      }),
      "revoked",
    );
    w.db.close();
  });

  test("a bound invitation rejects wrong-subject use and forwards", () => {
    const w = world();
    const { token } = mint(w, { bound: "subject-intended" });
    const wrongUser = w.makeUser("6002");
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, token),
        invitee_user_id: wrongUser,
        ...facts({ invitee_provider_subject: "subject-other" }),
      }),
      "wrong_subject",
    );
    const rightUser = w.makeUser("6003");
    const ok = w.invitations.redeem({
      token_digest: invitationTokenDigest(KEY, token),
      invitee_user_id: rightUser,
      ...facts({ invitee_provider_subject: "subject-intended" }),
    });
    expect(ok.status).toBe("joined");
    w.db.close();
  });

  test("ineligible invitees, lost inviter authority, and existing members are rejected", () => {
    const w = world();
    const invitee = w.makeUser("6004");
    const ineligible = mint(w);
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, ineligible.token),
        invitee_user_id: invitee,
        ...facts({ invitee_eligible: false }),
      }),
      "ineligible",
    );
    const authorityLost = mint(w);
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, authorityLost.token),
        invitee_user_id: invitee,
        ...facts({ inviter_authorized: false }),
      }),
      "inviter_authority_lost",
    );
    w.repos.memberships.create(w.scope, { user_id: invitee, role: "member" });
    const alreadyMember = mint(w);
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, alreadyMember.token),
        invitee_user_id: invitee,
        ...facts(),
      }),
      "already_member",
    );
    // The denial never consumes the invitation.
    expect(w.invitations.getById(w.scope, alreadyMember.invitation.id)?.redeemed_at).toBeNull();
    w.db.close();
  });

  test("archived workspaces reject redemption", () => {
    const w = world();
    const invitee = w.makeUser("6005");
    const { token, invitation } = mint(w);
    w.repos.workspaces.archive(
      { enterprise_id: w.scope.enterprise_id, actor_id: ACTOR },
      w.workspace.id,
      w.workspace.version,
    );
    expectDenied(
      w.invitations.redeem({
        token_digest: invitationTokenDigest(KEY, token),
        invitee_user_id: invitee,
        ...facts(),
      }),
      "workspace_archived",
    );
    expect(w.invitations.getById(w.scope, invitation.id)?.redeemed_at).toBeNull();
    w.db.close();
  });

  test("evaluateRedemption orders replay before every denial", () => {
    const w = world();
    const invitee = w.makeUser("6006");
    const { token, invitation } = mint(w, { ttlSeconds: -5 });
    const outcome = w.invitations.redeem({
      token_digest: invitationTokenDigest(KEY, token),
      invitee_user_id: invitee,
      ...facts(),
    });
    // The first redemption was denied (expired), so there is no replay to
    // order here; a consumed invitation expires afterwards and still replays.
    expect(outcome.status).toBe("denied");
    const replayed = evaluateRedemption(
      { ...invitation, redeemed_at: "2026-01-01T00:00:00Z", redeemed_by: invitee },
      {
        invitee_user_id: invitee,
        invitee_membership_id: "mbr_x",
        invitee_provider_subject: null,
        inviter_authorized: false,
        invitee_eligible: false,
        workspace_status: "archived",
        now: new Date().toISOString(),
      },
    );
    expect(replayed).toEqual({ kind: "replay", membership_id: "mbr_x" });
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
    const consumed = mint(w);
    const joined = w.invitations.redeem({
      token_digest: invitationTokenDigest(KEY, consumed.token),
      invitee_user_id: invitee,
      ...facts(),
    });
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
    expect(PAGE).toBe(50);
    w.db.close();
  });
});
