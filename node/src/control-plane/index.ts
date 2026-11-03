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
  ScopeError,
  ValidationError,
  VersionConflictError,
} from "./errors.js";

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
