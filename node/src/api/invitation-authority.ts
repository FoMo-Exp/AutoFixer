/**
 * Invitation eligibility's point refresh (DAT-204 consumer of DAT-247).
 *
 * Invitation redemption must verify the invitee's *current* repository
 * access, not a fact observed at login time. The single source of truth is
 * DAT-203's `subject_authority` store, produced by the repository-scoped
 * service integration — never by a user OAuth token and never by a second,
 * parallel fact table.
 *
 * This module is the consumer side of that contract. Immediately before the
 * redemption transaction it asks DAT-247's {@link refreshSubjectAuthority}
 * about exactly one subject, using the integration's own service credential.
 * The refresh writes (or removes) authority through the DAT-203 store, so the
 * transaction that follows re-reads a fact from this moment:
 *
 * - provider says the subject has a permission → `active`, verified now;
 * - provider says "not a collaborator/member" (404) → `removed`;
 * - provider cannot answer, lacks scope, is rate limited, or the workspace
 *   has no active integration / no linked identity → the refresh throws and
 *   the caller denies the join. Nothing is written on a failed verification.
 */

import type {
  IdentityRepository,
  ProviderAccessRepositories,
  ProviderInstanceRepository,
  ServiceIntegration,
  UserId,
  Workspace,
  WorkspaceScope,
} from "../control-plane/index.js";
import { createIntegrationAdapter } from "../provider-access/adapters/index.js";
import type { AuthorityEpoch } from "../provider-access/access-gate.js";
import type { ServiceCredentialStore } from "../provider-access/credentials.js";
import { refreshSubjectAuthority } from "../provider-access/subject-refresh.js";
import { MissingPermissionError } from "../provider-access/types.js";

export interface InvitationAuthorityDeps {
  access: ProviderAccessRepositories;
  identities: IdentityRepository;
  providerInstances: ProviderInstanceRepository;
  /** DAT-247's service credential boundary; never a user OAuth token. */
  credentials: ServiceCredentialStore;
  /** Shared authority-change signal; a successful refresh bumps it. */
  epoch: AuthorityEpoch;
  clock?: () => Date;
  /** Test/deployment override of the provider API base (fake provider). */
  apiBaseUrl?: (integration: ServiceIntegration) => string | undefined;
  /** Scopes the service credential actually holds, when the deployment knows. */
  availableTokenScope?: readonly string[];
}

export interface InvitationAuthority {
  /**
   * Refresh the invitee's repository authority for the workspace's active
   * integration. Throws when the refresh cannot run — callers fail closed.
   */
  refreshFor(scope: WorkspaceScope, workspace: Workspace, userId: UserId): Promise<void>;
}

export function createInvitationAuthority(deps: InvitationAuthorityDeps): InvitationAuthority {
  return {
    async refreshFor(scope, workspace, userId): Promise<void> {
      const integration = deps.access.integrations
        .listByWorkspace(scope)
        .find(
          (candidate) =>
            candidate.install_status === "active" &&
            candidate.provider_instance_id === workspace.provider_instance_id,
        );
      if (integration === undefined) {
        // No repository-scoped integration means there is nothing to verify
        // current access against. Denying is the only safe answer.
        throw new MissingPermissionError(
          "visibility",
          "workspace has no active repository-scoped integration",
        );
      }
      const identity = deps.identities
        .listByUser(userId)
        .find((candidate) => candidate.provider_instance_id === integration.provider_instance_id);
      if (identity === undefined) {
        throw new MissingPermissionError(
          "permission_query",
          "invitee has no linked identity on the workspace's provider instance",
        );
      }
      const instance = deps.providerInstances.getById(
        { enterprise_id: scope.enterprise_id, actor_id: scope.actor_id },
        integration.provider_instance_id,
      );
      if (instance === undefined) {
        throw new MissingPermissionError(
          "visibility",
          "workspace integration references a missing provider instance",
        );
      }
      const baseUrl = deps.apiBaseUrl?.(integration);
      const adapter = createIntegrationAdapter({
        integration,
        canonical_repository_id: integration.repository_id,
        credentials: deps.credentials,
        provider_origin: instance.origin_url,
        resolve_login: (subject) =>
          deps.identities.getByProviderSubject(integration.provider_instance_id, subject)?.login,
        ...(baseUrl !== undefined ? { api_base_url: baseUrl } : {}),
      });
      await refreshSubjectAuthority(
        {
          access: deps.access,
          epoch: deps.epoch,
          identities: deps.identities,
          ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
          ...(deps.availableTokenScope !== undefined
            ? { available_token_scope: deps.availableTokenScope }
            : {}),
        },
        scope,
        integration,
        adapter,
        identity.subject,
      );
    },
  };
}
