/**
 * Approved-repository discovery (DAT-289, ADR-0011).
 *
 * DAT-286 can add a repository to a workspace, but an administrator had to
 * supply `(provider_instance_id, installation_ref, repository_id)` by hand.
 * This surface answers the question that made that necessary: *which
 * repositories can I select for this workspace?*
 *
 * ## The four boundaries
 *
 * 1. **Authority.** Discovery is disclosed only to a repository manager — the
 *    same rule the preview/confirm/commit surface uses
 *    (`createRepositoryManagerGuard`). Someone who could not decide the change
 *    cannot enumerate the workspace's candidate repositories either.
 * 2. **Tenant.** Candidates come from active service integrations of *this*
 *    workspace, which are already enterprise-scoped. A repository installed for
 *    another enterprise is not a candidate, and an unknown or cross-tenant
 *    workspace is one indistinguishable 404.
 * 3. **Evidence.** A candidate is offered with the exact installation that would
 *    have to vouch for it, plus the installation's own state. A candidate whose
 *    installation cannot serve as evidence (inactive, unapproved instance,
 *    unobservable permissions, provider unreachable, truncated roster) is
 *    reported with the named **restriction**, never hidden and never labelled
 *    approvable.
 * 4. **Bounded coverage.** The response always says its list is bounded and
 *    names the source it could not use. It never reads as "every repository the
 *    provider would allow". A repository already bound in this workspace is
 *    excluded and counted, because DAT-286 refuses to add it (the binding
 *    identity is unique, retired or not).
 *
 * ## What discovery is not
 *
 * It is not an approval, not a grant and not a reservation. Submitting a
 * candidate still runs the full DAT-286 preview → confirmation → commit chain,
 * which re-verifies the actor's authority, the installation, the whole member
 * impact and the observed set version. So a candidate that is deactivated,
 * revoked or degraded between discovery and submission is refused there — this
 * module never has to be trusted for that.
 */

import type {
  EnterpriseId,
  ProviderInstance,
  UserId,
  WorkspaceScope,
} from "../control-plane/types.js";
import type { ControlPlaneRepositories } from "../control-plane/repositories.js";
import type { IdentityRepositories } from "../control-plane/identity-repositories.js";
import type { ProviderAccessRepositories } from "../control-plane/provider-access-repositories.js";
import type {
  InstallStatus,
  PermissionVisibility,
  ServiceIntegration,
} from "../control-plane/provider-access-types.js";
import type { ProviderType } from "../control-plane/types.js";
import type { WorkspaceRepositorySetRepository } from "../control-plane/workspace-repository-repositories.js";
import type { CapabilityCeilingService } from "../provider-access/capability-ceiling.js";
import { createRepositoryManagerGuard } from "../provider-access/repository-manager.js";
import { WorkspaceRepositorySetError } from "../control-plane/errors.js";
import { ApiError } from "./errors.js";
import { resolveWorkspaceScope, rethrowRepositoryDomainError } from "./workspace-locator.js";
import type {
  RepositoryCandidateFreshness,
  RepositoryCandidateRestriction,
} from "./repository-candidate-types.js";
import {
  REPOSITORY_CANDIDATE_RESTRICTIONS,
  REPOSITORY_DISCOVERY_COMPLETENESS,
  REPOSITORY_DISCOVERY_LIMITS,
  REPOSITORY_DISCOVERY_SOURCES,
  REPOSITORY_DISCOVERY_UNSUPPORTED_SOURCES,
} from "./repository-candidate-types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Candidates per page; the cursor is the last item's key. */
export const REPOSITORY_CANDIDATE_PAGE_SIZE = 50;

/**
 * The freshness bound for observed authority: one day, the same bound the
 * capability ceiling applies before it treats a verified fact as stale. It is
 * reported, not enforced — an aged installation is still offered, because the
 * preview decides whether each member's evidence is current.
 */
export const DEFAULT_AUTHORITY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Failure codes a reconciliation leaves behind when the provider was unwell. */
const PROVIDER_UNAVAILABLE_FAILURE = "PROVIDER_UNAVAILABLE";
const ROSTER_INCOMPLETE_FAILURE = "PROVIDER_ROSTER_INCOMPLETE";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** How current the installation's observed authority is. */
export interface RepositoryCandidateVerificationView {
  /** Subjects the installation has an authority row for. */
  subjects: number;
  /** Most recent per-subject verification, or null when none was recorded. */
  latest_verified_at: string | null;
  freshness: RepositoryCandidateFreshness;
  /** Start (or finish) of the last reconciliation attempt, when one ran. */
  last_reconcile_at: string | null;
  /** The failure code of the last attempt, when it failed. */
  last_failure: string | null;
}

/**
 * One repository an administrator may select for this workspace.
 *
 * The three authority-bearing fields are exactly what DAT-286 accepts as a
 * proposal entry. `repository_name` is display metadata only: it is never
 * stored in a confirmation, a binding or an audit row, and it never
 * authorizes.
 */
export interface RepositoryCandidateView {
  provider_instance_id: string;
  /** The registered instance's type; null while the instance is unapproved. */
  provider_type: ProviderType | null;
  /**
   * The repository-scoped, active service integration (`service_integration.id`)
   * that would have to vouch for this repository. This is the `installation_ref`
   * a DAT-286 proposal carries.
   */
  installation_ref: string;
  /** Immutable provider-assigned repository id; the only authority-bearing name. */
  repository_id: string;
  /** Display metadata from the registered installation; never authority. */
  repository_name: string | null;
  install_status: InstallStatus;
  permission_visibility: PermissionVisibility;
  verification: RepositoryCandidateVerificationView;
  /**
   * True only when nothing restricts this installation. It means "selectable for
   * the preview", never "approved" and never "will commit".
   */
  proposable: boolean;
  /** Every reason this installation cannot be proposed as it stands. */
  restriction_reasons: RepositoryCandidateRestriction[];
}

/** What the list covers, stated so it can never be mistaken for a full one. */
export interface RepositoryDiscoveryCoverageView {
  /** Always `bounded`: this surface never claims an exhaustive list. */
  completeness: (typeof REPOSITORY_DISCOVERY_COMPLETENESS)[number];
  /** The stores this list was built from. */
  sources: Array<(typeof REPOSITORY_DISCOVERY_SOURCES)[number]>;
  /** Sources this build cannot enumerate; an empty gap would hide a real one. */
  unsupported_sources: Array<(typeof REPOSITORY_DISCOVERY_UNSUPPORTED_SOURCES)[number]>;
  /** Why the list is bounded. */
  limits: Array<(typeof REPOSITORY_DISCOVERY_LIMITS)[number]>;
}

export interface RepositoryDiscoveryTotalsView {
  /** Unbound repositories whose installation was readable. */
  discovered: number;
  /** Candidates with no restriction. */
  proposable: number;
  /** Candidates kept but restricted. */
  restricted: number;
  /**
   * Repositories already bound in this workspace (active or retired), excluded
   * from `items` because DAT-286 only adds. Reported so an empty page is
   * explainable.
   */
  already_bound: number;
}

export interface RepositoryCandidatePageView {
  enterprise_id: EnterpriseId;
  workspace_id: string;
  /** The set version a selection should be previewed against. */
  set_version: number;
  discovered_at: string;
  coverage: RepositoryDiscoveryCoverageView;
  items: RepositoryCandidateView[];
  next_cursor: string | null;
  /** Counts over the whole discovered set, not just this page. */
  totals: RepositoryDiscoveryTotalsView;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RepositoryCandidateServiceDeps {
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  access: ProviderAccessRepositories;
  repositorySets: WorkspaceRepositorySetRepository;
  capabilityCeilings: CapabilityCeilingService;
  enterpriseId: EnterpriseId;
  clock?: () => Date;
  staleAfterMs?: number;
}

export interface RepositoryCandidateService {
  /** One page of candidate repositories for the caller's workspace. */
  discover(
    actorUserId: UserId,
    workspaceId: string,
    cursor: string | null,
  ): RepositoryCandidatePageView;
}

export class WorkspaceRepositoryCandidateService implements RepositoryCandidateService {
  readonly #deps: RepositoryCandidateServiceDeps;
  readonly #managers: ReturnType<typeof createRepositoryManagerGuard>;

  constructor(deps: RepositoryCandidateServiceDeps) {
    this.#deps = deps;
    this.#managers = createRepositoryManagerGuard({
      memberships: deps.repos.memberships,
      identity: deps.identity,
      capabilityCeilings: deps.capabilityCeilings,
    });
  }

  discover(
    actorUserId: UserId,
    workspaceId: string,
    cursor: string | null,
  ): RepositoryCandidatePageView {
    const { access, repositorySets, clock } = this.#deps;
    const now = (clock ?? (() => new Date()))();
    const at = now.toISOString();
    const scope = this.#scope(actorUserId, workspaceId);

    // Authority before disclosure: a caller who cannot decide a repository-set
    // change must not be able to enumerate its candidate repositories either.
    this.#guard(() => this.#managers.require(scope, actorUserId, now));

    // Bound repositories: any active or retired binding. DAT-286 only adds, and
    // a retired binding still occupies the unique binding identity, so it is
    // not offered again — it is counted instead, so an empty page is
    // explainable rather than mysterious.
    let bound: Set<string>;
    let setVersion: number;
    try {
      bound = new Set(
        repositorySets
          .listBindings(scope, { include_retired: true })
          .map((binding) => binding.repository_id),
      );
      setVersion = repositorySets.currentSetVersion(scope);
    } catch (error) {
      if (error instanceof WorkspaceRepositorySetError) {
        // A set that cannot be read cannot be administrated: no candidate is
        // offered, so nothing can be proposed against an unreadable set.
        throw new ApiError(error.status, error.code, error.message, error.details);
      }
      throw error;
    }

    const discovered: ServiceIntegration[] = [];
    let alreadyBound = 0;
    for (const integration of access.integrations.listByWorkspace(scope)) {
      if (bound.has(integration.repository_id)) {
        alreadyBound += 1;
        continue;
      }
      discovered.push(integration);
    }

    const sorted = discovered.sort(
      (a, b) =>
        (a.repository_name ?? a.repository_id).localeCompare(
          b.repository_name ?? b.repository_id,
        ) || a.repository_id.localeCompare(b.repository_id),
    );
    const page = paginate(sorted, cursor, candidateKey);
    const items = page.page.map((integration) => this.#candidateView(scope, integration, now));
    return {
      enterprise_id: this.#deps.enterpriseId,
      workspace_id: scope.workspace_id,
      set_version: setVersion,
      discovered_at: at,
      coverage: {
        completeness: REPOSITORY_DISCOVERY_COMPLETENESS[0],
        sources: [...REPOSITORY_DISCOVERY_SOURCES],
        unsupported_sources: [...REPOSITORY_DISCOVERY_UNSUPPORTED_SOURCES],
        limits: [...REPOSITORY_DISCOVERY_LIMITS],
      },
      items,
      next_cursor: page.next,
      totals: this.#totals(scope, sorted, alreadyBound),
    };
  }

  /**
   * Totals cover the whole discovered set, not one page: a caller reading the
   * last page still learns how many candidates exist in total.
   */
  #totals(
    scope: WorkspaceScope,
    all: readonly ServiceIntegration[],
    alreadyBound: number,
  ): RepositoryDiscoveryTotalsView {
    let proposable = 0;
    for (const integration of all) {
      if (this.#restrictions(scope, integration).length === 0) {
        proposable += 1;
      }
    }
    return {
      discovered: all.length,
      proposable,
      restricted: all.length - proposable,
      already_bound: alreadyBound,
    };
  }

  #candidateView(
    scope: WorkspaceScope,
    integration: ServiceIntegration,
    now: Date,
  ): RepositoryCandidateView {
    const restrictions = this.#restrictions(scope, integration);
    const provider = this.#deps.repos.providerInstances.getById(
      scope,
      integration.provider_instance_id,
    );
    return {
      provider_instance_id: integration.provider_instance_id,
      // A candidate whose instance is not registered is still reported (with
      // its restriction), and its provider type is reported as unknown rather
      // than inferred from the repository id.
      provider_type: provider?.provider_type ?? null,
      installation_ref: integration.id,
      repository_id: integration.repository_id,
      repository_name: integration.repository_name,
      install_status: integration.install_status,
      permission_visibility: integration.permission_visibility,
      verification: this.#verification(scope, integration.id, now),
      proposable: restrictions.length === 0,
      restriction_reasons: restrictions,
    };
  }

  /** Every reason this installation cannot serve as evidence, canonical order. */
  #restrictions(
    scope: WorkspaceScope,
    integration: ServiceIntegration,
  ): RepositoryCandidateRestriction[] {
    const found = new Set<RepositoryCandidateRestriction>();
    if (integration.install_status !== "active") {
      found.add("installation_inactive");
    }
    const provider: ProviderInstance | undefined = this.#deps.repos.providerInstances.getById(
      scope,
      integration.provider_instance_id,
    );
    if (provider === undefined) {
      found.add("provider_instance_unapproved");
    }
    if (integration.permission_visibility === "none") {
      found.add("permission_visibility_none");
    } else if (integration.permission_visibility === "partial") {
      found.add("permission_visibility_partial");
    }
    const failure = this.#deps.access.reconcileRuns.list(scope, integration.id, 1)[0]?.failure_code;
    if (failure === PROVIDER_UNAVAILABLE_FAILURE) {
      found.add("provider_unavailable");
    } else if (failure === ROSTER_INCOMPLETE_FAILURE) {
      found.add("roster_incomplete");
    }
    // A candidate is only restricted by *positive* facts: an installation that
    // has never been reconciled is offered, and freshness is reported next to
    // it instead of being turned into a guess.
    return REPOSITORY_CANDIDATE_RESTRICTIONS.filter((code) => found.has(code));
  }

  #verification(
    scope: WorkspaceScope,
    integrationId: string,
    now: Date,
  ): RepositoryCandidateVerificationView {
    const authority = this.#deps.access.roster.listAuthority(scope, integrationId);
    let latest: string | null = null;
    for (const row of authority) {
      if (row.last_verified_at === null) {
        continue;
      }
      if (latest === null || row.last_verified_at > latest) {
        latest = row.last_verified_at;
      }
    }
    const [run] = this.#deps.access.reconcileRuns.list(scope, integrationId, 1);
    const staleAfterMs = this.#deps.staleAfterMs ?? DEFAULT_AUTHORITY_STALE_AFTER_MS;
    let freshness: RepositoryCandidateFreshness = "never_verified";
    if (latest !== null) {
      const age = now.getTime() - Date.parse(latest);
      freshness = Number.isNaN(age) || age > staleAfterMs ? "stale" : "fresh";
    }
    return {
      subjects: authority.length,
      latest_verified_at: latest,
      freshness,
      last_reconcile_at: run?.finished_at ?? run?.started_at ?? null,
      last_failure: run?.failure_code ?? null,
    };
  }

  /**
   * The path workspace is a locator: an unknown workspace, another enterprise's
   * workspace and a workspace the caller holds no membership in are one
   * indistinguishable 404, so the route cannot enumerate workspaces.
   */
  #scope(actorUserId: UserId, workspaceId: string): WorkspaceScope {
    return resolveWorkspaceScope(
      this.#deps.repos,
      this.#deps.enterpriseId,
      actorUserId,
      workspaceId,
    );
  }

  /** Domain refusals keep their stable codes and 403/409 semantics. */
  #guard<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      return rethrowRepositoryDomainError(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable, display-safe cursor key: identities only, never a secret. */
function candidateKey(integration: ServiceIntegration): string {
  return `${integration.provider_instance_id}:${integration.repository_id}`;
}

function paginate<T>(
  items: readonly T[],
  cursor: string | null,
  keyOf: (item: T) => string,
): { page: T[]; next: string | null } {
  let start = 0;
  if (cursor !== null) {
    const index = items.findIndex((item) => keyOf(item) === cursor);
    if (index < 0) {
      throw new ApiError(400, "INVALID_CURSOR", `Unknown cursor ${JSON.stringify(cursor)}`);
    }
    start = index + 1;
  }
  const page = items.slice(start, start + REPOSITORY_CANDIDATE_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    page,
    next: last !== undefined && start + page.length < items.length ? keyOf(last) : null,
  };
}
