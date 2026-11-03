/**
 * Workspace memory entity types (DAT-232).
 *
 * Memory items follow the ADR-0009 memory-item contract: every persisted
 * version is immutable and self-contained, so any historical run's memory can
 * be rebuilt exactly from the version table. Lifecycle state (status,
 * confidence counters) lives on the item row; content lives on the version
 * rows. Every row is enterprise- and workspace-scoped; a scope is derived from
 * authenticated membership, never from a client-supplied identifier.
 */

import type { EnterpriseId, UserId, WorkspaceId } from "../control-plane/types.js";

// ---------------------------------------------------------------------------
// Schema version (export envelopes and contract tests)
// ---------------------------------------------------------------------------

export const MEMORY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Branded ID aliases (documentation-level; runtime values are plain strings).
// ---------------------------------------------------------------------------

export type MemoryItemId = string;
export type MemoryEvidenceId = string;
export type MemoryLinkId = string;
export type MemoryEmbeddingId = string;
export type MemoryEventId = string;
export type MemoryTombstoneId = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Memory tier classification (ADR-0009 five tiers are L0/L1 short-term, L2-L4 long-term). */
export type MemoryKind = "fact" | "lesson" | "playbook" | "anti_pattern" | "episode" | "policy";

/** Lifecycle state machine; `retired` is terminal. */
export type MemoryStatus =
  "proposed" | "candidate" | "active" | "deprecated" | "retired" | "quarantined";

/** Trust class of the version's author. */
export type MemoryTrust = "human" | "agent" | "enterprise_template" | "system";

/** Data class constraining retrieval, export, and retention (ADR-0008). */
export type MemorySensitivity = "internal" | "confidential" | "restricted";

export type MemoryEvidenceType =
  "run" | "issue" | "pr" | "commit" | "test" | "reviewer_decision" | "incident";

export type MemoryLinkType = "supersedes" | "contradicts" | "related" | "derived_from";

export type MemoryEventType =
  | "item_created"
  | "version_created"
  | "version_reviewed"
  | "evidence_added"
  | "link_created"
  | "status_changed"
  | "embedding_written"
  | "item_deleted"
  | "workspace_erased";

export type MemoryTombstoneReason = "item_deleted" | "workspace_erased";

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/**
 * Applicability domain of a version: the team, path prefix, language, or task
 * family the memory applies to. Empty fields mean broad applicability.
 */
export interface MemoryApplicability {
  team_id?: string;
  path_prefix?: string;
  language?: string;
  task_family?: string;
}

/** Who authored the version and under which agent configuration. */
export interface MemoryProvenance {
  author_type: "human" | "agent" | "system";
  /** Model identifier when an agent wrote the version. */
  agent_model?: string;
  /** Digest of the agent configuration in effect. */
  config_digest?: string;
  /** Prompt-template version in effect. */
  prompt_template_version?: string;
}

/** Approval of one exact version; stored on that version only. */
export interface MemoryReview {
  approver_id: UserId;
  approved_at: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Stable identity plus lifecycle state. The content of a memory item is
 * whatever its versions say it is; the item row only tracks which version is
 * current and the mutable lifecycle counters.
 */
export interface MemoryItem {
  id: MemoryItemId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  status: MemoryStatus;
  /** Content version number of the latest version. */
  current_version: number;
  support_count: number;
  contradiction_count: number;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

/** Immutable content version. `valid_to` is null while the version is effective. */
export interface MemoryItemVersion {
  item_id: MemoryItemId;
  version: number;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  provenance: MemoryProvenance;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  valid_from: string;
  valid_to: string | null;
  /** Canonical content hash; identical writes are idempotent no-ops. */
  content_hash: string;
  /** Run correlation for rebuilding the memory a historical run consumed. */
  source_run_id: string | null;
  review: MemoryReview | null;
  created_at: string;
  created_by: UserId;
}

/** An item together with its current version. */
export interface MemoryItemRecord {
  item: MemoryItem;
  current: MemoryItemVersion;
}

export interface MemoryEvidence {
  id: MemoryEvidenceId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId;
  evidence_type: MemoryEvidenceType;
  /** Opaque pointer: run id, issue/PR/commit reference, test id, decision, or incident. */
  reference: string;
  note: string | null;
  created_at: string;
  created_by: UserId;
}

export interface MemoryLink {
  id: MemoryLinkId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId;
  target_item_id: MemoryItemId;
  link_type: MemoryLinkType;
  reason: string | null;
  created_at: string;
  created_by: UserId;
}

/** Derived sensitive data; deleted together with its source item. */
export interface MemoryEmbedding {
  id: MemoryEmbeddingId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId;
  item_version: number;
  model: string;
  dimensions: number;
  vector: string;
  created_at: string;
  created_by: UserId;
}

/** Append-only audit record. Survives item deletion and workspace erasure. */
export interface MemoryEvent {
  id: MemoryEventId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId | null;
  item_version: number | null;
  event_type: MemoryEventType;
  actor_id: UserId;
  run_id: string | null;
  /** Non-sensitive metadata only: opaque IDs, fixed enums, counts. Never memory content or free-text reasons. */
  detail: Record<string, unknown>;
  created_at: string;
}

/** Minimal non-sensitive remnant kept after a purge. */
export interface MemoryTombstone {
  id: MemoryTombstoneId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId;
  reason: MemoryTombstoneReason;
  purged_at: string;
  purged_by: UserId;
}

// ---------------------------------------------------------------------------
// Create / update inputs
// ---------------------------------------------------------------------------

export interface CreateMemoryVersionContent {
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  provenance: MemoryProvenance;
  trust: MemoryTrust;
  sensitivity: MemorySensitivity;
  valid_from: string;
  valid_to: string | null;
}

export interface CreateMemoryItemInput {
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  /** Empty means broad applicability and lowers the default trust weight. */
  preconditions?: string[];
  provenance: MemoryProvenance;
  trust: MemoryTrust;
  sensitivity?: MemorySensitivity;
  /** Defaults to the creation time. */
  valid_from?: string;
  valid_to?: string | null;
  source_run_id?: string | null;
}

export interface AddMemoryVersionInput {
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions?: string[];
  provenance: MemoryProvenance;
  trust: MemoryTrust;
  sensitivity?: MemorySensitivity;
  /** Must not precede the previous version's validity window. */
  valid_from?: string;
  valid_to?: string | null;
  source_run_id?: string | null;
}

export interface AddMemoryEvidenceInput {
  evidence_type: MemoryEvidenceType;
  reference: string;
  note?: string;
}

export interface CreateMemoryLinkInput {
  item_id: MemoryItemId;
  target_item_id: MemoryItemId;
  link_type: MemoryLinkType;
  /** Required for `supersedes` and `contradicts`. */
  reason?: string;
}

export interface PutMemoryEmbeddingInput {
  item_id: MemoryItemId;
  item_version: number;
  model: string;
  dimensions: number;
  vector: string;
}

// ---------------------------------------------------------------------------
// Query filters and export
// ---------------------------------------------------------------------------

export interface MemoryListFilter {
  status?: MemoryStatus;
  kind?: MemoryKind;
  limit?: number;
}

export interface MemorySearchFilter extends MemoryListFilter {
  /** Case-insensitive substring match on the current version's statement. */
  query?: string;
}

export interface MemoryEventFilter {
  item_id?: MemoryItemId;
  run_id?: string;
  event_type?: MemoryEventType;
  limit?: number;
}

export interface MemoryExportItem {
  item: MemoryItem;
  versions: MemoryItemVersion[];
  evidence: MemoryEvidence[];
  links: MemoryLink[];
}

/**
 * Bounded workspace export. Embeddings are derived sensitive data and are
 * deliberately not part of the export surface.
 */
export interface MemoryExport {
  schema_version: number;
  exported_at: string;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId;
  items: MemoryExportItem[];
}

export interface MemoryEraseResult {
  items_purged: number;
  tombstones_written: number;
}
