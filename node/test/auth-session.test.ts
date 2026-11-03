import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieValue, getJson, postJson } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  completeCallback,
  cookieSessionHeaders,
  startAuthApp,
  startLogin,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";

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

async function createTaskStatus(
  authApp: AuthApp,
  headers: Record<string, string>,
): Promise<{ status: number; taskId?: string }> {
  const created = await postJson<{ id: string }>(
    `${authApp.base}/api/v1/tasks`,
    {
      repository_id: "github:Luthiel/AutoFixer",
      base_ref: "main",
      summary: "Session gating probe",
    },
    { "Content-Type": "application/json", ...headers },
  );
  return created.status === 201
    ? { status: created.status, taskId: created.body.id }
    : { status: created.status };
}

/** A non-terminal task for SSE subscriptions. */
async function openTaskId(authApp: AuthApp): Promise<string> {
  const created = await createTaskStatus(authApp, operatorHeaders(authApp));
  expect(created.status).toBe(201);
  return created.taskId ?? "";
}

function streamUrl(authApp: AuthApp, taskId: string): string {
  return `${authApp.base}/api/v1/tasks/${taskId}/stream`;
}

/**
 * Open the task SSE stream with a session cookie and return a promise that
 * resolves when the *server* ends the stream (rejects if it dangles past the
 * deadline). The fetch resolving with 200 proves the subscription is live:
 * the SSE branch registers its handlers synchronously before flushing the
 * first frame, so no timer-based settling is needed before triggering an
 * invalidation.
 */
function openSessionStream(
  authApp: AuthApp,
  taskId: string,
  session: LoggedInSession,
): { connected: Promise<Response>; ended: Promise<string> } {
  const connected = fetch(streamUrl(authApp, taskId), {
    headers: { Cookie: `fp_session=${session.session}` },
    signal: AbortSignal.timeout(10_000),
  });
  const ended = connected.then((response) => {
    expect(response.status).toBe(200);
    return response.text();
  });
  return { connected, ended };
}

describe("session access to the task surface", () => {
  test("membership grants reads and writes; viewer is read-only", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const write = await createTaskStatus(authApp, cookieSessionHeaders(member));
    expect(write.status).toBe(201);
    const read = await getJson(`${authApp.base}/api/v1/tasks/${write.taskId ?? ""}`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(read.status).toBe(200);

    // A different provider subject is a different user.
    authApp.provider.profile = { id: 1002, login: "viewer-user" };
    const viewerLogin = await webLogin(authApp);
    expect(viewerLogin.userId).not.toBe(member.userId);
    expect(await grantMembership(authApp, viewerLogin.userId, "viewer")).toBe(200);
    const viewerWrite = await createTaskStatus(authApp, cookieSessionHeaders(viewerLogin));
    expect(viewerWrite.status).toBe(403);
    const viewerRead = await getJson(`${authApp.base}/api/v1/tasks/${write.taskId ?? ""}`, {
      Cookie: `fp_session=${viewerLogin.session}`,
    });
    expect(viewerRead.status).toBe(200);
  });

  test("without membership reads and writes are denied", async () => {
    const authApp = await app();
    const outsider = await webLogin(authApp);
    await openTaskId(authApp);
    const read = await getJson(`${authApp.base}/api/v1/tasks`, {
      Cookie: `fp_session=${outsider.session}`,
    });
    expect(read.status).toBe(403);
    const write = await createTaskStatus(authApp, cookieSessionHeaders(outsider));
    expect(write.status).toBe(403);
  });

  test("cookie-authenticated writes require the CSRF token", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const missing = await createTaskStatus(authApp, { Cookie: `fp_session=${member.session}` });
    expect(missing.status).toBe(403);
    const wrong = await createTaskStatus(authApp, {
      Cookie: `fp_session=${member.session}`,
      "X-CSRF-Token": "not-the-right-token",
    });
    expect(wrong.status).toBe(403);
    const right = await createTaskStatus(authApp, cookieSessionHeaders(member));
    expect(right.status).toBe(201);
  });

  test("the operator bearer path stays unchanged", async () => {
    const authApp = await app();
    await openTaskId(authApp);
    const read = await getJson(`${authApp.base}/api/v1/tasks`, operatorHeaders(authApp));
    expect(read.status).toBe(200);
    const noCredentials = await getJson(`${authApp.base}/api/v1/tasks`);
    expect(noCredentials.status).toBe(401);
  });
});

describe("invalidation", () => {
  test("logout revokes the session for reads, writes, and SSE immediately", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const taskId = await openTaskId(authApp);

    const stream = openSessionStream(authApp, taskId, member);
    await stream.connected;
    const logout = await fetch(`${authApp.base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { ...cookieSessionHeaders(member), "Content-Type": "application/json" },
    });
    expect(logout.status).toBe(204);
    // Server closes the stream as the session dies.
    await stream.ended;

    const read = await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(read.status).toBe(401);
    const write = await createTaskStatus(authApp, cookieSessionHeaders(member));
    expect(write.status).toBe(401);
  });

  test("suspension closes live SSE, kills sessions, and blocks new logins", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const taskId = await openTaskId(authApp);

    const stream = openSessionStream(authApp, taskId, member);
    await stream.connected;
    const suspend = await fetch(`${authApp.base}/api/v1/admin/users/${member.userId}/suspend`, {
      method: "POST",
      headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(suspend.status).toBe(200);
    await stream.ended;

    const read = await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(read.status).toBe(401);
    const sessionInfo = await getJson(`${authApp.base}/api/v1/auth/session`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(sessionInfo.status).toBe(401);

    // A suspended user cannot even finish a new login.
    const started = await startLogin(authApp);
    const callback = await completeCallback(authApp, {
      state: started.state,
      binding: started.binding,
    });
    expect(callback.status).toBe(403);
  });

  test("membership revocation closes live SSE and denies reads and writes", async () => {
    const authApp = await app();
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, member.userId, "member")).toBe(200);
    const taskId = await openTaskId(authApp);

    const stream = openSessionStream(authApp, taskId, member);
    await stream.connected;
    const revoke = await fetch(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${member.userId}`,
      {
        method: "DELETE",
        headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN },
      },
    );
    expect(revoke.status).toBe(204);
    await stream.ended;

    const read = await getJson(`${authApp.base}/api/v1/tasks/${taskId}`, {
      Cookie: `fp_session=${member.session}`,
    });
    expect(read.status).toBe(403);
    const write = await createTaskStatus(authApp, cookieSessionHeaders(member));
    expect(write.status).toBe(403);
  });

  test("an expired session is rejected", async () => {
    const expiring = await startAuthApp({ dsh, configOverrides: { sessionTtlSeconds: 0 } });
    apps.push(expiring);
    const started = await startLogin(expiring);
    const completed = await completeCallback(expiring, {
      state: started.state,
      binding: started.binding,
    });
    expect(completed.status).toBe(302);
    const session = cookieValue(completed.headers, "fp_session");
    expect(session).toBeDefined();
    // The minted session is already past its expiry: every use is refused.
    const read = await getJson(`${expiring.base}/api/v1/tasks`, {
      Cookie: `fp_session=${session}`,
    });
    expect(read.status).toBe(401);
  });
});
