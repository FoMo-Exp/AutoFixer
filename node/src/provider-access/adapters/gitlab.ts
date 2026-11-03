/**
 * GitLab roster adapter (DAT-247).
 *
 * Real GitLab reads over a project (or group) access token with `read_api`
 * only — the read-only service-integration credential, never a user OAuth
 * token.
 *
 * Path handling is the subtle part. A GitLab project is addressed by its
 * full namespace path as ONE URL segment:
 * `gitlab:acme/platform/api` → `/api/v4/projects/acme%2Fplatform%2Fapi`.
 * The `gitlab:` prefix is addressing metadata and never appears in the URL.
 *
 * Inheritance is recorded the way `normalize.ts` models it rather than
 * flattened: direct project members are `direct_collaborator`, direct members
 * of the project's own group are `group`, and members reached through an
 * ancestor group are `inherited_role` with `inherited_from` naming the child
 * group the authority descends through. Provenance is therefore preserved per
 * level instead of inventing a source, and each level is a separate,
 * exact endpoint.
 */

import {
  gitlabProjectPath,
  parseCanonicalRepositoryId,
  type CanonicalRepositoryId,
} from "../canonical-repository.js";
import { withServiceCredential, type ServiceCredentialStore } from "../credentials.js";
import {
  assertProviderStatus,
  assertRateLimitBudget,
  createFetchHttpClient,
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

/** The only scope a roster adapter may hold. */
export const GITLAB_REQUIRED_TOKEN_SCOPE: readonly string[] = Object.freeze(["read_api"]);

/**
 * GitLab access levels. `5` (minimal access) cannot read repository content,
 * so it is not repository authority and is skipped rather than granted.
 */
const ACCESS_LEVEL: Readonly<Record<number, string>> = Object.freeze({
  10: "guest",
  20: "reporter",
  30: "developer",
  40: "maintainer",
  50: "owner",
});

const SKIPPED_ACCESS_LEVEL = 5;

export interface GitLabAdapterOptions {
  /** Canonical id, e.g. `gitlab:acme/platform/api`. */
  canonical_repository_id: string;
  credential_ref: string;
  credentials: ServiceCredentialStore;
  /** Defaults to `{provider_origin}/api/v4`, or `https://gitlab.com/api/v4`. */
  api_base_url?: string;
  provider_origin?: string;
  http?: ProviderHttpClient;
  per_page?: number;
  pages_max?: number;
  requests_per_minute?: number;
  max_retry_after_ms?: number;
}

interface GitLabCursor {
  source: "project_members" | "group_members";
  /** Which entry of the discovered group chain this page belongs to. */
  group_index: number;
  page: number;
}

interface GitLabGroup {
  id: string;
  /** Group full path, e.g. `acme/platform`. */
  path: string;
}

interface GitLabRepository {
  project_id: string;
  /** Neares first: the project's own group, then each ancestor. */
  groups: GitLabGroup[];
}

const CURSOR_VERSION = 1;

function encodeCursor(cursor: GitLabCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...cursor }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(raw: string): GitLabCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new IncompleteRosterError("missing_cursor", "gitlab roster cursor is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new IncompleteRosterError("missing_cursor", "gitlab roster cursor is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const source = record["source"];
  const page = record["page"];
  const groupIndex = record["group_index"] ?? 0;
  if (
    (source !== "project_members" && source !== "group_members") ||
    typeof page !== "number" ||
    !Number.isInteger(page) ||
    page < 1 ||
    typeof groupIndex !== "number" ||
    !Number.isInteger(groupIndex) ||
    groupIndex < 0
  ) {
    throw new IncompleteRosterError("missing_cursor", "gitlab roster cursor is not usable");
  }
  return { source, group_index: groupIndex, page };
}

/** Derive the GitLab API base from the approved provider-instance origin. */
export function gitlabApiBaseUrl(options: {
  api_base_url?: string;
  provider_origin?: string;
}): string {
  if (options.api_base_url !== undefined) {
    return options.api_base_url.replace(/\/+$/, "");
  }
  const origin =
    options.provider_origin === undefined || options.provider_origin === ""
      ? "https://gitlab.com"
      : options.provider_origin;
  return `${origin.replace(/\/+$/, "")}/api/v4`;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

/** Map a GitLab member record; `undefined` means "not repository authority". */
function memberRole(record: Record<string, unknown>, where: string): string | undefined {
  const level = record["access_level"];
  const numeric = typeof level === "number" ? level : Number.parseInt(stringValue(level), 10);
  if (!Number.isFinite(numeric)) {
    throw new NormalizationError(`gitlab ${where} entry has no access_level`);
  }
  if (numeric === SKIPPED_ACCESS_LEVEL) {
    return undefined; // minimal access cannot read repository content
  }
  const role = ACCESS_LEVEL[numeric];
  if (role === undefined) {
    throw new NormalizationError(
      `gitlab ${where} entry has unknown access_level ${String(numeric)}`,
    );
  }
  return role;
}

function memberSubject(
  record: Record<string, unknown>,
  where: string,
): { subject: string; login: string } {
  const subject = stringValue(record["id"]);
  const login = stringValue(record["username"]);
  if (subject === "" || login === "") {
    throw new NormalizationError(`gitlab ${where} entry has no stable subject id or username`);
  }
  return { subject, login };
}

function isActiveMember(record: Record<string, unknown>): boolean {
  const state = record["state"];
  return state === undefined || state === "active";
}

const USER_AGENT = "AutoFixer-ProviderIntegration/1";

/** Guard against a provider that only ever answers with empty pages. */
const MAX_EMPTY_PAGES = 200;

export function createGitLabAdapter(options: GitLabAdapterOptions): ProviderAdapter {
  const coords: CanonicalRepositoryId = parseCanonicalRepositoryId(options.canonical_repository_id);
  if (coords.provider !== "gitlab") {
    throw new MissingPermissionError(
      "visibility",
      `gitlab adapter cannot address ${coords.canonical}`,
    );
  }
  const base = gitlabApiBaseUrl(options);
  const projectPath = gitlabProjectPath(coords);
  const perPage = Math.min(Math.max(options.per_page ?? 100, 1), 100);
  const pagesMax = Math.max(options.pages_max ?? 20, 1);
  const maxRetryAfterMs = options.max_retry_after_ms ?? 5_000;
  const http = options.http ?? createFetchHttpClient();

  const capabilities: ProviderAdapterCapabilities = {
    effective_permission_visibility: "full",
    pagination: { per_page_max: 100, pages_max: pagesMax },
    rate_limit: {
      requests_per_minute: options.requests_per_minute ?? 2_000,
      retry_after_supported: true,
    },
    required_token_scope: GITLAB_REQUIRED_TOKEN_SCOPE,
    checkout_capability: "read",
    delivery_capability: "scoped_write",
  };

  async function request(ctx: ProviderCallContext, url: string): Promise<ProviderHttpResponse> {
    const send = async (): Promise<ProviderHttpResponse> =>
      withServiceCredential(options.credentials, options.credential_ref, (secret) =>
        http({
          url,
          headers: {
            "PRIVATE-TOKEN": secret,
            Accept: "application/json",
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
   * Project id and ancestor-group chain. Both are immutable provider ids, so
   * the discovery result is memoized per adapter; a failed discovery is not
   * cached. Without this the chain would have to ride inside every cursor.
   */
  let discovery: Promise<GitLabRepository> | null = null;

  function discover(ctx: ProviderCallContext): Promise<GitLabRepository> {
    if (discovery !== null) {
      return discovery;
    }
    const pending = (async (): Promise<GitLabRepository> => {
      const projectUrl = `${base}/projects/${projectPath}`;
      const projectResponse = await request(ctx, projectUrl);
      assertProviderStatus("gitlab", projectResponse, projectUrl);
      if (projectResponse.status === 404) {
        // The project is not visible to this credential at all. That is a
        // visibility failure, never a roster of zero members.
        throw new MissingPermissionError(
          "visibility",
          `gitlab project ${coords.canonical} is not visible to this integration (HTTP 404)`,
        );
      }
      const project = parseJsonBody<Record<string, unknown>>(projectResponse.body, projectUrl);
      const projectId = stringValue(project["id"]);
      if (projectId === "") {
        throw new ProviderUnavailableError(
          "unexpected_status",
          `gitlab project payload for ${projectUrl} has no id`,
        );
      }

      // The project's own namespace first, then each ancestor group.
      const namespace =
        typeof project["namespace"] === "object" && project["namespace"] !== null
          ? (project["namespace"] as Record<string, unknown>)
          : {};
      const namespacePath = stringValue(namespace["full_path"]);
      const namespaceId = stringValue(namespace["id"]);
      const groups: GitLabGroup[] = [];
      if (namespacePath !== "") {
        const segments = namespacePath.split("/").filter((segment) => segment !== "");
        const first = segments[0];
        if (first !== undefined) {
          groups.push({ id: namespaceId, path: namespacePath });
        }
        // Ancestors, nearest first: `acme/platform` then `acme`.
        for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
          const ancestorPath = segments.slice(0, depth).join("/");
          const groupUrl = `${base}/groups/${encodeURIComponent(ancestorPath)}`;
          const groupResponse = await request(ctx, groupUrl);
          assertProviderStatus("gitlab", groupResponse, groupUrl);
          if (groupResponse.status === 404) {
            // An ancestor group we cannot read hides an unknown number of
            // members who do have access to this project. Continuing would
            // hand `reconcile` a "complete" roster with those people missing,
            // and it would record them as `removed`. The verification must
            // fail instead: stale, nothing written.
            throw new MissingPermissionError(
              "visibility",
              `gitlab ancestor group ${ancestorPath} of ${coords.canonical} is not visible to this integration (HTTP 404)`,
            );
          }
          const group = parseJsonBody<Record<string, unknown>>(groupResponse.body, groupUrl);
          const groupId = stringValue(group["id"]);
          if (groupId === "") {
            // Without the id the group's members cannot be enumerated, which
            // is the same incompleteness as an unreadable group.
            throw new MissingPermissionError(
              "visibility",
              `gitlab ancestor group ${ancestorPath} of ${coords.canonical} returned no id`,
            );
          }
          groups.push({ id: groupId, path: ancestorPath });
        }
      }

      return { project_id: projectId, groups };
    })();
    discovery = pending;
    pending.catch(() => {
      discovery = null;
    });
    return pending;
  }

  /** `X-Next-Page` is GitLab's continuation marker. */
  function hasNextPage(response: ProviderHttpResponse, recordCount: number): boolean {
    const next = response.headers["x-next-page"];
    if (next !== undefined) {
      return next !== "";
    }
    // No header at all: a full page means more data may exist, so the fetch
    // must continue (and `pages_max` bounds it) instead of assuming the end.
    return recordCount >= perPage;
  }

  /**
   * One provider page per source. Empty pages are walked past internally
   * (see {@link fetchPage}) because `collectRoster` correctly refuses a page
   * that reports more data and delivers none.
   */
  async function fetchOnePage(ctx: ProviderCallContext, cursor: GitLabCursor): Promise<RosterPage> {
    const repo = await discover(ctx);
    const query = `per_page=${String(perPage)}&page=${String(cursor.page)}`;

    let url: string;
    if (cursor.source === "project_members") {
      url = `${base}/projects/${repo.project_id}/members?${query}`;
    } else {
      const group = repo.groups[cursor.group_index];
      if (group === undefined) {
        // A cursor pointing past the discovered chain cannot be continued.
        throw new IncompleteRosterError(
          "missing_cursor",
          `gitlab roster cursor references unknown group index ${String(cursor.group_index)}`,
        );
      }
      url = `${base}/groups/${group.id}/members?${query}`;
    }

    const response = await request(ctx, url);
    assertProviderStatus("gitlab", response, url);

    const records = parseJsonArray(response.body, url);
    const rateLimit = readRateLimit(response.headers, "gitlab");
    const hasMore = hasNextPage(response, records.length);
    assertRateLimitBudget(rateLimit, hasMore, url);

    const entries: RawProviderRole[] = [];
    if (cursor.source === "project_members") {
      for (const record of records) {
        if (!isActiveMember(record)) {
          continue;
        }
        const role = memberRole(record, "project member");
        if (role === undefined) {
          continue;
        }
        const { subject, login } = memberSubject(record, "project member");
        entries.push({
          subject,
          login,
          kind: "direct_collaborator",
          provider_role: role,
          authority_ref: `project:${repo.project_id}`,
          inherited_from: null,
        });
      }
    } else {
      const group = repo.groups[cursor.group_index];
      if (group === undefined) {
        throw new IncompleteRosterError(
          "missing_cursor",
          `gitlab roster cursor references unknown group index ${String(cursor.group_index)}`,
        );
      }
      const parent = repo.groups[cursor.group_index - 1];
      for (const record of records) {
        if (!isActiveMember(record)) {
          continue;
        }
        const role = memberRole(record, "group member");
        if (role === undefined) {
          continue;
        }
        const { subject, login } = memberSubject(record, "group member");
        // The project's own group grants access directly; an ancestor grants
        // it through the child group on the chain.
        const kind = cursor.group_index === 0 ? "group" : "inherited_role";
        entries.push({
          subject,
          login,
          kind,
          provider_role: role,
          authority_ref: `group:${group.id}`,
          inherited_from: kind === "group" || parent === undefined ? null : `group:${parent.id}`,
        });
      }
    }

    let next: GitLabCursor | null = null;
    if (hasMore) {
      next = { ...cursor, page: cursor.page + 1 };
    } else if (cursor.source === "project_members" && repo.groups.length > 0) {
      next = { source: "group_members", group_index: 0, page: 1 };
    } else if (cursor.source === "group_members" && cursor.group_index + 1 < repo.groups.length) {
      next = { source: "group_members", group_index: cursor.group_index + 1, page: 1 };
    }

    return {
      entries,
      has_more: next !== null,
      next_cursor: next === null ? null : encodeCursor(next),
      rate_limit: rateLimit,
    };
  }

  async function fetchPage(ctx: ProviderCallContext, cursor: GitLabCursor): Promise<RosterPage> {
    let current: GitLabCursor = cursor;
    for (let skipped = 0; skipped < MAX_EMPTY_PAGES; skipped += 1) {
      const page = await fetchOnePage(ctx, current);
      if (page.entries.length > 0 || !page.has_more || page.next_cursor === null) {
        return page;
      }
      current = decodeCursor(page.next_cursor);
    }
    throw new IncompleteRosterError(
      "pagination_limit",
      "gitlab roster returned an implausible run of empty pages",
    );
  }

  return {
    provider_type: "gitlab",
    capabilities,
    async fetchRosterPage(
      ctx: ProviderCallContext,
      _repository: RepositoryRef,
      cursor: string | null,
    ): Promise<RosterPage> {
      const decoded =
        cursor === null
          ? { source: "project_members" as const, group_index: 0, page: 1 }
          : decodeCursor(cursor);
      return fetchPage(ctx, decoded);
    },
    /**
     * One subject's effective permission, with **real** provenance.
     *
     * `/projects/:id/members/all/:user_id` returns the aggregated effective
     * permission without saying where it comes from. Recording that as a
     * direct project membership would fabricate provenance for everyone who
     * only reaches the project through a group, so the adapter instead asks
     * the source-identifying endpoints in order:
     *
     * 1. direct project membership → `direct_collaborator` / `project:<id>`
     * 2. each group on the ancestor chain, nearest first → `group` (own group)
     *    or `inherited_role` with `inherited_from` (ancestor group)
     *
     * Only when no level claims the user is the aggregated endpoint consulted,
     * to distinguish "no access" (404 → null) from "access exists but this
     * integration cannot attribute it" (throws: a visibility gap, never a
     * removal).
     */
    async fetchEffectivePermission(
      ctx: ProviderCallContext,
      _repository: RepositoryRef,
      subject: string,
    ): Promise<RawProviderRole | null> {
      const repo = await discover(ctx);
      const encodedSubject = encodeURIComponent(subject);

      const read = async (
        url: string,
        kind: ProviderRoleSourceKind,
        authorityRef: string,
        inheritedFrom: string | null,
      ): Promise<RawProviderRole | null> => {
        const response = await request(ctx, url);
        assertProviderStatus("gitlab", response, url);
        if (response.status === 404) {
          return null;
        }
        const record = parseJsonBody<Record<string, unknown>>(response.body, url);
        if (!isActiveMember(record)) {
          return null;
        }
        const role = memberRole(record, "member");
        if (role === undefined) {
          return null;
        }
        const { subject: resolved, login } = memberSubject(record, "member");
        return {
          subject: resolved,
          login,
          kind,
          provider_role: role,
          authority_ref: authorityRef,
          inherited_from: inheritedFrom,
        };
      };

      const direct = await read(
        `${base}/projects/${repo.project_id}/members/${encodedSubject}`,
        "direct_collaborator",
        `project:${repo.project_id}`,
        null,
      );
      if (direct !== null) {
        return direct;
      }

      for (let index = 0; index < repo.groups.length; index += 1) {
        const group = repo.groups[index];
        if (group === undefined) {
          continue;
        }
        const parent = repo.groups[index - 1];
        const member = await read(
          `${base}/groups/${group.id}/members/${encodedSubject}`,
          index === 0 ? "group" : "inherited_role",
          `group:${group.id}`,
          index === 0 || parent === undefined ? null : `group:${parent.id}`,
        );
        if (member !== null) {
          return member;
        }
      }

      // No level attributes the user. Ask the aggregate endpoint whether they
      // have access at all — the answer decides between "no permission" and
      // "cannot tell".
      const aggregateUrl = `${base}/projects/${repo.project_id}/members/all/${encodedSubject}`;
      const aggregate = await request(ctx, aggregateUrl);
      assertProviderStatus("gitlab", aggregate, aggregateUrl);
      if (aggregate.status === 404) {
        return null;
      }
      throw new MissingPermissionError(
        "permission_query",
        `gitlab reports access for subject ${JSON.stringify(subject)} on ${coords.canonical} but the integration cannot attribute it to a project, group, or ancestor group`,
      );
    },
  };
}
