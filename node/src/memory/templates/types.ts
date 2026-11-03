/**
 * Enterprise template types (DAT-237).
 *
 * An enterprise template is a scrubbed, immutable copy of one memory item
 * version that an enterprise administrator explicitly publishes. Templates
 * live in their own tables: they are not memory items, they are not visible to
 * any workspace's retrieval path, and adopting one never modifies another
 * workspace. See `docs/contracts/memory-enterprise-templates-v1.md`.
 *
 * Two identities are deliberately split:
 *
 * - the *template* (what another workspace may adopt): scrubbed statement,
 *   applicability, evidence **classes**, sensitivity, and security review;
 * - the *publication record* (admin-only audit): which source workspace, item,
 *   and version the template came from, plus a redaction report of counts.
 *
 * The publication record never travels with an adoption, so an adopting
 * workspace cannot reconstruct the source workspace from what it receives.
 */

import type {
  EnterpriseId,
  TeamId,
  UserId,
  WorkspaceId,
  WorkspaceScope,
} from "../../control-plane/types.js";
import type {
  MemoryApplicability,
  MemoryEvidenceType,
  MemoryItemId,
  MemoryItemRecord,
  MemoryKind,
  MemorySensitivity,
} from "../types.js";

// ---------------------------------------------------------------------------
// Schema version (contract and fixture tests)
// ---------------------------------------------------------------------------

export const ENTERPRISE_TEMPLATE_SCHEMA_VERSION = 1;

export type EnterpriseTemplateId = string;
export type EnterpriseTemplateAdoptionId = string;
export type EnterpriseTemplateEventId = string;
export type EnterpriseTemplatePublicationId = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Template headers are either published or revoked. Revocation is terminal:
 * revoked templates cannot be revised, re-published, or newly adopted.
 */
export type EnterpriseTemplateStatus = "published" | "revoked";

/**
 * Only durable L2/L3 content can be shared. `episode` (a run-scoped record)
 * and `policy` (L4 institutional policy) are rejected: policy can bind a
 * workspace only through an explicit policy publication, never through a
 * template.
 */
export type EnterpriseTemplateKind = Extract<
  MemoryKind,
  "fact" | "lesson" | "playbook" | "anti_pattern"
>;

export const ENTERPRISE_TEMPLATE_KINDS: readonly EnterpriseTemplateKind[] = [
  "fact",
  "lesson",
  "playbook",
  "anti_pattern",
];

/**
 * Procedural content — ordered steps, anti-patterns, and lessons — can carry
 * execution guidance and therefore requires a named security review before
 * publication.
 */
export const PROCEDURAL_TEMPLATE_KINDS: readonly EnterpriseTemplateKind[] = [
  "lesson",
  "playbook",
  "anti_pattern",
];

export type AdoptionState = "active" | "revoked";

/**
 * What revocation did to one adopter's local copy. Revocation never deletes
 * history: a quarantined or retired copy stays exactly as it was, and only
 * the adoption record changes.
 */
export type AdoptionRevocationOutcome =
  | "deprecated"
  | "already_deprecated"
  | "quarantined_untouched"
  | "retired_untouched"
  | "item_missing"
  | "deprecation_failed";

export type EnterpriseTemplateEventType =
  | "template_published"
  | "template_version_published"
  | "template_revoked"
  | "template_adopted"
  | "adoption_deprecated"
  | "adoption_revocation_skipped";

/**
 * Scrub categories. Reports carry counts per category, never the matched
 * text: the whole point is that the removed content does not survive.
 */
export type ScrubRedactionKind =
  | "credential"
  | "url"
  | "issue_reference"
  | "email"
  | "phone"
  | "ip_address"
  | "local_path"
  | "log_line"
  | "control_token"
  | "enterprise_identifier"
  | "workspace_identifier"
  | "team_identifier"
  | "long_digest"
  | "personal_data_label";

// ---------------------------------------------------------------------------
// Value objects
// ---------------------------------------------------------------------------

/** A named enterprise administrator's review of exact procedural content. */
export interface TemplateSecurityReview {
  reviewer_id: UserId;
  reviewed_at: string;
}

/** Counts-only proof of what scrubbing removed. Never contains matches. */
export interface TemplateScrubReport {
  redactions: Partial<Record<ScrubRedactionKind, number>>;
  /** Scope fields dropped because they were workspace-identifying or empty. */
  removed_scope_fields: string[];
  /** Evidence classes observed on the source item (classes only, no payload). */
  evidence_classes: MemoryEvidenceType[];
  /** Number of source evidence references, retained as a count only. */
  source_evidence_count: number;
  /** Lines removed from multiline statements because they looked like logs. */
  removed_log_lines: number;
  /** Every remaining detector ran clean before publication. */
  residual_scan: "clean";
}

/**
 * What an adopting workspace receives. Nothing here identifies the source
 * workspace, its repository, its teams, or its evidence payload.
 */
export interface EnterpriseTemplateVersion {
  template_id: EnterpriseTemplateId;
  version: number;
  enterprise_id: EnterpriseId;
  kind: EnterpriseTemplateKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  sensitivity: MemorySensitivity;
  evidence_classes: MemoryEvidenceType[];
  security_review: TemplateSecurityReview | null;
  content_hash: string;
  created_at: string;
  created_by: UserId;
}

export interface EnterpriseTemplate {
  id: EnterpriseTemplateId;
  enterprise_id: EnterpriseId;
  status: EnterpriseTemplateStatus;
  current_version: number;
  revoked_at: string | null;
  revoked_by: UserId | null;
  /** Admin-only free text. Never copied to a template version or adoption. */
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: UserId;
  updated_by: UserId;
}

export interface EnterpriseTemplateRecord {
  template: EnterpriseTemplate;
  current: EnterpriseTemplateVersion;
}

/** Admin-only provenance of one publication. Never exposed to adopters. */
export interface EnterpriseTemplatePublication {
  id: EnterpriseTemplatePublicationId;
  enterprise_id: EnterpriseId;
  template_id: EnterpriseTemplateId;
  template_version: number;
  source_workspace_id: WorkspaceId;
  source_item_id: MemoryItemId;
  source_item_version: number;
  source_evidence_count: number;
  scrub_report: TemplateScrubReport;
  published_at: string;
  published_by: UserId;
}

export interface EnterpriseTemplateAdoption {
  id: EnterpriseTemplateAdoptionId;
  enterprise_id: EnterpriseId;
  template_id: EnterpriseTemplateId;
  template_version: number;
  workspace_id: WorkspaceId;
  item_id: MemoryItemId;
  /** Content version of the local copy created by adoption (always 1 here). */
  item_version: number;
  state: AdoptionState;
  adopted_at: string;
  adopted_by: UserId;
  revoked_at: string | null;
  revoked_by: UserId | null;
  revoke_reason: string | null;
  revocation_outcome: AdoptionRevocationOutcome | null;
}

/** Append-only template audit. No foreign keys: it outlives its rows. */
export interface EnterpriseTemplateEvent {
  id: EnterpriseTemplateEventId;
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId | null;
  template_id: EnterpriseTemplateId;
  template_version: number;
  event_type: EnterpriseTemplateEventType;
  actor_id: UserId;
  /** Metadata only: opaque IDs, fixed enums, and counts. Never content or reasons. */
  detail: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Inputs and results
// ---------------------------------------------------------------------------

export interface PublishEnterpriseTemplateInput {
  /** Source workspace. Must belong to the caller's enterprise. */
  source_workspace_id: WorkspaceId;
  source_item_id: MemoryItemId;
  /** The exact source version the administrator published (optimistic pin). */
  source_item_version: number;
  /** Revise an existing template; omit to create a new template. */
  template_id?: EnterpriseTemplateId;
  /** Required for lesson/playbook/anti_pattern: an enterprise admin who is not the publisher. */
  security_review?: TemplateSecurityReview;
}

export interface PublishEnterpriseTemplateResult {
  template: EnterpriseTemplate;
  version: EnterpriseTemplateVersion;
  publication: EnterpriseTemplatePublication;
  /** False when the exact source version had already been published. */
  created: boolean;
}

export interface AdoptEnterpriseTemplateInput {
  template_id: EnterpriseTemplateId;
  /** Pinned template version; adoption never floats to the latest version. */
  template_version: number;
}

export interface AdoptEnterpriseTemplateResult {
  adoption: EnterpriseTemplateAdoption;
  item: MemoryItemRecord;
  /** True when an identical adoption already existed (idempotent retry). */
  existing: boolean;
}

export interface RevokeEnterpriseTemplateInput {
  template_id: EnterpriseTemplateId;
  /** Required: revocation must be explainable to affected workspace owners. */
  reason: string;
}

export interface RevokeEnterpriseTemplateResult {
  template: EnterpriseTemplate;
  adoptions: EnterpriseTemplateAdoption[];
  /** Adoption outcomes by fixed code, for the operator response. */
  outcomes: Partial<Record<AdoptionRevocationOutcome, number>>;
}

/** The source-side identity terms a scrub must remove. */
export interface SourceIdentityTerms {
  enterprise: { id: string; name: string; slug: string };
  workspaces: Array<{ id: string; name: string; repository_id: string }>;
  repository_names: string[];
  teams: Array<{ id: TeamId; name: string }>;
}

export interface ScrubbedTemplateContent {
  kind: EnterpriseTemplateKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  sensitivity: MemorySensitivity;
  report: TemplateScrubReport;
}

/** Service surface, grouped so callers cannot use internal stores by accident. */
export interface EnterpriseTemplateService {
  publish(
    scope: WorkspaceScope,
    input: PublishEnterpriseTemplateInput,
  ): PublishEnterpriseTemplateResult;
  listTemplates(scope: WorkspaceScope): EnterpriseTemplateRecord[];
  getTemplate(scope: WorkspaceScope, templateId: EnterpriseTemplateId): EnterpriseTemplateRecord;
  listVersions(
    scope: WorkspaceScope,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplateVersion[];
  /** Admin-only: which source workspace/version each template version came from. */
  listPublications(
    scope: WorkspaceScope,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplatePublication[];
  adopt(scope: WorkspaceScope, input: AdoptEnterpriseTemplateInput): AdoptEnterpriseTemplateResult;
  revoke(
    scope: WorkspaceScope,
    input: RevokeEnterpriseTemplateInput,
  ): RevokeEnterpriseTemplateResult;
  listAdoptions(scope: WorkspaceScope): EnterpriseTemplateAdoption[];
  listTemplateAdoptions(
    scope: WorkspaceScope,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplateAdoption[];
  /** Enterprise-level audit, restricted to enterprise administrators. */
  listEnterpriseEvents(scope: WorkspaceScope): EnterpriseTemplateEvent[];
  /** Workspace-level audit of adoptions and revocations affecting this workspace. */
  listWorkspaceEvents(scope: WorkspaceScope): EnterpriseTemplateEvent[];
}
