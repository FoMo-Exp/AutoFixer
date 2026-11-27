/**
 * Trusted task baselines (DAT-293, ADR-0011).
 *
 * A remediation run is dispatched against an exact commit, never against a
 * branch name a caller supplied and never against a value read from the
 * deployment for a different repository. This module is the one place that
 * derives that commit for a workspace repository binding:
 *
 * - the deployment's own pinned repository keeps its configured revision (no
 *   provider call, byte-identical to the pre-contract behavior);
 * - every other repository is read through its approved integration's
 *   **checkout** (read) capability, and the provider's answer must be a full
 *   commit id. A branch name, short sha, missing ref, unreadable provider or
 *   absent credential is reported as unavailable — never guessed and never
 *   substituted with another repository's pin.
 *
 * Availability is reported as data rather than thrown: a create refuses with a
 * stable code derived from the reason, while the target-selection read shows
 * the same reason per candidate so a client never offers a target this
 * deployment cannot pin.
 */

import type { OrchestratorConfig } from "../config.js";
import type { ProviderInstanceRepository } from "../control-plane/repositories.js";
import type { ServiceIntegration } from "../control-plane/provider-access-types.js";
import type { ProviderInstance } from "../control-plane/types.js";
import type { ServiceIntegrationRepository } from "../control-plane/provider-access-repositories.js";
import type { WorkspaceRepositoryBinding } from "../control-plane/workspace-repository-types.js";
import { resolveRepositoryRef } from "../provider-access/adapter.js";
import { createIntegrationAdapter } from "../provider-access/adapters/index.js";
import {
  parseCanonicalRepositoryId,
  type CanonicalRepositoryId,
} from "../provider-access/canonical-repository.js";
import type { ServiceCredentialStore } from "../provider-access/credentials.js";
import type { ProviderHttpClient } from "../provider-access/provider-http.js";
import {
  ProviderIntegrationError,
  type ProviderCallContext,
  type RepositoryRef,
} from "../provider-access/types.js";
import { pinnedTaskTargetBaselines } from "./task-targets.js";
import type {
  TrustedBaselineReason,
  TrustedBaselineResolver,
  TrustedBaselineResult,
} from "./task-targets.js";

export type {
  TrustedBaselineReason,
  TrustedBaselineResolver,
  TrustedBaselineResult,
} from "./task-targets.js";

export interface TrustedBaselineDeps {
  config: OrchestratorConfig;
  integrations: ServiceIntegrationRepository;
  providerInstances: ProviderInstanceRepository;
  /** The DAT-203 credential boundary; values never leave it. */
  credentials: ServiceCredentialStore;
  /** Test/deployment override for the provider API base. */
  api_base_url?: string | (() => string);
  http?: ProviderHttpClient;
  /** Clock seam for tests. */
  now?: () => Date;
}

/** The unavailable answer for one reason, with the ref that was attempted. */
function unavailable(ref: string | null, reason: TrustedBaselineReason): TrustedBaselineResult {
  return { state: "unavailable", base_ref: ref, base_sha: null, reason };
}

/**
 * Repository URL for a binding, from the binding itself or its provider origin.
 *
 * The binding's recorded URL is the immutable checkout location the workspace
 * was created with; the provider origin is only used to derive the canonical
 * HTTPS form when that column is empty. Nothing is invented from a repository
 * name.
 */
function repositoryUrlFor(
  binding: WorkspaceRepositoryBinding,
  providerType: ProviderInstance["provider_type"],
  origin: string,
  coords: CanonicalRepositoryId | null,
): string | null {
  if (binding.repository_url !== null && binding.repository_url.trim() !== "") {
    return binding.repository_url;
  }
  if (coords === null) {
    return null;
  }
  const base = origin.replace(/\/+$/, "");
  if (base === "") {
    return null;
  }
  const path =
    providerType === "github" || providerType === "gitlab" ? coords.path.replace(/^\/+/, "") : "";
  if (path === "") {
    return null;
  }
  return `${base}/${path}.git`;
}

/**
 * The provider-backed resolver.
 *
 * Ordering is deliberate and fail-closed: an integration that is missing,
 * suspended, bound to another workspace/provider instance or not the binding's
 * recorded installation refuses before any credential or provider call. Only
 * then is the checkout credential's *existence* checked in the boundary, and
 * only then is the provider asked. The credential value never leaves
 * {@link withServiceCredential}.
 */
export function createTrustedBaselineResolver(deps: TrustedBaselineDeps): TrustedBaselineResolver {
  const deploymentPin = pinnedTaskTargetBaselines(deps.config);
  const enterpriseScope = {
    enterprise_id: deps.config.enterpriseId,
    actor_id: deps.config.actorId,
  };

  function integrationFor(binding: WorkspaceRepositoryBinding): ServiceIntegration | null {
    const integration = deps.integrations.getByRepository(enterpriseScope, binding.repository_id);
    if (integration === undefined) {
      return null;
    }
    // The enterprise-wide lookup is not enough: the binding must be this
    // workspace's own approved installation of the same provider instance.
    if (
      integration.workspace_id !== binding.workspace_id ||
      integration.provider_instance_id !== binding.provider_instance_id ||
      integration.install_status !== "active"
    ) {
      return null;
    }
    // A binding that records an installation must be that exact installation.
    // A binding with none is only the local-prototype shape, which has no
    // integration at all — the caller establishes that separately.
    if (binding.installation_ref !== null && binding.installation_ref !== integration.id) {
      return null;
    }
    return integration;
  }

  async function resolve(
    binding: WorkspaceRepositoryBinding,
    requestedBaseRef?: string,
  ): Promise<TrustedBaselineResult> {
    const pin = deploymentPin.resolve(binding, requestedBaseRef);
    if (pin !== null) {
      const integration = integrationFor(binding);
      return {
        state: "trusted",
        base_ref: pin.base_ref,
        base_sha: pin.base_sha,
        repository_url: pin.repository_url,
        integration_id: integration?.id ?? null,
      };
    }

    const baseRef = requestedBaseRef?.trim() ?? deps.config.baseRef;
    if (baseRef === "") {
      return unavailable(null, "ref_not_found");
    }
    const provider = deps.providerInstances.getById(enterpriseScope, binding.provider_instance_id);
    if (provider === undefined) {
      return unavailable(baseRef, "installation_not_approved");
    }
    const integration = integrationFor(binding);
    if (integration === null) {
      // A workspace with *no* integration at all has no provider authority to
      // read the commit through: the honest answer is "this deployment cannot
      // pin this repository" (the DAT-245/292 seam), not a claim that an
      // installation was refused. A workspace that does have an integration
      // but cannot approve this binding is a different, precise refusal.
      const authorityInPlay =
        deps.integrations.listByWorkspace({
          enterprise_id: binding.enterprise_id,
          workspace_id: binding.workspace_id,
          actor_id: deps.config.actorId,
        }).length > 0;
      return unavailable(baseRef, authorityInPlay ? "integration_missing" : "baseline_not_pinned");
    }
    if (binding.installation_ref === null) {
      // No recorded installation means the binding was never verified through
      // this integration. Accepting it would grant a repository the workspace
      // set never bound, so it refuses like a missing installation.
      return unavailable(baseRef, "installation_not_approved");
    }
    const credentialRef = integration.checkout_credential_ref;
    if (credentialRef === null || credentialRef.trim() === "") {
      return unavailable(baseRef, "checkout_credential_missing");
    }
    if (!deps.credentials.has(credentialRef)) {
      // The reference exists on the row but the boundary cannot materialize
      // it: a rotated or withdrawn secret is not an approved credential.
      return unavailable(baseRef, "checkout_credential_missing");
    }

    let coords: CanonicalRepositoryId | null = null;
    try {
      coords = parseCanonicalRepositoryId(binding.repository_id);
    } catch {
      coords = null;
    }
    const repositoryUrl = repositoryUrlFor(
      binding,
      provider.provider_type,
      provider.origin_url,
      coords,
    );
    if (repositoryUrl === null) {
      return unavailable(baseRef, "baseline_not_pinned");
    }

    const repository: RepositoryRef = {
      repository_id: binding.repository_id,
      repository_name: binding.repository_name ?? coords?.path ?? binding.repository_id,
      provider_type: provider.provider_type,
    };
    const ctx: ProviderCallContext = {
      enterprise_id: binding.enterprise_id,
      workspace_id: binding.workspace_id,
      integration_id: integration.id,
    };

    try {
      const adapter = createIntegrationAdapter({
        integration,
        canonical_repository_id: binding.repository_id,
        credentials: deps.credentials,
        credential_kind: "checkout",
        ...(typeof deps.api_base_url === "string"
          ? { api_base_url: deps.api_base_url }
          : typeof deps.api_base_url === "function"
            ? { api_base_url: deps.api_base_url() }
            : {}),
        ...(deps.http !== undefined ? { http: deps.http } : {}),
      });
      const resolved = await resolveRepositoryRef(adapter, ctx, repository, baseRef);
      if (resolved === null) {
        return unavailable(baseRef, "ref_not_found");
      }
      return {
        state: "trusted",
        base_ref: resolved.ref,
        base_sha: resolved.sha,
        repository_url: repositoryUrl,
        integration_id: integration.id,
      };
    } catch (error) {
      if (error instanceof ProviderIntegrationError) {
        // Permission, scope, rate-limit and visibility failures are all
        // "cannot prove this commit right now". None of them is a baseline.
        return unavailable(baseRef, "provider_unavailable");
      }
      throw error;
    }
  }

  return { resolve };
}
