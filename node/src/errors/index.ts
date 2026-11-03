/**
 * Shared error contract for every AutoFixer surface (DAT-226).
 *
 * - `catalog.ts` — the closed code vocabulary with stage, category, retry
 *   policy, authorized next action, and safe texts (agent + human).
 * - `envelope.ts` — the versioned envelope: build, strict validation,
 *   forward migration, localization, and model-facing rendering.
 * - `retry.ts` — service-side retry authority; model hints are ignored.
 * - `diagnostics.ts` — sensitive detail behind a separate access check.
 * - `map.ts` — dsh/gateway/trace code mapping into the shared vocabulary.
 * - `redact.ts` — secret redaction for anything that can reach a reader.
 */
export {
  DENIED_CAPABILITIES,
  ERROR_CATALOG,
  ERROR_CATEGORIES,
  ERROR_STAGES,
  NEXT_ACTIONS,
  errorCodeSpec,
  isErrorCode,
  type DeniedCapability,
  type ErrorCategory,
  type ErrorCode,
  type ErrorCodeSpec,
  type ErrorStage,
  type NextAction,
  type RetryPolicy,
} from "./catalog.js";
export {
  ERROR_ENVELOPE_VERSION,
  ErrorEnvelopeContractError,
  buildErrorEnvelope,
  localizeError,
  migrateErrorEnvelope,
  renderAgentError,
  validateErrorEnvelope,
  type BuildErrorEnvelopeInput,
  type EnvelopeFacts,
  type ErrorEnvelope,
} from "./envelope.js";
export {
  RetryGovernor,
  type RetryDecision,
  type RetryDecisionInput,
  type RetryGovernorOptions,
  type RetryHint,
  type RetryRefusalReason,
} from "./retry.js";
export {
  DiagnosticsVault,
  SensitiveDiagnosticsAccessDenied,
  readSensitiveDiagnostics,
  sealDiagnostics,
  type DiagnosticAccess,
  type SealDiagnosticsInput,
  type SensitiveDiagnostics,
} from "./diagnostics.js";
export {
  mapDshError,
  mapForeignError,
  type ForeignErrorLike,
  type MapErrorOptions,
  type MappedError,
} from "./map.js";
export { REDACTED, redactSensitiveText } from "./redact.js";
