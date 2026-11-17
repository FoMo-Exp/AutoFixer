/** Narrow GitHub/GitLab issue API adapter for the dedicated sync credential. */

import type { ProviderType } from "../control-plane/types.js";
import {
  withServiceCredential,
  type ServiceCredentialStore,
} from "../provider-access/credentials.js";
import {
  assertProviderStatus,
  createFetchHttpClient,
  parseJsonArray,
  parseJsonBody,
  type ProviderHttpClient,
} from "../provider-access/provider-http.js";
import { parseCanonicalRepositoryId } from "../provider-access/canonical-repository.js";
import { githubApiBaseUrl } from "../provider-access/adapters/github.js";
import { gitlabApiBaseUrl } from "../provider-access/adapters/gitlab.js";

export interface ProviderIssue {
  id: string;
  number: string;
  url: string;
  title: string;
  description: string;
  state: "open" | "closed";
  labels: string[];
  updated_at: string;
}

export interface ProviderIssueComment {
  id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface IssueFieldsPatch {
  title?: string;
  description?: string;
  state?: "open" | "closed";
  labels?: string[];
}

export interface CreateProviderIssueInput {
  title: string;
  description: string;
  labels?: string[];
}

export interface ProviderIssueApi {
  readonly provider: ProviderType;
  createIssue(input: CreateProviderIssueInput): Promise<ProviderIssue>;
  getIssue(issueId: string): Promise<ProviderIssue>;
  listIssues(updatedSince?: string): Promise<ProviderIssue[]>;
  updateIssue(issueId: string, patch: IssueFieldsPatch): Promise<ProviderIssue>;
  listComments(issueId: string): Promise<ProviderIssueComment[]>;
  createComment(issueId: string, body: string): Promise<ProviderIssueComment>;
}

export interface IssueSyncAdapterOptions {
  repository_id: string;
  issue_sync_credential_ref: string;
  credentials: ServiceCredentialStore;
  provider_origin?: string;
  /** Test/deployment override; still constrained to HTTPS and this base origin. */
  api_base_url?: string;
  http?: ProviderHttpClient;
}

type JsonObject = Record<string, unknown>;

export function createProviderIssueApi(options: IssueSyncAdapterOptions): ProviderIssueApi {
  const repository = parseCanonicalRepositoryId(options.repository_id);
  const provider = repository.provider;
  if (!options.issue_sync_credential_ref) {
    throw new Error("issue-sync credential reference is required");
  }
  const apiBase =
    provider === "github"
      ? githubApiBaseUrl({
          ...(options.api_base_url ? { api_base_url: options.api_base_url } : {}),
          ...(options.provider_origin ? { provider_origin: options.provider_origin } : {}),
        })
      : gitlabApiBaseUrl({
          ...(options.api_base_url ? { api_base_url: options.api_base_url } : {}),
          ...(options.provider_origin ? { provider_origin: options.provider_origin } : {}),
        });
  const base = new URL(apiBase);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("issue-sync provider API base must be a clean HTTPS URL");
  }
  const transport = options.http ?? createFetchHttpClient();
  const githubPath = `/repos/${repository.path}/issues`;
  const gitlabPath = `/projects/${encodeURIComponent(repository.path)}/issues`;
  const issueCollectionPath = provider === "github" ? githubPath : gitlabPath;

  function issueUrl(suffix = ""): string {
    return `${base.origin}${base.pathname.replace(/\/$/, "")}${issueCollectionPath}${suffix}`;
  }

  function issueItemPath(issueId: string): string {
    if (!/^\d+$/.test(issueId)) throw new Error("provider issue ID must be numeric");
    return `/${issueId}`;
  }

  async function request<T>(
    url: string,
    method: "GET" | "POST" | "PATCH",
    body?: Record<string, unknown>,
  ): Promise<T> {
    const parsed = new URL(url);
    if (
      parsed.origin !== base.origin ||
      !parsed.pathname.startsWith(base.pathname.replace(/\/$/, ""))
    ) {
      throw new Error("issue-sync request escaped the configured provider API origin");
    }
    return withServiceCredential(
      options.credentials,
      options.issue_sync_credential_ref,
      async (secret) => {
        const response = await transport({
          url,
          method,
          headers:
            provider === "github"
              ? {
                  Accept: "application/vnd.github+json",
                  Authorization: `Bearer ${secret}`,
                  "X-GitHub-Api-Version": "2022-11-28",
                  ...(body ? { "Content-Type": "application/json" } : {}),
                }
              : {
                  "PRIVATE-TOKEN": secret,
                  ...(body ? { "Content-Type": "application/json" } : {}),
                },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assertProviderStatus(provider, response, url);
        if (response.status === 404) throw new Error("provider issue was not found");
        return parseJsonBody<T>(response.body, url);
      },
    );
  }

  return {
    provider,
    async createIssue(input) {
      const payload =
        provider === "github"
          ? { title: input.title, body: input.description, labels: input.labels ?? [] }
          : {
              title: input.title,
              description: input.description,
              labels: (input.labels ?? []).join(","),
            };
      return mapIssue(await request<JsonObject>(issueUrl(), "POST", payload), provider);
    },
    async getIssue(issueId) {
      return mapIssue(await request<JsonObject>(issueUrl(issueItemPath(issueId)), "GET"), provider);
    },
    async listIssues(updatedSince) {
      const result: ProviderIssue[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const params = new URLSearchParams({ state: "all", per_page: "100", page: String(page) });
        if (provider === "github") params.set("sort", "updated");
        if (updatedSince)
          params.set(provider === "github" ? "since" : "updated_after", updatedSince);
        const url = `${issueUrl()}?${params.toString()}`;
        const raw = await getRaw(url);
        const rows = parseJsonArray(raw.body, url);
        result.push(
          ...rows
            // GitHub's issues endpoint includes pull requests; they are not issues.
            .filter((row) => provider !== "github" || !Object.hasOwn(row, "pull_request"))
            .map((row) => mapIssue(row, provider)),
        );
        if (rows.length < 100) break;
      }
      return result;
    },
    async updateIssue(issueId, patch) {
      const payload: Record<string, unknown> = {};
      if (patch.title !== undefined) payload.title = patch.title;
      if (patch.description !== undefined)
        payload[provider === "github" ? "body" : "description"] = patch.description;
      if (patch.labels !== undefined)
        payload.labels = provider === "github" ? patch.labels : patch.labels.join(",");
      if (patch.state !== undefined) {
        if (provider === "github") payload.state = patch.state;
        else payload.state_event = patch.state === "closed" ? "close" : "reopen";
      }
      return mapIssue(
        await request<JsonObject>(issueUrl(issueItemPath(issueId)), "PATCH", payload),
        provider,
      );
    },
    async listComments(issueId) {
      const comments: ProviderIssueComment[] = [];
      for (let page = 1; page <= 100; page += 1) {
        const collection =
          provider === "github"
            ? `${issueUrl(issueItemPath(issueId))}/comments`
            : `${base.origin}${base.pathname.replace(/\/$/, "")}/projects/${encodeURIComponent(repository.path)}/issues/${issueId}/notes`;
        const url = `${collection}?per_page=100&page=${page}`;
        const rows = parseJsonArray((await getRaw(url)).body, url);
        comments.push(...rows.map((row) => mapComment(row, provider)));
        if (rows.length < 100) break;
      }
      return comments;
    },
    async createComment(issueId, body) {
      const url =
        provider === "github"
          ? `${issueUrl(issueItemPath(issueId))}/comments`
          : `${base.origin}${base.pathname.replace(/\/$/, "")}/projects/${encodeURIComponent(repository.path)}/issues/${issueId}/notes`;
      const payload = provider === "github" ? { body } : { body };
      return mapComment(await request<JsonObject>(url, "POST", payload), provider);
    },
  };

  async function getRaw(url: string): Promise<{ body: string }> {
    const parsed = new URL(url);
    if (parsed.origin !== base.origin)
      throw new Error("issue-sync request escaped provider origin");
    return withServiceCredential(
      options.credentials,
      options.issue_sync_credential_ref,
      async (secret) => {
        const response = await transport({
          url,
          method: "GET",
          headers:
            provider === "github"
              ? {
                  Accept: "application/vnd.github+json",
                  Authorization: `Bearer ${secret}`,
                  "X-GitHub-Api-Version": "2022-11-28",
                }
              : { "PRIVATE-TOKEN": secret },
        });
        assertProviderStatus(provider, response, url);
        return { body: response.body };
      },
    );
  }
}

function mapIssue(row: JsonObject, provider: ProviderType): ProviderIssue {
  const id = stringValue(row[provider === "github" ? "number" : "iid"]);
  const title = stringValue(row["title"]);
  const updated = stringValue(row["updated_at"]);
  if (!id || !title || !Number.isFinite(Date.parse(updated))) {
    throw new Error("provider issue response is missing required identity or timestamp fields");
  }
  const rawLabels = row["labels"];
  const labels = Array.isArray(rawLabels)
    ? rawLabels.map((label) =>
        typeof label === "string" ? label : stringValue((label as JsonObject)["name"]),
      )
    : [];
  const state = row["state"] === "closed" ? "closed" : "open";
  return {
    // The Issues APIs address updates by issue number (GitHub) or IID (GitLab),
    // not by the provider's internal database ID.
    id,
    number: id,
    url: stringValue(row["html_url"] ?? row["web_url"]),
    title,
    description: stringValue(row[provider === "github" ? "body" : "description"]),
    state,
    labels,
    updated_at: new Date(updated).toISOString(),
  };
}

function mapComment(row: JsonObject, provider: ProviderType): ProviderIssueComment {
  const id = stringValue(row["id"]);
  const body = stringValue(row[provider === "github" ? "body" : "body"]);
  const createdAt = stringValue(row["created_at"]);
  if (!id || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("provider comment response is missing required identity or timestamp fields");
  }
  const user = row["user"] ?? row["author"];
  const author =
    typeof user === "object" && user !== null
      ? stringValue((user as JsonObject)["login"] ?? (user as JsonObject)["username"])
      : "unknown";
  const updatedAt = stringValue(row["updated_at"] ?? row["last_edited_at"] ?? createdAt);
  return {
    id,
    author,
    body,
    created_at: new Date(createdAt).toISOString(),
    updated_at: Number.isFinite(Date.parse(updatedAt))
      ? new Date(updatedAt).toISOString()
      : new Date(createdAt).toISOString(),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
