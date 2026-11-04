import { describe, expect, test, beforeEach } from "vitest";

import {
  NotFoundError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  approveAndPromote,
  assessAndAutoPromote,
  createMemoryLifecycleStore,
  createMemoryRepositories,
  runConsolidation,
} from "../src/memory/index.js";
import type {
  CreateMemoryItemInput,
  MemoryLifecycleStore,
  MemoryRepositories,
  RunSupport,
} from "../src/memory/index.js";

// ---------------------------------------------------------------------------
// Deletion stickiness: deleted memory is never silently rebuilt from
// retained evidence. Purge and tombstone semantics themselves are covered by
// memory-isolation.test.ts; what is proven here is that nothing in the
// lifecycle brings deleted content back — consolidation, promotion, and
// retained proposals all refuse the deleted identity, and the only way back
// is the full write path, which lands `proposed` and visible.
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let memory: MemoryRepositories;
let lifecycle: MemoryLifecycleStore;
let scope: WorkspaceScope;

const ACTOR = "usr_admin";

function bootstrap(): WorkspaceScope {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "Repo Workspace",
    repository_id: "repo-1",
    provider_instance_id: provider.id,
  });
  return { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: ACTOR };
}

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

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  if (row === null || typeof row !== "object" || !("n" in row)) {
    throw new Error(`unexpected COUNT row from ${table}`);
  }
  return Number(row.n);
}

function retainedLedger(): RunSupport[] {
  // What the outcome-capture path still holds after the item is gone: two
  // known supporting runs over evidence that predates the deletion.
  return [
    {
      run_id: "run_1",
      known_outcome: true,
      evidence: [{ evidence_type: "test", reference: "t1" }],
    },
    {
      run_id: "run_2",
      known_outcome: true,
      evidence: [{ evidence_type: "test", reference: "t2" }],
    },
  ];
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  memory = createMemoryRepositories(db);
  lifecycle = createMemoryLifecycleStore(db);
  scope = bootstrap();
});

describe("Deleted memory is never silently rebuilt", () => {
  test("consolidation recreates nothing after a deletion, even over retained evidence", () => {
    const deleted = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, deleted.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, deleted.item.id, "candidate", 1);
    const hash = deleted.current.content_hash;
    memory.items.deleteItem(scope, deleted.item.id);

    const survivor = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, survivor.item.id, { evidence_type: "test", reference: "t2" });

    const report = runConsolidation(scope, { memory, lifecycle });
    expect(report.ops).toHaveLength(0);
    // No item carries the deleted content again; the only row is the one
    // survivor that predates the deletion.
    expect(countRows("memory_items")).toBe(1);
    expect(memory.items.search(scope, { query: "npm test" })).toHaveLength(1);
    expect(memory.tombstones.getByItem(scope, deleted.item.id)?.reason).toBe("item_deleted");
    expect(hash).toEqual(expect.any(String));
  });

  test("a retained proposal naming a deleted identity is skipped, never re-derived", () => {
    const deleted = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, deleted.item.id, { evidence_type: "test", reference: "t1" });
    const successor = memory.items.create(scope, itemContent({ statement: "newer fact" }));
    memory.evidence.add(scope, successor.item.id, { evidence_type: "test", reference: "t2" });
    memory.items.deleteItem(scope, deleted.item.id);
    const itemsBefore = countRows("memory_items");

    const report = runConsolidation(
      scope,
      { memory, lifecycle },
      {
        proposals: [
          {
            op: "supersede",
            item_id: deleted.item.id,
            successor_item_id: successor.item.id,
            reason_code: "retirement_proposal",
          },
          { op: "quarantine", item_id: deleted.item.id, reason_code: "security_report" },
        ],
      },
    );
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "supersede",
        item_id: deleted.item.id,
        reason_code: "item_deleted",
        applied: false,
      }),
      expect.objectContaining({
        op: "quarantine",
        item_id: deleted.item.id,
        reason_code: "item_deleted",
        applied: false,
      }),
    ]);
    expect(report.ops_applied).toBe(0);
    expect(countRows("memory_items")).toBe(itemsBefore);
    expect(memory.tombstones.getByItem(scope, deleted.item.id)?.reason).toBe("item_deleted");
  });

  test("a deleted identity is tombstoned, distinct from one that never existed", () => {
    const deleted = memory.items.create(scope, itemContent());
    memory.items.deleteItem(scope, deleted.item.id);
    expect(memory.tombstones.getByItem(scope, deleted.item.id)?.item_id).toBe(deleted.item.id);
    expect(memory.tombstones.getByItem(scope, "mem_never_existed")).toBeUndefined();
  });

  test("promotion refuses a deleted identity and records no decision", () => {
    const deleted = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, deleted.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, deleted.item.id, "candidate", 1);
    memory.items.deleteItem(scope, deleted.item.id);
    const itemsBefore = countRows("memory_items");

    expect(() =>
      assessAndAutoPromote(
        scope,
        { memory, lifecycle },
        {
          itemId: deleted.item.id,
          support: retainedLedger(),
          validation: { disposition: "admitted" },
          evaluation: { delta: 1 },
        },
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      approveAndPromote(scope, { memory, lifecycle }, { itemId: deleted.item.id, version: 1 }),
    ).toThrow(NotFoundError);
    expect(lifecycle.listPromotionDecisions(scope, { item_id: deleted.item.id })).toHaveLength(0);
    expect(countRows("memory_items")).toBe(itemsBefore);
  });

  test("re-creating the same content goes through the write path and lands proposed", () => {
    const deleted = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, deleted.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, deleted.item.id, "candidate", 1);
    memory.items.setStatus(scope, deleted.item.id, "active", 1);
    memory.items.deleteItem(scope, deleted.item.id);

    // The write path is the only sanctioned way back: a fresh identity, a
    // fresh proposed item, a fresh promotion assessment — never a silent
    // restore of the deleted row and never straight to `active`.
    const recreated = memory.items.create(scope, itemContent());
    expect(recreated.item.id).not.toBe(deleted.item.id);
    expect(recreated.item.status).toBe("proposed");
    expect(recreated.current.content_hash).toBe(deleted.current.content_hash);
    expect(memory.tombstones.getByItem(scope, deleted.item.id)?.reason).toBe("item_deleted");

    memory.evidence.add(scope, recreated.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, recreated.item.id, "candidate", 1);
    const decision = assessAndAutoPromote(
      scope,
      { memory, lifecycle },
      {
        itemId: recreated.item.id,
        support: retainedLedger(),
        validation: { disposition: "admitted" },
        evaluation: { delta: 0 },
      },
    );
    expect(decision.outcome).toBe("promoted");
    expect(memory.items.getById(scope, recreated.item.id)?.item.status).toBe("active");
  });

  test("a merge never touches or rebuilds a deleted duplicate", () => {
    const survivor = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, survivor.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, survivor.item.id, "candidate", 1);
    const duplicate = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, duplicate.item.id, { evidence_type: "test", reference: "t2" });
    memory.items.deleteItem(scope, duplicate.item.id);

    const report = runConsolidation(scope, { memory, lifecycle });
    expect(report.ops).toHaveLength(0);
    expect(countRows("memory_items")).toBe(1);
    expect(memory.items.getById(scope, survivor.item.id)?.item.status).toBe("candidate");
    expect(memory.tombstones.getByItem(scope, duplicate.item.id)?.reason).toBe("item_deleted");
  });

  test("workspace erasure leaves tombstones and nothing rebuilds", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    const erased = memory.eraseWorkspace(scope);
    expect(erased.items_purged).toBe(1);

    const report = runConsolidation(
      scope,
      { memory, lifecycle },
      {
        proposals: [{ op: "quarantine", item_id: record.item.id, reason_code: "security_report" }],
      },
    );
    expect(report.items_scanned).toBe(0);
    expect(report.ops).toEqual([
      expect.objectContaining({ reason_code: "item_deleted", applied: false }),
    ]);
    expect(countRows("memory_items")).toBe(0);
    expect(memory.tombstones.getByItem(scope, record.item.id)?.reason).toBe("workspace_erased");
  });
});
