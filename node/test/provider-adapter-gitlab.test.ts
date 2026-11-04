/**
 * GitLab adapter tests (DAT-247).
 *
 * The encoded project path is the crux: a GitLab project is ONE URL segment,
 * so `gitlab:acme/platform/api` must become `/api/v4/projects/acme%2Fplatform%2Fapi`
 * — never `/api/v4/projects/gitlab:acme/platform/api` and never an
 * unencoded nested path.
 */

import { afterEach, describe, expect, test } from "vitest";

import { collectRoster, fetchEffectivePermission } from "../src/provider-access/adapter.js";
import { createGitLabAdapter, gitlabApiBaseUrl } from "../src/provider-access/adapters/gitlab.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import {
  IncompleteRosterError,
  MissingPermissionError,
  NormalizationError,
  ProviderUnavailableError,
  type ProviderCallContext,
  type RepositoryRef,
} from "../src/provider-access/types.js";
import { exactRoutes, startFakeProvider, type FakeProvider } from "./helpers/fake-provider.js";

const SECRET = "glpat_read_only_service_token_9c31";
const CREDENTIAL_REF = "svc-source-gitlab";
const CANONICAL = "gitlab:acme/platform/api";

const PROJECT_URL = "/api/v4/projects/acme%2Fplatform%2Fapi";
const PARENT_GROUP_URL = "/api/v4/groups/acme";
const PROJECT_MEMBERS_URL = "/api/v4/projects/414/members?per_page=100&page=1";
const GROUP_MEMBERS_URL = "/api/v4/groups/57/members?per_page=100&page=1";
const ANCESTOR_MEMBERS_URL = "/api/v4/groups/12/members?per_page=100&page=1";
const INVITED_GROUPS_URL = "/api/v4/projects/414/invited_groups?per_page=100&page=1";

const ctx: ProviderCallContext = {
  enterprise_id: "ent_1",
  workspace_id: "wsp_1",
  integration_id: "int_1",
};

const repository: RepositoryRef = {
  repository_id: "gitlab:project:414",
  repository_name: "acme/platform/api",
  provider_type: "gitlab",
};

const credentials = createStaticServiceCredentialStore({ [CREDENTIAL_REF]: SECRET });

let provider: FakeProvider | null = null;

afterEach(async () => {
  await provider?.close();
  provider = null;
});

function adapterFor(baseUrl: string) {
  return createGitLabAdapter({
    canonical_repository_id: CANONICAL,
    credential_ref: CREDENTIAL_REF,
    credentials,
    // Provider origin drives `/api/v4`, exactly as a real deployment does.
    provider_origin: baseUrl,
  });
}

const PROJECT = {
  id: 414,
  path_with_namespace: "acme/platform/api",
  namespace: { id: 57, full_path: "acme/platform", kind: "group" },
  // Only the project payload carries the granted share level (DAT-248).
  shared_with_groups: [],
};

const PROJECT_MEMBER = { id: 900, username: "dev", access_level: 30, state: "active" };
const GROUP_MEMBER = { id: 901, username: "groupie", access_level: 40, state: "active" };
const ANCESTOR_MEMBER = { id: 902, username: "ancestor", access_level: 20, state: "active" };

function fullRoutes() {
  return exactRoutes({
    [PROJECT_URL]: { status: 200, body: PROJECT },
    [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
    [INVITED_GROUPS_URL]: { status: 200, body: [] },
    [PROJECT_MEMBERS_URL]: { status: 200, body: [PROJECT_MEMBER] },
    [GROUP_MEMBERS_URL]: { status: 200, body: [GROUP_MEMBER] },
    [ANCESTOR_MEMBERS_URL]: { status: 200, body: [ANCESTOR_MEMBER] },
  });
}

describe("gitlab adapter paths and credentials", () => {
  test("encodes the project path as one segment and never sends the provider prefix", async () => {
    provider = await startFakeProvider(fullRoutes());

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository, {
      available_token_scope: ["read_api"],
    });

    expect(provider.urls()).toEqual([
      PROJECT_URL,
      PARENT_GROUP_URL,
      INVITED_GROUPS_URL,
      PROJECT_MEMBERS_URL,
      GROUP_MEMBERS_URL,
      ANCESTOR_MEMBERS_URL,
    ]);
    expect(provider.urls().every((url) => !url.includes("gitlab:"))).toBe(true);
    expect(provider.urls().some((url) => url.includes("acme%2Fplatform%2Fapi"))).toBe(true);

    for (const request of provider.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers["private-token"]).toBe(SECRET);
    }

    // Direct project membership, own-group membership, and ancestor
    // inheritance keep distinct provenance, as normalize.ts models them.
    expect(roster.entries).toEqual([
      {
        subject: "900",
        login: "dev",
        kind: "direct_collaborator",
        provider_role: "developer",
        authority_ref: "project:414",
        inherited_from: null,
      },
      {
        subject: "901",
        login: "groupie",
        kind: "group",
        provider_role: "maintainer",
        authority_ref: "group:57",
        inherited_from: null,
      },
      {
        subject: "902",
        login: "ancestor",
        kind: "inherited_role",
        provider_role: "reporter",
        authority_ref: "group:12",
        inherited_from: "group:57",
      },
    ]);
  });

  test("declares read_api only and refuses any other credential", async () => {
    provider = await startFakeProvider(fullRoutes());
    const adapter = adapterFor(provider.base_url);
    expect(adapter.capabilities.required_token_scope).toEqual(["read_api"]);

    const error = await collectRoster(adapter, ctx, repository, {
      available_token_scope: ["api"],
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("token_scope");
    expect(provider.requests).toHaveLength(0);
  });

  test("addresses self-hosted GitLab under /api/v4", () => {
    expect(gitlabApiBaseUrl({ provider_origin: "https://gitlab.example.com" })).toBe(
      "https://gitlab.example.com/api/v4",
    );
    expect(gitlabApiBaseUrl({})).toBe("https://gitlab.com/api/v4");
  });

  test("follows X-Next-Page for a paginated member list", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        [PROJECT_MEMBERS_URL]: {
          status: 200,
          headers: { "x-next-page": "2" },
          body: [PROJECT_MEMBER],
        },
        "/api/v4/projects/414/members?per_page=100&page=2": {
          status: 200,
          headers: { "x-next-page": "" },
          body: [{ id: 903, username: "dev2", access_level: 20 }],
        },
        [GROUP_MEMBERS_URL]: { status: 200, body: [] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);
    expect(roster.entries.map((entry) => entry.subject)).toEqual(["900", "903"]);
    expect(provider.urls()).toContain("/api/v4/projects/414/members?per_page=100&page=2");
  });

  test("minimal access (5) is not repository authority and is skipped", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        [PROJECT_MEMBERS_URL]: {
          status: 200,
          body: [{ id: 905, username: "minimal", access_level: 5, state: "active" }],
        },
        [GROUP_MEMBERS_URL]: { status: 200, body: [] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);
    expect(roster.entries).toEqual([]);
  });

  test("an unknown access level aborts normalization instead of inventing a role", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        [PROJECT_MEMBERS_URL]: {
          status: 200,
          body: [{ id: 906, username: "weird", access_level: 77 }],
        },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NormalizationError);
  });
});

describe("gitlab provider failure semantics", () => {
  test("a project 404 is a visibility failure, never an empty roster", async () => {
    provider = await startFakeProvider(
      exactRoutes({ [PROJECT_URL]: { status: 404, body: { message: "404 Project Not Found" } } }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("visibility");
  });

  test("an unreadable ancestor group fails the verification instead of yielding a short roster", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        // The ancestor group is not visible: its members cannot be enumerated.
        [PARENT_GROUP_URL]: { status: 404, body: { message: "404 Group Not Found" } },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    // Treating the remaining pages as complete would make reconcile record
    // every member of that group as `removed`.
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("visibility");
    expect((error as Error).message).toContain("acme");
  });

  test("401 is a missing-scope failure", async () => {
    provider = await startFakeProvider(
      exactRoutes({ [PROJECT_URL]: { status: 401, body: { message: "401 Unauthorized" } } }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("token_scope");
  });

  test("403 is a permission failure and never reads as removal", async () => {
    provider = await startFakeProvider(
      exactRoutes({ [PROJECT_URL]: { status: 403, body: { message: "403 Forbidden" } } }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("permission_query");
  });

  test("429 is unavailable", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 429,
          headers: { "retry-after": "90" },
          body: { message: "limit" },
        },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).reason).toBe("rate_limited");
  });

  test("5xx is unavailable", async () => {
    provider = await startFakeProvider(exactRoutes({ [PROJECT_URL]: { status: 502, body: {} } }));

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).reason).toBe("server_error");
  });

  test("an exhausted rate-limit budget mid-roster is an incomplete roster", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: 3000 + index,
      username: `member-${String(index)}`,
      access_level: 20,
      state: "active",
    }));
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        [PROJECT_MEMBERS_URL]: {
          status: 200,
          headers: {
            "x-next-page": "2",
            "ratelimit-remaining": "0",
            "ratelimit-reset": "1800000000",
          },
          body: fullPage,
        },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(IncompleteRosterError);
    expect((error as IncompleteRosterError).reason).toBe("rate_limited");
  });

  test("the service credential never appears in an error message", async () => {
    provider = await startFakeProvider(exactRoutes({ [PROJECT_URL]: { status: 500, body: {} } }));

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});

describe("gitlab effective permission", () => {
  function adapterForSubjectChecks(baseUrl: string) {
    return createGitLabAdapter({
      canonical_repository_id: CANONICAL,
      credential_ref: CREDENTIAL_REF,
      credentials,
      provider_origin: baseUrl,
    });
  }

  test("a direct project member is recorded as a direct collaborator", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        "/api/v4/projects/414/members/900": { status: 200, body: PROJECT_MEMBER },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterForSubjectChecks(provider.base_url),
      ctx,
      repository,
      "900",
    );
    expect(role).toEqual({
      subject: "900",
      login: "dev",
      kind: "direct_collaborator",
      provider_role: "developer",
      authority_ref: "project:414",
      inherited_from: null,
    });
  });

  test("group-inherited access keeps the group as provenance, never the aggregate endpoint", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        "/api/v4/projects/414/members/901": { status: 404, body: {} },
        "/api/v4/groups/57/members/901": { status: 200, body: GROUP_MEMBER },
        "/api/v4/groups/12/members/901": { status: 404, body: {} },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterForSubjectChecks(provider.base_url),
      ctx,
      repository,
      "901",
    );
    expect(role).toEqual({
      subject: "901",
      login: "groupie",
      kind: "group",
      provider_role: "maintainer",
      authority_ref: "group:57",
      inherited_from: null,
    });
    // The unfiltered aggregate endpoint is never used when a level answers.
    expect(provider.urls().some((url) => url.includes("/members/all/"))).toBe(false);
  });

  test("ancestor-group access is inherited_role with inherited_from", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        "/api/v4/projects/414/members/902": { status: 404, body: {} },
        "/api/v4/groups/57/members/902": { status: 404, body: {} },
        "/api/v4/groups/12/members/902": { status: 200, body: ANCESTOR_MEMBER },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterForSubjectChecks(provider.base_url),
      ctx,
      repository,
      "902",
    );
    expect(role).toEqual({
      subject: "902",
      login: "ancestor",
      kind: "inherited_role",
      provider_role: "reporter",
      authority_ref: "group:12",
      inherited_from: "group:57",
    });
  });

  test("no membership anywhere means no permission", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        "/api/v4/projects/414/members/999": { status: 404, body: {} },
        "/api/v4/groups/57/members/999": { status: 404, body: {} },
        "/api/v4/groups/12/members/999": { status: 404, body: {} },
        "/api/v4/projects/414/members/all/999": { status: 404, body: { message: "404 Not found" } },
      }),
    );

    await expect(
      fetchEffectivePermission(adapterForSubjectChecks(provider.base_url), ctx, repository, "999"),
    ).resolves.toBeNull();
  });

  test("access that no level can be attributed to is recorded as effective access", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        "/api/v4/projects/414/members/904": { status: 404, body: {} },
        "/api/v4/groups/57/members/904": { status: 404, body: {} },
        "/api/v4/groups/12/members/904": { status: 404, body: {} },
        // e.g. a group that is only shared with an invited group.
        "/api/v4/projects/414/members/all/904": {
          status: 200,
          body: { id: 904, username: "shared", access_level: 30, state: "active" },
        },
      }),
    );

    // The provider proved effective access; it did not prove where it comes
    // from, so the row says exactly that and never claims a direct grant.
    const role = await fetchEffectivePermission(
      adapterForSubjectChecks(provider.base_url),
      ctx,
      repository,
      "904",
    );
    expect(role).toEqual({
      subject: "904",
      login: "shared",
      kind: "effective_access",
      provider_role: "developer",
      authority_ref: "project:414",
      inherited_from: null,
    });
  });

  test("a failed aggregate query is never read as removal", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [] },
        "/api/v4/projects/414/members/907": { status: 404, body: {} },
        "/api/v4/groups/57/members/907": { status: 404, body: {} },
        "/api/v4/groups/12/members/907": { status: 404, body: {} },
        "/api/v4/projects/414/members/all/907": { status: 500, body: {} },
      }),
    );

    const error = await fetchEffectivePermission(
      adapterForSubjectChecks(provider.base_url),
      ctx,
      repository,
      "907",
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });
});

/**
 * DAT-248: a project can be invited to a group ("shared with a group"). Only
 * that group's members — direct plus the members it inherits from its own
 * parents — reach the project through it, and each keeps the lower of their
 * group role and the granted share level. The project payload is the only
 * response that carries that level.
 */
describe("gitlab invited (shared) groups", () => {
  function invitedProjects(
    shared: { group_id: number; group_full_path: string; group_access_level: number }[],
  ) {
    return { ...PROJECT, shared_with_groups: shared };
  }

  const INVITED_GROUP = {
    id: 77,
    name: "Contractors",
    full_path: "partner/contractors",
  };
  const CONTRACTOR = { id: 910, username: "contractor", access_level: 40, state: "active" };

  test("declares partial visibility, because the invited-group endpoints cannot prove everything", () => {
    expect(adapterFor("http://127.0.0.1:1").capabilities.effective_permission_visibility).toBe(
      "partial",
    );
  });

  test("records invited-group members as that group, capped by the granted level", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 200,
          body: invitedProjects([
            { group_id: 77, group_full_path: "partner/contractors", group_access_level: 20 },
          ]),
        },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [INVITED_GROUP] },
        [PROJECT_MEMBERS_URL]: { status: 200, body: [] },
        [GROUP_MEMBERS_URL]: { status: 200, body: [] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [] },
        "/api/v4/groups/77/members/all?per_page=100&page=1": { status: 200, body: [CONTRACTOR] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);

    expect(roster.entries).toEqual([
      {
        subject: "910",
        login: "contractor",
        kind: "group",
        // Inherited members of an invited group keep the lower of the two
        // levels: maintainer (40) in the group, reporter (20) granted.
        provider_role: "reporter",
        authority_ref: "group:77",
        inherited_from: null,
      },
    ]);
    expect(provider.urls()).toContain("/api/v4/groups/77/members/all?per_page=100&page=1");
    // The ancestor-group listing (`/projects/:id/groups`) is a different
    // endpoint and must never be used as the invited-group source.
    expect(provider.urls().some((url) => url.includes("/projects/414/groups?"))).toBe(false);
  });

  test("Planner and Security Manager members are floored instead of aborting the roster", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 200,
          body: invitedProjects([
            { group_id: 77, group_full_path: "partner/contractors", group_access_level: 50 },
            { group_id: 78, group_full_path: "partner/auditors", group_access_level: 25 },
          ]),
        },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: {
          status: 200,
          body: [
            { id: 77, full_path: "partner/contractors" },
            { id: 78, full_path: "partner/auditors" },
          ],
        },
        [PROJECT_MEMBERS_URL]: { status: 200, body: [] },
        [GROUP_MEMBERS_URL]: { status: 200, body: [] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [] },
        "/api/v4/groups/77/members/all?per_page=100&page=1": {
          status: 200,
          body: [
            // Planner (15) and Security Manager (25) are real GitLab levels
            // with no repository role of their own.
            { id: 920, username: "planner", access_level: 15, state: "active" },
            { id: 921, username: "security-manager", access_level: 25, state: "active" },
          ],
        },
        "/api/v4/groups/78/members/all?per_page=100&page=1": {
          status: 200,
          body: [{ id: 922, username: "developer", access_level: 30, state: "active" }],
        },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);

    expect(roster.entries.map((entry) => [entry.subject, entry.provider_role])).toEqual([
      // Security Manager share level (25) floors to reporter (20).
      ["922", "reporter"],
      // Planner floors to guest, Security Manager floors to reporter.
      ["920", "guest"],
      ["921", "reporter"],
    ]);
  });

  test("paginates the invited-group listing and each invited group's members", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 200,
          body: invitedProjects([
            { group_id: 77, group_full_path: "partner/contractors", group_access_level: 20 },
            { group_id: 78, group_full_path: "partner/auditors", group_access_level: 30 },
          ]),
        },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: {
          status: 200,
          headers: { "x-next-page": "2" },
          body: [INVITED_GROUP],
        },
        "/api/v4/projects/414/invited_groups?per_page=100&page=2": {
          status: 200,
          body: [{ id: 78, full_path: "partner/auditors" }],
        },
        [PROJECT_MEMBERS_URL]: { status: 200, body: [] },
        [GROUP_MEMBERS_URL]: { status: 200, body: [] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [] },
        "/api/v4/groups/78/members/all?per_page=100&page=1": {
          status: 200,
          headers: { "x-next-page": "2" },
          body: [{ id: 911, username: "auditor-a", access_level: 20, state: "active" }],
        },
        "/api/v4/groups/78/members/all?per_page=100&page=2": {
          status: 200,
          body: [{ id: 912, username: "auditor-b", access_level: 40, state: "active" }],
        },
        "/api/v4/groups/77/members/all?per_page=100&page=1": { status: 200, body: [] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);

    // Ordered by group path: `partner/auditors` before `partner/contractors`.
    expect(roster.entries.map((entry) => [entry.subject, entry.provider_role])).toEqual([
      ["911", "reporter"],
      ["912", "developer"],
    ]);
    expect(roster.entries.every((entry) => entry.authority_ref === "group:78")).toBe(true);
    expect(provider.urls()).toContain("/api/v4/projects/414/invited_groups?per_page=100&page=2");
    expect(provider.urls()).toContain("/api/v4/groups/78/members/all?per_page=100&page=2");
  });

  test("keeps direct, own-group, ancestor-group, and invited-group provenance apart", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 200,
          body: invitedProjects([
            { group_id: 77, group_full_path: "partner/contractors", group_access_level: 20 },
          ]),
        },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [INVITED_GROUP] },
        [PROJECT_MEMBERS_URL]: { status: 200, body: [PROJECT_MEMBER] },
        [GROUP_MEMBERS_URL]: { status: 200, body: [GROUP_MEMBER] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [ANCESTOR_MEMBER] },
        "/api/v4/groups/77/members/all?per_page=100&page=1": { status: 200, body: [CONTRACTOR] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);

    expect(
      roster.entries.map((entry) => [
        entry.kind,
        entry.authority_ref,
        entry.inherited_from,
        entry.provider_role,
      ]),
    ).toEqual([
      ["direct_collaborator", "project:414", null, "developer"],
      ["group", "group:57", null, "maintainer"],
      ["inherited_role", "group:12", "group:57", "reporter"],
      ["group", "group:77", null, "reporter"],
    ]);
  });

  test("an invited group without an observable granted level fails instead of guessing", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        // The listing knows group 79, the project payload does not carry its
        // level: every member role would be an upper bound, so no row is safe.
        [PROJECT_URL]: { status: 200, body: invitedProjects([]) },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [{ id: 79, full_path: "partner/unknown" }] },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("visibility");
    expect((error as Error).message).toContain("79");
  });

  test("an instance without the invited-group endpoint falls back to the project payload", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 200,
          body: invitedProjects([
            { group_id: 77, group_full_path: "partner/contractors", group_access_level: 20 },
          ]),
        },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        // Older instances do not serve the listing at all.
        [INVITED_GROUPS_URL]: { status: 404, body: { message: "404 Not Found" } },
        [PROJECT_MEMBERS_URL]: { status: 200, body: [] },
        [GROUP_MEMBERS_URL]: { status: 200, body: [] },
        [ANCESTOR_MEMBERS_URL]: { status: 200, body: [] },
        "/api/v4/groups/77/members/all?per_page=100&page=1": { status: 200, body: [CONTRACTOR] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository);

    expect(roster.entries.map((entry) => entry.subject)).toEqual(["910"]);
  });

  test("a subject refresh resolves invited-group access to that group", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: {
          status: 200,
          body: invitedProjects([
            { group_id: 77, group_full_path: "partner/contractors", group_access_level: 30 },
          ]),
        },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        [INVITED_GROUPS_URL]: { status: 200, body: [INVITED_GROUP] },
        "/api/v4/projects/414/members/910": { status: 404, body: {} },
        "/api/v4/groups/57/members/910": { status: 404, body: {} },
        "/api/v4/groups/12/members/910": { status: 404, body: {} },
        "/api/v4/groups/77/members/all/910": { status: 200, body: CONTRACTOR },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "910",
    );
    expect(role).toEqual({
      subject: "910",
      login: "contractor",
      kind: "group",
      provider_role: "developer",
      authority_ref: "group:77",
      inherited_from: null,
    });
    // The unfiltered aggregate endpoint is never consulted when a level answers.
    expect(provider.urls().some((url) => url.includes("/members/all/910"))).toBe(true);
    expect(provider.urls()).not.toContain("/api/v4/projects/414/members/all/910");
  });
});
