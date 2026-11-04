import { describe, expect, test, beforeEach, vi } from "vitest";

import {
  ValidationError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  CONSOLIDATION_OPS,
  CONSOLIDATION_OP_REASONS,
  createMemoryLifecycleStore,
  createMemoryRepositories,
  runConsolidation,
  scheduleMemoryConsolidation,
} from "../src/memory/index.js";
import type {
  ConsolidationOpRecord,
  ConsolidationReport,
  CreateMemoryItemInput,
  FactVerifier,
  MemoryItemRecord,
  MemoryLifecycleStore,
  MemoryRepositories,
} from "../src/memory/index.js";

// ---------------------------------------------------------------------------
// Fixtures
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

function mustGet(itemId: string): MemoryItemRecord {
  const record = memory.items.getById(scope, itemId);
  if (record === undefined) {
    throw new Error(`expected memory item ${itemId}`);
  }
  return record;
}

function evidenceOf(itemId: string): string[] {
  return memory.evidence
    .listByItem(scope, itemId)
    .map((row) => `${row.evidence_type}:${row.reference}`)
    .sort();
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  if (row === null || typeof row !== "object" || !("n" in row)) {
    throw new Error(`unexpected COUNT row from ${table}`);
  }
  return Number(row.n);
}

function consolidate(options: Parameters<typeof runConsolidation>[2] = {}): ConsolidationReport {
  return runConsolidation(scope, { memory, lifecycle }, options);
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  memory = createMemoryRepositories(db);
  lifecycle = createMemoryLifecycleStore(db);
  scope = bootstrap();
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("Consolidation merges exact duplicates", () => {
  test("folds evidence into the canonical and retires the absorbed duplicate", () => {
    const canonical = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, canonical.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, canonical.item.id, "candidate", 1);

    const duplicate = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, duplicate.item.id, { evidence_type: "test", reference: "t1" });
    memory.evidence.add(scope, duplicate.item.id, { evidence_type: "test", reference: "t2" });

    const report = consolidate();

    const mergeOps = report.ops.filter((op) => op.op === "merge");
    expect(mergeOps).toHaveLength(1);
    expect(mergeOps[0]).toMatchObject({
      item_id: duplicate.item.id,
      target_item_id: canonical.item.id,
      reason_code: "duplicate_content",
      applied: true,
      detail: { evidence_folded: 1 },
    });
    // The duplicate is absorbed but retained for audit: merge never deletes.
    expect(mustGet(duplicate.item.id).item.status).toBe("retired");
    expect(mustGet(canonical.item.id).item.status).toBe("candidate");
    expect(evidenceOf(canonical.item.id)).toEqual(["test:t1", "test:t2"]);
    expect(countRows("memory_items")).toBe(2);
    expect(countRows("memory_tombstones")).toBe(0);
    const links = memory.links.listByItem(scope, canonical.item.id);
    expect(links).toEqual([
      expect.objectContaining({ link_type: "related", target_item_id: duplicate.item.id }),
    ]);
  });

  test("the canonical survivor is deterministic: status rank, then age", () => {
    const active = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, active.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, active.item.id, "candidate", 1);
    memory.items.setStatus(scope, active.item.id, "active", 1);

    const duplicate = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, duplicate.item.id, { evidence_type: "test", reference: "t2" });

    const report = consolidate();
    const mergeOp = report.ops.find((op) => op.op === "merge");
    expect(mergeOp?.target_item_id).toBe(active.item.id);
    expect(mustGet(active.item.id).item.status).toBe("active");
    expect(mustGet(duplicate.item.id).item.status).toBe("retired");
  });

  test("different content is never merged", () => {
    memory.items.create(scope, itemContent());
    memory.items.create(scope, itemContent({ statement: "different statement" }));
    const report = consolidate();
    expect(report.ops.filter((op) => op.op === "merge")).toHaveLength(0);
    expect(countRows("memory_items")).toBe(2);
  });

  test("quarantined and retired items are never merged", () => {
    const live = memory.items.create(scope, itemContent());
    memory.items.setStatus(scope, live.item.id, "quarantined", 1);
    const other = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    const report = consolidate();
    expect(report.ops).toHaveLength(0);
    expect(mustGet(live.item.id).item.status).toBe("quarantined");
    expect(mustGet(other.item.id).item.status).toBe("proposed");
  });
});

// ---------------------------------------------------------------------------
// Confidence counters
// ---------------------------------------------------------------------------

describe("Consolidation recomputes confidence counters", () => {
  test("duplicate citations count once and open contradictions count", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    memory.evidence.add(scope, record.item.id, { evidence_type: "pr", reference: "t1" });

    const other = memory.items.create(scope, itemContent({ statement: "conflicting fact" }));
    memory.evidence.add(scope, other.item.id, { evidence_type: "test", reference: "t9" });
    memory.links.create(scope, {
      item_id: record.item.id,
      target_item_id: other.item.id,
      link_type: "contradicts",
      reason: "conflict",
    });

    const report = consolidate();
    const reloaded = mustGet(record.item.id).item;
    expect(reloaded.support_count).toBe(2); // test:t1 and pr:t1
    expect(reloaded.contradiction_count).toBe(1); // other side still open
    expect(report.counts_recomputed).toBeGreaterThanOrEqual(1);

    // Resolving the contradiction drops the count on the next run.
    memory.items.setStatus(scope, other.item.id, "deprecated", 1);
    consolidate();
    expect(mustGet(record.item.id).item.contradiction_count).toBe(0);
  });

  test("confidence counters reject invalid values", () => {
    const record = memory.items.create(scope, itemContent());
    expect(() =>
      memory.items.setConfidenceCounts(scope, record.item.id, {
        supportCount: -1,
        contradictionCount: 0,
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe("Consolidation expires items past their validity window", () => {
  test("an expired item is deprecated once, with an auditable op", () => {
    const record = memory.items.create(scope, itemContent({ valid_to: "2026-11-02T00:00:00Z" }));
    memory.items.setStatus(scope, record.item.id, "candidate", 1);

    const report = consolidate({ at: "2026-11-05T00:00:00Z" });
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "expire",
        item_id: record.item.id,
        reason_code: "past_valid_to",
        applied: true,
      }),
    ]);
    expect(mustGet(record.item.id).item.status).toBe("deprecated");

    // No double-deprecation on the next run.
    const second = consolidate({ at: "2026-11-06T00:00:00Z" });
    expect(second.ops).toHaveLength(0);
    expect(mustGet(record.item.id).item.status).toBe("deprecated");
  });

  test("an open validity window is never expired", () => {
    const record = memory.items.create(scope, itemContent({ valid_to: "2026-12-01T00:00:00Z" }));
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
    const report = consolidate({ at: "2026-11-05T00:00:00Z" });
    expect(report.ops).toHaveLength(0);
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

describe("Consolidation decays unused candidates", () => {
  test("an unused candidate past the decay window is deprecated", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, record.item.id, "candidate", 1);

    // The item is created "now"; pinning `at` 40 days out ages it past the
    // default 30-day window with no evidence or use inside the window.
    const at = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const report = consolidate({ at });
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "deprecate",
        item_id: record.item.id,
        reason_code: "unused_decay",
        applied: true,
      }),
    ]);
    expect(mustGet(record.item.id).item.status).toBe("deprecated");
  });

  test("recorded use inside the window keeps the candidate", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, record.item.id, "candidate", 1);

    const at = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const lastUsed = new Date(Date.now() + 38 * 24 * 60 * 60 * 1000).toISOString();
    const report = consolidate({
      at,
      usage: [{ item_id: record.item.id, use_count: 3, last_used_at: lastUsed }],
    });
    expect(report.ops).toHaveLength(0);
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });

  test("evidence inside the window keeps the candidate", () => {
    const record = memory.items.create(scope, itemContent());
    const evidence = memory.evidence.add(scope, record.item.id, {
      evidence_type: "test",
      reference: "t1",
    });
    memory.items.setStatus(scope, record.item.id, "candidate", 1);

    // The row is backdated forward to sit inside the decay window; repository
    // behavior stays real, only the passage of time is fabricated.
    const recent = new Date(Date.now() + 36 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE memory_evidence SET created_at = ? WHERE id = ?").run(recent, evidence.id);

    const at = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const report = consolidate({ at });
    expect(report.ops).toHaveLength(0);
    expect(mustGet(record.item.id).item.status).toBe("candidate");
  });

  test("a young candidate is never decayed and active items are never decayed", () => {
    const young = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, young.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, young.item.id, "candidate", 1);

    const active = memory.items.create(scope, itemContent({ statement: "active fact" }));
    memory.evidence.add(scope, active.item.id, { evidence_type: "test", reference: "t2" });
    memory.items.setStatus(scope, active.item.id, "candidate", 1);
    memory.items.setStatus(scope, active.item.id, "active", 1);

    const at = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const report = consolidate({ at });
    expect(report.ops).toHaveLength(0);
    expect(mustGet(young.item.id).item.status).toBe("candidate");
    expect(mustGet(active.item.id).item.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe("Consolidation detects stale facts through a verifier", () => {
  test("an affirmative stale verdict deprecates the active fact", () => {
    const stale = memory.items.create(scope, itemContent({ statement: "stale command" }));
    memory.evidence.add(scope, stale.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, stale.item.id, "candidate", 1);
    memory.items.setStatus(scope, stale.item.id, "active", 1);

    const fresh = memory.items.create(scope, itemContent({ statement: "fresh command" }));
    memory.evidence.add(scope, fresh.item.id, { evidence_type: "test", reference: "t2" });
    memory.items.setStatus(scope, fresh.item.id, "candidate", 1);
    memory.items.setStatus(scope, fresh.item.id, "active", 1);

    const probed: string[] = [];
    const verifier: FactVerifier = {
      verify: (record) => {
        probed.push(`${record.current.kind}:${record.item.id}`);
        return record.item.id === stale.item.id ? "stale" : "fresh";
      },
    };
    const report = consolidate({ verifier });
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "deprecate",
        item_id: stale.item.id,
        reason_code: "stale_fact",
        applied: true,
      }),
    ]);
    expect(mustGet(stale.item.id).item.status).toBe("deprecated");
    expect(mustGet(fresh.item.id).item.status).toBe("active");
    // Only active facts are probed.
    expect(probed).toEqual([`fact:${stale.item.id}`, `fact:${fresh.item.id}`]);
  });

  test("without a verifier nothing is reported stale", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, record.item.id, "candidate", 1);
    memory.items.setStatus(scope, record.item.id, "active", 1);

    const unknown: FactVerifier = { verify: () => "unknown" };
    expect(consolidate({ verifier: unknown }).ops).toHaveLength(0);
    expect(consolidate().ops).toHaveLength(0);
    expect(mustGet(record.item.id).item.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Proposals and the fixed vocabulary
// ---------------------------------------------------------------------------

describe("Consolidation decides proposals with fixed operations only", () => {
  test("a supersede proposal records succession", () => {
    const previous = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, previous.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, previous.item.id, "candidate", 1);
    memory.items.setStatus(scope, previous.item.id, "active", 1);
    const successor = memory.items.create(scope, itemContent({ statement: "newer fact" }));
    memory.evidence.add(scope, successor.item.id, { evidence_type: "test", reference: "t2" });

    const report = consolidate({
      proposals: [
        {
          op: "supersede",
          item_id: previous.item.id,
          successor_item_id: successor.item.id,
          reason_code: "retirement_proposal",
        },
      ],
    });
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "supersede",
        item_id: previous.item.id,
        target_item_id: successor.item.id,
        reason_code: "retirement_proposal",
        applied: true,
      }),
    ]);
    expect(mustGet(previous.item.id).item.status).toBe("deprecated");
    expect(mustGet(previous.item.id).current.valid_to).not.toBeNull();
  });

  test("deprecate and quarantine proposals apply at current state", () => {
    const gone = memory.items.create(scope, itemContent({ statement: "to deprecate" }));
    memory.evidence.add(scope, gone.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, gone.item.id, "candidate", 1);
    memory.items.setStatus(scope, gone.item.id, "active", 1);
    const suspect = memory.items.create(scope, itemContent({ statement: "to quarantine" }));
    memory.evidence.add(scope, suspect.item.id, { evidence_type: "test", reference: "t2" });

    const report = consolidate({
      proposals: [
        { op: "deprecate", item_id: gone.item.id, reason_code: "retirement_proposal" },
        { op: "quarantine", item_id: suspect.item.id, reason_code: "security_report" },
      ],
    });
    expect(report.ops.map((op) => op.op).sort()).toEqual(["deprecate", "quarantine"]);
    expect(mustGet(gone.item.id).item.status).toBe("deprecated");
    expect(mustGet(suspect.item.id).item.status).toBe("quarantined");
  });

  test("a supersede proposal never touches a quarantined item", () => {
    const quarantined = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, quarantined.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, quarantined.item.id, "candidate", 1);
    memory.items.setStatus(scope, quarantined.item.id, "quarantined", 1);
    const successor = memory.items.create(scope, itemContent({ statement: "newer fact" }));
    memory.evidence.add(scope, successor.item.id, { evidence_type: "test", reference: "t2" });
    const before = mustGet(quarantined.item.id);

    const report = consolidate({
      proposals: [
        {
          op: "supersede",
          item_id: quarantined.item.id,
          successor_item_id: successor.item.id,
          reason_code: "retirement_proposal",
        },
      ],
    });
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "supersede",
        item_id: quarantined.item.id,
        reason_code: "status_not_applicable",
        applied: false,
      }),
    ]);
    const after = mustGet(quarantined.item.id);
    expect(after.item.status).toBe("quarantined");
    // No validity window was closed and no succession link was written:
    // security response is not consolidation's to modify.
    expect(after.current.valid_to).toBe(before.current.valid_to);
    expect(
      memory.links
        .listByItem(scope, quarantined.item.id)
        .filter((link) => link.link_type === "supersedes"),
    ).toHaveLength(0);
  });

  test("a skipped proposal is recorded with its reason, never silently dropped", () => {
    const retired = memory.items.create(scope, itemContent({ statement: "already retired" }));
    memory.evidence.add(scope, retired.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, retired.item.id, "deprecated", 1);
    memory.items.setStatus(scope, retired.item.id, "retired", 1);

    const report = consolidate({
      proposals: [
        { op: "deprecate", item_id: retired.item.id, reason_code: "retirement_proposal" },
        { op: "quarantine", item_id: "mem_never_existed", reason_code: "security_report" },
      ],
    });
    expect(report.ops).toEqual([
      expect.objectContaining({
        op: "deprecate",
        item_id: retired.item.id,
        reason_code: "status_not_applicable",
        applied: false,
      }),
      expect.objectContaining({
        op: "quarantine",
        item_id: "mem_never_existed",
        reason_code: "item_missing",
        applied: false,
      }),
    ]);
    expect(mustGet(retired.item.id).item.status).toBe("retired");
  });

  test("a supersede proposal without a successor is rejected", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    expect(() =>
      consolidate({
        proposals: [
          { op: "supersede", item_id: record.item.id, reason_code: "retirement_proposal" },
        ],
      }),
    ).toThrow(ValidationError);
  });

  test("the operation vocabulary is closed at the persistence boundary", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    expect(() =>
      lifecycle.recordConsolidationOp(
        scope,
        "run_x",
        {
          op: "rewrite" as ConsolidationOpRecord["op"],
          item_id: record.item.id,
          target_item_id: null,
          item_version: 1,
          reason_code: "duplicate_content",
          applied: true,
          detail: {},
        },
        "2026-11-05T00:00:00.000Z",
      ),
    ).toThrow(ValidationError);
    expect(() =>
      lifecycle.recordConsolidationOp(
        scope,
        "run_x",
        {
          op: "merge",
          item_id: record.item.id,
          target_item_id: null,
          item_version: 1,
          reason_code: "made_up" as ConsolidationOpRecord["reason_code"],
          applied: true,
          detail: {},
        },
        "2026-11-05T00:00:00.000Z",
      ),
    ).toThrow(ValidationError);
  });

  test("every report entry uses the fixed vocabulary and reason codes", () => {
    const a = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, a.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, a.item.id, "candidate", 1);
    const b = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, b.item.id, { evidence_type: "test", reference: "t2" });
    const expired = memory.items.create(
      scope,
      itemContent({ statement: "expired fact", valid_to: "2026-11-02T00:00:00Z" }),
    );
    memory.evidence.add(scope, expired.item.id, { evidence_type: "test", reference: "t3" });

    const report = consolidate({ at: "2026-11-05T00:00:00Z" });
    expect(report.ops.length).toBeGreaterThanOrEqual(2);
    for (const op of report.ops) {
      expect(CONSOLIDATION_OPS).toContain(op.op);
      expect(CONSOLIDATION_OP_REASONS).toContain(op.reason_code);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounds and the audit report
// ---------------------------------------------------------------------------

describe("Consolidation is bounded and auditable", () => {
  test("the op budget stops the run and is recorded", () => {
    const a = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, a.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, a.item.id, "candidate", 1);
    const b = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, b.item.id, { evidence_type: "test", reference: "t2" });
    const c = memory.items.create(scope, itemContent({ source_run_id: "run_3" }));
    memory.evidence.add(scope, c.item.id, { evidence_type: "test", reference: "t3" });

    const report = consolidate({ max_ops: 1 });
    expect(report.ops).toHaveLength(1);
    expect(report.ops_applied).toBe(1);
    expect(report.budget_exhausted).toBe(true);
  });

  test("the scan budget bounds what one run inspects", () => {
    memory.items.create(scope, itemContent());
    memory.items.create(scope, itemContent({ statement: "second" }));
    memory.items.create(scope, itemContent({ statement: "third" }));
    const report = consolidate({ max_items_scanned: 1 });
    expect(report.items_scanned).toBe(1);
  });

  test("invalid bounds are rejected", () => {
    expect(() => consolidate({ max_ops: 0 })).toThrow(ValidationError);
    expect(() => consolidate({ max_items_scanned: -1 })).toThrow(ValidationError);
    expect(() => consolidate({ decay_unused_days: 1.5 })).toThrow(ValidationError);
    expect(() => consolidate({ at: "yesterday" })).toThrow(ValidationError);
  });

  test("the run and its operations are persisted for audit", () => {
    const a = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, a.item.id, { evidence_type: "test", reference: "t1" });
    memory.items.setStatus(scope, a.item.id, "candidate", 1);
    const b = memory.items.create(scope, itemContent({ source_run_id: "run_2" }));
    memory.evidence.add(scope, b.item.id, { evidence_type: "test", reference: "t2" });

    const report = consolidate();
    const runs = lifecycle.listConsolidationRuns(scope);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      run_id: report.run_id,
      status: "completed",
      items_scanned: 2,
      ops_applied: 1,
      ops_skipped: 0,
      budget_exhausted: false,
    });
    const ops = lifecycle.listConsolidationOps(scope, report.run_id);
    expect(ops).toEqual(report.ops);
  });

  test("a failing run is recorded as failed, not as silent success", () => {
    const record = memory.items.create(scope, itemContent());
    memory.evidence.add(scope, record.item.id, { evidence_type: "test", reference: "t1" });
    expect(() =>
      consolidate({
        proposals: [
          { op: "supersede", item_id: record.item.id, reason_code: "retirement_proposal" },
        ],
      }),
    ).toThrow(ValidationError);
    const runs = lifecycle.listConsolidationRuns(scope);
    expect(runs[0]?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe("scheduleMemoryConsolidation", () => {
  test("invokes the job on each tick and isolates failures", () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const errors: unknown[] = [];
      let fail = true;
      const handle = scheduleMemoryConsolidation({
        intervalMs: 1000,
        run: () => {
          calls.push(1);
          if (fail) {
            fail = false;
            throw new Error("boom");
          }
        },
        onError: (error) => errors.push(error),
      });
      vi.advanceTimersByTime(3000);
      handle.stop();
      vi.advanceTimersByTime(5000);
      expect(calls).toHaveLength(3);
      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a non-positive interval", () => {
    expect(() => scheduleMemoryConsolidation({ intervalMs: 0, run: () => undefined })).toThrow(
      ValidationError,
    );
    expect(() => scheduleMemoryConsolidation({ intervalMs: 1.5, run: () => undefined })).toThrow(
      ValidationError,
    );
  });
});
