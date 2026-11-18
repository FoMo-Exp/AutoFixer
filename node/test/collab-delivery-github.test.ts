import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ApprovalService } from "../src/collab/approval-service.js";
import type { ApprovalDirectory, ApprovalMemberFact } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { DeliveryBroker } from "../src/collab/delivery-broker.js";
import { createGitHubDeliveryProvider } from "../src/collab/github-delivery.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { ApprovalRecord, CandidateRecord, IssueRecord } from "../src/collab/types.js";
import { autofixerBranchFor } from "../src/collab/types.js";
import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import {
  REPOSITORY,
  Clock,
  acquireLease,
  freezeCandidateInput,
  grantInput,
  leaseRef,
  op,
  openRun,
  planningIssue,
  stoppedPreparation,
} from "./helpers/collab.js";
import { filesToTree, startFakeGitHub } from "./helpers/fake-github.js";
import type { FakeGitHub, FakeGitHubFault } from "./helpers/fake-github.js";

/**
 * The broker driving the real GitHub adapter end to end (DAT-260).
 *
 * These tests replace the scripted provider of DAT-259 with the adapter and an
 * exact fake GitHub service, so the delivered branch is a genuine git object
 * graph: the approved head, its tree, and its parent are recomputed by the
 * service. Every acceptance outcome of the issue is exercised through the real
 * broker: a delivered PR, an audit-unavailable refusal, a revoked permission or
 * credential, an unreadable provider, a push-without-PR partial, and a lost PR
 * response that reconciles to delivered without a duplicate.
 */

const OWNER = "FoMo-Exp";
const REPO = "AutoFixer";
const TOKEN = "ghs_delivery_token";
const CREDENTIAL_REF = "service/delivery/github";
const ERIN = "usr_erin";

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

const CANDIDATE_TREE = filesToTree(CANDIDATE_FILES).sha;
const BASE_COMMIT_MESSAGE = "base\n";
const BASE_COMMIT = {
  message: BASE_COMMIT_MESSAGE,
  author: { name: "AutoFixer", email: "autofixer@localhost", date: "2026-11-01T00:00:00 +0000" },
  committer: {
    name: "AutoFixer",
    email: "autofixer@localhost",
    date: "2026-11-01T00:00:00 +0000",
  },
};
const BASE_TREE = filesToTree(BASE_FILES).sha;

function member(userId: string): ApprovalMemberFact {
  return {
    user_id: userId,
    display_name: userId.replace("usr_", ""),
    role: "maintainer",
    status: "active",
    repository_access: true,
    approval_authority: true,
  };
}

class FakeDirectory implements ApprovalDirectory {
  authorityVersion(): string {
    return "2026-11-18.1";
  }

  members(): ApprovalMemberFact[] {
    return [member(ERIN)];
  }

  member(_scope: unknown, _repositoryId: string, userId: string): ApprovalMemberFact | null {
    return userId === ERIN ? member(ERIN) : null;
  }
}

function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected denial ${code}`);
    },
    (error: unknown) => {
      expect((error as { code?: string }).code).toBe(code);
    },
  );
}

interface Fixture {
  root: string;
  clock: Clock;
  machine: CollabMachine;
  store: CandidateContentStore;
  broker: DeliveryBroker;
  brokerFor(provider: ReturnType<typeof createGitHubDeliveryProvider>): DeliveryBroker;
  fake: FakeGitHub;
  issue: IssueRecord;
  candidate: CandidateRecord;
  approval: ApprovalRecord;
  grantId: string;
  repository: typeof REPOSITORY;
}

interface SetupOptions {
  faults?: FakeGitHubFault[];
  credentialRevoked?: boolean;
  auditAvailable?: boolean;
  deliveryAuthorized?: boolean;
  requestTimeoutMs?: number;
}

const roots: string[] = [];
const fakes: FakeGitHub[] = [];

afterEach(async () => {
  while (fakes.length > 0) {
    await (fakes.pop() as FakeGitHub).close();
  }
  while (roots.length > 0) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-github-delivery-"));
  roots.push(root);

  // The provider-side repository: its base commit is a real object the adapter
  // can read, and its base branch points at it. A repository root commit has no
  // pinned parent; the fake's helper requires one (it hashes candidate
  // commits), so the base carries an opaque placeholder parent.
  const fake = await startFakeGitHub({
    owner: OWNER,
    repo: REPO,
    refs: {},
    token: TOKEN,
    ...(options.faults !== undefined ? { faults: options.faults } : {}),
  });
  fakes.push(fake);
  fake.addTree(BASE_FILES);
  const baseCommit = fake.addCommit(BASE_TREE, ["2".repeat(40)], BASE_COMMIT);
  fake.refs.set("main", baseCommit);

  const repository = { ...REPOSITORY, base_sha: baseCommit };
  const clock = new Clock();
  const store = new CandidateContentStore(path.join(root, "candidates"));
  const machine = new CollabMachine({ candidateStore: store, now: clock.now });
  const directory = new FakeDirectory();
  const approvalService = new ApprovalService(machine, directory);

  const issue = planningIssue(machine, { repository });
  const context = stoppedPreparation(machine, issue.issue_id, {
    repository,
    diff: DIFF,
    treeSha: CANDIDATE_TREE,
  });
  const candidate = machine.freezeCandidate(freezeCandidateInput(context));
  expect(candidate.head_sha).toBe(context.head_sha);

  for (const to of ["validating", "awaiting_change_approval"] as const) {
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to,
      reason: null,
    });
  }
  const approval = approvalService.request({
    operation_id: op(),
    actor: "orchestrator:approval",
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    target_branch: repository.base_ref,
    approver_user_id: ERIN,
  });
  approvalService.decide({
    operation_id: op(),
    actor_user: { id: ERIN, display_name: "erin" },
    issue_id: issue.issue_id,
    approval_id: approval.approval_id,
    decision: "approve",
    diff_digest: approval.binding.diff_digest,
  });

  const run = openRun(machine, issue.issue_id, { role: "delivery", repository });
  const lease = leaseRef(acquireLease(machine, run.run_id, "worker:delivery"));
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:delivery",
    run_id: run.run_id,
    lease,
    to: "approved",
    head_sha: candidate.head_sha,
  });
  const grant = machine.recordGrant({
    operation_id: op(),
    actor: "worker:delivery",
    run_id: run.run_id,
    lease,
    grant: grantInput({ may_create_or_update_pr: true }),
  });

  const provider = createGitHubDeliveryProvider({
    credentials: createStaticServiceCredentialStore(
      options.credentialRevoked === true ? {} : { [CREDENTIAL_REF]: TOKEN },
    ),
    resolve: () => ({
      canonical_repository_id: repository.repository_id,
      credential_ref: CREDENTIAL_REF,
    }),
    api_base_url: fake.base_url,
    request_timeout_ms: options.requestTimeoutMs ?? 2_000,
  });

  const brokerFor = (usedProvider: ReturnType<typeof createGitHubDeliveryProvider>) =>
    new DeliveryBroker({
      machine,
      providers: { github: usedProvider },
      approvalDirectory: directory,
      candidateContent: { read: (digest) => store.read(digest) },
      deliveryAuthorized: () => options.deliveryAuthorized ?? true,
      auditAvailable: () => options.auditAvailable ?? true,
    });

  return {
    root,
    clock,
    machine,
    store,
    broker: brokerFor(provider),
    brokerFor,
    fake,
    issue: machine.getIssue(issue.issue_id) as IssueRecord,
    candidate,
    approval: machine.getApproval(approval.approval_id) as ApprovalRecord,
    grantId: grant.grant_id,
    repository,
  };
}

function requestDelivery(f: Fixture) {
  return f.broker.request({
    operation_id: op(),
    actor: "orchestrator:delivery",
    issue_id: f.issue.issue_id,
    candidate_id: f.candidate.candidate_id,
    approval_id: f.approval.approval_id,
    grant_id: f.grantId,
    requester_authorized: true,
  });
}

describe("end-to-end delivery", () => {
  test("pushes the approved commit to the autofixer branch and opens its PR", async () => {
    const f = await setup();
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });

    expect(view.state).toBe("delivered");
    expect(view.error_code).toBeNull();
    expect(view.pr_url).not.toBeNull();

    const branch = autofixerBranchFor(f.issue.issue_id);
    expect(view.branch).toBe(branch);
    expect(f.fake.refs.get(branch)).toBe(f.candidate.head_sha);
    expect(f.fake.refs.get("main")).toBe(f.repository.base_sha);

    // The branch holds the approved commit object itself: same tree, same
    // pinned parent, same hash the approval covered.
    expect(f.fake.commits.get(f.candidate.head_sha)).toMatchObject({
      tree_sha: CANDIDATE_TREE,
      parents: [f.repository.base_sha],
    });

    expect(f.fake.pullRequests).toHaveLength(1);
    expect(f.fake.pullRequests[0]).toMatchObject({
      head_ref: branch,
      head_sha: f.candidate.head_sha,
      base_ref: "main",
      state: "open",
    });
    expect(f.machine.getDelivery(delivery.delivery_id)?.state).toBe("delivered");
  });

  test("an open PR for the same revision against another base is not adopted", async () => {
    const f = await setup();
    const branch = autofixerBranchFor(f.issue.issue_id);
    // An open PR for the approved revision targets a release branch instead of
    // the repository base. It is not evidence that this delivery happened.
    const foreign = f.fake.addPullRequest({
      head_ref: branch,
      head_sha: f.candidate.head_sha,
      base_ref: "release",
    });

    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });

    expect(view.state).toBe("delivered");
    expect(f.fake.pullRequests).toHaveLength(2);
    const created = f.fake.pullRequests.find((pr) => pr.number !== foreign.number);
    expect(created).toMatchObject({
      head_ref: branch,
      head_sha: f.candidate.head_sha,
      base_ref: "main",
      state: "open",
    });
    expect(view.pr_id).toBe(String(created?.number));
    expect(f.fake.refs.get(branch)).toBe(f.candidate.head_sha);
  });

  test("an audit-unavailable sink writes nothing to the provider", async () => {
    const f = await setup({ auditAvailable: false });
    const delivery = requestDelivery(f);
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_AUDIT_UNAVAILABLE",
    );
    expect(f.fake.writes()).toEqual([]);
    expect(f.fake.refs.get(autofixerBranchFor(f.issue.issue_id))).toBeUndefined();
    expect(f.fake.pullRequests).toEqual([]);
  });

  test("revoked delivery permission writes nothing to the provider", async () => {
    const f = await setup({ deliveryAuthorized: false });
    const delivery = requestDelivery(f);
    await expectCodeAsync(
      () => f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" }),
      "DELIVERY_FORBIDDEN",
    );
    expect(f.fake.writes()).toEqual([]);
    expect(f.fake.pullRequests).toEqual([]);
  });

  test("a revoked credential leaves the operation pending with no write", async () => {
    const f = await setup({ credentialRevoked: true });
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    // The pre-write evidence read cannot run without the credential, so the
    // outcome is unknown and no branch or PR exists.
    expect(view.state).toBe("unknown");
    expect(f.fake.writes()).toEqual([]);
    expect(f.fake.refs.get(autofixerBranchFor(f.issue.issue_id))).toBeUndefined();
  });

  test("a permission loss on the ref write is a definite failure with no branch", async () => {
    const f = await setup({
      faults: [{ method: "POST", path: "/git/refs", status: 403 }],
    });
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("failed");
    expect(view.error_code).toBe("PROVIDER_PERMISSION_DENIED");
    expect(f.fake.refs.get(autofixerBranchFor(f.issue.issue_id))).toBeUndefined();
    expect(f.fake.pullRequests).toEqual([]);
  });

  test("branch drift refuses the delivery instead of force-updating", async () => {
    const f = await setup();
    const branch = autofixerBranchFor(f.issue.issue_id);
    f.fake.refs.set(branch, "9".repeat(40));
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("failed");
    expect(view.error_code).toBe("PROVIDER_BRANCH_DRIFT");
    expect(f.fake.refs.get(branch)).toBe("9".repeat(40));
    expect(f.fake.pullRequests).toEqual([]);
  });

  test("an advanced base refuses the delivery", async () => {
    const f = await setup();
    f.fake.refs.set("main", "8".repeat(40));
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("failed");
    expect(view.error_code).toBe("PROVIDER_BASE_ADVANCED");
    expect(f.fake.pullRequests).toEqual([]);
  });

  test("a failed PR creation after a successful push is partial", async () => {
    const f = await setup({ faults: [{ method: "POST", path: "/pulls", status: 500 }] });
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("partial");
    expect(view.error_code).toBe("PR_CREATION_FAILED");
    expect(f.fake.refs.get(autofixerBranchFor(f.issue.issue_id))).toBe(f.candidate.head_sha);
    expect(f.fake.pullRequests).toEqual([]);
  });

  test("a lost PR response is partial, then reconcile delivers without a duplicate", async () => {
    const f = await setup({
      requestTimeoutMs: 150,
      faults: [{ method: "POST", path: "/pulls", delayMs: 400 }],
    });
    const delivery = requestDelivery(f);
    const view = await f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery" });
    expect(view.state).toBe("partial");
    expect(view.error_code).toBe("PR_CREATION_FAILED");
    // The provider created the PR even though the response was lost.
    expect(f.fake.pullRequests).toHaveLength(1);

    const reconciled = await f.broker.reconcile(delivery.delivery_id, {
      operation_id: op(),
      actor: "broker:reconcile",
    });
    expect(reconciled.state).toBe("delivered");
    expect(reconciled.pr_id).toBe(String(f.fake.pullRequests[0]?.number));
    expect(f.fake.pullRequests).toHaveLength(1);
  });

  test("two brokers delivering at once produce one push and one PR", async () => {
    const f = await setup({
      faults: [{ method: "GET", path: "/pulls?", delayMs: 120 }],
    });
    const delivery = requestDelivery(f);
    const secondProvider = createGitHubDeliveryProvider({
      credentials: createStaticServiceCredentialStore({ [CREDENTIAL_REF]: TOKEN }),
      resolve: () => ({
        canonical_repository_id: f.repository.repository_id,
        credential_ref: CREDENTIAL_REF,
      }),
      api_base_url: f.fake.base_url,
      request_timeout_ms: 2_000,
    });
    const second = f.brokerFor(secondProvider);

    const results = await Promise.allSettled([
      f.broker.deliver(delivery.delivery_id, { actor: "broker:delivery-a" }),
      second.deliver(delivery.delivery_id, { actor: "broker:delivery-b" }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "DELIVERY_STATE_CONFLICT",
    });

    const branch = autofixerBranchFor(f.issue.issue_id);
    expect(f.fake.refs.get(branch)).toBe(f.candidate.head_sha);
    expect(f.fake.pullRequests).toHaveLength(1);
    const refWrites = f.fake
      .writes()
      .filter((write) => write.includes("/git/refs") && !write.includes("/git/refs/heads"));
    const refPatches = f.fake
      .writes()
      .filter((write) => write.startsWith("PATCH") && write.includes("/git/refs/heads/"));
    expect(refWrites.length + refPatches.length).toBe(1);
  });
});
