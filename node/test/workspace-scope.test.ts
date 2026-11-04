import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRepositories } from "../src/control-plane/index.js";
import type { Workspace } from "../src/control-plane/index.js";
import { createTaskRecord } from "../src/api/task-store.js";
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

/** Grant a session user a role in any workspace of the seeded enterprise. */
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

async function createLegacyTask(authApp: AuthApp): Promise<TaskResource> {
  const created = await postJson<TaskResource>(
    `${authApp.base}/api/v1/tasks`,
    {
      repository_id: "github:Luthiel/AutoFixer",
      base_ref: "main",
      summary: "workspace scope probe",
    },
    { "Content-Type": "application/json", ...operatorHeaders(authApp) },
  );
  expect(created.status).toBe(201);
  return created.body;
}

/**
 * A durable task owned by another workspace, written directly to the
 * projection. Task creation inside an arbitrary workspace is DAT-245; this
 * issue must still serve and isolate records that already carry an owner.
 */
function seedTaskInWorkspace(authApp: AuthApp, workspaceId: string, id: string): void {
  const record = createTaskRecord({
    id,
    workspaceId,
    repository: {
      id: "github:Luthiel/Beta",
      display_name: "Luthiel/Beta",
      base_ref: "main",
      base_sha: "52081eaddca099967fd8be13b3060337fde50d3f",
    },
    summary: "beta workspace task",
    sourceReference: null,
    acceptanceCriteria: [],
  });
  authApp.orchestrator.store.put(record);
}

function cookie(session: LoggedInSession): Record<string, string> {
  return { Cookie: `fp_session=${session.session}` };
}

describe("workspace-scoped task surface (DAT-244)", () => {
  test("lists and reads stay inside the path workspace", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    expect(await grantMembership(authApp, workspaceB, member.userId, "member")).toBe(200);

    const taskA = await createLegacyTask(authApp);
    expect(taskA.workspace_id).toBe(workspaceA);
    seedTaskInWorkspace(authApp, workspaceB, "tsk_ws_b_task");

    const listA = await getJson<{ items: TaskResource[] }>(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks`,
      cookie(member),
    );
    expect(listA.status).toBe(200);
    expect(listA.body.items.map((task) => task.id)).toEqual([taskA.id]);
    expect(listA.body.items[0]?.workspace_id).toBe(workspaceA);

    const listB = await getJson<{ items: TaskResource[] }>(
      `${authApp.base}/api/v1/workspaces/${workspaceB}/tasks`,
      cookie(member),
    );
    expect(listB.status).toBe(200);
    expect(listB.body.items.map((task) => task.id)).toEqual(["tsk_ws_b_task"]);
    expect(listB.body.items[0]?.workspace_id).toBe(workspaceB);

    const readB = await getJson<TaskResource>(
      `${authApp.base}/api/v1/workspaces/${workspaceB}/tasks/tsk_ws_b_task`,
      cookie(member),
    );
    expect(readB.status).toBe(200);
    expect(readB.body.workspace_id).toBe(workspaceB);
  });

  test("run_history_url follows the route family that served the task", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    expect(await grantMembership(authApp, workspaceB, member.userId, "member")).toBe(200);

    const taskA = await createLegacyTask(authApp);
    expect(taskA.run_history_url).toBe(`/api/v1/tasks/${taskA.id}/runs`);
    seedTaskInWorkspace(authApp, workspaceB, "tsk_ws_b_task");

    // Legacy responses keep the historical URL.
    const legacyRead = await getJson<TaskResource>(
      `${authApp.base}/api/v1/tasks/${taskA.id}`,
      cookie(member),
    );
    expect(legacyRead.status).toBe(200);
    expect(legacyRead.body.run_history_url).toBe(`/api/v1/tasks/${taskA.id}/runs`);

    // Scoped responses point at their own workspace, and the URL is usable.
    const scopedA = await getJson<TaskResource>(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${taskA.id}`,
      cookie(member),
    );
    expect(scopedA.status).toBe(200);
    expect(scopedA.body.run_history_url).toBe(
      `/api/v1/workspaces/${workspaceA}/tasks/${taskA.id}/runs`,
    );
    const followed = await getJson(
      `${authApp.base}${scopedA.body.run_history_url}`,
      cookie(member),
    );
    expect(followed.status).toBe(200);

    const scopedB = await getJson<TaskResource>(
      `${authApp.base}/api/v1/workspaces/${workspaceB}/tasks/tsk_ws_b_task`,
      cookie(member),
    );
    expect(scopedB.status).toBe(200);
    expect(scopedB.body.run_history_url).toBe(
      `/api/v1/workspaces/${workspaceB}/tasks/tsk_ws_b_task/runs`,
    );

    const listA = await getJson<{ items: TaskResource[] }>(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks`,
      cookie(member),
    );
    expect(listA.status).toBe(200);
    expect(listA.body.items[0]?.run_history_url).toBe(
      `/api/v1/workspaces/${workspaceA}/tasks/${taskA.id}/runs`,
    );
    const listB = await getJson<{ items: TaskResource[] }>(
      `${authApp.base}/api/v1/workspaces/${workspaceB}/tasks`,
      cookie(member),
    );
    expect(listB.status).toBe(200);
    expect(listB.body.items[0]?.run_history_url).toBe(
      `/api/v1/workspaces/${workspaceB}/tasks/tsk_ws_b_task/runs`,
    );

    // State-changing scoped responses carry the same scoped link.
    const cancelled = await postJson<TaskResource>(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${taskA.id}/cancel`,
      {},
      { "Content-Type": "application/json", ...cookieSessionHeaders(member) },
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.run_history_url).toBe(
      `/api/v1/workspaces/${workspaceA}/tasks/${taskA.id}/runs`,
    );
  });

  test("a foreign task id is 404 on every scoped subresource", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    expect(await grantMembership(authApp, workspaceB, member.userId, "member")).toBe(200);
    seedTaskInWorkspace(authApp, workspaceB, "tsk_foreign");
    const prefix = `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/tsk_foreign`;

    const detail = await getJson<{ error: { code: string } }>(prefix, cookie(member));
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe("TASK_NOT_FOUND");
    for (const path of ["runs", "timeline", "stream"]) {
      const response = await getJson(`${prefix}/${path}`, cookie(member));
      expect(response.status, path).toBe(404);
    }
    const artifact = await getJson(`${prefix}/artifacts/patch_report`, cookie(member));
    expect(artifact.status).toBe(404);
    const cursor = await getJson<{ error: { code: string } }>(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks?cursor=tsk_foreign`,
      cookie(member),
    );
    expect(cursor.status).toBe(404);
    expect(cursor.body.error.code).toBe("TASK_NOT_FOUND");

    for (const [path, body] of [
      ["messages", { mode: "steer", content: "hi" }],
      ["approvals", { decision: "approve", scope_digest: "sha256:x" }],
      ["cancel", {}],
      ["archive", {}],
      ["recover", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const response = await postJson(`${prefix}/${path}`, body, {
        "Content-Type": "application/json",
        ...cookieSessionHeaders(member),
      });
      expect(response.status, path).toBe(404);
    }
  });

  test("unknown, revoked, and non-member workspaces are one indistinguishable 404", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const outsider = await webLogin(authApp);
    for (const workspaceId of [workspaceA, "wsp_does_not_exist"]) {
      const response = await getJson<{ error: { code: string } }>(
        `${authApp.base}/api/v1/workspaces/${workspaceId}/tasks`,
        cookie(outsider),
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }

    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    const read = await getJson(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks`,
      cookie(member),
    );
    expect(read.status).toBe(200);
    const revoke = await fetch(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${workspaceA}/members/${member.userId}`,
      { method: "DELETE", headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    expect(revoke.status).toBe(204);
    const after = await getJson(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks`,
      cookie(member),
    );
    expect(after.status).toBe(404);
  });

  test("GET /api/v1/workspaces lists exactly the caller's live memberships", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    expect(await grantMembership(authApp, workspaceB, member.userId, "viewer")).toBe(200);

    const listed = await getJson<{
      items: Array<{
        id: string;
        name: string;
        role: string;
        repository: { repository_id: string };
      }>;
      next_cursor: string | null;
    }>(`${authApp.base}/api/v1/workspaces`, cookie(member));
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item) => item.id).sort()).toEqual(
      [workspaceA, workspaceB].sort(),
    );
    expect(listed.body.items.find((item) => item.id === workspaceA)?.role).toBe("member");
    expect(listed.body.items.find((item) => item.id === workspaceB)?.role).toBe("viewer");
    expect(listed.body.items.every((item) => item.name.length > 0)).toBe(true);
    expect(listed.body.next_cursor).toBeNull();

    authApp.provider.profile = { id: 1003, login: "workspace-outsider" };
    const outsider = await webLogin(authApp);
    const empty = await getJson<{ items: unknown[] }>(
      `${authApp.base}/api/v1/workspaces`,
      cookie(outsider),
    );
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);
  });

  test("viewer can read but cannot mutate a scoped task", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    const task = await createLegacyTask(authApp);

    authApp.provider.profile = { id: 1002, login: "scoped-viewer" };
    const viewer = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, viewer.userId, "viewer")).toBe(200);

    const read = await getJson(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${task.id}`,
      cookie(viewer),
    );
    expect(read.status).toBe(200);
    const cancel = await postJson(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${task.id}/cancel`,
      {},
      { "Content-Type": "application/json", ...cookieSessionHeaders(viewer) },
    );
    expect(cancel.status).toBe(403);
  });

  test("revoking this workspace's membership closes its live SSE stream", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const member = await webLogin(authApp);
    expect(await grantMembership(authApp, workspaceA, member.userId, "member")).toBe(200);
    expect(await grantMembership(authApp, workspaceB, member.userId, "member")).toBe(200);
    const task = await createLegacyTask(authApp);

    const connected = fetch(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${task.id}/stream`,
      { headers: cookie(member), signal: AbortSignal.timeout(10_000) },
    );
    const ended = connected.then((response) => {
      expect(response.status).toBe(200);
      return response.text();
    });
    await connected;

    const revoke = await fetch(
      `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${workspaceA}/members/${member.userId}`,
      { method: "DELETE", headers: { "X-Bootstrap-Token": BOOTSTRAP_TOKEN } },
    );
    expect(revoke.status).toBe(204);
    await ended;

    const read = await getJson(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${task.id}`,
      cookie(member),
    );
    expect(read.status).toBe(404);
  });

  test("the operator bearer is bound to the configured workspace", async () => {
    const authApp = await app();
    const workspaceA = authApp.workspaceId;
    const workspaceB = addWorkspace(authApp, "Beta").id;
    const task = await createLegacyTask(authApp);

    const allowed = await getJson(
      `${authApp.base}/api/v1/workspaces/${workspaceA}/tasks/${task.id}`,
      operatorHeaders(authApp),
    );
    expect(allowed.status).toBe(200);
    const foreign = await getJson(
      `${authApp.base}/api/v1/workspaces/${workspaceB}/tasks/${task.id}`,
      operatorHeaders(authApp),
    );
    expect(foreign.status).toBe(404);

    const listing = await getJson<{ items: unknown[] }>(
      `${authApp.base}/api/v1/workspaces`,
      operatorHeaders(authApp),
    );
    expect(listing.status).toBe(200);
    expect(listing.body.items).toEqual([]);
  });
});
