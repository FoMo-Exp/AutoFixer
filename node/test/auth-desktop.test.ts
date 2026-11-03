import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson } from "./helpers/http.js";
import { BOOTSTRAP_TOKEN, completeCallback, startAuthApp, startLogin } from "./helpers/auth-app.js";
import type { AuthApp } from "./helpers/auth-app.js";

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

async function app(overrides: Parameters<typeof startAuthApp>[0] = { dsh }): Promise<AuthApp> {
  const created = await startAuthApp(overrides);
  apps.push(created);
  return created;
}

interface DesktopFlowCreated {
  flow_id: string;
  secret: string;
  login_url: string;
  expires_at: string;
}

interface ExchangeOk {
  status: string;
  token: string;
  csrf_token: string;
  expires_at: string;
  user: { id: string };
}

function exchangeUrl(authApp: AuthApp, flowId: string): string {
  return `${authApp.base}/api/v1/auth/desktop/flows/${flowId}/exchange`;
}

async function createDesktopFlow(
  authApp: AuthApp,
  providerInstanceId?: string,
): Promise<DesktopFlowCreated> {
  const created = await postJson<DesktopFlowCreated>(
    `${authApp.base}/api/v1/auth/desktop/flows`,
    providerInstanceId !== undefined ? { provider_instance_id: providerInstanceId } : {},
    { "Content-Type": "application/json" },
  );
  expect(created.status).toBe(201);
  return created.body;
}

/** Complete the system-browser leg for a desktop flow. */
async function browserLeg(authApp: AuthApp, flowId: string): Promise<string> {
  const started = await startLogin(authApp, { desktopFlowId: flowId });
  expect(started.response.status).toBe(302);
  const completed = await completeCallback(authApp, {
    state: started.state,
    binding: started.binding,
  });
  expect(completed.status).toBe(200);
  // The browser completion page must not carry the desktop credential.
  expect(completed.text).not.toContain("tok_");
  expect(completed.headers.getSetCookie().some((entry) => entry.startsWith("fp_session="))).toBe(
    false,
  );
  return completed.text;
}

describe("desktop system-browser flow", () => {
  test("binds once and exchanges a single-use secret into a desktop session", async () => {
    const authApp = await app();
    const flow = await createDesktopFlow(authApp, authApp.providerInstanceId);
    expect(flow.secret.length).toBeGreaterThanOrEqual(32);
    expect(flow.login_url).toContain(`desktop_flow=${flow.flow_id}`);
    // The secret is never in the browser URL.
    expect(flow.login_url).not.toContain(flow.secret);

    await browserLeg(authApp, flow.flow_id);
    const exchanged = await postJson<ExchangeOk>(
      exchangeUrl(authApp, flow.flow_id),
      {
        secret: flow.secret,
      },
      { "Content-Type": "application/json" },
    );
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.token.length).toBeGreaterThanOrEqual(32);

    // The desktop session works as a bearer credential (no cookies, no CSRF).
    const session = await getJson<{ user: { id: string } }>(`${authApp.base}/api/v1/auth/session`, {
      Authorization: `Bearer ${exchanged.body.token}`,
    });
    expect(session.status).toBe(200);
    expect(session.body.user.id).toBe(exchanged.body.user.id);

    // Single-use: a second exchange of the same secret fails.
    const replay = await postJson(exchangeUrl(authApp, flow.flow_id), { secret: flow.secret });
    expect(replay.status).toBe(410);
  });

  test("exchange before the browser login reports not-ready", async () => {
    const authApp = await app();
    const flow = await createDesktopFlow(authApp);
    const early = await postJson(exchangeUrl(authApp, flow.flow_id), { secret: flow.secret });
    expect(early.status).toBe(428);
  });

  test("a wrong secret is rejected and burned after repeated attempts", async () => {
    const authApp = await app();
    const flow = await createDesktopFlow(authApp);
    await browserLeg(authApp, flow.flow_id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await postJson(exchangeUrl(authApp, flow.flow_id), {
        secret: `wrong-secret-${attempt}`,
      });
      expect(wrong.status).toBe(401);
    }
    const limited = await postJson(exchangeUrl(authApp, flow.flow_id), { secret: flow.secret });
    expect(limited.status).toBe(429);
    // The flow id is not enumerable through error text.
    const unknown = await postJson(exchangeUrl(authApp, "dsk_unknown"), { secret: "whatever" });
    expect(unknown.status).toBe(400);
  });

  test("an expired desktop flow cannot start a login", async () => {
    const expiring = await app({ dsh, configOverrides: { desktopFlowTtlSeconds: 0 } });
    const flow = await createDesktopFlow(expiring);
    const started = await startLogin(expiring, { desktopFlowId: flow.flow_id });
    expect(started.response.status).toBe(410);
    // And its exchange reports expiry rather than delivering a session.
    const exchanged = await postJson(exchangeUrl(expiring, flow.flow_id), { secret: flow.secret });
    expect(exchanged.status).toBe(410);
  });

  test("membership is still enforced for desktop sessions", async () => {
    const authApp = await app();
    const flow = await createDesktopFlow(authApp);
    await browserLeg(authApp, flow.flow_id);
    const exchanged = await postJson<ExchangeOk>(exchangeUrl(authApp, flow.flow_id), {
      secret: flow.secret,
    });
    expect(exchanged.status).toBe(200);
    // Without membership the desktop session cannot read the task surface.
    const read = await getJson(`${authApp.base}/api/v1/tasks`, {
      Authorization: `Bearer ${exchanged.body.token}`,
    });
    expect(read.status).toBe(403);
    // Granting membership through deployment authority unlocks it.
    const grant = await fetch(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${exchanged.body.user.id}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
        },
        body: JSON.stringify({ role: "member" }),
      },
    );
    expect(grant.status).toBe(200);
    const readAgain = await getJson(`${authApp.base}/api/v1/tasks`, {
      Authorization: `Bearer ${exchanged.body.token}`,
    });
    expect(readAgain.status).toBe(200);
  });
});
