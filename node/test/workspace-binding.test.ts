import { describe, expect, test } from "vitest";

import type { OrchestratorConfig } from "../src/config.js";
import type { DshClient } from "../src/dsh/client.js";
import type { DshCreateRunRequest, DshRunResponse } from "../src/dsh/types.js";
import type { GatewayBindingIdentity, ModelGateway } from "../src/gateway/index.js";
import { ApiError } from "../src/api/errors.js";
import { TaskService, deploymentRunBinding } from "../src/api/task-service.js";
import type { WorkspaceRunBinding } from "../src/api/task-service.js";
import { TaskStore } from "../src/api/task-store.js";
import { createWorkspaceRunBindingResolver } from "../src/api/workspace-bindings.js";
import type { ProviderInstance, Workspace } from "../src/control-plane/index.js";
import { scriptedStream, TEST_MODEL } from "./helpers/scripted-stream.js";
import { waitUntil } from "./helpers/http.js";

const CONFIG = {
  dshSocketPath: "/tmp/unused.sock",
  apiHost: "127.0.0.1",
  apiPort: 0,
  apiTokenFile: "/tmp/unused-token",
  repositoryId: "github:acme/Alpha",
  repositoryUrl: "https://github.com/acme/Alpha.git",
  baseRef: "main",
  baseSha: "a".repeat(40),
  actorId: "usr_operator",
  actorDisplayName: "Deployment Operator",
  approverIdentity: "github:local-operator",
  pathHints: [],
  toolCapabilities: [],
  maxWallClockSeconds: 60,
  enterpriseId: "ent_deployment",
  workspaceId: "wsp_alpha",
} as OrchestratorConfig;

const BETA: WorkspaceRunBinding = {
  enterpriseId: "ent_tenant",
  workspaceId: "wsp_beta",
  repositoryId: "github:acme/Beta",
  repositoryUrl: "https://github.com/acme/Beta.git",
  baseRef: "trunk",
  baseSha: "b".repeat(40),
};

function runResponse(taskId: string, runId: string): DshRunResponse {
  return {
    run_id: runId,
    task_id: taskId,
    issue_id: "issue-1",
    state: "running",
    risk_assessment: {
      contract_version: "task-evidence-contract-v1",
      task_id: taskId,
      run_id: runId,
      assessed_at: "2026-11-04T00:00:00.000Z",
      assessor_identity: "dsh",
      risk_class: "low",
      decision_code: "risk_low",
      rationale_reference: "evidence://risk",
      policy_version: "v1",
      elevated_approval_reference: null,
    },
    grant_status: { state: "active", scope_digest: "sha256:x", grant: null },
    execution_counts: { actions_total: 0, actions_allowed: 0, actions_denied: 0 },
    patch_report: null,
    approval_snapshot: null,
    bundle_available: false,
    created_at: "2026-11-04T00:00:00.000Z",
  };
}

/** A dsh stand-in that records exactly what Node asked it to dispatch. */
function fakeDsh() {
  const created: DshCreateRunRequest[] = [];
  const runs = new Map<string, string>();
  const client = {
    async createRun(request: DshCreateRunRequest) {
      created.push(structuredClone(request));
      const runId = `run_${created.length}`;
      runs.set(runId, request.task_id);
      return {
        run_id: runId,
        state: "approved",
        risk_assessment: { risk_class: "low", decision_code: "risk_low" },
        grant: {
          capability_grant_version: "1",
          issued_at: "2026-11-04T00:00:00.000Z",
          expires_at: "2026-11-04T01:00:00.000Z",
          permitted_paths: [],
          permitted_tools: [],
          max_wall_clock_seconds: 60,
          scope_digest: "sha256:x",
        },
        required_action: null,
      };
    },
    async getRun(runId: string) {
      return runResponse(runs.get(runId) ?? "tsk_unknown", runId);
    },
    async cancelRun(_runId: string) {
      return { state: "cancelled", cancellation_requested: true, audit_event_reference: "ev" };
    },
  } as unknown as DshClient;
  return { client, created };
}

function serviceFor(bindings: Record<string, WorkspaceRunBinding>) {
  const dsh = fakeDsh();
  const bound: GatewayBindingIdentity[] = [];
  const gateway = {
    bind(identity: GatewayBindingIdentity) {
      bound.push(identity);
      return scriptedStream([{ kind: "text", text: "settled" }]).streamFn;
    },
  } as unknown as ModelGateway;
  // The model is only a shape here: the scripted stream never reaches a
  // provider, and every call still carries the gateway binding under test.
  const service = new TaskService({
    config: CONFIG,
    dsh: dsh.client,
    store: new TaskStore(),
    gateway,
    model: TEST_MODEL,
    workspaceBindings: {
      resolve(workspaceId: string): WorkspaceRunBinding {
        const binding = bindings[workspaceId];
        if (binding === undefined) {
          throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
        }
        return binding;
      },
    },
  });
  return { service, created: dsh.created, bound };
}

describe("workspace-bound task creation (DAT-245)", () => {
  test("a workspace's repository, base revision, and gateway identity drive the run", async () => {
    const { service, created, bound } = serviceFor({
      [BETA.workspaceId]: BETA,
      [CONFIG.workspaceId]: deploymentRunBinding(CONFIG),
    });
    try {
      const task = await service.createTask(
        { repository_id: BETA.repositoryId, base_ref: BETA.baseRef, summary: "beta work" },
        { workspaceId: BETA.workspaceId },
      );

      expect(task.workspace_id).toBe(BETA.workspaceId);
      expect(task.repository).toEqual({
        id: BETA.repositoryId,
        display_name: "acme/Beta",
        base_ref: BETA.baseRef,
        base_sha: BETA.baseSha,
      });
      expect(created).toHaveLength(1);
      expect(created[0]?.repository).toEqual({
        repository_id: BETA.repositoryId,
        url: BETA.repositoryUrl,
        base_ref: BETA.baseRef,
        base_sha: BETA.baseSha,
      });

      const record = service.store.get(task.id);
      expect(record?.enterpriseId).toBe(BETA.enterpriseId);
      await waitUntil(() => bound.length > 0, "gateway binding");
      expect(bound[0]?.enterpriseId).toBe(BETA.enterpriseId);
      expect(bound[0]?.workspaceId).toBe(BETA.workspaceId);
    } finally {
      service.disposeAll();
    }
  });

  test("the same idempotency key in two workspaces names two creates", async () => {
    const { service, created } = serviceFor({
      [BETA.workspaceId]: BETA,
      [CONFIG.workspaceId]: deploymentRunBinding(CONFIG),
    });
    try {
      const alpha = deploymentRunBinding(CONFIG);
      const betaTask = await service.createTask(
        { repository_id: BETA.repositoryId, base_ref: BETA.baseRef, summary: "same" },
        { workspaceId: BETA.workspaceId, idempotencyKey: "k1" },
      );
      const alphaTask = await service.createTask(
        { repository_id: alpha.repositoryId, base_ref: alpha.baseRef, summary: "same" },
        { workspaceId: alpha.workspaceId, idempotencyKey: "k1" },
      );
      expect(alphaTask.id).not.toBe(betaTask.id);
      expect(created.map((request) => request.repository.repository_id)).toEqual([
        BETA.repositoryId,
        alpha.repositoryId,
      ]);
    } finally {
      service.disposeAll();
    }
  });

  test("a request may only select inside the workspace binding", async () => {
    const { service, created } = serviceFor({ [BETA.workspaceId]: BETA });
    try {
      await expect(
        service.createTask(
          { repository_id: "github:acme/Other", base_ref: BETA.baseRef, summary: "x" },
          { workspaceId: BETA.workspaceId },
        ),
      ).rejects.toMatchObject({ code: "REPOSITORY_NOT_IN_WORKSPACE" });
      await expect(
        service.createTask(
          { repository_id: BETA.repositoryId, base_ref: "main", summary: "x" },
          { workspaceId: BETA.workspaceId },
        ),
      ).rejects.toMatchObject({ code: "BASE_REF_NOT_SUPPORTED" });
      expect(created).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });

  test("binding resolution failures refuse before any dispatch", async () => {
    const { service, created } = serviceFor({});
    try {
      await expect(
        service.createTask(
          { repository_id: BETA.repositoryId, base_ref: BETA.baseRef, summary: "x" },
          { workspaceId: "wsp_missing" },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(created).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });
});

describe("control-plane workspace binding resolution", () => {
  function fakeRepositories(
    workspace: Workspace | undefined,
    provider: ProviderInstance | undefined,
  ) {
    return {
      workspaces: {
        getById: () => workspace,
      },
      providerInstances: {
        getById: () => provider,
      },
    };
  }

  const workspace = {
    id: BETA.workspaceId,
    enterprise_id: BETA.enterpriseId,
    name: "Beta",
    repository_id: BETA.repositoryId,
    provider_instance_id: "pi_1",
    status: "active",
    version: 1,
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    created_by: "usr_admin",
    updated_by: "usr_admin",
  } as Workspace;

  const provider = {
    id: "pi_1",
    enterprise_id: BETA.enterpriseId,
    provider_type: "github",
    origin_url: "https://github.com",
    version: 1,
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    created_by: "usr_admin",
    updated_by: "usr_admin",
  } as ProviderInstance;

  test("another repository without a pinned base revision is refused", () => {
    const resolver = createWorkspaceRunBindingResolver({
      config: CONFIG,
      ...fakeRepositories(workspace, provider),
    } as unknown as Parameters<typeof createWorkspaceRunBindingResolver>[0]);
    expect(() => resolver.resolve(BETA.workspaceId)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_UNAVAILABLE" }),
    );
  });

  test("an unregistered provider instance is refused", () => {
    const resolver = createWorkspaceRunBindingResolver({
      config: CONFIG,
      ...fakeRepositories(workspace, undefined),
    } as unknown as Parameters<typeof createWorkspaceRunBindingResolver>[0]);
    expect(() => resolver.resolve(BETA.workspaceId)).toThrow(
      expect.objectContaining({ code: "PROVIDER_INSTANCE_NOT_APPROVED" }),
    );
  });

  test("unknown, archived, and cross-enterprise workspaces are one 404", () => {
    const resolver = createWorkspaceRunBindingResolver({
      config: CONFIG,
      ...fakeRepositories(undefined, provider),
    } as unknown as Parameters<typeof createWorkspaceRunBindingResolver>[0]);
    expect(() => resolver.resolve(BETA.workspaceId)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    const archived = createWorkspaceRunBindingResolver({
      config: CONFIG,
      ...fakeRepositories({ ...workspace, status: "archived" }, provider),
    } as unknown as Parameters<typeof createWorkspaceRunBindingResolver>[0]);
    expect(() => archived.resolve(BETA.workspaceId)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });
});
