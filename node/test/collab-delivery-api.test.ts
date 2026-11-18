import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createApprovalDirectory, createDeliveryPermission } from "../src/api/collab-authority.js";
import type { CollabActor, CollabHttpDeps } from "../src/api/collab-http.js";
import { handleCollabRequest } from "../src/api/collab-http.js";
import { ApprovalService } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { CandidateReviewService } from "../src/collab/candidate-service.js";
import { DeliveryBroker } from "../src/collab/delivery-broker.js";
import type {
  OpenPullRequestInput,
  ProviderBranchEvidence,
  ProviderPullRequestEvidence,
  PushBranchInput,
  PushBranchOutcome,
} from "../src/collab/delivery-broker.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { CandidateRecord, IssueRecord, RepositoryRef } from "../src/collab/types.js";
import {
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb } from "../src/control-plane/index.js";
import type { ProviderAccessRepositories } from "../src/control-plane/provider-access-repositories.js";
import type { IdentityRepositories } from "../src/control-plane/identity-repositories.js";
import type { ControlPlaneRepositories } from "../src/control-plane/repositories.js";
import {
  Clock,
  REPOSITORY,
  freezeCandidateInput,
  grantInput,
  leaseRef,
  openRun,
  planningIssue,
  registerTestPolicy,
  stoppedPreparation,
  acquireLease,
  op,
} from "./helpers/collab.js";

/**
 * Delivery API boundary tests (DAT-259).
 *
 * These exercise the HTTP handler the server delegates to, with the *production*
 * approval directory and delivery-permission facts over a real control-plane
 * database and provider roster — no hand-written authority facts. They cover
 * the properties the issue names: server-authoritative workspace/member/
 * repository permission, candidate-bound approval, replay/restart idempotency,
 * concurrent delivery, and partial/unknown outcomes.
 *
 * The provider here is a scripted test double. It proves the broker's
 * transitions and the API surface only; it is never production delivery —
 * the deployment registers no provider adapter until DAT-260 lands one.
 */

const NOW = "2026-11-18T09:00:00.000Z";

class FakeProvider {
  readonly provider = "github" as const;
  readonly capabilities = {
    push: true,
    pull_request: true,
    repository_governance: "github_branch_protection" as const,
  };
  pushMode: "ok" | "ambiguous" | "failed" = "ok";
  findMode: "ok" | "throw" = "ok";
  /** When set, the PR probe waits for it (tests hold a write in flight). */
  findGate: Promise<void> | null = null;
  branchHead: string | null = null;
  pr: ProviderPullRequestEvidence | null = null;
  pushCalls: PushBranchInput[] = [];
  openCalls: OpenPullRequestInput[] = [];

  async observeBranch(): Promise<ProviderBranchEvidence> {
    return { head_sha: this.branchHead };
  }

  async pushBranch(input: PushBranchInput): Promise<PushBranchOutcome> {
    this.pushCalls.push({ ...input });
    if (this.pushMode === "ambiguous") {
      return { status: "ambiguous", error_code: "PROVIDER_PUSH_UNKNOWN" };
    }
    if (this.pushMode === "failed") {
      return { status: "failed", error_code: "PROVIDER_REJECTED" };
    }
    this.branchHead = input.head_sha;
    return { status: "pushed", head_sha: input.head_sha };
  }

  async findPullRequest(): Promise<ProviderPullRequestEvidence | null> {
    if (this.findGate !== null) {
      await this.findGate;
    }
    if (this.findMode === "throw") {
      throw new Error("provider evidence unavailable");
    }
    return this.pr;
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<ProviderPullRequestEvidence> {
    this.openCalls.push({ ...input });
    const pr: ProviderPullRequestEvidence = {
      pr_id: "pr_1",
      pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/1",
      branch: input.branch,
      head_sha: input.head_sha,
      state: "open",
    };
    this.pr = pr;
    return pr;
  }
}

class CapturingResponse {
  statusCode = 0;
  headersSent = false;
  payload = "";
  writeHead(status: number): void {
    this.statusCode = status;
    this.headersSent = true;
  }
  end(chunk?: unknown): void {
    if (typeof chunk === "string") {
      this.payload = chunk;
    }
  }
}

interface Fixture {
  root: string;
  clock: Clock;
  db: ControlPlaneDb;
  repos: ControlPlaneRepositories;
  identity: IdentityRepositories;
  access: ProviderAccessRepositories;
  workspaceId: string;
  machine: CollabMachine;
  store: CandidateContentStore;
  provider: FakeProvider;
  deps: CollabHttpDeps;
  issue: IssueRecord;
  candidate: CandidateRecord;
  ownerId: string;
  memberId: string;
  grantId: string;
  candidateHead: string;
}

let fixture: Fixture | null = null;

function setup(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "collab-delivery-api-"));
  const clock = new Clock(NOW);
  const store = new CandidateContentStore(path.join(root, "candidates"));
  const machine = new CollabMachine({
    candidateStore: store,
    persistencePath: path.join(root, "collaboration.json"),
    now: clock.now,
  });
  const db = openControlPlaneDb({ path: ":memory:" });
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: "usr_seed",
  });
  const instance = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspace = seedWorkspace(db, admin_scope, {
    name: "AutoFixer",
    repository_id: REPOSITORY.repository_id,
    provider_instance_id: instance.id,
  });
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const access = createProviderAccessRepositories(db);
  const scope = { enterprise_id: enterprise.id, workspace_id: workspace.id, actor_id: "usr_seed" };

  const owner = identity.users.create({ display_name: "Erin Owner", actor_id: "usr_seed" });
  repos.memberships.create(scope, { user_id: owner.id, role: "owner" });
  identity.identities.create({
    user_id: owner.id,
    provider_instance_id: instance.id,
    subject: "1001",
    login: "octo",
    actor_id: "usr_seed",
  });
  const member = identity.users.create({ display_name: "Sam Member", actor_id: "usr_seed" });
  repos.memberships.create(scope, { user_id: member.id, role: "member" });
  identity.identities.create({
    user_id: member.id,
    provider_instance_id: instance.id,
    subject: "1002",
    login: "sam",
    actor_id: "usr_seed",
  });

  access.integrations.create(scope, {
    provider_instance_id: instance.id,
    repository_id: REPOSITORY.repository_id,
    repository_name: "FoMo-Exp/AutoFixer",
    source_credential_ref: "svc-source",
    delivery_credential_ref: "svc-delivery",
    permission_visibility: "full",
    actor_id: "usr_seed",
  });
  access.roster.applySnapshot(scope, access.integrations.listByWorkspace(scope)[0]!.id, {
    verified_at: NOW,
    roles: [
      {
        subject: "1001",
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: "admin",
        authority_ref: "repo:owner",
        inherited_from: null,
      },
      {
        subject: "1002",
        login: "sam",
        source_kind: "direct_collaborator",
        provider_role: "push",
        authority_ref: "repo:member",
        inherited_from: null,
      },
    ],
    subject_users: { "1001": owner.id, "1002": member.id },
  });

  const directory = createApprovalDirectory({
    enterprise_id: enterprise.id,
    memberships: repos.memberships,
    users: identity.users,
    identities: identity.identities,
    access,
    clock: clock.now,
  });
  const provider = new FakeProvider();
  const deliveries = new DeliveryBroker({
    machine,
    providers: { github: provider },
    approvalDirectory: directory,
    deliveryAuthorized: createDeliveryPermission({
      machine,
      access,
      workspaces: repos.workspaces,
      enterprise_id: enterprise.id,
    }),
    auditAvailable: () => machine.auditAvailable(),
  });
  const deps: CollabHttpDeps = {
    machine,
    candidates: new CandidateReviewService(machine, store),
    approvals: new ApprovalService(machine, directory),
    deliveries,
  };

  const workspaceScope = { enterprise_id: enterprise.id, workspace_id: workspace.id };
  // A registered, workspace+repository-scoped test policy: validation evidence
  // is only meaningful against policy, never against checks a run supplied.
  const policy = registerTestPolicy(machine, {
    workspace: workspaceScope,
    repository_id: REPOSITORY.repository_id,
    repository_url: REPOSITORY.url,
  });
  const issue = planningIssue(machine, {
    workspace: workspaceScope,
    repository: REPOSITORY as RepositoryRef,
  });
  const context = stoppedPreparation(machine, issue.issue_id, { policyId: policy.policy_id });
  const candidate = machine.freezeCandidate(freezeCandidateInput(context));
  for (const to of ["validating", "awaiting_change_approval"] as const) {
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to,
      reason: null,
    });
  }

  const run = openRun(machine, issue.issue_id, { role: "delivery" });
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
    grant: grantInput({
      may_create_or_update_pr: true,
      expires_at: "2026-11-19T00:00:00.000Z",
    }),
  });

  return {
    root,
    clock,
    db,
    repos,
    identity,
    access,
    workspaceId: workspace.id,
    machine,
    store,
    provider,
    deps,
    issue: machine.getIssue(issue.issue_id) as IssueRecord,
    candidate,
    ownerId: owner.id,
    memberId: member.id,
    grantId: grant.grant_id,
    candidateHead: candidate.head_sha,
  };
}

beforeEach(() => {
  fixture = setup();
});

afterEach(() => {
  if (fixture !== null) {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = null;
  }
});

interface CallOptions {
  method: string;
  tail: string[];
  body?: unknown;
  idempotencyKey?: string;
  actor?: CollabActor;
  issueId?: string;
  workspaceId?: string;
  query?: string;
  requesterAuthorized?: boolean;
  deps?: CollabHttpDeps;
}

function actorFor(f: Fixture, userId: string, displayName: string): CollabActor {
  return { kind: "session", user_id: userId, display_name: displayName };
}

const OWNER = (f: Fixture): CollabActor => actorFor(f, f.ownerId, "Erin Owner");
const MEMBER = (f: Fixture): CollabActor => actorFor(f, f.memberId, "Sam Member");
const OPERATOR: CollabActor = { kind: "local_operator", user_id: null, display_name: null };

async function call(
  f: Fixture,
  options: CallOptions,
): Promise<{ handled: boolean; status: number; body: Record<string, unknown> }> {
  const payload =
    options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), "utf8")];
  const req = Readable.from(payload) as unknown as http.IncomingMessage;
  (req as unknown as { method: string }).method = options.method;
  (req as unknown as { headers: Record<string, string> }).headers =
    options.idempotencyKey === undefined ? {} : { "idempotency-key": options.idempotencyKey };
  const res = new CapturingResponse();
  const url = new URL(
    `http://127.0.0.1/api/v1/workspaces/${options.workspaceId ?? f.workspaceId}/issues/${
      options.issueId ?? f.issue.issue_id
    }/${options.tail.join("/")}${options.query ?? ""}`,
  );
  const handled = await handleCollabRequest(options.deps ?? f.deps, {
    req,
    res: res as unknown as http.ServerResponse,
    url,
    requestId: "req_test",
    workspaceId: options.workspaceId ?? f.workspaceId,
    issueId: options.issueId ?? f.issue.issue_id,
    tail: options.tail,
    actor: options.actor ?? OPERATOR,
    requesterAuthorized: options.requesterAuthorized ?? true,
  });
  return {
    handled,
    status: res.statusCode,
    body: res.payload === "" ? {} : (JSON.parse(res.payload) as Record<string, unknown>),
  };
}

async function expectApiCode(
  promise: Promise<{ status: number; body: Record<string, unknown> }>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const apiError = error as { status?: number; code?: string };
    expect(apiError.status).toBe(status);
    expect(apiError.code).toBe(code);
    return;
  }
  throw new Error(`expected ${status} ${code}`);
}

async function requestApproval(f: Fixture, key = "approval-key"): Promise<string> {
  const response = await call(f, {
    method: "POST",
    tail: ["approvals"],
    body: { candidate_id: f.candidate.candidate_id },
    idempotencyKey: key,
    actor: OWNER(f),
  });
  expect(response.status).toBe(201);
  return String(response.body["approval_id"]);
}

function diffBody(f: Fixture): { algorithm: string; value: string } {
  return { algorithm: f.candidate.diff.digest_algorithm, value: f.candidate.diff.digest };
}

async function approve(f: Fixture, approvalId: string): Promise<void> {
  const response = await call(f, {
    method: "POST",
    tail: ["approvals", approvalId, "decision"],
    body: { decision: "approve", diff_digest: diffBody(f) },
    idempotencyKey: "decision-key",
    actor: OWNER(f),
  });
  expect(response.status).toBe(200);
}

/** A second machine/services instance over the same persisted state (restart). */
function restartedServices(f: Fixture): { machine: CollabMachine; deps: CollabHttpDeps } {
  const machine = new CollabMachine({
    candidateStore: f.store,
    persistencePath: path.join(f.root, "collaboration.json"),
    now: f.clock.now,
  });
  const directory = createApprovalDirectory({
    enterprise_id: f.issue.workspace.enterprise_id,
    memberships: f.repos.memberships,
    users: f.identity.users,
    identities: f.identity.identities,
    access: f.access,
    clock: f.clock.now,
  });
  return {
    machine,
    deps: {
      machine,
      candidates: new CandidateReviewService(machine, f.store),
      approvals: new ApprovalService(machine, directory),
      deliveries: new DeliveryBroker({
        machine,
        providers: { github: f.provider },
        approvalDirectory: directory,
        deliveryAuthorized: createDeliveryPermission({
          machine,
          access: f.access,
          workspaces: f.repos.workspaces,
          enterprise_id: f.issue.workspace.enterprise_id,
        }),
        auditAvailable: () => machine.auditAvailable(),
      }),
    },
  };
}

/** Record the delivery intent without starting a write (as the API route does). */
function recordDeliveryIntent(f: Fixture, approvalId: string, operationId: string) {
  return f.deps.deliveries.request({
    operation_id: operationId,
    actor: `user:${f.ownerId}`,
    issue_id: f.issue.issue_id,
    candidate_id: f.candidate.candidate_id,
    approval_id: approvalId,
    grant_id: f.grantId,
    requester_authorized: true,
  });
}

/**
 * Persist the pre-write state transition the broker records, then stop: this is
 * exactly the audit state a process leaves behind when it dies during a
 * provider write.
 */
function recordPreWriteState(
  f: Fixture,
  deliveryId: string,
  operationId: string,
  to: "pushing" | "opening_pr",
) {
  return f.machine.recordDeliveryState({
    operation_id: `${operationId}:${to}`,
    actor: `user:${f.ownerId}`,
    delivery_id: deliveryId,
    to,
    branch: to === "opening_pr" ? `autofixer/${f.issue.issue_id}` : null,
    pr_id: null,
    pr_url: null,
    error_code: null,
    authority: {
      approver_authorized: true,
      delivery_authorized: true,
      audit_available: true,
    },
  });
}

describe("candidate review reads are workspace-scoped", () => {
  test("list and card are served for the issue in the path workspace", async () => {
    const f = fixture!;
    const list = await call(f, { method: "GET", tail: ["candidates"], actor: OWNER(f) });
    expect(list.handled).toBe(true);
    expect(list.status).toBe(200);
    expect((list.body["items"] as unknown[]).length).toBe(1);

    const card = await call(f, {
      method: "GET",
      tail: ["candidates", f.candidate.candidate_id],
      actor: OWNER(f),
    });
    expect(card.status).toBe(200);
    expect(card.body["candidate_id"]).toBe(f.candidate.candidate_id);
    expect(card.body["diff"]).toMatchObject({ digest: f.candidate.diff.digest });
  });

  test("another workspace's issue is an indistinguishable 404", async () => {
    const f = fixture!;
    await expectApiCode(
      call(f, {
        method: "GET",
        tail: ["candidates"],
        workspaceId: "ws_other",
        actor: OWNER(f),
      }),
      404,
      "ISSUE_NOT_FOUND",
    );
  });

  test("a candidate of another issue is not enumerable", async () => {
    const f = fixture!;
    await expectApiCode(
      call(f, {
        method: "GET",
        tail: ["candidates", "cand_other"],
        actor: OWNER(f),
      }),
      404,
      "CANDIDATE_NOT_FOUND",
    );
  });
});

describe("approvals use live membership and repository authority", () => {
  test("an approver without current repository access cannot be addressed", async () => {
    const f = fixture!;
    // Remove the provider roster membership: the workspace role remains, the
    // repository access does not. Approval eligibility is both, so addressing
    // this user must fail rather than trust the workspace role alone.
    const scope = {
      enterprise_id: f.issue.workspace.enterprise_id,
      workspace_id: f.workspaceId,
      actor_id: "usr_seed",
    };
    const integration = f.access.integrations.listByWorkspace(scope)[0]!;
    f.access.roster.applySnapshot(scope, integration.id, {
      verified_at: NOW,
      roles: [
        {
          subject: "1001",
          login: "octo",
          source_kind: "direct_collaborator",
          provider_role: "admin",
          authority_ref: "repo:owner",
          inherited_from: null,
        },
      ],
      subject_users: { "1001": f.ownerId },
    });

    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["approvals"],
        body: {
          candidate_id: f.candidate.candidate_id,
          approver_user_id: f.memberId,
        },
        idempotencyKey: "approval-denied",
        actor: OWNER(f),
      }),
      403,
      "APPROVER_NOT_AUTHORIZED",
    );
  });

  test("the request is addressed to the one eligible human and only they may decide", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    const approval = await call(f, {
      method: "GET",
      tail: ["approvals", approvalId],
      actor: OWNER(f),
    });
    expect(approval.status).toBe(200);
    expect(approval.body["state"]).toBe("pending");
    expect(approval.body["approver"]).toMatchObject({ id: f.ownerId });

    // A member who can read the issue is not the addressed approver.
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["approvals", approvalId, "decision"],
        body: { decision: "approve", diff_digest: diffBody(f) },
        idempotencyKey: "not-addressed",
        actor: MEMBER(f),
      }),
      403,
      "APPROVER_NOT_AUTHORIZED",
    );

    // The deployment bearer is not a human and never decides.
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["approvals", approvalId, "decision"],
        body: { decision: "approve", diff_digest: diffBody(f) },
        idempotencyKey: "operator-decision",
        actor: OPERATOR,
      }),
      403,
      "APPROVER_NOT_AUTHORIZED",
    );

    // Approving a different revision is a stale binding, not an approval.
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["approvals", approvalId, "decision"],
        body: { decision: "approve", diff_digest: { algorithm: "sha256", value: "a".repeat(64) } },
        idempotencyKey: "wrong-digest",
        actor: OWNER(f),
      }),
      409,
      "APPROVAL_BINDING_STALE",
    );

    await approve(f, approvalId);
    const decided = await call(f, {
      method: "GET",
      tail: ["approvals", approvalId],
      actor: OWNER(f),
    });
    expect(decided.body["state"]).toBe("approved");
  });

  test("a restarted service replays the recorded approval and decision", async () => {
    const f = fixture!;
    const first = await requestApproval(f, "restart-key");
    await approve(f, first);

    // Restart: a new machine rebuilt from the persisted audit log, with new
    // services over the same control-plane facts.
    const restarted = restartedServices(f);
    expect(restarted.machine.snapshotDigest()).toBe(f.machine.snapshotDigest());
    const replayed = await call(f, {
      method: "POST",
      tail: ["approvals"],
      body: { candidate_id: f.candidate.candidate_id },
      idempotencyKey: "restart-key",
      actor: OWNER(f),
      deps: restarted.deps,
    });
    expect(replayed.status).toBe(201);
    expect(replayed.body["approval_id"]).toBe(first);

    // The recorded decision replays too instead of being re-applied.
    const replayDecision = await call(f, {
      method: "POST",
      tail: ["approvals", first, "decision"],
      body: { decision: "approve", diff_digest: diffBody(f) },
      idempotencyKey: "decision-key",
      actor: OWNER(f),
      deps: restarted.deps,
    });
    expect(replayDecision.status).toBe(200);
    expect(replayDecision.body["state"]).toBe("approved");
    // Exactly one request and one decision were recorded: the replays returned
    // them, they did not ask for a second approval.
    expect(
      restarted.machine
        .listApprovals(f.issue.issue_id)
        .filter((item) => item.candidate_id === f.candidate.candidate_id),
    ).toHaveLength(1);
    expect(restarted.machine.listApprovals(f.issue.issue_id)[0]?.decision?.decision).toBe(
      "approve",
    );
  });

  test("reusing a key with a different payload is an idempotency conflict", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    // Same operation id (actor + route + key) with a different decision body:
    // the machine refuses the rewrite instead of applying a second decision.
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["approvals", approvalId, "decision"],
        body: {
          decision: "reject",
          diff_digest: diffBody(f),
          note: "changed my mind under the same key",
        },
        idempotencyKey: "decision-key",
        actor: OWNER(f),
      }),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
  });
});

describe("broker-controlled delivery", () => {
  test("delivery without a reviewed provider is blocked before any write", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const directory = createApprovalDirectory({
      enterprise_id: f.issue.workspace.enterprise_id,
      memberships: f.repos.memberships,
      users: f.identity.users,
      identities: f.identity.identities,
      access: f.access,
      clock: f.clock.now,
    });
    const blocked: CollabHttpDeps = {
      ...f.deps,
      deliveries: new DeliveryBroker({
        machine: f.machine,
        providers: {},
        approvalDirectory: directory,
        deliveryAuthorized: () => true,
        auditAvailable: () => true,
      }),
    };
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["deliveries"],
        body: { approval_id: approvalId, grant_id: f.grantId },
        idempotencyKey: "delivery-blocked",
        actor: OWNER(f),
        deps: blocked,
      }),
      403,
      "DELIVERY_FORBIDDEN",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
    expect(f.machine.listDeliveries(f.issue.issue_id)).toHaveLength(0);
  });

  test("an approved candidate is delivered once through the broker", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const response = await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "delivery-key",
      actor: OWNER(f),
    });
    expect(response.status).toBe(202);
    expect(response.body["state"]).toBe("delivered");
    expect(response.body["head_sha"]).toBe(f.candidateHead);
    expect(response.body["branch"]).toBe(`autofixer/${f.issue.issue_id}`);
    expect(f.provider.pushCalls).toHaveLength(1);
    expect(f.provider.openCalls).toHaveLength(1);
    // The approved change moved into the delivery stage only once.
    expect(f.machine.getIssue(f.issue.issue_id)?.product_state).toBe("delivering");

    // Same key, same operation: replayed, never a second push.
    const replay = await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "delivery-key",
      actor: OWNER(f),
    });
    expect(replay.status).toBe(202);
    expect(replay.body["delivery_id"]).toBe(response.body["delivery_id"]);
    expect(f.provider.pushCalls).toHaveLength(1);
    expect(f.provider.openCalls).toHaveLength(1);
  });

  test("a rejection terminates the request and refuses delivery", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    const rejected = await call(f, {
      method: "POST",
      tail: ["approvals", approvalId, "decision"],
      body: { decision: "reject", diff_digest: diffBody(f), note: "not this revision" },
      idempotencyKey: "reject-key",
      actor: OWNER(f),
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body["state"]).toBe("rejected");
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["deliveries"],
        body: { approval_id: approvalId, grant_id: f.grantId },
        idempotencyKey: "delivery-after-reject",
        actor: OWNER(f),
      }),
      409,
      "APPROVAL_NOT_APPROVED",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("concurrent identical delivery requests perform exactly one write", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const attempt = () =>
      call(f, {
        method: "POST",
        tail: ["deliveries"],
        body: { approval_id: approvalId, grant_id: f.grantId },
        idempotencyKey: "delivery-concurrent",
        actor: OWNER(f),
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const statuses = results.map((result) =>
      result.status === "fulfilled"
        ? result.value.status
        : (result.reason as { status: number }).status,
    );
    expect(statuses.sort()).toEqual([202, 409]);
    const denied = results.find((result) => result.status === "rejected");
    expect((denied as PromiseRejectedResult).reason.code).toBe("DELIVERY_STATE_CONFLICT");
    expect(f.provider.pushCalls).toHaveLength(1);
    expect(f.provider.openCalls).toHaveLength(1);

    // Afterwards the same key reports the one delivered operation.
    const settled = await attempt();
    expect(settled.status).toBe(202);
    expect(settled.body["state"]).toBe("delivered");
    expect(f.provider.pushCalls).toHaveLength(1);
  });

  test("a failed pre-write PR probe stops at unknown and never pushes", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    f.provider.findMode = "throw";
    const response = await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "probe-failed",
      actor: OWNER(f),
    });
    expect(response.status).toBe(202);
    expect(response.body["state"]).toBe("unknown");
    expect(response.body["error_code"]).toBe("PROVIDER_UNAVAILABLE");
    // An unreadable PR probe is never "no PR exists": no push, no PR.
    expect(f.provider.pushCalls).toHaveLength(0);
    expect(f.provider.openCalls).toHaveLength(0);

    // Only an explicit reconcile, once evidence is readable, converges.
    f.provider.findMode = "ok";
    f.provider.branchHead = f.candidateHead;
    f.provider.pr = {
      pr_id: "pr_1",
      pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/1",
      branch: `autofixer/${f.issue.issue_id}`,
      head_sha: f.candidateHead,
      state: "open",
    };
    const reconciled = await call(f, {
      method: "POST",
      tail: ["deliveries", String(response.body["delivery_id"]), "reconcile"],
      idempotencyKey: "probe-failed-reconcile",
      actor: OWNER(f),
    });
    expect(reconciled.status).toBe(202);
    expect(reconciled.body["state"]).toBe("delivered");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a crash-orphaned pushing state converges after restart without a new write", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const intent = recordDeliveryIntent(f, approvalId, "op_crash_push");
    recordPreWriteState(f, intent.delivery_id, "op_crash_push", "pushing");
    expect(f.machine.getDelivery(intent.delivery_id)?.state).toBe("pushing");

    // The process died after the push but before recording its result: the
    // restarted service still sees the in-flight state.
    const restarted = restartedServices(f);
    expect(restarted.machine.getDelivery(intent.delivery_id)?.state).toBe("pushing");
    f.provider.branchHead = f.candidateHead;

    const reconciled = await call(f, {
      method: "POST",
      tail: ["deliveries", intent.delivery_id, "reconcile"],
      idempotencyKey: "crash-push-reconcile",
      actor: OWNER(f),
      deps: restarted.deps,
    });
    expect(reconciled.status).toBe(202);
    expect(reconciled.body["state"]).toBe("partial");
    expect(reconciled.body["error_code"]).toBe("PR_NOT_OBSERVED");
    expect(f.provider.pushCalls).toHaveLength(0);
    expect(f.provider.openCalls).toHaveLength(0);
  });

  test("a crash-orphaned pushing state with no provider side effect converges to failed", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const intent = recordDeliveryIntent(f, approvalId, "op_crash_empty");
    recordPreWriteState(f, intent.delivery_id, "op_crash_empty", "pushing");
    const restarted = restartedServices(f);
    const reconciled = await call(f, {
      method: "POST",
      tail: ["deliveries", intent.delivery_id, "reconcile"],
      idempotencyKey: "crash-empty-reconcile",
      actor: OWNER(f),
      deps: restarted.deps,
    });
    expect(reconciled.status).toBe(202);
    expect(reconciled.body["state"]).toBe("failed");
    expect(reconciled.body["error_code"]).toBe("NO_PROVIDER_SIDE_EFFECT");
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("a crash-orphaned opening_pr state reconciles to delivered from PR evidence", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const intent = recordDeliveryIntent(f, approvalId, "op_crash_open");
    recordPreWriteState(f, intent.delivery_id, "op_crash_open", "pushing");
    recordPreWriteState(f, intent.delivery_id, "op_crash_open", "opening_pr");
    expect(f.machine.getDelivery(intent.delivery_id)?.state).toBe("opening_pr");

    const restarted = restartedServices(f);
    f.provider.branchHead = f.candidateHead;
    const pr = {
      pr_id: "pr_1",
      pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/1",
      branch: `autofixer/${f.issue.issue_id}`,
      head_sha: f.candidateHead,
      state: "open" as const,
    };
    f.provider.pr = pr;

    const reconciled = await call(f, {
      method: "POST",
      tail: ["deliveries", intent.delivery_id, "reconcile"],
      idempotencyKey: "crash-open-reconcile",
      actor: OWNER(f),
      deps: restarted.deps,
    });
    expect(reconciled.status).toBe(202);
    expect(reconciled.body["state"]).toBe("delivered");
    expect(reconciled.body["pr_url"]).toBe(pr.pr_url);
    // The PR was adopted, never opened a second time.
    expect(f.provider.pushCalls).toHaveLength(0);
    expect(f.provider.openCalls).toHaveLength(0);
  });

  test("reconcile is refused while the same operation's write is still running", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const intent = recordDeliveryIntent(f, approvalId, "op_live_write");
    let release!: () => void;
    f.provider.findGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = f.deps.deliveries.deliver(intent.delivery_id, {
      actor: `user:${f.ownerId}`,
    });
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["deliveries", intent.delivery_id, "reconcile"],
        idempotencyKey: "live-write-reconcile",
        actor: OWNER(f),
      }),
      409,
      "DELIVERY_STATE_CONFLICT",
    );
    release();
    const view = await attempt;
    expect(view.state).toBe("delivered");
    expect(f.provider.pushCalls).toHaveLength(1);
  });

  test("a consumed approval cannot start a second delivery", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const first = await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "delivery-first",
      actor: OWNER(f),
    });
    expect(first.status).toBe(202);
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["deliveries"],
        body: { approval_id: approvalId, grant_id: f.grantId },
        idempotencyKey: "delivery-second",
        actor: OWNER(f),
      }),
      409,
      "APPROVAL_CONSUMED",
    );
    expect(f.provider.pushCalls).toHaveLength(1);
  });

  test("a pending approval is not enough to deliver", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["deliveries"],
        body: { approval_id: approvalId, grant_id: f.grantId },
        idempotencyKey: "delivery-pending",
        actor: OWNER(f),
      }),
      409,
      "APPROVAL_NOT_APPROVED",
    );
    expect(f.provider.pushCalls).toHaveLength(0);
  });

  test("an unauthorized requester never records a delivery", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["deliveries"],
        body: { approval_id: approvalId, grant_id: f.grantId },
        idempotencyKey: "delivery-unauthorized",
        actor: MEMBER(f),
        requesterAuthorized: false,
      }),
      403,
      "DELIVERY_FORBIDDEN",
    );
    expect(f.machine.listDeliveries(f.issue.issue_id)).toHaveLength(0);
  });

  test("an ambiguous push is unknown until an explicit reconcile", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    f.provider.pushMode = "ambiguous";
    const ambiguous = await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "delivery-ambiguous",
      actor: OWNER(f),
    });
    expect(ambiguous.status).toBe(202);
    expect(ambiguous.body["state"]).toBe("unknown");
    const deliveryId = String(ambiguous.body["delivery_id"]);

    // The provider actually holds the approved commit: reconcile records the
    // delivered state without a second push.
    f.provider.branchHead = f.candidateHead;
    f.provider.pr = {
      pr_id: "pr_1",
      pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/1",
      branch: `autofixer/${f.issue.issue_id}`,
      head_sha: f.candidateHead,
      state: "open",
    };
    const reconciled = await call(f, {
      method: "POST",
      tail: ["deliveries", deliveryId, "reconcile"],
      idempotencyKey: "reconcile-key",
      actor: OWNER(f),
    });
    expect(reconciled.status).toBe(202);
    expect(reconciled.body["state"]).toBe("delivered");
    expect(f.provider.pushCalls).toHaveLength(1);
  });

  test("a pushed branch whose PR is missing is an explicit partial outcome", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    const initialOpen = f.provider.openPullRequest.bind(f.provider);
    f.provider.openPullRequest = async () => {
      throw new Error("PR creation timed out");
    };
    const partial = await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "delivery-partial",
      actor: OWNER(f),
    });
    expect(partial.status).toBe(202);
    expect(partial.body["state"]).toBe("partial");
    expect(partial.body["error_code"]).toBe("PR_CREATION_FAILED");
    expect(partial.body["pr_url"]).toBeNull();

    // Reconcile observes only the branch: still partial, never invented success.
    f.provider.openPullRequest = initialOpen;
    const reconciled = await call(f, {
      method: "POST",
      tail: ["deliveries", String(partial.body["delivery_id"]), "reconcile"],
      idempotencyKey: "reconcile-partial",
      actor: OWNER(f),
    });
    expect(reconciled.status).toBe(202);
    expect(reconciled.body["state"]).toBe("partial");
    expect(reconciled.body["error_code"]).toBe("PR_NOT_OBSERVED");
  });

  test("the delivery list pages by opaque cursor", async () => {
    const f = fixture!;
    const approvalId = await requestApproval(f);
    await approve(f, approvalId);
    await call(f, {
      method: "POST",
      tail: ["deliveries"],
      body: { approval_id: approvalId, grant_id: f.grantId },
      idempotencyKey: "delivery-page",
      actor: OWNER(f),
    });
    const list = await call(f, { method: "GET", tail: ["deliveries"], actor: OWNER(f) });
    expect(list.status).toBe(200);
    expect((list.body["items"] as unknown[]).length).toBe(1);
    expect(list.body["next_cursor"]).toBeNull();
    await expectApiCode(
      call(f, {
        method: "GET",
        tail: ["deliveries"],
        query: "?cursor=dlv_unknown",
        actor: OWNER(f),
      }),
      400,
      "INVALID_CURSOR",
    );
  });
});

describe("route ownership", () => {
  test("paths outside the candidate/approval/delivery surface are not handled", async () => {
    const f = fixture!;
    const tasks = await call(f, { method: "GET", tail: ["tasks"], actor: OWNER(f) });
    expect(tasks.handled).toBe(false);
    const candidatePost = await call(f, {
      method: "POST",
      tail: ["candidates"],
      body: {},
      actor: OWNER(f),
    });
    expect(candidatePost.handled).toBe(false);
  });

  test("an approval request requires a frozen candidate", async () => {
    const f = fixture!;
    await expectApiCode(
      call(f, {
        method: "POST",
        tail: ["approvals"],
        body: { candidate_id: "cand_missing" },
        idempotencyKey: "missing-candidate",
        actor: OWNER(f),
      }),
      404,
      "CANDIDATE_NOT_FOUND",
    );
  });
});
