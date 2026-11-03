import { describe, expect, test, beforeEach } from "vitest";

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  createMemoryRepositories,
  memoryContentHash,
  MEMORY_SCHEMA_VERSION,
} from "../src/memory/index.js";
import type {
  AddMemoryVersionInput,
  CreateMemoryItemInput,
  MemoryRepositories,
} from "../src/memory/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let memory: MemoryRepositories;
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
    kind: "lesson",
    scope: { path_prefix: "node/src" },
    statement: "Run npm test before claiming done",
    preconditions: ["node workspace"],
    provenance: { author_type: "agent", agent_model: "test-model" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-11-01T00:00:00Z",
    valid_to: null,
    source_run_id: "run_42",
    ...overrides,
  };
}

function versionContent(overrides: Partial<AddMemoryVersionInput> = {}): AddMemoryVersionInput {
  return {
    kind: "lesson",
    scope: { path_prefix: "node/src" },
    statement: "Prefer scoped repositories over raw SQL",
    preconditions: ["control-plane change"],
    provenance: { author_type: "agent", agent_model: "test-model" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-11-02T00:00:00Z",
    valid_to: null,
    source_run_id: "run_43",
    ...overrides,
  };
}

function createItem(overrides: Partial<CreateMemoryItemInput> = {}) {
  return memory.items.create(scope, itemContent(overrides));
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  if (row === null || typeof row !== "object" || !("n" in row)) {
    throw new Error(`unexpected COUNT row from ${table}`);
  }
  return Number(row.n);
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  memory = createMemoryRepositories(db);
  scope = bootstrap();
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe("Memory migrations", () => {
  test("creates every memory table", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const tables = rows.map((row) => {
      if (row === null || typeof row !== "object" || !("name" in row)) {
        throw new Error("unexpected sqlite_master row");
      }
      return String(row.name);
    });
    expect(tables).toContain("memory_items");
    expect(tables).toContain("memory_item_versions");
    expect(tables).toContain("memory_evidence");
    expect(tables).toContain("memory_links");
    expect(tables).toContain("memory_events");
    expect(tables).toContain("memory_embeddings");
    expect(tables).toContain("memory_tombstones");
    // DAT-234: admission decisions and the retirement candidates a
    // contradiction produces.
    expect(tables).toContain("memory_admission_decisions");
    expect(tables).toContain("memory_retirement_candidates");
  });

  test("is re-runnable and preserves memory rows", () => {
    const record = createItem();
    migrate(db);
    migrate(db);
    const reloaded = memory.items.getById(scope, record.item.id);
    expect(reloaded?.item).toEqual(record.item);
    expect(reloaded?.current).toEqual(record.current);
    const applied = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as { version: number }).version);
    // Versions 1-3 predate both; version 4 is DAT-203's provider access
    // tables, version 5 is DAT-234's admission decisions and retirement
    // candidates. A future migration bumps this list again.
    expect(applied).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Items and immutable versions
// ---------------------------------------------------------------------------

describe("Memory items and immutable versions", () => {
  test("creates an item with its version 1 and matching content hash", () => {
    const record = createItem();
    expect(record.item.status).toBe("proposed");
    expect(record.item.current_version).toBe(1);
    expect(record.item.created_by).toBe(ACTOR);
    expect(record.current.version).toBe(1);
    expect(record.current.kind).toBe("lesson");
    expect(record.current.scope).toEqual({ path_prefix: "node/src" });
    expect(record.current.trust).toBe("agent");
    expect(record.current.sensitivity).toBe("internal");
    expect(record.current.valid_from).toBe("2026-11-01T00:00:00.000Z");
    expect(record.current.valid_to).toBeNull();
    expect(record.current.source_run_id).toBe("run_42");
    expect(record.current.content_hash).toBe(
      memoryContentHash({
        kind: "lesson",
        scope: { path_prefix: "node/src" },
        statement: "Run npm test before claiming done",
        preconditions: ["node workspace"],
        sensitivity: "internal",
      }),
    );
  });

  test("addVersion appends an immutable version and closes the previous window", () => {
    const record = createItem();
    const result = memory.items.addVersion(scope, record.item.id, versionContent(), 1);
    expect(result.created).toBe(true);
    expect(result.version.version).toBe(2);
    const versions = memory.items.listVersions(scope, record.item.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]?.valid_to).toBe("2026-11-02T00:00:00.000Z");
    expect(versions[1]?.valid_to).toBeNull();
    expect(memory.items.getById(scope, record.item.id)?.item.current_version).toBe(2);
  });

  test("version content is never mutated; validity closes at most once", () => {
    const record = createItem();
    const before = memory.items.getVersion(scope, record.item.id, 1);
    memory.items.addVersion(scope, record.item.id, versionContent(), 1);
    memory.items.setStatus(scope, record.item.id, "candidate", 2);
    const after = memory.items.getVersion(scope, record.item.id, 1);
    // Content fields are immutable; only valid_to transitions null → closed,
    // exactly at the successor's valid_from.
    expect(after).toEqual({ ...before, valid_to: "2026-11-02T00:00:00.000Z" });
    // Later operations never rewrite the closed window.
    const successor = createItem({ statement: "successor" });
    memory.items.supersede(scope, record.item.id, successor.item.id, "stale");
    expect(memory.items.getVersion(scope, record.item.id, 1)?.valid_to).toBe(
      "2026-11-02T00:00:00.000Z",
    );
  });

  test("an identical write is an idempotent no-op by content hash", () => {
    const record = createItem();
    const result = memory.items.addVersion(scope, record.item.id, itemContent(), 1);
    expect(result.created).toBe(false);
    expect(result.version.version).toBe(1);
    expect(memory.items.listVersions(scope, record.item.id)).toHaveLength(1);
    expect(memory.items.getById(scope, record.item.id)?.item.current_version).toBe(1);
  });

  test("content hash is canonical over preconditions order", () => {
    const a = memoryContentHash({
      kind: "fact",
      scope: { language: "ts" },
      statement: "s",
      preconditions: ["b", "a"],
      sensitivity: "internal",
    });
    const b = memoryContentHash({
      kind: "fact",
      scope: { language: "ts" },
      statement: "s",
      preconditions: ["a", "b"],
      sensitivity: "internal",
    });
    const different = memoryContentHash({
      kind: "fact",
      scope: { language: "ts" },
      statement: "s",
      preconditions: ["a", "b"],
      sensitivity: "confidential",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(different);
  });

  test("addVersion with a stale expectedVersion throws VersionConflictError", () => {
    const record = createItem();
    expect(() => memory.items.addVersion(scope, record.item.id, versionContent(), 5)).toThrow(
      VersionConflictError,
    );
    expect(memory.items.listVersions(scope, record.item.id)).toHaveLength(1);
  });

  test("validity windows never overlap and never move backwards", () => {
    const record = createItem({
      valid_from: "2026-11-01T00:00:00Z",
      valid_to: "2026-12-01T00:00:00Z",
    });
    expect(() =>
      memory.items.addVersion(
        scope,
        record.item.id,
        versionContent({ valid_from: "2026-10-01T00:00:00Z" }),
        1,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      memory.items.addVersion(
        scope,
        record.item.id,
        versionContent({ valid_from: "2026-11-15T00:00:00Z" }),
        1,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      memory.items.addVersion(
        scope,
        record.item.id,
        versionContent({ valid_from: "2026-11-05T00:00:00Z", valid_to: "2026-11-04T00:00:00Z" }),
        1,
      ),
    ).toThrow(ValidationError);
  });

  test("rejects invalid version content", () => {
    const record = createItem();
    expect(() =>
      memory.items.addVersion(scope, record.item.id, versionContent({ statement: "  " }), 1),
    ).toThrow(ValidationError);
    expect(() =>
      memory.items.addVersion(
        scope,
        record.item.id,
        versionContent({ valid_from: "yesterday" }),
        1,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      memory.items.addVersion(scope, record.item.id, versionContent({ preconditions: [""] }), 1),
    ).toThrow(ValidationError);
    expect(memory.items.listVersions(scope, record.item.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Temporal validity and run reconstruction
// ---------------------------------------------------------------------------

describe("Temporal validity and run reconstruction", () => {
  test("the effective version at a timestamp is exactly one version", () => {
    const record = createItem({
      valid_from: "2026-11-01T00:00:00Z",
      valid_to: "2026-12-01T00:00:00Z",
      statement: "first",
      source_run_id: "run_42",
    });
    memory.items.addVersion(
      scope,
      record.item.id,
      versionContent({ valid_from: "2026-12-01T00:00:00Z", statement: "second" }),
      1,
    );
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-11-15T00:00:00Z")?.statement,
    ).toBe("first");
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-12-15T00:00:00Z")?.statement,
    ).toBe("second");
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-10-01T00:00:00Z"),
    ).toBeUndefined();
    expect(() => memory.items.getEffectiveVersion(scope, record.item.id, "nope")).toThrow(
      ValidationError,
    );
  });

  test("version history rebuilds the memory a historical run used", () => {
    const record = createItem({
      statement: "first",
      valid_from: "2026-11-01T00:00:00Z",
      source_run_id: "run_42",
    });
    memory.items.addVersion(
      scope,
      record.item.id,
      versionContent({ statement: "second", source_run_id: "run_43" }),
      1,
    );
    const run42 = memory.items.listVersionsBySourceRun(scope, "run_42");
    expect(run42).toHaveLength(1);
    expect(run42[0]?.statement).toBe("first");
    const run43 = memory.items.listVersionsBySourceRun(scope, "run_43");
    expect(run43).toHaveLength(1);
    expect(run43[0]?.statement).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Timestamps compare as instants, not strings
// ---------------------------------------------------------------------------

describe("Timestamps are compared as instants, not strings", () => {
  test("a lexicographically larger timestamp may be an earlier instant and is rejected as backwards", () => {
    // "02:00:00+02:00" sorts after "00:30:00Z" but is the earlier instant.
    const record = createItem({ valid_from: "2026-11-01T00:30:00Z" });
    expect(() =>
      memory.items.addVersion(
        scope,
        record.item.id,
        versionContent({ valid_from: "2026-11-01T02:00:00+02:00" }),
        1,
      ),
    ).toThrow(ValidationError);
    expect(memory.items.listVersions(scope, record.item.id)).toHaveLength(1);
  });

  test("a later instant with a lexicographically smaller string is accepted and closes the window", () => {
    // "02:00:00+02:00" == 00:00Z; "00:30:00Z" is the later instant.
    const record = createItem({ valid_from: "2026-11-01T02:00:00+02:00" });
    expect(record.current.valid_from).toBe("2026-11-01T00:00:00.000Z");
    const result = memory.items.addVersion(
      scope,
      record.item.id,
      versionContent({ valid_from: "2026-11-01T00:30:00Z" }),
      1,
    );
    expect(result.created).toBe(true);
    const versions = memory.items.listVersions(scope, record.item.id);
    expect(versions[0]?.valid_to).toBe("2026-11-01T00:30:00.000Z");
  });

  test("a validity window is judged by instants across offsets", () => {
    // valid_to 00:30Z is later than valid_from 00:00Z despite its string form.
    const accepted = createItem({
      valid_from: "2026-11-01T02:00:00+02:00",
      valid_to: "2026-11-01T00:30:00Z",
    });
    expect(accepted.current.valid_to).toBe("2026-11-01T00:30:00.000Z");
    // The mirror case is a backwards window and must be rejected.
    expect(() =>
      createItem({
        valid_from: "2026-11-01T00:30:00Z",
        valid_to: "2026-11-01T02:00:00+02:00",
      }),
    ).toThrow(ValidationError);
  });

  test("getEffectiveVersion resolves mixed-offset instants to the right version", () => {
    const record = createItem({ valid_from: "2026-11-01T02:00:00+02:00" }); // 00:00Z
    memory.items.addVersion(
      scope,
      record.item.id,
      versionContent({ valid_from: "2026-11-02T00:00:00Z" }),
      1,
    );
    // 03:00Z on Nov 1 → version 1, expressed with a +02:00 offset.
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-11-01T05:00:00+02:00")?.version,
    ).toBe(1);
    // Boundary: the exact instant of version 1's valid_from in yet another form.
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-10-31T19:00:00-05:00")?.version,
    ).toBe(1);
    // 03:00Z on Nov 2 → version 2, expressed with a -05:00 offset.
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-11-01T22:00:00-05:00")?.version,
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Timestamp precision
// ---------------------------------------------------------------------------

describe("Timestamp precision is limited to milliseconds", () => {
  test("sub-millisecond fractions are rejected, never silently merged", () => {
    // .0001Z and .0009Z are distinct instants; collapsing them to .000Z would
    // merge them and could squeeze a valid window to zero length.
    expect(() =>
      createItem({
        valid_from: "2026-11-01T00:00:00.0001Z",
        valid_to: "2026-11-01T00:00:00.0009Z",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createItem({
        valid_from: "2026-11-01T00:00:00.001Z",
        valid_to: "2026-11-01T00:00:00.0021Z",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createItem({
        valid_from: "2026-11-01T00:00:00.000001-05:00",
      }),
    ).toThrow(ValidationError);
    const record = createItem();
    expect(() =>
      memory.items.addVersion(
        scope,
        record.item.id,
        versionContent({ valid_from: "2026-11-01T00:00:00.0009Z" }),
        1,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-11-01T00:00:00.0005Z"),
    ).toThrow(ValidationError);
  });

  test("millisecond instants round-trip exactly and stay distinct", () => {
    const record = createItem({ valid_from: "2026-11-01T00:00:00.001Z" });
    expect(record.current.valid_from).toBe("2026-11-01T00:00:00.001Z");
    memory.items.addVersion(
      scope,
      record.item.id,
      versionContent({ valid_from: "2026-11-01T00:00:00.002Z" }),
      1,
    );
    const versions = memory.items.listVersions(scope, record.item.id);
    expect(versions[0]?.valid_to).toBe("2026-11-01T00:00:00.002Z");
    // Instants one millisecond apart must never collapse: each boundary
    // resolves to exactly one version.
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-11-01T00:00:00.001Z")?.version,
    ).toBe(1);
    expect(
      memory.items.getEffectiveVersion(scope, record.item.id, "2026-11-01T00:00:00.002Z")?.version,
    ).toBe(2);
  });

  test("coarse fractions canonicalize to milliseconds without changing the instant", () => {
    const record = createItem({ valid_from: "2026-11-01T00:00:00.5Z" });
    expect(record.current.valid_from).toBe("2026-11-01T00:00:00.500Z");
  });
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

describe("Version review", () => {
  test("approval stamps one exact version and is set-once", () => {
    const record = createItem();
    const reviewed = memory.items.reviewVersion(scope, record.item.id, 1, "usr_lead");
    expect(reviewed.review).toEqual({
      approver_id: "usr_lead",
      approved_at: expect.any(String),
    });
    const again = memory.items.reviewVersion(scope, record.item.id, 1, "usr_other");
    expect(again.review?.approver_id).toBe("usr_lead");
    expect(memory.items.getVersion(scope, record.item.id, 1)?.review).not.toBeNull();
  });

  test("reviewing an unknown version is rejected", () => {
    const record = createItem();
    expect(() => memory.items.reviewVersion(scope, record.item.id, 9, "usr_lead")).toThrow(
      NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

describe("Memory status machine", () => {
  test("walks the ADR-0009 lifecycle with evidence gating on active", () => {
    const record = createItem();
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
    expect(() => memory.items.setStatus(scope, record.item.id, "active", 1)).toThrow(
      ValidationError,
    );
    memory.evidence.add(scope, record.item.id, {
      evidence_type: "run",
      reference: "run_42",
    });
    const active = memory.items.setStatus(scope, record.item.id, "active", 1);
    expect(active.status).toBe("active");
    expect(memory.items.setStatus(scope, record.item.id, "deprecated", 1).status).toBe(
      "deprecated",
    );
    expect(memory.items.setStatus(scope, record.item.id, "retired", 1).status).toBe("retired");
  });

  test("rejects transitions the state machine does not allow", () => {
    const record = createItem();
    expect(() => memory.items.setStatus(scope, record.item.id, "active", 1)).toThrow(
      ValidationError,
    );
    expect(() => memory.items.setStatus(scope, record.item.id, "retired", 1)).toThrow(
      ValidationError,
    );
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
    memory.items.setStatus(scope, record.item.id, "deprecated", 1);
    memory.items.setStatus(scope, record.item.id, "retired", 1);
    expect(() => memory.items.setStatus(scope, record.item.id, "candidate", 1)).toThrow(
      ValidationError,
    );
  });

  test("quarantine is reachable from any non-terminal state and restore reopens as candidate", () => {
    const record = createItem();
    memory.items.setStatus(scope, record.item.id, "quarantined", 1);
    expect(memory.items.setStatus(scope, record.item.id, "candidate", 1).status).toBe("candidate");
  });

  test("same-status transition is a conflict, stale version is a version conflict", () => {
    const record = createItem();
    expect(() => memory.items.setStatus(scope, record.item.id, "proposed", 1)).toThrow(
      ConflictError,
    );
    expect(() => memory.items.setStatus(scope, record.item.id, "candidate", 7)).toThrow(
      VersionConflictError,
    );
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe("Supersession", () => {
  test("supersedes with a recorded reason, closes validity, deprecates the old item", () => {
    const previous = createItem({ statement: "old fact" });
    const successor = createItem({ statement: "new fact" });
    const link = memory.items.supersede(scope, previous.item.id, successor.item.id, "stale");
    expect(link.link_type).toBe("supersedes");
    expect(link.item_id).toBe(successor.item.id);
    expect(link.target_item_id).toBe(previous.item.id);
    expect(link.reason).toBe("stale");
    expect(memory.items.getById(scope, previous.item.id)?.item.status).toBe("deprecated");
    const versions = memory.items.listVersions(scope, previous.item.id);
    expect(versions[0]?.valid_to).not.toBeNull();
  });

  test("a quarantined item keeps its status through supersession", () => {
    const previous = createItem({ statement: "poisoned" });
    memory.items.setStatus(scope, previous.item.id, "quarantined", 1);
    const successor = createItem({ statement: "replacement" });
    memory.items.supersede(scope, previous.item.id, successor.item.id, "security report");
    expect(memory.items.getById(scope, previous.item.id)?.item.status).toBe("quarantined");
    expect(memory.links.listByItem(scope, previous.item.id)).toHaveLength(1);
  });

  test("rejects self-supersession, missing reason, and duplicate supersession", () => {
    const previous = createItem({ statement: "old" });
    const successor = createItem({ statement: "new" });
    expect(() => memory.items.supersede(scope, previous.item.id, previous.item.id, "r")).toThrow(
      ValidationError,
    );
    expect(() => memory.items.supersede(scope, previous.item.id, successor.item.id, "  ")).toThrow(
      ValidationError,
    );
    memory.items.supersede(scope, previous.item.id, successor.item.id, "r");
    expect(() => memory.items.supersede(scope, previous.item.id, successor.item.id, "r")).toThrow(
      ConflictError,
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence and links
// ---------------------------------------------------------------------------

describe("Evidence and links", () => {
  test("evidence attaches to items and is validated", () => {
    const record = createItem();
    const evidence = memory.evidence.add(scope, record.item.id, {
      evidence_type: "reviewer_decision",
      reference: "pr-7#review",
      note: "approved",
    });
    expect(evidence.evidence_type).toBe("reviewer_decision");
    expect(memory.evidence.listByItem(scope, record.item.id)).toHaveLength(1);
    expect(() =>
      memory.evidence.add(scope, record.item.id, {
        evidence_type: "run",
        reference: "  ",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      memory.evidence.add(scope, "mem_missing", { evidence_type: "run", reference: "run_1" }),
    ).toThrow(NotFoundError);
  });

  test("links join two in-workspace items and duplicates conflict", () => {
    const a = createItem({ statement: "a" });
    const b = createItem({ statement: "b" });
    const link = memory.links.create(scope, {
      item_id: a.item.id,
      target_item_id: b.item.id,
      link_type: "contradicts",
      reason: "conflicting reports",
    });
    expect(link.link_type).toBe("contradicts");
    expect(memory.links.listByItem(scope, b.item.id).map((l) => l.id)).toContain(link.id);
    expect(() =>
      memory.links.create(scope, {
        item_id: a.item.id,
        target_item_id: b.item.id,
        link_type: "contradicts",
        reason: "again",
      }),
    ).toThrow(ConflictError);
    expect(() =>
      memory.links.create(scope, {
        item_id: a.item.id,
        target_item_id: a.item.id,
        link_type: "related",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      memory.links.create(scope, {
        item_id: a.item.id,
        target_item_id: b.item.id,
        link_type: "contradicts",
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

describe("Embeddings", () => {
  test("embeddings attach to an exact version and replace per model", () => {
    const record = createItem();
    memory.embeddings.put(scope, {
      item_id: record.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 3,
      vector: "[1,2,3]",
    });
    memory.embeddings.put(scope, {
      item_id: record.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 3,
      vector: "[4,5,6]",
    });
    memory.items.addVersion(scope, record.item.id, versionContent(), 1);
    memory.embeddings.put(scope, {
      item_id: record.item.id,
      item_version: 2,
      model: "emb-1",
      dimensions: 3,
      vector: "[7,8,9]",
    });
    const embeddings = memory.embeddings.listByItem(scope, record.item.id);
    expect(embeddings).toHaveLength(2);
    expect(embeddings.find((e) => e.item_version === 1)?.vector).toBe("[4,5,6]");
    expect(embeddings.find((e) => e.item_version === 2)?.vector).toBe("[7,8,9]");
  });

  test("an embedding for an unknown or foreign version is rejected", () => {
    const record = createItem();
    expect(() =>
      memory.embeddings.put(scope, {
        item_id: record.item.id,
        item_version: 9,
        model: "emb-1",
        dimensions: 3,
        vector: "[1,2,3]",
      }),
    ).toThrow(NotFoundError);
    expect(countRows("memory_embeddings")).toBe(0);
    expect(() =>
      memory.embeddings.put(scope, {
        item_id: record.item.id,
        item_version: 1,
        model: "emb-1",
        dimensions: 0,
        vector: "[1,2,3]",
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("Audit trail", () => {
  test("every mutation is recorded with actor, version, and non-sensitive detail", () => {
    const record = createItem({ statement: "secret statement" });
    memory.evidence.add(scope, record.item.id, { evidence_type: "run", reference: "run_42" });
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
    memory.items.addVersion(scope, record.item.id, versionContent(), 1);
    memory.items.reviewVersion(scope, record.item.id, 2, "usr_lead");
    const successor = createItem({ statement: "successor" });
    memory.items.supersede(scope, record.item.id, successor.item.id, "SECRET_REASON_MARKER");
    memory.embeddings.put(scope, {
      item_id: successor.item.id,
      item_version: 1,
      model: "emb-1",
      dimensions: 2,
      vector: "[1,2]",
    });
    memory.items.deleteItem(scope, successor.item.id);

    const events = memory.audit.list(scope, { limit: 100 });
    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      "item_created",
      "evidence_added",
      "status_changed",
      "version_created",
      "version_reviewed",
      "item_created",
      "link_created",
      "status_changed",
      "embedding_written",
      "item_deleted",
    ]);
    for (const event of events) {
      expect(event.actor_id).toBe(ACTOR);
      expect(event.workspace_id).toBe(scope.workspace_id);
      // Audit survives deletion, so it must never carry memory content or the
      // free-text supersession reason.
      expect(JSON.stringify(event.detail)).not.toContain("secret statement");
      expect(JSON.stringify(event.detail)).not.toContain("SECRET_REASON_MARKER");
    }
    expect(memory.audit.list(scope, { item_id: record.item.id }).length).toBeGreaterThan(0);
    expect(memory.audit.list(scope, { event_type: "embedding_written" })).toHaveLength(1);
    expect(memory.audit.list(scope, { run_id: "run_42" }).length).toBeGreaterThan(0);
    expect(() => memory.audit.list(scope, { limit: 0 })).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("Export", () => {
  test("exports items with versions, evidence, and links", () => {
    const record = createItem();
    memory.evidence.add(scope, record.item.id, { evidence_type: "run", reference: "run_42" });
    memory.items.addVersion(scope, record.item.id, versionContent(), 1);
    const exported = memory.items.exportWorkspace(scope);
    expect(exported.schema_version).toBe(MEMORY_SCHEMA_VERSION);
    expect(exported.workspace_id).toBe(scope.workspace_id);
    expect(exported.items).toHaveLength(1);
    const entry = exported.items[0];
    expect(entry?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(entry?.evidence).toHaveLength(1);
    expect(entry?.item.id).toBe(record.item.id);
  });

  test("the export is bounded", () => {
    createItem();
    expect(() => memory.items.exportWorkspace(scope, 0)).toThrow(ValidationError);
    expect(memory.items.exportWorkspace(scope, 1).items).toHaveLength(1);
    expect(memory.items.exportWorkspace(scope, 10_000).items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Search and browse
// ---------------------------------------------------------------------------

describe("Search and browse", () => {
  test("search matches current statements and filters by kind and status", () => {
    createItem({ statement: "npm test must pass" });
    createItem({ statement: "flaky suite known", kind: "fact" });
    expect(memory.items.search(scope, { query: "npm" }).map((r) => r.current.statement)).toEqual([
      "npm test must pass",
    ]);
    expect(memory.items.search(scope, { query: "npm" })).toHaveLength(1);
    expect(memory.items.list(scope, { kind: "fact" })).toHaveLength(1);
    expect(memory.items.list(scope, { status: "proposed" })).toHaveLength(2);
    expect(memory.items.search(scope, { query: "%" })).toHaveLength(0);
    expect(() => memory.items.search(scope, { limit: -1 })).toThrow(ValidationError);
  });
});
