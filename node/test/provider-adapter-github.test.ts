/**
 * GitHub adapter tests (DAT-247).
 *
 * Every provider interaction is asserted against a real HTTP fake: the exact
 * request target (path + query), the exact credential header, and the declared
 * scope. Substring matching on the URL is exactly the mistake that let
 * DAT-204's login-time probe ship a permanently-404 request.
 */

import { afterEach, describe, expect, test } from "vitest";

import { collectRoster, fetchEffectivePermission } from "../src/provider-access/adapter.js";
import { createGitHubAdapter, githubApiBaseUrl } from "../src/provider-access/adapters/github.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import {
  IncompleteRosterError,
  MissingPermissionError,
  ProviderUnavailableError,
  type ProviderCallContext,
  type RepositoryRef,
} from "../src/provider-access/types.js";
import { exactRoutes, startFakeProvider, type FakeProvider } from "./helpers/fake-provider.js";

const SECRET = "ghs_installation_token_should_never_leak_4f2a";
const CREDENTIAL_REF = "svc-source-github";
const CANONICAL = "github:Luthiel/AutoFixer";

const ctx: ProviderCallContext = {
  enterprise_id: "ent_1",
  workspace_id: "wsp_1",
  integration_id: "int_1",
};

const repository: RepositoryRef = {
  repository_id: "github:9001",
  repository_name: "Luthiel/AutoFixer",
  provider_type: "github",
};

const credentials = createStaticServiceCredentialStore({ [CREDENTIAL_REF]: SECRET });

const REPO_URL = "/repos/Luthiel/AutoFixer";
const COLLABORATORS_URL = "/repos/Luthiel/AutoFixer/collaborators?per_page=100&page=1";
const OWNERS_URL = "/orgs/Luthiel/members?role=admin&per_page=100&page=1";

let provider: FakeProvider | null = null;

afterEach(async () => {
  await provider?.close();
  provider = null;
});

function adapterFor(
  baseUrl: string,
  overrides: { pages_max?: number; available_scope?: never } = {},
) {
  return createGitHubAdapter({
    canonical_repository_id: CANONICAL,
    credential_ref: CREDENTIAL_REF,
    credentials,
    api_base_url: baseUrl,
    resolve_login: (subject) => (subject === "4242" ? "octocat" : undefined),
    ...(overrides.pages_max !== undefined ? { pages_max: overrides.pages_max } : {}),
  });
}

const COLLABORATOR = {
  id: 4242,
  login: "octocat",
  role_name: "admin",
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
};

const ORG_OWNER = { id: 4242, login: "octocat" };

const ORG_REPO = { id: 9001, owner: { id: 7, login: "Luthiel", type: "Organization" } };
const PERSONAL_REPO = { id: 9002, owner: { id: 8, login: "Luthiel", type: "User" } };

describe("github adapter paths and credentials", () => {
  test("requests the repository and roster by exact API paths with the exact credential", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: {
          status: 200,
          body: {
            id: 9001,
            full_name: "Luthiel/AutoFixer",
            owner: { id: 7, login: "Luthiel", type: "Organization" },
          },
        },
        [COLLABORATORS_URL]: { status: 200, body: [COLLABORATOR] },
        [OWNERS_URL]: { status: 200, body: [ORG_OWNER] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository, {
      available_token_scope: ["metadata:read", "contents:read", "members:read"],
    });

    // Exact request targets, in order: no `github:` prefix anywhere.
    expect(provider.urls()).toEqual([REPO_URL, COLLABORATORS_URL, OWNERS_URL]);
    expect(provider.urls().every((url) => !url.includes("github:"))).toBe(true);

    // The credential comes from the boundary as a bearer token, per request.
    for (const request of provider.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers["authorization"]).toBe(`Bearer ${SECRET}`);
      expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
    }

    expect(roster.entries).toEqual([
      {
        subject: "4242",
        login: "octocat",
        // Organization repositories: the collaborator list cannot
        // differentiate an organization-level from a repository-level grant,
        // so the row claims effective access only.
        kind: "effective_access",
        provider_role: "admin",
        authority_ref: "repository:Luthiel/AutoFixer",
        inherited_from: null,
      },
      {
        subject: "4242",
        login: "octocat",
        kind: "org_owner",
        provider_role: "owner",
        authority_ref: "organization:Luthiel",
        inherited_from: null,
      },
    ]);
  });

  test("declares least-privilege scopes and refuses a credential that is missing one", async () => {
    provider = await startFakeProvider(() => ({ status: 200, body: [] }));
    const adapter = adapterFor(provider.base_url);
    expect(adapter.capabilities.required_token_scope).toEqual([
      "metadata:read",
      "contents:read",
      "members:read",
    ]);
    // Least privilege: nothing broader than what the endpoints used require.
    expect(adapter.capabilities.required_token_scope).not.toContain("administration:read");

    await expect(
      collectRoster(adapter, ctx, repository, { available_token_scope: ["metadata:read"] }),
    ).rejects.toBeInstanceOf(MissingPermissionError);
    // Refused before any provider call: no partial roster, no requests.
    expect(provider.requests).toHaveLength(0);
  });

  test("a credential holding exactly the declared scopes is accepted", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [COLLABORATOR] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository, {
      available_token_scope: ["metadata:read", "contents:read", "members:read"],
    });
    expect(roster.entries).toHaveLength(1);
  });

  test("a personal-account repository has no organization owners to query", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: PERSONAL_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [COLLABORATOR] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository, {
      available_token_scope: ["metadata:read", "contents:read", "members:read"],
    });

    // The collaborator list IS the complete roster for a user-owned
    // repository; /orgs/{owner}/members does not exist there, so hitting it
    // would turn every reconciliation into an outage.
    expect(provider.urls()).toEqual([REPO_URL, COLLABORATORS_URL]);
    // No teams, no organization default permissions: the provider does prove
    // a direct grant here.
    expect(roster.entries.map((entry) => entry.kind)).toEqual(["direct_collaborator"]);
    expect(roster.entries.map((entry) => entry.authority_ref)).toEqual([
      "repository:Luthiel/AutoFixer",
    ]);
  });

  test("a personal-account repository's per-subject refresh is a direct grant", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: PERSONAL_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat/permission": {
          status: 200,
          body: { permission: "write", role_name: "write", user: { id: 4242, login: "octocat" } },
        },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "4242",
    );
    expect(role?.kind).toBe("direct_collaborator");
    expect(role?.authority_ref).toBe("repository:Luthiel/AutoFixer");
    expect(provider.urls()).toEqual([
      REPO_URL,
      "/repos/Luthiel/AutoFixer/collaborators/octocat/permission",
    ]);
  });

  test("a GitHub Enterprise origin addresses /api/v3, public GitHub addresses api.github.com", () => {
    expect(githubApiBaseUrl({ provider_origin: "https://github.com" })).toBe(
      "https://api.github.com",
    );
    expect(githubApiBaseUrl({ provider_origin: "https://ghe.example.com" })).toBe(
      "https://ghe.example.com/api/v3",
    );
    expect(githubApiBaseUrl({})).toBe("https://api.github.com");
  });
});

describe("github provider failure semantics", () => {
  test("401 is a missing-scope failure, never an empty roster", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 401, body: { message: "Bad credentials" } },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("token_scope");
  });

  test("403 is a permission failure, and produces no removed fact", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 403, body: { message: "Resource not accessible" } },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("permission_query");
  });

  test("429 is unavailable, distinct from an incomplete roster", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: {
          status: 429,
          headers: { "retry-after": "120" },
          body: { message: "API rate limit exceeded" },
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
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 503, body: { message: "unavailable" } },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).reason).toBe("server_error");
  });

  test("a 404 repository is a visibility failure, never a zero-member roster", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 404, body: { message: "Not Found" } },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("visibility");
    expect(provider.urls()).toEqual([REPO_URL]);
  });

  test("an exhausted rate-limit budget mid-roster is an incomplete roster", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      login: `user-${String(index)}`,
      role_name: "pull",
    }));
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: {
          status: 200,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
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

  test("pagination past the declared budget is an incomplete roster", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: 2000 + index,
      login: `page1-${String(index)}`,
      role_name: "pull",
    }));
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: fullPage },
      }),
    );

    const error = await collectRoster(
      adapterFor(provider.base_url, { pages_max: 1 }),
      ctx,
      repository,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(IncompleteRosterError);
    expect((error as IncompleteRosterError).reason).toBe("pagination_limit");
  });

  test("the service credential never appears in an error message", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 500, body: { message: "boom" } },
      }),
    );

    const error = await collectRoster(adapterFor(provider.base_url), ctx, repository).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  test("honors Retry-After exactly once when a sleep hook is available", async () => {
    const waits: number[] = [];
    let collaboratorCalls = 0;
    provider = await startFakeProvider((request) => {
      if (request.url === REPO_URL) {
        return { status: 200, body: ORG_REPO };
      }
      if (request.url === OWNERS_URL) {
        return { status: 200, body: [] };
      }
      collaboratorCalls += 1;
      if (collaboratorCalls === 1) {
        return { status: 429, headers: { "retry-after": "1" }, body: { message: "slow down" } };
      }
      return { status: 200, body: [COLLABORATOR] };
    });

    const adapter = createGitHubAdapter({
      canonical_repository_id: CANONICAL,
      credential_ref: CREDENTIAL_REF,
      credentials,
      api_base_url: provider.base_url,
      resolve_login: () => "octocat",
    });

    await collectRoster(
      adapter,
      { ...ctx, sleep: async (ms: number) => void waits.push(ms) },
      repository,
    );
    expect(waits).toEqual([1000]);
    expect(collaboratorCalls).toBe(2);
    // Exactly one retry, then the roster continues normally.
    expect(provider.urls()).toEqual([REPO_URL, COLLABORATORS_URL, COLLABORATORS_URL, OWNERS_URL]);
  });
});

describe("github effective permission", () => {
  test("asks for the exact collaborator path and returns the provider role", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat/permission": {
          status: 200,
          body: {
            permission: "admin",
            role_name: "admin",
            user: { id: 4242, login: "octocat" },
          },
        },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "4242",
    );
    // The permission endpoint, not the 204-only "check a collaborator" one.
    expect(provider.urls()).toEqual([
      REPO_URL,
      "/repos/Luthiel/AutoFixer/collaborators/octocat/permission",
    ]);
    expect(role).toEqual({
      subject: "4242",
      login: "octocat",
      kind: "effective_access",
      provider_role: "admin",
      authority_ref: "repository:Luthiel/AutoFixer",
      inherited_from: null,
    });
  });

  test("a 404 collaborator means no permission", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat/permission": {
          status: 404,
          body: { message: "Not Found" },
        },
      }),
    );

    await expect(
      fetchEffectivePermission(adapterFor(provider.base_url), ctx, repository, "4242"),
    ).resolves.toBeNull();
  });

  test("maps the permission endpoint's read/write spelling", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat/permission": {
          status: 200,
          body: { permission: "write", role_name: "write", user: { id: 4242, login: "octocat" } },
        },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "4242",
    );
    expect(role?.provider_role).toBe("write");
  });

  test("a 204 without a role is a visibility gap, not a provider outage", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat/permission": { status: 204, body: "" },
      }),
    );

    const error = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "4242",
    ).catch((thrown: unknown) => thrown);
    // A 204 has no body to parse: reporting "provider unavailable" would be
    // wrong, and claiming "no access" would be worse.
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("permission_query");
  });

  test("an unbound subject is a visibility gap, not an absence of access", async () => {
    provider = await startFakeProvider(
      exactRoutes({ [REPO_URL]: { status: 200, body: ORG_REPO } }),
    );

    const error = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "9999",
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect((error as MissingPermissionError).detail).toBe("permission_query");
  });
});
