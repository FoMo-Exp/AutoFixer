import { withServiceCredential } from "../provider-access/credentials.js";
import type { ServiceCredentialStore } from "../provider-access/credentials.js";
import { createFetchHttpClient } from "../provider-access/provider-http.js";
import type { ProviderHttpClient } from "../provider-access/provider-http.js";
import { parseCanonicalRepositoryId } from "../provider-access/canonical-repository.js";
import type { CanonicalRepositoryId } from "../provider-access/canonical-repository.js";
import { isGitObjectId } from "./git-objects.js";
import { GovernanceProviderError } from "./pr-governance.js";
import type {
  GovernanceApprovalObservation,
  GovernanceCheckObservation,
  PRGovernanceProvider,
  ProviderGovernanceSnapshot,
} from "./pr-governance.js";
import type { RepositoryRef } from "./types.js";

/**
 * Read-only GitHub pull-request governance reader (DAT-261, ADR-0007).
 *
 * The adapter answers exactly one question: what did GitHub observe about
 * this pull request's current head — its check runs, its decisive reviews, and
 * whether its review conversations are resolved? It can issue three kinds of
 * request, all reads:
 *
 * - `GET /repos/{owner}/{repo}/pulls/{number}` (the current head and state);
 * - `GET /repos/{owner}/{repo}/commits/{head}/check-runs` and
 *   `GET /repos/{owner}/{repo}/pulls/{number}/reviews` (paginated reads);
 * - one `POST /graphql` **query** for review-thread resolution, which the
 *   REST surface does not expose. The body is a fixed `query`, never a
 *   mutation; the adapter has no approve, merge, dismiss, or rerun call.
 *
 * Failure classification is deliberately fail-closed: a missing integration or
 * credential, a 401/403, or an absent PR is `blocked`; a timeout, rate limit,
 * 5xx, truncated page, or malformed body is `unknown`. Neither case reuses the
 * last observation — a head we cannot read is not a head we may claim.
 *
 * The credential is the integration's **source** (read-only) reference, never
 * the broker's delivery credential: observing governance must not require the
 * write capability that opens branches and pull requests.
 */

export interface GitHubGovernanceBinding {
  /** Canonical id, e.g. `github:FoMo-Exp/AutoFixer`. */
  canonical_repository_id: string;
  /** Read-only credential reference from the integration; never a secret. */
  credential_ref: string;
}

export interface GitHubGovernanceProviderOptions {
  credentials: ServiceCredentialStore;
  /**
   * Resolve the active repository integration for one repository. `null`
   * means no read integration is available, and observation is blocked
   * rather than borrowed from another repository's credential.
   */
  resolve: (repository: RepositoryRef) => GitHubGovernanceBinding | null;
  /** Provider API base; defaults to `https://api.github.com`. */
  api_base_url?: string;
  /** GraphQL base; derived from the API base when omitted. */
  graphql_url?: string;
  http?: ProviderHttpClient;
  request_timeout_ms?: number;
  per_page?: number;
  pages_max?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAGES_MAX = 5;

const REVIEW_THREADS_QUERY = [
  "query AutoFixerReviewThreads($owner: String!, $repo: String!, $number: Int!) {",
  "  repository(owner: $owner, name: $repo) {",
  "    pullRequest(number: $number) {",
  "      reviewThreads(first: 100) {",
  "        pageInfo { hasNextPage }",
  "        nodes { isResolved }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

interface BoundRepository {
  coords: CanonicalRepositoryId;
  credential_ref: string;
  repo_path: string;
}

interface GitHubAnswer {
  status: number;
  json: Record<string, unknown> | null;
  body: unknown;
  links: string;
}

interface PullRequestEvidence {
  head_sha: string;
  state: "open" | "closed" | "merged";
}

/** Review states documented as not decisive for the head. */
const NON_DECISIVE_REVIEW_STATES = new Set(["COMMENTED", "PENDING", "DISMISSED"]);

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

export function createGitHubGovernanceProvider(
  options: GitHubGovernanceProviderOptions,
): PRGovernanceProvider {
  const apiBase = normalizeBase(options.api_base_url, "https://api.github.com", "API");
  const graphqlUrl = options.graphql_url ?? deriveGraphqlUrl(apiBase);
  const transport = options.http ?? createFetchHttpClient();
  const timeoutMs = options.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("governance provider request timeout must be a positive integer");
  }
  const perPage = Math.min(Math.max(options.per_page ?? 100, 1), 100);
  const pagesMax = Math.max(options.pages_max ?? DEFAULT_PAGES_MAX, 1);

  function bindingFor(repository: RepositoryRef): BoundRepository {
    const binding = options.resolve(repository);
    if (binding === null) {
      throw new GovernanceProviderError("blocked", "integration_not_configured");
    }
    let coords: CanonicalRepositoryId;
    try {
      coords = parseCanonicalRepositoryId(binding.canonical_repository_id);
    } catch {
      throw new GovernanceProviderError("blocked", "integration_not_configured");
    }
    if (coords.provider !== "github" || coords.canonical !== repository.repository_id) {
      throw new GovernanceProviderError("blocked", "integration_not_configured");
    }
    let url: URL;
    try {
      url = new URL(repository.url);
    } catch {
      throw new GovernanceProviderError("blocked", "integration_not_configured");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new GovernanceProviderError("blocked", "integration_not_configured");
    }
    return { coords, credential_ref: binding.credential_ref, repo_path: coords.path };
  }

  async function secretFor<T>(
    bound: BoundRepository,
    fn: (secret: string) => Promise<T>,
  ): Promise<T> {
    let secret: string;
    try {
      secret = withServiceCredential(options.credentials, bound.credential_ref, (value) => value);
    } catch {
      throw new GovernanceProviderError("blocked", "credential_unavailable");
    }
    return fn(secret);
  }

  async function call(
    secret: string,
    url: string,
    init: { method: "GET" | "POST"; body?: string },
  ): Promise<GitHubAnswer> {
    let response;
    try {
      response = await withDeadline(
        transport({
          url,
          method: init.method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${secret}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(init.body !== undefined ? { body: init.body } : {}),
        }),
        timeoutMs,
      );
    } catch {
      throw new GovernanceProviderError("unknown", "provider_unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new GovernanceProviderError("blocked", "permission_denied");
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GovernanceProviderError("unknown", "provider_unavailable");
    }
    let body: unknown = null;
    if (response.body.trim() !== "") {
      try {
        body = JSON.parse(response.body) as unknown;
      } catch {
        throw new GovernanceProviderError("unknown", "invalid_provider_response");
      }
    }
    return {
      status: response.status,
      json: recordField(body),
      body,
      links: response.headers["link"] ?? "",
    };
  }

  async function readPullRequest(
    secret: string,
    bound: BoundRepository,
    number: number,
  ): Promise<PullRequestEvidence> {
    const response = await call(
      secret,
      `${apiBase}/repos/${bound.repo_path}/pulls/${String(number)}`,
      {
        method: "GET",
      },
    );
    if (response.status === 404) {
      throw new GovernanceProviderError("blocked", "pull_request_not_found");
    }
    if (response.status !== 200 || response.json === null) {
      throw new GovernanceProviderError("unknown", "invalid_provider_response");
    }
    const head = recordField(response.json["head"]);
    const headSha = stringField(head?.["sha"]);
    if (headSha === null || !isGitObjectId(headSha)) {
      throw new GovernanceProviderError("unknown", "invalid_provider_response");
    }
    const state =
      response.json["merged_at"] !== null && response.json["merged_at"] !== undefined
        ? "merged"
        : stringField(response.json["state"]) === "closed"
          ? "closed"
          : "open";
    return { head_sha: headSha, state };
  }

  interface PageRead {
    rows: Record<string, unknown>[];
    /** At least one row was not the documented object shape. */
    malformed: boolean;
    /** The list stopped at `pagesMax` while the provider still had more. */
    truncated: boolean;
  }

  /**
   * Read one paginated list. `extract` receives the decoded body and returns
   * the page's rows (or null when the container shape is not what the endpoint
   * documents). A row that is not an object is reported as `malformed` rather
   * than dropped: silently discarding a row could hide the newest failing
   * check or rejecting review. A short page ends the list; a permanently full
   * list is `truncated` and must never be read as complete.
   */
  async function readPages(
    secret: string,
    url: string,
    extract: (body: unknown) => { rows: unknown[] } | null,
  ): Promise<PageRead> {
    const rows: Record<string, unknown>[] = [];
    let malformed = false;
    for (let page = 1; page <= pagesMax; page += 1) {
      const target = `${url}${url.includes("?") ? "&" : "?"}per_page=${String(perPage)}&page=${String(page)}`;
      const response = await call(secret, target, { method: "GET" });
      if (response.status === 404) {
        return { rows: [], malformed: false, truncated: false };
      }
      if (response.status !== 200) {
        throw new GovernanceProviderError("unknown", "invalid_provider_response");
      }
      const extracted = extract(response.body);
      if (extracted === null) {
        throw new GovernanceProviderError("unknown", "invalid_provider_response");
      }
      for (const row of extracted.rows) {
        const parsed = recordField(row);
        if (parsed === null) {
          malformed = true;
          continue;
        }
        rows.push(parsed);
      }
      if (extracted.rows.length < perPage) {
        return { rows, malformed, truncated: false };
      }
      if (response.links !== "" && !/rel="next"/.test(response.links)) {
        return { rows, malformed, truncated: false };
      }
    }
    return { rows, malformed, truncated: true };
  }

  function arrayRows(body: unknown): { rows: unknown[] } | null {
    return Array.isArray(body) ? { rows: body } : null;
  }

  function checkRunRows(body: unknown): { rows: unknown[] } | null {
    const container = recordField(body);
    const rows = container?.["check_runs"];
    return Array.isArray(rows) ? { rows } : null;
  }

  async function readChecks(
    secret: string,
    bound: BoundRepository,
    headSha: string,
    observedAt: string,
  ): Promise<{ checks: GovernanceCheckObservation[]; complete: boolean }> {
    const page = await readPages(
      secret,
      `${apiBase}/repos/${bound.repo_path}/commits/${headSha}/check-runs?filter=latest`,
      checkRunRows,
    );
    const checks: GovernanceCheckObservation[] = [];
    let complete = !page.malformed && !page.truncated;
    for (const row of page.rows) {
      const name = stringField(row["name"]);
      const rowSha = stringField(row["head_sha"]);
      const rawStatus = stringField(row["status"]);
      if (name === null || rowSha === null || !isGitObjectId(rowSha) || rawStatus === null) {
        // A check row we cannot bind to name/commit/status could be the failing
        // one; the check set is not complete.
        complete = false;
        continue;
      }
      const conclusion = stringField(row["conclusion"]);
      const completedAt = stringField(row["completed_at"]) ?? stringField(row["started_at"]);
      checks.push({
        name,
        status:
          rawStatus !== "completed"
            ? "pending"
            : conclusion === "success"
              ? "passed"
              : conclusion !== null && FAILED_CONCLUSIONS.has(conclusion)
                ? "failed"
                : // neutral/skipped/stale are not evidence of passing.
                  "pending",
        head_sha: rowSha,
        observed_at: completedAt ?? observedAt,
      });
    }
    return { checks, complete };
  }

  async function readApprovals(
    secret: string,
    bound: BoundRepository,
    number: number,
  ): Promise<{ approvals: GovernanceApprovalObservation[]; complete: boolean }> {
    const page = await readPages(
      secret,
      `${apiBase}/repos/${bound.repo_path}/pulls/${String(number)}/reviews`,
      arrayRows,
    );
    const approvals: GovernanceApprovalObservation[] = [];
    let complete = !page.malformed && !page.truncated;
    for (const row of page.rows) {
      const state = stringField(row["state"]);
      if (state === null) {
        // A review without a readable state could be the newest rejection.
        complete = false;
        continue;
      }
      if (NON_DECISIVE_REVIEW_STATES.has(state)) {
        continue;
      }
      if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") {
        // An unrecognised state may be decisive in a newer API revision, so
        // the review set cannot be treated as complete.
        complete = false;
        continue;
      }
      const user = recordField(row["user"]);
      const identity = stringField(user?.["login"]);
      const commitId = stringField(row["commit_id"]);
      const submittedAt = stringField(row["submitted_at"]);
      if (
        identity === null ||
        commitId === null ||
        !isGitObjectId(commitId) ||
        submittedAt === null
      ) {
        // A decisive review that cannot be bound to reviewer/commit/time must
        // never be dropped: dropping a newer rejection would leave an older
        // approval looking like the reviewer's latest decision.
        complete = false;
        continue;
      }
      approvals.push({
        identity,
        decision: state === "APPROVED" ? "approved" : "changes_requested",
        head_sha: commitId,
        submitted_at: submittedAt,
      });
    }
    return { approvals, complete };
  }

  async function readUnresolvedDiscussions(
    secret: string,
    coords: CanonicalRepositoryId,
    number: number,
  ): Promise<number> {
    const response = await call(secret, graphqlUrl, {
      method: "POST",
      body: JSON.stringify({
        query: REVIEW_THREADS_QUERY,
        variables: { owner: coords.owner, repo: coords.name, number },
      }),
    });
    if (response.status !== 200 || response.json === null) {
      throw new GovernanceProviderError("unknown", "invalid_provider_response");
    }
    if (Array.isArray(response.json["errors"]) && response.json["errors"].length > 0) {
      throw new GovernanceProviderError("unknown", "invalid_provider_response");
    }
    const data = recordField(response.json["data"]);
    const repository = recordField(data?.["repository"]);
    const pullRequest = recordField(repository?.["pullRequest"]);
    const threads = recordField(pullRequest?.["reviewThreads"]);
    const nodes = threads?.["nodes"];
    const pageInfo = recordField(threads?.["pageInfo"]);
    if (!Array.isArray(nodes) || pageInfo?.["hasNextPage"] === true) {
      // A truncated thread list cannot prove "no unresolved conversations".
      throw new GovernanceProviderError("unknown", "invalid_provider_response");
    }
    let unresolved = 0;
    for (const node of nodes) {
      const thread = recordField(node);
      if (thread === null || typeof thread["isResolved"] !== "boolean") {
        throw new GovernanceProviderError("unknown", "invalid_provider_response");
      }
      if (thread["isResolved"] === false) {
        unresolved += 1;
      }
    }
    return unresolved;
  }

  return {
    provider: "github",
    async observe(repository: RepositoryRef, prId: string): Promise<ProviderGovernanceSnapshot> {
      const bound = bindingFor(repository);
      const number = /^[1-9][0-9]{0,9}$/.test(prId) ? Number(prId) : null;
      if (number === null) {
        throw new GovernanceProviderError("blocked", "pull_request_not_found");
      }
      const observedAt = new Date().toISOString();
      return secretFor(bound, async (secret) => {
        const pull = await readPullRequest(secret, bound, number);
        const checks = await readChecks(secret, bound, pull.head_sha, observedAt);
        const reviews = await readApprovals(secret, bound, number);
        const unresolved = await readUnresolvedDiscussions(secret, bound.coords, number);
        return {
          head_sha: pull.head_sha,
          pull_request_state: pull.state,
          checks: checks.checks,
          checks_complete: checks.complete,
          approvals: reviews.approvals,
          approvals_complete: reviews.complete,
          unresolved_discussions: unresolved,
        };
      });
    },
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeBase(raw: string | undefined, fallback: string, label: string): string {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`governance provider ${label} base must be a clean HTTP(S) URL`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * github.com serves GraphQL at `https://api.github.com/graphql`; a GitHub
 * Enterprise API base (`<origin>/api/v3`) serves it at `<origin>/api/graphql`.
 */
function deriveGraphqlUrl(apiBase: string): string {
  if (apiBase.endsWith("/api/v3")) {
    return `${apiBase.slice(0, -"/api/v3".length)}/api/graphql`;
  }
  return `${apiBase}/graphql`;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new GovernanceProviderError("unknown", "provider_unavailable"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
