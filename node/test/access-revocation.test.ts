import { beforeEach, describe, expect, test } from "vitest";

import { AccessDeniedError, revokeAuthority } from "../src/provider-access/index.js";
import { ACTION_KINDS, type ActionKind } from "../src/provider-access/types.js";
import {
  NOW,
  addMember,
  setupFixture,
  verifyAuthority,
  type Fixture,
} from "./helpers/provider-access.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = setupFixture();
});

describe("request-path authorization", () => {
  test("a verified member can read; writes need a live delivery grant", () => {
    const { userId } = addMember(fixture, { subject: "4242", login: "alice", role: "member" });
    verifyAuthority(fixture, "4242", userId, NOW);

    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);

    const write = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "write",
    });
    expect(write.allowed).toBe(false);
    expect(write.reason).toBe("capability_grant");

    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      branch_scope: "main",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });
    fixture.epoch.bump();
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "write" }).allowed,
    ).toBe(true);
  });

  test("login without provider identity grants nothing", () => {
    const user = fixture.identity.users.create({
      display_name: "no-identity",
      actor_id: "usr_operator",
    });
    // A workspace membership exists — but without a provider identity there
    // is no repository authority: login alone never grants repository access.
    fixture.memberships.create(fixture.scope, { user_id: user.id, role: "admin" });
    const decision = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: user.id,
      action: "read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("authority_unknown");
    expect(decision.requires_reconciliation).toBe(true);
  });

  test("a suspended user is denied immediately", () => {
    const { userId } = addMember(fixture, {
      subject: "4243",
      login: "bob",
      role: "admin",
      user_status: "suspended",
    });
    verifyAuthority(fixture, "4243", userId, NOW);
    const decision = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("user_suspended");
  });

  test("workspace role minimums apply per action", () => {
    const { userId } = addMember(fixture, { subject: "4244", login: "viewer", role: "viewer" });
    verifyAuthority(fixture, "4244", userId, NOW);
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);
    const approval = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "approval",
    });
    expect(approval.allowed).toBe(false);
    expect(approval.reason).toBe("workspace_role");
  });
});

describe("revocation stops the request path", () => {
  test("revocation denies read/stream/artifact/approval/write and revokes grants", () => {
    const { userId } = addMember(fixture, { subject: "5001", login: "carol", role: "admin" });
    verifyAuthority(fixture, "5001", userId, NOW);
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "checkout_read",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });
    fixture.epoch.bump();

    // Exercise every action class first — exactly what a busy service does.
    for (const action of ACTION_KINDS) {
      expect(
        fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action }).allowed,
      ).toBe(true);
    }

    const effects = fixture.gate.revoke(
      fixture.scope,
      { integration_id: fixture.integration.id, subject: "5001", user_id: userId },
      "member removed at provider",
      "2026-11-03T12:30:00.000Z",
    );

    expect(effects.stopped_actions).toEqual([...ACTION_KINDS]);
    expect(effects.authority_state).toBe("removed");
    expect(effects.revoked_grants).toHaveLength(2);

    // Same gate instance — every action class now denies.
    for (const action of ACTION_KINDS) {
      const decision = fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("repository_access");
    }

    // Capability grants are gone from the store too.
    const live = fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      now: "2026-11-03T12:31:00.000Z",
    });
    expect(live).toHaveLength(0);
  });

  test("revocation mid-request denies every later step", () => {
    const { userId } = addMember(fixture, { subject: "5002", login: "dave", role: "admin" });
    verifyAuthority(fixture, "5002", userId, NOW);

    // One request performing several steps: read → stream → artifact →
    // approval → write. Revocation lands between two steps.
    const steps: ActionKind[] = ["read", "stream", "artifact_read", "approval", "write"];
    const outcomes: boolean[] = [];
    for (const [index, action] of steps.entries()) {
      if (index === 2) {
        revokeAuthority(
          fixture.access,
          fixture.epoch,
          fixture.scope,
          { integration_id: fixture.integration.id, subject: "5002", user_id: userId },
          "authority lost mid-request",
          "2026-11-03T12:20:00.000Z",
        );
      }
      outcomes.push(
        fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action }).allowed,
      );
    }
    expect(outcomes).toEqual([true, true, false, false, false]);
  });

  test("re-revocation is idempotent", () => {
    const { userId } = addMember(fixture, { subject: "5003", login: "eve", role: "member" });
    verifyAuthority(fixture, "5003", userId, NOW);
    const target = { integration_id: fixture.integration.id, subject: "5003", user_id: userId };
    fixture.gate.revoke(fixture.scope, target, "first", NOW);
    const again = fixture.gate.revoke(fixture.scope, target, "second", NOW);
    expect(again.revoked_grants).toHaveLength(0);
    expect(again.authority_state).toBe("removed");
  });

  test("revoke via the shared path (reconcile style) denies immediately", () => {
    const { userId } = addMember(fixture, { subject: "5004", login: "frank", role: "member" });
    verifyAuthority(fixture, "5004", userId, NOW);
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);

    // Revocation not going through the gate object must also take effect on
    // the very next check.
    revokeAuthority(
      fixture.access,
      fixture.epoch,
      fixture.scope,
      { integration_id: fixture.integration.id, subject: "5004", user_id: userId },
      "reconcile removal",
      NOW,
    );
    const decision = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("unknown and expired authority block sensitive actions", () => {
  test("unknown authority (e.g. after transfer) blocks and requires reconciliation", () => {
    const { userId } = addMember(fixture, { subject: "6001", login: "grace", role: "admin" });
    verifyAuthority(fixture, "6001", userId, NOW);
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });
    fixture.access.roster.resetAuthority(fixture.scope, fixture.integration.id, NOW);
    fixture.epoch.bump();

    for (const action of ["read", "approval", "write"] as const) {
      const decision = fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("authority_unknown");
      expect(decision.requires_reconciliation).toBe(true);
    }
  });

  test("expired verification blocks sensitive actions until reconciliation re-verifies", () => {
    const { userId } = addMember(fixture, { subject: "6002", login: "heidi", role: "admin" });
    verifyAuthority(fixture, "6002", userId, NOW);

    // Two hours pass without a successful reconciliation.
    fixture.clock.now = new Date("2026-11-03T14:00:00.000Z");
    fixture.epoch.bump();

    const approval = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "approval",
    });
    expect(approval.allowed).toBe(false);
    expect(approval.reason).toBe("verification_stale");
    expect(approval.requires_reconciliation).toBe(true);

    // Ordinary reads are unaffected.
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);

    // A successful verification restores sensitive actions.
    verifyAuthority(fixture, "6002", userId, fixture.clock.now.toISOString());
    fixture.epoch.bump();
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "approval" }).allowed,
    ).toBe(true);
  });

  test("assert throws a machine-readable denial", () => {
    const { userId } = addMember(fixture, { subject: "6003", login: "ivan", role: "viewer" });
    verifyAuthority(fixture, "6003", userId, NOW);
    expect(() =>
      fixture.gate.assert({ scope: fixture.scope, user_id: userId, action: "write" }),
    ).toThrow(AccessDeniedError);
    try {
      fixture.gate.assert({ scope: fixture.scope, user_id: userId, action: "approval" });
    } catch (error) {
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).code).toBe("FORBIDDEN");
      expect((error as AccessDeniedError).decision.reason).toBe("workspace_role");
    }
  });
});

// Regression (QA DAT-203 round 1): authorization decisions must expire with
// the evidence they were computed from. These tests deliberately change
// NOTHING except the clock — no revoke, no event, no epoch bump — so a
// decision cache that outlived its evidence would fail them.
describe("decisions expire with their evidence (no decision cache)", () => {
  test("an expired delivery grant denies the next write with no invalidation at all", () => {
    const { userId } = addMember(fixture, { subject: "9001", login: "judy", role: "member" });
    verifyAuthority(fixture, "9001", userId, NOW);
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      branch_scope: "main",
      expires_at: "2026-11-03T12:10:00.000Z",
      actor_id: "usr_operator",
    });

    fixture.clock.now = new Date("2026-11-03T12:00:00.000Z");
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "write" }).allowed,
    ).toBe(true);

    // Only the clock moves. The grant silently expired underneath a prior
    // allow: the next write must deny on the grant, not on some stale verdict.
    fixture.clock.now = new Date("2026-11-03T12:11:00.000Z");
    const expired = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "write",
    });
    expect(expired.allowed).toBe(false);
    expect(expired.reason).toBe("capability_grant");
  });

  test("verification freshness expires by itself: sensitive actions deny", () => {
    const { userId } = addMember(fixture, { subject: "9002", login: "karl", role: "admin" });
    verifyAuthority(fixture, "9002", userId, NOW);

    fixture.clock.now = new Date("2026-11-03T12:05:00.000Z");
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "approval" }).allowed,
    ).toBe(true);

    // Thirty minutes after verification the fresh window has passed — with
    // no state change and no invalidation signal of any kind.
    fixture.clock.now = new Date("2026-11-03T12:30:00.000Z");
    const stale = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "approval",
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toBe("verification_stale");
    expect(stale.requires_reconciliation).toBe(true);
    // Ordinary reads are unaffected by the freshness window.
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);
  });

  test("membership and role changes take effect on the very next check", () => {
    const { userId } = addMember(fixture, { subject: "9003", login: "lena", role: "viewer" });
    verifyAuthority(fixture, "9003", userId, NOW);
    fixture.clock.now = new Date("2026-11-03T12:00:00.000Z");

    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "approval" }).allowed,
    ).toBe(false);

    // Promote viewer -> admin; the next check reflects it immediately.
    const membership = fixture.memberships.getByUser(fixture.scope, userId);
    if (!membership) {
      throw new Error("membership missing");
    }
    fixture.memberships.updateRole(fixture.scope, membership.id, "admin", membership.version);
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "approval" }).allowed,
    ).toBe(true);

    // Remove the membership entirely; the next check denies just as fast.
    fixture.memberships.remove(fixture.scope, membership.id);
    const decision = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("workspace_role");
  });
});
