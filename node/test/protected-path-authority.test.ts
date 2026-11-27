/**
 * Protected-path runtime authorization (DAT-294, ADR-0011).
 *
 * Every protected path — task reads, the legacy seam, SSE (including replay),
 * artifacts, approvals, messages, issues, memory and delivery — decides from
 * the **complete** active repository set, the applicable target and the
 * observed version. These tests drive real HTTP against a build configured for
 * complete-set enforcement (the deployment mode a rollout release ships with;
 * the immutable gate row still has to say `enabled`) and pin:
 *
 * - the intersection over every repository bounds each action — write on A and
 *   read on B is read, never write;
 * - a resource is decided against its own target, so a repository that left
 *   the set stops authorizing the resources that belong to it;
 * - a set change invalidates a live subscription and refuses a stale observed
 *   version instead of streaming or authorizing under the old scope;
 * - an unavailable authority blocks every path and never becomes a recorded
 *   loss, and the advisory frontend projection is never a credential;
 * - the same decisions hold after a process restart (nothing is cached).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { getJson, postJson } from "./helpers/http.js";
import type { JsonResponse } from "./helpers/http.js";
import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
  seedProviderInstance,
  type ControlPlaneDb,
  type EnterpriseScope,
  type ProviderAccessRepositories,
  type WorkspaceScope,
} from "../src/control-plane/index.js";
import { bumpRepositorySetVersion } from "../src/control-plane/workspace-repository-repositories.js";

const REPOSITORY_ID = "github:FoMo-Exp/AutoFixer";
const REPO_B = "gitlab:acme/service";
const BASE_SHA = "52081eaddca099967fd8be13b3060337fde50d3f";
/** The fake GitHub login's provider subject. */
const GITHUB_SUBJECT = "1001";
const GITLAB_SUBJECT = "9501";

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 180_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

function nowIso(): string {
  return new Date().toISOString();
}

function enableGate(db: ControlPlaneDb): void {
  db.prepare(
    `INSERT INTO deployment_feature_gate
       (key, min_schema_version, state, reason, created_at, created_by)
     VALUES (?, ?, 'enabled', ?, ?, ?)`,
  ).run(
    MULTI_REPOSITORY_GATE_KEY,
    CURRENT_SCHEMA_VERSION,
    "test fixture: a build that enforces the whole set",
    nowIso(),
    "usr_auth_system",
  );
}

function insertSecondBinding(
  db: ControlPlaneDb,
  scope: WorkspaceScope,
  providerInstanceId: string,
  installationRef: string,
): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO workspace_repository_binding
       (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
        repository_id, repository_url, repository_name, position, status,
        created_at, updated_at, created_by, updated_by, version)
     VALUES ('wrb_second', ?, ?, ?, ?, ?, 'https://gitlab.com/acme/service.git', 'acme/service', 2, 'active', ?, ?, ?, ?, 1)`,
  ).run(
    scope.enterprise_id,
    scope.workspace_id,
    providerInstanceId,
    installationRef,
    REPO_B,
    at,
    at,
    scope.actor_id,
    scope.actor_id,
  );
}

interface TwoRepository {
  app: AuthApp;
  db: ControlPlaneDb;
  session: LoggedInSession;
  scope: WorkspaceScope;
  adminScope: EnterpriseScope;
  access: ProviderAccessRepositories;
  integrationA: string;
  gitlabInstanceId: string;
  integrationB: string;
}

/**
 * A real orchestrator in complete-set enforcement mode over two repositories:
 * the deployment's pinned repository A (GitHub) and a second GitLab
 * repository B, both with verified provider evidence for the login.
 *
 * The gate row is appended exactly as a forward migration would; nothing here
 * enables a production switch (the shipped deployment passes no enforcement
 * option and keeps the refusing default).
 */
async function startTwoRepository(
  options: { githubRole?: string; gitlabRole?: string } = {},
): Promise<TwoRepository> {
  const app = await startAuthApp({
    dsh,
    repositoryIntegration: true,
    multiRepositoryEnforcement: "complete",
  });
  apps.push(app);
  const db = app.orchestrator.controlPlane as ControlPlaneDb;
  const session = await webLogin(app);
  const repos = createRepositories(db);
  const access = createProviderAccessRepositories(db);
  const scope: WorkspaceScope = {
    enterprise_id: app.enterpriseId,
    workspace_id: app.workspaceId,
    actor_id: "usr_test_operator",
  };
  const adminScope: EnterpriseScope = {
    enterprise_id: app.enterpriseId,
    actor_id: "usr_test_operator",
  };
  const integrationA = app.integration;
  if (integrationA === undefined) {
    throw new Error("fixture requires the seeded GitHub integration");
  }
  enableGate(db);
  repos.memberships.create(scope, { user_id: session.userId, role: "owner" });

  // The workspace's own repository keeps its pinned baseline, but a run that
  // selects it from a set of several must still hold its own delivery
  // capability (DAT-293).
  db.prepare(
    `UPDATE service_integration SET checkout_credential_ref = ?, delivery_credential_ref = ? WHERE id = ?`,
  ).run("svc-checkout-a", "svc-delivery-a", integrationA.id);
  const at = nowIso();
  access.roster.applySnapshot(scope, integrationA.id, {
    roles: [
      {
        subject: GITHUB_SUBJECT,
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: options.githubRole ?? "admin",
        authority_ref: REPOSITORY_ID,
        inherited_from: null,
      },
    ],
    verified_at: at,
  });

  const gitlab = seedProviderInstance(db, adminScope, {
    provider_type: "gitlab",
    origin_url: "https://gitlab.com",
  });
  const integrationB = access.integrations.create(scope, {
    provider_instance_id: gitlab.id,
    repository_id: REPO_B,
    repository_name: "acme/service",
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    delivery_credential_ref: "svc-delivery-b",
    permission_visibility: "full",
    actor_id: "usr_test_operator",
  });
  // The same human's GitLab identity: the intersection is over one member's
  // evidence on every repository, never one login's roles.
  createIdentityRepositories(db).identities.create({
    user_id: session.userId,
    provider_instance_id: gitlab.id,
    subject: GITLAB_SUBJECT,
    login: "gitlab-user",
    actor_id: "usr_test_operator",
  });
  access.roster.applySnapshot(scope, integrationB.id, {
    roles: [
      {
        subject: GITLAB_SUBJECT,
        login: "gitlab-user",
        source_kind: "direct_collaborator",
        provider_role: options.gitlabRole ?? "developer",
        authority_ref: REPO_B,
        inherited_from: null,
      },
    ],
    verified_at: at,
  });

  insertSecondBinding(db, scope, gitlab.id, integrationB.id);
  bumpRepositorySetVersion(db, adminScope, app.workspaceId);

  return {
    app,
    db,
    session,
    scope,
    adminScope,
    access,
    integrationA: integrationA.id,
    gitlabInstanceId: gitlab.id,
    integrationB: integrationB.id,
  };
}

function cookie(fx: TwoRepository): Record<string, string> {
  return cookieSessionHeaders(fx.session);
}

function workspaceUrl(fx: TwoRepository): string {
  return `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}`;
}

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}

function errorOf(response: JsonResponse<unknown>): ErrorBody["error"] {
  return (response.body as ErrorBody).error;
}

interface CreatedTask {
  id: string;
  target: {
    repository_id: string;
    provider_instance_id: string;
    installation_ref: string | null;
    set_version: number;
  } | null;
  repository_set_version: number | null;
}

/** Create a task against repository A (the deployment's pinned baseline). */
async function createTaskOnA(fx: TwoRepository): Promise<JsonResponse<CreatedTask>> {
  return postJson<CreatedTask>(
    `${workspaceUrl(fx)}/tasks`,
    {
      target: {
        repository_id: REPOSITORY_ID,
        provider_instance_id: fx.app.providerInstanceId,
        installation_ref: fx.integrationA,
        base_ref: "main",
        expected_set_version: 2,
      },
      summary: "protected-path authority probe",
      acceptance_criteria: ["none"],
    },
    cookie(fx),
  );
}

describe("complete-set enforcement on every protected path (DAT-294)", () => {
  test("the intersection over every repository bounds each action", async () => {
    // Write on A, read on B: the workspace intersection is read.
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "reporter" });
    const ws = workspaceUrl(fx);

    const tasks = await getJson<{ items: unknown[] }>(`${ws}/tasks`, cookie(fx));
    expect(tasks.status).toBe(200);

    const created = await createTaskOnA(fx);
    expect(created.status).toBe(403);
    expect(errorOf(created)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "write", reason: "capability_ceiling" },
    });

    // Approvals demand repository_write on every repository too.
    const approval = await postJson<ErrorBody>(
      `${ws}/tasks/task_any/approvals`,
      { decision: "approved" },
      cookie(fx),
    );
    expect(approval.status).toBe(403);
    expect(errorOf(approval).code).toBe("FORBIDDEN");

    // A delivery/approval action on an issue is decided the same way.
    const delivery = await postJson<ErrorBody>(`${ws}/issues/issue_any/deliveries`, {}, cookie(fx));
    expect(delivery.status).toBe(403);
    expect(errorOf(delivery).details?.action).toBe("delivery");

    // Workspace memory is bounded by the same intersection: reading needs
    // code_read everywhere (allowed), writing needs repository_write (denied).
    expect((await getJson(`${ws}/memory/items`, cookie(fx))).status).toBe(200);
    const feedback = await postJson<ErrorBody>(`${ws}/memory/feedback`, {}, cookie(fx));
    expect(feedback.status).toBe(403);
    expect(errorOf(feedback).details?.action).toBe("write");

    // Issues reads are ordinary workspace reads and stay available.
    expect((await getJson(`${ws}/issues`, cookie(fx))).status).toBe(200);
  });

  test("with authority on both repositories a targeted task is served, streamed and steered", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);

    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const task = created.body;
    expect(task.target).toMatchObject({
      repository_id: REPOSITORY_ID,
      provider_instance_id: fx.app.providerInstanceId,
      installation_ref: fx.integrationA,
      set_version: 2,
    });
    expect(task.repository_set_version).toBe(2);

    // Read, runs, timeline and artifact routes all decide against the task's
    // target and the complete set.
    expect((await getJson(`${ws}/tasks/${task.id}`, cookie(fx))).status).toBe(200);
    expect((await getJson(`${ws}/tasks/${task.id}/runs`, cookie(fx))).status).toBe(200);
    expect((await getJson(`${ws}/tasks/${task.id}/timeline`, cookie(fx))).status).toBe(200);
    const artifact = await getJson<ErrorBody>(
      `${ws}/tasks/${task.id}/artifacts/art_missing`,
      cookie(fx),
    );
    // The authority allowed the action; the artifact itself does not exist.
    expect(artifact.status).toBe(404);

    // A write action on the task is authorized by the boundary; the route's
    // own state machine then answers (no live Pi session yet), never a 403.
    const cancel = await postJson<ErrorBody>(
      `${ws}/tasks/${task.id}/cancel`,
      { reason: "authority probe" },
      cookie(fx),
    );
    expect(cancel.status).toBe(202);
    const message = await postJson<ErrorBody>(
      `${ws}/tasks/${task.id}/messages`,
      { mode: "follow_up", content: "continue" },
      cookie(fx),
    );
    expect(message.status).not.toBe(403);

    // The legacy seam is the same protected path.
    const legacy = await getJson(`${fx.app.base}/api/v1/tasks/${task.id}`, cookie(fx));
    expect(legacy.status).toBe(200);

    // A live stream is authorized with the task's target and set version.
    const stream = await fetch(`${ws}/tasks/${task.id}/stream`, {
      headers: cookie(fx),
      signal: AbortSignal.timeout(10_000),
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
  }, 60_000);

  test("a set change invalidates a subscription bound to the old version", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    // Another repository joins the set: the decision the subscription was
    // opened against no longer describes the workspace.
    bumpRepositorySetVersion(fx.db, fx.adminScope, fx.app.workspaceId);

    const stale = await fetch(`${ws}/tasks/${taskId}/stream`, {
      headers: cookie(fx),
      signal: AbortSignal.timeout(10_000),
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as ErrorBody;
    expect(body.error.code).toBe("REPOSITORY_SET_VERSION_CONFLICT");

    // A fresh read is evaluated against the current set and stays available:
    // the target is still an active binding.
    expect((await getJson(`${ws}/tasks/${taskId}`, cookie(fx))).status).toBe(200);
  }, 60_000);

  test("SSE replay with Last-Event-ID is refused once the set moved", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    bumpRepositorySetVersion(fx.db, fx.adminScope, fx.app.workspaceId);

    // The replay path shares the subscription's decision: the client's
    // Last-Event-ID does not let it resume history under the old set.
    const replay = await fetch(`${ws}/tasks/${taskId}/stream`, {
      headers: { ...cookie(fx), "Last-Event-ID": "evt_anything" },
      signal: AbortSignal.timeout(10_000),
    });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as ErrorBody).error.code).toBe("REPOSITORY_SET_VERSION_CONFLICT");
  }, 60_000);

  test("a live stream closes when the set changes while it is open", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    const stream = await fetch(`${ws}/tasks/${taskId}/stream`, {
      headers: cookie(fx),
      signal: AbortSignal.timeout(15_000),
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    // Drain the replay that was already authorized.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();

    // The set changes while the subscription is open; the next event must not
    // be delivered, and the stream ends instead of emitting under the old set.
    bumpRepositorySetVersion(fx.db, fx.adminScope, fx.app.workspaceId);
    const cancelled = await postJson<ErrorBody>(
      `${ws}/tasks/${taskId}/cancel`,
      { reason: "live stream probe" },
      cookie(fx),
    );
    expect(cancelled.status).toBe(202);

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).not.toContain("task.status_changed");
  }, 60_000);

  test("a change persisted by another process applies without a local signal", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);

    // Another process holds its own repository handle and observes the access
    // removal. This process's authority epoch is never bumped: the next
    // request still reads the shared store and denies.
    const otherProcess = createProviderAccessRepositories(fx.db);
    otherProcess.roster.setAuthorityState(
      fx.scope,
      fx.integrationB,
      GITLAB_SUBJECT,
      "removed",
      nowIso(),
    );

    const denied = await getJson<ErrorBody>(`${ws}/tasks/${created.body.id}`, cookie(fx));
    expect(denied.status).toBe(403);
    expect(errorOf(denied)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "capability_loss" },
    });
  }, 60_000);

  test("concurrent requests during a set change are always decided, never half-authorized", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    const reads = Array.from({ length: 8 }, () => getJson(`${ws}/tasks/${taskId}`, cookie(fx)));
    bumpRepositorySetVersion(fx.db, fx.adminScope, fx.app.workspaceId);
    const responses = await Promise.all(reads);
    for (const response of responses) {
      // Every answer is a complete decision: allowed against the set it read,
      // or a stable refusal — never a partial/5xx outcome.
      expect([200, 403, 409]).toContain(response.status);
    }
    // The target is still an active binding, so a fresh read settles on the
    // current set and is served.
    expect((await getJson(`${ws}/tasks/${taskId}`, cookie(fx))).status).toBe(200);
  }, 60_000);

  test("a target that left the set stops authorizing its resources", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    // Simulate a run whose target is the second repository: the task record is
    // the durable target the request boundary reads.
    const record = fx.app.orchestrator.service.store.get(taskId);
    expect(record).toBeDefined();
    const bindingB = fx.db
      .prepare(
        `SELECT id, provider_instance_id, installation_ref FROM workspace_repository_binding
          WHERE workspace_id = ? AND repository_id = ?`,
      )
      .get(fx.app.workspaceId, REPO_B) as
      { id: string; provider_instance_id: string; installation_ref: string | null } | undefined;
    expect(bindingB).toBeDefined();
    record!.target = {
      binding_id: bindingB!.id,
      repository_id: REPO_B,
      provider_instance_id: bindingB!.provider_instance_id,
      installation_ref: bindingB!.installation_ref,
      base_ref: "main",
      base_sha: BASE_SHA,
      set_version: 2,
      verified_at: nowIso(),
    };
    fx.app.orchestrator.service.store.put(record!);

    // While B is an active binding the targeted task is served.
    expect((await getJson(`${ws}/tasks/${taskId}`, cookie(fx))).status).toBe(200);

    // B leaves the set: the resource's target no longer authorizes anything,
    // and the refusal names the target rather than the workspace.
    fx.db
      .prepare(
        `DELETE FROM workspace_repository_binding WHERE workspace_id = ? AND repository_id = ?`,
      )
      .run(fx.app.workspaceId, REPO_B);
    bumpRepositorySetVersion(fx.db, fx.adminScope, fx.app.workspaceId);

    const denied = await getJson<ErrorBody>(`${ws}/tasks/${taskId}`, cookie(fx));
    expect(denied.status).toBe(403);
    expect(errorOf(denied)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "read", reason: "target_repository" },
    });
    // The same refusal holds on the legacy seam and for the task's artifacts.
    expect((await getJson(`${fx.app.base}/api/v1/tasks/${taskId}`, cookie(fx))).status).toBe(403);
    expect((await getJson(`${ws}/tasks/${taskId}/artifacts/art_x`, cookie(fx))).status).toBe(403);
  }, 60_000);

  test("unavailable evidence blocks every path and recovers without a recorded loss", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    // A verification that can no longer prove the role is unknown, not a loss.
    fx.access.roster.setAuthorityState(
      fx.scope,
      fx.integrationB,
      GITLAB_SUBJECT,
      "unknown",
      nowIso(),
    );

    const denied = await getJson<ErrorBody>(`${ws}/tasks/${taskId}`, cookie(fx));
    expect(denied.status).toBe(403);
    expect(errorOf(denied)).toMatchObject({
      code: "AUTHORITY_RECHECK_REQUIRED",
      details: { reason: "capability_unverified" },
    });
    expect((await getJson(`${ws}/tasks`, cookie(fx))).status).toBe(403);
    expect((await getJson(`${ws}/issues`, cookie(fx))).status).toBe(403);
    expect((await getJson(`${ws}/memory/items`, cookie(fx))).status).toBe(403);
    const stream = await fetch(`${ws}/tasks/${taskId}/stream`, {
      headers: cookie(fx),
      signal: AbortSignal.timeout(10_000),
    });
    expect(stream.status).toBe(403);

    // The same facts verify again: access returns and nothing was recorded as
    // a downgrade.
    fx.access.roster.applySnapshot(fx.scope, fx.integrationB, {
      roles: [
        {
          subject: GITLAB_SUBJECT,
          login: "gitlab-user",
          source_kind: "direct_collaborator",
          provider_role: "developer",
          authority_ref: REPO_B,
          inherited_from: null,
        },
      ],
      verified_at: nowIso(),
    });
    expect((await getJson(`${ws}/tasks/${taskId}`, cookie(fx))).status).toBe(200);
  }, 60_000);

  test("the advisory projection is not a credential", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "developer" });
    const ws = workspaceUrl(fx);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(201);
    const taskId = created.body.id;

    const projection = await getJson<{
      modules: Record<string, { actions: Record<string, { allowed: boolean }> }>;
    }>(`${ws}/capabilities`, cookie(fx));
    expect(projection.status).toBe(200);
    expect(projection.body.modules["tasks"]!.actions["view"]!.allowed).toBe(true);

    // Authority changes after the projection was read. The projection remains
    // a snapshot; every request is decided again and denies.
    fx.access.roster.setAuthorityState(
      fx.scope,
      fx.integrationB,
      GITLAB_SUBJECT,
      "unknown",
      nowIso(),
    );
    expect((await getJson(`${ws}/tasks/${taskId}`, cookie(fx))).status).toBe(403);
  }, 60_000);

  test("the same decisions hold after a process restart", async () => {
    const fx = await startTwoRepository({ githubRole: "admin", gitlabRole: "reporter" });
    const ws = workspaceUrl(fx);
    expect((await getJson(`${ws}/tasks`, cookie(fx))).status).toBe(200);
    expect((await createTaskOnA(fx)).status).toBe(403);

    await fx.app.restart();
    const restarted = workspaceUrl(fx);
    expect((await getJson(`${restarted}/tasks`, cookie(fx))).status).toBe(200);
    const created = await createTaskOnA(fx);
    expect(created.status).toBe(403);
    expect(errorOf(created)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "capability_ceiling" },
    });
  }, 90_000);
});
