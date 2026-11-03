import { describe, expect, test, beforeEach } from "vitest";

import {
  ConflictError,
  NotFoundError,
  createIdentityRepositories,
  createRepositories,
  hashToken,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  secretEquals,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, IdentityRepositories } from "../src/control-plane/index.js";

let db: ControlPlaneDb;
let identity: IdentityRepositories;

const ACTOR = "usr_admin";
const SUBJECT_A = "424242";
const SUBJECT_B = "424243";

function bootstrap(): { enterpriseId: string; providerInstanceId: string } {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  return { enterpriseId: enterprise.id, providerInstanceId: provider.id };
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  identity = createIdentityRepositories(db);
});

describe("identity storage", () => {
  test("account matching is only (provider instance, subject), never email or login", () => {
    const { providerInstanceId } = bootstrap();
    const userA = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const userB = identity.users.create({ display_name: "B", actor_id: ACTOR });
    // Two provider subjects that share a login/email stay two users.
    const first = identity.identities.create({
      user_id: userA.id,
      provider_instance_id: providerInstanceId,
      subject: SUBJECT_A,
      login: "twin",
      actor_id: ACTOR,
    });
    const second = identity.identities.create({
      user_id: userB.id,
      provider_instance_id: providerInstanceId,
      subject: SUBJECT_B,
      login: "twin",
      actor_id: ACTOR,
    });
    expect(first.user_id).not.toBe(second.user_id);
    expect(identity.identities.getByProviderSubject(providerInstanceId, SUBJECT_A)?.user_id).toBe(
      userA.id,
    );
    expect(identity.identities.getByProviderSubject(providerInstanceId, SUBJECT_B)?.user_id).toBe(
      userB.id,
    );
  });

  test("the same subject cannot be bound twice to different users", () => {
    const { providerInstanceId } = bootstrap();
    const userA = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const userB = identity.users.create({ display_name: "B", actor_id: ACTOR });
    identity.identities.create({
      user_id: userA.id,
      provider_instance_id: providerInstanceId,
      subject: SUBJECT_A,
      login: "a",
      actor_id: ACTOR,
    });
    expect(() =>
      identity.identities.create({
        user_id: userB.id,
        provider_instance_id: providerInstanceId,
        subject: SUBJECT_A,
        login: "a-renamed",
        actor_id: ACTOR,
      }),
    ).toThrow(ConflictError);
  });

  test("the same subject on a different provider instance is a distinct identity", () => {
    const { enterpriseId, providerInstanceId } = bootstrap();
    const repos = createRepositories(db);
    const other = repos.providerInstances.create(
      { enterprise_id: enterpriseId, actor_id: ACTOR },
      { provider_type: "gitlab", origin_url: "https://gitlab.com" },
    );
    const user = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const github = identity.identities.create({
      user_id: user.id,
      provider_instance_id: providerInstanceId,
      subject: SUBJECT_A,
      login: "a",
      actor_id: ACTOR,
    });
    const gitlab = identity.identities.create({
      user_id: user.id,
      provider_instance_id: other.id,
      subject: SUBJECT_A,
      login: "a",
      actor_id: ACTOR,
    });
    expect(github.id).not.toBe(gitlab.id);
  });
});

describe("session storage", () => {
  test("sessions are found by token digest and revoked single-shot", () => {
    bootstrap();
    const user = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const token = "raw-session-token";
    const session = identity.sessions.create({
      user_id: user.id,
      kind: "web",
      token_hash: hashToken(token),
      csrf_token: "csrf-value",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(identity.sessions.findByTokenHash(hashToken(token))?.id).toBe(session.id);
    const revoked = identity.sessions.revoke(session.id, "logout");
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.revoked_reason).toBe("logout");
  });

  test("suspension revokes every live session of the user", () => {
    const user = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const mk = (hash: string) =>
      identity.sessions.create({
        user_id: user.id,
        kind: "web",
        token_hash: hash,
        csrf_token: "c",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    const one = mk("hash-1");
    const two = mk("hash-2");
    const already = mk("hash-3");
    identity.sessions.revoke(already.id, "logout");
    expect(identity.sessions.revokeAllForUser(user.id, "user.suspended")).toBe(2);
    expect(identity.sessions.getById(one.id)?.revoked_reason).toBe("user.suspended");
    expect(identity.sessions.getById(two.id)?.revoked_reason).toBe("user.suspended");
    expect(identity.sessions.getById(already.id)?.revoked_reason).toBe("logout");
  });
});

describe("single-use flows", () => {
  test("an OAuth flow consumes exactly once", () => {
    const { providerInstanceId } = bootstrap();
    const flow = identity.oauthFlows.create({
      kind: "web",
      provider_instance_id: providerInstanceId,
      state_hash: "state-hash",
      binding_hash: "binding-hash",
      pkce_verifier: "verifier",
      redirect_uri: "http://127.0.0.1:1234/api/v1/auth/callback",
      return_to: "/",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(identity.oauthFlows.consume(flow.id)).toBe(true);
    // A replayed callback loses the consume race.
    expect(identity.oauthFlows.consume(flow.id)).toBe(false);
    expect(identity.oauthFlows.findByStateHash("state-hash")?.consumed_at).not.toBeNull();
  });

  test("a desktop flow delivers to exactly one exchange", () => {
    const user = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const flow = identity.desktopFlows.create({
      secret_hash: hashToken("desktop-secret"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    // Not ready before the browser login completes.
    expect(identity.desktopFlows.consume(flow.id)).toBe(false);
    identity.desktopFlows.markReady(flow.id, user.id);
    expect(identity.desktopFlows.consume(flow.id)).toBe(true);
    expect(identity.desktopFlows.consume(flow.id)).toBe(false);
    expect(identity.desktopFlows.getById(flow.id)?.status).toBe("consumed");
  });

  test("a consumed desktop flow cannot be re-bound", () => {
    const userA = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const userB = identity.users.create({ display_name: "B", actor_id: ACTOR });
    const flow = identity.desktopFlows.create({
      secret_hash: hashToken("desktop-secret"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    identity.desktopFlows.markReady(flow.id, userA.id);
    identity.desktopFlows.consume(flow.id);
    expect(() => identity.desktopFlows.markReady(flow.id, userB.id)).toThrow(ConflictError);
  });

  test("failed exchange attempts are counted", () => {
    const flow = identity.desktopFlows.create({
      secret_hash: hashToken("desktop-secret"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(identity.desktopFlows.recordFailedAttempt(flow.id)).toBe(1);
    expect(identity.desktopFlows.recordFailedAttempt(flow.id)).toBe(2);
  });
});

describe("enterprise roles", () => {
  test("grant is idempotent, revoke is single-shot", () => {
    const { enterpriseId } = bootstrap();
    const user = identity.users.create({ display_name: "A", actor_id: ACTOR });
    const role = identity.enterpriseRoles.grant({
      enterprise_id: enterpriseId,
      user_id: user.id,
      role: "admin",
      actor_id: ACTOR,
    });
    expect(
      identity.enterpriseRoles.grant({
        enterprise_id: enterpriseId,
        user_id: user.id,
        role: "admin",
        actor_id: ACTOR,
      }).id,
    ).toBe(role.id);
    identity.enterpriseRoles.revoke(enterpriseId, user.id);
    expect(() => identity.enterpriseRoles.revoke(enterpriseId, user.id)).toThrow(NotFoundError);
    expect(identity.enterpriseRoles.getByUser(enterpriseId, user.id)).toBeUndefined();
  });
});

describe("auth audit", () => {
  test("records secret-free details and filters by enterprise", () => {
    const { enterpriseId, providerInstanceId } = bootstrap();
    const record = identity.authAudit.append({
      event: "admin.bootstrap",
      enterprise_id: enterpriseId,
      actor_kind: "deployment",
      provider_instance_id: providerInstanceId,
      details: { subject: SUBJECT_A },
    });
    expect(record.event).toBe("admin.bootstrap");
    expect(record.details).toEqual({ subject: SUBJECT_A });
    expect(identity.authAudit.list({ enterprise_id: enterpriseId })).toHaveLength(1);
    expect(identity.authAudit.list({ enterprise_id: "ent_other" })).toHaveLength(0);
    expect(identity.authAudit.list({ event: "admin.bootstrap" })).toHaveLength(1);
    expect(identity.authAudit.list({ event: "session.revoked" })).toHaveLength(0);
  });
});

describe("digest helpers", () => {
  test("secretEquals compares digests without leaking length", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
  });
});
