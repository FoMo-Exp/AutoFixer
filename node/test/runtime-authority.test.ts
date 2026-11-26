/**
 * Runtime authorization and loss propagation (DAT-285).
 *
 * Three surfaces that used to decide once and never again:
 *
 * - a running remediation run's sensitive steps (`dsh_request_action`) are
 *   re-authorized from durable state immediately before every dispatch, so a
 *   confirmed downgrade, a revocation, an outage or a repository-set change
 *   stops the next action — in this process, another process, or after a
 *   restart;
 * - approval eligibility is the workspace-wide capability intersection, not
 *   the best single repository's roster fact;
 * - unknown authority (an outage) stays distinct from a confirmed loss: one
 *   blocks the step, the other also ends the run.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson, waitUntil } from "./helpers/http.js";
import type { ScriptedTurn } from "./helpers/scripted-stream.js";
import {
  addMember,
  NOW,
  REPO_ID,
  setupFixture,
  verifyAuthority,
} from "./helpers/provider-access.js";
import type { Fixture } from "./helpers/provider-access.js";
import { createApprovalDirectory } from "../src/api/collab-authority.js";
import { createRunStepAuthority } from "../src/api/run-step-authority.js";
import { createRequestAuthority } from "../src/api/request-authority.js";
import { createTaskRecord, TaskStore } from "../src/api/task-store.js";
import type { TaskResource, TimelineItem } from "../src/api/task-store.js";
import type { DshClient } from "../src/dsh/client.js";
import { createDshRequestActionTool } from "../src/pi/dsh-request-action-tool.js";
import type { ActionObservation } from "../src/pi/dsh-request-action-tool.js";
import {
  createProviderAccessRepositories,
  createWorkspaceRepositorySetRepository,
} from "../src/control-plane/index.js";
import type { ProviderAccessRepositories, ServiceIntegration } from "../src/control-plane/index.js";
import type { WorkspaceScope } from "../src/control-plane/types.js";

const REPOSITORY_ID = "github:FoMo-Exp/AutoFixer";
const SUBJECT = "1001";
const BOOTSTRAP = { "X-Bootstrap-Token": "test-bootstrap-token-0123456789abcdef0123456789abcdef" };

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 120_000);

afterAll(async () => {
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
  await dsh.stop();
});

async function app(turns: ScriptedTurn[] = []): Promise<AuthApp> {
  const created = await startAuthApp({ dsh, turns });
  apps.push(created);
  return created;
}

interface ToolTurn {
  kind: "tool";
  toolId: string;
  args: Record<string, unknown>;
  pathScope: string[];
}

function echoTurn(): ToolTurn {
  return {
    kind: "tool",
    toolId: "echo",
    args: { message: "hello" },
    pathScope: ["node/package.json"],
  };
}

/**
 * A tool that occupies dsh for long enough to change authority between two
 * model turns. The real dsh `sleep` profile is the only slow, allow-listed
 * tool; its completion is a real event, not a timed guess.
 */
function sleepTurn(): ToolTurn {
  return {
    kind: "tool",
    toolId: "sleep",
    args: { seconds: "5" },
    pathScope: ["node/package.json"],
  };
}

async function grantRole(authApp: AuthApp, userId: string, role: string): Promise<number> {
  const response = await fetch(
    `${authApp.base}/api/v1/admin/enterprises/${authApp.enterpriseId}/workspaces/${authApp.workspaceId}/members/${userId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...BOOTSTRAP },
      body: JSON.stringify({ role }),
    },
  );
  return response.status;
}

interface BoundaryFixture {
  access: ProviderAccessRepositories;
  integration: ServiceIntegration;
  scope: WorkspaceScope;
}

/** Install the workspace integration and verify the login's subject role. */
function installIntegration(
  authApp: AuthApp,
  userId: string,
  options: { providerRole?: string } = {},
): BoundaryFixture {
  const db = authApp.orchestrator.controlPlane;
  if (!db) {
    throw new Error("control plane missing");
  }
  const access = createProviderAccessRepositories(db);
  const scope: WorkspaceScope = {
    enterprise_id: authApp.enterpriseId,
    workspace_id: authApp.workspaceId,
    actor_id: "usr_test_operator",
  };
  const integration = access.integrations.create(scope, {
    provider_instance_id: authApp.providerInstanceId,
    repository_id: REPOSITORY_ID,
    repository_name: "FoMo-Exp/AutoFixer",
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
        provider_role: options.providerRole ?? "write",
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
    subject_users: { [SUBJECT]: userId },
  });
  return { access, integration, scope };
}

function setProviderRole(fixture: BoundaryFixture, providerRole: string): void {
  // Deliberately no local epoch bump: this is what another process's
  // reconciliation looks like to this one. The step policy reads the roster
  // row itself, so no in-memory signal is involved.
  fixture.access.roster.applySnapshot(fixture.scope, fixture.integration.id, {
    roles: [
      {
        subject: SUBJECT,
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: providerRole,
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: new Date().toISOString(),
  });
}

/** Bump the workspace's repository-set version through the storage writer. */
function bumpSetVersion(authApp: AuthApp): void {
  const db = authApp.orchestrator.controlPlane;
  if (!db) {
    throw new Error("control plane missing");
  }
  db.prepare(
    "UPDATE workspace SET repository_set_version = repository_set_version + 1 WHERE id = ?",
  ).run(authApp.workspaceId);
}

/** Create and approve one workspace-scoped task; Pi starts on approval. */
async function createRunningTask(
  authApp: AuthApp,
  session: LoggedInSession,
): Promise<TaskResource> {
  const created = await postJson<TaskResource>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks`,
    { repository_id: REPOSITORY_ID, base_ref: "main", summary: "worker step probe" },
    { "Content-Type": "application/json", ...cookieSessionHeaders(session) },
  );
  expect(created.status).toBe(201);
  const timeline = await getJson<{ items: TimelineItem[] }>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks/${created.body.id}/timeline`,
    cookieSessionHeaders(session),
  );
  const required = timeline.body.items.find((event) => event.type === "approval.required");
  const approved = await postJson<TaskResource>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks/${created.body.id}/approvals`,
    { decision: "approve", scope_digest: String(required?.data["scope_digest"]) },
    { "Content-Type": "application/json", ...cookieSessionHeaders(session) },
  );
  expect(approved.status).toBe(200);
  return approved.body;
}

async function timelineOf(
  authApp: AuthApp,
  session: LoggedInSession,
  taskId: string,
): Promise<TimelineItem[]> {
  const response = await getJson<{ items: TimelineItem[] }>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks/${taskId}/timeline`,
    cookieSessionHeaders(session),
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function taskOf(
  authApp: AuthApp,
  session: LoggedInSession,
  taskId: string,
): Promise<TaskResource> {
  const response = await getJson<TaskResource>(
    `${authApp.base}/api/v1/workspaces/${authApp.workspaceId}/tasks/${taskId}`,
    cookieSessionHeaders(session),
  );
  expect(response.status).toBe(200);
  return response.body;
}

/**
 * Create and approve one workspace-scoped task, wait until the first (slow)
 * action is executing in dsh, and return the task. Authority can be changed
 * here: the next model turn's step is evaluated afterwards.
 */
async function startFirstAction(authApp: AuthApp, session: LoggedInSession): Promise<TaskResource> {
  const task = await createRunningTask(authApp, session);
  await waitUntil(
    async () =>
      (await timelineOf(authApp, session, task.id)).some((e) => e.type === "tool.requested"),
    "the first action to start",
  );
  return task;
}

async function waitForDenial(
  authApp: AuthApp,
  session: LoggedInSession,
  taskId: string,
): Promise<TimelineItem> {
  await waitUntil(
    async () => (await timelineOf(authApp, session, taskId)).some((e) => e.type === "tool.denied"),
    "the next action to be denied before dispatch",
  );
  const events = await timelineOf(authApp, session, taskId);
  const denied = events.find((event) => event.type === "tool.denied");
  if (denied === undefined) {
    throw new Error("no denied step recorded");
  }
  return denied;
}

describe("a running run re-authorizes every sensitive step", () => {
  test("a confirmed downgrade mid-run denies the next action and stops the run", async () => {
    const authApp = await app([sleepTurn(), echoTurn()]);
    const session = await webLogin(authApp);
    expect(await grantRole(authApp, session.userId, "owner")).toBe(200);
    const fixture = installIntegration(authApp, session.userId, { providerRole: "write" });

    const task = await startFirstAction(authApp, session);

    // While the first action executes, the provider now proves read only: a
    // confirmed reduction, persisted by the ceiling on its next evaluation.
    // This process received no authority event.
    setProviderRole(fixture, "read");

    // The first (slow) action still completes — its dispatch predates the
    // change — and the *next* step is refused.
    await waitUntil(
      async () =>
        (await timelineOf(authApp, session, task.id)).some((e) => e.type === "tool.completed"),
      "the first action to complete",
    );
    const denied = await waitForDenial(authApp, session, task.id);
    expect(denied.data["error_code"]).toBe("FORBIDDEN");
    expect(String(denied.data["message"])).toContain("no longer permits");
    const events = await timelineOf(authApp, session, task.id);
    // Exactly one action ever reached dsh; the downgraded step dispatched
    // nothing, regardless of what the model tried.
    expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(1);

    // A confirmed loss ends the run: dsh records the authoritative
    // cancellation the service requested after the denial.
    await waitUntil(async () => {
      const current = await taskOf(authApp, session, task.id);
      return current.status === "cancelled" || current.status === "stopped";
    }, "the run to be stopped after the confirmed loss");
  }, 60_000);

  test("unverifiable authority denies the step without recording a revocation", async () => {
    const authApp = await app([sleepTurn(), echoTurn()]);
    const session = await webLogin(authApp);
    expect(await grantRole(authApp, session.userId, "owner")).toBe(200);
    const fixture = installIntegration(authApp, session.userId, { providerRole: "write" });

    const task = await startFirstAction(authApp, session);

    // A transfer/outage resets authority to `unknown`: not a confirmed loss.
    fixture.access.roster.resetAuthority(
      fixture.scope,
      fixture.integration.id,
      new Date().toISOString(),
    );

    // The member's own reads fail closed for the duration of the outage, so
    // the outcome is observed through the deployment's own credential.
    const operator = { Authorization: `Bearer ${authApp.orchestrator.apiToken}` };
    const operatorTimeline = async (): Promise<TimelineItem[]> => {
      const response = await getJson<{ items: TimelineItem[] }>(
        `${authApp.base}/api/v1/tasks/${task.id}/timeline`,
        operator,
      );
      expect(response.status).toBe(200);
      return response.body.items;
    };
    await waitUntil(
      async () => (await operatorTimeline()).some((e) => e.type === "tool.denied"),
      "the next action to be blocked pending reconciliation",
    );
    const events = await operatorTimeline();
    const denied = events.find((event) => event.type === "tool.denied");
    expect(denied?.data["error_code"]).toBe("AUTHORITY_RECHECK_REQUIRED");
    expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(1);

    // The outage is not recorded as a confirmed removal: the task is not
    // cancelled by the denial.
    const current = await getJson<TaskResource>(
      `${authApp.base}/api/v1/tasks/${task.id}`,
      operator,
    );
    expect(current.status).toBe(200);
    expect(current.body.status).not.toBe("cancelled");
  }, 60_000);

  test("a repository-set change invalidates the set the run was bound to", async () => {
    const authApp = await app([sleepTurn(), echoTurn()]);
    const session = await webLogin(authApp);
    expect(await grantRole(authApp, session.userId, "owner")).toBe(200);
    installIntegration(authApp, session.userId, { providerRole: "write" });

    const task = await startFirstAction(authApp, session);

    // A later binding change bumps the workspace's set version; the run's
    // decision was formed against the old one and is refused.
    bumpSetVersion(authApp);

    const denied = await waitForDenial(authApp, session, task.id);
    expect(denied.data["error_code"]).toBe("REPOSITORY_SET_VERSION_CONFLICT");
  }, 60_000);
});

describe("approval eligibility is the workspace-wide intersection", () => {
  test("an admin whose verified intersection lacks repository write cannot approve", () => {
    const fixture = setupFixture();
    const member = addMember(fixture, { subject: "7001", login: "admin", role: "admin" });
    verifyAuthority(fixture, "7001", member.userId, NOW, { provider_role: "write" });
    const scope = {
      enterprise_id: fixture.scope.enterprise_id,
      workspace_id: fixture.workspaceId,
    };
    const directory = createApprovalDirectory({
      enterprise_id: fixture.scope.enterprise_id,
      memberships: fixture.memberships,
      users: fixture.users,
      identities: fixture.identities,
      access: fixture.access,
      clock: () => fixture.clock.now,
      workspaceActionAllowed: (input) =>
        fixture.gate.authorize({
          scope: { ...fixture.scope, workspace_id: input.workspace_id },
          user_id: input.user_id,
          action: input.action,
        }).allowed,
    });

    expect(directory.member(scope, REPO_ID, member.userId)?.repository_access).toBe(true);

    // A verified downgrade to read-only limits the whole workspace action
    // ceiling: the admin role and the issue repository's roster fact are not
    // enough to approve.
    verifyAuthority(fixture, "7001", member.userId, NOW, { provider_role: "read" });
    expect(directory.member(scope, REPO_ID, member.userId)?.repository_access).toBe(false);
  });
});

describe("the action tool never dispatches a denied step", () => {
  test("a denied re-authorization records the denial and calls nothing", async () => {
    const calls: unknown[] = [];
    const client = {
      submitAction: async () => {
        calls.push("submitted");
        throw new Error("must not be called");
      },
    } as unknown as DshClient;
    const observations: ActionObservation[] = [];
    const tool = createDshRequestActionTool({
      client,
      runId: "run_test",
      sessionId: "pis_test",
      getTurnId: () => "turn_1",
      observe: (observation) => observations.push(observation),
      authorizeStep: () => ({
        allowed: false,
        code: "FORBIDDEN",
        message:
          "The run's repository authority no longer permits this action; nothing was dispatched.",
      }),
    });

    await expect(
      tool.execute("call_1", {
        tool_id: "echo",
        arguments: { message: "hello" },
        path_scope: ["node/package.json"],
        rationale: "probe",
      }),
    ).rejects.toThrow("no longer permits");
    expect(calls).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ outcome: "denied", errorCode: "FORBIDDEN" });
  });
});

describe("the run-step policy", () => {
  function authorityFor(fixture: Fixture) {
    return createRequestAuthority({
      access: fixture.access,
      memberships: fixture.memberships,
      workspaces: fixture.workspaces,
      users: fixture.users,
      identities: fixture.identities,
      enterpriseUsers: fixture.identity.enterpriseUsers,
      capabilityCeilings: fixture.capabilityCeilings,
      epoch: fixture.epoch,
      enterpriseId: fixture.scope.enterprise_id,
      workspaceId: fixture.workspaceId,
      clock: () => fixture.clock.now,
    });
  }

  function policyFor(fixture: Fixture) {
    return createRunStepAuthority({
      enterpriseId: fixture.scope.enterprise_id,
      actorId: "usr_step",
      repositorySets: createWorkspaceRepositorySetRepository(fixture.db),
      authority: authorityFor(fixture),
    });
  }

  function currentSetVersion(fixture: Fixture): number {
    return createWorkspaceRepositorySetRepository(fixture.db).currentSetVersion({
      enterprise_id: fixture.scope.enterprise_id,
      workspace_id: fixture.workspaceId,
      actor_id: "usr_step",
    });
  }

  test("a confirmed loss is terminal, an outage is not", () => {
    const fixture = setupFixture();
    const member = addMember(fixture, { subject: "8001", login: "worker", role: "member" });
    verifyAuthority(fixture, "8001", member.userId, NOW, { provider_role: "write" });
    const policy = policyFor(fixture);
    const input = {
      enterprise_id: fixture.scope.enterprise_id,
      workspace_id: fixture.workspaceId,
      repository_id: REPO_ID,
      requested_by: { kind: "session" as const, user_id: member.userId },
      repository_set_version: null,
    };
    expect(policy(input)).toEqual({ allowed: true });

    fixture.access.roster.resetAuthority(
      fixture.scope,
      fixture.integration.id,
      new Date(NOW).toISOString(),
    );
    expect(policy(input)).toMatchObject({
      allowed: false,
      code: "AUTHORITY_RECHECK_REQUIRED",
      terminal: false,
    });

    verifyAuthority(fixture, "8001", member.userId, NOW, { provider_role: "read" });
    expect(policy(input)).toMatchObject({ allowed: false, code: "FORBIDDEN", terminal: true });
  });

  test("a record without a requester fails closed only where authority governs", () => {
    const enforcing = setupFixture();
    addMember(enforcing, { subject: "8002", login: "worker", role: "member" });
    const input = {
      enterprise_id: enforcing.scope.enterprise_id,
      workspace_id: enforcing.workspaceId,
      repository_id: REPO_ID,
      requested_by: null,
      repository_set_version: null,
    };
    expect(policyFor(enforcing)(input)).toMatchObject({
      allowed: false,
      code: "AUTHORITY_RECHECK_REQUIRED",
    });

    // The identity-less deployment has no provider roster at all: the dsh
    // grant remains the boundary and the deployment credential is admitted.
    const prototype = setupFixture();
    prototype.access.integrations.listByWorkspace = () => [];
    expect(policyFor(prototype)(input)).toEqual({ allowed: true });
    expect(policyFor(prototype)({ ...input, requested_by: { kind: "deployment" } })).toEqual({
      allowed: true,
    });
  });

  test("a changed repository set is a terminal refusal", () => {
    const fixture = setupFixture();
    const member = addMember(fixture, { subject: "8003", login: "worker", role: "member" });
    verifyAuthority(fixture, "8003", member.userId, NOW, { provider_role: "write" });
    expect(
      policyFor(fixture)({
        enterprise_id: fixture.scope.enterprise_id,
        workspace_id: fixture.workspaceId,
        repository_id: REPO_ID,
        requested_by: { kind: "session", user_id: member.userId },
        repository_set_version: currentSetVersion(fixture) + 1,
      }),
    ).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_VERSION_CONFLICT",
      terminal: true,
    });
  });
});

describe("the run requester and set version survive persistence", () => {
  test("a schema-4 projection round-trips and schema-3 invents neither fact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "task-store-285-"));
    const file = path.join(dir, "tasks.json");
    const options = {
      persistencePath: file,
      legacyWorkspaceId: "wsp_legacy",
      legacyEnterpriseId: "ent_legacy",
    };
    const store = new TaskStore(options);
    const record = createTaskRecord({
      id: "tsk_persisted",
      workspaceId: "wsp_legacy",
      enterpriseId: "ent_legacy",
      repository: {
        id: "github:acme/Alpha",
        display_name: "acme/Alpha",
        base_ref: "main",
        base_sha: "a".repeat(40),
      },
      summary: "persisted",
      sourceReference: null,
      acceptanceCriteria: [],
      requestedBy: { kind: "session", user_id: "usr_1" },
      repositorySetVersion: 4,
    });
    store.put(record);
    store.flushSync();

    const reloaded = new TaskStore(options);
    expect(reloaded.get("tsk_persisted")?.requestedBy).toEqual({
      kind: "session",
      user_id: "usr_1",
    });
    expect(reloaded.get("tsk_persisted")?.repositorySetVersion).toBe(4);

    // A projection written before this field existed must not invent a
    // requester or a set version: the step policy then refuses where provider
    // authority governs.
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      schema_version: number;
      tasks: Array<Record<string, unknown>>;
    };
    raw.schema_version = 3;
    for (const task of raw.tasks) {
      delete task["requestedBy"];
      delete task["repositorySetVersion"];
    }
    writeFileSync(file, JSON.stringify(raw));
    const legacy = new TaskStore(options);
    expect(legacy.get("tsk_persisted")?.requestedBy).toBeNull();
    expect(legacy.get("tsk_persisted")?.repositorySetVersion).toBeNull();
  });
});
