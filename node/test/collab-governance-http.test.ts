import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { actionForRequest } from "../src/api/request-authority.js";
import { createApiServer } from "../src/api/server.js";
import type { ApiServerDeps } from "../src/api/server.js";
import { ApprovalService } from "../src/collab/approval-service.js";
import type { ApprovalDirectory } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { CandidateReviewService } from "../src/collab/candidate-service.js";
import { DeliveryBroker } from "../src/collab/delivery-broker.js";
import { CollabMachine } from "../src/collab/machine.js";
import {
  GovernanceProviderError,
  PullRequestGovernanceService,
} from "../src/collab/pr-governance.js";
import type {
  PRGovernanceProvider,
  ProviderGovernanceSnapshot,
} from "../src/collab/pr-governance.js";
import type { CandidateRecord, DeliveryRecord, IssueRecord } from "../src/collab/types.js";
import type { OrchestratorConfig } from "../src/config.js";
import type { DshClient } from "../src/dsh/client.js";
import type { ModelGateway } from "../src/gateway/index.js";
import { TaskService } from "../src/api/task-service.js";
import { TaskStore } from "../src/api/task-store.js";
import {
  REPOSITORY,
  WORKSPACE,
  acquireLease,
  freezeCandidateInput,
  grantInput,
  leaseRef,
  openRun,
  op,
  planningIssue,
  registerTestPolicy,
  stoppedPreparation,
} from "./helpers/collab.js";

/**
 * The governance observation route on the product API (DAT-261).
 *
 * Proves the route is served (authentication, issue/delivery scope), that a
 * successful read is a 200 observation bound to the delivered head, that a
 * provider failure is reported inside the body as blocked/unknown rather than
 * as a stale success, and that no mutating method exists on this path. The
 * observation service and the GitHub reader have their own suites.
 */

const API_TOKEN = "test-api-token-0123456789abcdef0123456789abcdef";
const OTHER_HEAD = "9".repeat(40);

const EMPTY_DIRECTORY: ApprovalDirectory = {
  authorityVersion: () => "directory-empty",
  members: () => [],
  member: () => null,
};

let root = "";
let server: http.Server;
let base = "";
let machine: CollabMachine;
let issue: IssueRecord;
let candidate: CandidateRecord;
let delivery: DeliveryRecord;
let answer: ProviderGovernanceSnapshot | GovernanceProviderError;

const NOW = "2026-11-18T09:00:00.000Z";

const scripted: PRGovernanceProvider = {
  provider: "github",
  observe() {
    return answer instanceof GovernanceProviderError
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  },
};

function passingSnapshot(
  overrides: Partial<ProviderGovernanceSnapshot> = {},
): ProviderGovernanceSnapshot {
  const head = delivery.head_sha;
  return {
    head_sha: head,
    pull_request_state: "open",
    checks: [
      { name: "build", status: "passed", head_sha: head, observed_at: NOW },
      { name: "test", status: "passed", head_sha: head, observed_at: NOW },
    ],
    approvals: [
      { identity: "Luthiel", decision: "approved", head_sha: head, submitted_at: NOW },
      { identity: "Ludwig-Planck", decision: "approved", head_sha: head, submitted_at: NOW },
    ],
    checks_complete: true,
    approvals_complete: true,
    head_stable: true,
    unresolved_discussions: 0,
    ...overrides,
  };
}

function minimalConfig(): OrchestratorConfig {
  return {
    dshSocketPath: "/tmp/unused.sock",
    apiHost: "127.0.0.1",
    apiPort: 0,
    apiTokenFile: "/tmp/unused-token",
    repositoryId: REPOSITORY.repository_id,
    repositoryUrl: REPOSITORY.url,
    baseRef: REPOSITORY.base_ref,
    baseSha: REPOSITORY.base_sha,
    actorId: "usr_operator",
    actorDisplayName: "Operator",
    approverIdentity: "github:local-operator",
    pathHints: [],
    toolCapabilities: [],
    maxWallClockSeconds: 60,
    enterpriseId: WORKSPACE.enterprise_id,
    workspaceId: WORKSPACE.workspace_id,
  } as OrchestratorConfig;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "collab-governance-http-"));
  const store = new CandidateContentStore(path.join(root, "candidates"));
  machine = new CollabMachine({ candidateStore: store, now: () => new Date(NOW) });
  const policy = registerTestPolicy(machine);
  issue = planningIssue(machine, { workspace: WORKSPACE, repository: REPOSITORY });
  const context = stoppedPreparation(machine, issue.issue_id, { policyId: policy.policy_id });
  candidate = machine.freezeCandidate(freezeCandidateInput(context));
  for (const to of ["validating", "awaiting_change_approval"] as const) {
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to,
      reason: null,
    });
  }

  const approval = machine.requestApproval({
    operation_id: op(),
    actor: "human:operator",
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    target_branch: REPOSITORY.base_ref,
    approver: { id: "usr_owner", display_name: "Owner" },
    no_eligible_approver: false,
    authority: {
      member_active: true,
      repository_access: true,
      approval_authority: true,
      authority_version: "directory-1",
    },
  });
  machine.decideApproval({
    operation_id: op(),
    actor: "user:usr_owner",
    issue_id: issue.issue_id,
    approval_id: approval.approval_id,
    decision: "approve",
    diff_digest: { algorithm: candidate.diff.digest_algorithm, value: candidate.diff.digest },
    actor_user: { id: "usr_owner", display_name: "Owner" },
    authority: {
      member_active: true,
      repository_access: true,
      approval_authority: true,
      authority_version: "directory-1",
    },
  });

  const deliveryRun = openRun(machine, issue.issue_id, { role: "delivery" });
  const lease = leaseRef(acquireLease(machine, deliveryRun.run_id, "worker:delivery"));
  machine.recordRunState({
    operation_id: op(),
    actor: "worker:delivery",
    run_id: deliveryRun.run_id,
    lease,
    to: "approved",
    head_sha: candidate.head_sha,
  });
  const grant = machine.recordGrant({
    operation_id: op(),
    actor: "worker:delivery",
    run_id: deliveryRun.run_id,
    lease,
    grant: grantInput({
      may_create_or_update_pr: true,
      expires_at: "2026-11-19T00:00:00.000Z",
    }),
  });
  delivery = machine.requestDelivery({
    operation_id: op(),
    actor: "user:usr_owner",
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    approval_id: approval.approval_id,
    target_branch: REPOSITORY.base_ref,
    provider: "github",
    grant_id: grant.grant_id,
    requester_authorized: true,
  });
  const authority = {
    approver_authorized: true,
    delivery_authorized: true,
    audit_available: true,
  };
  machine.recordDeliveryState({
    operation_id: op(),
    actor: "user:usr_owner",
    delivery_id: delivery.delivery_id,
    to: "pushing",
    branch: null,
    pr_id: null,
    pr_url: null,
    error_code: null,
    authority,
  });
  machine.recordDeliveryState({
    operation_id: op(),
    actor: "user:usr_owner",
    delivery_id: delivery.delivery_id,
    to: "opening_pr",
    branch: `autofixer/${issue.issue_id}`,
    pr_id: null,
    pr_url: null,
    error_code: null,
    authority,
  });
  delivery = machine.recordDeliveryState({
    operation_id: op(),
    actor: "user:usr_owner",
    delivery_id: delivery.delivery_id,
    to: "delivered",
    branch: `autofixer/${issue.issue_id}`,
    pr_id: "7",
    pr_url: "https://github.com/FoMo-Exp/AutoFixer/pull/7",
    error_code: null,
    authority,
  });

  answer = passingSnapshot();
  const config = minimalConfig();
  const service = new TaskService({
    config,
    dsh: {} as DshClient,
    store: new TaskStore(),
    gateway: {} as ModelGateway,
    workspaceBindings: {
      resolve() {
        throw new Error("no workspace binding in this test");
      },
    },
    runScope: () => ({
      enterpriseId: WORKSPACE.enterprise_id,
      workspaceId: WORKSPACE.workspace_id,
      scopeAuthority: {
        resolve: () => ({
          enterpriseId: WORKSPACE.enterprise_id,
          workspaceId: WORKSPACE.workspace_id,
        }),
      },
    }),
  });
  let observation = 0;
  const deps: ApiServerDeps = {
    service,
    apiToken: API_TOKEN,
    legacyWorkspaceId: WORKSPACE.workspace_id,
    collab: {
      machine,
      candidates: new CandidateReviewService(machine, store),
      approvals: new ApprovalService(machine, EMPTY_DIRECTORY),
      deliveries: new DeliveryBroker({
        machine,
        providers: {},
        approvalDirectory: EMPTY_DIRECTORY,
        candidateContent: { read: (digest) => store.read(digest) },
        auditAvailable: () => false,
      }),
      governance: new PullRequestGovernanceService({
        provider: scripted,
        clock: () => new Date(NOW),
        observationId: () => `gov_${String((observation += 1))}`,
      }),
    },
  };
  server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});

function url(deliveryId = delivery.delivery_id, workspaceId = WORKSPACE.workspace_id): string {
  return `${base}/api/v1/workspaces/${workspaceId}/issues/${issue.issue_id}/deliveries/${deliveryId}/governance`;
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" };
}

describe("GET .../deliveries/{delivery_id}/governance", () => {
  test("requires the deployment credential", async () => {
    const denied = await fetch(url());
    expect(denied.status).toBe(401);
  });

  test("serves a current-head observation for the delivered PR", async () => {
    answer = passingSnapshot();
    const response = await fetch(url(), { headers: bearer() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issue_id: issue.issue_id,
      delivery_id: delivery.delivery_id,
      repository_id: REPOSITORY.repository_id,
      provider: "github",
      pr_id: "7",
      delivery_head_sha: delivery.head_sha,
      head_sha: delivery.head_sha,
      validity: "current",
      observations_valid: true,
      conditions_satisfied: true,
      unmet_condition: null,
    });
    expect((body["checks"] as { items: unknown[] }).items).toHaveLength(2);
    expect((body["approvals"] as { satisfied: boolean }).satisfied).toBe(true);
    expect((body["review_discussions"] as { unresolved: number }).unresolved).toBe(0);
  });

  test("a provider permission denial is a 200 blocked observation, not a stale pass", async () => {
    answer = new GovernanceProviderError("blocked", "permission_denied");
    const response = await fetch(url(), { headers: bearer() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      validity: "blocked",
      head_sha: null,
      observations_valid: false,
      conditions_satisfied: false,
      unmet_condition: "governance_blocked",
    });
    expect((body["checks"] as { reason: string }).reason).toBe("permission_denied");
  });

  test("a provider outage is a 200 unknown observation", async () => {
    answer = new GovernanceProviderError("unknown", "provider_unavailable");
    const response = await fetch(url(), { headers: bearer() });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["validity"]).toBe("unknown");
    expect(body["conditions_satisfied"]).toBe(false);
    expect((body["checks"] as { reason: string }).reason).toBe("provider_unavailable");
  });

  test("a head the provider moved to is superseded and not eligible", async () => {
    answer = passingSnapshot({
      head_sha: OTHER_HEAD,
      checks: [{ name: "build", status: "passed", head_sha: delivery.head_sha, observed_at: NOW }],
      approvals: [
        {
          identity: "Luthiel",
          decision: "approved",
          head_sha: delivery.head_sha,
          submitted_at: NOW,
        },
      ],
    });
    const response = await fetch(url(), { headers: bearer() });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["head_sha"]).toBe(OTHER_HEAD);
    expect(body["validity"]).toBe("superseded");
    expect(body["unmet_condition"]).toBe("head_changed");
    expect(body["conditions_satisfied"]).toBe(false);
    // Old-head evidence is not inherited into the new head's observation.
    expect((body["checks"] as { items: unknown[] }).items).toEqual([]);
    expect((body["approvals"] as { items: unknown[] }).items).toEqual([]);
  });

  test("the route is read-only: no mutating method is served", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await fetch(url(), { method, headers: bearer() });
      expect(response.status, method).toBe(404);
    }
  });

  test("an unknown delivery is 404 and another workspace is unreachable", async () => {
    const missing = await fetch(url("dlv_missing"), { headers: bearer() });
    expect(missing.status).toBe(404);
    const foreign = await fetch(url(delivery.delivery_id, "ws_other"), { headers: bearer() });
    expect(foreign.status).toBe(404);
  });
});

describe("governance observation authorization class", () => {
  const base = ["api", "v1", "workspaces", "ws_1", "issues", "iss_1"];

  test("the observation is a read, so provider authority is enforced", () => {
    expect(actionForRequest("GET", [...base, "deliveries", "dlv_1", "governance"])).toBe("read");
    expect(actionForRequest("HEAD", [...base, "deliveries", "dlv_1", "governance"])).toBe("read");
    expect(actionForRequest("POST", [...base, "deliveries", "dlv_1", "governance"])).toBeNull();
    expect(actionForRequest("DELETE", [...base, "deliveries", "dlv_1", "governance"])).toBeNull();
  });
});
