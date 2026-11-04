import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRepositories } from "../src/control-plane/index.js";
import type { Workspace } from "../src/control-plane/index.js";
import type { TaskResource } from "../src/api/task-store.js";
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

/** A second workspace in the same enterprise, bound to another repository. */
function addWorkspace(authApp: AuthApp, name: string): Workspace {
  const controlPlane = authApp.orchestrator.controlPlane;
  if (controlPlane === undefined) {
    throw new Error("identity surface is not configured");
  }
  return createRepositories(controlPlane).workspaces.create(
    { enterprise_id: authApp.enterpriseId, actor_id: "usr_seed" },
    {
      name,
      repository_id: `github:Luthiel/${name}`,
      provider_instance_id: authApp.providerInstanceId,
    },
  );
}

async function grantMembership(
  authApp: AuthApp,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<number> {
  const response = await fetch(
    `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${workspaceId}/members/${userId}`,
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

async function revokeMembership(
  authApp: AuthApp,
  workspaceId: string,
  userId: string,
): Promise<number> {
  const response = await fetch(
    `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${workspaceId}/members/${userId}`,
    { method: "DELETE", headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
  );
  return response.status;
}

function createTask(
  authApp: AuthApp,
  workspaceId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
) {
  return postJson<{ error: { code: string; message: string } } & Partial<TaskResource>>(
    `${authApp.base}/api/v1/workspaces/${workspaceId}/tasks`,
    body,
    { "Content-Type": "application/json", ...headers },
  );
}

async function listTaskIds(
  authApp: AuthApp,
  workspaceId: string,
  session?: LoggedInSession,
): Promise<string[]> {
  const response = await getJson<{ items: TaskResource[] }>(
    `${authApp.base}/api/v1/workspaces/${workspaceId}/tasks`,
    session !== undefined ? cookieSessionHeaders(session) : operatorHeaders(authApp),
  );
  expect(response.status).toBe(200);
  return response.body.items.map((task) => task.id);
}

describe("workspace-scoped task creation (DAT-245)", () => {
  test("a member creates a task bound to that workspace", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);

    const created = await createTask(
      authApp,
      workspaceA,
      {
        repository_id: "github:Luthiel/AutoFixer",
        base_ref: "main",
        summary: "workspace-scoped create",
      },
      cookieSessionHeaders(member),
    );
    expect(created.status).toBe(201);
    expect(created.body.workspace_id).toBe(workspaceA);
    expect(created.body.repository?.id).toBe("github:Luthiel/AutoFixer");
    expect(created.body.run_history_url).toBe(
      `/api/v1/workspaces/${workspaceA}/tasks/${created.body.id}/runs`,
    );

    // The scoped run-history URL the response advertises resolves in place.
    const runs = await getJson(
      `${authApp.base}${created.body.run_history_url}`,
      cookieSessionHeaders(member),
    );
    expect(runs.status).toBe(200);
    expect(await listTaskIds(authApp, workspaceA, member)).toContain(created.body.id);
  });

  test("the request cannot select another repository or base ref", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    expect(await grantMembership(authApp, workspaceB, member.userId, "member")).toBe(200);

    const wrongRepository = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/Beta", base_ref: "main", summary: "cross repo" },
      cookieSessionHeaders(member),
    );
    expect(wrongRepository.status).toBe(400);
    expect(wrongRepository.body.error.code).toBe("REPOSITORY_NOT_IN_WORKSPACE");

    const wrongRef = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "dev", summary: "cross ref" },
      cookieSessionHeaders(member),
    );
    expect(wrongRef.status).toBe(400);
    expect(wrongRef.body.error.code).toBe("BASE_REF_NOT_SUPPORTED");

    // Zero dispatch: neither refusal produced a task or a run.
    expect(await listTaskIds(authApp, workspaceA, member)).toEqual([]);
    expect(await listTaskIds(authApp, workspaceB, member)).toEqual([]);
  });

  test("a workspace without a pinned base revision fails closed", async () => {
    const authApp = await app();
    const workspaceB = addWorkspace(authApp, "Gamma").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceB, member.userId, "member")).toBe(200);

    const refused = await createTask(
      authApp,
      workspaceB,
      { repository_id: "github:Luthiel/Gamma", base_ref: "main", summary: "unbound repo" },
      cookieSessionHeaders(member),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("REPOSITORY_BINDING_UNAVAILABLE");
    expect(await listTaskIds(authApp, workspaceB, member)).toEqual([]);
  });

  test("non-members, revoked members, and viewers cannot create", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Delta").id;

    const outsider = await webLogin(authApp);
    const notMember = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "outsider" },
      cookieSessionHeaders(outsider),
    );
    expect(notMember.status).toBe(404);
    expect(notMember.body.error.code).toBe("NOT_FOUND");

    const revoked = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, revoked.userId, "member")).toBe(200);
    expect(await revokeMembership(authApp, workspaceA, revoked.userId)).toBe(204);
    const afterRevoke = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "revoked" },
      cookieSessionHeaders(revoked),
    );
    expect(afterRevoke.status).toBe(404);

    const viewer = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, viewer.userId, "viewer")).toBe(200);
    const viewerWrite = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "viewer" },
      cookieSessionHeaders(viewer),
    );
    expect(viewerWrite.status).toBe(403);

    // A task created elsewhere is not reachable from this workspace either.
    const other = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceB, other.userId, "member")).toBe(200);
    const otherWrite = await createTask(
      authApp,
      workspaceB,
      { repository_id: "github:Luthiel/Delta", base_ref: "main", summary: "other" },
      cookieSessionHeaders(other),
    );
    expect(otherWrite.status).toBe(409);
    expect(await listTaskIds(authApp, workspaceA, viewer)).toEqual([]);
  });

  test("the operator bearer is confined to the deployment workspace", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Epsilon").id;

    const created = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "operator create" },
      operatorHeaders(authApp),
    );
    expect(created.status).toBe(201);
    expect(created.body.workspace_id).toBe(workspaceA);

    const foreign = await createTask(
      authApp,
      workspaceB,
      { repository_id: "github:Luthiel/Epsilon", base_ref: "main", summary: "foreign" },
      operatorHeaders(authApp),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
  });

  test("an idempotency key replays inside the workspace only", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    const headers = {
      ...cookieSessionHeaders(member),
      "Idempotency-Key": "same-key",
    };
    const first = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "idempotent" },
      headers,
    );
    expect(first.status).toBe(201);
    const replay = await createTask(
      authApp,
      workspaceA,
      { repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "idempotent" },
      headers,
    );
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(await listTaskIds(authApp, workspaceA, member)).toEqual([first.body.id]);
  });
});
