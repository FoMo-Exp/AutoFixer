/**
 * GitHub roster adapter (DAT-247).
 *
 * Real GitHub App installation-token reads that produce the
 * `subject_authority` facts DAT-204's invitation redemption consumes:
 *
 * - repository metadata and the collaborator list describe *current
 *   repository access*;
 * - the organization's owners are recorded as organization authority, which
 *   is what GitHub actually models (a GitHub repository has no "owner" user —
 *   see `normalize.ts`).
 *
 * Deliberate choices:
 *
 * - **Exact API paths.** `github:<owner>/<repo>` becomes
 *   `/repos/{owner}/{repo}`; the provider prefix never reaches the URL. This
 *   is the defect DAT-204's login-time OAuth probe shipped
 *   (`/repositories/github:<owner>/<repo>`, always 404).
 * - **Least privilege, declared.** Metadata read addresses the repository and
 *   the collaborator list (the endpoint the GitHub docs list Metadata read
 *   for, which returns everyone with access including team and default
 *   permission inheritance), Contents read covers checkout, and Members read
 *   addresses organization owners. Nothing broader is required.
 *   `collectRoster` refuses to run when the credential does not hold every
 *   declared scope, so a narrower token fails closed instead of producing a
 *   short roster that reads as removals.
 * - **Organization membership alone is not authority.** Plain org members are
 *   deliberately absent: on GitHub, org membership without a team or direct
 *   grant is not repository access, so recording it would grant data access
 *   the provider never did.
 */

import {
  githubRepositoryPath,
  parseCanonicalRepositoryId,
  type CanonicalRepositoryId,
} from "../canonical-repository.js";
import { withServiceCredential, type ServiceCredentialStore } from "../credentials.js";
import {
  assertProviderStatus,
  assertRateLimitBudget,
  createFetchHttpClient,
  linkHasNext,
  parseJsonArray,
  parseJsonBody,
  readRateLimit,
  retryAfterMs,
  type ProviderHttpClient,
  type ProviderHttpResponse,
} from "../provider-http.js";
import {
  IncompleteRosterError,
  MissingPermissionError,
  NormalizationError,
  ProviderUnavailableError,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderCallContext,
  type ProviderRoleSourceKind,
  type RawProviderRole,
  type RepositoryRef,
  type RosterPage,
} from "../types.js";

/**
 * Scopes the integration credential must hold — the minimum each endpoint the
 * adapter uses actually requires, nothing more. Installation tokens realize
 * these as installation permissions; the service catalog maps each entry to
 * the granted permission it stands for.
 *
 * - `metadata:read` — repository metadata and the collaborator list (the
 *   GitHub docs list Metadata read for fine-grained tokens on these
 *   endpoints).
 * - `contents:read` — code checkout, the integration's read capability.
 * - `members:read` — organization owners, the one organization-level roster
 *   source.
 *
 * Administration read is deliberately NOT required: least privilege here is
 * the whole point of using a repository-scoped service integration instead of
 * a `repo`-scoped user OAuth token, and the endpoints used do not need it.
 */
export const GITHUB_REQUIRED_TOKEN_SCOPE: readonly string[] = Object.freeze([
  "metadata:read",
  "contents:read",
  "members:read",
]);

/**
 * GitHub role vocabulary → this project's roles.
 *
 * GitHub reports repository roles in two spellings: the collaborator list
 * uses `pull` / `push`, while the permissions endpoint uses `read` / `write`.
 * Both are accepted so the mapping never depends on which endpoint answered.
 */
const ROLE_NAME: Readonly<Record<string, string>> = Object.freeze({
  pull: "read",
  read: "read",
  triage: "triage",
  push: "write",
  write: "write",
  maintain: "maintain",
  admin: "admin",
});

/** Read-only service credential; never a user OAuth token (DAT-204 ruling). */
export interface GitHubAdapterOptions {
  /** Canonical id, e.g. `github:Luthiel/AutoFixer`. */
  canonical_repository_id: string;
  /** Reference into the DAT-203 credential boundary — never a secret. */
  credential_ref: string;
  credentials: ServiceCredentialStore;
  /** `https://api.github.com` or `https://ghe.example.com/api/v3`. */
  api_base_url?: string;
  /**
   * Approved provider-instance origin. Only used to derive the API base for
   * GitHub Enterprise; `https://github.com` maps to `https://api.github.com`.
   */
  provider_origin?: string;
  /**
   * Resolve a stable provider subject to its current login. GitHub's
   * per-collaborator endpoint is addressed by login, and the subject → login
   * binding belongs to the identity table — the adapter is handed a lookup,
   * never a second credential.
   */
  resolve_login?: (subject: string) => string | undefined;
  http?: ProviderHttpClient;
  per_page?: number;
  pages_max?: number;
  requests_per_minute?: number;
  /** Longest `Retry-After` the adapter will wait out before giving up. */
  max_retry_after_ms?: number;
}

interface GitHubCursor {
  source: "collaborators" | "org_owners";
  page: number;
}

/** What the adapter needs to know about the bound repository. */
interface GitHubRepository {
  owner_type: "organization" | "user";
  owner_login: string;
}

const CURSOR_VERSION = 1;

function encodeCursor(cursor: GitHubCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...cursor }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(raw: string): GitHubCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new IncompleteRosterError("missing_cursor", "github roster cursor is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new IncompleteRosterError("missing_cursor", "github roster cursor is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const source = record["source"];
  const page = record["page"];
  if (
    (source !== "collaborators" && source !== "org_owners") ||
    typeof page !== "number" ||
    !Number.isInteger(page) ||
    page < 1
  ) {
    throw new IncompleteRosterError("missing_cursor", "github roster cursor is not usable");
  }
  return { source, page };
}

/** Derive the API base: public GitHub, or the Enterprise `/api/v3` root. */
export function githubApiBaseUrl(options: {
  api_base_url?: string;
  provider_origin?: string;
}): string {
  if (options.api_base_url !== undefined) {
    return options.api_base_url.replace(/\/+$/, "");
  }
  const origin = options.provider_origin;
  if (origin === undefined || origin === "") {
    return "https://api.github.com";
  }
  const parsed = new URL(origin);
  if (parsed.hostname.toLowerCase() === "github.com") {
    return "https://api.github.com";
  }
  return `${origin.replace(/\/+$/, "")}/api/v3`;
}

/** Map one collaborator record to the project's repository-role vocabulary. */
function collaboratorRole(record: Record<string, unknown>, where: string): string {
  const roleName = typeof record["role_name"] === "string" ? record["role_name"] : "";
  const mappedRoleName = ROLE_NAME[roleName];
  if (mappedRoleName !== undefined) {
    return mappedRoleName;
  }
  const permission = typeof record["permission"] === "string" ? record["permission"] : "";
  const mappedPermission = ROLE_NAME[permission];
  if (mappedPermission !== undefined) {
    return mappedPermission;
  }
  const permissions = record["permissions"];
  if (typeof permissions === "object" && permissions !== null) {
    const flags = permissions as Record<string, unknown>;
    if (flags["admin"] === true) return "admin";
    if (flags["maintain"] === true) return "maintain";
    if (flags["push"] === true) return "write";
    if (flags["triage"] === true) return "triage";
    if (flags["pull"] === true) return "read";
  }
  throw new NormalizationError(
    `github ${where} entry has no usable repository role (role_name=${JSON.stringify(roleName)})`,
  );
}

function subjectOf(
  record: Record<string, unknown>,
  where: string,
): { subject: string; login: string } {
  const id = record["id"];
  const subject =
    typeof id === "number" && Number.isFinite(id) ? String(id) : typeof id === "string" ? id : "";
  const login = typeof record["login"] === "string" ? record["login"] : "";
  if (subject === "" || login === "") {
    throw new NormalizationError(`github ${where} entry has no stable subject id or login`);
  }
  return { subject, login };
}

/**
 * Provenance of a row read from the collaborator endpoints.
 *
 * For an **organization** repository the collaborator list mixes direct
 * collaborators, team-inherited members, organization default-permission
 * members, and organization owners, and GitHub documents that the response
 * cannot distinguish an organization-level grant from a repository-level one.
 * Recording those rows as `direct_collaborator` would persist provenance the
 * provider never proved, so they are `effective_access`.
 *
 * A **personal-account** repository has no teams and no organization default
 * permissions, so the same endpoints do prove a direct grant there, and the
 * row keeps `direct_collaborator`.
 */
function collaboratorKind(repository: GitHubRepository): ProviderRoleSourceKind {
  return repository.owner_type === "organization" ? "effective_access" : "direct_collaborator";
}

const USER_AGENT = "AutoFixer-ProviderIntegration/1";

/** Guard against a provider that only ever answers with empty pages. */
const MAX_EMPTY_PAGES = 200;

export function createGitHubAdapter(options: GitHubAdapterOptions): ProviderAdapter {
  const coords: CanonicalRepositoryId = parseCanonicalRepositoryId(options.canonical_repository_id);
  if (coords.provider !== "github") {
    throw new MissingPermissionError(
      "visibility",
      `github adapter cannot address ${coords.canonical}`,
    );
  }
  const base = githubApiBaseUrl(options);
  const repoPath = githubRepositoryPath(coords);
  const perPage = Math.min(Math.max(options.per_page ?? 100, 1), 100);
  const pagesMax = Math.max(options.pages_max ?? 20, 1);
  const maxRetryAfterMs = options.max_retry_after_ms ?? 5_000;
  const http = options.http ?? createFetchHttpClient();

  const capabilities: ProviderAdapterCapabilities = {
    effective_permission_visibility: "full",
    pagination: { per_page_max: 100, pages_max: pagesMax },
    rate_limit: {
      requests_per_minute: options.requests_per_minute ?? 1_000,
      retry_after_supported: true,
    },
    required_token_scope: GITHUB_REQUIRED_TOKEN_SCOPE,
    checkout_capability: "read",
    delivery_capability: "scoped_write",
  };

  /**
   * One authenticated read. The credential is materialized inside the
   * boundary for the duration of the request only, and a single bounded
   * retry honors `Retry-After` when the caller supplied a sleep hook.
   */
  async function request(ctx: ProviderCallContext, url: string): Promise<ProviderHttpResponse> {
    const send = async (): Promise<ProviderHttpResponse> =>
      withServiceCredential(options.credentials, options.credential_ref, (secret) =>
        http({
          url,
          headers: {
            Authorization: `Bearer ${secret}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
          },
        }),
      );

    let response = await send();
    const wait = retryAfterMs(response.headers);
    if (
      ctx.sleep !== undefined &&
      wait !== undefined &&
      wait <= maxRetryAfterMs &&
      (response.status === 429 || response.status === 503)
    ) {
      await ctx.sleep(wait);
      response = await send();
    }
    return response;
  }

  /**
   * Read the repository itself: identity and owner type.
   *
   * `GET /repos/{owner}/{repo}` is the canonical GitHub repository read —
   * never `/repositories/github:<owner>/<repo>`. A 404 here means the
   * integration is bound to a repository this credential cannot see, which is
   * a visibility failure (fail closed, keep prior authority), not an empty
   * roster and not a removal.
   *
   * The owner type decides the roster sources: an organization repository also
   * has organization owners (`/orgs/{owner}/members` exists), while a
   * personal-account repository has no such endpoint — its complete roster is
   * the collaborator list alone. Querying `/orgs/{user}` for a personal repo
   * answers 404 and must not turn the whole reconciliation into an outage.
   *
   * The result is memoized: repository identity is immutable for an
   * integration, and a failed check is not cached.
   */
  let metadata: Promise<GitHubRepository> | null = null;

  function ensureRepositoryVisible(ctx: ProviderCallContext): Promise<GitHubRepository> {
    if (metadata !== null) {
      return metadata;
    }
    const url = `${base}/repos/${repoPath}`;
    const pending = (async (): Promise<GitHubRepository> => {
      const response = await request(ctx, url);
      assertProviderStatus("github", response, url);
      if (response.status === 404) {
        throw new MissingPermissionError(
          "visibility",
          `github repository ${coords.canonical} is not visible to this integration (HTTP 404)`,
        );
      }
      const payload = parseJsonBody<Record<string, unknown>>(response.body, url);
      const owner =
        typeof payload["owner"] === "object" && payload["owner"] !== null
          ? (payload["owner"] as Record<string, unknown>)
          : {};
      const ownerType = typeof owner["type"] === "string" ? owner["type"] : "";
      if (ownerType !== "Organization" && ownerType !== "User") {
        throw new ProviderUnavailableError(
          "unexpected_status",
          `github repository payload for ${url} has no usable owner.type`,
        );
      }
      return {
        owner_type: ownerType === "Organization" ? "organization" : "user",
        owner_login: typeof owner["login"] === "string" ? owner["login"] : coords.owner,
      };
    })();
    metadata = pending;
    pending.catch(() => {
      metadata = null;
    });
    return pending;
  }

  /**
   * One provider page per source. Empty pages are skipped by {@link fetchPage}
   * before they leave the adapter: `collectRoster` treats "no entries but more
   * data" as a dropped tail, which is right — so an empty source must be
   * walked past internally instead of surfacing as a page.
   */
  async function fetchOnePage(ctx: ProviderCallContext, cursor: GitHubCursor): Promise<RosterPage> {
    const repository = await ensureRepositoryVisible(ctx);
    const query = `per_page=${String(perPage)}&page=${String(cursor.page)}`;
    const url =
      cursor.source === "collaborators"
        ? `${base}/repos/${repoPath}/collaborators?${query}`
        : `${base}/orgs/${encodeURIComponent(repository.owner_login)}/members?role=admin&${query}`;

    const response = await request(ctx, url);
    assertProviderStatus("github", response, url);

    const records = parseJsonArray(response.body, url);
    const rateLimit = readRateLimit(response.headers, "github");
    const fullPage = records.length >= perPage;
    const hasMore = linkHasNext(response.headers) || fullPage;

    // A full page with an exhausted budget cannot be continued.
    assertRateLimitBudget(rateLimit, hasMore, url);

    const entries: RawProviderRole[] =
      cursor.source === "collaborators"
        ? records.map((record) => {
            const { subject, login } = subjectOf(record, "collaborator");
            return {
              subject,
              login,
              kind: collaboratorKind(repository),
              provider_role: collaboratorRole(record, "collaborator"),
              authority_ref: `repository:${coords.path}`,
              inherited_from: null,
            };
          })
        : records.map((record) => {
            const { subject, login } = subjectOf(record, "organization owner");
            return {
              subject,
              login,
              kind: "org_owner",
              provider_role: "owner",
              authority_ref: `organization:${coords.owner}`,
              inherited_from: null,
            };
          });

    // Only an organization repository has organization owners to enumerate;
    // for a personal repository the collaborator list is the complete roster.
    const sources: GitHubCursor["source"][] =
      repository.owner_type === "organization"
        ? ["collaborators", "org_owners"]
        : ["collaborators"];
    const nextSource = sources[sources.indexOf(cursor.source) + 1];

    let next: GitHubCursor | null = null;
    if (hasMore) {
      next = { source: cursor.source, page: cursor.page + 1 };
    } else if (nextSource !== undefined) {
      next = { source: nextSource, page: 1 };
    }

    return {
      entries,
      has_more: next !== null,
      next_cursor: next === null ? null : encodeCursor(next),
      rate_limit: rateLimit,
    };
  }

  async function fetchPage(ctx: ProviderCallContext, cursor: GitHubCursor): Promise<RosterPage> {
    await ensureRepositoryVisible(ctx);
    let current: GitHubCursor = cursor;
    for (let skipped = 0; skipped < MAX_EMPTY_PAGES; skipped += 1) {
      const page = await fetchOnePage(ctx, current);
      if (page.entries.length > 0 || !page.has_more || page.next_cursor === null) {
        return page;
      }
      current = decodeCursor(page.next_cursor);
    }
    throw new IncompleteRosterError(
      "pagination_limit",
      "github roster returned an implausible run of empty pages",
    );
  }

  return {
    provider_type: "github",
    capabilities,
    async fetchRosterPage(
      ctx: ProviderCallContext,
      _repository: RepositoryRef,
      cursor: string | null,
    ): Promise<RosterPage> {
      return fetchPage(
        ctx,
        cursor === null ? { source: "collaborators", page: 1 } : decodeCursor(cursor),
      );
    },
    async fetchEffectivePermission(
      ctx: ProviderCallContext,
      _repository: RepositoryRef,
      subject: string,
    ): Promise<RawProviderRole | null> {
      const repository = await ensureRepositoryVisible(ctx);
      const login = options.resolve_login?.(subject);
      if (login === undefined || login === "") {
        // Without the subject → login binding the adapter cannot ask the
        // provider at all. That is a visibility gap, never "no access".
        throw new MissingPermissionError(
          "permission_query",
          `no github login is bound to subject ${JSON.stringify(subject)}`,
        );
      }
      // `GET /collaborators/{login}/permission` returns 200 with
      // `{ permission, role_name, user }`. The sibling
      // `/collaborators/{login}` endpoint only answers 204 No Content for a
      // collaborator, so it cannot supply the role this fact needs — parsing
      // its empty body would look like a provider outage.
      const url = `${base}/repos/${repoPath}/collaborators/${encodeURIComponent(login)}/permission`;
      const response = await request(ctx, url);
      assertProviderStatus("github", response, url);
      if (response.status === 404) {
        // GitHub's documented answer for "this user is not a collaborator".
        return null;
      }
      if (response.status === 204) {
        // Defensive: a 204 carries no role. Knowing someone has *some* access
        // while being unable to name it is a visibility gap, never a removal.
        throw new MissingPermissionError(
          "permission_query",
          `github answered 204 without a role for ${url}; the permission cannot be determined`,
        );
      }
      const record = parseJsonBody<Record<string, unknown>>(response.body, url);
      return {
        subject,
        login,
        kind: collaboratorKind(repository),
        provider_role: collaboratorRole(record, "collaborator"),
        authority_ref: `repository:${coords.path}`,
        inherited_from: null,
      };
    },
  };
}
