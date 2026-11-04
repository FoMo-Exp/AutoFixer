/**
 * Real provider adapter factory (DAT-247).
 *
 * One place binds an installed `ServiceIntegration` to a concrete adapter, so
 * every caller (periodic reconcile, per-subject refresh, tests) uses the same
 * credential source and the same canonical-id rules.
 *
 * Credential rules encoded here:
 *
 * - Only the integration's **source** credential is used — the repository-
 *   scoped, read-only service integration credential. Checkout and delivery
 *   references are never touched by a roster read, and no user OAuth token
 *   can be substituted (DAT-204's login-time probe was ruled out).
 * - Only the *reference* is passed around; the adapter resolves the value
 *   inside the DAT-203 credential boundary per request.
 */

import type { ServiceIntegration } from "../../control-plane/provider-access-types.js";
import { parseCanonicalRepositoryId, type CanonicalRepositoryId } from "../canonical-repository.js";
import type { ServiceCredentialStore } from "../credentials.js";
import type { ProviderHttpClient } from "../provider-http.js";
import { ProviderIntegrationError, type ProviderAdapter } from "../types.js";
import { createGitHubAdapter, type GitHubAdapterOptions } from "./github.js";
import { createGitLabAdapter, type GitLabAdapterOptions } from "./gitlab.js";

export {
  GITHUB_REQUIRED_TOKEN_SCOPE,
  createGitHubAdapter,
  githubApiBaseUrl,
  type GitHubAdapterOptions,
} from "./github.js";
export {
  GITLAB_REQUIRED_TOKEN_SCOPE,
  createGitLabAdapter,
  gitlabApiBaseUrl,
  type GitLabAdapterOptions,
} from "./gitlab.js";

export interface IntegrationAdapterOptions {
  integration: ServiceIntegration;
  /** Canonical locator of the repository, e.g. `github:Luthiel/AutoFixer`. */
  canonical_repository_id: string;
  credentials: ServiceCredentialStore;
  /** Approved provider-instance origin (self-hosted GitHub/GitLab). */
  provider_origin?: string;
  /** Explicit API base override (tests and pinned deployments). */
  api_base_url?: string;
  resolve_login?: (subject: string) => string | undefined;
  http?: ProviderHttpClient;
  per_page?: number;
  pages_max?: number;
  requests_per_minute?: number;
  max_retry_after_ms?: number;
}

/**
 * Build the adapter for one integration. The canonical id's provider decides
 * the implementation; a mismatch with the integration's registered provider
 * type is refused rather than guessed.
 */
export function createIntegrationAdapter(options: IntegrationAdapterOptions): ProviderAdapter {
  const coords: CanonicalRepositoryId = parseCanonicalRepositoryId(options.canonical_repository_id);
  const credentialRef = options.integration.source_credential_ref;
  if (credentialRef === undefined || credentialRef === "") {
    throw new ProviderIntegrationError(
      "PROVIDER_CREDENTIAL_MISSING",
      `integration ${options.integration.id} has no source credential reference`,
    );
  }

  const shared = {
    canonical_repository_id: coords.canonical,
    credential_ref: credentialRef,
    credentials: options.credentials,
    http: options.http,
    ...(options.api_base_url !== undefined ? { api_base_url: options.api_base_url } : {}),
    per_page: options.per_page,
    pages_max: options.pages_max,
    requests_per_minute: options.requests_per_minute,
    max_retry_after_ms: options.max_retry_after_ms,
    ...(options.provider_origin !== undefined ? { provider_origin: options.provider_origin } : {}),
  };

  switch (coords.provider) {
    case "github":
      return createGitHubAdapter({
        ...shared,
        ...(options.resolve_login !== undefined ? { resolve_login: options.resolve_login } : {}),
      } satisfies GitHubAdapterOptions);
    case "gitlab":
      return createGitLabAdapter(shared satisfies GitLabAdapterOptions);
    default: {
      const exhaustive: never = coords.provider;
      throw new ProviderIntegrationError(
        "PROVIDER_UNSUPPORTED",
        `no adapter for provider ${String(exhaustive)}`,
      );
    }
  }
}
