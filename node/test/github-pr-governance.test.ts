import { afterEach, describe, expect, test } from "vitest";

import {
  GovernanceProviderError,
  PullRequestGovernanceService,
} from "../src/collab/pr-governance.js";
import { createGitHubGovernanceProvider } from "../src/collab/github-pr-governance.js";
import type { GitHubGovernanceBinding } from "../src/collab/github-pr-governance.js";
import type { PRGovernanceProvider } from "../src/collab/pr-governance.js";
import type { DeliveryRecord, RepositoryRef } from "../src/collab/types.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import { startFakeGitHub } from "./helpers/fake-github.js";
import type { FakeGitHub, FakeGitHubFault, FakeGitHubOptions } from "./helpers/fake-github.js";

/**
 * The read-only GitHub governance reader against an exact fake provider
 * (DAT-261).
 *
 * The fake serves GitHub-shaped REST/GraphQL answers, so the adapter is tested
 * on what production actually returns: check runs bound to a commit, reviews
 * bound to a `commit_id`, and review-thread resolution (REST has no field for
 * it, which is why the read-only GraphQL query exists). Cases cover passing,
 * failing, and pending checks, an unresolved discussion, an old-head approval
 * that must not survive a new head, and every blocked/unknown failure mode.
 */

const OWNER = "FoMo-Exp";
const REPO = "AutoFixer";
const TOKEN = "ghs_source_read_token";
const CREDENTIAL_REF = "service/source/github";
const HEAD = "1".repeat(40);
const PR_NUMBER = 1;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;

const REPOSITORY: RepositoryRef = {
  repository_id: `github:${OWNER}/${REPO}`,
  url: `https://github.com/${OWNER}/${REPO}.git`,
  base_ref: "main",
  base_sha: "3".repeat(40),
};

const BINDING: GitHubGovernanceBinding = {
  canonical_repository_id: `github:${OWNER}/${REPO}`,
  credential_ref: CREDENTIAL_REF,
};

const DELIVERY: DeliveryRecord = {
  delivery_id: "dlv_dat261",
  operation_id: "op_dat261",
  issue_id: "iss_dat261",
  candidate_id: "cand_dat261",
  approval_id: "apr_dat261",
  repository: REPOSITORY,
  target_branch: "main",
  head_sha: HEAD,
  provider: "github",
  state: "delivered",
  branch: "autofixer/iss_dat261",
  pr_id: String(PR_NUMBER),
  pr_url: PR_URL,
  error_code: null,
  created_at: "2026-11-18T09:00:00.000Z",
  updated_at: "2026-11-18T09:00:00.000Z",
  reconciled_at: null,
  grant_id: "grt_dat261",
};

interface Fixture {
  fake: FakeGitHub;
  provider: PRGovernanceProvider;
}

const open: FakeGitHub[] = [];

afterEach(async () => {
  while (open.length > 0) {
    await (open.pop() as FakeGitHub).close();
  }
});

function baseGovernance(): NonNullable<FakeGitHubOptions["governance"]> {
  return {
    check_runs: [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        head_sha: HEAD,
        completed_at: "2026-11-18T09:10:00Z",
      },
      {
        name: "lint",
        status: "completed",
        conclusion: "success",
        head_sha: HEAD,
        completed_at: "2026-11-18T09:11:00Z",
      },
    ],
    reviews: [
      {
        user: { login: "Luthiel" },
        state: "APPROVED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:12:00Z",
      },
      {
        user: { login: "Ludwig-Planck" },
        state: "APPROVED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:13:00Z",
      },
      {
        user: { login: "reviewer" },
        state: "COMMENTED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:14:00Z",
      },
    ],
    review_threads: [{ isResolved: true }, { isResolved: true }],
  };
}

async function setup(
  options: {
    governance?: NonNullable<FakeGitHubOptions["governance"]>;
    faults?: FakeGitHubFault[];
    binding?: GitHubGovernanceBinding | null;
    credentials?: Record<string, string>;
    prHead?: string;
  } = {},
): Promise<Fixture> {
  const fake = await startFakeGitHub({
    owner: OWNER,
    repo: REPO,
    refs: { main: REPOSITORY.base_sha },
    token: TOKEN,
    governance: options.governance ?? baseGovernance(),
    ...(options.faults !== undefined ? { faults: options.faults } : {}),
  });
  open.push(fake);
  fake.addPullRequest({
    head_ref: "autofixer/iss_dat261",
    head_sha: options.prHead ?? HEAD,
    base_ref: "main",
  });
  const binding = options.binding === undefined ? BINDING : options.binding;
  const provider = createGitHubGovernanceProvider({
    credentials: createStaticServiceCredentialStore({
      ...{ [CREDENTIAL_REF]: TOKEN },
      ...(options.credentials ?? {}),
    }),
    resolve: () => binding,
    api_base_url: fake.base_url,
    request_timeout_ms: 2_000,
  });
  return { fake, provider };
}

function unreliable(): PRGovernanceProvider {
  return {
    provider: "github",
    observe: () => Promise.reject(new GovernanceProviderError("unknown", "provider_unavailable")),
  };
}

describe("GitHub governance reads", () => {
  test("a passing, approved, resolved head is observed and eligible", async () => {
    const { fake, provider } = await setup();
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);

    expect(observation.head_sha).toBe(HEAD);
    expect(observation.validity).toBe("current");
    expect(observation.conditions_satisfied).toBe(true);
    expect(observation.unmet_condition).toBeNull();
    expect(observation.checks.items).toEqual([
      { name: "build", status: "passed", head_sha: HEAD, observed_at: "2026-11-18T09:10:00Z" },
      { name: "lint", status: "passed", head_sha: HEAD, observed_at: "2026-11-18T09:11:00Z" },
    ]);
    expect(observation.approvals.items.map((item) => item.identity)).toEqual([
      "Luthiel",
      "Ludwig-Planck",
    ]);
    expect(observation.review_discussions.unresolved).toBe(0);

    // The reader uses the read-only source credential on every call.
    for (const request of fake.requests) {
      expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    }
    // Only reads: the REST surface is GET-only and GraphQL carries a query.
    expect(fake.writes()).toEqual([]);
    const graphql = fake.requests.filter((request) => request.url === "/graphql");
    expect(graphql).toHaveLength(1);
    expect(graphql[0]?.method).toBe("POST");
    expect(JSON.parse(graphql[0]?.body ?? "{}")).toMatchObject({
      variables: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    });
    expect(graphql[0]?.body).toContain("query AutoFixerReviewThreads");
  });

  test("a failing check and a pending check are reported, not flattened", async () => {
    const governance = baseGovernance();
    governance.check_runs = [
      {
        name: "build",
        status: "completed",
        conclusion: "failure",
        head_sha: HEAD,
        completed_at: "2026-11-18T09:10:00Z",
      },
      { name: "e2e", status: "in_progress", conclusion: null, head_sha: HEAD },
    ];
    const { provider } = await setup({ governance });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.checks.items.map((item) => item.status)).toEqual(["failed", "pending"]);
    expect(observation.unmet_condition).toBe("checks_not_passed");
    expect(observation.conditions_satisfied).toBe(false);
  });

  test("an unresolved review thread blocks the head", async () => {
    const governance = baseGovernance();
    governance.review_threads = [{ isResolved: true }, { isResolved: false }];
    const { provider } = await setup({ governance });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.review_discussions.unresolved).toBe(1);
    expect(observation.unmet_condition).toBe("review_discussions_unresolved");
  });

  test("an older-head approval is not evidence about the current head", async () => {
    // The PR is at a head no review or check covered: the adapter still reads
    // the resource, and the service binds every surviving fact to that head.
    const other = "4".repeat(40);
    const { provider } = await setup({ prHead: other });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.head_sha).toBe(other);
    expect(observation.validity).toBe("superseded");
    expect(observation.unmet_condition).toBe("head_changed");
    expect(observation.checks.items).toEqual([]);
    expect(observation.approvals.items).toEqual([]);
    expect(observation.conditions_satisfied).toBe(false);
  });

  test("a changed head starts a fresh observation and marks the old one superseded", async () => {
    const { fake, provider } = await setup();
    const service = new PullRequestGovernanceService({ provider });
    const first = await service.observe(DELIVERY);
    expect(first.conditions_satisfied).toBe(true);

    // A human push moves the PR; the previous checks/approvals do not follow.
    const nextHead = "5".repeat(40);
    fake.pullRequests[0]!.head_sha = nextHead;
    const second = await service.observe(DELIVERY);
    expect(second.head_sha).toBe(nextHead);
    expect(second.validity).toBe("superseded");
    expect(second.checks.items).toEqual([]);
    expect(second.approvals.items).toEqual([]);
    expect(second.supersedes).toMatchObject({
      observation_id: first.observation_id,
      head_sha: HEAD,
      invalidation_reason: "head_changed",
    });
    expect(second.conditions_satisfied).toBe(false);
  });

  test("a truncated review-thread page is unknown, not 'all resolved'", async () => {
    const governance = baseGovernance();
    governance.thread_page_has_next = true;
    const { provider } = await setup({ governance });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.validity).toBe("unknown");
    expect(observation.review_discussions.reason).toBe("invalid_provider_response");
    expect(observation.review_discussions.unresolved).toBeNull();
  });
});

describe("uninterpretable review rows are never silently dropped", () => {
  test("an unreadable newer rejection makes the whole approval set unknown", async () => {
    const governance = baseGovernance();
    governance.reviews = [
      {
        user: { login: "Luthiel" },
        state: "APPROVED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:12:00Z",
      },
      // The newer, decisive rejection cannot be bound to a commit.
      {
        user: { login: "Luthiel" },
        state: "CHANGES_REQUESTED",
        commit_id: null,
        submitted_at: "2026-11-18T09:20:00Z",
      },
      {
        user: { login: "Ludwig-Planck" },
        state: "APPROVED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:13:00Z",
      },
    ];
    const { provider } = await setup({ governance });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.approvals).toMatchObject({
      state: "unknown",
      reason: "invalid_provider_response",
      satisfied: false,
      items: [],
    });
    expect(observation.checks.state).toBe("observed");
    expect(observation.validity).toBe("unknown");
    expect(observation.conditions_satisfied).toBe(false);
    expect(observation.unmet_condition).toBe("governance_unknown");
  });

  test("a non-object review row also makes the approval set unknown", async () => {
    const governance = baseGovernance();
    governance.reviews = [
      {
        user: { login: "Luthiel" },
        state: "APPROVED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:12:00Z",
      },
      "not-a-review",
    ];
    const { provider } = await setup({ governance });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.approvals.state).toBe("unknown");
    expect(observation.approvals.items).toEqual([]);
  });

  test("a decisive review without a submit time is not treated as absent", async () => {
    const governance = baseGovernance();
    governance.reviews = [
      {
        user: { login: "Luthiel" },
        state: "APPROVED",
        commit_id: HEAD,
        submitted_at: "2026-11-18T09:12:00Z",
      },
      { user: { login: "Luthiel" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
    ];
    const { provider } = await setup({ governance });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.approvals.satisfied).toBe(false);
    expect(observation.approvals.state).toBe("unknown");
    expect(observation.conditions_satisfied).toBe(false);
  });
});

describe("GitHub governance failure classification", () => {
  test("a permission denial is blocked and makes no further request", async () => {
    const { fake, provider } = await setup({
      faults: [{ method: "GET", path: `/pulls/${String(PR_NUMBER)}`, status: 403 }],
    });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.validity).toBe("blocked");
    expect(observation.checks.reason).toBe("permission_denied");
    expect(observation.head_sha).toBeNull();
    expect(observation.conditions_satisfied).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  test("a provider outage is unknown, never the previous head", async () => {
    const { provider } = await setup({
      faults: [{ method: "GET", path: `/pulls/${String(PR_NUMBER)}`, status: 500 }],
    });
    const observation = await new PullRequestGovernanceService({ provider: unreliable() }).observe(
      DELIVERY,
    );
    expect(observation.validity).toBe("unknown");
    expect(observation.unmet_condition).toBe("head_unavailable");

    const outage = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(outage.validity).toBe("unknown");
    expect(outage.checks.reason).toBe("provider_unavailable");
    expect(outage.head_sha).toBeNull();
    expect(outage.conditions_satisfied).toBe(false);
  });

  test("an absent pull request is blocked", async () => {
    const { provider } = await setup();
    const observation = await new PullRequestGovernanceService({ provider }).observe({
      ...DELIVERY,
      pr_id: "999",
    });
    expect(observation.validity).toBe("blocked");
    expect(observation.checks.reason).toBe("pull_request_not_found");
  });

  test("a missing credential is blocked before any network call", async () => {
    const { fake, provider } = await setup();
    const missing = createGitHubGovernanceProvider({
      credentials: createStaticServiceCredentialStore({}),
      resolve: () => BINDING,
      api_base_url: fake.base_url,
    });
    const blocked = await new PullRequestGovernanceService({ provider: missing }).observe(DELIVERY);
    expect(blocked.validity).toBe("blocked");
    expect(blocked.checks.reason).toBe("credential_unavailable");
    expect(fake.requests).toEqual([]);
    expect(provider).toBeDefined();
  });

  test("a repository without an integration is blocked, not borrowed from another", async () => {
    const { provider } = await setup({ binding: null });
    const observation = await new PullRequestGovernanceService({ provider }).observe(DELIVERY);
    expect(observation.validity).toBe("blocked");
    expect(observation.checks.reason).toBe("integration_not_configured");
  });
});
