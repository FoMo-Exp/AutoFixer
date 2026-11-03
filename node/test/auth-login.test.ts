import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieValue, getJson, getRaw } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  completeCallback,
  fakeProvider,
  startAuthApp,
  startLogin,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp, FakeProvider } from "./helpers/auth-app.js";

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 120_000);

afterAll(async () => {
  await dsh.stop();
});

async function app(provider?: FakeProvider): Promise<AuthApp> {
  const created = await startAuthApp({ dsh, ...(provider ? { provider } : {}) });
  apps.push(created);
  return created;
}

afterAll(async () => {
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

describe("login start", () => {
  test("redirects to the provider with state, PKCE S256, and the exact callback", async () => {
    const authApp = await app();
    const started = await startLogin(authApp);
    expect(started.response.status).toBe(302);
    expect(started.authorizeUrl.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    const params = new URL(started.authorizeUrl).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("redirect_uri")).toBe(`${authApp.base}/api/v1/auth/callback`);
    expect(params.get("state")).toBe(started.state);
    expect(started.state.length).toBeGreaterThanOrEqual(32);
    expect(params.get("code_challenge_method")).toBe("S256");
    // The binding cookie ties the flow to this browser (login-CSRF defense).
    expect(started.binding.length).toBeGreaterThanOrEqual(32);
    expect(cookieValue(started.response.headers, "fp_oauth_binding")).toBe(started.binding);
    const setCookie = started.response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("HttpOnly");
    // No client secret in anything the browser sees.
    expect(started.authorizeUrl).not.toContain("client-secret");
  });

  test("rejects login against an unapproved or unknown provider instance", async () => {
    const authApp = await app();
    const response = await getRaw(
      `${authApp.base}/api/v1/auth/login?provider_instance_id=pi_does_not_exist`,
    );
    expect(response.status).toBe(400);
    expect(response.text).not.toContain("pi_does_not_exist");
  });

  test("open redirect targets are refused", async () => {
    const authApp = await app();
    const started = await startLogin(authApp, { returnTo: "https://evil.example.com/steal" });
    const completed = await completeCallback(authApp, {
      state: started.state,
      binding: started.binding,
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toBe("/");
  });
});

describe("login callback", () => {
  test("establishes a server-side session and provisions the user", async () => {
    const authApp = await app();
    const started = await startLogin(authApp);
    const completed = await completeCallback(authApp, {
      state: started.state,
      binding: started.binding,
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toBe("/");
    const session = cookieValue(completed.headers, "fp_session");
    expect(session).toBeDefined();
    expect(completed.headers.getSetCookie().join("\n")).toContain("HttpOnly");
    // The session cookie is never echoed into the redirect target.
    expect(completed.headers.get("location")).not.toContain("tok_");
    const info = await getJson<{ user: { display_name: string }; csrf_token: string }>(
      `${authApp.base}/api/v1/auth/session`,
      { Cookie: `fp_session=${session}` },
    );
    expect(info.status).toBe(200);
    expect(info.body.user.display_name).toBe("octo");
    expect(info.body.csrf_token.length).toBeGreaterThan(20);
  });

  test("the token exchange proves PKCE and the exact redirect URI", async () => {
    const provider = fakeProvider({ id: 2002, login: "pkce-user" });
    const authApp = await app(provider);
    const started = await startLogin(authApp);
    await completeCallback(authApp, { state: started.state, binding: started.binding });
    const tokenRequest = provider.requests.find((entry) => entry.url.includes("access_token"));
    expect(tokenRequest).toBeDefined();
    const params = new URLSearchParams(tokenRequest?.body ?? "");
    expect(params.get("redirect_uri")).toBe(`${authApp.base}/api/v1/auth/callback`);
    const verifier = params.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(32);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(started.codeChallenge);
    // The client secret travels in the POST body, never in a URL.
    expect(tokenRequest?.url).not.toContain("client-secret");
    expect(params.get("client_secret")).toBe("client-secret");
  });

  test("a replayed callback fails (single-use state)", async () => {
    const authApp = await app();
    const started = await startLogin(authApp);
    const first = await completeCallback(authApp, {
      state: started.state,
      binding: started.binding,
    });
    expect(first.status).toBe(302);
    const replay = await completeCallback(authApp, {
      state: started.state,
      binding: started.binding,
    });
    expect(replay.status).toBe(410);
    expect(replay.text).toContain("AUTH_FLOW_CONSUMED");
  });

  test("login CSRF fails without the browser binding", async () => {
    const authApp = await app();
    const started = await startLogin(authApp);
    // Attacker completes the callback in a different browser: no binding.
    const noBinding = await completeCallback(authApp, { state: started.state });
    expect(noBinding.status).toBe(403);
    // Wrong binding (attacker's own flow binding) also fails.
    const wrongBinding = await completeCallback(authApp, {
      state: started.state,
      binding: "attacker-binding",
    });
    expect(wrongBinding.status).toBe(403);
    // And an unknown state is rejected outright.
    const unknownState = await completeCallback(authApp, {
      state: "forged-state",
      binding: started.binding,
    });
    expect(unknownState.status).toBe(400);
  });

  test("an expired flow is rejected", async () => {
    const expiring = await startAuthApp({
      dsh,
      configOverrides: { oauthFlowTtlSeconds: 0 },
    });
    apps.push(expiring);
    const started = await startLogin(expiring);
    const completed = await completeCallback(expiring, {
      state: started.state,
      binding: started.binding,
    });
    expect(completed.status).toBe(410);
    expect(completed.text).toContain("AUTH_FLOW_EXPIRED");
  });
});

describe("identity matching", () => {
  test("a shared email never merges two provider subjects (no account takeover)", async () => {
    const provider = fakeProvider({
      id: 3001,
      login: "alice",
      name: "Alice",
      email: "shared@example.com",
    });
    const authApp = await app(provider);
    const first = await webLogin(authApp);
    // Same email, different provider subject: must become a different user.
    provider.profile = { id: 3002, login: "mallory", name: "Mallory", email: "shared@example.com" };
    const second = await webLogin(authApp);
    expect(second.userId).not.toBe(first.userId);
    // The original subject still maps to the original account.
    provider.profile = { id: 3001, login: "alice", name: "Alice", email: "shared@example.com" };
    const third = await webLogin(authApp);
    expect(third.userId).toBe(first.userId);
  });

  test("the provider access token never reaches the client or the audit log", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    const response = await fetch(`${authApp.base}/api/v1/auth/session`, {
      headers: { Cookie: `fp_session=${session.session}` },
    });
    const body = await response.text();
    expect(body).not.toContain("tok_");
    expect(body).not.toContain("client-secret");
    const audit = await fetch(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/auth-audit`,
      { headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    expect(audit.status).toBe(200);
    const auditBody = await audit.text();
    expect(auditBody).not.toContain("tok_");
    expect(auditBody).not.toContain("client-secret");
    expect(auditBody).not.toContain(session.session);
    expect(auditBody).not.toContain(session.csrf);
  });
});
