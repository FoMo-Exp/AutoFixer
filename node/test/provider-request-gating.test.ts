import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  cookieSessionHeaders,
  startAuthApp,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import {
  createProviderAccessRepositories,
  createIdentityRepositories,
} from "../src/control-plane/index.js";
import type {
  IdentityRepository,
  ProviderAccessRepositories,
  ServiceIntegration,
} from "../src/control-plane/index.js";
import type { WorkspaceScope } from "../src/control-plane/types.js";
import { applyProviderEvent, reconcileIntegration } from "../src/provider-access/reconcile.js";
import { revokeAuthority } from "../src/provider-access/revocation.js";
import { page, role, scriptedAdapter } from "./helpers/provider-access.js";
import type {
  ProviderEvent,
  ProviderEventType,
} from "../src/control-plane/provider-access-types.js";

/**
 * Request-path regression (QA DAT-203 round 2): the provider-authority gate
 * is enforced at the production request boundary. After provider revocation,
 * read / stream / artifact / approval / write requests are rejected with 403
 * — these tests drive real HTTP routes, not the gate helper.
 */

const REPOSITORY_ID = "github:Luthiel/AutoFixer";
const SUBJECT = "1001"; // fakeProvider profile id of the default login

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 120_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

async function app(): Promise<AuthApp> {
  const created = await startAuthApp({ dsh });
  apps.push(created);
  return created;
}

function operatorHeaders(authApp: AuthApp): Record<string, string> {
  return { Authorization: `Bearer ${authApp.orchestrator.apiToken}` };
}

async function grantMembership(authApp: AuthApp, userId: string, role: string): Promise<number> {
  const response = await fetch(
    `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({ role }),
    },
  );
  return response.status;
}

interface BoundaryFixture {
  access: ProviderAccessRepositories;
  identities: IdentityRepository;
  integration: ServiceIntegration;
  scope: WorkspaceScope;
}

/**
 * Install a repository-scoped service integration and verify the login's
 * provider subject — the state in which provider authority is enforced.
 */
function installIntegration(authApp: AuthApp, userId: string): BoundaryFixture {
  const db = authApp.orchestrator.controlPlane;
  if (!db) {
    throw new Error("control plane missing");
  }
  const access = createProviderAccessRepositories(db);
  const identities = createIdentityRepositories(db).identities;
  const identity = identities.getByProviderSubject(authApp.providerInstanceId, SUBJECT);
  if (!identity || identity.user_id !== userId) {
    throw new Error("login subject is not linked to the expected user");
  }
  const scope: WorkspaceScope = {
    enterprise_id: authApp.enterpriseId,
    workspace_id: authApp.workspaceId,
    actor_id: "usr_test_operator",
  };
  const integration = access.integrations.create(scope, {
    provider_instance_id: authApp.providerInstanceId,
    repository_id: REPOSITORY_ID,
    repository_name: "Luthiel/AutoFixer",
    source_credential_ref: "svc-source-1",
    checkout_credential_ref: "svc-checkout-1",
    delivery_credential_ref: "svc-delivery-1",
    permission_visibility: "full",
    actor_id: "usr_test_operator",
  });
  access.roster.applySnapshot(scope, integration.id, {
    roles: [
      {
        subject: SUBJECT,
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: "admin",
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
    subject_users: { [SUBJECT]: userId },
  });
  return { access, identities, integration, scope };
}

function providerEvent(
  authApp: AuthApp,
  fixture: BoundaryFixture,
  eventType: ProviderEventType,
  payload: Record<string, unknown>,
  deliveryId: string,
): ProviderEvent {
  return {
    id: "evt_in",
    enterprise_id: authApp.enterpriseId,
    provider_instance_id: authApp.providerInstanceId,
    integration_id: fixture.integration.id,
    repository_id: fixture.integration.repository_id,
    event_type: eventType,
    payload,
    delivery_id: deliveryId,
    received_at: new Date().toISOString(),
    processed_at: null,
  };
}

async function createTask(
  authApp: AuthApp,
  headers: Record<string, string>,
): Promise<{ status: number; taskId: string }> {
  const created = await postJson<{ id: string }>(
    `${authApp.base}/api/v1/tasks`,
    {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Provider gating probe",
    },
    { "Content-Type": "application/json", ...headers },
  );
  return { status: created.status, taskId: created.status === 201 ? created.body.id : "" };
}

async function approvalDigest(
  authApp: AuthApp,
  taskId: string,
  session: LoggedInSession,
): Promise<string> {
  const timeline = await getJson<{ items: Array<{ type: string; data: Record<string, unknown> }> }>(
    `${authApp.base}/api/v1/tasks/${taskId}/timeline`,
    { Cookie: `fp_session=${session.session}` },
  );
  expect(timeline.status).toBe(200);
  const required = timeline.body.items.find((item) => item.type === "approval.required");
  const digest = required?.data["scope_digest"];
  expect(typeof digest).toBe("string");
  return String(digest);
}

/** The five action classes against one task, as real HTTP requests. */
async function probeAllActions(
  authApp: AuthApp,
  session: LoggedInSession,
  taskId: string,
): Promise<Record<string, number>> {
  const cookie = { Cookie: `fp_session=${session.session}` };
  const read = await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, cookie);
  const timeline = await getJson(`${authApp.base}/api/v1/tasks/${taskId}/timeline`, cookie);
  const artifact = await getJson(`${authApp.base}/api/v1/tasks/${taskId}/artifacts/probe`, cookie);
  const digest = await approvalDigest(authApp, taskId, session);
  // Human-paced like the real flow; same-millisecond approvals can land
  // before the dsh run exists (DSH_APPROVAL_WINDOW_EXPIRED).
  await new Promise((resolve) => setTimeout(resolve, 5));
  const approval = await postJson(
    `${authApp.base}/api/v1/tasks/${taskId}/approvals`,
    { decision: "approve", scope_digest: digest },
    { "Content-Type": "application/json", ...cookieSessionHeaders(session) },
  );
  const write = await createTask(authApp, cookieSessionHeaders(session));
  return {
    read: read.status,
    timeline: timeline.status,
    artifact: artifact.status,
    approval: approval.status,
    write: write.status,
  };
}

describe("provider authority at the request boundary", () => {
  test("provider member removal denies read, stream, artifact, approval, and write", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "admin")).toBe(200);
    const fixture = installIntegration(authApp, member.userId);

    // Pre-revocation: every action class passes the boundary and works.
    const before = await probeAllActions(
      authApp,
      member,
      (await createTask(authApp, cookieSessionHeaders(member))).taskId,
    );
    expect(before.read).toBe(200);
    expect(before.timeline).toBe(200);
    // Artifact lookup may 404 on content but never 403 on authority.
    expect(before.artifact).not.toBe(403);
    expect(before.approval).toBe(200);
    expect(before.write).toBe(201);

    // A live SSE stream, subscribed before revocation.
    const streamTask = (await createTask(authApp, cookieSessionHeaders(member))).taskId;
    const connected = fetch(`${authApp.base}/api/v1/tasks/${streamTask}/stream`, {
      headers: { Cookie: `fp_session=${member.session}` },
      signal: AbortSignal.timeout(10_000),
    });
    const ended = connected.then((response) => {
      expect(response.status).toBe(200);
      return response.text();
    });
    await connected;

    // Provider member removal through the production event-sync path.
    const authority = authApp.orchestrator.providerAuthority;
    if (!authority) {
      throw new Error("provider authority boundary missing");
    }
    applyProviderEvent(
      {
        access: fixture.access,
        identities: fixture.identities,
        epoch: authority.epoch,
      },
      fixture.scope,
      fixture.integration,
      providerEvent(authApp, fixture, "member_removed", { subject: SUBJECT }, "removal-1"),
    );

    // Revocation cuts the live stream: read/stream stop in the same path.
    await ended;

    // Every action class is now refused at the request boundary.
    const cookie = { Cookie: `fp_session=${member.session}` };
    const read = await getJson(`${authApp.base}/api/v1/tasks/${streamTask}`, cookie);
    expect(read.status).toBe(403);
    expect((read.body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    const list = await getJson(`${authApp.base}/api/v1/tasks`, cookie);
    expect(list.status).toBe(403);
    const timeline = await getJson(`${authApp.base}/api/v1/tasks/${streamTask}/timeline`, cookie);
    expect(timeline.status).toBe(403);
    const artifact = await getJson(
      `${authApp.base}/api/v1/tasks/${streamTask}/artifacts/probe`,
      cookie,
    );
    expect(artifact.status).toBe(403);
    const approval = await postJson(
      `${authApp.base}/api/v1/tasks/${streamTask}/approvals`,
      { decision: "approve", scope_digest: "whatever" },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(approval.status).toBe(403);
    const write = await createTask(authApp, cookieSessionHeaders(member));
    expect(write.status).toBe(403);
    const stream = await fetch(`${authApp.base}/api/v1/tasks/${streamTask}/stream`, {
      headers: { Cookie: `fp_session=${member.session}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect(stream.status).toBe(403);

    // The deployment's own operator bearer is unchanged: it is not a
    // provider subject (local-prototype surface, ADR-0006).
    const operator = await getJson(`${authApp.base}/api/v1/tasks`, operatorHeaders(authApp));
    expect(operator.status).toBe(200);
  }, 60_000);

  test("reconciliation-reported removal denies the same request classes", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "admin")).toBe(200);
    const fixture = installIntegration(authApp, member.userId);
    const taskId = (await createTask(authApp, cookieSessionHeaders(member))).taskId;
    expect(
      (
        await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, {
          Cookie: `fp_session=${member.session}`,
        })
      ).status,
    ).toBe(200);

    // The reconcile path revokes with the shared authority-change signal.
    const authority = authApp.orchestrator.providerAuthority;
    if (!authority) {
      throw new Error("provider authority boundary missing");
    }
    revokeAuthority(
      fixture.access,
      authority.epoch,
      fixture.scope,
      { integration_id: fixture.integration.id, subject: SUBJECT, user_id: member.userId },
      "reconcile: absent from provider roster",
      new Date().toISOString(),
    );

    const cookie = { Cookie: `fp_session=${member.session}` };
    expect((await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, cookie)).status).toBe(403);
    expect((await createTask(authApp, cookieSessionHeaders(member))).status).toBe(403);
    const approval = await postJson(
      `${authApp.base}/api/v1/tasks/${taskId}/approvals`,
      { decision: "approve", scope_digest: "whatever" },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(approval.status).toBe(403);
    expect(
      (await getJson(`${authApp.base}/api/v1/tasks/${taskId}/artifacts/probe`, cookie)).status,
    ).toBe(403);
    const stream = await fetch(`${authApp.base}/api/v1/tasks/${taskId}/stream`, {
      headers: cookie,
      signal: AbortSignal.timeout(10_000),
    });
    expect(stream.status).toBe(403);
  }, 60_000);

  test("repository transfer blocks requests pending reconciliation", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "admin")).toBe(200);
    const fixture = installIntegration(authApp, member.userId);
    const taskId = (await createTask(authApp, cookieSessionHeaders(member))).taskId;

    const authority = authApp.orchestrator.providerAuthority;
    if (!authority) {
      throw new Error("provider authority boundary missing");
    }
    applyProviderEvent(
      {
        access: fixture.access,
        identities: fixture.identities,
        epoch: authority.epoch,
      },
      fixture.scope,
      fixture.integration,
      providerEvent(
        authApp,
        fixture,
        "repository_transferred",
        { repository_id: "github:repo:9002", repository_name: "NewOrg/AutoFixer" },
        "transfer-1",
      ),
    );

    const cookie = { Cookie: `fp_session=${member.session}` };
    const read = await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, cookie);
    expect(read.status).toBe(403);
    // Unknown authority says so explicitly: reconciliation is the next step.
    expect((read.body as { error: { code: string } }).error.code).toBe(
      "AUTHORITY_RECHECK_REQUIRED",
    );
  }, 60_000);

  test("without an installed integration the surface keeps its session behavior", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);

    // No service integration: no provider roster exists. The pre-existing
    // membership gating is unchanged (local-prototype mode).
    const write = await createTask(authApp, cookieSessionHeaders(member));
    expect(write.status).toBe(201);
    const read = await getJson(`${authApp.base}/api/v1/tasks/${write.taskId}`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(read.status).toBe(200);
    // The boundary still reports provider authority as not in play.
    expect(authApp.orchestrator.providerAuthority?.isEnforcing()).toBe(false);
  }, 60_000);
});

//
// ---------------------------------------------------------------------------
// Architect ruling (round 3) acceptance: a non-active integration is not an
// escape hatch. Existence of any service_integration row keeps the gate in
// play; suspension fails closed with AUTHORITY_RECHECK_REQUIRED, cuts live
// streams, and only a re-activation plus a successful reconciliation
// restores access.
// ---------------------------------------------------------------------------

describe("integration suspension fails closed and recovers", () => {
  test("suspension denies every class with AUTHORITY_RECHECK_REQUIRED and recovers after re-activation + reconcile", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "admin")).toBe(200);
    const fixture = installIntegration(authApp, member.userId);
    const authority = authApp.orchestrator.providerAuthority;
    if (!authority) {
      throw new Error("provider authority boundary missing");
    }
    const taskId = (await createTask(authApp, cookieSessionHeaders(member))).taskId;

    // A live SSE stream, opened before the event.
    const connected = fetch(`${authApp.base}/api/v1/tasks/${taskId}/stream`, {
      headers: { Cookie: `fp_session=${member.session}` },
      signal: AbortSignal.timeout(10_000),
    });
    const ended = connected.then((response) => {
      expect(response.status).toBe(200);
      return response.text();
    });
    await connected;

    // Production event path: the provider suspends the integration.
    applyProviderEvent(
      {
        access: fixture.access,
        identities: fixture.identities,
        epoch: authority.epoch,
      },
      fixture.scope,
      fixture.integration,
      providerEvent(authApp, fixture, "integration_suspended", {}, "susp-1"),
    );

    // The already-open stream closes on the epoch notification.
    await ended;

    // Authority stays in play: a suspended integration is not a way out of
    // the gate (Architect ruling: existence, not current status).
    expect(authApp.orchestrator.providerAuthority?.isEnforcing()).toBe(true);

    const cookie = { Cookie: `fp_session=${member.session}` };
    const denial = async (response: { status: number; body: unknown }): Promise<void> => {
      expect(response.status).toBe(403);
      const error = (response.body as { error: { code: string; next_action: string | null } })
        .error;
      expect(error.code).toBe("AUTHORITY_RECHECK_REQUIRED");
      expect(error.next_action).toBe("reconcile");
    };

    // read: list / detail / timeline / runs
    await denial(await getJson(`${authApp.base}/api/v1/tasks`, cookie));
    await denial(await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, cookie));
    await denial(await getJson(`${authApp.base}/api/v1/tasks/${taskId}/timeline`, cookie));
    await denial(await getJson(`${authApp.base}/api/v1/tasks/${taskId}/runs`, cookie));
    // artifact
    await denial(await getJson(`${authApp.base}/api/v1/tasks/${taskId}/artifacts/probe`, cookie));
    // approval
    await denial(
      await postJson(
        `${authApp.base}/api/v1/tasks/${taskId}/approvals`,
        { decision: "approve", scope_digest: "probe" },
        { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
      ),
    );
    // write: create / steer / cancel / archive
    await denial(
      await postJson(
        `${authApp.base}/api/v1/tasks`,
        { repository_id: REPOSITORY_ID, base_ref: "main", summary: "suspended probe" },
        { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
      ),
    );
    await denial(
      await postJson(
        `${authApp.base}/api/v1/tasks/${taskId}/messages`,
        { mode: "steer", content: "halt" },
        { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
      ),
    );
    await denial(
      await postJson(
        `${authApp.base}/api/v1/tasks/${taskId}/cancel`,
        { reason: "probe" },
        { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
      ),
    );
    await denial(
      await postJson(
        `${authApp.base}/api/v1/tasks/${taskId}/archive`,
        {},
        { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
      ),
    );

    // New SSE connections are refused the same way.
    const stream = await fetch(`${authApp.base}/api/v1/tasks/${taskId}/stream`, {
      headers: cookie,
      signal: AbortSignal.timeout(10_000),
    });
    expect(stream.status).toBe(403);
    const streamBody = (await stream.json()) as { error: { code: string } };
    expect(streamBody.error.code).toBe("AUTHORITY_RECHECK_REQUIRED");

    // Recovery path: re-activate the integration, then one successful
    // reconciliation re-verifies authority. The same requests recover —
    // suspension never permanently locks the workspace.
    const fresh = fixture.access.integrations.getById(fixture.scope, fixture.integration.id);
    if (!fresh) {
      throw new Error("integration missing");
    }
    fixture.access.integrations.setStatus(
      fixture.scope,
      fresh.id,
      { install_status: "active", actor_id: "usr_test_operator" },
      fresh.version,
    );
    const summary = await reconcileIntegration(
      {
        access: fixture.access,
        identities: fixture.identities,
        epoch: authority.epoch,
      },
      fixture.scope,
      fixture.access.integrations.getById(fixture.scope, fresh.id) ?? fresh,
      scriptedAdapter({
        pages: [page([role(SUBJECT, "direct_collaborator", "admin", REPOSITORY_ID)])],
      }),
      { now: new Date() },
    );
    expect(summary.status).toBe("completed");

    const recoveredRead = await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, cookie);
    expect(recoveredRead.status).toBe(200);
    const recoveredWrite = await postJson(
      `${authApp.base}/api/v1/tasks`,
      { repository_id: REPOSITORY_ID, base_ref: "main", summary: "recovered probe" },
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(recoveredWrite.status).toBe(201);
  }, 60_000);
});
