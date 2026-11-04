import { describe, expect, test, beforeEach, vi } from "vitest";

import {
  createRepositories,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, Workspace, WorkspaceScope } from "../src/control-plane/index.js";
import { createMemoryConsolidationRunner, createMemoryRepositories } from "../src/memory/index.js";
import type {
  ConsolidationOptions,
  ConsolidationReport,
  CreateMemoryItemInput,
  MemoryRepositories,
} from "../src/memory/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let memory: MemoryRepositories;
let enterpriseId: string;
let ws1: Workspace;
let ws2: Workspace;

const ACTOR = "usr_admin";

function itemContent(overrides: Partial<CreateMemoryItemInput> = {}): CreateMemoryItemInput {
  return {
    kind: "fact",
    scope: { path_prefix: "node/" },
    statement: "The node workspace builds with npm test",
    preconditions: ["node workspace"],
    provenance: { author_type: "agent", agent_model: "test-model" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-11-01T00:00:00Z",
    valid_to: null,
    source_run_id: "run_1",
    ...overrides,
  };
}

function workspaceScope(workspace: Workspace): WorkspaceScope {
  return { enterprise_id: workspace.enterprise_id, workspace_id: workspace.id, actor_id: ACTOR };
}

/** Two exact-duplicate facts in one workspace, with distinct evidence. */
function seedDuplicatePair(workspace: Workspace): { canonical: string; duplicate: string } {
  const scope = workspaceScope(workspace);
  const canonical = memory.items.create(scope, itemContent());
  memory.evidence.add(scope, canonical.item.id, { evidence_type: "test", reference: "t1" });
  memory.items.setStatus(scope, canonical.item.id, "candidate", 1);
  const duplicate = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
  memory.evidence.add(scope, duplicate.item.id, { evidence_type: "test", reference: "t2" });
  return { canonical: canonical.item.id, duplicate: duplicate.item.id };
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  memory = createMemoryRepositories(db);
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  enterpriseId = enterprise.id;
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  ws1 = seedWorkspace(db, admin_scope, {
    name: "Workspace One",
    repository_id: "repo-1",
    provider_instance_id: provider.id,
  });
  ws2 = seedWorkspace(db, admin_scope, {
    name: "Workspace Two",
    repository_id: "repo-2",
    provider_instance_id: provider.id,
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe("memory consolidation runner", () => {
  test("consolidates every active workspace of the enterprise", () => {
    const pair = seedDuplicatePair(ws1);
    const reports: { workspaceId: string; report: ConsolidationReport }[] = [];
    const runner = createMemoryConsolidationRunner({
      db,
      enterpriseId,
      actorId: ACTOR,
      onReport: (workspaceId, report) => reports.push({ workspaceId, report }),
    });

    runner.tick();

    expect(reports.map((entry) => entry.workspaceId).sort()).toEqual([ws1.id, ws2.id].sort());
    const first = reports.find((entry) => entry.workspaceId === ws1.id);
    expect(first?.report.ops.filter((op) => op.op === "merge")).toHaveLength(1);
    const second = reports.find((entry) => entry.workspaceId === ws2.id);
    expect(second?.report.ops).toHaveLength(0);

    // The effects landed in the right workspace, and only there.
    expect(memory.items.getById(workspaceScope(ws1), pair.duplicate)?.item.status).toBe("retired");
    expect(memory.items.getById(workspaceScope(ws2), pair.canonical)).toBeUndefined();
  });

  test("one workspace's failed pass never blocks the others", () => {
    const pair = seedDuplicatePair(ws1);
    const ws2Item = memory.items.create(workspaceScope(ws2), itemContent());
    const errors: unknown[] = [];
    const runner = createMemoryConsolidationRunner({
      db,
      enterpriseId,
      actorId: ACTOR,
      optionsFor: (workspaceId): ConsolidationOptions =>
        workspaceId === ws2.id
          ? {
              proposals: [
                // Missing successor: runConsolidation rejects the proposal and
                // the workspace's pass fails.
                {
                  op: "supersede",
                  item_id: ws2Item.item.id,
                  reason_code: "retirement_proposal",
                },
              ],
            }
          : {},
      onError: (error) => errors.push(error),
    });

    runner.tick();

    expect(errors).toHaveLength(1);
    expect(memory.items.getById(workspaceScope(ws1), pair.duplicate)?.item.status).toBe("retired");
  });

  test("ticks on the configured interval and stops on demand", () => {
    vi.useFakeTimers();
    try {
      const reports: string[] = [];
      const runner = createMemoryConsolidationRunner({
        db,
        enterpriseId,
        actorId: ACTOR,
        intervalMs: 1000,
        onReport: (workspaceId) => reports.push(workspaceId),
      });
      runner.start();
      runner.start(); // idempotent: a second start does not double the schedule
      vi.advanceTimersByTime(2000);
      expect(reports).toHaveLength(4); // two workspaces × two ticks

      runner.stop();
      vi.advanceTimersByTime(5000);
      expect(reports).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed tick reaches onError and the schedule survives", () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const errors: unknown[] = [];
      const runner = createMemoryConsolidationRunner({
        db,
        enterpriseId,
        actorId: ACTOR,
        intervalMs: 1000,
        optionsFor: () => {
          if (fail) {
            fail = false;
            throw new Error("options resolution failed");
          }
          return {};
        },
        onError: (error) => errors.push(error),
      });
      runner.start();
      vi.advanceTimersByTime(2000);
      runner.stop();
      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("archived workspaces are not consolidated", () => {
    createRepositories(db).workspaces.archive(
      { enterprise_id: enterpriseId, actor_id: ACTOR },
      ws2.id,
      ws2.version,
    );
    const reports: string[] = [];
    const runner = createMemoryConsolidationRunner({
      db,
      enterpriseId,
      actorId: ACTOR,
      onReport: (workspaceId) => reports.push(workspaceId),
    });
    runner.tick();
    expect(reports).toEqual([ws1.id]);
  });
});
