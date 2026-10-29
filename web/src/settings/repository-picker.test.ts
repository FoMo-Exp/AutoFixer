import { describe, expect, it } from "vitest";

import type { ProviderAccount, ProviderRepository } from "./client";
import {
  branchSelectValue,
  buildRepositoryOptions,
  CUSTOM_BRANCH,
  CUSTOM_REPOSITORY,
  isBranchInput,
  isRepositoryInput,
  orderedBranchNames,
  pickPrefillOption,
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

describe("view state model (regression: Choose from discovered did nothing)", () => {
  // The bug: two booleans could not express "force the select open" while
  // the value stayed undiscovered, so the button's flag flip was cancelled
  // by !selectedOption and the input bounced back.
  it("shows the select in auto mode only when the value is discovered", () => {
    expect(isRepositoryInput("auto", true)).toBe(false);
    expect(isRepositoryInput("auto", false)).toBe(true);
  });

  it("forces the select open after Choose from discovered, even when undiscovered", () => {
    expect(isRepositoryInput("select", false)).toBe(false);
    expect(isRepositoryInput("select", true)).toBe(false);
  });

  it("forces free text after Custom is chosen, even when discovered", () => {
    expect(isRepositoryInput("input", true)).toBe(true);
    expect(isRepositoryInput("input", false)).toBe(true);
  });

  it("offers the base-ref select whenever branches are known, in auto mode", () => {
    const branches = ["main", "dev"];
    // A known ref selects directly…
    expect(isBranchInput("auto", branches)).toBe(false);
    // …and even an unknown/inherited ref still shows the dropdown (landing on
    // the Custom sentinel) rather than trapping the user in a text box.
    expect(isBranchInput("auto", branches)).toBe(false);
    // "Choose from branches…" forces the select open.
    expect(isBranchInput("select", branches)).toBe(false);
    // "Custom ref…" forces free text.
    expect(isBranchInput("input", branches)).toBe(true);
  });

  it("renders free text when no branches are known, regardless of view", () => {
    expect(isBranchInput("select", [])).toBe(true);
    expect(isBranchInput("auto", [])).toBe(true);
    expect(isBranchInput("input", [])).toBe(true);
  });
});

describe("auto-prefill of an undiscovered default repository", () => {
  const fomoRepo = repository({
    id: "github:FoMo-Exp/AutoFixer",
    owner: "FoMo-Exp",
    name: "AutoFixer",
    defaultBranch: "main",
  });
  const otherRepo = repository({
    id: "github:someone/other",
    owner: "someone",
    name: "other",
  });
  const options = buildRepositoryOptions(
    [githubAccount],
    new Map([[githubAccount.id, [otherRepo, fomoRepo]]]),
  );

  it("prefers a discovered repo whose name matches the default, across owners", () => {
    // The form default points at an owner the bound account does not see;
    // the discovered FoMo-Exp/AutoFixer should still be recognised by name.
    const picked = pickPrefillOption(options, "github:Luthiel/AutoFixer");
    expect(picked?.repositoryId).toBe("github:FoMo-Exp/AutoFixer");
  });

  it("is case-insensitive on the repository name", () => {
    const picked = pickPrefillOption(options, "github:Luthiel/autofixer");
    expect(picked?.repositoryId).toBe("github:FoMo-Exp/AutoFixer");
  });

  it("falls back to the first option when no name matches", () => {
    const picked = pickPrefillOption(options, "github:acme/unrelated");
    expect(picked?.repositoryId).toBe("github:someone/other");
  });

  it("returns undefined when nothing was discovered", () => {
    expect(pickPrefillOption([], "github:Luthiel/AutoFixer")).toBeUndefined();
  });

  it("handles a default with no owner segment", () => {
    const picked = pickPrefillOption(options, "AutoFixer");
    // No slash means no name to match, so it falls back to the first option.
    expect(picked?.repositoryId).toBe("github:someone/other");
  });
});
