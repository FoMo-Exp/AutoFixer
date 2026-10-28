import { describe, expect, it, vi } from "vitest";

import {
  apiBaseUrl,
  createProviderClient,
  normalizeInstanceUrl,
  parseRepositoryId,
  ProviderApiError,
  repositoryIdFor,
} from "../../electron/git-providers.js";
import type { StoredAccount } from "../../electron/settings-store.js";

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "acct_0123456789abcdef",
    provider: "github",
    instanceUrl: "https://github.com",
    login: "octocat",
    token: "ghp_test-token",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("instance URL normalization", () => {
  it("defaults to the public host", () => {
    expect(normalizeInstanceUrl("github", undefined)).toBe("https://github.com");
    expect(normalizeInstanceUrl("gitlab", "")).toBe("https://gitlab.com");
  });

  it("accepts a plain https origin and strips a trailing slash", () => {
    expect(normalizeInstanceUrl("gitlab", "https://gitlab.example.com/")).toBe(
      "https://gitlab.example.com",
    );
  });

  it("rejects http, credentials, paths, and queries but allows explicit https ports", () => {
    for (const bad of [
      "http://gitlab.example.com",
      "https://user:pass@gitlab.example.com",
      "https://gitlab.example.com/group",
      "https://gitlab.example.com?x=1",
    ]) {
      expect(() => normalizeInstanceUrl("gitlab", bad)).toThrow(ProviderApiError);
    }
    expect(normalizeInstanceUrl("gitlab", "https://gitlab.example.com:8443")).toBe(
      "https://gitlab.example.com:8443",
    );
  });
});

describe("provider endpoint derivation", () => {
  it("routes github.com to api.github.com and GHE to /api/v3", () => {
    expect(apiBaseUrl("github", "https://github.com")).toBe("https://api.github.com");
    expect(apiBaseUrl("github", "https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
  });

  it("routes gitlab origins to /api/v4", () => {
    expect(apiBaseUrl("gitlab", "https://gitlab.com")).toBe("https://gitlab.com/api/v4");
    expect(apiBaseUrl("gitlab", "https://gitlab.example.com")).toBe(
      "https://gitlab.example.com/api/v4",
    );
  });
});

describe("repository ids", () => {
  it("round-trips through provider coordinates", () => {
    const id = repositoryIdFor("gitlab", "group/subgroup", "project");
    expect(parseRepositoryId(id)).toEqual({
      provider: "gitlab",
      owner: "group/subgroup",
      name: "project",
    });
  });

  it("rejects foreign shapes", () => {
    expect(parseRepositoryId("svn:trunk")).toBeNull();
    expect(parseRepositoryId("github:norepo")).toBeNull();
  });
});

describe("token verification", () => {
  it("returns the GitHub login", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { login: "octocat" }));
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.verifyAccount("github", "https://github.com", "tok")).resolves.toEqual({
      login: "octocat",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.github.com/user");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  });

  it("maps a rejected token to an auth error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { message: "Bad credentials" }));
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.verifyAccount("github", "https://github.com", "bad")).rejects.toMatchObject(
      { kind: "auth" },
    );
  });

  it("maps GitLab rate limiting distinctly", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { message: "slow down" }, { "x-ratelimit-remaining": "0" }),
    );
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.verifyAccount("gitlab", "https://gitlab.com", "tok")).rejects.toMatchObject(
      { kind: "rate_limited" },
    );
  });
});

describe("repository discovery", () => {
  it("maps GitHub repositories to task-scoped ids", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        { full_name: "Luthiel/AutoFixer", default_branch: "main", private: true },
        { full_name: "octocat/spoon-fork", default_branch: "trunk", private: false },
      ]),
    );
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const repositories = await client.listRepositories(account());
    expect(repositories).toEqual([
      {
        id: "github:Luthiel/AutoFixer",
        provider: "github",
        owner: "Luthiel",
        name: "AutoFixer",
        defaultBranch: "main",
        private: true,
      },
      {
        id: "github:octocat/spoon-fork",
        provider: "github",
        owner: "octocat",
        name: "spoon-fork",
        defaultBranch: "trunk",
        private: false,
      },
    ]);
  });

  it("maps GitLab projects including subgroup paths", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        {
          path_with_namespace: "group/sub/project",
          default_branch: "main",
          visibility: "private",
        },
      ]),
    );
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const repositories = await client.listRepositories(
      account({ provider: "gitlab", instanceUrl: "https://gitlab.com" }),
    );
    expect(repositories[0].id).toBe("gitlab:group/sub/project");
    expect(repositories[0].owner).toBe("group/sub");
    expect(repositories[0].name).toBe("project");
    expect(repositories[0].private).toBe(true);
  });
});

describe("branch discovery", () => {
  it("marks the GitHub default branch from the repository payload", async () => {
    const fetchImpl = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/repos/octocat/hello")) {
        return jsonResponse(200, { default_branch: "trunk" });
      }
      return jsonResponse(200, [{ name: "main" }, { name: "trunk" }]);
    });
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const branches = await client.listBranches(account(), "github:octocat/hello");
    expect(branches).toEqual([
      { name: "main", isDefault: false },
      { name: "trunk", isDefault: true },
    ]);
  });

  it("marks the GitLab default branch from the branch payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, [
        { name: "main", default: true },
        { name: "feature/x", default: false },
      ]),
    );
    const client = createProviderClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const branches = await client.listBranches(
      account({ provider: "gitlab", instanceUrl: "https://gitlab.com" }),
      "gitlab:group/project",
    );
    expect(branches).toEqual([
      { name: "main", isDefault: true },
      { name: "feature/x", isDefault: false },
    ]);
  });

  it("refuses a repository that belongs to the other provider", async () => {
    const client = createProviderClient({
      fetchImpl: (async () => jsonResponse(200, [])) as unknown as typeof fetch,
    });
    await expect(client.listBranches(account(), "gitlab:group/project")).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});
