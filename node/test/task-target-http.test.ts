import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ControlPlaneDb } from "../src/control-plane/index.js";
import {
  createProviderAccessRepositories,
  createRepositories,
} from "../src/control-plane/index.js";
import type { TaskResource } from "../src/api/task-store.js";
import type { TaskTargetList } from "../src/api/task-targets.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson } from "./helpers/http.js";
import {
  BOOTSTRAP_TOKEN,
  REPOSITORY_ID,
  cookieSessionHeaders,
  startAuthApp,
  webLogin,
} from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";

/**
 * DAT-292: explicit task targets over the real HTTP surface.
 *
 * The task is created by the real orchestrator against the real Go dsh server
 * and the real control-plane database. Set-version conflicts are produced by a
 * concurrent set-version write, not by a mocked resolver, so the refusal the
 * test observes is the one a concurrent repository-set change would cause.
 */

const CAPTURE = process.env["AUTOFIXER_CAPTURE_FIXTURES"] === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "task-target-api-v1");
const BASE_SHA = "52081eaddca099967fd8be13b3060337fde50d3f";

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

async function app(options: { repositoryIntegration?: boolean } = {}): Promise<AuthApp> {
  const created = await startAuthApp({ dsh, ...options });
  apps.push(created);
  return created;
}

function db(authApp: AuthApp): ControlPlaneDb {
  const value = authApp.orchestrator.controlPlane;
  if (value === undefined) {
    throw new Error("control plane missing");
  }
  return value;
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

function createTask(authApp: AuthApp, body: Record<string, unknown>, session: LoggedInSession) {
  return postJson<{ error: { code: string; message: string } } & Partial<TaskResource>>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks`,
    body,
    { "Content-Type": "application/json", ...cookieSessionHeaders(session) },
  );
}

function listTargets(
  authApp: AuthApp,
  session: LoggedInSession,
  workspaceId = authApp.workspaceId,
) {
  return getJson<TaskTargetList & { error: { code: string } }>(
    `${authApp.base}/api/v1/workspaces/${workspaceId}/task-targets`,
    cookieSessionHeaders(session),
  );
}

function bumpSetVersion(authApp: AuthApp): void {
  db(authApp)
    .prepare(
      "UPDATE workspace SET repository_set_version = repository_set_version + 1 WHERE id = ?",
    )
    .run(authApp.workspaceId);
}

/** Pin a verified provider roster entry for the logged-in subject. */
function verifyMember(authApp: AuthApp, userId: string): void {
  const access = createProviderAccessRepositories(db(authApp));
  const scope = {
    enterprise_id: authApp.enterpriseId,
    workspace_id: authApp.workspaceId,
    actor_id: "usr_seed",
  };
  const integration = access.integrations.listByWorkspace(scope)[0];
  if (integration === undefined) {
    throw new Error("repository integration is not seeded");
  }
  access.roster.applySnapshot(scope, integration.id, {
    roles: [
      {
        subject: "1001",
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: "admin",
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
    subject_users: { "1001": userId },
  });
  authApp.orchestrator.providerAuthority?.epoch.bump();
}

function writeFixture(file: string, value: unknown): void {
  if (!CAPTURE) {
    return;
  }
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Normalize only deployment-specific ids and instants, never the shape. The
 * result must still validate against the closed OpenAPI schemas.
 */
function normalizeTask(task: Partial<TaskResource>): Record<string, unknown> {
  const copy = structuredClone(task) as Record<string, unknown>;
  copy["id"] = "tsk_fixture_0001";
  copy["workspace_id"] = "wsp_fixture_0001";
  copy["current_run_id"] = "run_fixture_0001";
  copy["run_history_url"] = "/api/v1/workspaces/wsp_fixture_0001/tasks/tsk_fixture_0001/runs";
  copy["created_at"] = "2026-11-27T12:00:00.000Z";
  copy["updated_at"] = "2026-11-27T12:00:00.000Z";
  const target = copy["target"] as Record<string, unknown> | null;
  if (target !== null) {
    target["binding_id"] = "wrb_fixture_0001";
    target["provider_instance_id"] = "pi_fixture_0001";
    target["installation_ref"] = null;
    target["verified_at"] = "2026-11-27T12:00:00.000Z";
  }
  const association = copy["association"] as Record<string, unknown>;
  association["task_id"] = "tsk_fixture_0001";
  association["run_id"] = "run_fixture_0001";
  return copy;
}

function normalizeTargets(list: TaskTargetList): Record<string, unknown> {
  const copy = structuredClone(list) as unknown as Record<string, unknown>;
  copy["workspace_id"] = "wsp_fixture_0001";
  for (const target of copy["targets"] as Array<Record<string, unknown>>) {
    target["binding_id"] = "wrb_fixture_0001";
    target["provider_instance_id"] = "pi_fixture_0001";
    target["installation_ref"] = null;
  }
  return copy;
}

describe("workspace task targets over HTTP (DAT-292)", () => {
  test("a legacy single-repository create records the immutable target", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, authApp.workspaceId, session.userId, "member")).toBe(200);

    const created = await createTask(
      authApp,
      {
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "legacy create records a target",
      },
      session,
    );
    expect(created.status).toBe(201);
    expect(created.body.target).toMatchObject({
      repository_id: REPOSITORY_ID,
      provider_instance_id: authApp.providerInstanceId,
      installation_ref: null,
      base_ref: "main",
      base_sha: BASE_SHA,
      set_version: 1,
    });
    expect(created.body.target?.binding_id).toMatch(/^wrb_/);
    expect(created.body.repository_set_version).toBe(1);

    const detail = await getJson<Partial<TaskResource>>(
      `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks/${created.body.id}`,
      cookieSessionHeaders(session),
    );
    expect(detail.status).toBe(200);
    expect(detail.body.target).toEqual(created.body.target);

    const runs = await getJson<{
      items: Array<{ target: unknown; repository_set_version: unknown }>;
    }>(
      `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks/${created.body.id}/runs`,
      cookieSessionHeaders(session),
    );
    expect(runs.status).toBe(200);
    expect(runs.body.items[0]?.target).toEqual(created.body.target);
    expect(runs.body.items[0]?.repository_set_version).toBe(1);

    writeFixture("task-with-target.json", normalizeTask(created.body));
  });

  test("the target list and an explicit create agree on the immutable identity", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, authApp.workspaceId, session.userId, "member")).toBe(200);

    const targets = await listTargets(authApp, session);
    expect(targets.status).toBe(200);
    expect(targets.body.selection_required).toBe(false);
    expect(targets.body.repository_set_version).toBe(1);
    expect(targets.body.usable).toBe(true);
    expect(targets.body.targets).toHaveLength(1);
    const candidate = targets.body.targets[0]!;
    expect(candidate).toMatchObject({
      repository_id: REPOSITORY_ID,
      provider_instance_id: authApp.providerInstanceId,
      installation_ref: null,
      baseline: { state: "trusted", base_ref: "main", base_sha: BASE_SHA },
    });

    const created = await createTask(
      authApp,
      {
        target: {
          repository_id: candidate.repository_id,
          provider_instance_id: candidate.provider_instance_id,
          installation_ref: candidate.installation_ref,
          base_ref: "main",
          expected_set_version: targets.body.repository_set_version,
        },
        summary: "explicit target create",
      },
      session,
    );
    expect(created.status).toBe(201);
    expect(created.body.target).toMatchObject({
      binding_id: candidate.binding_id,
      repository_id: candidate.repository_id,
      provider_instance_id: candidate.provider_instance_id,
      installation_ref: null,
      set_version: 1,
    });

    writeFixture("task-targets.json", normalizeTargets(targets.body));
  });

  test("a stale observed set version refuses instead of re-resolving the target", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, authApp.workspaceId, session.userId, "member")).toBe(200);

    bumpSetVersion(authApp);
    const refused = await createTask(
      authApp,
      {
        target: {
          repository_id: REPOSITORY_ID,
          provider_instance_id: authApp.providerInstanceId,
          installation_ref: null,
          base_ref: "main",
          expected_set_version: 1,
        },
        summary: "stale target selection",
      },
      session,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("REPOSITORY_SET_VERSION_CONFLICT");
  });

  test("tampered identity, unknown repository and a changed baseline are distinct refusals", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, authApp.workspaceId, session.userId, "member")).toBe(200);

    const wrongProvider = await createTask(
      authApp,
      {
        target: {
          repository_id: REPOSITORY_ID,
          provider_instance_id: "pi_not_this_workspace",
          installation_ref: null,
          base_ref: "main",
          expected_set_version: 1,
        },
        summary: "wrong provider",
      },
      session,
    );
    expect(wrongProvider.status).toBe(409);
    expect(wrongProvider.body.error.code).toBe("TARGET_IDENTITY_MISMATCH");

    const wrongRepository = await createTask(
      authApp,
      {
        target: {
          repository_id: "github:other/tenant",
          provider_instance_id: authApp.providerInstanceId,
          installation_ref: null,
          base_ref: "main",
          expected_set_version: 1,
        },
        summary: "wrong repository",
      },
      session,
    );
    expect(wrongRepository.status).toBe(400);
    expect(wrongRepository.body.error.code).toBe("REPOSITORY_NOT_IN_WORKSPACE");

    const wrongBaseline = await createTask(
      authApp,
      {
        target: {
          repository_id: REPOSITORY_ID,
          provider_instance_id: authApp.providerInstanceId,
          installation_ref: null,
          base_ref: "main",
          expected_set_version: 1,
          expected_base_sha: "b".repeat(40),
        },
        summary: "changed baseline",
      },
      session,
    );
    expect(wrongBaseline.status).toBe(409);
    expect(wrongBaseline.body.error.code).toBe("TARGET_BASELINE_MISMATCH");
  });

  test("the approved installation is required once the workspace has an integration", async () => {
    const authApp = await app({ repositoryIntegration: true });
    const session = await webLogin(authApp);
    verifyMember(authApp, session.userId);
    expect(await grantMembership(authApp, authApp.workspaceId, session.userId, "member")).toBe(200);

    const targets = await listTargets(authApp, session);
    expect(targets.status).toBe(200);
    const candidate = targets.body.targets[0]!;
    expect(candidate.installation_ref).toMatch(/^sint_/);

    const omitted = await createTask(
      authApp,
      {
        target: {
          repository_id: candidate.repository_id,
          provider_instance_id: candidate.provider_instance_id,
          installation_ref: null,
          base_ref: "main",
          expected_set_version: targets.body.repository_set_version,
        },
        summary: "missing installation",
      },
      session,
    );
    expect(omitted.status).toBe(409);
    expect(omitted.body.error.code).toBe("TARGET_IDENTITY_MISMATCH");

    const created = await createTask(
      authApp,
      {
        target: {
          repository_id: candidate.repository_id,
          provider_instance_id: candidate.provider_instance_id,
          installation_ref: candidate.installation_ref,
          base_ref: "main",
          expected_set_version: targets.body.repository_set_version,
        },
        summary: "installation-bound target",
      },
      session,
    );
    expect(created.status).toBe(201);
    expect(created.body.target).toMatchObject({
      installation_ref: candidate.installation_ref,
    });
  });

  test("another workspace is not an enumeration oracle for targets", async () => {
    const authApp = await app();
    const session = await webLogin(authApp);
    expect(await grantMembership(authApp, authApp.workspaceId, session.userId, "member")).toBe(200);
    const other = createRepositories(db(authApp)).workspaces.create(
      {
        enterprise_id: authApp.enterpriseId,
        actor_id: "usr_seed",
      },
      {
        name: "Other",
        repository_id: "github:acme/other",
        provider_instance_id: authApp.providerInstanceId,
      },
    );

    const refused = await listTargets(authApp, session, other.id);
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe("NOT_FOUND");
  });
});
