/**
 * Enterprise template surface (DAT-237): scrubbed publication, explicit
 * workspace adoption as a local candidate, immutable versions, and revocation
 * that deprecates adopted copies without rewriting history.
 *
 * See `docs/contracts/memory-enterprise-templates-v1.md` for the contract.
 */

export {
  assertTemplatePolicyClean,
  lintTemplateContent,
  requiresSecurityReview,
  TemplatePolicyError,
  TEMPLATE_POLICY_RULES,
} from "./policy.js";
export type { TemplatePolicyViolation, TemplatePolicyViolationCode } from "./policy.js";

export {
  MAX_TEMPLATE_PRECONDITION_CHARS,
  MAX_TEMPLATE_PRECONDITIONS,
  MAX_TEMPLATE_STATEMENT_CHARS,
  orderEvidenceClasses,
  scrubTemplateContent,
} from "./scrub.js";
export type { ScrubInput } from "./scrub.js";

export { createEnterpriseTemplateStore } from "./repositories.js";
export type {
  AppendTemplateVersionInput,
  CreateAdoptionInput,
  CreatePublicationInput,
  CreateTemplateInput,
  EnterpriseTemplateStore,
  PublishBundle,
  RecordEventInput,
} from "./repositories.js";

export { createEnterpriseTemplateService } from "./service.js";
export type { EnterpriseTemplateServiceOptions } from "./service.js";

export {
  ENTERPRISE_TEMPLATE_KINDS,
  ENTERPRISE_TEMPLATE_SCHEMA_VERSION,
  PROCEDURAL_TEMPLATE_KINDS,
} from "./types.js";
export type {
  AdoptionRevocationOutcome,
  AdoptionState,
  AdoptEnterpriseTemplateInput,
  AdoptEnterpriseTemplateResult,
  EnterpriseTemplate,
  EnterpriseTemplateAdoption,
  EnterpriseTemplateAdoptionId,
  EnterpriseTemplateEvent,
  EnterpriseTemplateEventId,
  EnterpriseTemplateEventType,
  EnterpriseTemplateId,
  EnterpriseTemplateKind,
  EnterpriseTemplatePublication,
  EnterpriseTemplatePublicationId,
  EnterpriseTemplateRecord,
  EnterpriseTemplateService,
  EnterpriseTemplateStatus,
  EnterpriseTemplateVersion,
  PublishEnterpriseTemplateInput,
  PublishEnterpriseTemplateResult,
  RevokeEnterpriseTemplateInput,
  RevokeEnterpriseTemplateResult,
  ScrubbedTemplateContent,
  ScrubRedactionKind,
  SourceIdentityTerms,
  TemplateScrubReport,
  TemplateSecurityReview,
} from "./types.js";
