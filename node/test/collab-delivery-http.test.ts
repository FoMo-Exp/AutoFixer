import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createApiServer } from "../src/api/server.js";
import type { ApiServerDeps } from "../src/api/server.js";
import { actionForRequest } from "../src/api/request-authority.js";
import { ApprovalService } from "../src/collab/approval-service.js";
import type { ApprovalDirectory } from "../src/collab/approval-service.js";
import { CandidateContentStore } from "../src/collab/candidate-store.js";
import { CandidateReviewService } from "../src/collab/candidate-service.js";
import { DeliveryBroker } from "../src/collab/delivery-broker.js";
import { CollabMachine } from "../src/collab/machine.js";
import type { IssueRecord } from "../src/collab/types.js";
import type { OrchestratorConfig } from "../src/config.js";
import type { DshClient } from "../src/dsh/client.js";
import type { ModelGateway } from "../src/gateway/index.js";
import { TaskService } from "../src/api/task-service.js";
import { TaskStore } from "../src/api/task-store.js";
import {
  REPOSITORY,
  WORKSPACE,
  freezeCandidateInput,
  op,
  planningIssue,
  registerTestPolicy,
  stoppedPreparation,
} from "./helpers/collab.js";

/**
 * HTTP wiring test for the collaboration delivery surface (DAT-259).
 *
 * Proves the routes are actually served by the product API (not just that a
 * handler exists): authentication is required, the issue must live in the path
 * workspace, candidate reads work for the deployment credential, and a
 * non-human deployment bearer can never decide an approval. The deeper
 * authority/idempotency/broker behavior is covered by
 * `collab-delivery-api.test.ts`, which runs against the production approval
 * directory.
 */

const API_TOKEN = "test-api-token-0123456789abcdef0123456789abcdef";

let root = "";
let server: http.Server;
let base = "";
let machine: CollabMachine;
let store: CandidateContentStore;
let issue: IssueRecord;

const EMPTY_DIRECTORY: ApprovalDirectory = {
  authorityVersion: () => "directory-empty",
  members: () => [],
  member: () => null,
};

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
  root = mkdtempSync(path.join(tmpdir(), "collab-delivery-http-"));
  store = new CandidateContentStore(path.join(root, "candidates"));
  machine = new CollabMachine({ candidateStore: store });
  const policy = registerTestPolicy(machine);
  issue = planningIssue(machine, { workspace: WORKSPACE, repository: REPOSITORY });
  const context = stoppedPreparation(machine, issue.issue_id, { policyId: policy.policy_id });
  machine.freezeCandidate(freezeCandidateInput(context));
  for (const to of ["validating", "awaiting_change_approval"] as const) {
    machine.transitionIssue({
      operation_id: op(),
      actor: "human:operator",
      issue_id: issue.issue_id,
      to,
      reason: null,
    });
  }

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
    },
  };
  server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function url(tail: string, workspaceId = WORKSPACE.workspace_id): string {
  return `${base}/api/v1/workspaces/${workspaceId}/issues/${issue.issue_id}/${tail}`;
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" };
}

describe("collaboration delivery routes are served by the product API", () => {
  test("candidate reads require the deployment credential", async () => {
    const denied = await fetch(url("candidates"));
    expect(denied.status).toBe(401);
    const served = await fetch(url("candidates"), { headers: bearer() });
    expect(served.status).toBe(200);
    const body = (await served.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  test("another workspace is unreachable with the deployment credential", async () => {
    // The operator bearer is scoped to the deployment workspace: the path
    // workspace itself is indistinguishable from a missing one, so no issue
    // identity is confirmed to the caller. (A session member of two workspaces
    // reaches the next scope check; the handler suite covers that
    // `ISSUE_NOT_FOUND` for an issue outside the path workspace.)
    const response = await fetch(url("candidates", "ws_other"), { headers: bearer() });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("an approval request is recorded unaddressed when no eligible human exists", async () => {
    const response = await fetch(url("approvals"), {
      method: "POST",
      headers: { ...bearer(), "Idempotency-Key": "request-1" },
      body: JSON.stringify({
        candidate_id: machine.listCandidates(issue.issue_id)[0]!.candidate_id,
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { approver: unknown; state: string };
    expect(body.approver).toBeNull();
    expect(body.state).toBe("pending");
  });

  test("the deployment bearer is not a human approver", async () => {
    const approvals = machine.listApprovals(issue.issue_id);
    const approval = approvals[approvals.length - 1]!;
    const response = await fetch(url(`approvals/${approval.approval_id}/decision`), {
      method: "POST",
      headers: { ...bearer(), "Idempotency-Key": "decision-1" },
      body: JSON.stringify({
        decision: "approve",
        diff_digest: approval.binding.diff_digest,
      }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("APPROVER_NOT_AUTHORIZED");
  });

  test("delivery without a reviewed provider is blocked before any write", async () => {
    const approvals = machine.listApprovals(issue.issue_id);
    const approval = approvals[approvals.length - 1]!;
    const response = await fetch(url("deliveries"), {
      method: "POST",
      headers: { ...bearer(), "Idempotency-Key": "delivery-1" },
      body: JSON.stringify({ approval_id: approval.approval_id, grant_id: "grt_missing" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DELIVERY_FORBIDDEN");
    expect(machine.listDeliveries(issue.issue_id)).toHaveLength(0);
  });

  test("an unsupported method or resource keeps the 404 fallback", async () => {
    const response = await fetch(url("candidates"), {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });
});

describe("action class mapping for the delivery surface", () => {
  const base = ["api", "v1", "workspaces", "ws_1", "issues", "iss_1"];

  test("reads are read, decisions are approval, delivery writes are delivery", () => {
    expect(actionForRequest("GET", [...base, "candidates"])).toBe("read");
    expect(actionForRequest("GET", [...base, "candidates", "cand_1"])).toBe("read");
    expect(actionForRequest("GET", [...base, "approvals", "apr_1"])).toBe("read");
    expect(actionForRequest("GET", [...base, "deliveries", "dlv_1"])).toBe("read");
    expect(actionForRequest("POST", [...base, "approvals"])).toBe("delivery");
    expect(actionForRequest("POST", [...base, "approvals", "apr_1", "decision"])).toBe("approval");
    expect(actionForRequest("POST", [...base, "deliveries"])).toBe("delivery");
    expect(actionForRequest("POST", [...base, "deliveries", "dlv_1", "reconcile"])).toBe(
      "delivery",
    );
  });

  test("an unknown subpath needs no authorization decision", () => {
    expect(actionForRequest("POST", [...base, "stage"])).toBeNull();
    expect(actionForRequest("DELETE", [...base, "candidates"])).toBeNull();
  });
});
