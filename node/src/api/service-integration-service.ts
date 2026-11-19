/**
 * Administrator-controlled service-integration initialization (DAT-267).
 *
 * DAT-260's real acceptance previously required writing a `service_integration`
 * row by hand. This surface is the smallest controlled replacement: an
 * enterprise administrator (or the deployment) can initialize, read, and
 * deactivate the workspace's one active repository-scoped integration.
 *
 * Three rules are structural rather than conventions:
 *
 * - **Binding comes from the workspace.** The provider instance and the
 *   immutable repository id are read from the workspace row and its approved
 *   provider instance; the request cannot name either. A repository/provider
 *   mismatch is refused, never coerced.
 * - **References only.** The request carries credential *references*; secret
 *   values are never accepted, returned, or written to the audit trail. The
 *   response exposes presence flags, not the references themselves, so a
 *   read cannot be used to exfiltrate configuration.
 * - **Audit and mutation commit together.** The audit record and the row
 *   change run in one transaction, so a failed audit write leaves no
 *   integration behind and cannot be reported as success.
 *
 * Deactivation sets `install_status = 'uninstalled'`. That row remains the
 * workspace's authority marker: the request boundary sees it and fails closed,
 * exactly as it does for a suspended integration. Re-initialization creates a
 * new row once the uniqueness guard no longer applies.
 */

import type { AuthAuditRepository } from "../control-plane/identity-repositories.js";
import type { EnterpriseRoleRepository } from "../control-plane/identity-repositories.js";
import type {
  ProviderInstanceRepository,
  WorkspaceRepository,
} from "../control-plane/repositories.js";
import type {
  EnterpriseId,
  ProviderInstance,
  UserId,
  Workspace,
  WorkspaceScope,
} from "../control-plane/types.js";
import type { ServiceIntegrationRepository } from "../control-plane/provider-access-repositories.js";
import type {
  PermissionVisibility,
  ServiceIntegration,
} from "../control-plane/provider-access-types.js";
import type { ControlPlaneDb } from "../control-plane/db.js";
import { runInTransaction } from "../control-plane/db.js";
import { ConflictError } from "../control-plane/errors.js";
import {
  InvalidRepositoryIdError,
  parseCanonicalRepositoryId,
  type CanonicalRepositoryId,
} from "../provider-access/canonical-repository.js";
import type { ServiceCredentialStore } from "../provider-access/credentials.js";
import { permissionVisibilityForProvider } from "../provider-access/permission-visibility.js";
import { SYSTEM_ACTOR, type AdminActor } from "./auth-service.js";
import { ApiError } from "./errors.js";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/**
 * Administrator-visible view. Credential *references* are deliberately absent:
 * `credentials` reports which capabilities are configured, which is all an
 * operator needs to verify an installation without disclosing infrastructure
 * identifiers to every administrator session.
 */
export interface ServiceIntegrationView {
  id: string;
  enterprise_id: string;
  workspace_id: string;
  provider_instance_id: string;
  repository_id: string;
  repository_name: string;
  install_status: ServiceIntegration["install_status"];
  permission_visibility: PermissionVisibility;
  credentials: {
    source: boolean;
    checkout: boolean;
    delivery: boolean;
  };
  version: number;
  created_at: string;
  updated_at: string;
}

export interface InitializeServiceIntegrationInput {
  source_credential_ref: string;
  checkout_credential_ref?: string;
  delivery_credential_ref?: string;
}

export interface InitializeResult {
  created: boolean;
  integration: ServiceIntegrationView;
}

export interface ServiceIntegrationService {
  /** The workspace's active integration; 404 when none is active. */
  get(actor: AdminActor, enterpriseId: string, workspaceId: string): ServiceIntegrationView;
  /**
   * Create the active integration. An identical retry returns the existing
   * row with `created: false`; a different configuration is a 409 — the
   * request cannot silently overwrite credentials an operator already
   * installed.
   */
  initialize(
    actor: AdminActor,
    enterpriseId: string,
    workspaceId: string,
    input: InitializeServiceIntegrationInput,
  ): InitializeResult;
  /** Idempotent deactivation: no active integration is already the goal state. */
  deactivate(actor: AdminActor, enterpriseId: string, workspaceId: string): void;
}

export interface ServiceIntegrationServiceDeps {
  db: ControlPlaneDb;
  enterpriseId: EnterpriseId;
  workspaces: WorkspaceRepository;
  providerInstances: ProviderInstanceRepository;
  enterpriseRoles: EnterpriseRoleRepository;
  integrations: ServiceIntegrationRepository;
  /** Existence checks only; secret values never leave the boundary. */
  credentials: ServiceCredentialStore;
  audit: Pick<AuthAuditRepository, "append">;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A credential reference is an opaque name inside the server credential
 * boundary: no whitespace, no control characters, no scheme or path escapes.
 * The shape is intentionally narrow so a pasted token is rejected by
 * construction.
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * Well-known provider token prefixes. A value with one of these is secret
 * material being submitted as a reference; refuse it before it can reach the
 * database or an audit record.
 */
const SECRET_LIKE_REFERENCE = /^(gh[pousr]_|github_pat_|glpat-|xox[abposr]-)/i;

const CREDENTIAL_REF_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  source_credential_ref: true,
  checkout_credential_ref: true,
  delivery_credential_ref: true,
});

function requireCredentialRef(field: string, value: string): string {
  if (
    value.length === 0 ||
    value.length > 200 ||
    !CREDENTIAL_REF_PATTERN.test(value) ||
    SECRET_LIKE_REFERENCE.test(value)
  ) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      `${field} must be a credential reference (1-200 characters: letters, digits, . _ : / -), never a secret value`,
    );
  }
  return value;
}

function optionalCredentialRef(field: string, value: string | undefined): string | null {
  return value === undefined ? null : requireCredentialRef(field, value);
}

/** Only credential-reference fields are accepted; bindings cannot be supplied. */
export function assertInitializeFields(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (CREDENTIAL_REF_FIELDS[key] !== true) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `${key} is not accepted; the repository and provider instance come from the workspace, and visibility from the provider adapter`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Internal signal: the audit write failed, so the transaction was rolled back. */
class AuditUnavailableError extends Error {
  constructor() {
    super("the audit trail is unavailable");
    this.name = "AuditUnavailableError";
  }
}

interface Binding {
  workspace: Workspace;
  provider: ProviderInstance;
  repository: CanonicalRepositoryId;
}

function toView(row: ServiceIntegration): ServiceIntegrationView {
  return {
    id: row.id,
    enterprise_id: row.enterprise_id,
    workspace_id: row.workspace_id,
    provider_instance_id: row.provider_instance_id,
    repository_id: row.repository_id,
    repository_name: row.repository_name,
    install_status: row.install_status,
    permission_visibility: row.permission_visibility,
    credentials: {
      source: row.source_credential_ref.length > 0,
      checkout: row.checkout_credential_ref !== null,
      delivery: row.delivery_credential_ref !== null,
    },
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sameConfiguration(
  row: ServiceIntegration,
  providerInstanceId: string,
  repositoryId: string,
  refs: { source: string; checkout: string | null; delivery: string | null },
): boolean {
  return (
    row.provider_instance_id === providerInstanceId &&
    row.repository_id === repositoryId &&
    row.source_credential_ref === refs.source &&
    row.checkout_credential_ref === refs.checkout &&
    row.delivery_credential_ref === refs.delivery
  );
}

export function createServiceIntegrationService(
  deps: ServiceIntegrationServiceDeps,
): ServiceIntegrationService {
  function assertAdmin(actor: AdminActor, enterpriseId: EnterpriseId): UserId {
    if (actor.kind === "deployment") {
      return SYSTEM_ACTOR;
    }
    const role = deps.enterpriseRoles.getByUser(enterpriseId, actor.user_id);
    if (role?.role !== "admin") {
      // Denial is recorded best effort: an audit failure must not turn a
      // considered 403 into a different outcome.
      try {
        deps.audit.append({
          event: "admin.denied",
          enterprise_id: enterpriseId,
          actor_kind: "user",
          actor_user_id: actor.user_id,
          details: { action: "service_integration" },
        });
      } catch {
        // The authorization decision stands regardless of the audit write.
      }
      throw new ApiError(
        403,
        "FORBIDDEN",
        "administrator authority in this enterprise is required",
      );
    }
    return actor.user_id;
  }

  /**
   * Resolve the authoritative binding. Unknown and foreign-enterprise
   * workspaces are one indistinguishable 404; a corrupt or unapproved binding
   * is a 409 because the workspace exists but cannot carry an integration.
   */
  function resolveBinding(actorId: UserId, enterpriseId: string, workspaceId: string): Binding {
    if (enterpriseId !== deps.enterpriseId) {
      throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
    }
    const scope = { enterprise_id: enterpriseId, actor_id: actorId };
    const workspace = deps.workspaces.getById(scope, workspaceId);
    if (workspace === undefined || workspace.enterprise_id !== enterpriseId) {
      throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
    }
    if (workspace.status !== "active") {
      throw new ApiError(
        409,
        "WORKSPACE_ARCHIVED",
        "an archived workspace cannot carry a service integration",
      );
    }
    const provider = deps.providerInstances.getById(scope, workspace.provider_instance_id);
    if (provider === undefined) {
      throw new ApiError(
        409,
        "SERVICE_INTEGRATION_BINDING_INVALID",
        "The workspace's provider instance is not registered for this enterprise",
      );
    }
    let repository: CanonicalRepositoryId;
    try {
      repository = parseCanonicalRepositoryId(workspace.repository_id);
    } catch (error) {
      if (error instanceof InvalidRepositoryIdError) {
        throw new ApiError(
          409,
          "SERVICE_INTEGRATION_BINDING_INVALID",
          "The workspace's repository binding is not a canonical provider repository id",
        );
      }
      throw error;
    }
    if (repository.provider !== provider.provider_type) {
      throw new ApiError(
        409,
        "SERVICE_INTEGRATION_BINDING_INVALID",
        "The workspace's repository binding does not match its provider instance",
      );
    }
    return { workspace, provider, repository };
  }

  function scopeOf(workspaceId: string, actorId: UserId): WorkspaceScope {
    return {
      enterprise_id: deps.enterpriseId,
      workspace_id: workspaceId,
      actor_id: actorId,
    };
  }

  function activeIntegration(workspaceId: string, actorId: UserId): ServiceIntegration | undefined {
    return deps.integrations
      .listByWorkspace(scopeOf(workspaceId, actorId))
      .filter((row) => row.install_status === "active")
      .at(-1);
  }

  function appendAuditOrThrow(input: Parameters<AuthAuditRepository["append"]>[0]): void {
    try {
      deps.audit.append(input);
    } catch {
      throw new AuditUnavailableError();
    }
  }

  function mapAuditFailure(error: unknown): never {
    if (error instanceof AuditUnavailableError) {
      throw new ApiError(
        503,
        "SERVICE_INTEGRATION_AUDIT_UNAVAILABLE",
        "The integration was not changed because the audit trail is unavailable.",
      );
    }
    throw error;
  }

  return {
    get(actor, enterpriseId, workspaceId) {
      if (enterpriseId !== deps.enterpriseId) {
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      }
      const actorId = assertAdmin(actor, enterpriseId);
      const { workspace } = resolveBinding(actorId, enterpriseId, workspaceId);
      const integration = activeIntegration(workspace.id, actorId);
      if (integration === undefined) {
        throw new ApiError(
          404,
          "SERVICE_INTEGRATION_NOT_FOUND",
          "This workspace has no active service integration",
        );
      }
      return toView(integration);
    },

    initialize(actor, enterpriseId, workspaceId, input) {
      if (enterpriseId !== deps.enterpriseId) {
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      }
      const actorId = assertAdmin(actor, enterpriseId);
      const { workspace, provider, repository } = resolveBinding(
        actorId,
        enterpriseId,
        workspaceId,
      );
      const source = requireCredentialRef("source_credential_ref", input.source_credential_ref);
      const checkout = optionalCredentialRef(
        "checkout_credential_ref",
        input.checkout_credential_ref,
      );
      const delivery = optionalCredentialRef(
        "delivery_credential_ref",
        input.delivery_credential_ref,
      );
      for (const [field, value] of [
        ["source_credential_ref", source],
        ["checkout_credential_ref", checkout],
        ["delivery_credential_ref", delivery],
      ] as const) {
        if (value !== null && !deps.credentials.has(value)) {
          // An integration whose credential cannot be resolved would fail
          // closed at every use; refuse it here instead of recording a
          // reference the deployment cannot serve. The submitted value is
          // never echoed.
          throw new ApiError(
            400,
            "INVALID_REQUEST",
            `${field} does not resolve in the server credential boundary`,
          );
        }
      }

      const existing = activeIntegration(workspace.id, actorId);
      if (existing !== undefined) {
        if (
          sameConfiguration(existing, provider.id, repository.canonical, {
            source,
            checkout,
            delivery,
          })
        ) {
          return { created: false, integration: toView(existing) };
        }
        throw new ApiError(
          409,
          "SERVICE_INTEGRATION_EXISTS",
          "This workspace already has a service integration with a different configuration; deactivate it before installing another",
          { integration_id: existing.id },
        );
      }

      const visibility = permissionVisibilityForProvider(provider.provider_type);
      let created: ServiceIntegration;
      try {
        created = runInTransaction(deps.db, () => {
          const row = deps.integrations.create(scopeOf(workspace.id, actorId), {
            provider_instance_id: provider.id,
            repository_id: repository.canonical,
            repository_name: repository.path,
            source_credential_ref: source,
            ...(checkout !== null ? { checkout_credential_ref: checkout } : {}),
            ...(delivery !== null ? { delivery_credential_ref: delivery } : {}),
            permission_visibility: visibility,
            actor_id: actorId,
          });
          appendAuditOrThrow({
            event: "service_integration.initialized",
            enterprise_id: enterpriseId,
            actor_kind: actor.kind,
            ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
            provider_instance_id: provider.id,
            details: {
              integration_id: row.id,
              repository_id: repository.canonical,
              permission_visibility: visibility,
              credentials: {
                source: true,
                checkout: checkout !== null,
                delivery: delivery !== null,
              },
            },
          });
          return row;
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          // A concurrent initialization won the unique guard. An identical
          // request is a replay of the same intent; anything else conflicts.
          const raced = activeIntegration(workspace.id, actorId);
          if (
            raced !== undefined &&
            sameConfiguration(raced, provider.id, repository.canonical, {
              source,
              checkout,
              delivery,
            })
          ) {
            return { created: false, integration: toView(raced) };
          }
          throw new ApiError(
            409,
            "SERVICE_INTEGRATION_EXISTS",
            "This workspace already has a service integration with a different configuration; deactivate it before installing another",
          );
        }
        mapAuditFailure(error);
      }
      return { created: true, integration: toView(created) };
    },

    deactivate(actor, enterpriseId, workspaceId) {
      if (enterpriseId !== deps.enterpriseId) {
        throw new ApiError(404, "NOT_FOUND", "Workspace was not found");
      }
      const actorId = assertAdmin(actor, enterpriseId);
      const { workspace } = resolveBinding(actorId, enterpriseId, workspaceId);
      const existing = activeIntegration(workspace.id, actorId);
      if (existing === undefined) {
        // Replay after a successful deactivation: the goal state already holds.
        return;
      }
      try {
        runInTransaction(deps.db, () => {
          const row = deps.integrations.setStatus(
            scopeOf(workspace.id, actorId),
            existing.id,
            { install_status: "uninstalled", actor_id: actorId },
            existing.version,
          );
          appendAuditOrThrow({
            event: "service_integration.deactivated",
            enterprise_id: enterpriseId,
            actor_kind: actor.kind,
            ...(actor.kind === "user" ? { actor_user_id: actor.user_id } : {}),
            provider_instance_id: existing.provider_instance_id,
            details: {
              integration_id: row.id,
              repository_id: existing.repository_id,
            },
          });
        });
      } catch (error) {
        mapAuditFailure(error);
      }
    },
  };
}
