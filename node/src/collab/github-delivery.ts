import {
  githubRepositoryPath,
  parseCanonicalRepositoryId,
} from "../provider-access/canonical-repository.js";
import type { CanonicalRepositoryId } from "../provider-access/canonical-repository.js";
import { withServiceCredential } from "../provider-access/credentials.js";
import type { ServiceCredentialStore } from "../provider-access/credentials.js";
import { createFetchHttpClient } from "../provider-access/provider-http.js";
import type { ProviderHttpClient } from "../provider-access/provider-http.js";
import { DeliveryProviderError } from "./delivery-broker.js";
import type {
  DeliveryProvider,
  DeliveryProviderCapabilities,
  OpenPullRequestInput,
  ProviderBranchEvidence,
  ProviderPullRequestEvidence,
  PushBranchInput,
  PushBranchOutcome,
} from "./delivery-broker.js";
import { commitObjectSha, gitBlobSha, isGitObjectId, toIsoDate } from "./git-objects.js";
import type { GitTreeEntry } from "./git-objects.js";
import type { CandidateCommit, RepositoryRef } from "./types.js";
import { applyFileChange, changeMode, parseUnifiedDiff, PatchFormatError } from "./unified-diff.js";
import type { DiffFileChange } from "./unified-diff.js";

/**
 * GitHub delivery provider (DAT-260, ADR-0007 "Approval and delivery").
 *
 * The real provider behind the broker's write seam. It can do exactly four
 * things, and the transport exposes no other GitHub endpoint:
 *
 * - read a branch ref (evidence);
 * - read pull requests for a branch (duplicate detection and reconciliation);
 * - push the *approved* commit to the issue's `autofixer/*` branch;
 * - open the corresponding pull request against the repository base branch.
 *
 * There is deliberately no merge, review, check-waiver, tag, release, secret,
 * or workflow operation. A merge or a protected-branch write is not "blocked
 * by a check here"; it is absent from the capability surface entirely.
 *
 * Pushing the approved commit, not an equivalent one:
 *
 * The sandbox freezes a candidate as a deterministic local commit (pinned
 * base, approved tree, run-bound message, captive identity). This adapter
 * rebuilds that exact commit object, checks its SHA-1 equals the approved
 * `head_sha` **before any network call**, then asks GitHub to create the same
 * tree and commit and checks the returned ids. A provider-side tree that does
 * not hash to the approved `tree_sha` stops the delivery before any branch ref
 * moves. Reconstructing the tree from the retained unified diff is what makes
 * the check meaningful: the diff is the bytes the human approved.
 *
 * Every outcome the broker records is derived from provider evidence:
 *
 * - `failed` — a definite refusal/no side effect (forbidden branch, base
 *   advanced, drift, permission denied, unreconstructable patch, id mismatch);
 * - `ambiguous` — a ref write whose result cannot be read back (timeout/5xx),
 *   which the broker records as `unknown` and only `reconcile` resolves;
 * - thrown {@link DeliveryProviderError} — a read failed, so no write occurred
 *   and the operation must be reconciled before another attempt.
 */

export interface GitHubDeliveryBinding {
  /** Canonical id, e.g. `github:FoMo-Exp/AutoFixer`. */
  canonical_repository_id: string;
  /** Reference into the DAT-203 credential boundary — never a secret. */
  credential_ref: string;
}

export interface GitHubDeliveryProviderOptions {
  credentials: ServiceCredentialStore;
  /**
   * Resolve the active delivery integration for one repository. `null` means
   * the repository has no delivery integration and every operation is refused
   * (fail closed); the adapter never falls back to another repository's
   * credential.
   */
  resolve: (repository: RepositoryRef) => GitHubDeliveryBinding | null;
  /**
   * Provider API base. Defaults to `https://api.github.com`; a GitHub
   * Enterprise host serves `<origin>/api/v3`. Tests point this at an exact
   * fake provider.
   */
  api_base_url?: string;
  http?: ProviderHttpClient;
  /** Per-request deadline. A timed-out write is an ambiguous outcome. */
  request_timeout_ms?: number;
  per_page?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DELIVERY_BRANCH_PREFIX = "autofixer/";
const BRANCH_MAX = 200;

/** Internal classification of a provider call failure. */
class GitHubCallError extends Error {
  readonly kind: "permission" | "unavailable" | "timeout" | "rejected";
  readonly status: number | null;

  constructor(kind: GitHubCallError["kind"], message: string, status: number | null = null) {
    super(message);
    this.name = "GitHubCallError";
    this.kind = kind;
    this.status = status;
  }
}

interface GitHubResponse {
  status: number;
  /** The parsed body when it is a JSON object. */
  json: Record<string, unknown> | null;
  /** The parsed body whatever its shape (the pull list is an array). */
  body: unknown;
}

interface BoundRepository {
  coords: CanonicalRepositoryId;
  credential_ref: string;
  repo_path: string;
}

interface GitHubRefEvidence {
  sha: string;
}

interface GitHubCommitEvidence {
  sha: string;
  tree_sha: string;
  parents: string[];
}

interface GitHubTreeEvidence {
  sha: string;
  entries: Map<string, GitTreeEntry>;
  truncated: boolean;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_repo: string | null;
}

type PushFailure = { status: "failed"; error_code: string };

function failed(error_code: string): PushFailure {
  return { status: "failed", error_code };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordField(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Ref-name rules beyond the autofixer namespace (git-check-ref-format subset). */
function branchViolation(repository: RepositoryRef, branch: string): string | null {
  if (branch === repository.base_ref) {
    return "delivery never writes the repository base branch";
  }
  if (branch === "main" || branch === "master") {
    return "delivery never writes a protected mainline branch";
  }
  if (
    !branch.startsWith(DELIVERY_BRANCH_PREFIX) ||
    branch.length <= DELIVERY_BRANCH_PREFIX.length
  ) {
    return "delivery branch must use the autofixer namespace";
  }
  if (branch.length > BRANCH_MAX) {
    return "delivery branch is too long";
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return "delivery branch contains characters a ref cannot carry";
  }
  if (
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("@{")
  ) {
    return "delivery branch is not a valid ref name";
  }
  for (const segment of branch.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.startsWith(".")) {
      return "delivery branch has an invalid path segment";
    }
  }
  return null;
}

/** Parse the canonical repository id and confirm the URL names the same repo. */
function bindRepository(
  repository: RepositoryRef,
  binding: GitHubDeliveryBinding,
): BoundRepository | null {
  let coords: CanonicalRepositoryId;
  try {
    coords = parseCanonicalRepositoryId(binding.canonical_repository_id);
  } catch {
    return null;
  }
  if (coords.provider !== "github") {
    return null;
  }
  if (repository.repository_id !== coords.canonical) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(repository.url);
  } catch {
    return null;
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
    return null;
  }
  const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  if (path.toLowerCase() !== coords.path.toLowerCase()) {
    return null;
  }
  return {
    coords,
    credential_ref: binding.credential_ref,
    repo_path: githubRepositoryPath(coords),
  };
}

function normalizeApiBase(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return "https://api.github.com";
  }
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("delivery provider API base must be a clean HTTP(S) URL");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function parseCommit(commit: CandidateCommit): CandidateCommit | null {
  if (
    typeof commit !== "object" ||
    commit === null ||
    typeof commit.message !== "string" ||
    commit.message.trim() === "" ||
    typeof commit.author !== "object" ||
    commit.author === null ||
    typeof commit.committer !== "object" ||
    commit.committer === null
  ) {
    return null;
  }
  for (const person of [commit.author, commit.committer]) {
    if (
      typeof person.name !== "string" ||
      typeof person.email !== "string" ||
      typeof person.date !== "string" ||
      person.name.trim() === "" ||
      person.email.trim() === "" ||
      person.date.trim() === ""
    ) {
      return null;
    }
  }
  return commit;
}

function patchFailure(error: unknown): PushFailure {
  if (error instanceof PatchFormatError) {
    switch (error.code) {
      case "binary_patch":
        return failed("PROVIDER_BINARY_PATCH");
      case "submodule_patch":
        return failed("PROVIDER_SUBMODULE_PATCH");
      case "context_mismatch":
        return failed("PROVIDER_PATCH_MISMATCH");
      default:
        return failed("PROVIDER_PATCH_INVALID");
    }
  }
  return failed("PROVIDER_PATCH_INVALID");
}

export function createGitHubDeliveryProvider(
  options: GitHubDeliveryProviderOptions,
): DeliveryProvider {
  const apiBase = normalizeApiBase(options.api_base_url);
  const transport = options.http ?? createFetchHttpClient();
  const timeoutMs = options.request_timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("delivery provider request timeout must be a positive integer");
  }
  const perPage = Math.min(Math.max(options.per_page ?? 100, 1), 100);

  const capabilities: DeliveryProviderCapabilities = {
    push: true,
    pull_request: true,
    // GitHub's branch-protection governance is the reviewed mapping; the
    // adapter never merges or writes the protected branch itself.
    repository_governance: "github_branch_protection",
  };

  function bindingFor(repository: RepositoryRef): BoundRepository | null {
    const binding = options.resolve(repository);
    if (binding === null) {
      return null;
    }
    return bindRepository(repository, binding);
  }

  function secretFor<T>(bound: BoundRepository, fn: (secret: string) => Promise<T>): Promise<T> {
    let secret: string;
    try {
      secret = withServiceCredential(options.credentials, bound.credential_ref, (value) => value);
    } catch {
      // A missing credential is a permission fact, not a transport accident,
      // and no provider request is made.
      throw new GitHubCallError("permission", "the delivery credential is not available");
    }
    return fn(secret);
  }

  async function request(
    secret: string,
    bound: BoundRepository,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<GitHubResponse> {
    const url = `${apiBase}/repos/${bound.repo_path}${path}`;
    let response;
    try {
      response = await withDeadline(
        transport({
          url,
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${secret}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof GitHubCallError) {
        throw error;
      }
      throw new GitHubCallError("unavailable", `provider request to ${path} failed`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitHubCallError("permission", `provider denied ${path}`, response.status);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GitHubCallError(
        "unavailable",
        `provider returned ${String(response.status)} for ${path}`,
        response.status,
      );
    }
    let parsedBody: unknown = null;
    if (response.body.trim() !== "") {
      try {
        parsedBody = JSON.parse(response.body) as unknown;
      } catch {
        throw new GitHubCallError("unavailable", `provider returned unreadable JSON for ${path}`);
      }
    }
    return { status: response.status, json: recordField(parsedBody), body: parsedBody };
  }

  async function readRef(
    secret: string,
    bound: BoundRepository,
    branch: string,
  ): Promise<GitHubRefEvidence | null> {
    const response = await request(secret, bound, "GET", `/git/ref/heads/${branch}`);
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200 || response.json === null) {
      throw new GitHubCallError("unavailable", `provider ref read for ${branch} was not usable`);
    }
    const object = recordField(response.json["object"]);
    const sha = stringField(object?.["sha"]);
    const type = stringField(object?.["type"]);
    if (sha === null || !isGitObjectId(sha) || type !== "commit") {
      throw new GitHubCallError("unavailable", `provider ref ${branch} is not a commit ref`);
    }
    return { sha };
  }

  async function readCommit(
    secret: string,
    bound: BoundRepository,
    sha: string,
  ): Promise<GitHubCommitEvidence | null> {
    const response = await request(secret, bound, "GET", `/git/commits/${sha}`);
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200 || response.json === null) {
      throw new GitHubCallError("unavailable", `provider commit read for ${sha} was not usable`);
    }
    const tree = recordField(response.json["tree"]);
    const treeSha = stringField(tree?.["sha"]);
    const parentsRaw = response.json["parents"];
    const parents: string[] = [];
    if (Array.isArray(parentsRaw)) {
      for (const parent of parentsRaw) {
        const parentSha = stringField(recordField(parent)?.["sha"]);
        if (parentSha === null || !isGitObjectId(parentSha)) {
          throw new GitHubCallError(
            "unavailable",
            `provider commit ${sha} has an unreadable parent`,
          );
        }
        parents.push(parentSha);
      }
    }
    const returned = stringField(response.json["sha"]) ?? sha;
    if (returned !== sha || treeSha === null || !isGitObjectId(treeSha)) {
      throw new GitHubCallError(
        "unavailable",
        `provider commit ${sha} is not the requested object`,
      );
    }
    return { sha, tree_sha: treeSha, parents };
  }

  async function readTree(
    secret: string,
    bound: BoundRepository,
    sha: string,
  ): Promise<GitHubTreeEvidence> {
    const response = await request(secret, bound, "GET", `/git/trees/${sha}?recursive=1`);
    if (response.status !== 200 || response.json === null) {
      throw new GitHubCallError("unavailable", `provider tree read for ${sha} was not usable`);
    }
    const returned = stringField(response.json["sha"]);
    if (returned !== sha) {
      throw new GitHubCallError("unavailable", `provider tree read returned another tree`);
    }
    const truncated = response.json["truncated"] === true;
    const entries = new Map<string, GitTreeEntry>();
    const rawEntries = response.json["tree"];
    if (Array.isArray(rawEntries)) {
      for (const raw of rawEntries) {
        const entry = recordField(raw);
        const path = stringField(entry?.["path"]);
        const mode = stringField(entry?.["mode"]);
        const type = stringField(entry?.["type"]);
        const entrySha = stringField(entry?.["sha"]);
        if (path === null || mode === null || type === null || entrySha === null) {
          throw new GitHubCallError("unavailable", `provider tree ${sha} has an unreadable entry`);
        }
        if (type !== "blob" && type !== "tree" && type !== "commit") {
          throw new GitHubCallError(
            "unavailable",
            `provider tree ${sha} has an unknown entry type`,
          );
        }
        entries.set(path, { path, mode, type, sha: entrySha });
      }
    }
    return { sha, entries, truncated };
  }

  async function readBlob(secret: string, bound: BoundRepository, sha: string): Promise<Buffer> {
    const response = await request(secret, bound, "GET", `/git/blobs/${sha}`);
    if (response.status !== 200 || response.json === null) {
      throw new GitHubCallError("unavailable", `provider blob read for ${sha} was not usable`);
    }
    const encoding = stringField(response.json["encoding"]);
    const content = stringField(response.json["content"]);
    if (content === null || (encoding !== "base64" && encoding !== "utf-8")) {
      throw new GitHubCallError("unavailable", `provider blob ${sha} is not decodable`);
    }
    const bytes = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
    if (gitBlobSha(bytes) !== sha) {
      throw new GitHubCallError("unavailable", `provider blob ${sha} does not match its content`);
    }
    return bytes;
  }

  function pullRequestFrom(raw: unknown, repoName: string): GitHubPullRequest | null {
    const record = recordField(raw);
    if (record === null) {
      return null;
    }
    const number = record["number"];
    const htmlUrl = stringField(record["html_url"]);
    const state = stringField(record["state"]);
    const head = recordField(record["head"]);
    const base = recordField(record["base"]);
    const headRef = stringField(head?.["ref"]);
    const headSha = stringField(head?.["sha"]);
    const baseRef = stringField(base?.["ref"]);
    const baseRepo = stringField(recordField(base?.["repo"])?.["full_name"]);
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0 ||
      htmlUrl === null ||
      (state !== "open" && state !== "closed") ||
      headRef === null ||
      headSha === null ||
      !isGitObjectId(headSha) ||
      baseRef === null
    ) {
      return null;
    }
    if (baseRepo !== null && baseRepo.toLowerCase() !== repoName.toLowerCase()) {
      return null;
    }
    return {
      number,
      html_url: htmlUrl,
      state,
      merged: record["merged_at"] !== null && record["merged_at"] !== undefined,
      head_ref: headRef,
      head_sha: headSha,
      base_ref: baseRef,
      base_repo: baseRepo,
    };
  }

  async function listPullRequests(
    secret: string,
    bound: BoundRepository,
    branch: string,
  ): Promise<GitHubPullRequest[]> {
    const query = `?head=${encodeURIComponent(`${bound.coords.owner}:${branch}`)}&state=all&per_page=${String(perPage)}`;
    const response = await request(secret, bound, "GET", `/pulls${query}`);
    if (response.status !== 200) {
      throw new GitHubCallError("unavailable", `provider pull request list was not usable`);
    }
    const rows = response.body;
    if (!Array.isArray(rows)) {
      throw new GitHubCallError("unavailable", `provider pull request list was not an array`);
    }
    const pullRequests: GitHubPullRequest[] = [];
    for (const row of rows) {
      const parsed = pullRequestFrom(row, bound.coords.path);
      if (parsed !== null) {
        pullRequests.push(parsed);
      }
    }
    return pullRequests;
  }

  function evidenceOf(pr: GitHubPullRequest): ProviderPullRequestEvidence {
    return {
      pr_id: String(pr.number),
      pr_url: pr.html_url,
      branch: pr.head_ref,
      head_sha: pr.head_sha,
      base_ref: pr.base_ref,
      state: pr.merged ? "merged" : pr.state,
    };
  }

  function requireBinding(repository: RepositoryRef): BoundRepository {
    const bound = bindingFor(repository);
    if (bound === null) {
      throw new DeliveryProviderError(
        "no reviewed delivery integration is bound to this repository",
      );
    }
    return bound;
  }

  function callFailure(error: unknown, writePhase: "read" | "ambiguous"): never {
    throw error instanceof GitHubCallError &&
      error.kind !== "unavailable" &&
      error.kind !== "timeout"
      ? new DeliveryProviderError(error.message)
      : new DeliveryProviderError(
          writePhase === "ambiguous"
            ? "the provider write outcome is unknown"
            : "provider evidence is temporarily unavailable",
        );
  }

  async function pushBranch(input: PushBranchInput): Promise<PushBranchOutcome> {
    const bound = bindingFor(input.repository);
    if (bound === null) {
      return failed("PROVIDER_NOT_CONFIGURED");
    }
    const violation = branchViolation(input.repository, input.branch);
    if (violation !== null) {
      return failed("PROVIDER_BRANCH_FORBIDDEN");
    }
    if (
      !isGitObjectId(input.base_sha) ||
      !isGitObjectId(input.head_sha) ||
      !isGitObjectId(input.tree_sha)
    ) {
      return failed("PROVIDER_IDENTITY_INVALID");
    }
    const commit = parseCommit(input.commit);
    if (commit === null) {
      return failed("PROVIDER_COMMIT_IDENTITY_INVALID");
    }
    let expectedHead: string;
    try {
      expectedHead = commitObjectSha({
        tree_sha: input.tree_sha,
        parent_shas: [input.base_sha],
        identity: commit,
      });
    } catch {
      return failed("PROVIDER_COMMIT_IDENTITY_INVALID");
    }
    // The approved commit must be reproducible from the approved identity
    // before a single provider call is made. A mismatch means the recorded
    // identity and the approved head describe different objects.
    if (expectedHead !== input.head_sha) {
      return failed("PROVIDER_COMMIT_IDENTITY_MISMATCH");
    }
    let changes: DiffFileChange[];
    try {
      changes = parseUnifiedDiff(input.diff_content);
    } catch (error) {
      return patchFailure(error);
    }
    if (changes.length === 0) {
      return failed("PROVIDER_PATCH_EMPTY");
    }

    try {
      return await secretFor(bound, async (secret) => {
        // -------------------------------------------------------- read phase
        let baseCommit: GitHubCommitEvidence | null;
        let baseRef: GitHubRefEvidence | null;
        let existing: GitHubRefEvidence | null;
        let baseTree: GitHubTreeEvidence;
        try {
          baseCommit = await readCommit(secret, bound, input.base_sha);
          if (baseCommit === null) {
            return failed("PROVIDER_BASE_UNKNOWN");
          }
          baseRef = await readRef(secret, bound, input.repository.base_ref);
          existing = await readRef(secret, bound, input.branch);
          if (existing !== null && existing.sha === input.head_sha) {
            // A previous attempt (or a concurrent one) already published this
            // exact commit. Verify it still names the approved tree and base.
            const pushed = await readCommit(secret, bound, input.head_sha);
            if (
              pushed === null ||
              pushed.tree_sha !== input.tree_sha ||
              pushed.parents.length !== 1 ||
              pushed.parents[0] !== input.base_sha
            ) {
              return failed("PROVIDER_HEAD_UNVERIFIED");
            }
            return { status: "pushed", head_sha: input.head_sha };
          }
          baseTree = await readTree(secret, bound, baseCommit.tree_sha);
        } catch (error) {
          // A rejected credential is a definite refusal: no write occurred.
          if (error instanceof GitHubCallError && error.kind === "permission") {
            return failed("PROVIDER_PERMISSION_DENIED");
          }
          callFailure(error, "read");
        }
        // The base branch must still hold the approved base. A base that moved
        // under the approval invalidates it (ADR-0007); never deliver a tree
        // whose evidence describes an older revision.
        if (baseRef === null || baseRef.sha !== input.base_sha) {
          return failed("PROVIDER_BASE_ADVANCED");
        }
        // The issue branch may be absent or still at the pinned base. Anything
        // else is drift from another writer; this adapter never force-updates.
        if (existing !== null && existing.sha !== input.base_sha) {
          return failed("PROVIDER_BRANCH_DRIFT");
        }
        if (baseTree.truncated) {
          return failed("PROVIDER_TREE_TRUNCATED");
        }

        // -------------------------------------------------- rebuild the tree
        interface TreeWrite {
          path: string;
          mode: string;
          sha: string | null;
        }
        const treeWrites: TreeWrite[] = [];
        const blobs: { path: string; content: Buffer; sha: string }[] = [];
        try {
          for (const change of changes) {
            const baseEntry = baseTree.entries.get(change.path);
            if (change.kind === "add") {
              if (baseEntry !== undefined) {
                return failed("PROVIDER_PATCH_MISMATCH");
              }
            } else if (baseEntry === undefined || baseEntry.type !== "blob") {
              // The retained diff does not apply to this exact base tree.
              return failed("PROVIDER_PATCH_MISMATCH");
            }
            const baseContent =
              baseEntry === undefined || change.kind === "delete"
                ? null
                : (await readBlob(secret, bound, baseEntry.sha)).toString("utf8");
            const content = applyFileChange(baseContent, change);
            const mode = changeMode(change, baseEntry?.mode ?? null);
            if (content === null) {
              treeWrites.push({ path: change.path, mode: baseEntry?.mode ?? mode, sha: null });
              continue;
            }
            const blobSha = gitBlobSha(content);
            if (baseEntry === undefined || baseEntry.sha !== blobSha) {
              blobs.push({
                path: change.path,
                content: Buffer.from(content, "utf8"),
                sha: blobSha,
              });
            }
            treeWrites.push({ path: change.path, mode, sha: blobSha });
          }
        } catch (error) {
          if (error instanceof GitHubCallError && error.kind === "permission") {
            return failed("PROVIDER_PERMISSION_DENIED");
          }
          if (error instanceof PatchFormatError) {
            return patchFailure(error);
          }
          callFailure(error, "read");
        }

        // --------------------------------------------------------- write phase
        for (const blob of blobs) {
          try {
            const response = await request(secret, bound, "POST", "/git/blobs", {
              content: blob.content.toString("base64"),
              encoding: "base64",
            });
            const created = stringField(response.json?.["sha"]);
            if (response.status !== 201 || created !== blob.sha) {
              return failed("PROVIDER_BLOB_MISMATCH");
            }
          } catch (error) {
            if (error instanceof GitHubCallError && error.kind === "permission") {
              return failed("PROVIDER_PERMISSION_DENIED");
            }
            // Unreferenced blobs are not a repository side effect; the ref was
            // never touched, so this is a definite failure.
            return failed("PROVIDER_BLOB_WRITE_FAILED");
          }
        }

        try {
          const response = await request(secret, bound, "POST", "/git/trees", {
            base_tree: baseCommit?.tree_sha,
            tree: treeWrites.map((entry) => ({
              path: entry.path,
              mode: entry.mode,
              type: "blob",
              sha: entry.sha,
            })),
          });
          const created = stringField(response.json?.["sha"]);
          if (response.status !== 201) {
            return failed("PROVIDER_TREE_WRITE_FAILED");
          }
          if (created !== input.tree_sha) {
            // The provider built a different tree from the approved diff. No ref
            // has moved; refuse the delivery instead of publishing unapproved
            // content.
            return failed("PROVIDER_TREE_MISMATCH");
          }
        } catch (error) {
          if (error instanceof GitHubCallError && error.kind === "permission") {
            return failed("PROVIDER_PERMISSION_DENIED");
          }
          return failed("PROVIDER_TREE_WRITE_FAILED");
        }

        try {
          const response = await request(secret, bound, "POST", "/git/commits", {
            message: commit.message,
            tree: input.tree_sha,
            parents: [input.base_sha],
            author: {
              name: commit.author.name,
              email: commit.author.email,
              date: toIsoDate(commit.author.date),
            },
            committer: {
              name: commit.committer.name,
              email: commit.committer.email,
              date: toIsoDate(commit.committer.date),
            },
          });
          const created = stringField(response.json?.["sha"]);
          if (response.status !== 201) {
            return failed("PROVIDER_COMMIT_WRITE_FAILED");
          }
          if (created !== input.head_sha) {
            // The provider normalized the commit bytes. Publishing it would put a
            // commit on the branch that the approval never named.
            return failed("PROVIDER_COMMIT_MISMATCH");
          }
        } catch (error) {
          if (error instanceof GitHubCallError && error.kind === "permission") {
            return failed("PROVIDER_PERMISSION_DENIED");
          }
          return failed("PROVIDER_COMMIT_WRITE_FAILED");
        }

        // Move the branch ref. This is the one write that changes what the
        // repository exposes, so an unreadable result is `ambiguous` (the broker
        // records `unknown` and only reconcile may resolve it).
        try {
          const response =
            existing === null
              ? await request(secret, bound, "POST", "/git/refs", {
                  ref: `refs/heads/${input.branch}`,
                  sha: input.head_sha,
                })
              : await request(secret, bound, "PATCH", `/git/refs/heads/${input.branch}`, {
                  sha: input.head_sha,
                  force: false,
                });
          if (response.status !== 201 && response.status !== 200) {
            // A create rejected because the ref appeared concurrently, or an
            // update rejected as a non-fast-forward, is decided by evidence.
            const observed = await readRef(secret, bound, input.branch);
            if (observed !== null && observed.sha === input.head_sha) {
              return { status: "pushed", head_sha: input.head_sha };
            }
            return failed("PROVIDER_BRANCH_CONFLICT");
          }
        } catch (error) {
          if (error instanceof GitHubCallError && error.kind === "permission") {
            const observed = await readRef(secret, bound, input.branch).catch(() => null);
            return observed !== null && observed.sha === input.head_sha
              ? { status: "pushed", head_sha: input.head_sha }
              : failed("PROVIDER_PERMISSION_DENIED");
          }
          return { status: "ambiguous", error_code: "PROVIDER_PUSH_UNKNOWN" };
        }

        // Read the ref back: the push is only confirmed by provider evidence.
        try {
          const observed = await readRef(secret, bound, input.branch);
          if (observed === null || observed.sha !== input.head_sha) {
            return { status: "ambiguous", error_code: "PROVIDER_HEAD_UNVERIFIED" };
          }
        } catch {
          return { status: "ambiguous", error_code: "PROVIDER_PUSH_UNKNOWN" };
        }
        return { status: "pushed", head_sha: input.head_sha };
      });
    } catch (error) {
      // A credential that cannot be materialized is a permission fact: no
      // provider request was made, so this is a definite failure, not unknown.
      if (error instanceof GitHubCallError) {
        return failed("PROVIDER_PERMISSION_DENIED");
      }
      throw error;
    }
  }

  async function findPullRequest(
    repository: RepositoryRef,
    branch: string,
    headSha: string,
    targetBranch: string,
  ): Promise<ProviderPullRequestEvidence | null> {
    const bound = requireBinding(repository);
    const violation = branchViolation(repository, branch);
    if (violation !== null) {
      throw new DeliveryProviderError(violation);
    }
    // Reuse evidence must bind the whole identity of the delivery. A PR for
    // the same head against another branch is a different delivery target and
    // must never be accepted as this one.
    if (targetBranch !== repository.base_ref) {
      throw new DeliveryProviderError(
        "a delivery pull request may only target the repository base branch",
      );
    }
    try {
      return await secretFor(bound, async (secret) => {
        let pullRequests: GitHubPullRequest[];
        try {
          pullRequests = await listPullRequests(secret, bound, branch);
        } catch (error) {
          callFailure(error, "read");
        }
        const matching = pullRequests.filter(
          (pr) => pr.head_ref === branch && pr.head_sha === headSha && pr.base_ref === targetBranch,
        );
        // An open PR is the one a retry must reuse; a closed one is evidence but
        // never a reason to open a duplicate for the same revision.
        const open = matching.find((pr) => pr.state === "open" && !pr.merged);
        const chosen = open ?? matching[0];
        return chosen === undefined ? null : evidenceOf(chosen);
      });
    } catch (error) {
      callFailure(error, "read");
    }
  }

  async function openPullRequest(
    input: OpenPullRequestInput,
  ): Promise<ProviderPullRequestEvidence> {
    const bound = requireBinding(input.repository);
    const violation = branchViolation(input.repository, input.branch);
    if (violation !== null) {
      throw new DeliveryProviderError(violation);
    }
    if (input.target_branch !== input.repository.base_ref) {
      throw new DeliveryProviderError(
        "a delivery pull request may only target the repository base branch",
      );
    }
    if (input.target_branch === input.branch) {
      throw new DeliveryProviderError("a delivery pull request cannot target its own branch");
    }
    try {
      return await secretFor(bound, async (secret) => {
        // Never open a second PR for the same branch revision: a crashed earlier
        // attempt may have created it while its state write was lost.
        let existing: GitHubPullRequest[];
        try {
          existing = await listPullRequests(secret, bound, input.branch);
        } catch (error) {
          callFailure(error, "read");
        }
        const reusable = existing.find(
          (pr) =>
            pr.state === "open" &&
            !pr.merged &&
            pr.head_ref === input.branch &&
            pr.head_sha === input.head_sha &&
            pr.base_ref === input.target_branch,
        );
        if (reusable !== undefined) {
          return evidenceOf(reusable);
        }

        let response: GitHubResponse;
        try {
          response = await request(secret, bound, "POST", "/pulls", {
            title: input.title,
            head: input.branch,
            base: input.target_branch,
            body: input.body,
          });
        } catch {
          // The PR may exist despite the failed response; the broker records
          // `partial` and reconcile decides from evidence.
          throw new DeliveryProviderError("pull request creation outcome is unknown");
        }
        if (response.status === 422) {
          const after = await listPullRequests(secret, bound, input.branch).catch(() => []);
          const concurrent = after.find(
            (pr) =>
              pr.state === "open" &&
              !pr.merged &&
              pr.head_ref === input.branch &&
              pr.head_sha === input.head_sha &&
              pr.base_ref === input.target_branch,
          );
          if (concurrent !== undefined) {
            return evidenceOf(concurrent);
          }
          throw new DeliveryProviderError("the provider rejected the pull request");
        }
        if (response.status !== 201 || response.json === null) {
          throw new DeliveryProviderError("the provider did not create the pull request");
        }
        const created = pullRequestFrom(response.json, bound.coords.path);
        if (
          created === null ||
          created.head_ref !== input.branch ||
          created.head_sha !== input.head_sha ||
          created.base_ref !== input.target_branch ||
          created.state !== "open"
        ) {
          throw new DeliveryProviderError("the created pull request does not match the delivery");
        }
        return evidenceOf(created);
      });
    } catch (error) {
      callFailure(error, "ambiguous");
    }
  }

  return {
    provider: "github",
    capabilities,
    async observeBranch(
      repository: RepositoryRef,
      branch: string,
    ): Promise<ProviderBranchEvidence> {
      const bound = requireBinding(repository);
      const violation = branchViolation(repository, branch);
      if (violation !== null) {
        throw new DeliveryProviderError(violation);
      }
      try {
        return await secretFor(bound, async (secret) => {
          try {
            const ref = await readRef(secret, bound, branch);
            return { head_sha: ref?.sha ?? null };
          } catch (error) {
            callFailure(error, "read");
          }
        });
      } catch (error) {
        callFailure(error, "read");
      }
    },
    pushBranch,
    findPullRequest,
    openPullRequest,
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new GitHubCallError("timeout", "provider request timed out"));
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
