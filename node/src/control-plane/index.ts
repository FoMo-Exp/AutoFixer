/**
 * Control-plane public API.
 *
 * Re-exports the types, errors, and factory functions that handlers and
 * services consume. The raw database handle stays inside the repository
 * implementations — handlers receive only the repository interfaces.
 */

export type { ControlPlaneDb, OpenOptions } from "./db.js";
export { migrate, newId, nowIso, openControlPlaneDb } from "./db.js";

export {
  ConflictError,
  ControlPlaneError,
  NotFoundError,
  RequestScopeError,
  ScopeError,
  ValidationError,
  VersionConflictError,
} from "./errors.js";
export type { RequestScopeErrorCode } from "./errors.js";

export type {
  ControlPlaneRepositories,
  EnterpriseRepository,
  MembershipRepository,
  ProviderInstanceRepository,
  TeamRepository,
  WorkspaceRepository,
} from "./repositories.js";
export { createRepositories } from "./repositories.js";

export type {
  AuthenticatedPrincipal,
  RequestScopeDeps,
  ResolvedRequestScope,
  SessionContextLike,
} from "./request-scope.js";
export { principalFromSession, resolveRequestScope } from "./request-scope.js";

export type {
  CreateEnterpriseInput,
  CreateMembershipInput,
  CreateProviderInstanceInput,
  CreateTeamInput,
  CreateWorkspaceInput,
  Enterprise,
  EnterpriseId,
  EnterpriseScope,
  Membership,
  MembershipId,
  ProviderInstance,
  ProviderInstanceId,
  ProviderType,
  Team,
  TeamId,
  TransferWorkspaceInput,
  UpdateEnterpriseInput,
  UpdateMembershipInput,
  UpdateTeamInput,
  UpdateWorkspaceInput,
  UserId,
  Workspace,
  WorkspaceId,
  WorkspaceRole,
  WorkspaceScope,
  WorkspaceStatus,
} from "./types.js";

export type {
  SeedEnterpriseInput,
  SeedProviderInput,
  SeedResult,
  SeedWorkspaceInput,
} from "./seed.js";
export { seedEnterprise, seedProviderInstance, seedWorkspace } from "./seed.js";

export type {
  AppendAuthAuditInput,
  AppUser,
  AuthActorKind,
  AuthAuditFilter,
  AuthAuditRecord,
  AuthSession,
  CreateDesktopFlowInput,
  CreateIdentityInput,
  CreateOauthFlowInput,
  CreateSessionInput,
  CreateUserInput,
  DesktopAuthFlow,
  DesktopFlowStatus,
  EnterpriseRole,
  EnterpriseRoleName,
  GrantEnterpriseRoleInput,
  LoginProvider,
  OauthFlow,
  SessionKind,
  UserIdentity,
  UserStatus,
} from "./identity-types.js";

export type {
  CreateInvitationInput,
  Invitation,
  InvitationDenialReason,
  InvitationEvaluationInput,
  InvitationId,
  InvitationRedemptionDenied,
  InvitationRedemptionOutcome,
  InvitationRedemptionSuccess,
  InvitationRole,
  InvitationStatus,
} from "./invitation-types.js";

export type {
  InvitationRepository,
  RedemptionDecision,
  RedemptionFacts,
  RepositoryAccessFact,
} from "./invitation-repositories.js";
export {
  createInvitationRepository,
  evaluateRedemption,
  hasCurrentRepositoryAccess,
} from "./invitation-repositories.js";

export type {
  AuthAuditRepository,
  DesktopFlowRepository,
  EnterpriseRoleRepository,
  IdentityRepositories,
  IdentityRepository,
  LoginProviderDirectory,
  OauthFlowRepository,
  SessionRepository,
  UserRepository,
} from "./identity-repositories.js";
export { createIdentityRepositories, hashToken, secretEquals } from "./identity-repositories.js";

export type {
  CapabilityGrantRepository,
  ProviderAccessRepositories,
  ProviderEventRepository,
  ProviderRosterRepository,
  ReconcileRunRepository,
  ServiceIntegrationRepository,
} from "./provider-access-repositories.js";
export { createProviderAccessRepositories } from "./provider-access-repositories.js";

export type {
  AppendProviderEventInput,
  AuthorityState,
  CapabilityGrant,
  CapabilityKind,
  CreateCapabilityGrantInput,
  CreateServiceIntegrationInput,
  FinishReconcileRunInput,
  InstallStatus,
  NormalizedRoleRow,
  PermissionVisibility,
  ProviderEvent,
  ProviderEventType,
  ProviderMemberRole,
  ProviderRoleSourceKind,
  ReconcileRun,
  ReconcileRunStatus,
  RenameIntegrationInput,
  ReplaceRosterInput,
  ServiceIntegration,
  ServiceIntegrationId,
  SetInstallStatusInput,
  StartReconcileRunInput,
  SubjectAuthority,
  TransferIntegrationInput,
} from "./provider-access-types.js";
