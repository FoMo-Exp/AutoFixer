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
};

const PROJECT_MEMBER = { id: 900, username: "dev", access_level: 30, state: "active" };
const GROUP_MEMBER = { id: 901, username: "groupie", access_level: 40, state: "active" };
const ANCESTOR_MEMBER = { id: 902, username: "ancestor", access_level: 20, state: "active" };

function fullRoutes() {
  return exactRoutes({
    [PROJECT_URL]: { status: 200, body: PROJECT },
    [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
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
  test("asks for the exact members/all path for the subject", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        "/api/v4/projects/414/members/all/900": {
          status: 200,
          body: { id: 900, username: "dev", access_level: 30, state: "active" },
        },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "900",
    );
    // Project metadata, then the ancestor lookup that completes the chain,
    // then the per-subject query.
    expect(provider.urls()).toEqual([
      PROJECT_URL,
      PARENT_GROUP_URL,
      "/api/v4/projects/414/members/all/900",
    ]);
    expect(role).toEqual({
      subject: "900",
      login: "dev",
      kind: "direct_collaborator",
      provider_role: "developer",
      authority_ref: "project:414",
      inherited_from: null,
    });
  });

  test("a 404 member means no permission", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [PROJECT_URL]: { status: 200, body: PROJECT },
        [PARENT_GROUP_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
        "/api/v4/projects/414/members/all/999": { status: 404, body: { message: "404 Not found" } },
      }),
    );

    await expect(
      fetchEffectivePermission(adapterFor(provider.base_url), ctx, repository, "999"),
    ).resolves.toBeNull();
  });
});
