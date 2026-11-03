import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  cookieSessionHeaders,
  fakeProvider,
  startAuthApp,
  webLogin,
} from "./helpers/auth-app.js";
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

async function app(): Promise<AuthApp> {
  const created = await startAuthApp({ dsh });
  apps.push(created);
  return created;
}

function bootstrapUrl(authApp: AuthApp): string {
  return `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/bootstrap`;
}

async function bootstrap(
  authApp: AuthApp,
  input: { subject: string; providerInstanceId?: string; token?: string },
): Promise<{ status: number; text: string }> {
  const response = await fetch(bootstrapUrl(authApp), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bootstrap-Token": input.token ?? BOOTSTRAP_TOKEN,
    },
    body: JSON.stringify({
      provider_instance_id: input.providerInstanceId ?? authApp.providerInstanceId,
      subject: input.subject,
    }),
  });
  return { status: response.status, text: await response.text() };
}

function providerInstanceUrl(authApp: AuthApp): string {
  return `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/provider-instances`;
}

describe("administrator bootstrap", () => {
  test("an ordinary login never becomes an administrator", async () => {
    const authApp = await app();
    const user = await webLogin(authApp);
    // The logged-in user cannot approve provider instances…
    const approve = await postJson(
      providerInstanceUrl(authApp),
      {
        provider_type: "gitlab",
        origin_url: "https://gitlab.example.com",
      },
      cookieSessionHeaders(user),
    );
    expect(approve.status).toBe(403);
    // …and cannot invoke the deployment bootstrap either.
    const selfBootstrap = await bootstrap(authApp, {
      subject: "1001",
      token: "",
    });
    expect(selfBootstrap.status).toBe(401);
    const withSession = await fetch(bootstrapUrl(authApp), {
      method: "POST",
      headers: { ...cookieSessionHeaders(user), "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_instance_id: authApp.providerInstanceId,
        subject: "1001",
      }),
    });
    expect(withSession.status).toBe(403);
  });

  test("the bootstrap token is deployment-owned and required", async () => {
    const authApp = await app();
    expect((await bootstrap(authApp, { subject: "1001", token: "wrong-token" })).status).toBe(401);
    const missing = await fetch(bootstrapUrl(authApp), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_instance_id: authApp.providerInstanceId,
        subject: "1001",
      }),
    });
    expect(missing.status).toBe(401);
  });

  test("bootstrap names the provider identity, grants once, and cannot be squatted", async () => {
    const provider = fakeProvider({ id: 7001, login: "first-signin" });
    const authApp = await startAuthApp({ dsh, provider });
    apps.push(authApp);
    // Whoever signs in first is an ordinary user.
    const squatter = await webLogin(authApp);
    expect(squatter.userId).toBeDefined();

    // The deployment names the intended administrator's provider identity.
    provider.profile = { id: 7002, login: "intended-admin" };
    const admin = await webLogin(authApp);
    expect(admin.userId).not.toBe(squatter.userId);
    const granted = await bootstrap(authApp, { subject: "7002" });
    expect(granted.status).toBe(200);
    expect(granted.text).toContain(admin.userId);

    // The first signer-in cannot capture the role afterwards.
    const squat = await bootstrap(authApp, { subject: "7001" });
    expect(squat.status).toBe(409);
    // Re-running for the same named identity is idempotent.
    const again = await bootstrap(authApp, { subject: "7002" });
    expect(again.status).toBe(200);
    // A subject that never signed in cannot be granted at all.
    const unknown = await bootstrap(authApp, { subject: "9999" });
    expect(unknown.status).toBe(404);
  });

  test("the bootstrapped admin approves provider origins; internal ones are refused", async () => {
    const authApp = await app();
    const admin = await webLogin(authApp);
    expect((await bootstrap(authApp, { subject: "1001" })).status).toBe(200);

    const approve = await postJson<{ provider_instance: { origin_url: string } }>(
      providerInstanceUrl(authApp),
      { provider_type: "gitlab", origin_url: "https://gitlab.example.com" },
      cookieSessionHeaders(admin),
    );
    expect(approve.status).toBe(201);
    expect(approve.body.provider_instance.origin_url).toBe("https://gitlab.example.com");

    for (const origin of [
      "https://10.0.0.5",
      "https://gitlab.internal",
      "https://169.254.169.254",
    ]) {
      const internal = await postJson(
        providerInstanceUrl(authApp),
        { provider_type: "gitlab", origin_url: origin },
        cookieSessionHeaders(admin),
      );
      expect(internal.status, origin).toBe(403);
    }
    // An origin without a configured OAuth application is refused outright.
    const unconfigured = await postJson(
      providerInstanceUrl(authApp),
      { provider_type: "github", origin_url: "https://ghe.example.com" },
      cookieSessionHeaders(admin),
    );
    expect(unconfigured.status).toBe(400);
  });

  test("the audit trail records bootstrap and never leaks secrets", async () => {
    const authApp = await app();
    const admin = await webLogin(authApp);
    expect((await bootstrap(authApp, { subject: "1001" })).status).toBe(200);

    const audit = await getJson<{ items: Array<{ event: string }> }>(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/auth-audit`,
      { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
    );
    expect(audit.status).toBe(200);
    expect(audit.body.items.map((item) => item.event)).toContain("admin.bootstrap");

    // The same list as a non-admin session is refused.
    authApp.provider.profile = { id: 8001, login: "plain-user" };
    const plain = await webLogin(authApp);
    const denied = await getJson(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/auth-audit`,
      cookieSessionHeaders(plain),
    );
    expect(denied.status).toBe(403);
    // But the bootstrapped admin may read it.
    const allowed = await getJson(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/auth-audit`,
      cookieSessionHeaders(admin),
    );
    expect(allowed.status).toBe(200);
  });

  test("without a configured bootstrap token the surface fails closed", async () => {
    const authApp = await startAuthApp({
      dsh,
      configOverrides: { bootstrapToken: undefined },
    });
    apps.push(authApp);
    const response = await fetch(bootstrapUrl(authApp), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bootstrap-Token": BOOTSTRAP_TOKEN,
      },
      body: JSON.stringify({
        provider_instance_id: authApp.providerInstanceId,
        subject: "1001",
      }),
    });
    expect(response.status).toBe(401);
  });
});
