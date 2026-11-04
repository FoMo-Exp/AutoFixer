/**
 * Enterprise template service (DAT-237).
 *
 * Publication is an explicit enterprise-administrator action from one source
 * workspace. Adoption is an explicit workspace-manager action in another
 * workspace of the same enterprise, and it creates a local **candidate** only:
 * no administrator action can make memory active in a workspace that did not
 * adopt and validate it.
 *
 * The service owns three boundaries the storage layer cannot express:
 *
 * 1. authority — publication/revocation need an enterprise admin; adoption
 *    needs a workspace owner or admin;
 * 2. scrubbing and policy lint — before anything is persisted;
 * 3. lifecycle — revocation deprecates local copies without rewriting any
 *    version, evidence, or audit row.
 */

import type { ControlPlaneDb } from "../../control-plane/db.js";
import {
  ConflictError,
  NotFoundError,
  ScopeError,
  ValidationError,
  VersionConflictError,
} from "../../control-plane/errors.js";
import { createIdentityRepositories } from "../../control-plane/identity-repositories.js";
import { createProviderAccessRepositories } from "../../control-plane/provider-access-repositories.js";
import { createRepositories } from "../../control-plane/repositories.js";
import type { EnterpriseScope, UserId, WorkspaceScope } from "../../control-plane/types.js";
import { isTimestamp } from "../../trace/schema.js";
import { memoryContentHash } from "../hash.js";
import { createMemoryRepositories } from "../repositories.js";
import type { MemoryRepositories } from "../repositories.js";
import type { MemoryEvidenceType, MemoryItemRecord, MemoryStatus } from "../types.js";
import { assertTemplatePolicyClean, requiresSecurityReview } from "./policy.js";
import { createEnterpriseTemplateStore } from "./repositories.js";
import type { EnterpriseTemplateStore } from "./repositories.js";
import { orderEvidenceClasses, scrubTemplateContent } from "./scrub.js";
import type {
  EnterpriseTemplate,
  EnterpriseTemplateId,
  EnterpriseTemplateKind,
  EnterpriseTemplateRecord,
  EnterpriseTemplateService,
  EnterpriseTemplateVersion,
  EnterpriseTemplatePublication,
  EnterpriseTemplateAdoption,
  EnterpriseTemplateEvent,
  AdoptEnterpriseTemplateInput,
  AdoptEnterpriseTemplateResult,
  AdoptionRevocationOutcome,
  PublishEnterpriseTemplateInput,
  PublishEnterpriseTemplateResult,
  RevokeEnterpriseTemplateInput,
  RevokeEnterpriseTemplateResult,
  SourceIdentityTerms,
  TemplateSecurityReview,
} from "./types.js";
import { ENTERPRISE_TEMPLATE_KINDS } from "./types.js";

const MAX_SCRUBBED_WORKSPACES = 500;
/** Adoption rows processed per revocation page; pages continue until exhausted. */
const REVOCATION_PAGE_SIZE = 500;

function isEnterpriseAdmin(
  identity: ReturnType<typeof createIdentityRepositories>,
  enterpriseId: string,
  userId: UserId,
): boolean {
  const role = identity.enterpriseRoles.getByUser(enterpriseId, userId);
  return role !== undefined && role.role === "admin";
}

function requireEnterpriseAdmin(
  identity: ReturnType<typeof createIdentityRepositories>,
  enterpriseId: string,
  userId: UserId,
): void {
  if (!isEnterpriseAdmin(identity, enterpriseId, userId)) {
    throw new ScopeError(
      "template publication, revocation, and publication records require an enterprise administrator",
    );
  }
}

function requireWorkspaceManager(
  controlPlane: ReturnType<typeof createRepositories>,
  identity: ReturnType<typeof createIdentityRepositories>,
  scope: WorkspaceScope,
): void {
  if (isEnterpriseAdmin(identity, scope.enterprise_id, scope.actor_id)) {
    return;
  }
  const membership = controlPlane.memberships.getByUser(scope, scope.actor_id);
  if (membership === undefined || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new ScopeError("adoption requires a workspace owner or administrator");
  }
}

function requireWorkspaceReader(
  controlPlane: ReturnType<typeof createRepositories>,
  identity: ReturnType<typeof createIdentityRepositories>,
  scope: WorkspaceScope,
): void {
  if (isEnterpriseAdmin(identity, scope.enterprise_id, scope.actor_id)) {
    return;
  }
  if (controlPlane.memberships.getByUser(scope, scope.actor_id) === undefined) {
    throw new ScopeError("template listing requires enterprise or workspace membership");
  }
}

function requireTemplateKind(kind: string): EnterpriseTemplateKind {
  if (!ENTERPRISE_TEMPLATE_KINDS.includes(kind as EnterpriseTemplateKind)) {
    throw new ValidationError(
      `memory kind ${kind} cannot be published as an enterprise template (only fact, lesson, playbook, anti_pattern)`,
    );
  }
  return kind as EnterpriseTemplateKind;
}

function normalizeReviewTimestamp(value: string): string {
  if (!isTimestamp(value)) {
    throw new ValidationError("security review timestamp must be an RFC 3339 timestamp");
  }
  return new Date(value).toISOString();
}

/**
 * Collect every source-identifying term available in the control plane. Only
 * names the deployment actually stores are scrubbed; personal names are not a
 * directory field here, so PII protection relies on pattern detectors plus the
 * publishing administrator's attestation.
 */
function collectSourceIdentity(
  db: ControlPlaneDb,
  scope: WorkspaceScope,
  sourceWorkspaceId: string,
): SourceIdentityTerms {
  const controlPlane = createRepositories(db);
  const integrations = createProviderAccessRepositories(db);
  const enterprise = controlPlane.enterprises.getById(scope.enterprise_id);
  if (enterprise === undefined) {
    throw new NotFoundError("Enterprise", scope.enterprise_id);
  }
  const workspaces = controlPlane.workspaces.list({
    enterprise_id: scope.enterprise_id,
    actor_id: scope.actor_id,
  });
  if (workspaces.length > MAX_SCRUBBED_WORKSPACES) {
    throw new ValidationError(
      `enterprise has more than ${MAX_SCRUBBED_WORKSPACES} workspaces; template scrubbing cannot enumerate identifiers safely`,
    );
  }
  const identities: SourceIdentityTerms["workspaces"] = [];
  const repositoryNames: string[] = [];
  const teams: SourceIdentityTerms["teams"] = [];
  for (const workspace of workspaces) {
    identities.push({
      id: workspace.id,
      name: workspace.name,
      repository_id: workspace.repository_id,
    });
    const workspaceScope: WorkspaceScope = {
      enterprise_id: scope.enterprise_id,
      workspace_id: workspace.id,
      actor_id: scope.actor_id,
    };
    for (const integration of integrations.integrations.listByWorkspace(workspaceScope)) {
      repositoryNames.push(integration.repository_name);
    }
    for (const team of controlPlane.teams.list(workspaceScope)) {
      teams.push({ id: team.id, name: team.name });
    }
  }
  if (!identities.some((entry) => entry.id === sourceWorkspaceId)) {
    throw new NotFoundError("Workspace", sourceWorkspaceId);
  }
  return {
    enterprise: { id: enterprise.id, name: enterprise.name, slug: enterprise.slug },
    workspaces: identities,
    repository_names: repositoryNames,
    teams,
  };
}

function uniqueEvidenceClasses(
  evidence: ReadonlyArray<{ evidence_type: MemoryEvidenceType }>,
): MemoryEvidenceType[] {
  return orderEvidenceClasses([...new Set(evidence.map((entry) => entry.evidence_type))]);
}

class DefaultEnterpriseTemplateService implements EnterpriseTemplateService {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly store: EnterpriseTemplateStore,
    private readonly memory: MemoryRepositories,
  ) {}

  private get controlPlane() {
    return createRepositories(this.db);
  }

  private get identity() {
    return createIdentityRepositories(this.db);
  }

  publish(
    scope: WorkspaceScope,
    input: PublishEnterpriseTemplateInput,
  ): PublishEnterpriseTemplateResult {
    requireEnterpriseAdmin(this.identity, scope.enterprise_id, scope.actor_id);

    const sourceScope: WorkspaceScope = {
      enterprise_id: scope.enterprise_id,
      workspace_id: input.source_workspace_id,
      actor_id: scope.actor_id,
    };
    const workspace = this.controlPlane.workspaces.getById(
      { enterprise_id: scope.enterprise_id, actor_id: scope.actor_id },
      input.source_workspace_id,
    );
    if (workspace === undefined) {
      throw new NotFoundError("Workspace", input.source_workspace_id);
    }
    const record = this.memory.items.getById(sourceScope, input.source_item_id);
    if (record === undefined) {
      throw new NotFoundError("MemoryItem", input.source_item_id);
    }
    if (record.item.current_version !== input.source_item_version) {
      throw new VersionConflictError(
        "MemoryItem",
        input.source_item_id,
        input.source_item_version,
        record.item.current_version,
      );
    }
    if (record.item.status !== "active") {
      throw new ValidationError(
        "only an active memory item can be published as an enterprise template",
      );
    }
    const kind = requireTemplateKind(record.current.kind);
    const evidence = this.memory.evidence.listByItem(sourceScope, input.source_item_id);
    if (evidence.length === 0) {
      throw new ValidationError("an enterprise template requires source evidence");
    }

    // Idempotency: the same source version is published at most once.
    const existingPublication = this.store.findPublicationBySource(
      scope.enterprise_id,
      input.source_workspace_id,
      input.source_item_id,
      input.source_item_version,
    );
    if (existingPublication !== undefined) {
      if (
        input.template_id !== undefined &&
        input.template_id !== existingPublication.template_id
      ) {
        throw new ConflictError(
          `source version ${input.source_item_id}#${input.source_item_version} was already published as ${existingPublication.template_id}`,
        );
      }
      const template = this.store.getTemplate(scope.enterprise_id, existingPublication.template_id);
      if (template === undefined) {
        throw new NotFoundError("EnterpriseTemplate", existingPublication.template_id);
      }
      const version = this.store.getVersion(
        scope.enterprise_id,
        existingPublication.template_id,
        existingPublication.template_version,
      );
      if (version === undefined) {
        throw new NotFoundError(
          "EnterpriseTemplateVersion",
          `${existingPublication.template_id}#${existingPublication.template_version}`,
        );
      }
      return { template, version, publication: existingPublication, created: false };
    }

    const identity = collectSourceIdentity(this.db, scope, input.source_workspace_id);
    const scrubbed = scrubTemplateContent({
      kind,
      scope: record.current.scope,
      statement: record.current.statement,
      preconditions: record.current.preconditions,
      sensitivity: record.current.sensitivity,
      evidenceClasses: uniqueEvidenceClasses(evidence),
      evidenceCount: evidence.length,
      identity,
    });
    assertTemplatePolicyClean({
      statement: scrubbed.statement,
      preconditions: scrubbed.preconditions,
    });
    const securityReview = this.resolveSecurityReview(scope, input, kind);
    const contentHash = memoryContentHash({
      kind: scrubbed.kind,
      scope: scrubbed.scope,
      statement: scrubbed.statement,
      preconditions: scrubbed.preconditions,
      sensitivity: scrubbed.sensitivity,
    });
    const publicationInput = {
      source_workspace_id: input.source_workspace_id,
      source_item_id: input.source_item_id,
      source_item_version: input.source_item_version,
      source_evidence_count: evidence.length,
      scrub_report: scrubbed.report,
    };

    if (input.template_id === undefined) {
      const bundle = this.store.createTemplate({
        enterprise_id: scope.enterprise_id,
        actor_id: scope.actor_id,
        kind: scrubbed.kind,
        scope: scrubbed.scope,
        statement: scrubbed.statement,
        preconditions: scrubbed.preconditions,
        sensitivity: scrubbed.sensitivity,
        evidence_classes: scrubbed.report.evidence_classes,
        security_review: securityReview,
        content_hash: contentHash,
        publication: publicationInput,
      });
      return { ...bundle, created: true };
    }

    const template = this.store.getTemplate(scope.enterprise_id, input.template_id);
    if (template === undefined) {
      throw new NotFoundError("EnterpriseTemplate", input.template_id);
    }
    if (template.status !== "published") {
      throw new ConflictError(`EnterpriseTemplate ${input.template_id} is revoked`);
    }
    const currentVersion = this.store.getVersion(
      scope.enterprise_id,
      input.template_id,
      template.current_version,
    );
    if (currentVersion === undefined) {
      throw new NotFoundError(
        "EnterpriseTemplateVersion",
        `${input.template_id}#${template.current_version}`,
      );
    }
    if (currentVersion.content_hash === contentHash) {
      // Content is unchanged: no new version, but the new publication is
      // recorded so the admin audit still shows where this revision came from.
      const publication = this.store.recordPublication({
        enterprise_id: scope.enterprise_id,
        actor_id: scope.actor_id,
        template_id: input.template_id,
        template_version: template.current_version,
        ...publicationInput,
      });
      return { template, version: currentVersion, publication, created: false };
    }
    const bundle = this.store.appendVersion({
      enterprise_id: scope.enterprise_id,
      template_id: input.template_id,
      actor_id: scope.actor_id,
      expected_version: template.current_version,
      kind: scrubbed.kind,
      scope: scrubbed.scope,
      statement: scrubbed.statement,
      preconditions: scrubbed.preconditions,
      sensitivity: scrubbed.sensitivity,
      evidence_classes: scrubbed.report.evidence_classes,
      security_review: securityReview,
      content_hash: contentHash,
      publication: publicationInput,
    });
    return { ...bundle, created: true };
  }

  listTemplates(scope: WorkspaceScope): EnterpriseTemplateRecord[] {
    requireWorkspaceReader(this.controlPlane, this.identity, scope);
    return this.store
      .listTemplates(scope.enterprise_id)
      .map((template) => this.recordFor(template));
  }

  getTemplate(scope: WorkspaceScope, templateId: EnterpriseTemplateId): EnterpriseTemplateRecord {
    requireWorkspaceReader(this.controlPlane, this.identity, scope);
    const template = this.store.getTemplate(scope.enterprise_id, templateId);
    if (template === undefined) {
      throw new NotFoundError("EnterpriseTemplate", templateId);
    }
    return this.recordFor(template);
  }

  listVersions(
    scope: WorkspaceScope,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplateVersion[] {
    requireWorkspaceReader(this.controlPlane, this.identity, scope);
    if (this.store.getTemplate(scope.enterprise_id, templateId) === undefined) {
      throw new NotFoundError("EnterpriseTemplate", templateId);
    }
    return this.store.listVersions(scope.enterprise_id, templateId);
  }

  listPublications(
    scope: WorkspaceScope,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplatePublication[] {
    requireEnterpriseAdmin(this.identity, scope.enterprise_id, scope.actor_id);
    if (this.store.getTemplate(scope.enterprise_id, templateId) === undefined) {
      throw new NotFoundError("EnterpriseTemplate", templateId);
    }
    return this.store.listPublications(scope.enterprise_id, templateId);
  }

  adopt(scope: WorkspaceScope, input: AdoptEnterpriseTemplateInput): AdoptEnterpriseTemplateResult {
    requireWorkspaceManager(this.controlPlane, this.identity, scope);
    const workspace = this.controlPlane.workspaces.getById(
      { enterprise_id: scope.enterprise_id, actor_id: scope.actor_id },
      scope.workspace_id,
    );
    if (workspace === undefined) {
      throw new NotFoundError("Workspace", scope.workspace_id);
    }
    const template = this.store.getTemplate(scope.enterprise_id, input.template_id);
    if (template === undefined) {
      throw new NotFoundError("EnterpriseTemplate", input.template_id);
    }
    if (template.status !== "published") {
      throw new ConflictError(
        `EnterpriseTemplate ${input.template_id} is revoked and cannot be newly adopted`,
      );
    }
    const version = this.store.getVersion(
      scope.enterprise_id,
      input.template_id,
      input.template_version,
    );
    if (version === undefined) {
      throw new NotFoundError(
        "EnterpriseTemplateVersion",
        `${input.template_id}#${input.template_version}`,
      );
    }
    // Templates are data. Re-lint at adoption so a tampered row cannot smuggle
    // an instruction into a workspace even though publication linted it.
    assertTemplatePolicyClean({
      statement: version.statement,
      preconditions: version.preconditions,
    });
    const existing = this.store.findAdoption(
      scope.workspace_id,
      input.template_id,
      input.template_version,
    );
    if (existing !== undefined) {
      // A revocation may have completed between the status read above and this
      // lookup; never return a revoked adoption as if adoption succeeded.
      if (existing.state !== "active") {
        throw new ConflictError(
          `EnterpriseTemplate ${input.template_id} was revoked after this workspace adopted it`,
        );
      }
      const item = this.memory.items.getById(scope, existing.item_id);
      if (item === undefined) {
        throw new NotFoundError("MemoryItem", existing.item_id);
      }
      return { adoption: existing, item, existing: true };
    }
    const evidenceClass = version.evidence_classes[0];
    if (evidenceClass === undefined) {
      throw new ValidationError("enterprise template version carries no evidence class");
    }

    const created = this.memory.items.create(scope, {
      kind: version.kind,
      scope: version.scope,
      statement: version.statement,
      preconditions: version.preconditions,
      // `trust` carries the enterprise-template provenance; the provenance
      // record itself cannot name the source workspace and does not.
      provenance: {
        author_type: "system",
        config_digest: `enterprise-template:${input.template_id}@${input.template_version}`,
      },
      trust: "enterprise_template",
      sensitivity: version.sensitivity,
      valid_to: null,
      source_run_id: null,
    });
    this.memory.evidence.add(scope, created.item.id, {
      evidence_type: evidenceClass,
      reference: `enterprise-template:${input.template_id}@${input.template_version}`,
    });
    this.memory.items.setStatus(scope, created.item.id, "candidate", created.item.current_version);

    let adoption: EnterpriseTemplateAdoption;
    try {
      adoption = this.store.createAdoption({
        enterprise_id: scope.enterprise_id,
        actor_id: scope.actor_id,
        template_id: input.template_id,
        template_version: input.template_version,
        workspace_id: scope.workspace_id,
        item_id: created.item.id,
        item_version: created.item.current_version,
      });
    } catch (error) {
      // The adoption row is the durable claim. If it cannot be written (e.g. a
      // concurrent identical adoption won), remove the orphan candidate so the
      // workspace is not left with an untracked item.
      try {
        this.memory.items.deleteItem(scope, created.item.id);
      } catch {
        // Best effort only; the original error is authoritative.
      }
      throw error;
    }
    this.store.recordEvent({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      template_id: input.template_id,
      template_version: input.template_version,
      event_type: "template_adopted",
      actor_id: scope.actor_id,
      detail: { item_id: adoption.item_id, evidence_class: evidenceClass },
    });
    const item = this.memory.items.getById(scope, adoption.item_id);
    if (item === undefined) {
      throw new NotFoundError("MemoryItem", adoption.item_id);
    }
    return { adoption, item, existing: false };
  }

  revoke(
    scope: WorkspaceScope,
    input: RevokeEnterpriseTemplateInput,
  ): RevokeEnterpriseTemplateResult {
    requireEnterpriseAdmin(this.identity, scope.enterprise_id, scope.actor_id);
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new ValidationError("revocation requires a recorded reason");
    }
    const reason = input.reason.trim();
    const template = this.store.getTemplate(scope.enterprise_id, input.template_id);
    if (template === undefined) {
      throw new NotFoundError("EnterpriseTemplate", input.template_id);
    }
    if (template.status !== "published") {
      throw new ConflictError(`EnterpriseTemplate ${input.template_id} is already revoked`);
    }
    this.store.markRevoked({
      enterprise_id: scope.enterprise_id,
      template_id: input.template_id,
      actor_id: scope.actor_id,
      expected_version: template.current_version,
      reason,
    });

    const outcomes: Partial<Record<AdoptionRevocationOutcome, number>> = {};
    // Page through every adoption so a large enterprise is not partially
    // revoked. Rows are never deleted, so rowid pagination is stable while
    // their state changes.
    let offset = 0;
    for (;;) {
      const page = this.store.listAdoptionsByTemplate(
        scope.enterprise_id,
        input.template_id,
        REVOCATION_PAGE_SIZE,
        offset,
      );
      for (const adoption of page) {
        if (adoption.state !== "active") {
          continue;
        }
        const outcome = this.deprecateAdoptedCopy(scope, adoption);
        // Mark first, then audit: the adoption row is what blocks a second
        // revocation pass from acting on the same copy.
        this.store.markAdoptionRevoked({
          enterprise_id: scope.enterprise_id,
          adoption_id: adoption.id,
          actor_id: scope.actor_id,
          reason,
          outcome,
        });
        this.store.recordEvent({
          enterprise_id: scope.enterprise_id,
          workspace_id: adoption.workspace_id,
          template_id: input.template_id,
          template_version: adoption.template_version,
          event_type:
            outcome === "deprecated" || outcome === "already_deprecated"
              ? "adoption_deprecated"
              : "adoption_revocation_skipped",
          actor_id: scope.actor_id,
          detail: { outcome, item_id: adoption.item_id },
        });
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      }
      if (page.length < REVOCATION_PAGE_SIZE) {
        break;
      }
      offset += page.length;
    }

    const revoked = this.store.getTemplate(scope.enterprise_id, input.template_id);
    if (revoked === undefined) {
      throw new NotFoundError("EnterpriseTemplate", input.template_id);
    }
    return {
      template: revoked,
      adoptions: this.store.listAdoptionsByTemplate(scope.enterprise_id, input.template_id),
      outcomes,
    };
  }

  listAdoptions(scope: WorkspaceScope): EnterpriseTemplateAdoption[] {
    requireWorkspaceReader(this.controlPlane, this.identity, scope);
    return this.store.listAdoptionsByWorkspace(scope.enterprise_id, scope.workspace_id);
  }

  listTemplateAdoptions(
    scope: WorkspaceScope,
    templateId: EnterpriseTemplateId,
  ): EnterpriseTemplateAdoption[] {
    requireEnterpriseAdmin(this.identity, scope.enterprise_id, scope.actor_id);
    if (this.store.getTemplate(scope.enterprise_id, templateId) === undefined) {
      throw new NotFoundError("EnterpriseTemplate", templateId);
    }
    return this.store.listAdoptionsByTemplate(scope.enterprise_id, templateId);
  }

  listEnterpriseEvents(scope: WorkspaceScope): EnterpriseTemplateEvent[] {
    requireEnterpriseAdmin(this.identity, scope.enterprise_id, scope.actor_id);
    return this.store.listEnterpriseEvents(scope.enterprise_id);
  }

  listWorkspaceEvents(scope: WorkspaceScope): EnterpriseTemplateEvent[] {
    requireWorkspaceReader(this.controlPlane, this.identity, scope);
    return this.store.listWorkspaceEvents(scope.enterprise_id, scope.workspace_id);
  }

  private recordFor(template: EnterpriseTemplate): EnterpriseTemplateRecord {
    const current = this.store.getVersion(
      template.enterprise_id,
      template.id,
      template.current_version,
    );
    if (current === undefined) {
      throw new NotFoundError(
        "EnterpriseTemplateVersion",
        `${template.id}#${template.current_version}`,
      );
    }
    return { template, current };
  }

  private resolveSecurityReview(
    scope: EnterpriseScope & { workspace_id?: string },
    input: PublishEnterpriseTemplateInput,
    kind: EnterpriseTemplateKind,
  ): TemplateSecurityReview | null {
    if (!requiresSecurityReview(kind)) {
      return null;
    }
    const review = input.security_review;
    if (review === undefined) {
      throw new ValidationError(
        `procedural template kind ${kind} requires a named security review before publication`,
      );
    }
    if (typeof review.reviewer_id !== "string" || review.reviewer_id.length === 0) {
      throw new ValidationError("security review requires a reviewer id");
    }
    if (review.reviewer_id === scope.actor_id) {
      throw new ValidationError("the publisher cannot security-review their own template");
    }
    requireEnterpriseAdmin(this.identity, scope.enterprise_id, review.reviewer_id);
    return {
      reviewer_id: review.reviewer_id,
      reviewed_at: normalizeReviewTimestamp(review.reviewed_at),
    };
  }

  private deprecateAdoptedCopy(
    scope: WorkspaceScope,
    adoption: EnterpriseTemplateAdoption,
  ): AdoptionRevocationOutcome {
    const localScope: WorkspaceScope = {
      enterprise_id: scope.enterprise_id,
      workspace_id: adoption.workspace_id,
      actor_id: scope.actor_id,
    };
    let record: MemoryItemRecord | undefined;
    try {
      record = this.memory.items.getById(localScope, adoption.item_id);
    } catch {
      return "item_missing";
    }
    if (record === undefined) {
      return "item_missing";
    }
    const status: MemoryStatus = record.item.status;
    if (status === "deprecated") {
      return "already_deprecated";
    }
    if (status === "quarantined") {
      return "quarantined_untouched";
    }
    if (status === "retired") {
      return "retired_untouched";
    }
    try {
      this.memory.items.setStatus(
        localScope,
        adoption.item_id,
        "deprecated",
        record.item.current_version,
      );
      return "deprecated";
    } catch {
      // Concurrent change or an unexpected transition: report it rather than
      // pretending the copy was deprecated. The template itself is revoked, so
      // no new adoption can appear.
      return "deprecation_failed";
    }
  }
}

/**
 * Optional collaborators. Production uses the defaults, both built over `db`;
 * tests inject wrappers to force an interleaving at a specific step.
 */
export interface EnterpriseTemplateServiceOptions {
  store?: EnterpriseTemplateStore;
  memory?: MemoryRepositories;
}

/**
 * Build the template service over one control-plane database. The memory
 * repositories are created here so callers cannot pass a differently scoped
 * memory store than the one the service audits.
 */
export function createEnterpriseTemplateService(
  db: ControlPlaneDb,
  options: EnterpriseTemplateServiceOptions = {},
): EnterpriseTemplateService {
  return new DefaultEnterpriseTemplateService(
    db,
    options.store ?? createEnterpriseTemplateStore(db),
    options.memory ?? createMemoryRepositories(db),
  );
}
