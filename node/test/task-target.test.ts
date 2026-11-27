import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { OrchestratorConfig } from "../src/config.js";
import { WorkspaceRepositorySetError } from "../src/control-plane/errors.js";
import { createWorkspaceRunBindingResolver } from "../src/api/workspace-bindings.js";
import {
  TaskTargetService,
  listTaskTargetCandidates,
  resolveTaskTargetSelection,
} from "../src/api/task-targets.js";
import type { TaskTargetBaselines, TaskTargetSelection } from "../src/api/task-targets.js";
import { TaskStore, createTaskRecord, toTaskResource } from "../src/api/task-store.js";
import type { TaskRecord } from "../src/api/task-store.js";
import type {
  WorkspaceRepositoryBinding,
  WorkspaceRepositorySet,
} from "../src/control-plane/index.js";
import type {
  ProviderInstanceRepository,
  WorkspaceRepository,
} from "../src/control-plane/repositories.js";

const ENTERPRISE = "ent_test";
const WORKSPACE = "wsp_test";
const PROVIDER = "pi_github";
const REPOSITORY = "github:acme/payments";
const BASE_SHA = "a".repeat(40);

const CONFIG = {
  repositoryId: REPOSITORY,
  repositoryUrl: "https://github.com/acme/payments.git",
  baseRef: "main",
  baseSha: BASE_SHA,
  actorId: "usr_operator",
  enterpriseId: ENTERPRISE,
} as unknown as OrchestratorConfig;

function binding(overrides: Partial<WorkspaceRepositoryBinding> = {}): WorkspaceRepositoryBinding {
  return {
    id: "wrb_1",
    enterprise_id: ENTERPRISE,
    workspace_id: WORKSPACE,
    provider_instance_id: PROVIDER,
    installation_ref: null,
    repository_id: REPOSITORY,
    repository_url: "https://github.com/acme/payments.git",
    repository_name: "acme/payments",
    position: 1,
    status: "active",
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    created_by: "usr_seed",
    updated_by: "usr_seed",
    version: 1,
    ...overrides,
  };
}

function set(overrides: Partial<WorkspaceRepositorySet> = {}): WorkspaceRepositorySet {
  return {
    enterprise_id: ENTERPRISE,
    workspace_id: WORKSPACE,
    set_version: 7,
    bindings: [binding()],
    multi_repository: false,
    usable: true,
    blocked_reason: null,
    gate: {
      key: "multi_repository_workspace",
      state: "disabled",
      reason: "test",
      min_schema_version: 20,
      created_at: "2026-11-01T00:00:00.000Z",
      created_by: "usr_seed",
    },
    ...overrides,
  };
}

const baselines: TaskTargetBaselines = {
  resolve(candidate, requestedBaseRef) {
    if (candidate.repository_id !== REPOSITORY) {
      return null;
    }
    if (requestedBaseRef !== undefined && requestedBaseRef !== "main") {
      return null;
    }
    return {
      base_ref: "main",
      base_sha: BASE_SHA,
      repository_url: "https://github.com/acme/payments.git",
    };
  },
};

function selection(overrides: Partial<TaskTargetSelection> = {}): TaskTargetSelection {
  return {
    repository_id: REPOSITORY,
    provider_instance_id: PROVIDER,
    installation_ref: null,
    base_ref: "main",
    expected_set_version: 7,
    ...overrides,
  };
}

const NOW = () => new Date("2026-11-27T12:00:00.000Z");

describe("explicit task target selection (DAT-292)", () => {
  test("a matching immutable identity and observed set version mint the target", () => {
    const resolved = resolveTaskTargetSelection(set(), selection(), baselines, NOW);
    expect(resolved.target).toEqual({
      binding_id: "wrb_1",
      repository_id: REPOSITORY,
      provider_instance_id: PROVIDER,
      installation_ref: null,
      base_ref: "main",
      base_sha: BASE_SHA,
      set_version: 7,
      verified_at: "2026-11-27T12:00:00.000Z",
    });
  });

  test("an approved installation is part of the immutable identity", () => {
    const withInstallation = set({ bindings: [binding({ installation_ref: "si_active" })] });
    expect(() =>
      resolveTaskTargetSelection(
        withInstallation,
        selection({ installation_ref: null }),
        baselines,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "TARGET_IDENTITY_MISMATCH", status: 409 }));
    expect(
      resolveTaskTargetSelection(
        withInstallation,
        selection({ installation_ref: "si_active" }),
        baselines,
        NOW,
      ).target.installation_ref,
    ).toBe("si_active");
  });

  test("another repository, a retired binding and a deferred provider never resolve", () => {
    expect(() =>
      resolveTaskTargetSelection(
        set(),
        selection({ repository_id: "github:acme/other" }),
        baselines,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "REPOSITORY_NOT_IN_WORKSPACE", status: 400 }));

    expect(() =>
      resolveTaskTargetSelection(
        set({ bindings: [binding({ status: "retired" })] }),
        selection(),
        baselines,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "REPOSITORY_NOT_IN_WORKSPACE" }));

    expect(() =>
      resolveTaskTargetSelection(
        set(),
        selection({ provider_instance_id: "pi_other" }),
        baselines,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "TARGET_IDENTITY_MISMATCH" }));
  });

  test("a stale observed set version is refused, never re-resolved", () => {
    expect(() =>
      resolveTaskTargetSelection(set({ set_version: 8 }), selection(), baselines, NOW),
    ).toThrow(
      expect.objectContaining({
        code: "REPOSITORY_SET_VERSION_CONFLICT",
        status: 409,
        details: { expected_set_version: 7, actual_set_version: 8 },
      }),
    );
  });

  test("an unresolvable baseline and a changed baseline assertion are distinct conflicts", () => {
    expect(() =>
      resolveTaskTargetSelection(set(), selection({ base_ref: "release" }), baselines, NOW),
    ).toThrow(expect.objectContaining({ code: "REPOSITORY_BINDING_UNAVAILABLE", status: 409 }));

    expect(() =>
      resolveTaskTargetSelection(
        set(),
        selection({ expected_base_sha: "b".repeat(40) }),
        baselines,
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: "TARGET_BASELINE_MISMATCH", status: 409 }));
  });

  test("selection is described while the rollout gate is closed, without granting execution", () => {
    const closed = set({
      bindings: [
        binding(),
        binding({ id: "wrb_2", position: 2, repository_id: "github:acme/web" }),
      ],
      multi_repository: true,
      usable: false,
      blocked_reason: "MULTI_REPOSITORY_SCOPE_DISABLED",
    });
    const list = listTaskTargetCandidates(closed, baselines);
    expect(list.selection_required).toBe(true);
    expect(list.usable).toBe(false);
    expect(list.blocked_reason).toBe("MULTI_REPOSITORY_SCOPE_DISABLED");
    expect(list.targets.map((target) => target.baseline.state)).toEqual(["trusted", "unavailable"]);
    // Resolution is a contract check; the create path applies the gate.
    expect(
      resolveTaskTargetSelection(closed, selection({ expected_set_version: 7 }), baselines, NOW)
        .binding.id,
    ).toBe("wrb_1");
  });

  test("a multi-repository set without a selection asks for one instead of picking a binding", () => {
    const multi = set({
      bindings: [
        binding(),
        binding({ id: "wrb_2", position: 2, repository_id: "github:acme/web" }),
      ],
      multi_repository: true,
      usable: false,
      blocked_reason: "MULTI_REPOSITORY_SCOPE_DISABLED",
    });
    const resolver = createWorkspaceRunBindingResolver({
      config: CONFIG,
      workspaces: {
        getById: () => ({
          id: WORKSPACE,
          enterprise_id: ENTERPRISE,
          name: "Payments",
          repository_id: REPOSITORY,
          provider_instance_id: PROVIDER,
          status: "active",
        }),
      } as unknown as WorkspaceRepository,
      providerInstances: {
        getById: () => ({ id: PROVIDER, enterprise_id: ENTERPRISE }),
      } as unknown as ProviderInstanceRepository,
      repositorySets: {
        getSet: () => multi,
        requireSingleRepository: () => {
          throw new WorkspaceRepositorySetError("MULTI_REPOSITORY_SCOPE_DISABLED", "multi", 403);
        },
      } as never,
      baselines,
    });
    expect(() => resolver.resolve(WORKSPACE)).toThrow(
      expect.objectContaining({ code: "TARGET_REPOSITORY_REQUIRED", status: 400 }),
    );
  });

  test("an archived workspace's target list is refused instead of offered", () => {
    const service = new TaskTargetService({
      config: CONFIG,
      repositorySets: {
        getSet: () =>
          set({
            bindings: [binding({ status: "retired" })],
            usable: false,
            blocked_reason: "WORKSPACE_ARCHIVED",
          }),
      } as never,
    });
    expect(() => service.list(WORKSPACE)).toThrow(
      expect.objectContaining({ code: "WORKSPACE_ARCHIVED", status: 403 }),
    );
  });

  test("the target list read maps a set refusal to the API envelope", () => {
    const service = new TaskTargetService({
      config: CONFIG,
      repositorySets: {
        getSet: () => {
          throw new WorkspaceRepositorySetError("REPOSITORY_BINDING_MISSING", "missing", 409);
        },
      } as never,
    });
    expect(() => service.list(WORKSPACE)).toThrow(
      expect.objectContaining({ code: "REPOSITORY_BINDING_MISSING", status: 409 }),
    );
  });
});

describe("task projection target migration (schema 5)", () => {
  test("a schema-4 record keeps its reported set version and is never guessed into a target", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-target-migration-"));
    const file = path.join(directory, "tasks.json");
    const record = createTaskRecord({
      id: "tsk_legacy",
      workspaceId: WORKSPACE,
      enterpriseId: ENTERPRISE,
      repository: {
        id: REPOSITORY,
        display_name: "acme/payments",
        base_ref: "main",
        base_sha: BASE_SHA,
      },
      summary: "legacy task",
      sourceReference: null,
      acceptanceCriteria: [],
    }) as TaskRecord;
    delete (record as unknown as Record<string, unknown>)["target"];
    record.repositorySetVersion = 3;
    record.runs.push({
      run_id: "run_legacy",
      state: "merged",
      created_at: record.createdAt,
    } as never);
    fs.writeFileSync(
      file,
      JSON.stringify({ schema_version: 4, tasks: [record], idempotency: {} }),
      "utf8",
    );

    const store = new TaskStore({ persistencePath: file });
    const loaded = store.get("tsk_legacy")!;
    expect(loaded.target).toBeNull();
    expect(loaded.repositorySetVersion).toBe(3);
    expect(loaded.runs[0]!.target).toBeNull();
    expect(loaded.runs[0]!.repository_set_version).toBeNull();
    expect(toTaskResource(loaded).target).toBeNull();
    expect(toTaskResource(loaded).repository_set_version).toBe(3);
  });
});
