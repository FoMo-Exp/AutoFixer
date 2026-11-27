/**
 * Run start and worker-step target authority (DAT-293).
 *
 * A remediation run is bound to one immutable target at one repository-set
 * version. These tests pin the two dispatch boundaries:
 *
 * - the run-step policy refuses before dispatch when the set moved, the target
 *   is no longer an active binding of it, the target's approved credentials are
 *   gone, or the requester's complete-set capability intersection no longer
 *   permits the action — and distinguishes a confirmed loss (terminal) from
 *   unverifiable evidence (blocked, recoverable);
 * - the task service refuses to start a session on any such denial, leaving the
 *   run stopped for human triage rather than executing unauthorized work.
 */

import { describe, expect, test } from "vitest";

import type { DshClient } from "../src/dsh/client.js";
import type { GatewayBindingIdentity, ModelGateway } from "../src/gateway/index.js";
import { createAuthorizationContextService } from "../src/provider-access/authorization-context.js";
import { createCapabilityCeilingService } from "../src/provider-access/capability-ceiling.js";
import {
  CURRENT_SCHEMA_VERSION,
  createMemberCapabilityRepository,
  createRepositories,
  createWorkspaceRepositorySetRepository,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import { bumpRepositorySetVersion } from "../src/control-plane/workspace-repository-repositories.js";
import { TaskService } from "../src/api/task-service.js";
import type { RunStepAuthorityInput } from "../src/api/task-service.js";
import { TaskStore } from "../src/api/task-store.js";
import { ApiError } from "../src/api/errors.js";
import { createRequestAuthority, HTTP_ACTION_POLICY } from "../src/api/request-authority.js";
import { createRunStepAuthority } from "../src/api/run-step-authority.js";
import type { OrchestratorConfig } from "../src/config.js";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  addMember,
  NOW,
  REPO_ID,
  setupFixture,
  verifyAuthority,
} from "./helpers/provider-access.js";
import type { Fixture } from "./helpers/provider-access.js";
import { scriptedStream } from "./helpers/scripted-stream.js";

const ACTOR = "usr_operator";
const REPO_B = "github:repo:9002";
const B_SHA = "b".repeat(40);
const CONFIG = {
  repositoryId: REPO_ID,
  repositoryUrl: "https://github.com/FoMo-Exp/AutoFixer.git",
  baseRef: "main",
  baseSha: "a".repeat(40),
  actorId: ACTOR,
  enterpriseId: "ent_test",
  approverIdentity: "github:local-operator",
  maxWallClockSeconds: 900,
  toolCapabilities: ["echo"],
  pathHints: ["node/package.json"],
  actorDisplayName: "Operator",
} as unknown as OrchestratorConfig;

const TEST_MODEL = { id: "test-model" } as unknown as Model<Api>;

function insertBinding(db: ControlPlaneDb, fixture: Fixture, integrationId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace_repository_binding
       (id, enterprise_id, workspace_id, provider_instance_id, installation_ref,
        repository_id, repository_url, repository_name, position, status,
        created_at, updated_at, created_by, updated_by, version)
     VALUES ('wrb_second', ?, ?, ?, ?, ?, 'https://github.com/acme/b.git', 'acme/b', 2, 'active', ?, ?, ?, ?, 1)`,
  ).run(
    fixture.scope.enterprise_id,
    fixture.workspaceId,
    fixture.providerInstanceId,
    integrationId,
    REPO_B,
    now,
    now,
    ACTOR,
    ACTOR,
  );
}

interface TwoRepo {
  fixture: Fixture;
  memberId: string;
  integrationB: string;
  setVersion: number;
}

/** Two active repositories of one workspace, behind two approved installs. */
function twoRepositories(roles: { a: string; b: string }): TwoRepo {
  const fixture = setupFixture();
  const integrationB = fixture.access.integrations.create(fixture.scope, {
    provider_instance_id: fixture.providerInstanceId,
    repository_id: REPO_B,
    repository_name: "acme/b",
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    delivery_credential_ref: "svc-delivery-b",
    permission_visibility: "full",
    actor_id: ACTOR,
  });
  insertBinding(fixture.db, fixture, integrationB.id);
  // The shape a rollout release creates: the immutable gate row stays and an
  // enabled row is appended at the current schema version.
  fixture.db
    .prepare(
      `INSERT INTO deployment_feature_gate
         (key, min_schema_version, state, reason, created_at, created_by)
       VALUES ('multi_repository_workspace', ?, 'enabled', 'test', ?, ?)`,
    )
    .run(CURRENT_SCHEMA_VERSION, NOW, ACTOR);
  bumpRepositorySetVersion(fixture.db, fixture.adminScope, fixture.workspaceId);

  const member = addMember(fixture, { subject: "9101", login: "worker", role: "member" });
  verifyAuthority(fixture, "9101", member.userId, NOW, { provider_role: roles.a });
  fixture.access.roster.applySnapshot(fixture.scope, integrationB.id, {
    roles: [
      {
        subject: "9101",
        login: "worker",
        source_kind: "direct_collaborator",
        provider_role: roles.b,
        authority_ref: REPO_B,
        inherited_from: null,
      },
    ],
    verified_at: NOW,
  });
  const set = createWorkspaceRepositorySetRepository(fixture.db, {
    multiRepositoryRuntime: "complete",
  }).getSet(fixture.scope);
  return {
    fixture,
    memberId: member.userId,
    integrationB: integrationB.id,
    setVersion: set.set_version,
  };
}

function policyFor(two: TwoRepo) {
  const { fixture } = two;
  const repositorySets = createWorkspaceRepositorySetRepository(fixture.db, {
    multiRepositoryRuntime: "complete",
  });
  const capabilityCeilings = createCapabilityCeilingService({
    repositorySets,
    access: fixture.access,
    memberships: fixture.memberships,
    providerInstances: createRepositories(fixture.db).providerInstances,
    identity: fixture.identity,
    capabilities: createMemberCapabilityRepository(fixture.db),
    epoch: fixture.epoch,
    clock: () => fixture.clock.now,
    multiRepositoryEnforcement: "complete",
  });
  const authority = createRequestAuthority({
    access: fixture.access,
    memberships: fixture.memberships,
    workspaces: fixture.workspaces,
    users: fixture.users,
    identities: fixture.identities,
    enterpriseUsers: fixture.identity.enterpriseUsers,
    capabilityCeilings,
    epoch: fixture.epoch,
    enterpriseId: fixture.scope.enterprise_id,
    workspaceId: fixture.workspaceId,
    clock: () => fixture.clock.now,
  });
  const contexts = createAuthorizationContextService({
    repositorySets,
    capabilityCeilings,
    memberships: fixture.memberships,
    enterpriseUsers: fixture.identity.enterpriseUsers,
    users: fixture.users,
    access: fixture.access,
    policy: HTTP_ACTION_POLICY,
    clock: () => fixture.clock.now,
  });
  return createRunStepAuthority({
    enterpriseId: fixture.scope.enterprise_id,
    actorId: ACTOR,
    repositorySets,
    authority,
    contexts,
    integrations: fixture.access.integrations,
    clock: () => fixture.clock.now,
  });
}

function inputFor(
  two: TwoRepo,
  overrides: Partial<RunStepAuthorityInput> = {},
): RunStepAuthorityInput {
  const set = createWorkspaceRepositorySetRepository(two.fixture.db, {
    multiRepositoryRuntime: "complete",
  }).getSet(two.fixture.scope);
  const bindingB = set.bindings.find((binding) => binding.repository_id === REPO_B)!;
  return {
    enterprise_id: two.fixture.scope.enterprise_id,
    workspace_id: two.fixture.workspaceId,
    repository_id: REPO_B,
    requested_by: { kind: "session", user_id: two.memberId },
    repository_set_version: two.setVersion,
    target: {
      binding_id: bindingB.id,
      repository_id: REPO_B,
      provider_instance_id: two.fixture.providerInstanceId,
      installation_ref: bindingB.installation_ref,
      base_ref: "main",
      base_sha: B_SHA,
      set_version: two.setVersion,
      verified_at: NOW,
    },
    phase: "start",
    ...overrides,
  };
}

describe("the run-step policy is target-aware over the complete set", () => {
  test("the intersection over every repository decides; write on one repository is not enough", () => {
    const permitted = twoRepositories({ a: "write", b: "write" });
    expect(policyFor(permitted)(inputFor(permitted))).toEqual({ allowed: true });

    const mixed = twoRepositories({ a: "write", b: "read" });
    const policy = policyFor(mixed);
    const decision = policy(inputFor(mixed));
    expect(decision).toMatchObject({ allowed: false, code: "CAPABILITY_REQUIRED", terminal: true });
  });

  test("a set that moved on is terminal, and the new version is a different decision", () => {
    const two = twoRepositories({ a: "write", b: "write" });
    const policy = policyFor(two);
    expect(policy(inputFor(two, { repository_set_version: two.setVersion - 1 }))).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_VERSION_CONFLICT",
      terminal: true,
    });
  });

  test("a target that is no longer an active binding of the version is terminal", () => {
    const two = twoRepositories({ a: "write", b: "write" });
    const policy = policyFor(two);
    // The recorded binding id no longer exists (removed or replaced).
    const input = inputFor(two);
    expect(
      policy({ ...input, target: { ...input.target!, binding_id: "wrb_gone" } }),
    ).toMatchObject({
      allowed: false,
      code: "TARGET_REPOSITORY_UNAVAILABLE",
      terminal: true,
    });
    // A recorded identity that disagrees with the binding is refused too.
    expect(
      policy({ ...input, target: { ...input.target!, provider_instance_id: "pri_other" } }),
    ).toMatchObject({
      allowed: false,
      code: "TARGET_REPOSITORY_UNAVAILABLE",
      terminal: true,
    });
  });

  test("a withdrawn checkout or delivery capability refuses before dispatch", () => {
    const two = twoRepositories({ a: "write", b: "write" });
    const policy = policyFor(two);
    two.fixture.db
      .prepare(`UPDATE service_integration SET checkout_credential_ref = NULL WHERE id = ?`)
      .run(two.integrationB);
    expect(policy(inputFor(two))).toMatchObject({
      allowed: false,
      code: "CHECKOUT_CREDENTIAL_UNAVAILABLE",
      terminal: true,
    });

    two.fixture.db
      .prepare(
        `UPDATE service_integration SET checkout_credential_ref = 'svc-checkout-b',
           delivery_credential_ref = NULL WHERE id = ?`,
      )
      .run(two.integrationB);
    expect(policy(inputFor(two))).toMatchObject({
      allowed: false,
      code: "DELIVERY_CREDENTIAL_UNAVAILABLE",
      terminal: true,
    });
  });

  test("unverifiable authority blocks the step without recording a loss", () => {
    const two = twoRepositories({ a: "write", b: "write" });
    const policy = policyFor(two);
    two.fixture.access.roster.resetAuthority(two.fixture.scope, two.integrationB, NOW);
    expect(policy(inputFor(two))).toMatchObject({
      allowed: false,
      code: "AUTHORITY_RECHECK_REQUIRED",
      terminal: false,
    });
  });

  test("a multi-repository run without the complete-set engine stays blocked", () => {
    const two = twoRepositories({ a: "write", b: "write" });
    const fixture = two.fixture;
    const repositorySets = createWorkspaceRepositorySetRepository(fixture.db, {
      multiRepositoryRuntime: "complete",
    });
    const capabilityCeilings = createCapabilityCeilingService({
      repositorySets,
      access: fixture.access,
      memberships: fixture.memberships,
      providerInstances: createRepositories(fixture.db).providerInstances,
      identity: fixture.identity,
      capabilities: createMemberCapabilityRepository(fixture.db),
      epoch: fixture.epoch,
      multiRepositoryEnforcement: "complete",
    });
    const authority = createRequestAuthority({
      access: fixture.access,
      memberships: fixture.memberships,
      workspaces: fixture.workspaces,
      users: fixture.users,
      identities: fixture.identities,
      enterpriseUsers: fixture.identity.enterpriseUsers,
      capabilityCeilings,
      epoch: fixture.epoch,
      enterpriseId: fixture.scope.enterprise_id,
      workspaceId: fixture.workspaceId,
      clock: () => fixture.clock.now,
    });
    const policy = createRunStepAuthority({
      enterpriseId: fixture.scope.enterprise_id,
      actorId: ACTOR,
      repositorySets,
      authority,
      integrations: fixture.access.integrations,
    });
    expect(policy(inputFor(two))).toMatchObject({
      allowed: false,
      code: "AUTHORITY_RECHECK_REQUIRED",
      terminal: false,
    });
  });

  test("the identity-less local mode keeps its grant-only boundary", () => {
    const fixture = setupFixture();
    const policy = createRunStepAuthority({
      enterpriseId: fixture.scope.enterprise_id,
      actorId: ACTOR,
      repositorySets: createWorkspaceRepositorySetRepository(fixture.db),
      authority: {} as never,
      integrations: undefined,
    } as never);
    // No set version, no target, no requester: the deployment-owned seam.
    expect(
      policy({
        enterprise_id: fixture.scope.enterprise_id,
        workspace_id: fixture.workspaceId,
        repository_id: REPO_ID,
        requested_by: { kind: "deployment" },
        repository_set_version: null,
        target: null,
      }),
    ).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Task service: the start gate
// ---------------------------------------------------------------------------

interface Created {
  repository: { repository_id: string; base_sha: string };
}

function fakeDsh() {
  const created: Created[] = [];
  const cancelled: string[] = [];
  const client = {
    async createRun(request: Created & { task_id: string }) {
      created.push(request);
      return {
        run_id: `run_${created.length}`,
        state: "approved",
        risk_assessment: { risk_class: "elevated", decision_code: "assessed" },
        grant: {
          capability_grant_version: "capability-grant/v1",
          issued_at: NOW,
          expires_at: NOW,
          permitted_paths: ["node/package.json"],
          permitted_tools: [],
          max_wall_clock_seconds: 900,
          scope_digest: "digest",
        },
        required_action: null,
      };
    },
    async cancelRun(runId: string) {
      cancelled.push(runId);
      return { state: "cancelled", cancellation_requested: true, audit_event_reference: "ev" };
    },
  } as unknown as DshClient;
  return { client, created, cancelled };
}

function serviceFor(options: {
  authorize: (input: RunStepAuthorityInput) => {
    allowed: boolean;
    code?: string;
    terminal?: boolean;
  };
}) {
  const dsh = fakeDsh();
  const seen: RunStepAuthorityInput[] = [];
  const bound: GatewayBindingIdentity[] = [];
  const gateway = {
    bind(identity: GatewayBindingIdentity) {
      bound.push(identity);
      return scriptedStream([{ kind: "text", text: "settled" }]).streamFn;
    },
  } as unknown as ModelGateway;
  const target = {
    binding_id: "wrb_1",
    repository_id: REPO_ID,
    provider_instance_id: "pri_1",
    installation_ref: "sint_1",
    base_ref: "main",
    base_sha: "a".repeat(40),
    set_version: 3,
    verified_at: NOW,
  };
  const service = new TaskService({
    config: CONFIG,
    dsh: dsh.client,
    store: new TaskStore(),
    gateway,
    model: TEST_MODEL,
    workspaceBindings: {
      resolve(): never {
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      },
    },
    runTargets: {
      async resolve() {
        return {
          enterpriseId: "ent_test",
          workspaceId: "wsp_test",
          repositoryId: REPO_ID,
          repositoryUrl: "https://github.com/FoMo-Exp/AutoFixer.git",
          baseRef: "main",
          baseSha: "a".repeat(40),
          setVersion: 3,
          target,
        };
      },
    },
    runStepAuthority: (input) => {
      seen.push(input);
      return options.authorize(input);
    },
    runScope: () => ({
      enterpriseId: "ent_test",
      workspaceId: "wsp_test",
      scopeAuthority: {
        resolve: () => ({ enterpriseId: "ent_test", workspaceId: "wsp_test" }),
      },
    }),
  });
  return { service, dsh, seen, bound };
}

describe("the task service starts nothing on a denied start check", () => {
  test("a denied start leaves the run stopped and no session is created", async () => {
    const started = serviceFor({
      authorize: () => ({
        allowed: false,
        code: "REPOSITORY_SET_VERSION_CONFLICT",
        terminal: true,
      }),
    });
    try {
      const task = await started.service.createTask(
        { summary: "prepare" },
        {
          workspaceId: "wsp_test",
        },
      );
      expect(task.status).toBe("stopped");
      const record = started.service.store.get(task.id);
      expect(
        record?.events.some((event) =>
          String(event.data["reason"]).includes(
            "RUN_AUTHORITY_DENIED: REPOSITORY_SET_VERSION_CONFLICT",
          ),
        ),
      ).toBe(true);
      // The check ran at start, with the recorded target and set version.
      expect(started.seen[0]).toMatchObject({
        phase: "start",
        repository_set_version: 3,
        target: { binding_id: "wrb_1", repository_id: REPO_ID },
      });
      expect(started.bound).toHaveLength(0);
    } finally {
      started.service.disposeAll();
    }
  });

  test("an allowed start runs the session against the recorded target", async () => {
    const started = serviceFor({ authorize: () => ({ allowed: true }) });
    try {
      const task = await started.service.createTask(
        { summary: "prepare" },
        {
          workspaceId: "wsp_test",
        },
      );
      expect(task.status).not.toBe("stopped");
      expect(started.seen[0]?.phase).toBe("start");
      expect(started.dsh.created[0]?.repository.base_sha).toBe("a".repeat(40));
      expect(started.bound).toHaveLength(1);
    } finally {
      started.service.disposeAll();
    }
  });
});
