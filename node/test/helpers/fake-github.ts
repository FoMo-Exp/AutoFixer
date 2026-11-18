/**
 * An exact fake GitHub service for the delivery adapter (DAT-260).
 *
 * Unlike a stub that returns scripted ids, this fake *computes* git objects:
 * blobs, trees, and commits are hashed with the same rules git uses, and the
 * ref only moves when a real commit object exists. That makes the adapter's
 * checks meaningful — if the pushed tree or commit differs from the approved
 * one by a single byte, the fake produces a different SHA and the adapter
 * refuses the delivery.
 *
 * The request surface is exact: an unhandled target answers 599 so a test
 * fails loudly instead of silently exercising the wrong endpoint.
 */

import { gitBlobSha, gitTreeSha } from "../../src/collab/git-objects.js";
import type { GitTreeEntry } from "../../src/collab/git-objects.js";
import { commitObjectSha } from "../../src/collab/git-objects.js";
import type { CandidateCommit } from "../../src/collab/types.js";
import { startFakeProvider } from "./fake-provider.js";
import type { FakeProvider, FakeProviderResponse, RecordedRequest } from "./fake-provider.js";

export interface FakeGitHubFault {
  method: string;
  /** Substring match on the request target. */
  path: string;
  /** Answer with this status instead of performing the operation. */
  status?: number;
  /** Delay the answer (after any state change) by this long. */
  delayMs?: number;
}

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  /** Branch -> commit SHA. */
  refs: Record<string, string>;
  token: string;
  faults?: FakeGitHubFault[];
  /**
   * Deliberate provider misbehaviour: return a different object id (or PR
   * field) than the request describes, to prove the adapter checks evidence
   * instead of trusting its own request.
   */
  override?: {
    tree_sha?: string;
    commit_sha?: string;
    pull_head_sha?: string;
    pull_base_ref?: string;
  };
  /**
   * Read-only governance facts this repository serves (DAT-261). The rows are
   * shaped like GitHub's REST/GraphQL answers so the adapter parses exactly
   * what production returns.
   */
  governance?: {
    check_runs?: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      head_sha: string;
      started_at?: string | null;
      completed_at?: string | null;
    }>;
    /** Echoed verbatim, so a test can also serve a malformed review row. */
    reviews?: unknown[];
    review_threads?: Array<{ isResolved: boolean }>;
    thread_page_has_next?: boolean;
  };
}

interface FakeCommit {
  sha: string;
  tree_sha: string;
  parents: string[];
}

interface FakePullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  head_ref: string;
  head_sha: string;
  base_ref: string;
}

interface FakeGitHubState {
  refs: Map<string, string>;
  commits: Map<string, FakeCommit>;
  trees: Map<string, GitTreeEntry[]>;
  blobs: Map<string, Buffer>;
  pullRequests: FakePullRequest[];
  writes(): string[];
  addTree(files: Record<string, string>): string;
  addCommit(treeSha: string, parents: string[], identity: CandidateCommit): string;
  addPullRequest(input: {
    head_ref: string;
    head_sha: string;
    base_ref: string;
    state?: "open" | "closed";
    merged?: boolean;
  }): FakePullRequest;
}

export interface FakeGitHub {
  base_url: string;
  requests: RecordedRequest[];
  urls(): string[];
  refs: Map<string, string>;
  commits: Map<string, FakeCommit>;
  trees: Map<string, GitTreeEntry[]>;
  blobs: Map<string, Buffer>;
  pullRequests: FakePullRequest[];
  /** Every mutating request that reached the service, in order. */
  writes(): string[];
  addTree(files: Record<string, string>): string;
  addCommit(treeSha: string, parents: string[], identity: CandidateCommit): string;
  addPullRequest(input: {
    head_ref: string;
    head_sha: string;
    base_ref: string;
    state?: "open" | "closed";
    merged?: boolean;
  }): FakePullRequest;
  close(): Promise<void>;
}

export function filesToTree(files: Record<string, string>): {
  entries: GitTreeEntry[];
  sha: string;
} {
  const entries: GitTreeEntry[] = Object.entries(files).map(([path, content]) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: gitBlobSha(content),
  }));
  return { entries, sha: gitTreeSha(entries) };
}

function assertToken(request: RecordedRequest, token: string): FakeProviderResponse | null {
  const authorization = request.headers["authorization"];
  if (authorization !== `Bearer ${token}`) {
    return { status: 401, body: { message: "Bad credentials" } };
  }
  return null;
}

function parseJson(request: RecordedRequest): Record<string, unknown> {
  if (request.body === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(request.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeGitHub(options: FakeGitHubOptions): Promise<FakeGitHub> {
  const refs = new Map<string, string>(Object.entries(options.refs));
  const commits = new Map<string, FakeCommit>();
  const trees = new Map<string, GitTreeEntry[]>();
  const blobs = new Map<string, Buffer>();
  const pullRequests: FakePullRequest[] = [];
  const faults = [...(options.faults ?? [])];
  const prefix = `/repos/${options.owner}/${options.repo}`;
  const writesList: string[] = [];
  let nextPullRequest = 1;

  const service: FakeGitHubState = {
    refs,
    commits,
    trees,
    blobs,
    pullRequests,
    writes: () => writesList,
    addTree: (files) => {
      const tree = filesToTree(files);
      for (const content of Object.values(files)) {
        blobs.set(gitBlobSha(content), Buffer.from(content, "utf8"));
      }
      trees.set(tree.sha, tree.entries);
      return tree.sha;
    },
    addCommit: (treeSha, parents, identity) => {
      const sha = commitObjectSha({
        tree_sha: treeSha,
        parent_shas: parents,
        identity,
      });
      commits.set(sha, { sha, tree_sha: treeSha, parents });
      return sha;
    },
    addPullRequest: (input) => {
      const pr: FakePullRequest = {
        number: nextPullRequest,
        html_url: `https://github.com/${options.owner}/${options.repo}/pull/${String(nextPullRequest)}`,
        state: input.state ?? "open",
        merged_at: input.merged === true ? "2026-11-18T00:00:00Z" : null,
        head_ref: input.head_ref,
        head_sha: input.head_sha,
        base_ref: input.base_ref,
      };
      nextPullRequest += 1;
      pullRequests.push(pr);
      return pr;
    },
  };

  function prBody(pr: FakePullRequest): Record<string, unknown> {
    return {
      number: pr.number,
      html_url: pr.html_url,
      state: pr.state,
      merged_at: pr.merged_at,
      head: {
        ref: pr.head_ref,
        sha: pr.head_sha,
        repo: { full_name: `${options.owner}/${options.repo}` },
      },
      base: { ref: pr.base_ref, repo: { full_name: `${options.owner}/${options.repo}` } },
    };
  }

  function commitBody(commit: FakeCommit): Record<string, unknown> {
    return {
      sha: commit.sha,
      tree: { sha: commit.tree_sha },
      parents: commit.parents.map((sha) => ({ sha })),
    };
  }

  const provider: FakeProvider = await startFakeProvider((request) => {
    const unauthorized = assertToken(request, options.token);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const faultIndex = faults.findIndex(
      (fault) => fault.method === request.method && request.url.includes(fault.path),
    );
    const fault = faultIndex === -1 ? undefined : faults.splice(faultIndex, 1)[0];
    if (fault?.status !== undefined) {
      return { status: fault.status, body: { message: "injected fault" } };
    }
    return (async () => {
      const response = route(request);
      if (fault?.delayMs !== undefined) {
        await sleep(fault.delayMs);
      }
      return response;
    })();
  });

  function route(request: RecordedRequest): FakeProviderResponse {
    const url = request.url;
    const method = request.method;

    // ------------------------------------------------------------- branch refs
    const refMatch = new RegExp(`^${prefix}/git/ref/heads/(.+)$`).exec(url);
    if (method === "GET" && refMatch !== null) {
      const branch = decodeURIComponent(refMatch[1] as string);
      const sha = refs.get(branch);
      if (sha === undefined) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return {
        status: 200,
        body: {
          ref: `refs/heads/${branch}`,
          object: { type: "commit", sha },
        },
      };
    }

    const patchRefMatch = new RegExp(`^${prefix}/git/refs/heads/(.+)$`).exec(url);
    if (method === "PATCH" && patchRefMatch !== null) {
      writesList.push(`PATCH ${url}`);
      const branch = decodeURIComponent(patchRefMatch[1] as string);
      const body = parseJson(request);
      const sha = body["sha"];
      if (typeof sha !== "string" || !commits.has(sha)) {
        return { status: 422, body: { message: "Object does not exist" } };
      }
      if (body["force"] !== false) {
        // The adapter must never ask for a force update.
        return { status: 422, body: { message: "force updates are not used" } };
      }
      const current = refs.get(branch);
      // Fast-forward only: the current head must be an ancestor of the target.
      if (current !== undefined) {
        let cursor: FakeCommit | undefined = commits.get(sha);
        let ancestor = false;
        while (cursor !== undefined) {
          if (cursor.sha === current) {
            ancestor = true;
            break;
          }
          cursor = cursor.parents[0] === undefined ? undefined : commits.get(cursor.parents[0]);
        }
        if (!ancestor) {
          return { status: 422, body: { message: "Update is not a fast forward" } };
        }
      }
      refs.set(branch, sha);
      return {
        status: 200,
        body: { ref: `refs/heads/${branch}`, object: { type: "commit", sha } },
      };
    }

    if (method === "POST" && url === `${prefix}/git/refs`) {
      writesList.push(`POST ${url}`);
      const body = parseJson(request);
      const ref = body["ref"];
      const sha = body["sha"];
      if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || typeof sha !== "string") {
        return { status: 422, body: { message: "Reference update failed" } };
      }
      if (!commits.has(sha)) {
        return { status: 422, body: { message: "Object does not exist" } };
      }
      const branch = ref.slice("refs/heads/".length);
      if (refs.has(branch)) {
        return { status: 422, body: { message: "Reference already exists" } };
      }
      refs.set(branch, sha);
      return {
        status: 201,
        body: { ref, object: { type: "commit", sha } },
      };
    }

    // ---------------------------------------------------------------- commits
    const commitMatch = new RegExp(`^${prefix}/git/commits/([0-9a-f]{40})$`).exec(url);
    if (method === "GET" && commitMatch !== null) {
      const commit = commits.get(commitMatch[1] as string);
      if (commit === undefined) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return { status: 200, body: commitBody(commit) };
    }

    if (method === "POST" && url === `${prefix}/git/commits`) {
      writesList.push(`POST ${url}`);
      const body = parseJson(request);
      const tree = body["tree"];
      const parents = body["parents"];
      const message = body["message"];
      const author = body["author"];
      const committer = body["committer"];
      if (
        typeof tree !== "string" ||
        !trees.has(tree) ||
        !Array.isArray(parents) ||
        parents.some((parent) => typeof parent !== "string" || !commits.has(parent)) ||
        typeof message !== "string" ||
        typeof author !== "object" ||
        author === null ||
        typeof committer !== "object" ||
        committer === null
      ) {
        return { status: 422, body: { message: "Invalid commit" } };
      }
      const identity = {
        message,
        author: author as CandidateCommit["author"],
        committer: committer as CandidateCommit["committer"],
      };
      const sha = commitObjectSha({
        tree_sha: tree,
        parent_shas: parents as string[],
        identity,
      });
      commits.set(sha, { sha, tree_sha: tree, parents: parents as string[] });
      return { status: 201, body: { sha: options.override?.commit_sha ?? sha } };
    }

    // ------------------------------------------------------------------ trees
    const treeMatch = new RegExp(`^${prefix}/git/trees/([0-9a-f]{40})\\?recursive=1$`).exec(url);
    if (method === "GET" && treeMatch !== null) {
      const entries = trees.get(treeMatch[1] as string);
      if (entries === undefined) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return {
        status: 200,
        body: {
          sha: treeMatch[1],
          truncated: false,
          tree: entries.map((entry) => ({
            path: entry.path,
            mode: entry.mode === "40000" ? "040000" : entry.mode,
            type: entry.type,
            sha: entry.sha,
          })),
        },
      };
    }

    if (method === "POST" && url === `${prefix}/git/trees`) {
      writesList.push(`POST ${url}`);
      const body = parseJson(request);
      const baseTree = body["base_tree"];
      const rawEntries = body["tree"];
      if (typeof baseTree !== "string" || !trees.has(baseTree) || !Array.isArray(rawEntries)) {
        return { status: 422, body: { message: "Invalid tree" } };
      }
      const merged = new Map(
        (trees.get(baseTree) as GitTreeEntry[]).map((entry) => [entry.path, entry]),
      );
      for (const raw of rawEntries) {
        if (typeof raw !== "object" || raw === null) {
          return { status: 422, body: { message: "Invalid tree entry" } };
        }
        const entry = raw as Record<string, unknown>;
        const path = entry["path"];
        const mode = entry["mode"];
        const sha = entry["sha"];
        if (typeof path !== "string" || typeof mode !== "string") {
          return { status: 422, body: { message: "Invalid tree entry" } };
        }
        if (sha === null) {
          merged.delete(path);
          continue;
        }
        if (typeof sha !== "string" || !blobs.has(sha)) {
          return { status: 422, body: { message: "Invalid tree entry" } };
        }
        merged.set(path, { path, mode, type: "blob", sha });
      }
      const entries = [...merged.values()];
      const sha = gitTreeSha(entries);
      trees.set(sha, entries);
      return { status: 201, body: { sha: options.override?.tree_sha ?? sha } };
    }

    // ------------------------------------------------------------------ blobs
    const blobMatch = new RegExp(`^${prefix}/git/blobs/([0-9a-f]{40})$`).exec(url);
    if (method === "GET" && blobMatch !== null) {
      const blob = blobs.get(blobMatch[1] as string);
      if (blob === undefined) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return {
        status: 200,
        body: { sha: blobMatch[1], content: blob.toString("base64"), encoding: "base64" },
      };
    }

    if (method === "POST" && url === `${prefix}/git/blobs`) {
      writesList.push(`POST ${url}`);
      const body = parseJson(request);
      const content = body["content"];
      if (typeof content !== "string" || body["encoding"] !== "base64") {
        return { status: 422, body: { message: "Invalid blob" } };
      }
      const bytes = Buffer.from(content, "base64");
      const sha = gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return { status: 201, body: { sha } };
    }

    // ------------------------------------------------------------------ pulls
    if (method === "GET" && url.startsWith(`${prefix}/pulls?`)) {
      const query = new URL(`http://fake${url}`).searchParams;
      const head = query.get("head") ?? "";
      const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
      const state = query.get("state") ?? "open";
      const rows = pullRequests
        .filter((pr) => pr.head_ref === branch)
        .filter((pr) => state === "all" || pr.state === state)
        .map(prBody);
      return { status: 200, body: rows };
    }

    if (method === "POST" && url === `${prefix}/pulls`) {
      writesList.push(`POST ${url}`);
      const body = parseJson(request);
      const title = body["title"];
      const head = body["head"];
      const base = body["base"];
      if (typeof title !== "string" || typeof head !== "string" || typeof base !== "string") {
        return { status: 422, body: { message: "Invalid pull request" } };
      }
      const headSha = refs.get(head);
      if (headSha === undefined) {
        return { status: 422, body: { message: "Head branch does not exist" } };
      }
      // GitHub identifies a conflicting pull request by its head *and* base:
      // the same head may legitimately have open PRs against other branches.
      const existing = pullRequests.find(
        (pr) => pr.head_ref === head && pr.base_ref === base && pr.state === "open",
      );
      if (existing !== undefined) {
        return { status: 422, body: { message: "A pull request already exists" } };
      }
      const pr = service.addPullRequest({ head_ref: head, head_sha: headSha, base_ref: base });
      const bodyOut = prBody(pr);
      if (options.override?.pull_head_sha !== undefined) {
        (bodyOut["head"] as Record<string, unknown>)["sha"] = options.override.pull_head_sha;
      }
      if (options.override?.pull_base_ref !== undefined) {
        (bodyOut["base"] as Record<string, unknown>)["ref"] = options.override.pull_base_ref;
      }
      return { status: 201, body: bodyOut };
    }

    // ------------------------------------------------------- governance reads
    const pullByNumber = new RegExp(`^${prefix}/pulls/([0-9]+)$`).exec(url);
    if (method === "GET" && pullByNumber !== null) {
      const pr = pullRequests.find((row) => row.number === Number(pullByNumber[1]));
      if (pr === undefined) {
        return { status: 404, body: { message: "Not Found" } };
      }
      return { status: 200, body: prBody(pr) };
    }

    const checkRunsMatch = new RegExp(`^${prefix}/commits/([0-9a-f]{40})/check-runs\\?`).exec(url);
    if (method === "GET" && checkRunsMatch !== null) {
      const head = checkRunsMatch[1] as string;
      const rows = (options.governance?.check_runs ?? []).filter((row) => row.head_sha === head);
      return { status: 200, body: { total_count: rows.length, check_runs: rows } };
    }

    const reviewsMatch = new RegExp(`^${prefix}/pulls/([0-9]+)/reviews\\?`).exec(url);
    if (method === "GET" && reviewsMatch !== null) {
      return { status: 200, body: options.governance?.reviews ?? [] };
    }

    if (method === "POST" && url === "/graphql") {
      // The adapter sends a read-only reviewThreads query; anything about a
      // mutation has no route here at all.
      const body = parseJson(request);
      const query = typeof body["query"] === "string" ? body["query"] : "";
      if (!query.includes("reviewThreads")) {
        return { status: 400, body: { errors: [{ message: "unsupported query" }] } };
      }
      return {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: options.governance?.thread_page_has_next === true },
                  nodes: options.governance?.review_threads ?? [],
                },
              },
            },
          },
        },
      };
    }

    return { status: 599, body: { error: `unexpected request ${method} ${url}` } };
  }

  return {
    ...service,
    base_url: provider.base_url,
    requests: provider.requests,
    urls: provider.urls,
    close: provider.close,
  } as FakeGitHub;
}
