/**
 * Provider event sync and periodic reconciliation (DAT-203).
 *
 * Two sources of truth updates, one state machine:
 *
 * - **Provider events** (`applyProviderEvent`) push individual changes the
 *   moment the provider reports them: removals revoke authority in the same
 *   call, transfers revalidate, renames are metadata only. Events are
 *   idempotent on their delivery id.
 * - **Periodic reconciliation** (`reconcileIntegration`) pulls the complete
 *   roster and diffs it against local state. Only a *complete* roster may
 *   remove members: a missing permission, truncated page, pagination limit,
 *   or exhausted rate limit makes the run `incomplete`, marks authority
 *   `stale` (sensitive actions now require reconciliation), and changes no
 *   roster row. An incomplete roster is an error, never an empty member list.
 */

import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type { IdentityRepository } from "../control-plane/identity-repositories.js";
import type {
  ProviderEvent,
  ProviderEventType,
  ServiceIntegration,
} from "../control-plane/provider-access-types.js";
import type { UserId, WorkspaceScope } from "../control-plane/types.js";
import { collectRoster } from "./adapter.js";
import type { AuthorityEpoch } from "./access-gate.js";
import { normalizeRole, normalizeRoster } from "./normalize.js";
import { revokeAuthority, type RevocationEffects } from "./revocation.js";
import {
  IncompleteRosterError,
  MissingPermissionError,
  NormalizationError,
  ProviderIntegrationError,
  ProviderUnavailableError,
  type ProviderAdapter,
  type ProviderCallContext,
  type RawProviderRole,
  type RepositoryRef,
} from "./types.js";

export interface ReconcileDeps {
  access: ProviderAccessRepositories;
  /** Identity linking: (provider instance, subject) -> app user, never email. */
  identities: IdentityRepository;
  epoch: AuthorityEpoch;
  clock?: () => Date;
  /** Token scopes the service credential actually holds (adapter check). */
  available_token_scope?: readonly string[];
}

export interface ReconcileSummary {
  run_id: string;
  status: "completed" | "incomplete";
  pages_seen: number;
  roster_size: number;
  members_added: number;
  members_removed: number;
  roles_changed: number;
  /**
   * Rows dropped because their provenance key disappeared from a complete
   * roster. Reported here only: the persisted run record tracks provider
   * changes, not this derived cleanup.
   */
  roles_pruned: number;
  authority_reset: number;
  revocations: readonly RevocationEffects[];
  failure_code?: string;
}

/** Raised when a reconcile run could not establish a complete roster. */
export class ReconcileIncompleteError extends ProviderIntegrationError {
  constructor(
    readonly summary: ReconcileSummary,
    cause:
      | IncompleteRosterError
      | MissingPermissionError
      | NormalizationError
      | ProviderUnavailableError,
  ) {
    super(cause.code, `reconciliation incomplete: ${cause.message}`);
  }
}

function markAllStale(
  access: ProviderAccessRepositories,
  scope: WorkspaceScope,
  integrationId: string,
  at: string,
): void {
  for (const authority of access.roster.listAuthority(scope, integrationId)) {
    // `removed` is terminal until a new verification; `unknown` stays unknown.
    if (authority.state === "active") {
      access.roster.setAuthorityState(scope, integrationId, authority.subject, "stale", at);
    }
  }
}

/**
 * Reconcile one integration's roster against the provider.
 *
 * Order of operations is deliberate: verify everyone present first, then
 * revoke everyone absent — so a crash between the two leaves authority
 * stricter (some removed not yet applied), never looser.
 */
export async function reconcileIntegration(
  deps: ReconcileDeps,
  scope: WorkspaceScope,
  integration: ServiceIntegration,
  adapter: ProviderAdapter,
  options: { now?: Date; ctx?: Partial<ProviderCallContext> } = {},
): Promise<ReconcileSummary> {
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

  const run = access.reconcileRuns.start(scope, integration.id, {
    integration_id: integration.id,
    started_at: at,
  });

  const finish = (fields: {
    status: "completed" | "incomplete";
    pages_seen: number;
    roster_size: number;
    members_added?: number;
    members_removed?: number;
    roles_changed?: number;
    roles_pruned?: number;
    authority_reset?: number;
    failure_code?: string;
    revocations: readonly RevocationEffects[];
  }): ReconcileSummary => {
    access.reconcileRuns.finish(scope, run.id, {
      status: fields.status,
      pages_seen: fields.pages_seen,
      roster_size: fields.roster_size,
      members_added: fields.members_added,
      members_removed: fields.members_removed,
      roles_changed: fields.roles_changed,
      authority_reset: fields.authority_reset,
      ...(fields.failure_code ? { failure_code: fields.failure_code } : {}),
      finished_at: (options.now ?? clock()).toISOString(),
    });
    epoch.bump();
    return {
      run_id: run.id,
      status: fields.status,
      pages_seen: fields.pages_seen,
      roster_size: fields.roster_size,
      members_added: fields.members_added ?? 0,
      members_removed: fields.members_removed ?? 0,
      roles_changed: fields.roles_changed ?? 0,
      roles_pruned: fields.roles_pruned ?? 0,
      authority_reset: fields.authority_reset ?? 0,
      revocations: fields.revocations,
      ...(fields.failure_code ? { failure_code: fields.failure_code } : {}),
    };
  };

  let raw: RawProviderRole[];
  let pagesSeen: number;
  try {
    const collected = await collectRoster(adapter, ctx, repository, {
      ...(deps.available_token_scope ? { available_token_scope: deps.available_token_scope } : {}),
    });
    raw = collected.entries;
    pagesSeen = collected.pages_fetched;
  } catch (error) {
    if (
      error instanceof IncompleteRosterError ||
      error instanceof MissingPermissionError ||
      error instanceof NormalizationError ||
      error instanceof ProviderUnavailableError
    ) {
      // Nothing is applied. The verification did not complete, so existing
      // authority degrades to `stale`: sensitive actions are blocked pending
      // a successful reconciliation, ordinary reads keep the last verified
      // state. Never treat a partial fetch — or an unreachable provider — as
      // removal.
      markAllStale(access, scope, integration.id, at);
      const summary = finish({
        status: "incomplete",
        pages_seen: 0,
        roster_size: 0,
        failure_code: error.code,
        revocations: [],
      });
      throw new ReconcileIncompleteError(summary, error);
    }
    throw error;
  }

  // Normalize with explicit rules. A record that would fabricate authority
  // (e.g. a GitHub repository "owner" user) aborts the run like an
  // incomplete fetch — nothing is applied.
  let normalized;
  try {
    normalized = normalizeRoster(adapter.provider_type, raw);
  } catch (error) {
    if (error instanceof NormalizationError) {
      markAllStale(access, scope, integration.id, at);
      const summary = finish({
        status: "incomplete",
        pages_seen: pagesSeen,
        roster_size: 0,
        failure_code: error.code,
        revocations: [],
      });
      throw new ReconcileIncompleteError(summary, error);
    }
    throw error;
  }

  // 1. Verify everyone present in the complete roster.
  // Bind provider subjects to app users through the identity table:
  // (provider instance, stable subject) is the only account-match key.
  const subjectUsers: Record<string, UserId> = {};
  for (const entry of raw) {
    const identity = identities.getByProviderSubject(
      integration.provider_instance_id,
      entry.subject,
    );
    if (identity) {
      subjectUsers[entry.subject] = identity.user_id;
    }
  }
  const snapshot = access.roster.applySnapshot(scope, integration.id, {
    roles: normalized.map((entry) => ({
      subject: entry.subject,
      login: entry.login,
      source_kind: entry.source_kind,
      provider_role: entry.provider_role,
      authority_ref: entry.authority_ref,
      inherited_from: entry.inherited_from,
    })),
    verified_at: at,
    subject_users: subjectUsers,
  });

  // 2. Drop rows whose provenance key is gone from this complete roster.
  // Rows are upserted per (subject, source_kind, authority_ref), so a subject
  // whose source changed (e.g. `direct_collaborator` -> `effective_access`)
  // would otherwise keep displaying the old provenance forever. This belongs
  // here and not in `applySnapshot`: subject refresh also applies snapshots,
  // and pruning there would wipe the rest of the roster.
  const rolesPruned = access.roster.pruneRoles(
    scope,
    integration.id,
    normalized.map((entry) => ({
      subject: entry.subject,
      source_kind: entry.source_kind,
      authority_ref: entry.authority_ref,
    })),
  );

  // 3. Revoke everyone recorded locally but absent from the complete roster.
  const present = new Set(normalized.map((entry) => entry.subject));
  const revocations: RevocationEffects[] = [];
  let membersRemoved = 0;
  for (const authority of access.roster.listAuthority(scope, integration.id)) {
    if (!present.has(authority.subject) && authority.state !== "removed") {
      revocations.push(
        revokeAuthority(
          access,
          epoch,
          scope,
          {
            integration_id: integration.id,
            subject: authority.subject,
            user_id: authority.user_id,
          },
          "reconcile: absent from provider roster",
          at,
        ),
      );
      access.roster.removeSubject(scope, integration.id, authority.subject);
      membersRemoved += 1;
    }
  }

  return finish({
    status: "completed",
    pages_seen: pagesSeen,
    roster_size: normalized.length,
    members_added: snapshot.added,
    members_removed: membersRemoved,
    roles_changed: snapshot.changed,
    roles_pruned: rolesPruned,
    revocations,
  });
}

// ---------------------------------------------------------------------------
// Provider event sync
// ---------------------------------------------------------------------------

export interface EventSyncResult {
  applied: boolean;
  duplicate: boolean;
  event_type: ProviderEventType;
  revocation?: RevocationEffects;
  /** Only set for `repository_transferred`: subjects reset to unknown. */
  authority_reset?: number;
}

/**
 * Apply one provider event. Idempotent on the provider delivery id: a
 * replayed delivery is recorded once and applied once.
 *
 * Every path ends in an authority-epoch bump so cached allow decisions never
 * outlive the event that invalidated them.
 */
export function applyProviderEvent(
  deps: ReconcileDeps,
  scope: WorkspaceScope,
  integration: ServiceIntegration,
  event: ProviderEvent,
  options: { now?: Date } = {},
): EventSyncResult {
  const { access, epoch, identities, clock = () => new Date() } = deps;
  const now = options.now ?? clock();
  const at = now.toISOString();

  const record = access.events.append(
    { enterprise_id: scope.enterprise_id, actor_id: scope.actor_id },
    {
      provider_instance_id: event.provider_instance_id,
      integration_id: integration.id,
      repository_id: event.repository_id ?? integration.repository_id,
      event_type: event.event_type,
      payload: event.payload,
      ...(event.delivery_id ? { delivery_id: event.delivery_id } : {}),
      received_at: event.received_at,
    },
  );
  if (record.duplicate) {
    return { applied: false, duplicate: true, event_type: event.event_type };
  }

  let revocation: RevocationEffects | undefined;

  switch (event.event_type) {
    case "member_removed": {
      const subject = String(event.payload.subject ?? "");
      if (!subject) {
        throw new ProviderIntegrationError(
          "PROVIDER_EVENT_INVALID",
          "member_removed requires payload.subject",
        );
      }
      const boundUser =
        typeof event.payload.user_id === "string"
          ? event.payload.user_id
          : (identities.getByProviderSubject(integration.provider_instance_id, subject)?.user_id ??
            null);
      revocation = revokeAuthority(
        access,
        epoch,
        scope,
        { integration_id: integration.id, subject, user_id: boundUser },
        "provider event: member_removed",
        at,
      );
      access.roster.removeSubject(scope, integration.id, subject);
      break;
    }
    case "member_added":
    case "role_changed": {
      // Validate through the normalizer, then upsert exactly one provenance
      // row and (re)verify authority from the provider's own signal.
      const raw = eventPayloadRole(event);
      const checked = normalizeRole(providerTypeOf(event), raw);
      const boundUser =
        typeof event.payload.user_id === "string"
          ? event.payload.user_id
          : (identities.getByProviderSubject(integration.provider_instance_id, checked.subject)
              ?.user_id ?? null);
      access.roster.applySnapshot(scope, integration.id, {
        roles: [
          {
            subject: checked.subject,
            login: checked.login,
            source_kind: checked.source_kind,
            provider_role: checked.provider_role,
            authority_ref: checked.authority_ref,
            inherited_from: checked.inherited_from,
          },
        ],
        verified_at: at,
        ...(boundUser ? { subject_users: { [checked.subject]: boundUser } } : {}),
      });
      break;
    }
    case "repository_renamed": {
      // Rename is metadata only: authority and credentials are untouched.
      const name = String(event.payload.repository_name ?? "");
      if (!name) {
        throw new ProviderIntegrationError(
          "PROVIDER_EVENT_INVALID",
          "repository_renamed requires payload.repository_name",
        );
      }
      access.integrations.rename(
        scope,
        integration.id,
        { repository_name: name, actor_id: scope.actor_id },
        integration.version,
      );
      break;
    }
    case "repository_transferred": {
      // Transfer rebinds the repository id and demands authority
      // revalidation. Enterprise membership is unchanged and credentials are
      // never expanded: only repository metadata moves.
      const repositoryId = String(event.payload.repository_id ?? "");
      const repositoryName = String(event.payload.repository_name ?? integration.repository_name);
      if (!repositoryId) {
        throw new ProviderIntegrationError(
          "PROVIDER_EVENT_INVALID",
          "repository_transferred requires payload.repository_id",
        );
      }
      access.integrations.transfer(
        scope,
        integration.id,
        {
          repository_id: repositoryId,
          repository_name: repositoryName,
          provider_instance_id: integration.provider_instance_id,
          actor_id: scope.actor_id,
        },
        integration.version,
      );
      const reset = access.roster.resetAuthority(scope, integration.id, at);
      // Write capability never survives an unvalidated transfer; reads are
      // already blocked because every subject is now `unknown`.
      revokeCapabilityKind(
        access,
        scope,
        integration.id,
        "delivery_write",
        "repository_transferred",
        at,
      );
      epoch.bump();
      access.events.markProcessed(
        { enterprise_id: scope.enterprise_id, actor_id: scope.actor_id },
        record.event.id,
        at,
      );
      return {
        applied: true,
        duplicate: false,
        event_type: event.event_type,
        authority_reset: reset,
      };
    }
    case "integration_suspended": {
      access.integrations.setStatus(
        scope,
        integration.id,
        { install_status: "suspended", actor_id: scope.actor_id },
        integration.version,
      );
      access.roster.resetAuthority(scope, integration.id, at);
      revokeCapabilityKind(
        access,
        scope,
        integration.id,
        "delivery_write",
        "integration_suspended",
        at,
      );
      revokeCapabilityKind(
        access,
        scope,
        integration.id,
        "checkout_read",
        "integration_suspended",
        at,
      );
      break;
    }
    case "permission_changed": {
      // Effective permissions changed in a way events cannot fully describe:
      // degrade to `stale` so sensitive actions require reconciliation.
      markAllStale(access, scope, integration.id, at);
      break;
    }
  }

  access.events.markProcessed(
    { enterprise_id: scope.enterprise_id, actor_id: scope.actor_id },
    record.event.id,
    at,
  );
  epoch.bump();
  return {
    applied: true,
    duplicate: false,
    event_type: event.event_type,
    ...(revocation ? { revocation } : {}),
  };
}

function eventPayloadRole(event: ProviderEvent): RawProviderRole {
  const payload = event.payload;
  const subject = String(payload.subject ?? "");
  const kind = String(payload.source_kind ?? "");
  const providerRole = String(payload.provider_role ?? "");
  const authorityRef = String(payload.authority_ref ?? "");
  if (!subject || !kind || !providerRole || !authorityRef) {
    throw new ProviderIntegrationError(
      "PROVIDER_EVENT_INVALID",
      `${event.event_type} requires payload.subject, source_kind, provider_role, authority_ref`,
    );
  }
  return {
    subject,
    login: String(payload.login ?? subject),
    kind: kind as RawProviderRole["kind"],
    provider_role: providerRole,
    authority_ref: authorityRef,
    inherited_from: payload.inherited_from ? String(payload.inherited_from) : null,
  };
}

function providerTypeOf(event: ProviderEvent): "github" | "gitlab" {
  const type = String(event.payload.provider_type ?? "github");
  return type === "gitlab" ? "gitlab" : "github";
}

function revokeCapabilityKind(
  access: ProviderAccessRepositories,
  scope: WorkspaceScope,
  integrationId: string,
  capability: "checkout_read" | "delivery_write",
  reason: string,
  at: string,
): void {
  const live = access.grants.listLive(scope, integrationId, { capability, now: at });
  for (const grant of live) {
    access.grants.revoke(scope, grant.id, reason, at);
  }
}
