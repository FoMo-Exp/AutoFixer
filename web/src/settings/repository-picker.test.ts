import { describe, expect, it } from "vitest";

import type { ProviderAccount, ProviderRepository } from "./client";
import {
  branchSelectValue,
  buildRepositoryOptions,
  CUSTOM_BRANCH,
  CUSTOM_REPOSITORY,
  orderedBranchNames,
  repositorySelectValue,
  resolveRepositoryOption,
} from "./repository-picker";

const githubAccount: ProviderAccount = {
  id: "acct_aaaaaaaaaaaaaaaa",
  provider: "github",
  instanceUrl: "https://github.com",
  login: "octocat",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const gitlabAccount: ProviderAccount = {
  id: "acct_bbbbbbbbbbbbbbbb",
  provider: "gitlab",
  instanceUrl: "https://gitlab.com",
  login: "hubot",
  createdAt: "2026-01-02T00:00:00.000Z",
};

function repository(overrides: Partial<ProviderRepository> = {}): ProviderRepository {
  return {
    id: "github:octocat/hello",
    provider: "github",
    owner: "octocat",
    name: "hello",
    defaultBranch: "main",
    private: false,
    ...overrides,
  };
}

describe("repository picker options", () => {
  it("labels the same owner/name from two accounts distinctly", () => {
    const options = buildRepositoryOptions(
      [githubAccount, gitlabAccount],
      new Map([
        [githubAccount.id, [repository()]],
        [gitlabAccount.id, [repository({ id: "gitlab:octocat/hello", provider: "gitlab" })]],
      ]),
    );
    expect(options).toHaveLength(2);
    expect(options[0].label).toContain("octocat/hello · octocat (github)");
    expect(options[1].label).toContain("octocat/hello · hubot (gitlab)");
    // Select values are keyed by account, so identical repository ids from
    // two accounts never collide in the select element.
    expect(new Set(options.map((option) => option.value)).size).toBe(2);
  });

  it("skips accounts whose discovery failed (empty list)", () => {
    const options = buildRepositoryOptions(
      [githubAccount, gitlabAccount],
      new Map([[githubAccount.id, [repository()]]]),
    );
    expect(options).toHaveLength(1);
  });
});

describe("selection resolution", () => {
  const sharedPath = repository();
  const options = buildRepositoryOptions(
    [githubAccount, gitlabAccount],
    new Map([
      [githubAccount.id, [sharedPath]],
      [gitlabAccount.id, [repository({ id: "gitlab:octocat/hello", provider: "gitlab" })]],
    ]),
  );

  it("resolves the account-scoped selection for identical repository paths", () => {
    const secondValue = options[1].value;
    const resolved = resolveRepositoryOption(options, "gitlab:octocat/hello", secondValue);
    expect(resolved?.account.id).toBe(gitlabAccount.id);
  });

  it("falls back to the first matching repository id when the scoped value is stale", () => {
    const resolved = resolveRepositoryOption(
      options,
      "github:octocat/hello",
      "acct_zzzzzzzzzzzzzzzz:github:octocat/hello",
    );
    expect(resolved?.account.id).toBe(githubAccount.id);
  });

  it("resolves identical full repository ids from two accounts to the picked account", () => {
    // Two GitHub accounts on the same instance can both see the same
    // repository id; the account-scoped value must decide which one loads
    // branches, not the bare repository id.
    const secondGithub: ProviderAccount = {
      ...githubAccount,
      id: "acct_cccccccccccccccc",
      login: "second",
    };
    const sameOptions = buildRepositoryOptions(
      [githubAccount, secondGithub],
      new Map([
        [githubAccount.id, [repository()]],
        [secondGithub.id, [repository()]],
      ]),
    );
    expect(sameOptions[0].repositoryId).toBe(sameOptions[1].repositoryId);
    const resolved = resolveRepositoryOption(
      sameOptions,
      sameOptions[1].repositoryId,
      sameOptions[1].value,
    );
    expect(resolved?.account.id).toBe(secondGithub.id);
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveRepositoryOption(options, "github:acme/payments", undefined)).toBeUndefined();
  });

  it("maps an unresolved option to the Custom sentinel", () => {
    expect(repositorySelectValue(undefined)).toBe(CUSTOM_REPOSITORY);
    expect(repositorySelectValue(options[0])).toBe(options[0].value);
  });

  it("keeps a known branch selected and falls back to custom otherwise", () => {
    expect(branchSelectValue("main", ["main", "dev"])).toBe("main");
    expect(branchSelectValue("release/1.0", ["main", "dev"])).toBe(CUSTOM_BRANCH);
  });

  it("uses a sentinel no valid git ref can collide with", () => {
    // `..` is illegal in git refs, so a real branch can never equal the
    // Custom sentinel even though both are strings.
    expect(CUSTOM_BRANCH).toContain("..");
  });
});

describe("branch ordering", () => {
  it("puts the default branch first", () => {
    const names = orderedBranchNames(repository(), [
      { name: "dev", isDefault: false },
      { name: "main", isDefault: true },
    ]);
    expect(names).toEqual(["main", "dev"]);
  });

  it("keeps provider order when no default is known", () => {
    const names = orderedBranchNames(repository({ defaultBranch: null }), [
      { name: "dev", isDefault: false },
      { name: "main", isDefault: false },
    ]);
    expect(names).toEqual(["dev", "main"]);
  });
});
