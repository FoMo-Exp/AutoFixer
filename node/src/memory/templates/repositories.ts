/**
 * Enterprise template storage (DAT-237).
 *
 * Templates live in their own tables, separate from `memory_items`. That
 * separation is the structural guarantee behind two acceptance rules:
 *
 * - a published template is not retrievable by any workspace, because the
 *   memory read path never queries these tables;
 * - adoption is the only bridge, and it writes a *new* local candidate item in
 *   the adopting workspace rather than exposing the template as memory.
 *
 * Every query carries the enterprise scope in SQL. Publication records also
 * carry the source workspace/item, but they are read only through the
 * admin-only service method and never travel with a template version.
 */

import type { ControlPlaneDb } from "../../control-plane/db.js";
import { newId, nowIso } from "../../control-plane/db.js";
import { ConflictError, NotFoundError, ValidationError } from "../../control-plane/errors.js";
import type { EnterpriseId, UserId, WorkspaceId } from "../../control-plane/types.js";
import type { MemoryApplicability, MemoryEvidenceType, MemorySensitivity } from "../types.js";
import type {
  AdoptionRevocationOutcome,
  AdoptionState,
  EnterpriseTemplate,
  EnterpriseTemplateAdoption,
  EnterpriseTemplateEvent,
  EnterpriseTemplateEventType,
  EnterpriseTemplateId,
  EnterpriseTemplateKind,
  EnterpriseTemplatePublication,
  EnterpriseTemplateStatus,
  EnterpriseTemplateVersion,
  TemplateScrubReport,
  TemplateSecurityReview,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row types and mappers
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  enterprise_id: string;
  status: string;
  current_version: number;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

function toTemplate(row: TemplateRow): EnterpriseTemplate {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    status: row.status as EnterpriseTemplateStatus,
    current_version: row.current_version,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    revoke_reason: row.revoke_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

interface TemplateVersionRow {
  template_id: string;
  version: number;
  enterprise_id: string;
  kind: string;
  scope: string;
  statement: string;
  preconditions: string;
  sensitivity: string;
  evidence_classes: string;
  security_review: string | null;
  content_hash: string;
  created_at: string;
  created_by: string;
}

function toTemplateVersion(row: TemplateVersionRow): EnterpriseTemplateVersion {
  return {
    template_id: row.template_id,
    version: row.version,
    enterprise_id: row.enterprise_id,
    kind: row.kind as EnterpriseTemplateKind,
    scope: JSON.parse(row.scope) as MemoryApplicability,
    statement: row.statement,
    preconditions: JSON.parse(row.preconditions) as string[],
    sensitivity: row.sensitivity as MemorySensitivity,
    evidence_classes: JSON.parse(row.evidence_classes) as MemoryEvidenceType[],
    security_review:
      row.security_review === null
        ? null
        : (JSON.parse(row.security_review) as TemplateSecurityReview),
    content_hash: row.content_hash,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

interface PublicationRow {
  id: string;
  enterprise_id: string;
  template_id: string;
  template_version: number;
  source_workspace_id: string;
  source_item_id: string;
  source_item_version: number;
  source_evidence_count: number;
  scrub_report: string;
  published_at: string;
  published_by: string;
}

function toPublication(row: PublicationRow): EnterpriseTemplatePublication {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    template_id: row.template_id,
    template_version: row.template_version,
    source_workspace_id: row.source_workspace_id,
    source_item_id: row.source_item_id,
    source_item_version: row.source_item_version,
    source_evidence_count: row.source_evidence_count,
    scrub_report: JSON.parse(row.scrub_report) as TemplateScrubReport,
    published_at: row.published_at,
    published_by: row.published_by,
  };
}

interface AdoptionRow {
  id: string;
  enterprise_id: string;
  template_id: string;
  template_version: number;
  workspace_id: string;
  item_id: string;
  item_version: number;
  state: string;
  adopted_at: string;
  adopted_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  revocation_outcome: string | null;
}

function toAdoption(row: AdoptionRow): EnterpriseTemplateAdoption {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    template_id: row.template_id,
    template_version: row.template_version,
    workspace_id: row.workspace_id,
    item_id: row.item_id,
    item_version: row.item_version,
    state: row.state as AdoptionState,
    adopted_at: row.adopted_at,
    adopted_by: row.adopted_by,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    revoke_reason: row.revoke_reason,
    revocation_outcome: row.revocation_outcome as AdoptionRevocationOutcome | null,
  };
}

interface EventRow {
  id: string;
  enterprise_id: string;
  workspace_id: string | null;
  template_id: string;
  template_version: number;
  event_type: string;
  actor_id: string;
  detail: string;
  created_at: string;
}

function toEvent(row: EventRow): EnterpriseTemplateEvent {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    template_id: row.template_id,
    template_version: row.template_version,
    event_type: row.event_type as EnterpriseTemplateEventType,
    actor_id: row.actor_id,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type NewPublicationInput = Omit<
  CreatePublicationInput,
  "enterprise_id" | "actor_id" | "template_id" | "template_version"
>;

export interface CreateTemplateInput {
  enterprise_id: EnterpriseId;
  actor_id: UserId;
  kind: EnterpriseTemplateKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  sensitivity: MemorySensitivity;
  evidence_classes: MemoryEvidenceType[];
  security_review: TemplateSecurityReview | null;
  content_hash: string;
  publication: NewPublicationInput;
}

export interface AppendTemplateVersionInput {
  enterprise_id: EnterpriseId;
  template_id: EnterpriseTemplateId;
  actor_id: UserId;
  expected_version: number;
  kind: EnterpriseTemplateKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  sensitivity: MemorySensitivity;
  evidence_classes: MemoryEvidenceType[];
  security_review: TemplateSecurityReview | null;
  content_hash: string;
  publication: NewPublicationInput;
}

export interface CreatePublicationInput {
  enterprise_id: EnterpriseId;
  actor_id: UserId;
  template_id: EnterpriseTemplateId;
  template_version: number;
  source_workspace_id: WorkspaceId;
  source_item_id: string;
  source_item_version: number;
  source_evidence_count: number;
  scrub_report: TemplateScrubReport;
}

export interface CreateAdoptionInput {
  enterprise_id: EnterpriseId;
  actor_id: UserId;
  template_id: EnterpriseTemplateId;
  template_version: number;
  workspace_id: WorkspaceId;
  item_id: string;
  item_version: number;
}

export interface RecordEventInput {
  enterprise_id: EnterpriseId;
  workspace_id: WorkspaceId | null;
  template_id: EnterpriseTemplateId;
  template_version: number;
  event_type: EnterpriseTemplateEventType;
  actor_id: UserId;
  detail: Record<string, unknown>;
}

export interface PublishBundle {
  template: EnterpriseTemplate;
  version: EnterpriseTemplateVersion;
  publication: EnterpriseTemplatePublication;
}

export interface EnterpriseTemplateStore {
  /** Create a header, its first version, the publication record, and audit in one transaction. */
  createTemplate(input: CreateTemplateInput): PublishBundle;
  /** Append a version and publication to an existing published template. */
  appendVersion(input: AppendTemplateVersionInput): PublishBundle;
  getTemplate(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplate | undefined;
  listTemplates(enterpriseId: EnterpriseId, limit?: number): EnterpriseTemplate[];
  getVersion(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
    version: number,
  ): EnterpriseTemplateVersion | undefined;
  listVersions(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplateVersion[];
  findPublicationBySource(
    enterpriseId: EnterpriseId,
    sourceWorkspaceId: WorkspaceId,
    sourceItemId: string,
    sourceItemVersion: number,
  ): EnterpriseTemplatePublication | undefined;
  listPublications(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplatePublication[];
  findAdoption(
    workspaceId: WorkspaceId,
    templateId: EnterpriseTemplateId,
    templateVersion: number,
  ): EnterpriseTemplateAdoption | undefined;
  listAdoptionsByWorkspace(
    enterpriseId: EnterpriseId,
    workspaceId: WorkspaceId,
  ): EnterpriseTemplateAdoption[];
  listAdoptionsByTemplate(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
    limit?: number,
    offset?: number,
  ): EnterpriseTemplateAdoption[];
  createAdoption(input: CreateAdoptionInput): EnterpriseTemplateAdoption;
  /** Record a publication for content that did not need a new version. */
  recordPublication(input: CreatePublicationInput): EnterpriseTemplatePublication;
  markRevoked(input: {
    enterprise_id: EnterpriseId;
    template_id: EnterpriseTemplateId;
    actor_id: UserId;
    expected_version: number;
    reason: string;
  }): EnterpriseTemplate;
  markAdoptionRevoked(input: {
    enterprise_id: EnterpriseId;
    adoption_id: string;
    actor_id: UserId;
    reason: string;
    outcome: AdoptionRevocationOutcome;
  }): EnterpriseTemplateAdoption;
  recordEvent(input: RecordEventInput): EnterpriseTemplateEvent;
  listEnterpriseEvents(enterpriseId: EnterpriseId, limit?: number): EnterpriseTemplateEvent[];
  listWorkspaceEvents(
    enterpriseId: EnterpriseId,
    workspaceId: WorkspaceId,
    limit?: number,
  ): EnterpriseTemplateEvent[];
}

function boundedLimit(limit: number | undefined, fallback = 100): number {
  const resolved = limit ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(resolved, 500);
}

function requireRow<T>(entity: string, id: string, row: T | undefined): T {
  if (row === undefined) {
    throw new NotFoundError(entity, id);
  }
  return row;
}

class SqliteEnterpriseTemplateStore implements EnterpriseTemplateStore {
  private txDepth = 0;

  constructor(private readonly db: ControlPlaneDb) {}

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

  createTemplate(input: CreateTemplateInput): PublishBundle {
    return this.runAtomically(() => {
      const templateId = newId("etp");
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO enterprise_templates
             (id, enterprise_id, status, current_version, revoked_at, revoked_by, revoke_reason,
              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, 'published', 1, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(templateId, input.enterprise_id, now, now, input.actor_id, input.actor_id);
      const version = this.insertVersion(templateId, 1, input);
      const publication = this.insertPublication({
        ...input.publication,
        enterprise_id: input.enterprise_id,
        actor_id: input.actor_id,
        template_id: templateId,
        template_version: 1,
      });
      const template = requireRow(
        "EnterpriseTemplate",
        templateId,
        this.getTemplate(input.enterprise_id, templateId),
      );
      this.recordEvent({
        enterprise_id: input.enterprise_id,
        workspace_id: null,
        template_id: templateId,
        template_version: 1,
        event_type: "template_published",
        actor_id: input.actor_id,
        detail: {
          kind: input.kind,
          evidence_classes: input.evidence_classes,
          security_reviewed: input.security_review !== null,
        },
      });
      return { template, version, publication };
    });
  }

  appendVersion(input: AppendTemplateVersionInput): PublishBundle {
    return this.runAtomically(() => {
      const template = requireRow(
        "EnterpriseTemplate",
        input.template_id,
        this.getTemplate(input.enterprise_id, input.template_id),
      );
      if (template.status !== "published") {
        throw new ConflictError(`EnterpriseTemplate ${input.template_id} is revoked`);
      }
      if (template.current_version !== input.expected_version) {
        throw new ConflictError(
          `EnterpriseTemplate ${input.template_id} was modified concurrently (expected version ${input.expected_version}, found ${template.current_version})`,
        );
      }
      const nextVersion = template.current_version + 1;
      const version = this.insertVersion(input.template_id, nextVersion, input);
      this.db
        .prepare(
          `UPDATE enterprise_templates
              SET current_version = ?, updated_at = ?, updated_by = ?
            WHERE id = ? AND enterprise_id = ? AND current_version = ?`,
        )
        .run(
          nextVersion,
          nowIso(),
          input.actor_id,
          input.template_id,
          input.enterprise_id,
          input.expected_version,
        );
      const publication = this.insertPublication({
        ...input.publication,
        enterprise_id: input.enterprise_id,
        actor_id: input.actor_id,
        template_id: input.template_id,
        template_version: nextVersion,
      });
      this.recordEvent({
        enterprise_id: input.enterprise_id,
        workspace_id: null,
        template_id: input.template_id,
        template_version: nextVersion,
        event_type: "template_version_published",
        actor_id: input.actor_id,
        detail: {
          kind: input.kind,
          evidence_classes: input.evidence_classes,
          security_reviewed: input.security_review !== null,
        },
      });
      return {
        template: requireRow(
          "EnterpriseTemplate",
          input.template_id,
          this.getTemplate(input.enterprise_id, input.template_id),
        ),
        version,
        publication,
      };
    });
  }

  getTemplate(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplate | undefined {
    const row = this.db
      .prepare("SELECT * FROM enterprise_templates WHERE id = ? AND enterprise_id = ?")
      .get(templateId, enterpriseId) as TemplateRow | undefined;
    return row ? toTemplate(row) : undefined;
  }

  listTemplates(enterpriseId: EnterpriseId, limit?: number): EnterpriseTemplate[] {
    const rows = this.db
      .prepare("SELECT * FROM enterprise_templates WHERE enterprise_id = ? ORDER BY rowid LIMIT ?")
      .all(enterpriseId, boundedLimit(limit)) as unknown as TemplateRow[];
    return rows.map(toTemplate);
  }

  getVersion(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
    version: number,
  ): EnterpriseTemplateVersion | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM enterprise_template_versions
          WHERE enterprise_id = ? AND template_id = ? AND version = ?`,
      )
      .get(enterpriseId, templateId, version) as TemplateVersionRow | undefined;
    return row ? toTemplateVersion(row) : undefined;
  }

  listVersions(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplateVersion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM enterprise_template_versions
          WHERE enterprise_id = ? AND template_id = ? ORDER BY version`,
      )
      .all(enterpriseId, templateId) as unknown as TemplateVersionRow[];
    return rows.map(toTemplateVersion);
  }

  findPublicationBySource(
    enterpriseId: EnterpriseId,
    sourceWorkspaceId: WorkspaceId,
    sourceItemId: string,
    sourceItemVersion: number,
  ): EnterpriseTemplatePublication | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM enterprise_template_publications
          WHERE enterprise_id = ? AND source_workspace_id = ?
            AND source_item_id = ? AND source_item_version = ?`,
      )
      .get(enterpriseId, sourceWorkspaceId, sourceItemId, sourceItemVersion) as
      PublicationRow | undefined;
    return row ? toPublication(row) : undefined;
  }

  listPublications(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplatePublication[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM enterprise_template_publications
          WHERE enterprise_id = ? AND template_id = ? ORDER BY template_version, rowid`,
      )
      .all(enterpriseId, templateId) as unknown as PublicationRow[];
    return rows.map(toPublication);
  }

  findAdoption(
    workspaceId: WorkspaceId,
    templateId: EnterpriseTemplateId,
    templateVersion: number,
  ): EnterpriseTemplateAdoption | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM enterprise_template_adoptions
          WHERE workspace_id = ? AND template_id = ? AND template_version = ?`,
      )
      .get(workspaceId, templateId, templateVersion) as AdoptionRow | undefined;
    return row ? toAdoption(row) : undefined;
  }

  listAdoptionsByWorkspace(
    enterpriseId: EnterpriseId,
    workspaceId: WorkspaceId,
  ): EnterpriseTemplateAdoption[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM enterprise_template_adoptions
          WHERE enterprise_id = ? AND workspace_id = ? ORDER BY rowid`,
      )
      .all(enterpriseId, workspaceId) as unknown as AdoptionRow[];
    return rows.map(toAdoption);
  }

  listAdoptionsByTemplate(
    enterpriseId: EnterpriseId,
    templateId: EnterpriseTemplateId,
    limit?: number,
    offset = 0,
  ): EnterpriseTemplateAdoption[] {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("offset must be a non-negative integer");
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM enterprise_template_adoptions
          WHERE enterprise_id = ? AND template_id = ? ORDER BY rowid LIMIT ? OFFSET ?`,
      )
      .all(enterpriseId, templateId, boundedLimit(limit), offset) as unknown as AdoptionRow[];
    return rows.map(toAdoption);
  }

  createAdoption(input: CreateAdoptionInput): EnterpriseTemplateAdoption {
    const id = newId("eta");
    try {
      this.db
        .prepare(
          `INSERT INTO enterprise_template_adoptions
             (id, enterprise_id, template_id, template_version, workspace_id, item_id, item_version,
              state, adopted_at, adopted_by, revoked_at, revoked_by, revoke_reason, revocation_outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          id,
          input.enterprise_id,
          input.template_id,
          input.template_version,
          input.workspace_id,
          input.item_id,
          input.item_version,
          nowIso(),
          input.actor_id,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ConflictError(
          `EnterpriseTemplate ${input.template_id}@${input.template_version} is already adopted in this workspace`,
        );
      }
      throw error;
    }
    const row = this.db
      .prepare("SELECT * FROM enterprise_template_adoptions WHERE id = ?")
      .get(id) as AdoptionRow | undefined;
    return toAdoption(requireRow("EnterpriseTemplateAdoption", id, row));
  }

  recordPublication(input: CreatePublicationInput): EnterpriseTemplatePublication {
    return this.insertPublication(input);
  }

  markRevoked(input: {
    enterprise_id: EnterpriseId;
    template_id: EnterpriseTemplateId;
    actor_id: UserId;
    expected_version: number;
    reason: string;
  }): EnterpriseTemplate {
    return this.runAtomically(() => {
      const template = requireRow(
        "EnterpriseTemplate",
        input.template_id,
        this.getTemplate(input.enterprise_id, input.template_id),
      );
      if (template.status === "revoked") {
        throw new ConflictError(`EnterpriseTemplate ${input.template_id} is already revoked`);
      }
      if (template.current_version !== input.expected_version) {
        throw new ConflictError(
          `EnterpriseTemplate ${input.template_id} was modified concurrently (expected version ${input.expected_version}, found ${template.current_version})`,
        );
      }
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE enterprise_templates
              SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ?,
                  updated_at = ?, updated_by = ?
            WHERE id = ? AND enterprise_id = ? AND status = 'published'`,
        )
        .run(
          now,
          input.actor_id,
          input.reason,
          now,
          input.actor_id,
          input.template_id,
          input.enterprise_id,
        );
      this.recordEvent({
        enterprise_id: input.enterprise_id,
        workspace_id: null,
        template_id: input.template_id,
        template_version: template.current_version,
        event_type: "template_revoked",
        actor_id: input.actor_id,
        detail: { revoked_version: template.current_version },
      });
      return requireRow(
        "EnterpriseTemplate",
        input.template_id,
        this.getTemplate(input.enterprise_id, input.template_id),
      );
    });
  }

  markAdoptionRevoked(input: {
    enterprise_id: EnterpriseId;
    adoption_id: string;
    actor_id: UserId;
    reason: string;
    outcome: AdoptionRevocationOutcome;
  }): EnterpriseTemplateAdoption {
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE enterprise_template_adoptions
            SET state = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ?,
                revocation_outcome = ?
          WHERE id = ? AND enterprise_id = ? AND state = 'active'`,
      )
      .run(
        now,
        input.actor_id,
        input.reason,
        input.outcome,
        input.adoption_id,
        input.enterprise_id,
      ) as unknown as {
      changes: number;
    };
    if (result.changes === 0) {
      throw new ConflictError(`EnterpriseTemplateAdoption ${input.adoption_id} is already revoked`);
    }
    return toAdoption(
      requireRow(
        "EnterpriseTemplateAdoption",
        input.adoption_id,
        this.db
          .prepare("SELECT * FROM enterprise_template_adoptions WHERE id = ?")
          .get(input.adoption_id) as AdoptionRow | undefined,
      ),
    );
  }

  recordEvent(input: RecordEventInput): EnterpriseTemplateEvent {
    const id = newId("ete");
    this.db
      .prepare(
        `INSERT INTO enterprise_template_events
           (id, enterprise_id, workspace_id, template_id, template_version, event_type, actor_id, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.enterprise_id,
        input.workspace_id,
        input.template_id,
        input.template_version,
        input.event_type,
        input.actor_id,
        JSON.stringify(input.detail),
        nowIso(),
      );
    return toEvent(
      requireRow(
        "EnterpriseTemplateEvent",
        id,
        this.db.prepare("SELECT * FROM enterprise_template_events WHERE id = ?").get(id) as
          EventRow | undefined,
      ),
    );
  }

  listEnterpriseEvents(enterpriseId: EnterpriseId, limit?: number): EnterpriseTemplateEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM enterprise_template_events WHERE enterprise_id = ?
          ORDER BY rowid LIMIT ?`,
      )
      .all(enterpriseId, boundedLimit(limit)) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  listWorkspaceEvents(
    enterpriseId: EnterpriseId,
    workspaceId: WorkspaceId,
    limit?: number,
  ): EnterpriseTemplateEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM enterprise_template_events
          WHERE enterprise_id = ? AND workspace_id = ? ORDER BY rowid LIMIT ?`,
      )
      .all(enterpriseId, workspaceId, boundedLimit(limit)) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  private insertVersion(
    templateId: EnterpriseTemplateId,
    version: number,
    input: {
      enterprise_id: EnterpriseId;
      actor_id: UserId;
      kind: EnterpriseTemplateKind;
      scope: MemoryApplicability;
      statement: string;
      preconditions: string[];
      sensitivity: MemorySensitivity;
      evidence_classes: MemoryEvidenceType[];
      security_review: TemplateSecurityReview | null;
      content_hash: string;
    },
  ): EnterpriseTemplateVersion {
    this.db
      .prepare(
        `INSERT INTO enterprise_template_versions
           (template_id, version, enterprise_id, kind, scope, statement, preconditions, sensitivity,
            evidence_classes, security_review, content_hash, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        templateId,
        version,
        input.enterprise_id,
        input.kind,
        JSON.stringify(input.scope),
        input.statement,
        JSON.stringify(input.preconditions),
        input.sensitivity,
        JSON.stringify(input.evidence_classes),
        input.security_review === null ? null : JSON.stringify(input.security_review),
        input.content_hash,
        nowIso(),
        input.actor_id,
      );
    return requireRow(
      "EnterpriseTemplateVersion",
      `${templateId}#${version}`,
      this.getVersion(input.enterprise_id, templateId, version),
    );
  }

  private insertPublication(input: CreatePublicationInput): EnterpriseTemplatePublication {
    const id = newId("etb");
    try {
      this.db
        .prepare(
          `INSERT INTO enterprise_template_publications
             (id, enterprise_id, template_id, template_version, source_workspace_id, source_item_id,
              source_item_version, source_evidence_count, scrub_report, published_at, published_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.enterprise_id,
          input.template_id,
          input.template_version,
          input.source_workspace_id,
          input.source_item_id,
          input.source_item_version,
          input.source_evidence_count,
          JSON.stringify(input.scrub_report),
          nowIso(),
          input.actor_id,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ConflictError(
          `source version ${input.source_item_id}#${input.source_item_version} was already published`,
        );
      }
      throw error;
    }
    const row = this.db
      .prepare("SELECT * FROM enterprise_template_publications WHERE id = ?")
      .get(id) as PublicationRow | undefined;
    return toPublication(requireRow("EnterpriseTemplatePublication", id, row));
  }
}

export function createEnterpriseTemplateStore(db: ControlPlaneDb): EnterpriseTemplateStore {
  return new SqliteEnterpriseTemplateStore(db);
}
