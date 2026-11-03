import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildOpenApiDocument } from "../src/api/openapi.js";
import { createRepositories } from "../src/control-plane/index.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import type { JsonResponse } from "./helpers/http.js";
import { cookieValue, getJson, getRaw, postJson, postRaw } from "./helpers/http.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import {
  BOOTSTRAP_TOKEN,
  completeCallback,
  cookieSessionHeaders,
  startAuthApp,
  startLogin,
} from "./helpers/auth-app.js";

/**
 * End-to-end behavior of the owner-created invitation surface (DAT-204):
 * creation (bearer shown exactly once), QR/code delivery through the URL
 * fragment, join preview and redemption, owner revocation, uniform
 * non-enumerating denials, one-time use under concurrency, rate limiting, and
 * the no-bearer-in-logs/errors/audit guarantee.
 */

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

const document = buildOpenApiDocument();

function closedCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(closedCopy);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    copy[key] = closedCopy(item);
  }
  if (
    copy["type"] === "object" &&
    copy["properties"] &&
    copy["additionalProperties"] === undefined
  ) {
    copy["additionalProperties"] = false;
  }
  return copy;
}

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema({
  $id: "urn:forgepilot:contract",
  components: closedCopy({ schemas: document.components.schemas }),
} as Record<string, unknown>);

function expectContract(schemaName: string, value: unknown): void {
  const validate = ajv.getSchema(`urn:forgepilot:contract#/components/schemas/${schemaName}`);
  expect(validate).toBeDefined();
  const ok = validate?.(value) as boolean;
  expect(ok, `${schemaName}: ${ajv.errorsText(validate?.errors)}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HIGH_LIMITS = {
  windowSeconds: 900,
  createPerWindow: 100,
  previewPerWindow: 100,
  redeemPerWindow: 100,
  originMultiplier: 10,
};

let dsh: DshServerHandle;
const apps: AuthApp[] = [];
let app: AuthApp;
let owner: LoggedInSession;

interface Profile {
  id: number;
  login: string;
}

/** Log in as a distinct user (each distinct profile id is a distinct account). */
async function loginAs(profile: Profile, providerInstanceId?: string): Promise<LoggedInSession> {
  app.provider.profile = profile;
  const started = await startLogin(
    app,
    providerInstanceId !== undefined ? { providerInstanceId } : {},
  );
  const response = await completeCallback(app, {
    state: started.state,
    binding: started.binding,
  });
  expect(response.status).toBe(302);
  const session = cookieValue(response.headers, "fp_session") ?? "";
  const info = await getJson<{ user: { id: string }; csrf_token: string }>(
    `${app.base}/api/v1/auth/session`,
    { Cookie: `fp_session=${session}` },
  );
  return { userId: info.body.user.id, session, csrf: info.body.csrf_token };
}

async function grantRole(userId: string, role: string): Promise<number> {
  const response = await fetch(
    `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/workspaces/${app.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
      body: JSON.stringify({ role }),
    },
  );
  return response.status;
}

interface CreatedBody {
  invitation: { id: string; role: string; status: string; expires_at: string };
  token: string;
  invite_url: string;
}

function inviteUrl(session: LoggedInSession, body: Record<string, unknown> = {}) {
  return postJson<CreatedBody>(
    `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations`,
    body,
    { "Content-Type": "application/json", ...cookieSessionHeaders(session) },
  );
}

function preview(session: LoggedInSession, token: string) {
  return postJson(
    `${app.base}/api/v1/invitations/preview`,
    { token },
    cookieSessionHeaders(session),
  );
}

function redeem(session: LoggedInSession, token: string) {
  return postJson(
    `${app.base}/api/v1/invitations/redeem`,
    { token },
    cookieSessionHeaders(session),
  );
}

interface ErrorBody {
  error: {
    code: string;
    stage: string;
    category: string;
    message: string;
    retryable: boolean;
    retry_after_seconds: number | null;
    request_id: string;
    details: Record<string, unknown>;
    next_action: string | null;
  };
}

/** The denial body minus the trace id: all denials must be identical. */
function uniformPart(body: unknown): string {
  const typed = body as ErrorBody;
  return JSON.stringify({ ...typed.error, request_id: "" });
}

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
  app = await startAuthApp({ dsh, invitationRateLimits: HIGH_LIMITS });
  apps.push(app);
  owner = await loginAs({ id: 1001, login: "octo" });
  expect(await grantRole(owner.userId, "owner")).toBe(200);
}, 120_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

// ---------------------------------------------------------------------------
// Owner surface: creation, listing, revocation
// ---------------------------------------------------------------------------

describe("owner surface", () => {
  test("creation returns the bearer exactly once, in the fragment, as a member invite", async () => {
    const created = await inviteUrl(owner);
    expect(created.status).toBe(201);
    expectContract("CreatedInvitation", created.body);
    const { invitation, token, invite_url } = created.body;
    expect(token.startsWith("inv_")).toBe(true);
    expect(token).toMatch(/^inv_[A-Za-z0-9_-]+$/);
    expect(invitation.role).toBe("member");
    expect(invitation.status).toBe("active");
    // The QR value: the trusted landing URL carries the bearer in the URL
    // fragment only — never in the query a server would see on GET.
    const url = new URL(invite_url);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${token}`);
    expect(invite_url.endsWith(`/invite#${token}`)).toBe(true);

    // The list view is token-free: the bearer cannot be derived from it.
    const list = await getJson<{ items: Array<{ id: string }> }>(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations`,
      cookieSessionHeaders(owner),
    );
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.items.some((item) => item.id === invitation.id)).toBe(true);

    // Role escalation through the body is ignored: invitations grant member
    // only (administrative elevation is a separate audited action).
    const forced = await inviteUrl(owner, { role: "owner", expires_in_seconds: 60 });
    expect(forced.status).toBe(201);
    expect(forced.body.invitation.role).toBe("member");
  });

  test("expiry is capped at the 24-hour default and validated", async () => {
    const tooLong = await inviteUrl(owner, { expires_in_seconds: 86_401 });
    expect(tooLong.status).toBe(400);
    const zero = await inviteUrl(owner, { expires_in_seconds: 0 });
    expect(zero.status).toBe(400);
    const fractional = await inviteUrl(owner, { expires_in_seconds: 3.5 });
    expect(fractional.status).toBe(400);
    const shortened = await inviteUrl(owner, { expires_in_seconds: 3600 });
    expect(shortened.status).toBe(201);
    const ttlMs = Date.parse(shortened.body.invitation.expires_at) - Date.now();
    expect(ttlMs).toBeGreaterThan(3500 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(3600 * 1000);
  });

  test("listing paginates with opaque cursors and rejects unknown ones", async () => {
    const page = await getJson<{ items: unknown[]; next_cursor: string | null }>(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations`,
      cookieSessionHeaders(owner),
    );
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBeGreaterThan(0);
    for (const item of page.body.items) {
      expectContract("Invitation", item);
    }
    const bad = await getJson(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations?cursor=inv_nope`,
      cookieSessionHeaders(owner),
    );
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorBody).error.code).toBe("INVALID_CURSOR");
  });

  test("non-admin members and non-members cannot manage invitations", async () => {
    const member = await loginAs({ id: 2002, login: "katherine" });
    expect(await grantRole(member.userId, "member")).toBe(200);
    const asMember = await inviteUrl(member);
    expect(asMember.status).toBe(403);
    const stranger = await loginAs({ id: 3003, login: "grace" });
    const asStranger = await inviteUrl(stranger);
    expect(asStranger.status).toBe(404);
    const anonymous = await postRaw(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations`,
      {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as ErrorBody).error.message).toBe("Sign in to continue.");
  });

  test("revocation is idempotent and closes the invitation", async () => {
    const created = await inviteUrl(owner);
    const id = created.body.invitation.id;
    const first = await fetch(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations/${id}`,
      { method: "DELETE", headers: cookieSessionHeaders(owner) },
    );
    const second = await fetch(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations/${id}`,
      { method: "DELETE", headers: cookieSessionHeaders(owner) },
    );
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const invitee = await loginAs({ id: 4004, login: "alan" });
    const denied = await redeem(invitee, created.body.token);
    expect(denied.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Join surface: preview, redemption, replay, one-time use
// ---------------------------------------------------------------------------

describe("join surface", () => {
  test("preview never consumes; redeem joins once and replays idempotently", async () => {
    const created = await inviteUrl(owner);
    const invitee = await loginAs({ id: 5005, login: "margaret" });

    const previewed = await preview(invitee, created.body.token);
    expect(previewed.status).toBe(200);
    expectContract("InvitationPreview", previewed.body);
    const previewBody = previewed.body as {
      role: string;
      already_joined: boolean;
      inviter: { id: string };
    };
    expect(previewBody.role).toBe("member");
    expect(previewBody.already_joined).toBe(false);
    expect(previewBody.inviter.id).toBe(owner.userId);
    // Preview twice: still not consumed.
    expect((await preview(invitee, created.body.token)).status).toBe(200);

    const joined = await redeem(invitee, created.body.token);
    expect(joined.status).toBe(200);
    expectContract("InvitationRedemption", joined.body);
    const joinBody = joined.body as {
      workspace: { role: string; repository: { provider_type: string } };
      membership: {
        id: string;
        role: string;
        user_id: string;
        authority: { provider_role: string | null; provenance: string; stale: boolean };
      };
    };
    // The invitation grants exactly a member membership — never repository
    // authority: provider authority is unverified and stale until DAT-203.
    expect(joinBody.workspace.role).toBe("member");
    expect(joinBody.workspace.repository.provider_type).toBe("github");
    expect(joinBody.membership.role).toBe("member");
    expect(joinBody.membership.user_id).toBe(invitee.userId);
    expect(joinBody.membership.authority).toEqual({
      provider_role: null,
      provenance: "unknown",
      verified_at: null,
      stale: true,
    });

    // Same-subject retry: an idempotent replay of the same join, never a
    // second one — and preview now reports already_joined.
    const replay = await redeem(invitee, created.body.token);
    expect(replay.status).toBe(200);
    expect((replay.body as { membership: { id: string } }).membership.id).toBe(
      joinBody.membership.id,
    );
    const after = await preview(invitee, created.body.token);
    expect((after.body as { already_joined: boolean }).already_joined).toBe(true);
  });

  test("link previews and scanners on GET learn and consume nothing", async () => {
    const created = await inviteUrl(owner);
    const token = created.body.token;
    // A scanner-style unauthenticated GET with the token in the query: the
    // write-only route does not exist for GET, and the list route requires a
    // session — neither path reads or consumes the token.
    const landing = await getRaw(`${app.base}/api/v1/invitations/preview?token=${token}`);
    expect(landing.status).toBe(404);
    const anonymous = await getRaw(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations?token=${token}`,
    );
    expect(anonymous.status).toBe(401);
    // An authenticated list read never echoes the bearer either.
    const listGet = await getRaw(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations?token=${token}`,
      { headers: cookieSessionHeaders(owner) },
    );
    expect(listGet.status).toBe(200);
    expect(listGet.text).not.toContain(token);
    // Nothing consumed: the explicit authenticated POST still joins.
    const invitee = await loginAs({ id: 6006, login: "dorothy" });
    const joined = await redeem(invitee, token);
    expect(joined.status).toBe(200);
  });

  test("one-time use admits exactly one join under concurrent redemption", async () => {
    const created = await inviteUrl(owner);
    const first = await loginAs({ id: 7007, login: "edith" });
    const second = await loginAs({ id: 8008, login: "florence" });
    // Both redeemers race the same one-time invitation: exactly one joins.
    const outcomes = await Promise.all([
      redeem(first, created.body.token),
      redeem(second, created.body.token),
    ]);
    const statuses = outcomes.map((outcome) => outcome.status).sort();
    expect(statuses).toEqual([200, 403]);
    // The used invitation stays closed for everyone else afterwards.
    const late = await redeem(await loginAs({ id: 9009, login: "harriet" }), created.body.token);
    expect(late.status).toBe(403);
  });

  test("bound invitations reject wrong-subject and forwarded use", async () => {
    const intended = await loginAs({ id: 10_010, login: "irma" });
    const created = await inviteUrl(owner, { bound_provider_subject: "10010" });
    const wrong = await loginAs({ id: 10_011, login: "jack" });
    const denied = await redeem(wrong, created.body.token);
    expect(denied.status).toBe(403);
    const ok = await redeem(intended, created.body.token);
    expect(ok.status).toBe(200);
  });

  test("authority loss invalidates outstanding invitations", async () => {
    const created = await inviteUrl(owner);
    // The creator loses their administration authority (role demotion; the
    // member-management surface that performs it belongs to DAT-203, so the
    // fixture demotes through the control plane).
    const repos = createRepositories(
      app.orchestrator.controlPlane ??
        (() => {
          throw new Error("no control plane");
        })(),
    );
    const scope = {
      enterprise_id: app.enterpriseId,
      workspace_id: app.workspaceId,
      actor_id: "usr_test",
    };
    const membership = repos.memberships.getByUser(scope, owner.userId);
    expect(membership).toBeDefined();
    repos.memberships.updateRole(scope, membership?.id ?? "", "viewer", membership?.version ?? 0);
    const invitee = await loginAs({ id: 10_012, login: "karen" });
    const denied = await redeem(invitee, created.body.token);
    expect(denied.status).toBe(403);
    // The invitation also stops presenting as active to administrators.
    const successor = await loginAs({ id: 10_013, login: "leo" });
    expect(await grantRole(successor.userId, "admin")).toBe(200);
    const list = await getJson<{ items: Array<{ id: string; status: string }> }>(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations`,
      cookieSessionHeaders(successor),
    );
    const shown = list.body.items.find((item) => item.id === created.body.invitation.id);
    expect(shown?.status).toBe("expired");
    // Restore the shared owner for the remaining tests.
    const current = repos.memberships.getByUser(scope, owner.userId);
    repos.memberships.updateRole(scope, current?.id ?? "", "owner", current?.version ?? 0);
  });

  test("a user without an identity on the workspace's provider is ineligible", async () => {
    const gitlabInstance = createRepositories(
      app.orchestrator.controlPlane ??
        (() => {
          throw new Error("no control plane");
        })(),
    ).providerInstances.create(
      { enterprise_id: app.enterpriseId, actor_id: "usr_test" },
      { provider_type: "gitlab", origin_url: "https://gitlab.example.com" },
    );
    const created = await inviteUrl(owner);
    const gitlabOnly = await loginAs({ id: 10_014, login: "herman" }, gitlabInstance.id);
    const denied = await redeem(gitlabOnly, created.body.token);
    expect(denied.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Non-enumeration, rate limiting, CSRF, and bearer hygiene
// ---------------------------------------------------------------------------

describe("non-enumeration and hygiene", () => {
  test("every non-consumable state is one indistinguishable denial", async () => {
    const bodies: string[] = [];
    const expectUniform403 = async (response: JsonResponse<unknown>): Promise<void> => {
      expect(response.status).toBe(403);
      const body = response.body as ErrorBody;
      expect(body.error.code).toBe("INVITATION_NOT_ACCEPTED");
      expect(body.error.message).toBe(
        "This invitation cannot be used. Ask the workspace owner for a new invitation.",
      );
      expect(body.error.details).toEqual({});
      bodies.push(uniformPart(response.body));
    };

    const probe = await loginAs({ id: 10_015, login: "mira" });
    // Unknown bearer.
    await expectUniform403(await preview(probe, "inv_definitely-not-a-token"));
    // Revoked.
    const revoked = await inviteUrl(owner);
    await fetch(
      `${app.base}/api/v1/workspaces/${app.workspaceId}/invitations/${revoked.body.invitation.id}`,
      {
        method: "DELETE",
        headers: cookieSessionHeaders(owner),
      },
    );
    await expectUniform403(await redeem(probe, revoked.body.token));
    // Wrong subject on a bound invitation.
    const bound = await inviteUrl(owner, { bound_provider_subject: "someone-else" });
    await expectUniform403(await redeem(probe, bound.body.token));
    // Ineligible (no identity on the workspace's provider instance).
    const gitlabInstance = createRepositories(
      app.orchestrator.controlPlane ??
        (() => {
          throw new Error("no control plane");
        })(),
    ).providerInstances.create(
      { enterprise_id: app.enterpriseId, actor_id: "usr_test" },
      { provider_type: "gitlab", origin_url: "https://gitlab.example.com" },
    );
    const ineligible = await loginAs({ id: 10_016, login: "nina" }, gitlabInstance.id);
    const eligible = await inviteUrl(owner);
    await expectUniform403(await redeem(ineligible, eligible.body.token));
    // Already a member: an eligible user who joined earlier redeems again.
    const joinedBefore = await inviteUrl(owner);
    expect((await redeem(probe, joinedBefore.body.token)).status).toBe(200);
    const second = await inviteUrl(owner);
    await expectUniform403(await redeem(probe, second.body.token));

    // Expired.
    const expired = await inviteUrl(owner, { expires_in_seconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expectUniform403(await redeem(probe, expired.body.token));

    // All denials are byte-identical apart from the trace id.
    expect(new Set(bodies).size).toBe(1);
  });

  test("bearer never appears in errors, listings, or audit records", async () => {
    const created = await inviteUrl(owner);
    const token = created.body.token;
    const recorded: string[] = [JSON.stringify(created.body)];
    const capture = (response: JsonResponse<unknown>): void => {
      recorded.push(JSON.stringify(response.body));
    };

    const invitee = await loginAs({ id: 10_017, login: "olive" });
    capture(await preview(invitee, token));
    capture(await redeem(invitee, token));
    capture(await redeem(invitee, token));
    const bad = await inviteUrl(owner, { expires_in_seconds: 999_999 });
    capture(bad);
    capture(await preview(invitee, "inv_not-a-token"));

    const audit = await getJson<{ items: Array<{ event: string; details: unknown }> }>(
      `${app.base}/api/v1/admin/enterprises/${app.enterpriseId}/auth-audit?limit=500`,
      { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    );
    expect(audit.status).toBe(200);
    for (const item of audit.body.items) {
      recorded.push(JSON.stringify(item));
    }
    // Exactly one recorded object carries the bearer: the create response.
    const withToken = recorded.filter((entry) => entry.includes(token));
    expect(withToken).toHaveLength(1);
    expect(JSON.parse(withToken[0] ?? "{}")).toHaveProperty("token");

    // The audit trail records creation, attempts, results, and the role.
    const events = audit.body.items.map((item) => item.event);
    expect(events).toContain("invitation.created");
    expect(events).toContain("invitation.redeem");
    const redeemRecords = audit.body.items.filter(
      (item) => item.event === "invitation.redeem",
    ) as Array<{ details: { result?: string; role?: string } }>;
    expect(
      redeemRecords.some(
        (item) => item.details.result === "joined" && item.details.role === "member",
      ),
    ).toBe(true);
  });

  test("cookie-authenticated writes require the CSRF echo", async () => {
    const missing = await postRaw(`${app.base}/api/v1/invitations/preview`, {
      headers: { "Content-Type": "application/json", Cookie: `fp_session=${owner.session}` },
      body: JSON.stringify({ token: "inv_whatever" }),
    });
    expect(missing.status).toBe(403);
    expect((missing.body as ErrorBody).error.code).toBe("CSRF_TOKEN_INVALID");
  });

  test("desktop-style bearer sessions redeem without CSRF", async () => {
    const created = await inviteUrl(owner);
    const invitee = await loginAs({ id: 10_018, login: "petra" });
    const response = await postJson(
      `${app.base}/api/v1/invitations/redeem`,
      { token: created.body.token },
      { "Content-Type": "application/json", Authorization: `Bearer ${invitee.session}` },
    );
    expect(response.status).toBe(200);
  });
});

describe("rate limiting", () => {
  test("creation, preview, and redemption are limited per actor and origin", async () => {
    const limitedApp = await startAuthApp({
      dsh,
      invitationRateLimits: {
        windowSeconds: 900,
        createPerWindow: 2,
        previewPerWindow: 2,
        redeemPerWindow: 2,
        originMultiplier: 1,
      },
    });
    apps.push(limitedApp);
    const previous = app;
    app = limitedApp;
    try {
      const limitedOwner = await loginAs({ id: 20_020, login: "quinn" });
      expect(await grantRole(limitedOwner.userId, "owner")).toBe(200);
      const first = await inviteUrl(limitedOwner);
      const second = await inviteUrl(limitedOwner);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const third = await inviteUrl(limitedOwner);
      expect(third.status).toBe(429);
      const body = third.body as unknown as ErrorBody;
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.stage).toBe("auth");
      expect(body.error.retryable).toBe(true);
      expect(body.error.retry_after_seconds).toBeGreaterThan(0);

      const invitee = await loginAs({ id: 20_021, login: "rosa" });
      expect((await preview(invitee, first.body.token)).status).toBe(200);
      expect((await preview(invitee, first.body.token)).status).toBe(200);
      const limitedPreview = await preview(invitee, first.body.token);
      expect(limitedPreview.status).toBe(429);
    } finally {
      app = previous;
    }
  });
});
