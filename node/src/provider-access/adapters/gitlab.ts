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
 *
 * **Invited (shared) groups (DAT-248).** A project can also be invited to a
 * group, and only that group's members (direct ones plus the members it
 * inherits from its own parents) reach the project through it — subgroup
 * members do not, and an invited member keeps the lower of their group role
 * and the granted share level. Those members are enumerated from the invited
 * group's own membership (`/groups/:id/members/all`) and recorded as that
 * group: `group` with `group:<id>` as `authority_ref`, which is never the
 * project's own group id.
 *
 * Visibility is therefore declared **partial**, not full. What this adapter
 * proves: direct project members, the project's own group, its ancestor
 * groups, and the invited groups' members. What it cannot prove from these
 * endpoints: members of groups that are themselves shared with an invited
 * group, and share links whose expiry the project payload does not report.
 * Those gaps are why `reconcile` never treats absence from this roster as
 * removal (see `reconcile.ts`), and why the aggregated per-subject query is
 * still consulted before any subject is called removed.
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
  source: "project_members" | "group_members" | "shared_group_members";
  /** Which entry of the discovered group chain this page belongs to. */
  group_index: number;
  page: number;
}

interface GitLabGroup {
  id: string;
  /** Group full path, e.g. `acme/platform`. */
  path: string;
}

interface GitLabSharedGroup extends GitLabGroup {
  /** Access level the project grants to the invited group (`group_access_level`). */
  access_level: number;
}

interface GitLabRepository {
  project_id: string;
  /** Nearest first: the project's own group, then each ancestor. */
  groups: GitLabGroup[];
  /** Invited (shared) groups, ordered by path for reproducible cursors. */
  shared_groups: GitLabSharedGroup[];
}

const CURSOR_VERSION = 2;

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
    (source !== "project_members" &&
      source !== "group_members" &&
      source !== "shared_group_members") ||
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
  return roleForLevel(accessLevel(record, where), where);
}

/** Numeric access level of one record, or a normalization failure. */
function accessLevel(record: Record<string, unknown>, where: string): number {
  const level = record["access_level"];
  const numeric = typeof level === "number" ? level : Number.parseInt(stringValue(level), 10);
  if (!Number.isFinite(numeric)) {
    throw new NormalizationError(`gitlab ${where} entry has no access_level`);
  }
  return numeric;
}

/** Map one numeric access level to this adapter's role vocabulary. */
function roleForLevel(numeric: number, where: string): string | undefined {
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

/** Access levels that map onto repository role vocabulary, ascending. */
const KNOWN_ACCESS_LEVELS: readonly number[] = Object.freeze([10, 20, 30, 40, 50]);

/**
 * Every access level GitLab actually assigns, including the two this adapter
 * cannot express as a repository role.
 */
const GITLAB_ACCESS_LEVELS: ReadonlySet<number> = new Set<number>([
  SKIPPED_ACCESS_LEVEL,
  ...KNOWN_ACCESS_LEVELS,
  15, // Planner
  25, // Security Manager
]);

/**
 * Reduce a GitLab access level to one this adapter can express without ever
 * overstating it. Planner (15) and Security Manager (25) have no repository
 * role in the provider vocabulary, so they are floored to the next lower role
 * (guest / reporter). A level GitLab never assigns is refused instead of
 * guessed, because flooring an arbitrary number could land on a *higher* role.
 *
 * Both the granted share level and an invited member's own level go through
 * this: a Planner in an invited group must not abort the whole roster.
 */
function expressibleAccessLevel(level: number, where: string): number {
  if (level === 15) {
    return 10;
  }
  if (level === 25) {
    return 20;
  }
  if (!GITLAB_ACCESS_LEVELS.has(level)) {
    throw new NormalizationError(`gitlab ${where} entry has unknown access_level ${String(level)}`);
  }
  return level;
}

/**
 * Effective role of one member of an invited group: the lower of their role in
 * that group and the level the project granted to it (GitLab's own rule).
 * Both sides are floored to an expressible role first, so the recorded role
 * never exceeds what the member actually has on the project.
 */
function sharedGroupRole(
  record: Record<string, unknown>,
  where: string,
  grantedLevel: number,
): string | undefined {
  const memberLevel = expressibleAccessLevel(accessLevel(record, where), where);
  const granted = expressibleAccessLevel(grantedLevel, "invited group share");
  return roleForLevel(Math.min(memberLevel, granted), where);
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
    // DAT-248: invited (shared) groups are enumerated (see the header), but
    // members of nested shared groups and share-link expiry are not
    // observable from these endpoints. `partial` makes `reconcile` stop
    // treating absence from this roster as removal.
    effective_permission_visibility: "partial",
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

  /**
   * Invited groups of one project (`GET /projects/:id/invited_groups`),
   * paginated. This is the GitLab endpoint that lists groups a project is
   * shared with; `GET /projects/:id/groups` lists ancestor groups and must not
   * be used for this. `null` means the instance does not expose the endpoint
   * at all (older GitLab): the project payload's own `shared_with_groups`
   * then remains the source of truth.
   */
  async function discoverInvitedGroups(
    ctx: ProviderCallContext,
    projectId: string,
  ): Promise<GitLabGroup[] | null> {
    const collected: GitLabGroup[] = [];
    for (let page = 1; ; page += 1) {
      if (page > pagesMax) {
        // More invited groups than the declared fetch budget: the resulting
        // roster would silently miss members.
        throw new IncompleteRosterError(
          "pagination_limit",
          `gitlab invited-group discovery for ${coords.canonical} exceeded the page budget`,
        );
      }
      const url = `${base}/projects/${projectId}/invited_groups?per_page=${String(perPage)}&page=${String(page)}`;
      const response = await request(ctx, url);
      assertProviderStatus("gitlab", response, url);
      if (response.status === 404) {
        return null;
      }
      const records = parseJsonArray(response.body, url);
      for (const record of records) {
        const id = stringValue(record["id"]);
        if (id === "") {
          throw new MissingPermissionError(
            "visibility",
            `gitlab invited-group listing for ${coords.canonical} returned an entry without an id`,
          );
        }
        collected.push({ id, path: stringValue(record["full_path"]) });
      }
      const hasMore = hasNextPage(response, records.length);
      assertRateLimitBudget(readRateLimit(response.headers, "gitlab"), hasMore, url);
      if (!hasMore) {
        return collected;
      }
    }
  }

  /**
   * Invited (shared) groups with the access level the project grants each.
   *
   * Two GitLab payloads describe a share: the invited-group listing (see
   * {@link discoverInvitedGroups}) names the groups, and the project entity's
   * `shared_with_groups` is the only response that carries
   * `group_access_level`. A group only one of the two knows about is still
   * enumerated. A group whose granted level cannot be observed has no honest
   * member role (the member's own role is only an upper bound), so the
   * verification fails rather than overstating or understating authority;
   * `reconcile` then keeps the last fact instead of removing anyone.
   *
   * The invited listing never includes the project's own group or an ancestor
   * group, but the chain is filtered out anyway: a sub-optimal instance must
   * not be able to turn an ancestor into a duplicate roster source.
   */
  async function discoverSharedGroups(
    ctx: ProviderCallContext,
    projectId: string,
    project: Record<string, unknown>,
    chain: readonly GitLabGroup[],
  ): Promise<GitLabSharedGroup[]> {
    const granted = new Map<string, number>();
    const sharedWithGroups = project["shared_with_groups"];
    if (Array.isArray(sharedWithGroups)) {
      for (const entry of sharedWithGroups) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const id = stringValue(record["group_id"]);
        if (id === "") {
          throw new MissingPermissionError(
            "visibility",
            `gitlab project ${coords.canonical} lists an invited group without an id`,
          );
        }
        const raw = record["group_access_level"];
        const level = typeof raw === "number" ? raw : Number.parseInt(stringValue(raw), 10);
        if (!Number.isFinite(level)) {
          throw new MissingPermissionError(
            "visibility",
            `gitlab project ${coords.canonical} invited group ${id} has no observable access level`,
          );
        }
        granted.set(id, level);
      }
    }

    const candidates = new Map<string, GitLabGroup>();
    for (const group of (await discoverInvitedGroups(ctx, projectId)) ?? []) {
      candidates.set(group.id, group);
    }
    // Invited groups the project payload knows about even when the listing
    // does not return them.
    for (const id of granted.keys()) {
      if (!candidates.has(id)) {
        candidates.set(id, { id, path: "" });
      }
    }

    const chainIds = new Set(chain.map((group) => group.id).filter((id) => id !== ""));
    const chainPaths = new Set(chain.map((group) => group.path).filter((path) => path !== ""));
    const shared: GitLabSharedGroup[] = [];
    for (const group of candidates.values()) {
      // Ancestor groups are already walked as their own chain entries (the
      // invited-group endpoint does not return them, but no instance may turn
      // one into a duplicate source).
      if (chainIds.has(group.id) || (group.path !== "" && chainPaths.has(group.path))) {
        continue;
      }
      const level = granted.get(group.id);
      if (level === undefined) {
        throw new MissingPermissionError(
          "visibility",
          `gitlab reports group ${group.path === "" ? group.id : group.path} (id ${group.id}) as invited to ${coords.canonical} but the project payload does not expose its granted access level`,
        );
      }
      shared.push({ id: group.id, path: group.path, access_level: level });
    }
    // Deterministic order: cursors stay reproducible between runs.
    shared.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    return shared;
  }

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

      return {
        project_id: projectId,
        groups,
        shared_groups: await discoverSharedGroups(ctx, projectId, project, groups),
      };
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
      const group =
        cursor.source === "group_members"
          ? repo.groups[cursor.group_index]
          : repo.shared_groups[cursor.group_index];
      if (group === undefined) {
        // A cursor pointing past the discovered chain cannot be continued.
        throw new IncompleteRosterError(
          "missing_cursor",
          `gitlab roster cursor references unknown group index ${String(cursor.group_index)}`,
        );
      }
      // `/members/all` includes the members an invited group inherits from its
      // own parents — GitLab grants them access to the shared project too.
      // Subgroup members are deliberately not implied: GitLab does not grant
      // them access to a project shared with their parent group.
      url =
        cursor.source === "group_members"
          ? `${base}/groups/${group.id}/members?${query}`
          : `${base}/groups/${group.id}/members/all?${query}`;
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
    } else if (cursor.source === "shared_group_members") {
      const shared = repo.shared_groups[cursor.group_index];
      if (shared === undefined) {
        throw new IncompleteRosterError(
          "missing_cursor",
          `gitlab roster cursor references unknown invited group index ${String(cursor.group_index)}`,
        );
      }
      for (const record of records) {
        if (!isActiveMember(record)) {
          continue;
        }
        const role = sharedGroupRole(record, "invited group member", shared.access_level);
        if (role === undefined) {
          continue;
        }
        const { subject, login } = memberSubject(record, "invited group member");
        // Provenance is the invited group itself — never the project's own
        // group, and never a fabricated direct grant.
        entries.push({
          subject,
          login,
          kind: "group",
          provider_role: role,
          authority_ref: `group:${shared.id}`,
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
    } else if (cursor.source === "project_members") {
      if (repo.groups.length > 0) {
        next = { source: "group_members", group_index: 0, page: 1 };
      } else if (repo.shared_groups.length > 0) {
        next = { source: "shared_group_members", group_index: 0, page: 1 };
      }
    } else if (cursor.source === "group_members") {
      if (cursor.group_index + 1 < repo.groups.length) {
        next = { source: "group_members", group_index: cursor.group_index + 1, page: 1 };
      } else if (repo.shared_groups.length > 0) {
        next = { source: "shared_group_members", group_index: 0, page: 1 };
      }
    } else if (cursor.group_index + 1 < repo.shared_groups.length) {
      next = { source: "shared_group_members", group_index: cursor.group_index + 1, page: 1 };
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
     * 3. each invited (shared) group → `group` with the invited group's own
     *    id, role reduced to the granted share level
     *
     * Only when no level claims the user is the aggregated endpoint
     * consulted. Its answer is recorded as `effective_access` — the provider
     * states the subject has access but the response cannot attribute it to a
     * project, group, ancestor group, or invited group. A 404 there is "no
     * access" (null); a provider that cannot be asked still throws, because a
     * failed query is never evidence of removal.
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

      // No level attributes the user: check each invited (shared) group.
      for (const shared of repo.shared_groups) {
        const sharedUrl = `${base}/groups/${shared.id}/members/all/${encodedSubject}`;
        const response = await request(ctx, sharedUrl);
        assertProviderStatus("gitlab", response, sharedUrl);
        if (response.status === 404) {
          continue;
        }
        const record = parseJsonBody<Record<string, unknown>>(response.body, sharedUrl);
        if (!isActiveMember(record)) {
          continue;
        }
        const providerRole = sharedGroupRole(record, "invited group member", shared.access_level);
        if (providerRole === undefined) {
          continue;
        }
        const { subject: resolved, login } = memberSubject(record, "invited group member");
        return {
          subject: resolved,
          login,
          kind: "group",
          provider_role: providerRole,
          authority_ref: `group:${shared.id}`,
          inherited_from: null,
        };
      }

      // No level attributes the user. Ask the aggregate endpoint whether they
      // have access at all — the answer decides between "no permission" and
      // "effective access this integration cannot attribute".
      const aggregateUrl = `${base}/projects/${repo.project_id}/members/all/${encodedSubject}`;
      const aggregate = await request(ctx, aggregateUrl);
      assertProviderStatus("gitlab", aggregate, aggregateUrl);
      if (aggregate.status === 404) {
        return null;
      }
      const aggregateRecord = parseJsonBody<Record<string, unknown>>(aggregate.body, aggregateUrl);
      if (!isActiveMember(aggregateRecord)) {
        return null;
      }
      const aggregateRole = memberRole(aggregateRecord, "effective project member");
      if (aggregateRole === undefined) {
        return null;
      }
      const effective = memberSubject(aggregateRecord, "effective project member");
      // The provider proved effective access but not its origin (for example
      // a group that is only shared with an invited group): record exactly
      // that, never a direct grant.
      return {
        subject: effective.subject,
        login: effective.login,
        kind: "effective_access",
        provider_role: aggregateRole,
        authority_ref: `project:${repo.project_id}`,
        inherited_from: null,
      };
    },
  };
}
