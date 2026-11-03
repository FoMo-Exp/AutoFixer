/**
 * Scoped workspace-memory repositories (DAT-232).
 *
 * Every method takes an explicit {@link WorkspaceScope} derived from
 * authenticated membership — never from a client-supplied identifier — and the
 * SQL embeds the scope filter, so a record outside the caller's workspace is
 * indistinguishable from a missing one. There is deliberately no unscoped read
 * surface: enterprise templates and external retrieval cannot bypass these
 * repositories, because no other path to the memory tables exists.
 *
 * Versions are immutable except for `valid_to`, which is set at most once when
 * a successor version or a supersession closes the validity window. Every
 * mutation is recorded in the append-only `memory_events` audit trail, and
 * embeddings live and die with their source item.
 */

import type { ControlPlaneDb } from "../control-plane/db.js";
import { newId, nowIso } from "../control-plane/db.js";
import {
  ConflictError,
  NotFoundError,
  ScopeError,
  ValidationError,
  VersionConflictError,
} from "../control-plane/errors.js";
import type { UserId, WorkspaceScope } from "../control-plane/types.js";
import { isTimestamp } from "../trace/schema.js";
import { memoryContentHash } from "./hash.js";
import type {
  AddMemoryEvidenceInput,
  AddMemoryVersionInput,
  CreateMemoryItemInput,
  CreateMemoryLinkInput,
  MemoryApplicability,
  MemoryEmbedding,
  MemoryEvent,
  MemoryEventFilter,
  MemoryEvidence,
  MemoryEvidenceType,
  MemoryExport,
  MemoryExportItem,
  MemoryItem,
  MemoryItemId,
  MemoryItemRecord,
  MemoryItemVersion,
  MemoryKind,
  MemoryLink,
  MemoryLinkType,
  MemoryListFilter,
  MemoryProvenance,
  MemoryReview,
  MemorySensitivity,
  MemorySearchFilter,
  MemoryStatus,
  MemoryTombstone,
  MemoryTrust,
  PutMemoryEmbeddingInput,
} from "./types.js";
import { MEMORY_SCHEMA_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface MemoryItemRepository {
  /** Create a new item in `proposed` state together with its version 1. */
  create(scope: WorkspaceScope, input: CreateMemoryItemInput): MemoryItemRecord;
  /**
   * Append an immutable content version. `expectedVersion` is the current
   * content version the caller read (optimistic concurrency). A write whose
   * content hash matches an existing version is an idempotent no-op.
   */
  addVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    input: AddMemoryVersionInput,
    expectedVersion: number,
  ): { version: MemoryItemVersion; created: boolean };
  getById(scope: WorkspaceScope, itemId: MemoryItemId): MemoryItemRecord | undefined;
  list(scope: WorkspaceScope, filter?: MemoryListFilter): MemoryItemRecord[];
  /** Bounded substring search over current-version statements. */
  search(scope: WorkspaceScope, filter?: MemorySearchFilter): MemoryItemRecord[];
  getVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    version: number,
  ): MemoryItemVersion | undefined;
  /** All versions in order; empty for a missing item or foreign scope. */
  listVersions(scope: WorkspaceScope, itemId: MemoryItemId): MemoryItemVersion[];
  /** The version whose validity window contains `at` — rebuilds historical runs. */
  getEffectiveVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    at: string,
  ): MemoryItemVersion | undefined;
  /** Versions written from a given run, for run-level memory reconstruction. */
  listVersionsBySourceRun(
    scope: WorkspaceScope,
    runId: string,
    limit?: number,
  ): MemoryItemVersion[];
  /**
   * Lifecycle transition guarded by the ADR-0009 state machine and the exact
   * content version the actor reviewed. Reaching `active` requires evidence.
   */
  setStatus(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    status: MemoryStatus,
    expectedVersion: number,
  ): MemoryItem;
  /** Set-once approval stamp on one exact version. */
  reviewVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    version: number,
    approverId: UserId,
  ): MemoryItemVersion;
  /**
   * Record that `successorItemId` supersedes `previousItemId`: create the
   * supersedes link, close the previous item's open validity window, and
   * deprecate it unless it is quarantined or retired.
   */
  supersede(
    scope: WorkspaceScope,
    previousItemId: MemoryItemId,
    successorItemId: MemoryItemId,
    reason: string,
  ): MemoryLink;
  /** Bounded workspace export: items, versions, evidence, and links. */
  exportWorkspace(scope: WorkspaceScope, limit?: number): MemoryExport;
  /** Purge one item and its versions, evidence, links, and embeddings. */
  deleteItem(scope: WorkspaceScope, itemId: MemoryItemId): void;
}

export interface MemoryEvidenceRepository {
  add(scope: WorkspaceScope, itemId: MemoryItemId, input: AddMemoryEvidenceInput): MemoryEvidence;
  listByItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryEvidence[];
}

export interface MemoryLinkRepository {
  /** Create a link between two items of the same workspace. */
  create(scope: WorkspaceScope, input: CreateMemoryLinkInput): MemoryLink;
  /** Links in which the item participates, from either endpoint. */
  listByItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryLink[];
}

export interface MemoryEmbeddingRepository {
  /** Write or replace the derived embedding of one exact source version. */
  put(scope: WorkspaceScope, input: PutMemoryEmbeddingInput): MemoryEmbedding;
  listByItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryEmbedding[];
}

export interface MemoryAuditRepository {
  list(scope: WorkspaceScope, filter?: MemoryEventFilter): MemoryEvent[];
}

export interface MemoryTombstoneRepository {
  list(scope: WorkspaceScope, limit?: number): MemoryTombstone[];
}

export interface MemoryRepositories {
  items: MemoryItemRepository;
  evidence: MemoryEvidenceRepository;
  links: MemoryLinkRepository;
  embeddings: MemoryEmbeddingRepository;
  audit: MemoryAuditRepository;
  tombstones: MemoryTombstoneRepository;
  /**
   * Purge every memory row of the workspace and keep one minimal tombstone per
   * purged item plus the audit event. Idempotent in content: a second call
   * purges nothing but is still audited.
   */
  eraseWorkspace(scope: WorkspaceScope): { items_purged: number; tombstones_written: number };
}

// ---------------------------------------------------------------------------
// Scope helper
// ---------------------------------------------------------------------------

/**
 * Fail closed unless the scope carries both a non-empty enterprise and
 * workspace. Every repository entry point runs this before touching SQL, so a
 * missing or malformed scope can never widen a query.
 */
function requireWorkspaceScope(scope: WorkspaceScope): WorkspaceScope {
  const missing: string[] = [];
  if (typeof scope.enterprise_id !== "string" || scope.enterprise_id.length === 0) {
    missing.push("enterprise_id");
  }
  if (typeof scope.workspace_id !== "string" || scope.workspace_id.length === 0) {
    missing.push("workspace_id");
  }
  if (typeof scope.actor_id !== "string" || scope.actor_id.length === 0) {
    missing.push("actor_id");
  }
  if (missing.length > 0) {
    throw new ScopeError(`memory scope must carry ${missing.join(", ")}`);
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Row types and mappers
// ---------------------------------------------------------------------------

interface MemoryItemRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  status: string;
  current_version: number;
  support_count: number;
  contradiction_count: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

function toMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    status: row.status as MemoryStatus,
    current_version: row.current_version,
    support_count: row.support_count,
    contradiction_count: row.contradiction_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

interface MemoryItemVersionRow {
  item_id: string;
  version: number;
  enterprise_id: string;
  workspace_id: string;
  kind: string;
  scope: string;
  statement: string;
  preconditions: string;
  provenance: string;
  trust: string;
  sensitivity: string;
  valid_from: string;
  valid_to: string | null;
  content_hash: string;
  source_run_id: string | null;
  review: string | null;
  created_at: string;
  created_by: string;
}

function toMemoryItemVersion(row: MemoryItemVersionRow): MemoryItemVersion {
  return {
    item_id: row.item_id,
    version: row.version,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    kind: row.kind as MemoryKind,
    scope: JSON.parse(row.scope) as MemoryApplicability,
    statement: row.statement,
    preconditions: JSON.parse(row.preconditions) as string[],
    provenance: JSON.parse(row.provenance) as MemoryProvenance,
    trust: row.trust as MemoryTrust,
    sensitivity: row.sensitivity as MemorySensitivity,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    content_hash: row.content_hash,
    source_run_id: row.source_run_id,
    review: row.review === null ? null : (JSON.parse(row.review) as MemoryReview),
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

interface MemoryEvidenceRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string;
  evidence_type: string;
  reference: string;
  note: string | null;
  created_at: string;
  created_by: string;
}

function toMemoryEvidence(row: MemoryEvidenceRow): MemoryEvidence {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    evidence_type: row.evidence_type as MemoryEvidenceType,
    reference: row.reference,
    note: row.note,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

interface MemoryLinkRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string;
  target_item_id: string;
  link_type: string;
  reason: string | null;
  created_at: string;
  created_by: string;
}

function toMemoryLink(row: MemoryLinkRow): MemoryLink {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    target_item_id: row.target_item_id,
    link_type: row.link_type as MemoryLinkType,
    reason: row.reason,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

interface MemoryEmbeddingRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string;
  item_version: number;
  model: string;
  dimensions: number;
  vector: string;
  created_at: string;
  created_by: string;
}

function toMemoryEmbedding(row: MemoryEmbeddingRow): MemoryEmbedding {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    item_version: row.item_version,
    model: row.model,
    dimensions: row.dimensions,
    vector: row.vector,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

interface MemoryEventRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string | null;
  item_version: number | null;
  event_type: string;
  actor_id: string;
  run_id: string | null;
  detail: string;
  created_at: string;
}

function toMemoryEvent(row: MemoryEventRow): MemoryEvent {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    item_version: row.item_version,
    event_type: row.event_type as MemoryEvent["event_type"],
    actor_id: row.actor_id,
    run_id: row.run_id,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

interface MemoryTombstoneRow {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  item_id: string;
  reason: string;
  purged_at: string;
  purged_by: string;
}

function toMemoryTombstone(row: MemoryTombstoneRow): MemoryTombstone {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    reason: row.reason as MemoryTombstone["reason"],
    purged_at: row.purged_at,
    purged_by: row.purged_by,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireRow<T>(entity: string, id: string, row: T | undefined | null): T {
  if (row === undefined || row === null) {
    throw new NotFoundError(entity, id);
  }
  return row;
}

/** Bounded limit: positive, capped, and defaulted so no read is unbounded. */
function boundedLimit(limit: number | undefined, fallback = 100): number {
  const resolved = limit ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(resolved, 1000);
}

const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "lesson",
  "playbook",
  "anti_pattern",
  "episode",
  "policy",
];
const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "proposed",
  "candidate",
  "active",
  "deprecated",
  "retired",
  "quarantined",
];
const MEMORY_TRUSTS: readonly MemoryTrust[] = ["human", "agent", "enterprise_template", "system"];
const MEMORY_SENSITIVITIES: readonly MemorySensitivity[] = [
  "internal",
  "confidential",
  "restricted",
];
const MEMORY_LINK_TYPES: readonly MemoryLinkType[] = [
  "supersedes",
  "contradicts",
  "related",
  "derived_from",
];
const MEMORY_EVIDENCE_TYPES: readonly MemoryEvidenceType[] = [
  "run",
  "issue",
  "pr",
  "commit",
  "test",
  "reviewer_decision",
  "incident",
];

/**
 * ADR-0009 lifecycle state machine. `retired` is terminal; `quarantined` is
 * reachable from every non-terminal state; restore moves a quarantined item
 * back to `candidate`.
 */
const STATUS_TRANSITIONS: Readonly<Record<MemoryStatus, readonly MemoryStatus[]>> = {
  proposed: ["candidate", "deprecated", "quarantined"],
  candidate: ["active", "deprecated", "quarantined"],
  active: ["deprecated", "quarantined"],
  deprecated: ["active", "retired", "quarantined"],
  quarantined: ["candidate", "retired"],
  retired: [],
};

/** Validate a version's content fields; throws ValidationError on any violation. */
function validateVersionContent(content: {
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  provenance: MemoryProvenance;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  valid_from: string;
  valid_to: string | null;
}): void {
  if (!MEMORY_KINDS.includes(content.kind)) {
    throw new ValidationError(`unsupported memory kind: ${String(content.kind)}`);
  }
  if (!MEMORY_TRUSTS.includes(content.trust)) {
    throw new ValidationError(`unsupported memory trust class: ${String(content.trust)}`);
  }
  if (!MEMORY_SENSITIVITIES.includes(content.sensitivity)) {
    throw new ValidationError(`unsupported memory sensitivity: ${String(content.sensitivity)}`);
  }
  if (typeof content.statement !== "string" || content.statement.trim().length === 0) {
    throw new ValidationError("memory statement must be a non-empty string");
  }
  if (!Array.isArray(content.preconditions)) {
    throw new ValidationError("memory preconditions must be an array of strings");
  }
  for (const entry of content.preconditions) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ValidationError("memory preconditions must be non-empty strings");
    }
  }
  const applicability = content.scope;
  if (applicability === null || typeof applicability !== "object" || Array.isArray(applicability)) {
    throw new ValidationError("memory scope must be an applicability object");
  }
  for (const value of Object.values(applicability)) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new ValidationError("memory scope fields must be non-empty strings");
    }
  }
  const authorType = content.provenance?.author_type;
  if (authorType !== "human" && authorType !== "agent" && authorType !== "system") {
    throw new ValidationError(`unsupported provenance author_type: ${String(authorType)}`);
  }
  if (!isTimestamp(content.valid_from)) {
    throw new ValidationError("memory valid_from must be an RFC 3339 timestamp");
  }
  if (content.valid_to !== null && !isTimestamp(content.valid_to)) {
    throw new ValidationError("memory valid_to must be an RFC 3339 timestamp or null");
  }
  if (content.valid_to !== null && content.valid_to <= content.valid_from) {
    throw new ValidationError("memory valid_to must be later than valid_from");
  }
}

/**
 * Validity windows inside one item never overlap, so "which version was
 * effective at time T" always has exactly one answer.
 */
function assertWindowFitsPrevious(
  previous: { valid_from: string; valid_to: string | null },
  next: { valid_from: string },
): void {
  if (next.valid_from < previous.valid_from) {
    throw new ValidationError(
      `memory valid_from ${next.valid_from} precedes the previous version's window`,
    );
  }
  if (previous.valid_to !== null && next.valid_from < previous.valid_to) {
    throw new ValidationError(
      `memory valid_from ${next.valid_from} overlaps the previous version's window ending ${previous.valid_to}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Repository implementations
// ---------------------------------------------------------------------------

interface MemoryEventInput {
  scope: WorkspaceScope;
  item_id: MemoryItemId | null;
  item_version: number | null;
  event_type: MemoryEvent["event_type"];
  run_id: string | null;
  detail: Record<string, unknown>;
}

class SqliteMemoryStore implements MemoryRepositories {
  readonly items: MemoryItemRepository;
  readonly evidence: MemoryEvidenceRepository;
  readonly links: MemoryLinkRepository;
  readonly embeddings: MemoryEmbeddingRepository;
  readonly audit: MemoryAuditRepository;
  readonly tombstones: MemoryTombstoneRepository;
  private txDepth = 0;

  constructor(private readonly db: ControlPlaneDb) {
    this.items = new SqliteMemoryItemRepository(db, this);
    this.evidence = new SqliteMemoryEvidenceRepository(db, this);
    this.links = new SqliteMemoryLinkRepository(db, this);
    this.embeddings = new SqliteMemoryEmbeddingRepository(db, this);
    this.audit = new SqliteMemoryAuditRepository(db);
    this.tombstones = new SqliteMemoryTombstoneRepository(db);
  }

  /**
   * Run `fn` inside one SQLite transaction. Reentrant: composite operations
   * (supersession calls link creation and status transition) join the outer
   * transaction instead of nesting BEGINs.
   */
  runAtomically<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      return fn();
    }
    this.txDepth += 1;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** Append one audit event; every mutation in this module funnels through here. */
  recordEvent(input: MemoryEventInput): void {
    const id = newId("mea");
    this.db
      .prepare(
        `INSERT INTO memory_events
           (id, enterprise_id, workspace_id, item_id, item_version, event_type, actor_id, run_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope.enterprise_id,
        input.scope.workspace_id,
        input.item_id,
        input.item_version,
        input.event_type,
        input.scope.actor_id,
        input.run_id,
        JSON.stringify(input.detail),
        nowIso(),
      );
  }

  eraseWorkspace(scope: WorkspaceScope): { items_purged: number; tombstones_written: number } {
    requireWorkspaceScope(scope);
    return this.runAtomically(() => {
      const ids = (
        this.db
          .prepare("SELECT id FROM memory_items WHERE enterprise_id = ? AND workspace_id = ?")
          .all(scope.enterprise_id, scope.workspace_id) as unknown as { id: string }[]
      ).map((row) => row.id);
      if (ids.length > 0) {
        this.db
          .prepare("DELETE FROM memory_items WHERE enterprise_id = ? AND workspace_id = ?")
          .run(scope.enterprise_id, scope.workspace_id);
      }
      const insertTombstone = this.db.prepare(
        `INSERT INTO memory_tombstones
           (id, enterprise_id, workspace_id, item_id, reason, purged_at, purged_by)
         VALUES (?, ?, ?, ?, 'workspace_erased', ?, ?)`,
      );
      const now = nowIso();
      for (const itemId of ids) {
        insertTombstone.run(
          newId("mtb"),
          scope.enterprise_id,
          scope.workspace_id,
          itemId,
          now,
          scope.actor_id,
        );
      }
      this.recordEvent({
        scope,
        item_id: null,
        item_version: null,
        event_type: "workspace_erased",
        run_id: null,
        detail: { items_purged: ids.length },
      });
      return { items_purged: ids.length, tombstones_written: ids.length };
    });
  }
}

class SqliteMemoryItemRepository implements MemoryItemRepository {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly store: SqliteMemoryStore,
  ) {}

  create(scope: WorkspaceScope, input: CreateMemoryItemInput): MemoryItemRecord {
    requireWorkspaceScope(scope);
    const preconditions = input.preconditions ?? [];
    const sensitivity = input.sensitivity ?? "internal";
    const valid_from = input.valid_from ?? nowIso();
    const valid_to = input.valid_to ?? null;
    validateVersionContent({
      kind: input.kind,
      scope: input.scope,
      statement: input.statement,
      preconditions,
      provenance: input.provenance,
      trust: input.trust,
      sensitivity,
      valid_from,
      valid_to,
    });
    const content_hash = memoryContentHash({
      kind: input.kind,
      scope: input.scope,
      statement: input.statement,
      preconditions,
      sensitivity,
    });
    return this.store.runAtomically(() => {
      const itemId = newId("mem");
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO memory_items
             (id, enterprise_id, workspace_id, status, current_version, support_count, contradiction_count,
              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, 'proposed', 1, 0, 0, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
          scope.enterprise_id,
          scope.workspace_id,
          now,
          now,
          scope.actor_id,
          scope.actor_id,
        );
      this.db
        .prepare(
          `INSERT INTO memory_item_versions
             (item_id, version, enterprise_id, workspace_id, kind, scope, statement, preconditions,
              provenance, trust, sensitivity, valid_from, valid_to, content_hash, source_run_id,
              review, created_at, created_by)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          itemId,
          scope.enterprise_id,
          scope.workspace_id,
          input.kind,
          JSON.stringify(input.scope),
          input.statement,
          JSON.stringify(preconditions),
          JSON.stringify(input.provenance),
          input.trust,
          sensitivity,
          valid_from,
          valid_to,
          content_hash,
          input.source_run_id ?? null,
          now,
          scope.actor_id,
        );
      this.store.recordEvent({
        scope,
        item_id: itemId,
        item_version: 1,
        event_type: "item_created",
        run_id: input.source_run_id ?? null,
        detail: { content_hash, kind: input.kind },
      });
      return requireRow("MemoryItem", itemId, this.getRecord(scope, itemId));
    });
  }

  addVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    input: AddMemoryVersionInput,
    expectedVersion: number,
  ): { version: MemoryItemVersion; created: boolean } {
    requireWorkspaceScope(scope);
    const preconditions = input.preconditions ?? [];
    const sensitivity = input.sensitivity ?? "internal";
    const valid_from = input.valid_from ?? nowIso();
    const valid_to = input.valid_to ?? null;
    validateVersionContent({
      kind: input.kind,
      scope: input.scope,
      statement: input.statement,
      preconditions,
      provenance: input.provenance,
      trust: input.trust,
      sensitivity,
      valid_from,
      valid_to,
    });
    return this.store.runAtomically(() => {
      const record = requireRow("MemoryItem", itemId, this.getRecord(scope, itemId));
      if (record.item.current_version !== expectedVersion) {
        throw new VersionConflictError(
          "MemoryItem",
          itemId,
          expectedVersion,
          record.item.current_version,
        );
      }
      assertWindowFitsPrevious(record.current, { valid_from });
      const content_hash = memoryContentHash({
        kind: input.kind,
        scope: input.scope,
        statement: input.statement,
        preconditions,
        sensitivity,
      });
      // Writes are idempotent by content hash: an identical write returns the
      // already-stored version and changes nothing.
      const existing = this.db
        .prepare(
          `SELECT v.* FROM memory_item_versions v
             JOIN memory_items i ON i.id = v.item_id
           WHERE i.enterprise_id = ? AND i.workspace_id = ? AND v.item_id = ? AND v.content_hash = ?`,
        )
        .get(scope.enterprise_id, scope.workspace_id, itemId, content_hash) as
        MemoryItemVersionRow | undefined;
      if (existing) {
        return { version: toMemoryItemVersion(existing), created: false };
      }
      const nextVersion = record.item.current_version + 1;
      const now = nowIso();
      // Close the previous version's open window exactly once.
      this.db
        .prepare(
          "UPDATE memory_item_versions SET valid_to = ? WHERE item_id = ? AND version = ? AND valid_to IS NULL",
        )
        .run(valid_from, itemId, record.item.current_version);
      this.db
        .prepare(
          `INSERT INTO memory_item_versions
             (item_id, version, enterprise_id, workspace_id, kind, scope, statement, preconditions,
              provenance, trust, sensitivity, valid_from, valid_to, content_hash, source_run_id,
              review, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          itemId,
          nextVersion,
          scope.enterprise_id,
          scope.workspace_id,
          input.kind,
          JSON.stringify(input.scope),
          input.statement,
          JSON.stringify(preconditions),
          JSON.stringify(input.provenance),
          input.trust,
          sensitivity,
          valid_from,
          valid_to,
          content_hash,
          input.source_run_id ?? null,
          now,
          scope.actor_id,
        );
      const moved = this.db
        .prepare(
          `UPDATE memory_items SET current_version = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND enterprise_id = ? AND workspace_id = ? AND current_version = ?`,
        )
        .run(
          nextVersion,
          now,
          scope.actor_id,
          itemId,
          scope.enterprise_id,
          scope.workspace_id,
          expectedVersion,
        ) as unknown as { changes: number };
      if (moved.changes === 0) {
        throw new VersionConflictError("MemoryItem", itemId, expectedVersion, nextVersion - 1);
      }
      this.store.recordEvent({
        scope,
        item_id: itemId,
        item_version: nextVersion,
        event_type: "version_created",
        run_id: input.source_run_id ?? null,
        detail: { content_hash, kind: input.kind },
      });
      return {
        version: requireRow(
          "MemoryItemVersion",
          `${itemId}#${nextVersion}`,
          this.getVersion(scope, itemId, nextVersion),
        ),
        created: true,
      };
    });
  }

  getById(scope: WorkspaceScope, itemId: MemoryItemId): MemoryItemRecord | undefined {
    requireWorkspaceScope(scope);
    return this.getRecord(scope, itemId);
  }

  list(scope: WorkspaceScope, filter: MemoryListFilter = {}): MemoryItemRecord[] {
    requireWorkspaceScope(scope);
    return this.selectRecords(scope, filter, undefined);
  }

  search(scope: WorkspaceScope, filter: MemorySearchFilter = {}): MemoryItemRecord[] {
    requireWorkspaceScope(scope);
    return this.selectRecords(scope, filter, filter.query);
  }

  getVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    version: number,
  ): MemoryItemVersion | undefined {
    requireWorkspaceScope(scope);
    const row = this.db
      .prepare(
        `SELECT v.* FROM memory_item_versions v
           JOIN memory_items i ON i.id = v.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND v.item_id = ? AND v.version = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, itemId, version) as
      MemoryItemVersionRow | undefined;
    return row ? toMemoryItemVersion(row) : undefined;
  }

  listVersions(scope: WorkspaceScope, itemId: MemoryItemId): MemoryItemVersion[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT v.* FROM memory_item_versions v
           JOIN memory_items i ON i.id = v.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND v.item_id = ?
         ORDER BY v.version`,
      )
      .all(scope.enterprise_id, scope.workspace_id, itemId) as unknown as MemoryItemVersionRow[];
    return rows.map(toMemoryItemVersion);
  }

  getEffectiveVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    at: string,
  ): MemoryItemVersion | undefined {
    requireWorkspaceScope(scope);
    if (!isTimestamp(at)) {
      throw new ValidationError("getEffectiveVersion requires an RFC 3339 timestamp");
    }
    const row = this.db
      .prepare(
        `SELECT v.* FROM memory_item_versions v
           JOIN memory_items i ON i.id = v.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND v.item_id = ?
           AND v.valid_from <= ? AND (v.valid_to IS NULL OR v.valid_to > ?)
         ORDER BY v.version DESC LIMIT 1`,
      )
      .get(scope.enterprise_id, scope.workspace_id, itemId, at, at) as
      MemoryItemVersionRow | undefined;
    return row ? toMemoryItemVersion(row) : undefined;
  }

  listVersionsBySourceRun(
    scope: WorkspaceScope,
    runId: string,
    limit?: number,
  ): MemoryItemVersion[] {
    requireWorkspaceScope(scope);
    if (typeof runId !== "string" || runId.length === 0) {
      throw new ValidationError("runId must be a non-empty string");
    }
    const rows = this.db
      .prepare(
        `SELECT v.* FROM memory_item_versions v
           JOIN memory_items i ON i.id = v.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND v.source_run_id = ?
         ORDER BY v.created_at, v.version LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        runId,
        boundedLimit(limit),
      ) as unknown as MemoryItemVersionRow[];
    return rows.map(toMemoryItemVersion);
  }

  setStatus(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    status: MemoryStatus,
    expectedVersion: number,
  ): MemoryItem {
    requireWorkspaceScope(scope);
    if (!MEMORY_STATUSES.includes(status)) {
      throw new ValidationError(`unsupported memory status: ${String(status)}`);
    }
    return this.store.runAtomically(() => {
      const record = requireRow("MemoryItem", itemId, this.getRecord(scope, itemId));
      if (record.item.current_version !== expectedVersion) {
        throw new VersionConflictError(
          "MemoryItem",
          itemId,
          expectedVersion,
          record.item.current_version,
        );
      }
      const from = record.item.status;
      if (from === status) {
        throw new ConflictError(`MemoryItem ${itemId} is already ${status}`);
      }
      if (!STATUS_TRANSITIONS[from].includes(status)) {
        throw new ValidationError(`memory status transition ${from} -> ${status} is not allowed`);
      }
      if (status === "active" && this.countEvidence(scope, itemId) === 0) {
        throw new ValidationError("an active memory item requires at least one evidence reference");
      }
      const now = nowIso();
      const moved = this.db
        .prepare(
          `UPDATE memory_items SET status = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND enterprise_id = ? AND workspace_id = ? AND status = ? AND current_version = ?`,
        )
        .run(
          status,
          now,
          scope.actor_id,
          itemId,
          scope.enterprise_id,
          scope.workspace_id,
          from,
          expectedVersion,
        ) as unknown as { changes: number };
      if (moved.changes === 0) {
        throw new VersionConflictError("MemoryItem", itemId, expectedVersion, expectedVersion);
      }
      this.store.recordEvent({
        scope,
        item_id: itemId,
        item_version: expectedVersion,
        event_type: "status_changed",
        run_id: null,
        detail: { from, to: status },
      });
      return requireRow("MemoryItem", itemId, this.getRecord(scope, itemId)).item;
    });
  }

  reviewVersion(
    scope: WorkspaceScope,
    itemId: MemoryItemId,
    version: number,
    approverId: UserId,
  ): MemoryItemVersion {
    requireWorkspaceScope(scope);
    if (typeof approverId !== "string" || approverId.length === 0) {
      throw new ValidationError("approverId must be a non-empty string");
    }
    return this.store.runAtomically(() => {
      const current = requireRow(
        "MemoryItemVersion",
        `${itemId}#${version}`,
        this.getVersion(scope, itemId, version),
      );
      if (current.review !== null) {
        // Approval is set-once; a repeated review call is an idempotent no-op.
        return current;
      }
      const review: MemoryReview = { approver_id: approverId, approved_at: nowIso() };
      this.db
        .prepare(
          "UPDATE memory_item_versions SET review = ? WHERE item_id = ? AND version = ? AND review IS NULL",
        )
        .run(JSON.stringify(review), itemId, version);
      this.store.recordEvent({
        scope,
        item_id: itemId,
        item_version: version,
        event_type: "version_reviewed",
        run_id: null,
        detail: { approver_id: approverId },
      });
      return requireRow(
        "MemoryItemVersion",
        `${itemId}#${version}`,
        this.getVersion(scope, itemId, version),
      );
    });
  }

  supersede(
    scope: WorkspaceScope,
    previousItemId: MemoryItemId,
    successorItemId: MemoryItemId,
    reason: string,
  ): MemoryLink {
    requireWorkspaceScope(scope);
    if (previousItemId === successorItemId) {
      throw new ValidationError("a memory item cannot supersede itself");
    }
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new ValidationError("supersession requires a recorded reason");
    }
    return this.store.runAtomically(() => {
      const previous = requireRow(
        "MemoryItem",
        previousItemId,
        this.getRecord(scope, previousItemId),
      );
      requireRow("MemoryItem", successorItemId, this.getRecord(scope, successorItemId));
      const link = this.store.links.create(scope, {
        item_id: successorItemId,
        target_item_id: previousItemId,
        link_type: "supersedes",
        reason,
      });
      // Supersession, not destructive overwrite: close the previous item's
      // open validity window and record why it stopped being effective.
      this.db
        .prepare(
          "UPDATE memory_item_versions SET valid_to = ? WHERE item_id = ? AND version = ? AND valid_to IS NULL",
        )
        .run(nowIso(), previousItemId, previous.item.current_version);
      if (previous.item.status !== "quarantined" && previous.item.status !== "retired") {
        if (previous.item.status !== "deprecated") {
          this.setStatus(scope, previousItemId, "deprecated", previous.item.current_version);
        }
      }
      return link;
    });
  }

  exportWorkspace(scope: WorkspaceScope, limit?: number): MemoryExport {
    requireWorkspaceScope(scope);
    const bounded = boundedLimit(limit);
    const records = this.selectRecords(scope, { limit: bounded }, undefined);
    const items: MemoryExportItem[] = records.map((record) => ({
      item: record.item,
      versions: this.listVersions(scope, record.item.id),
      evidence: this.store.evidence.listByItem(scope, record.item.id),
      links: this.store.links.listByItem(scope, record.item.id),
    }));
    return {
      schema_version: MEMORY_SCHEMA_VERSION,
      exported_at: nowIso(),
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      items,
    };
  }

  deleteItem(scope: WorkspaceScope, itemId: MemoryItemId): void {
    requireWorkspaceScope(scope);
    this.store.runAtomically(() => {
      const record = requireRow("MemoryItem", itemId, this.getRecord(scope, itemId));
      this.db
        .prepare("DELETE FROM memory_items WHERE id = ? AND enterprise_id = ? AND workspace_id = ?")
        .run(itemId, scope.enterprise_id, scope.workspace_id);
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO memory_tombstones
             (id, enterprise_id, workspace_id, item_id, reason, purged_at, purged_by)
           VALUES (?, ?, ?, ?, 'item_deleted', ?, ?)`,
        )
        .run(newId("mtb"), scope.enterprise_id, scope.workspace_id, itemId, now, scope.actor_id);
      this.store.recordEvent({
        scope,
        item_id: itemId,
        item_version: record.item.current_version,
        event_type: "item_deleted",
        run_id: null,
        detail: { content_versions: record.item.current_version },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers (scope filters are embedded in every statement)
  // -------------------------------------------------------------------------

  private getRecord(scope: WorkspaceScope, itemId: MemoryItemId): MemoryItemRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_items WHERE id = ? AND enterprise_id = ? AND workspace_id = ?")
      .get(itemId, scope.enterprise_id, scope.workspace_id) as MemoryItemRow | undefined;
    if (!row) {
      return undefined;
    }
    const current = this.getVersion(scope, itemId, row.current_version);
    if (!current) {
      throw new NotFoundError("MemoryItemVersion", `${itemId}#${row.current_version}`);
    }
    return { item: toMemoryItem(row), current };
  }

  private selectRecords(
    scope: WorkspaceScope,
    filter: MemoryListFilter,
    query: string | undefined,
  ): MemoryItemRecord[] {
    const clauses = ["i.enterprise_id = ?", "i.workspace_id = ?"];
    const params: (string | number)[] = [scope.enterprise_id, scope.workspace_id];
    if (filter.status !== undefined) {
      clauses.push("i.status = ?");
      params.push(filter.status);
    }
    if (filter.kind !== undefined) {
      clauses.push("v.kind = ?");
      params.push(filter.kind);
    }
    if (query !== undefined && query.length > 0) {
      // LIKE with an escaped pattern: substring match only, never a pattern
      // injection surface.
      const escaped = query
        .toLowerCase()
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      clauses.push("LOWER(v.statement) LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    params.push(boundedLimit(filter.limit));
    const rows = this.db
      .prepare(
        `SELECT i.*, v.version AS v_version, v.kind AS v_kind, v.scope AS v_scope,
                v.statement AS v_statement, v.preconditions AS v_preconditions,
                v.provenance AS v_provenance, v.trust AS v_trust, v.sensitivity AS v_sensitivity,
                v.valid_from AS v_valid_from, v.valid_to AS v_valid_to,
                v.content_hash AS v_content_hash, v.source_run_id AS v_source_run_id,
                v.review AS v_review, v.created_at AS v_created_at, v.created_by AS v_created_by
           FROM memory_items i
           JOIN memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
          WHERE ${clauses.join(" AND ")}
          ORDER BY i.rowid
          LIMIT ?`,
      )
      .all(...params) as unknown as Record<string, unknown>[];
    return rows.map((row) => this.recordFromJoinedRow(row));
  }

  /** Rebuild a record from the aliased join produced by selectRecords. */
  private recordFromJoinedRow(row: Record<string, unknown>): MemoryItemRecord {
    const item = toMemoryItem(row as unknown as MemoryItemRow);
    const versionRow: MemoryItemVersionRow = {
      item_id: item.id,
      version: row["v_version"] as number,
      enterprise_id: row["enterprise_id"] as string,
      workspace_id: row["workspace_id"] as string,
      kind: row["v_kind"] as string,
      scope: row["v_scope"] as string,
      statement: row["v_statement"] as string,
      preconditions: row["v_preconditions"] as string,
      provenance: row["v_provenance"] as string,
      trust: row["v_trust"] as string,
      sensitivity: row["v_sensitivity"] as string,
      valid_from: row["v_valid_from"] as string,
      valid_to: row["v_valid_to"] as string | null,
      content_hash: row["v_content_hash"] as string,
      source_run_id: row["v_source_run_id"] as string | null,
      review: row["v_review"] as string | null,
      created_at: row["v_created_at"] as string,
      created_by: row["v_created_by"] as string,
    };
    return { item, current: toMemoryItemVersion(versionRow) };
  }

  private countEvidence(scope: WorkspaceScope, itemId: MemoryItemId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_evidence e
           JOIN memory_items i ON i.id = e.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND e.item_id = ?`,
      )
      .get(scope.enterprise_id, scope.workspace_id, itemId);
    if (row === null || typeof row !== "object" || !("n" in row)) {
      throw new ValidationError("unexpected COUNT row from memory_evidence");
    }
    return Number(row.n);
  }
}

class SqliteMemoryEvidenceRepository implements MemoryEvidenceRepository {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly store: SqliteMemoryStore,
  ) {}

  add(scope: WorkspaceScope, itemId: MemoryItemId, input: AddMemoryEvidenceInput): MemoryEvidence {
    requireWorkspaceScope(scope);
    if (!MEMORY_EVIDENCE_TYPES.includes(input.evidence_type)) {
      throw new ValidationError(`unsupported evidence type: ${String(input.evidence_type)}`);
    }
    if (typeof input.reference !== "string" || input.reference.trim().length === 0) {
      throw new ValidationError("evidence reference must be a non-empty string");
    }
    return this.store.runAtomically(() => {
      requireRow("MemoryItem", itemId, this.store.items.getById(scope, itemId));
      const id = newId("mev");
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO memory_evidence
             (id, enterprise_id, workspace_id, item_id, evidence_type, reference, note, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          scope.enterprise_id,
          scope.workspace_id,
          itemId,
          input.evidence_type,
          input.reference,
          input.note ?? null,
          now,
          scope.actor_id,
        );
      this.store.recordEvent({
        scope,
        item_id: itemId,
        item_version: null,
        event_type: "evidence_added",
        run_id: null,
        detail: { evidence_type: input.evidence_type },
      });
      return toMemoryEvidence(
        requireRow(
          "MemoryEvidence",
          id,
          this.db.prepare("SELECT * FROM memory_evidence WHERE id = ?").get(id) as
            MemoryEvidenceRow | undefined,
        ),
      );
    });
  }

  listByItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryEvidence[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_evidence e
           JOIN memory_items i ON i.id = e.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND e.item_id = ?
         ORDER BY e.rowid`,
      )
      .all(scope.enterprise_id, scope.workspace_id, itemId) as unknown as MemoryEvidenceRow[];
    return rows.map(toMemoryEvidence);
  }
}

class SqliteMemoryLinkRepository implements MemoryLinkRepository {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly store: SqliteMemoryStore,
  ) {}

  create(scope: WorkspaceScope, input: CreateMemoryLinkInput): MemoryLink {
    requireWorkspaceScope(scope);
    if (input.item_id === input.target_item_id) {
      throw new ValidationError("a memory item cannot link to itself");
    }
    if (!MEMORY_LINK_TYPES.includes(input.link_type)) {
      throw new ValidationError(`unsupported link type: ${String(input.link_type)}`);
    }
    if (
      (input.link_type === "supersedes" || input.link_type === "contradicts") &&
      (typeof input.reason !== "string" || input.reason.trim().length === 0)
    ) {
      throw new ValidationError(`${input.link_type} links require a recorded reason`);
    }
    return this.store.runAtomically(() => {
      requireRow("MemoryItem", input.item_id, this.store.items.getById(scope, input.item_id));
      requireRow(
        "MemoryItem",
        input.target_item_id,
        this.store.items.getById(scope, input.target_item_id),
      );
      const id = newId("mln");
      const now = nowIso();
      try {
        this.db
          .prepare(
            `INSERT INTO memory_links
               (id, enterprise_id, workspace_id, item_id, target_item_id, link_type, reason, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            scope.enterprise_id,
            scope.workspace_id,
            input.item_id,
            input.target_item_id,
            input.link_type,
            input.reason ?? null,
            now,
            scope.actor_id,
          );
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          throw new ConflictError(
            `link ${input.link_type} between ${input.item_id} and ${input.target_item_id} already exists`,
          );
        }
        throw error;
      }
      this.store.recordEvent({
        scope,
        item_id: input.item_id,
        item_version: null,
        event_type: "link_created",
        run_id: null,
        detail: {
          link_type: input.link_type,
          target_item_id: input.target_item_id,
          reason: input.reason ?? null,
        },
      });
      return toMemoryLink(
        requireRow(
          "MemoryLink",
          id,
          this.db.prepare("SELECT * FROM memory_links WHERE id = ?").get(id) as
            MemoryLinkRow | undefined,
        ),
      );
    });
  }

  listByItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryLink[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT l.* FROM memory_links l
           JOIN memory_items i ON i.id = l.item_id
           JOIN memory_items t ON t.id = l.target_item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ?
           AND t.enterprise_id = i.enterprise_id AND t.workspace_id = i.workspace_id
           AND (l.item_id = ? OR l.target_item_id = ?)
         ORDER BY l.rowid`,
      )
      .all(scope.enterprise_id, scope.workspace_id, itemId, itemId) as unknown as MemoryLinkRow[];
    return rows.map(toMemoryLink);
  }
}

class SqliteMemoryEmbeddingRepository implements MemoryEmbeddingRepository {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly store: SqliteMemoryStore,
  ) {}

  put(scope: WorkspaceScope, input: PutMemoryEmbeddingInput): MemoryEmbedding {
    requireWorkspaceScope(scope);
    if (typeof input.model !== "string" || input.model.length === 0) {
      throw new ValidationError("embedding model must be a non-empty string");
    }
    if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
      throw new ValidationError("embedding dimensions must be a positive integer");
    }
    if (typeof input.vector !== "string" || input.vector.length === 0) {
      throw new ValidationError("embedding vector must be a non-empty string");
    }
    return this.store.runAtomically(() => {
      // The embedding must reference an existing version inside the caller's
      // workspace; a foreign or unknown version is indistinguishable from a
      // missing one.
      requireRow(
        "MemoryItemVersion",
        `${input.item_id}#${input.item_version}`,
        this.store.items.getVersion(scope, input.item_id, input.item_version),
      );
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO memory_embeddings
             (id, enterprise_id, workspace_id, item_id, item_version, model, dimensions, vector, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (item_id, item_version, model) DO UPDATE SET
             dimensions = excluded.dimensions,
             vector = excluded.vector,
             created_at = excluded.created_at,
             created_by = excluded.created_by`,
        )
        .run(
          newId("mbe"),
          scope.enterprise_id,
          scope.workspace_id,
          input.item_id,
          input.item_version,
          input.model,
          input.dimensions,
          input.vector,
          now,
          scope.actor_id,
        );
      this.store.recordEvent({
        scope,
        item_id: input.item_id,
        item_version: input.item_version,
        event_type: "embedding_written",
        run_id: null,
        detail: { model: input.model, dimensions: input.dimensions },
      });
      const row = this.db
        .prepare(
          "SELECT * FROM memory_embeddings WHERE item_id = ? AND item_version = ? AND model = ?",
        )
        .get(input.item_id, input.item_version, input.model) as MemoryEmbeddingRow | undefined;
      return toMemoryEmbedding(requireRow("MemoryEmbedding", input.item_id, row));
    });
  }

  listByItem(scope: WorkspaceScope, itemId: MemoryItemId): MemoryEmbedding[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT e.* FROM memory_embeddings e
           JOIN memory_items i ON i.id = e.item_id
         WHERE i.enterprise_id = ? AND i.workspace_id = ? AND e.item_id = ?
         ORDER BY e.item_version, e.model`,
      )
      .all(scope.enterprise_id, scope.workspace_id, itemId) as unknown as MemoryEmbeddingRow[];
    return rows.map(toMemoryEmbedding);
  }
}

class SqliteMemoryAuditRepository implements MemoryAuditRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  list(scope: WorkspaceScope, filter: MemoryEventFilter = {}): MemoryEvent[] {
    requireWorkspaceScope(scope);
    const clauses = ["enterprise_id = ?", "workspace_id = ?"];
    const params: (string | number)[] = [scope.enterprise_id, scope.workspace_id];
    if (filter.item_id !== undefined) {
      clauses.push("item_id = ?");
      params.push(filter.item_id);
    }
    if (filter.run_id !== undefined) {
      clauses.push("run_id = ?");
      params.push(filter.run_id);
    }
    if (filter.event_type !== undefined) {
      clauses.push("event_type = ?");
      params.push(filter.event_type);
    }
    params.push(boundedLimit(filter.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_events WHERE ${clauses.join(" AND ")}
         ORDER BY rowid LIMIT ?`,
      )
      .all(...params) as unknown as MemoryEventRow[];
    return rows.map(toMemoryEvent);
  }
}

class SqliteMemoryTombstoneRepository implements MemoryTombstoneRepository {
  constructor(private readonly db: ControlPlaneDb) {}

  list(scope: WorkspaceScope, limit?: number): MemoryTombstone[] {
    requireWorkspaceScope(scope);
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_tombstones WHERE enterprise_id = ? AND workspace_id = ?
         ORDER BY rowid LIMIT ?`,
      )
      .all(
        scope.enterprise_id,
        scope.workspace_id,
        boundedLimit(limit),
      ) as unknown as MemoryTombstoneRow[];
    return rows.map(toMemoryTombstone);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryRepositories(db: ControlPlaneDb): MemoryRepositories {
  return new SqliteMemoryStore(db);
}
