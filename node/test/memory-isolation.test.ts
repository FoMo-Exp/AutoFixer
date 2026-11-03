import { describe, expect, test, beforeEach } from "vitest";

import {
  NotFoundError,
  ScopeError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createMemoryRepositories } from "../src/memory/index.js";
import type { MemoryRepositories, MemoryItemRecord } from "../src/memory/index.js";

// ---------------------------------------------------------------------------
// Test helpers: one enterprise with two workspaces, plus a second enterprise.
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let memory: MemoryRepositories;
let scopeA: WorkspaceScope;
let scopeB: WorkspaceScope;
let scopeForeign: WorkspaceScope;

const ACTOR = "usr_admin";

function bootstrap(): { a: WorkspaceScope; b: WorkspaceScope; foreign: WorkspaceScope } {
  const first = seedEnterprise(db, {
    enterprise_name: "Enterprise One",
    enterprise_slug: "ent-one",
    admin_user_id: ACTOR,
  });
  const providerOne = seedProviderInstance(db, first.admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspaceA = seedWorkspace(db, first.admin_scope, {
    name: "Workspace A",
    repository_id: "repo-a",
    provider_instance_id: providerOne.id,
  });
  const workspaceB = seedWorkspace(db, first.admin_scope, {
    name: "Workspace B",
    repository_id: "repo-b",
    provider_instance_id: providerOne.id,
  });
  const second = seedEnterprise(db, {
    enterprise_name: "Enterprise Two",
    enterprise_slug: "ent-two",
    admin_user_id: ACTOR,
  });
  const providerTwo = seedProviderInstance(db, second.admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspaceForeign = seedWorkspace(db, second.admin_scope, {
    name: "Foreign Workspace",
    repository_id: "repo-a",
    provider_instance_id: providerTwo.id,
  });
  return {
    a: { enterprise_id: first.enterprise.id, workspace_id: workspaceA.id, actor_id: ACTOR },
    b: { enterprise_id: first.enterprise.id, workspace_id: workspaceB.id, actor_id: ACTOR },
    foreign: {
      enterprise_id: second.enterprise.id,
      workspace_id: workspaceForeign.id,
      actor_id: ACTOR,
    },
  };
}

function seededItem(
  scope: WorkspaceScope,
  statement = "private workspace memory",
): MemoryItemRecord {
  return memory.items.create(scope, {
    kind: "fact",
    scope: {},
    statement,
    preconditions: [],
    provenance: { author_type: "agent" },
    trust: "agent",
    valid_from: "2026-11-01T00:00:00Z",
    source_run_id: "run_42",
  });
}

function countRows(table: string, where: string, params: (string | number)[]): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params);
  if (row === null || typeof row !== "object" || !("n" in row)) {
    throw new Error(`unexpected COUNT row from ${table}`);
  }
  return Number(row.n);
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  memory = createMemoryRepositories(db);
  ({ a: scopeA, b: scopeB, foreign: scopeForeign } = bootstrap());
});

// ---------------------------------------------------------------------------
// Cross-workspace isolation: reads
// ---------------------------------------------------------------------------

describe("Cross-workspace reads are rejected", () => {
  test("direct reads of another workspace's item are indistinguishable from missing", () => {
    const record = seededItem(scopeA);
    expect(memory.items.getById(scopeB, record.item.id)).toBeUndefined();
    expect(memory.items.getById(scopeForeign, record.item.id)).toBeUndefined();
    expect(memory.items.getVersion(scopeB, record.item.id, 1)).toBeUndefined();
    expect(memory.items.listVersions(scopeB, record.item.id)).toEqual([]);
    expect(memory.items.getEffectiveVersion(scopeB, record.item.id, "2026-11-15T00:00:00Z")).toBe(
      undefined,
    );
    expect(memory.items.listVersionsBySourceRun(scopeB, "run_42")).toEqual([]);
  });

  test("evidence, links, embeddings, events, and tombstones never cross the scope boundary", () => {
    const record = seededItem(scopeA);
    memory.evidence.add(scopeA, record.item.id, { evidence_type: "run", reference: "run_42" });
    memory.embeddings.put(scopeA, {
      item_id: record.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 2,
      vector: "[1,2]",
    });
    expect(memory.evidence.listByItem(scopeB, record.item.id)).toEqual([]);
    expect(memory.links.listByItem(scopeB, record.item.id)).toEqual([]);
    expect(memory.embeddings.listByItem(scopeB, record.item.id)).toEqual([]);
    expect(memory.audit.list(scopeB, { item_id: record.item.id })).toEqual([]);
    expect(memory.audit.list(scopeB, { run_id: "run_42" })).toEqual([]);
    expect(memory.tombstones.list(scopeB)).toEqual([]);
    expect(memory.tombstones.list(scopeForeign)).toEqual([]);
  });

  test("search, browse, and export return nothing of another workspace", () => {
    seededItem(scopeA, "private workspace memory");
    expect(memory.items.search(scopeB, { query: "private" })).toEqual([]);
    expect(memory.items.search(scopeForeign, { query: "private" })).toEqual([]);
    expect(memory.items.list(scopeB)).toEqual([]);
    expect(memory.items.exportWorkspace(scopeB).items).toEqual([]);
    expect(memory.items.exportWorkspace(scopeForeign).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ID substitution and write attempts
// ---------------------------------------------------------------------------

describe("ID substitution is rejected", () => {
  test("an item ID from one workspace is dead in every other scope", () => {
    const record = seededItem(scopeA);
    const bItem = seededItem(scopeB, "workspace B memory");
    // Same enterprise, other workspace.
    expect(() =>
      memory.items.addVersion(
        scopeB,
        record.item.id,
        {
          kind: "fact",
          scope: {},
          statement: "rewrite",
          preconditions: [],
          provenance: { author_type: "agent" },
          trust: "agent",
        },
        1,
      ),
    ).toThrow(NotFoundError);
    expect(() => memory.items.setStatus(scopeB, record.item.id, "candidate", 1)).toThrow(
      NotFoundError,
    );
    expect(() => memory.items.reviewVersion(scopeB, record.item.id, 1, ACTOR)).toThrow(
      NotFoundError,
    );
    expect(() => memory.items.supersede(scopeB, record.item.id, bItem.item.id, "r")).toThrow(
      NotFoundError,
    );
    expect(() => memory.items.deleteItem(scopeB, record.item.id)).toThrow(NotFoundError);
    expect(() =>
      memory.evidence.add(scopeB, record.item.id, { evidence_type: "run", reference: "run_1" }),
    ).toThrow(NotFoundError);
    expect(() =>
      memory.links.create(scopeB, {
        item_id: record.item.id,
        target_item_id: bItem.item.id,
        link_type: "related",
      }),
    ).toThrow(NotFoundError);
    expect(() =>
      memory.embeddings.put(scopeB, {
        item_id: record.item.id,
        item_version: 1,
        model: "emb-1",
        dimensions: 2,
        vector: "[1,2]",
      }),
    ).toThrow(NotFoundError);
    // Foreign enterprise: the substituted enterprise ID grants nothing.
    expect(() => memory.items.deleteItem(scopeForeign, record.item.id)).toThrow(NotFoundError);
    // Nothing above mutated workspace A's rows.
    expect(countRows("memory_items", "workspace_id = ?", [scopeA.workspace_id])).toBe(1);
    expect(countRows("memory_item_versions", "item_id = ?", [record.item.id])).toBe(1);
    expect(countRows("memory_evidence", "item_id = ?", [record.item.id])).toBe(0);
    expect(countRows("memory_links", "workspace_id = ?", [scopeA.workspace_id])).toBe(0);
    expect(countRows("memory_embeddings", "item_id = ?", [record.item.id])).toBe(0);
  });

  test("a scope without enterprise, workspace, or actor fails closed", () => {
    seededItem(scopeA);
    const malformed = [
      { enterprise_id: "", workspace_id: scopeA.workspace_id, actor_id: ACTOR },
      { enterprise_id: scopeA.enterprise_id, workspace_id: "", actor_id: ACTOR },
      { enterprise_id: scopeA.enterprise_id, workspace_id: scopeA.workspace_id, actor_id: "" },
    ];
    for (const broken of malformed) {
      expect(() =>
        memory.items.create(broken, {
          kind: "fact",
          scope: {},
          statement: "s",
          preconditions: [],
          provenance: { author_type: "agent" },
          trust: "agent",
        }),
      ).toThrow(ScopeError);
      expect(() => memory.items.getById(broken, "mem_any")).toThrow(ScopeError);
      expect(() => memory.items.search(broken, {})).toThrow(ScopeError);
      expect(() => memory.items.exportWorkspace(broken)).toThrow(ScopeError);
      expect(() => memory.audit.list(broken)).toThrow(ScopeError);
    }
  });
});

// ---------------------------------------------------------------------------
// No bypass for templates or external retrieval
// ---------------------------------------------------------------------------

describe("No unscoped bypass", () => {
  test("every read surface is scope-bound, so templates and external retrieval cannot route around isolation", () => {
    const record = seededItem(scopeA);
    expect(memory.items.getById(scopeB, record.item.id)).toBeUndefined();
    expect(memory.items.getVersion(scopeB, record.item.id, 1)).toBeUndefined();
    expect(memory.items.listVersions(scopeB, record.item.id)).toEqual([]);
    expect(memory.items.getEffectiveVersion(scopeB, record.item.id, "2026-11-15T00:00:00Z")).toBe(
      undefined,
    );
    expect(memory.items.listVersionsBySourceRun(scopeB, "run_42")).toEqual([]);
    expect(memory.items.list(scopeB)).toEqual([]);
    expect(memory.items.search(scopeB, { query: "private" })).toEqual([]);
    expect(memory.items.exportWorkspace(scopeB).items).toEqual([]);
    expect(memory.evidence.listByItem(scopeB, record.item.id)).toEqual([]);
    expect(memory.links.listByItem(scopeB, record.item.id)).toEqual([]);
    expect(memory.embeddings.listByItem(scopeB, record.item.id)).toEqual([]);
    expect(memory.audit.list(scopeB, { item_id: record.item.id })).toEqual([]);
    expect(memory.tombstones.list(scopeB)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deletion and erasure
// ---------------------------------------------------------------------------

describe("Deletion and erasure", () => {
  test("deleteItem purges item, versions, evidence, links, and embeddings and keeps a tombstone", () => {
    const record = seededItem(scopeA);
    const successor = seededItem(scopeA, "successor");
    memory.evidence.add(scopeA, record.item.id, { evidence_type: "run", reference: "run_42" });
    memory.links.create(scopeA, {
      item_id: successor.item.id,
      target_item_id: record.item.id,
      link_type: "contradicts",
      reason: "conflict",
    });
    memory.embeddings.put(scopeA, {
      item_id: record.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 2,
      vector: "[1,2]",
    });

    memory.items.deleteItem(scopeA, record.item.id);

    // No residue anywhere — embeddings included.
    expect(countRows("memory_items", "id = ?", [record.item.id])).toBe(0);
    expect(countRows("memory_item_versions", "item_id = ?", [record.item.id])).toBe(0);
    expect(countRows("memory_evidence", "item_id = ?", [record.item.id])).toBe(0);
    expect(countRows("memory_links", "target_item_id = ?", [record.item.id])).toBe(0);
    expect(countRows("memory_embeddings", "item_id = ?", [record.item.id])).toBe(0);
    // The unrelated successor item is untouched.
    expect(countRows("memory_items", "id = ?", [successor.item.id])).toBe(1);
    // Minimal tombstone and the audit event survive the purge.
    const tombstones = memory.tombstones.list(scopeA);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.item_id).toBe(record.item.id);
    expect(tombstones[0]?.reason).toBe("item_deleted");
    const deleted = memory.audit.list(scopeA, { event_type: "item_deleted" });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.item_id).toBe(record.item.id);
    expect(() => memory.items.deleteItem(scopeA, record.item.id)).toThrow(NotFoundError);
  });

  test("eraseWorkspace purges the whole workspace memory and leaves other workspaces intact", () => {
    const first = seededItem(scopeA, "first");
    const second = seededItem(scopeA, "second");
    memory.evidence.add(scopeA, first.item.id, { evidence_type: "run", reference: "run_1" });
    memory.embeddings.put(scopeA, {
      item_id: second.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 2,
      vector: "[1,2]",
    });
    const other = seededItem(scopeB, "other workspace memory");

    const result = memory.eraseWorkspace(scopeA);

    expect(result).toEqual({ items_purged: 2, tombstones_written: 2 });
    for (const table of [
      "memory_items",
      "memory_item_versions",
      "memory_evidence",
      "memory_links",
      "memory_embeddings",
    ]) {
      expect(countRows(table, "workspace_id = ?", [scopeA.workspace_id])).toBe(0);
    }
    // Workspace B is untouched — erasure is scope-bound, not global.
    expect(memory.items.getById(scopeB, other.item.id)).toBeDefined();
    // Minimal tombstones plus audit survive.
    expect(
      memory.tombstones
        .list(scopeA)
        .map((t) => t.item_id)
        .sort(),
    ).toEqual([first.item.id, second.item.id].sort());
    for (const tombstone of memory.tombstones.list(scopeA)) {
      expect(tombstone.reason).toBe("workspace_erased");
    }
    const erased = memory.audit.list(scopeA, { event_type: "workspace_erased" });
    expect(erased).toHaveLength(1);
    expect(erased[0]?.detail).toEqual({ items_purged: 2 });
  });

  test("erasure is idempotent in content and always audited", () => {
    seededItem(scopeA);
    memory.eraseWorkspace(scopeA);
    const again = memory.eraseWorkspace(scopeA);
    expect(again).toEqual({ items_purged: 0, tombstones_written: 0 });
    expect(memory.audit.list(scopeA, { event_type: "workspace_erased" })).toHaveLength(2);
  });

  test("deleting the workspace row cascades every memory content row", () => {
    const record = seededItem(scopeA);
    memory.evidence.add(scopeA, record.item.id, { evidence_type: "run", reference: "run_42" });
    memory.embeddings.put(scopeA, {
      item_id: record.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 2,
      vector: "[1,2]",
    });
    db.prepare("DELETE FROM workspace WHERE id = ?").run(scopeA.workspace_id);
    for (const table of [
      "memory_items",
      "memory_item_versions",
      "memory_evidence",
      "memory_links",
      "memory_embeddings",
    ]) {
      expect(countRows(table, "workspace_id = ?", [scopeA.workspace_id])).toBe(0);
    }
    // Audit outlives the workspace it describes.
    expect(memory.audit.list(scopeA).length).toBeGreaterThan(0);
  });
});
