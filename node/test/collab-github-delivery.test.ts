import { afterEach, describe, expect, test } from "vitest";

import { diffDigest } from "../src/collab/candidate-store.js";
import { DeliveryProviderError } from "../src/collab/delivery-broker.js";
import type { DeliveryProvider, PushBranchInput } from "../src/collab/delivery-broker.js";
import { commitObjectSha, gitBlobSha } from "../src/collab/git-objects.js";
import { createGitHubDeliveryProvider } from "../src/collab/github-delivery.js";
import type { GitHubDeliveryBinding } from "../src/collab/github-delivery.js";
import type { CandidateCommit, RepositoryRef } from "../src/collab/types.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import { filesToTree, startFakeGitHub } from "./helpers/fake-github.js";
import type { FakeGitHub, FakeGitHubFault } from "./helpers/fake-github.js";

/**
 * The GitHub delivery adapter against an exact fake provider (DAT-260).
 *
 * The fake hashes real git objects, so "the pushed tree matches the approved
 * tree" is checked by the provider's own object ids rather than by a scripted
 * answer. Each case below is one of the issue's accepted outcomes: refusal
 * without a side effect, permission revocation, drift, an unreadable write
 * (ambiguous), and duplicate-PR avoidance.
 */

const OWNER = "FoMo-Exp";
const REPO = "AutoFixer";
const TOKEN = "ghs_delivery_token";
const CREDENTIAL_REF = "service/delivery/github";

const BASE_FILES: Record<string, string> = {
  "src/retry.ts": [
    "export function retryHeader(value: string | null): string {",
    "  return value.trim();",
    "}",
    "",
  ].join("\n"),
  "README.md": "# AutoFixer\n",
};

const CANDIDATE_FILES: Record<string, string> = {
  ...BASE_FILES,
  "src/retry.ts": [
    "export function retryHeader(value: string | null): string {",
    '  return value === null ? "" : value.trim();',
    "}",
    "",
  ].join("\n"),
};

const DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -2 +2 @@",
  "-  return value.trim();",
  '+  return value === null ? "" : value.trim();',
  "",
].join("\n");

const BASE_TREE = filesToTree(BASE_FILES).sha;
const CANDIDATE_TREE = filesToTree(CANDIDATE_FILES).sha;

const BASE_COMMIT: CandidateCommit = {
  message: "base\n",
  author: { name: "AutoFixer", email: "autofixer@localhost", date: "2026-11-01T00:00:00 +0000" },
  committer: {
    name: "AutoFixer",
    email: "autofixer@localhost",
    date: "2026-11-01T00:00:00 +0000",
  },
};
/**
 * Provider-side base commit. The sandbox helper refuses parentless commits
 * because a *candidate* always has its pinned base as parent; a repository's
 * root commit is not a candidate, so it gets an opaque placeholder parent here.
 */
const BASE = commitObjectSha({
  tree_sha: BASE_TREE,
  parent_shas: ["2".repeat(40)],
  identity: BASE_COMMIT,
});

const CANDIDATE_COMMIT: CandidateCommit = {
  message: "autofixer candidate for tsk_dat260\n\nrun: run_dat260\n",
  author: { name: "AutoFixer", email: "autofixer@localhost", date: "1970-01-01T00:00:00 +0000" },
  committer: {
    name: "AutoFixer",
    email: "autofixer@localhost",
    date: "1970-01-01T00:00:00 +0000",
  },
};
const HEAD = commitObjectSha({
  tree_sha: CANDIDATE_TREE,
  parent_shas: [BASE],
  identity: CANDIDATE_COMMIT,
});
const OTHER_HEAD = "1".repeat(40);

const REPOSITORY: RepositoryRef = {
  repository_id: `github:${OWNER}/${REPO}`,
  url: `https://github.com/${OWNER}/${REPO}.git`,
  base_ref: "main",
  base_sha: BASE,
};
const BRANCH = "autofixer/iss_dat260";

const BINDING: GitHubDeliveryBinding = {
  canonical_repository_id: `github:${OWNER}/${REPO}`,
  credential_ref: CREDENTIAL_REF,
};

interface Fixture {
  fake: FakeGitHub;
  provider: DeliveryProvider;
}

const open: FakeGitHub[] = [];

afterEach(async () => {
  while (open.length > 0) {
    await (open.pop() as FakeGitHub).close();
  }
});

async function setup(
  options: {
    refs?: Record<string, string>;
    faults?: FakeGitHubFault[];
    binding?: GitHubDeliveryBinding | null;
    override?: Parameters<typeof startFakeGitHub>[0]["override"];
    requestTimeoutMs?: number;
    token?: string;
  } = {},
): Promise<Fixture> {
  const fake = await startFakeGitHub({
    owner: OWNER,
    repo: REPO,
    refs: { main: BASE, ...(options.refs ?? {}) },
    token: TOKEN,
    ...(options.faults !== undefined ? { faults: options.faults } : {}),
    ...(options.override !== undefined ? { override: options.override } : {}),
  });
  open.push(fake);
  fake.addTree(BASE_FILES);
  fake.addTree(CANDIDATE_FILES);
  expect(fake.addCommit(BASE_TREE, ["2".repeat(40)], BASE_COMMIT)).toBe(BASE);
  expect(fake.addCommit(CANDIDATE_TREE, [BASE], CANDIDATE_COMMIT)).toBe(HEAD);

  const binding = options.binding === undefined ? BINDING : options.binding;
  const provider = createGitHubDeliveryProvider({
    credentials: createStaticServiceCredentialStore({
      [CREDENTIAL_REF]: options.token ?? TOKEN,
    }),
    resolve: () => binding,
    api_base_url: fake.base_url,
    request_timeout_ms: options.requestTimeoutMs ?? 2_000,
  });
  return { fake, provider };
}

function pushInput(overrides: Partial<PushBranchInput> = {}): PushBranchInput {
  return {
    repository: REPOSITORY,
    branch: BRANCH,
    base_sha: BASE,
    head_sha: HEAD,
    tree_sha: CANDIDATE_TREE,
    diff_digest: diffDigest(DIFF),
    diff_content: DIFF,
    commit: CANDIDATE_COMMIT,
    ...overrides,
  };
}

function expectProviderError(fn: () => Promise<unknown>): Promise<void> {
  return fn().then(
    () => {
      throw new Error("expected a DeliveryProviderError");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(DeliveryProviderError);
    },
  );
}

describe("pushBranch", () => {
  test("publishes the approved commit and its exact tree on the autofixer branch", async () => {
    const { fake, provider } = await setup();
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "pushed", head_sha: HEAD });

    // The provider holds the approved commit object, not an equivalent one.
    expect(fake.refs.get(BRANCH)).toBe(HEAD);
    expect(fake.commits.get(HEAD)).toEqual({
      sha: HEAD,
      tree_sha: CANDIDATE_TREE,
      parents: [BASE],
    });
    const pushed = fake.trees.get(CANDIDATE_TREE);
    expect(pushed).toBeDefined();
    const retry = pushed?.find((entry) => entry.path === "src/retry.ts");
    expect(retry?.sha).toBe(gitBlobSha(CANDIDATE_FILES["src/retry.ts"] as string));

    // The base branch never moves, and the credential is attached to every call.
    expect(fake.refs.get("main")).toBe(BASE);
    for (const request of fake.requests) {
      expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("updates a branch that still sits at the pinned base", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: BASE } });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome.status).toBe("pushed");
    expect(fake.refs.get(BRANCH)).toBe(HEAD);
    expect(fake.writes()).toContain(`PATCH /repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`);
    expect(
      fake.writes().some((write) => write.startsWith("POST") && write.endsWith("/git/refs")),
    ).toBe(false);
  });

  test("is idempotent when the branch already holds the approved commit", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: HEAD } });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "pushed", head_sha: HEAD });
    expect(fake.writes()).toEqual([]);
  });

  test("refuses a branch that drifted to another commit", async () => {
    const { fake, provider } = await setup({
      refs: { [BRANCH]: OTHER_HEAD },
      // An unknown commit object makes the drift concrete provider evidence.
      faults: [],
    });
    // The fake has no commit for OTHER_HEAD; reads of it are not needed for the
    // drift decision, which only compares refs.
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_BRANCH_DRIFT" });
    expect(fake.refs.get(BRANCH)).toBe(OTHER_HEAD);
    expect(fake.writes()).toEqual([]);
  });

  test("refuses a base branch that advanced past the approval", async () => {
    const { fake, provider } = await setup({ refs: { main: OTHER_HEAD } });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_BASE_ADVANCED" });
    expect(fake.writes()).toEqual([]);
  });

  test("refuses a provider tree that does not hash to the approved tree", async () => {
    const { fake, provider } = await setup({ override: { tree_sha: OTHER_HEAD } });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_TREE_MISMATCH" });
    expect(fake.refs.get(BRANCH)).toBeUndefined();
  });

  test("refuses a provider commit that does not hash to the approved head", async () => {
    const { fake, provider } = await setup({ override: { commit_sha: OTHER_HEAD } });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_COMMIT_MISMATCH" });
    expect(fake.refs.get(BRANCH)).toBeUndefined();
  });

  test("refuses a commit identity that does not reproduce the approved head before any request", async () => {
    const { fake, provider } = await setup();
    const outcome = await provider.pushBranch(
      pushInput({ commit: { ...CANDIDATE_COMMIT, message: "rewritten\n" } }),
    );
    expect(outcome).toEqual({
      status: "failed",
      error_code: "PROVIDER_COMMIT_IDENTITY_MISMATCH",
    });
    expect(fake.requests).toEqual([]);
  });

  test("refuses a patch the base cannot reproduce", async () => {
    const { fake, provider } = await setup();
    const outcome = await provider.pushBranch(
      pushInput({ diff_content: DIFF.replace("  return value.trim();", "  return value;") }),
    );
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_PATCH_MISMATCH" });
    expect(fake.writes()).toEqual([]);
  });

  test("refuses a binary patch", async () => {
    const { fake, provider } = await setup();
    const outcome = await provider.pushBranch(
      pushInput({ diff_content: "diff --git a/a.png b/a.png\nGIT binary patch\nliteral 1\nA\n" }),
    );
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_BINARY_PATCH" });
    expect(fake.requests).toEqual([]);
  });

  test("maps a revoked credential to a definite permission failure", async () => {
    const { fake, provider } = await setup({ token: "another-token" });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_PERMISSION_DENIED" });
    expect(fake.refs.get(BRANCH)).toBeUndefined();
  });

  test("maps a provider 403 on the ref write to a permission failure", async () => {
    const { fake, provider } = await setup({
      refs: { [BRANCH]: BASE },
      faults: [{ method: "PATCH", path: `/git/refs/heads/${BRANCH}`, status: 403 }],
    });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_PERMISSION_DENIED" });
    expect(fake.refs.get(BRANCH)).toBe(BASE);
  });

  test("a timed-out ref write is ambiguous, and the provider may still hold the commit", async () => {
    const { fake, provider } = await setup({
      refs: { [BRANCH]: BASE },
      requestTimeoutMs: 100,
      faults: [{ method: "PATCH", path: `/git/refs/heads/${BRANCH}`, delayMs: 400 }],
    });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "ambiguous", error_code: "PROVIDER_PUSH_UNKNOWN" });
    // The write reached the service before the deadline; only reconciliation
    // may decide the outcome from this evidence.
    expect(fake.refs.get(BRANCH)).toBe(HEAD);
    await expect(provider.observeBranch(REPOSITORY, BRANCH)).resolves.toEqual({
      head_sha: HEAD,
    });
  });

  test("refuses a repository with no bound delivery integration", async () => {
    const { fake, provider } = await setup({ binding: null });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_NOT_CONFIGURED" });
    expect(fake.requests).toEqual([]);
  });

  test("refuses a binding for another repository", async () => {
    const { provider } = await setup({
      binding: {
        canonical_repository_id: "github:FoMo-Exp/Other",
        credential_ref: CREDENTIAL_REF,
      },
    });
    const outcome = await provider.pushBranch(pushInput());
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_NOT_CONFIGURED" });
  });

  test("refuses a repository URL that is not the canonical GitHub repository", async () => {
    const { provider } = await setup();
    const outcome = await provider.pushBranch(
      pushInput({
        repository: { ...REPOSITORY, url: "https://github.com/attacker/AutoFixer.git" },
      }),
    );
    expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_NOT_CONFIGURED" });
  });

  test.each(["main", "master", "feature/x", "autofixer/", "autofixer/a..b"])(
    "refuses the branch %s",
    async (branch) => {
      const { fake, provider } = await setup();
      const outcome = await provider.pushBranch(pushInput({ branch }));
      expect(outcome).toEqual({ status: "failed", error_code: "PROVIDER_BRANCH_FORBIDDEN" });
      expect(fake.requests).toEqual([]);
    },
  );
});

describe("observeBranch", () => {
  test("returns null for an absent branch", async () => {
    const { provider } = await setup();
    await expect(provider.observeBranch(REPOSITORY, BRANCH)).resolves.toEqual({ head_sha: null });
  });

  test("returns the branch head", async () => {
    const { provider } = await setup({ refs: { [BRANCH]: HEAD } });
    await expect(provider.observeBranch(REPOSITORY, BRANCH)).resolves.toEqual({ head_sha: HEAD });
  });

  test("a denied read is a provider error, not evidence of absence", async () => {
    const { provider } = await setup({
      faults: [{ method: "GET", path: `/git/ref/heads/${BRANCH}`, status: 403 }],
    });
    await expectProviderError(() => provider.observeBranch(REPOSITORY, BRANCH));
  });

  test("refuses to observe a branch outside the autofixer namespace", async () => {
    const { provider } = await setup();
    await expectProviderError(() => provider.observeBranch(REPOSITORY, "main"));
  });
});

describe("pull requests", () => {
  test("opens a PR for the pushed branch and reuses it on the next read", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: HEAD } });
    const pr = await provider.openPullRequest({
      repository: REPOSITORY,
      branch: BRANCH,
      target_branch: "main",
      head_sha: HEAD,
      title: "Fix iss_dat260",
      body: "body",
    });
    expect(pr).toMatchObject({
      branch: BRANCH,
      head_sha: HEAD,
      base_ref: "main",
      state: "open",
    });
    expect(fake.pullRequests).toHaveLength(1);
    await expect(provider.findPullRequest(REPOSITORY, BRANCH, HEAD, "main")).resolves.toEqual(pr);
  });

  test("never opens a duplicate PR for the same branch revision", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: HEAD } });
    const first = fake.addPullRequest({ head_ref: BRANCH, head_sha: HEAD, base_ref: "main" });
    const pr = await provider.openPullRequest({
      repository: REPOSITORY,
      branch: BRANCH,
      target_branch: "main",
      head_sha: HEAD,
      title: "Fix iss_dat260",
      body: "body",
    });
    expect(pr.pr_id).toBe(String(first.number));
    expect(fake.pullRequests).toHaveLength(1);
    expect(fake.writes().some((write) => write === `POST /repos/${OWNER}/${REPO}/pulls`)).toBe(
      false,
    );
  });

  test("findPullRequest prefers the open PR over an older closed one", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: HEAD } });
    fake.addPullRequest({
      head_ref: BRANCH,
      head_sha: HEAD,
      base_ref: "main",
      state: "closed",
    });
    const open = fake.addPullRequest({ head_ref: BRANCH, head_sha: HEAD, base_ref: "main" });
    const found = await provider.findPullRequest(REPOSITORY, BRANCH, HEAD, "main");
    expect(found?.pr_id).toBe(String(open.number));
    expect(found?.pr_id).toBe(String(open.number));
  });

  test("findPullRequest ignores a PR at another head", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: HEAD } });
    fake.addPullRequest({ head_ref: BRANCH, head_sha: OTHER_HEAD, base_ref: "main" });
    await expect(provider.findPullRequest(REPOSITORY, BRANCH, HEAD, "main")).resolves.toBeNull();
  });

  test("findPullRequest ignores a PR at the same head targeting another base", async () => {
    const { fake, provider } = await setup({ refs: { [BRANCH]: HEAD } });
    fake.addPullRequest({ head_ref: BRANCH, head_sha: HEAD, base_ref: "release" });
    await expect(provider.findPullRequest(REPOSITORY, BRANCH, HEAD, "main")).resolves.toBeNull();
  });

  test("findPullRequest refuses a target other than the repository base", async () => {
    const { provider } = await setup({ refs: { [BRANCH]: HEAD } });
    await expectProviderError(() => provider.findPullRequest(REPOSITORY, BRANCH, HEAD, "release"));
  });

  test("refuses to target anything but the repository base branch", async () => {
    const { provider } = await setup({ refs: { [BRANCH]: HEAD } });
    await expectProviderError(() =>
      provider.openPullRequest({
        repository: REPOSITORY,
        branch: BRANCH,
        target_branch: "release",
        head_sha: HEAD,
        title: "t",
        body: "b",
      }),
    );
  });

  test("a created PR whose head does not match the delivery is refused", async () => {
    const { provider } = await setup({
      refs: { [BRANCH]: HEAD },
      override: { pull_head_sha: OTHER_HEAD },
    });
    await expectProviderError(() =>
      provider.openPullRequest({
        repository: REPOSITORY,
        branch: BRANCH,
        target_branch: "main",
        head_sha: HEAD,
        title: "t",
        body: "b",
      }),
    );
  });

  test("a created PR whose base does not match the delivery is refused", async () => {
    const { provider } = await setup({
      refs: { [BRANCH]: HEAD },
      override: { pull_base_ref: "release" },
    });
    await expectProviderError(() =>
      provider.openPullRequest({
        repository: REPOSITORY,
        branch: BRANCH,
        target_branch: "main",
        head_sha: HEAD,
        title: "t",
        body: "b",
      }),
    );
  });
});

describe("capability surface", () => {
  test("advertises no merge or review operation", () => {
    const provider = createGitHubDeliveryProvider({
      credentials: createStaticServiceCredentialStore({}),
      resolve: () => null,
    });
    expect(provider.provider).toBe("github");
    expect(provider.capabilities).toEqual({
      push: true,
      pull_request: true,
      repository_governance: "github_branch_protection",
    });
    for (const forbidden of ["merge", "closePullRequest", "forcePush", "review"]) {
      expect(forbidden in provider).toBe(false);
    }
  });
});
