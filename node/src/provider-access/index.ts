/**
 * Provider access public API (DAT-203): repository-scoped service
 * integrations, explicit provider role normalization, the effective-access
 * intersection, request-path revocation, provider event sync, periodic
 * reconciliation, and the service credential boundary.
 */

export type {
  ActionKind,
  ActionPolicy,
  AccessDecision,
  DenyReason,
  EffectiveAccessInput,
  NormalizedRosterEntry,
  ProviderAdapter,
  ProviderAdapterCapabilities,
  ProviderCallContext,
  RawProviderRole,
  RepositoryRef,
  RosterPage,
} from "./types.js";
export {
  ACTION_KINDS,
  DEFAULT_ACTION_POLICY,
  IncompleteRosterError,
  MissingPermissionError,
  NormalizationError,
  ProviderIntegrationError,
  ProviderUnavailableError,
  WORKSPACE_ROLE_RANK,
} from "./types.js";

export type { CollectedRoster } from "./adapter.js";
export { collectRoster, fetchEffectivePermission } from "./adapter.js";

export type { EffectiveProviderRole } from "./normalize.js";
export {
  effectiveProviderRole,
  isKnownRole,
  normalizeRole,
  normalizeRoster,
  normalizeRosterFor,
} from "./normalize.js";

export { computeEffectiveAccess } from "./effective-access.js";

export type { AccessGate, AccessGateDeps, AccessRequest, AuthorityEpoch } from "./access-gate.js";
export { AccessDeniedError, createAccessGate, createAuthorityEpoch } from "./access-gate.js";

export type { RevocationEffects, RevocationTarget } from "./revocation.js";
export { revokeAuthority } from "./revocation.js";

export type { EventSyncResult, ReconcileDeps, ReconcileSummary } from "./reconcile.js";
export { applyProviderEvent, reconcileIntegration, ReconcileIncompleteError } from "./reconcile.js";

export type { CapabilityHandle, ServiceCredentialStore } from "./credentials.js";
export {
  createStaticServiceCredentialStore,
  issueCheckoutCapability,
  issueDeliveryCapability,
  readServiceCredentialFile,
  scrubForLog,
  scrubForPiContext,
  scrubForRenderer,
  taskWorkspaceEnv,
  withServiceCredential,
} from "./credentials.js";

// --- Real provider adapters and authority facts (DAT-247) -------------------

export type { CanonicalRepositoryId } from "./canonical-repository.js";
export {
  InvalidRepositoryIdError,
  canonicalRepositoryId,
  githubRepositoryPath,
  gitlabProjectPath,
  parseCanonicalRepositoryId,
} from "./canonical-repository.js";

export type {
  FetchHttpClientOptions,
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResponse,
  RateLimitSnapshot,
} from "./provider-http.js";
export {
  assertProviderStatus,
  assertRateLimitBudget,
  createFetchHttpClient,
  linkHasNext,
  parseJsonArray,
  parseJsonBody,
  readRateLimit,
  retryAfterMs,
} from "./provider-http.js";

export type {
  GitHubAdapterOptions,
  GitLabAdapterOptions,
  IntegrationAdapterOptions,
} from "./adapters/index.js";
export {
  GITHUB_REQUIRED_TOKEN_SCOPE,
  GITLAB_REQUIRED_TOKEN_SCOPE,
  createGitHubAdapter,
  createGitLabAdapter,
  createIntegrationAdapter,
  githubApiBaseUrl,
  gitlabApiBaseUrl,
} from "./adapters/index.js";

export type {
  RepositoryAccessView,
  SubjectRefreshDeps,
  SubjectRefreshResult,
} from "./subject-refresh.js";
export {
  refreshSubjectAuthority,
  repositoryAccessFor,
  workspaceRepositoryAccessFor,
} from "./subject-refresh.js";
