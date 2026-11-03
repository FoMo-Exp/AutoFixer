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

describe("github adapter paths and credentials", () => {
  test("requests the repository and roster by exact API paths with the exact credential", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: {
          status: 200,
          body: { id: 9001, full_name: "Luthiel/AutoFixer", owner: { id: 7, login: "Luthiel" } },
        },
        [COLLABORATORS_URL]: { status: 200, body: [COLLABORATOR] },
        [OWNERS_URL]: { status: 200, body: [ORG_OWNER] },
      }),
    );

    const roster = await collectRoster(adapterFor(provider.base_url), ctx, repository, {
      available_token_scope: [
        "metadata:read",
        "contents:read",
        "members:read",
        "administration:read",
      ],
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
        kind: "direct_collaborator",
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
      "administration:read",
    ]);

    await expect(
      collectRoster(adapter, ctx, repository, { available_token_scope: ["metadata:read"] }),
    ).rejects.toBeInstanceOf(MissingPermissionError);
    // Refused before any provider call: no partial roster, no requests.
    expect(provider.requests).toHaveLength(0);
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
        [REPO_URL]: { status: 200, body: { id: 9001 } },
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
        [REPO_URL]: { status: 200, body: { id: 9001 } },
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
        [REPO_URL]: { status: 200, body: { id: 9001 } },
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
        [REPO_URL]: { status: 200, body: { id: 9001 } },
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
        [REPO_URL]: { status: 200, body: { id: 9001 } },
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
        return { status: 200, body: { id: 9001 } };
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
        [REPO_URL]: { status: 200, body: { id: 9001 } },
        "/repos/Luthiel/AutoFixer/collaborators/octocat": { status: 200, body: COLLABORATOR },
      }),
    );

    const role = await fetchEffectivePermission(
      adapterFor(provider.base_url),
      ctx,
      repository,
      "4242",
    );
    expect(provider.urls()).toEqual([REPO_URL, "/repos/Luthiel/AutoFixer/collaborators/octocat"]);
    expect(role).toEqual({
      subject: "4242",
      login: "octocat",
      kind: "direct_collaborator",
      provider_role: "admin",
      authority_ref: "repository:Luthiel/AutoFixer",
      inherited_from: null,
    });
  });

  test("a 404 collaborator means no permission", async () => {
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: { id: 9001 } },
        "/repos/Luthiel/AutoFixer/collaborators/octocat": {
          status: 404,
          body: { message: "Not Found" },
        },
      }),
    );

    await expect(
      fetchEffectivePermission(adapterFor(provider.base_url), ctx, repository, "4242"),
    ).resolves.toBeNull();
  });

  test("an unbound subject is a visibility gap, not an absence of access", async () => {
    provider = await startFakeProvider(
      exactRoutes({ [REPO_URL]: { status: 200, body: { id: 9001 } } }),
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
