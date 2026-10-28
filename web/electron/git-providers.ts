/**
 * Git provider REST access for the workbench main process.
 *
 * Account tokens stay in the main process: the renderer only ever receives
 * the projections exported here (repository and branch names, provider
 * identities). Every call validates its target against the bound account's
 * instance origin before a token is attached, so a crafted repository name
 * can never redirect a credential to another host.
 */

import type { StoredAccount } from "./settings-store.js";

/** A repository the bound account can see, renderer-safe. */
export interface RepositorySummary {
  /** Canonical task-scoped id, e.g. `github:owner/repo` or `gitlab:group/proj`. */
  id: string;
  provider: "github" | "gitlab";
  owner: string;
  name: string;
  defaultBranch: string | null;
  private: boolean;
}

/** A branch of one repository, renderer-safe. */
export interface BranchSummary {
  name: string;
  isDefault: boolean;
}

export interface ProviderClientDeps {
  fetchImpl?: typeof fetch;
  /** Clock injection point for tests. */
  now?: () => Date;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 5;
const PER_PAGE = 100;

export class ProviderApiError extends Error {
  readonly kind: "auth" | "not_found" | "rate_limited" | "network" | "invalid";

  constructor(kind: ProviderApiError["kind"], message: string) {
    super(message);
    this.name = "ProviderApiError";
    this.kind = kind;
  }
}

/** Validate and normalize a provider origin URL. */
export function normalizeInstanceUrl(
  provider: "github" | "gitlab",
  value: string | undefined,
): string {
  const fallback = provider === "github" ? "https://github.com" : "https://gitlab.com";
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return fallback;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProviderApiError("invalid", "Instance URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ProviderApiError("invalid", "Instance URL must use https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProviderApiError("invalid", "Instance URL must not carry credentials.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ProviderApiError("invalid", "Instance URL must be an origin without a path.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ProviderApiError("invalid", "Instance URL must not carry a query or fragment.");
  }
  return url.origin;
}

/** API base for provider REST calls (web origin → api origin). */
export function apiBaseUrl(provider: "github" | "gitlab", instanceUrl: string): string {
  if (provider === "github") {
    // GitHub Enterprise keeps its REST API under /api/v3 on the same host.
    const origin = new URL(instanceUrl).origin;
    return origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`;
  }
  return `${new URL(instanceUrl).origin}/api/v4`;
}

/** Canonical task-scoped repository id from provider coordinates. */
export function repositoryIdFor(
  provider: "github" | "gitlab",
  owner: string,
  name: string,
): string {
  return `${provider}:${owner}/${name}`;
}

/** Split a task-scoped repository id back into provider coordinates. */
export function parseRepositoryId(
  id: string,
): { provider: "github" | "gitlab"; owner: string; name: string } | null {
  const match = /^(github|gitlab):(.+)\/([^/]+)$/.exec(id.trim());
  if (!match) return null;
  return { provider: match[1] as "github" | "gitlab", owner: match[2], name: match[3] };
}

export function createProviderClient(deps: ProviderClientDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  async function requestJson(
    account: StoredAccount,
    apiBase: string,
    pathSegments: string[],
    query: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const url = new URL(`${apiBase}/${pathSegments.map(encodeSegment).join("/")}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    // apiBase is always derived from the account's validated instanceUrl
    // (see apiBaseUrl), so pinning the request to the API base keeps the
    // token on the bound instance's API origin even if a crafted owner or
    // repository name tried to redirect the request.
    assertApiOrigin(apiBase, url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: authHeaders(account),
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        const rateLimited =
          response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
        throw new ProviderApiError(
          rateLimited ? "rate_limited" : "auth",
          rateLimited
            ? "Provider rate limit reached; try again later."
            : "The provider rejected the stored token.",
        );
      }
      if (response.status === 404) {
        throw new ProviderApiError(
          "not_found",
          "The provider returned not-found for this request.",
        );
      }
      if (!response.ok) {
        throw new ProviderApiError("network", `Provider responded with HTTP ${response.status}.`);
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ProviderApiError("network", "Provider returned a non-JSON response.");
      }
      return { status: response.status, json };
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw new ProviderApiError(
        "network",
        error instanceof Error && error.name === "AbortError"
          ? "The provider request timed out."
          : "The provider could not be reached.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verify a token by reading the authenticated identity. */
  async function verifyAccount(
    provider: "github" | "gitlab",
    instanceUrl: string,
    token: string,
  ): Promise<{ login: string }> {
    const account: StoredAccount = {
      id: "acct_0000000000000000",
      provider,
      instanceUrl,
      login: "",
      token,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    const apiBase = apiBaseUrl(provider, instanceUrl);
    if (provider === "github") {
      const { json } = await requestJson(account, apiBase, ["user"]);
      const login = field(json, "login");
      if (!login) throw new ProviderApiError("auth", "GitHub returned no login for this token.");
      return { login };
    }
    const { json } = await requestJson(account, apiBase, ["user"]);
    const login = field(json, "username");
    if (!login) throw new ProviderApiError("auth", "GitLab returned no username for this token.");
    return { login };
  }

  /** List repositories the account can see (first MAX_PAGES * PER_PAGE). */
  async function listRepositories(account: StoredAccount): Promise<RepositorySummary[]> {
    const apiBase = apiBaseUrl(account.provider, account.instanceUrl);
    const summaries: RepositorySummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (account.provider === "github") {
        const { json } = await requestJson(account, apiBase, ["user", "repos"], {
          per_page: String(PER_PAGE),
          page: String(page),
          sort: "full_name",
          affiliation: "owner,collaborator,organization_member",
        });
        if (!Array.isArray(json)) break;
        for (const entry of json) {
          const summary = githubRepositorySummary(entry);
          if (summary) summaries.push(summary);
        }
        if (json.length < PER_PAGE) break;
      } else {
        const { json } = await requestJson(account, apiBase, ["projects"], {
          per_page: String(PER_PAGE),
          page: String(page),
          membership: "true",
          simple: "true",
          order_by: "name",
        });
        if (!Array.isArray(json)) break;
        for (const entry of json) {
          const summary = gitlabRepositorySummary(entry);
          if (summary) summaries.push(summary);
        }
        if (json.length < PER_PAGE) break;
      }
    }
    return summaries;
  }

  /** List branches of one repository the account can see. */
  async function listBranches(
    account: StoredAccount,
    repositoryId: string,
  ): Promise<BranchSummary[]> {
    const parsed = parseRepositoryId(repositoryId);
    if (!parsed || parsed.provider !== account.provider) {
      throw new ProviderApiError(
        "invalid",
        "The selected repository does not belong to this account's provider.",
      );
    }
    const apiBase = apiBaseUrl(account.provider, account.instanceUrl);
    const names: Array<{ name: string; isDefault: boolean }> = [];
    if (account.provider === "github") {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { json } = await requestJson(
          account,
          apiBase,
          ["repos", parsed.owner, parsed.name, "branches"],
          { per_page: String(PER_PAGE), page: String(page) },
        );
        if (!Array.isArray(json)) break;
        for (const entry of json) {
          const name = field(entry, "name");
          if (name) names.push({ name, isDefault: false });
        }
        if (json.length < PER_PAGE) break;
      }
      const defaultBranch = await githubDefaultBranch(account, apiBase, parsed.owner, parsed.name);
      for (const entry of names) entry.isDefault = entry.name === defaultBranch;
    } else {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { json } = await requestJson(
          account,
          apiBase,
          ["projects", `${parsed.owner}/${parsed.name}`, "repository", "branches"],
          { per_page: String(PER_PAGE), page: String(page) },
        );
        if (!Array.isArray(json)) break;
        for (const entry of json) {
          const name = field(entry, "name");
          if (name) {
            names.push({ name, isDefault: booleanField(entry, "default") });
          }
        }
        if (json.length < PER_PAGE) break;
      }
    }
    return names;
  }

  async function githubDefaultBranch(
    account: StoredAccount,
    apiBase: string,
    owner: string,
    name: string,
  ): Promise<string | null> {
    try {
      const { json } = await requestJson(account, apiBase, ["repos", owner, name]);
      return field(json, "default_branch");
    } catch {
      return null;
    }
  }

  return { verifyAccount, listRepositories, listBranches };
}

export type ProviderClient = ReturnType<typeof createProviderClient>;

function authHeaders(account: StoredAccount): Record<string, string> {
  if (account.provider === "github") {
    return {
      Authorization: `Bearer ${account.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ForgePilot-Workbench",
    };
  }
  return { "PRIVATE-TOKEN": account.token, "User-Agent": "ForgePilot-Workbench" };
}

/**
 * Refuse any request that leaves the API origin derived from the bound
 * instance. This keeps a hostile repository/owner name from exfiltrating
 * the stored token to another host.
 */
function assertApiOrigin(apiBase: string, url: URL): void {
  if (url.origin !== new URL(apiBase).origin) {
    throw new ProviderApiError(
      "invalid",
      "Refusing a provider request off the bound instance origin.",
    );
  }
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function field(value: unknown, name: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>)[name];
  return typeof raw === "string" && raw !== "" ? raw : null;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)[name] === true;
}

function githubRepositorySummary(entry: unknown): RepositorySummary | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const fullName = typeof record["full_name"] === "string" ? record["full_name"] : null;
  if (!fullName || !fullName.includes("/")) return null;
  const separator = fullName.indexOf("/");
  return {
    id: repositoryIdFor("github", fullName.slice(0, separator), fullName.slice(separator + 1)),
    provider: "github",
    owner: fullName.slice(0, separator),
    name: fullName.slice(separator + 1),
    defaultBranch: field(record, "default_branch"),
    private: record["private"] === true,
  };
}

function gitlabRepositorySummary(entry: unknown): RepositorySummary | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const pathWithNamespace =
    typeof record["path_with_namespace"] === "string" ? record["path_with_namespace"] : null;
  if (!pathWithNamespace || !pathWithNamespace.includes("/")) return null;
  // GitLab namespaces can nest (group/subgroup/project), so the project
  // name is the last segment and the owner is everything before it.
  const separator = pathWithNamespace.lastIndexOf("/");
  return {
    id: repositoryIdFor(
      "gitlab",
      pathWithNamespace.slice(0, separator),
      pathWithNamespace.slice(separator + 1),
    ),
    provider: "gitlab",
    owner: pathWithNamespace.slice(0, separator),
    name: pathWithNamespace.slice(separator + 1),
    defaultBranch: field(record, "default_branch"),
    private: field(record, "visibility") !== "public",
  };
}
