/**
 * Per-subject authority refresh and the authority read model DAT-204 consumes
 * (DAT-247).
 *
 * Periodic reconciliation is the batch path; sensitive actions need the same
 * truth *for one subject* at the moment of the action. {@link refreshSubjectAuthority}
 * is that point refresh: it asks the provider about exactly one subject and
 * writes the result through the DAT-203 authority store.
 *
 * Semantics are deliberately different per provider answer:
 *
 * - provider says the subject has a permission → authority `active`, verified
 *   now (what makes a sensitive action pass immediately afterwards);
 * - provider says "no such collaborator/member" (404) → authority `removed`
 *   and capability grants revoked, exactly like a reconcile diff;
 * - provider cannot be asked (missing scope/permission), is rate limited, or
 *   fails → the call throws and **nothing is written**. A failed verification
 *   is not evidence of removal.
 */

import type { IdentityRepository } from "../control-plane/identity-repositories.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { AuthorityState, ServiceIntegration } from "../control-plane/provider-access-types.js";
import type { UserId, WorkspaceId, WorkspaceScope } from "../control-plane/types.js";
import { fetchEffectivePermission } from "./adapter.js";
import type { AuthorityEpoch } from "./access-gate.js";
import { normalizeRole } from "./normalize.js";
import { revokeAuthority, type RevocationEffects } from "./revocation.js";
import type {
  ProviderAdapter,
  ProviderCallContext,
  RawProviderRole,
  RepositoryRef,
} from "./types.js";

const DEFAULT_FRESH_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SubjectRefreshDeps {
  access: ProviderAccessRepositories;
  epoch: AuthorityEpoch;
  /** Identity linking: (provider instance, subject) → app user. */
  identities?: IdentityRepository;
  clock?: () => Date;
  /** Scopes the service credential actually holds; checked before the call. */
  available_token_scope?: readonly string[];
}

export interface SubjectRefreshResult {
  subject: string;
  /** Post-refresh authority state (`absent` when no row was ever recorded). */
  state: AuthorityState | "absent";
  /** The provider's row, when it reported a permission. */
  role: RawProviderRole | null;
  verified_at: string | null;
  revocation?: RevocationEffects;
}

/**
 * Refresh one subject's effective repository permission from the provider.
 * Throws {@link import("./types.js").MissingPermissionError} and
 * {@link import("./types.js").ProviderUnavailableError} without touching
 * stored authority.
 */
export async function refreshSubjectAuthority(
  deps: SubjectRefreshDeps,
  scope: WorkspaceScope,
  integration: ServiceIntegration,
  adapter: ProviderAdapter,
  subject: string,
  options: { now?: Date; ctx?: Partial<ProviderCallContext> } = {},
): Promise<SubjectRefreshResult> {
  const { access, epoch, identities, clock = () => new Date() } = deps;
  const now = options.now ?? clock();
  const at = now.toISOString();
  const repository: RepositoryRef = {
    repository_id: integration.repository_id,
    repository_name: integration.repository_name,
    provider_type: adapter.provider_type,
  };
  const ctx: ProviderCallContext = {
    enterprise_id: scope.enterprise_id,
    workspace_id: scope.workspace_id,
    integration_id: integration.id,
    ...options.ctx,
  };

  const raw = await fetchEffectivePermission(
    adapter,
    ctx,
    repository,
    subject,
    deps.available_token_scope ? { available_token_scope: deps.available_token_scope } : {},
  );

  if (raw === null) {
    // The provider positively reports no permission. Removal is a real fact
    // here — the query completed.
    const revocation = revokeAuthority(
      access,
      epoch,
      scope,
      {
        integration_id: integration.id,
        subject,
        user_id: access.roster.getAuthority(scope, integration.id, subject)?.user_id ?? null,
      },
      "provider: no effective repository permission",
      at,
    );
    return { subject, state: "removed", role: null, verified_at: at, revocation };
  }

  // Normalization runs before any write: a record that would fabricate
  // authority aborts the refresh.
  const normalized = normalizeRole(adapter.provider_type, raw);
  const identity = identities?.getByProviderSubject(integration.provider_instance_id, subject);
  const userId: UserId | null = identity?.user_id ?? null;
  access.roster.applySnapshot(scope, integration.id, {
    roles: [
      {
        subject: normalized.subject,
        login: normalized.login,
        source_kind: normalized.source_kind,
        provider_role: normalized.provider_role,
        authority_ref: normalized.authority_ref,
        inherited_from: normalized.inherited_from,
      },
    ],
    verified_at: at,
    ...(userId !== null ? { subject_users: { [normalized.subject]: userId } } : {}),
  });
  epoch.bump();

  return { subject, state: "active", role: raw, verified_at: at };
}

// ---------------------------------------------------------------------------
// Authority read model (consumed by invitation redemption and the access gate)
// ---------------------------------------------------------------------------

export interface RepositoryAccessView {
  subject: string;
  state: AuthorityState | "absent";
  last_verified_at: string | null;
  /**
   * `true` only for `active` authority verified inside the freshness window —
   * the exact condition a sensitive action (invitation redemption) needs.
   */
  current: boolean;
  /** `true` when the answer is "we do not know", not "no access". */
  requires_reconciliation: boolean;
}

/**
 * Read the stored authority fact for one subject. Pure read — no provider
 * call, no cache. Callers that need a fresh answer call
 * {@link refreshSubjectAuthority} first (that is what makes redemption
 * fail closed on an unreachable provider rather than pass on an old fact).
 */
export function repositoryAccessFor(
  access: ProviderAccessRepositories,
  scope: WorkspaceScope,
  integrationId: string,
  subject: string,
  options: { now?: Date; fresh_window_ms?: number; stale_after_ms?: number } = {},
): RepositoryAccessView {
  const now = options.now ?? new Date();
  const freshWindowMs = options.fresh_window_ms ?? DEFAULT_FRESH_WINDOW_MS;
  const staleAfterMs = options.stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
  const authority = access.roster.getAuthority(scope, integrationId, subject);
  const state: AuthorityState | "absent" = authority?.state ?? "absent";
  const lastVerifiedAt = authority?.last_verified_at ?? null;
  const verifiedAtMs = lastVerifiedAt === null ? Number.NaN : Date.parse(lastVerifiedAt);
  const ageMs = Number.isNaN(verifiedAtMs)
    ? Number.POSITIVE_INFINITY
    : now.getTime() - verifiedAtMs;

  const current = state === "active" && ageMs <= freshWindowMs;
  const requiresReconciliation =
    state === "absent" || state === "unknown" || state === "stale" || ageMs > staleAfterMs;

  return {
    subject,
    state,
    last_verified_at: lastVerifiedAt,
    current,
    requires_reconciliation: requiresReconciliation,
  };
}

/** Workspace-scoped convenience wrapper for `repositoryAccessFor`. */
export function workspaceRepositoryAccessFor(
  access: ProviderAccessRepositories,
  workspace_id: WorkspaceId,
  enterprise_id: string,
  actor_id: string,
  integrationId: string,
  subject: string,
  options: { now?: Date; fresh_window_ms?: number; stale_after_ms?: number } = {},
): RepositoryAccessView {
  const scope: WorkspaceScope = { enterprise_id, workspace_id, actor_id };
  return repositoryAccessFor(access, scope, integrationId, subject, options);
}
