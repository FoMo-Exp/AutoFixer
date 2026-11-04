import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRepositories } from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { DEFAULT_RETRIEVAL_POLICY } from "../src/memory/index.js";
import type { RsiProposalView, RsiStatusView } from "../src/memory/index.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import { getJson, postJson, postRaw } from "./helpers/http.js";

/**
 * DAT-238 HTTP contract: the bounded RSI surface is session-authenticated,
 * workspace-scoped, role-gated, and the server — not the caller — computes the
 * evaluation. No dsh process is needed: replay is a pure read over memory.
 */

const MISSING_DSH = {
  socketPath: path.join(process.env["TMPDIR"] ?? "/tmp", "dat-238-no-such-dsh.sock"),
};

const HOLDOUT_SECRET = "HOLDOUT-SECRET-QUERY build flag rollout";

let app: AuthApp;
let session: LoggedInSession;
let approver: LoggedInSession;
let db: ControlPlaneDb;
let scope: WorkspaceScope;
let activeLessonId: string;

function memoryUrl(suffix: string, workspaceId = app.workspaceId): string {
  return `${app.base}/api/v1/workspaces/${workspaceId}/memory/${suffix}`;
}

function sessionHeaders(): Record<string, string> {
  return cookieSessionHeaders(session);
}

/**
 * A second human owns approvals: the HTTP surface records the session user as
 * the proposer, and a proposer may never approve its own proposal.
 */
function approverHeaders(): Record<string, string> {
  return cookieSessionHeaders(approver);
}

function setRole(role: "owner" | "admin" | "member"): void {
  const repos = createRepositories(db);
  const membership = repos.memberships.getByUser(scope, session.userId);
  if (membership === undefined) {
    repos.memberships.create(scope, { user_id: session.userId, role });
    return;
  }
  repos.memberships.updateRole(scope, membership.id, role, membership.version);
}

function proposalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Bounded relevance change",
    summary: "Offline replay backed weight change",
    diff: "- relevance: 0.45\n+ relevance: 0.45",
    target: "retrieval_weights",
    candidate_policy: DEFAULT_RETRIEVAL_POLICY,
    ...overrides,
  };
}

async function createProposal(overrides: Record<string, unknown> = {}) {
  return postJson<RsiProposalView>(
    memoryUrl("proposals"),
    proposalBody(overrides),
    sessionHeaders(),
  );
}

async function evaluateProposal(
  proposalId: string,
  headers: Record<string, string> = approverHeaders(),
) {
  return postJson<RsiProposalView>(memoryUrl(`proposals/${proposalId}/evaluations`), {}, headers);
}

beforeAll(async () => {
  app = await startAuthApp({ dsh: MISSING_DSH as never });
  db = app.orchestrator.controlPlane as ControlPlaneDb;
  scope = {
    enterprise_id: app.enterpriseId,
    workspace_id: app.workspaceId,
    actor_id: "usr_seed",
  };
  session = await webLogin(app);
  setRole("owner");

  app.provider.profile = { id: 2002, login: "approver" };
  approver = await webLogin(app);
  createRepositories(db).memberships.create(scope, {
    user_id: approver.userId,
    role: "owner",
  });

  const memory = app.orchestrator.memoryRepositories;
  const rsiStore = app.orchestrator.rsiStore;
  if (memory === undefined || rsiStore === undefined) {
    throw new Error("memory and RSI stores are not wired");
  }
  const lesson = memory.items.create(scope, {
    kind: "lesson",
    scope: { path_prefix: "node/src/memory" },
    statement: "Run node memory tests before delivery",
    preconditions: ["node workspace"],
    provenance: { author_type: "human" },
    trust: "human",
    sensitivity: "internal",
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_to: null,
  });
  memory.evidence.add(scope, lesson.item.id, {
    evidence_type: "reviewer_decision",
    reference: "pr:memory-rsi-api",
  });
  memory.items.reviewVersion(scope, lesson.item.id, 1, "usr_reviewer");
  memory.items.setStatus(scope, lesson.item.id, "candidate", 1);
  memory.items.setStatus(scope, lesson.item.id, "active", 1);
  activeLessonId = lesson.item.id;

  for (let index = 0; index < 20; index += 1) {
    rsiStore.addGoldenCase(
      scope,
      {
        case_id: `golden-${index}`,
        dataset: "golden",
        query: "node memory tests build command",
        scope: { path_prefix: "node/src/memory" },
        role: "owner",
        expected_item_ids: [activeLessonId],
        forbidden_item_ids: [],
      },
      "usr_seed",
    );
  }
  for (let index = 0; index < 20; index += 1) {
    rsiStore.addHoldoutCase(
      scope,
      {
        case_id: `holdout-${index}`,
        dataset: "holdout",
        query: HOLDOUT_SECRET,
        scope: { path_prefix: "node/src/memory" },
        role: "owner",
        expected_item_ids: [activeLessonId],
        forbidden_item_ids: [],
      },
      "usr_seed",
    );
  }
});

afterAll(async () => {
  await app?.stop();
});

describe("workspace RSI HTTP surface", () => {
  test("rejects unauthenticated proposal access", async () => {
    const response = await postRaw(memoryUrl("proposals"), {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proposalBody()),
    });
    expect(response.status).toBe(401);
  });

  test("rejects a workspace outside the caller's membership", async () => {
    const response = await getJson<unknown>(
      memoryUrl("proposals", "wsp_unknown"),
      sessionHeaders(),
    );
    expect(response.status).toBe(404);
  });

  test("derives the proposer and refuses client-supplied proposer or risk", async () => {
    const withProposer = await postJson<{ error: { code: string } }>(
      memoryUrl("proposals"),
      proposalBody({ proposer: { id: "someone", kind: "agent" } }),
      sessionHeaders(),
    );
    expect(withProposer.status).toBe(400);
    const withRisk = await postJson<{ error: { code: string } }>(
      memoryUrl("proposals"),
      proposalBody({ risk: "A" }),
      sessionHeaders(),
    );
    expect(withRisk.status).toBe(400);
  });

  test("refuses class D targets", async () => {
    const response = await postJson<{ error: { code: string } }>(
      memoryUrl("proposals"),
      proposalBody({ target: "capability_grant" }),
      sessionHeaders(),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  test("the full proposal → replay → approval → canary path, with no client metrics", async () => {
    const created = await createProposal();
    expect(created.status).toBe(201);
    expect(created.body.risk).toBe("A");
    expect(created.body.status).toBe("proposed");

    const evaluated = await evaluateProposal(created.body.proposal_id);
    expect(evaluated.status).toBe(201);
    expect(evaluated.body.gate.offline_evaluation).toBe("pass");
    expect(evaluated.body.evaluations.map((entry) => entry.dataset).sort()).toEqual([
      "golden",
      "holdout",
    ]);
    // The verifier is the authenticated evaluator, not a request-supplied claim.
    expect(evaluated.body.evaluations[0]?.verifier.id).toBe(approver.userId);
    expect(evaluated.body.evaluations[0]?.verifier.reference).toMatch(/^replay:/);
    expect(JSON.stringify(evaluated.body)).not.toContain("HOLDOUT-SECRET");

    const approved = await postJson<RsiProposalView>(
      memoryUrl(`proposals/${created.body.proposal_id}/approvals`),
      { note: "reviewed replay" },
      approverHeaders(),
    );
    expect(approved.status).toBe(201);
    expect(approved.body.gate.canary_eligible).toBe(true);

    const canary = await postJson<RsiProposalView>(
      memoryUrl(`proposals/${created.body.proposal_id}/canary`),
      {},
      sessionHeaders(),
    );
    expect(canary.status).toBe(201);
    expect(canary.body.rollout?.stage).toBe(10);

    // Client-supplied canary numbers are refused outright.
    const forged = await postJson<{ error: { code: string } }>(
      memoryUrl(`proposals/${created.body.proposal_id}/canary/observations`),
      {
        sample_size: 500,
        baseline_successes: 500,
        candidate_successes: 500,
        evidence_reference: "qa:forged",
      },
      sessionHeaders(),
    );
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("INVALID_REQUEST");

    // With no terminal pinned runs, the server refuses to invent a sample.
    const empty = await postJson<{ error: { code: string } }>(
      memoryUrl(`proposals/${created.body.proposal_id}/canary/observations`),
      {},
      sessionHeaders(),
    );
    expect(empty.status).toBe(409);
    const unchanged = await getJson<RsiProposalView>(
      memoryUrl(`proposals/${created.body.proposal_id}`),
      sessionHeaders(),
    );
    expect(unchanged.body.status).toBe("canary");
    expect(unchanged.body.rollout?.stage).toBe(10);
  });

  test("an evaluation body cannot carry a score or verifier claim", async () => {
    const created = await createProposal();
    const forged = await postJson<{ error: { code: string } }>(
      memoryUrl(`proposals/${created.body.proposal_id}/evaluations`),
      {
        verifier: { kind: "test", id: "usr_qa", reference: "self" },
        metrics: { sample_size: 100, candidate_successes: 100 },
      },
      approverHeaders(),
    );
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("INVALID_REQUEST");
  });

  test("the authenticated proposer cannot evaluate its own proposal", async () => {
    const created = await createProposal();
    const proposerSelf = await postJson<{ error: { code: string } }>(
      memoryUrl(`proposals/${created.body.proposal_id}/evaluations`),
      {},
      sessionHeaders(),
    );
    expect(proposerSelf.status).toBe(400);
    expect(proposerSelf.body.error.code).toBe("INVALID_REQUEST");
  });

  test("member and admin roles cannot start a canary or engage the kill switch", async () => {
    setRole("member");
    const created = await createProposal();
    // A member may propose, but not evaluate or canary.
    expect(created.status).toBe(201);
    const evaluation = await evaluateProposal(created.body.proposal_id, sessionHeaders());
    expect(evaluation.status).toBe(403);
    const killSwitch = await postJson<unknown>(
      memoryUrl("rsi/kill-switch"),
      { enabled: true, reason: "member attempt" },
      sessionHeaders(),
    );
    expect(killSwitch.status).toBe(403);
    setRole("admin");
    const canary = await postJson<unknown>(
      memoryUrl(`proposals/${created.body.proposal_id}/canary`),
      {},
      sessionHeaders(),
    );
    expect(canary.status).toBe(403);
    setRole("owner");
  });

  test("the kill switch is immediate and blocks a ready proposal from canarying", async () => {
    const created = await createProposal();
    await evaluateProposal(created.body.proposal_id);
    await postJson<RsiProposalView>(
      memoryUrl(`proposals/${created.body.proposal_id}/approvals`),
      {},
      approverHeaders(),
    );

    const engaged = await postJson<{ controls: { kill_switch: boolean } }>(
      memoryUrl("rsi/kill-switch"),
      { enabled: true, reason: "security incident" },
      sessionHeaders(),
    );
    expect(engaged.status).toBe(200);
    expect(engaged.body.controls.kill_switch).toBe(true);

    const status = await getJson<RsiStatusView>(memoryUrl("rsi/status"), sessionHeaders());
    expect(status.status).toBe(200);
    expect(status.body.controls.kill_switch).toBe(true);
    expect(status.body.holdout.cases).toBe(20);
    expect(JSON.stringify(status.body)).not.toContain("HOLDOUT-SECRET");

    const blocked = await postJson<{ error: { code: string } }>(
      memoryUrl(`proposals/${created.body.proposal_id}/canary`),
      {},
      sessionHeaders(),
    );
    expect(blocked.status).toBe(409);

    const released = await postJson<{ controls: { kill_switch: boolean } }>(
      memoryUrl("rsi/kill-switch"),
      { enabled: false, reason: "resolved" },
      sessionHeaders(),
    );
    expect(released.body.controls.kill_switch).toBe(false);
  });

  test("controls may be tightened but never beyond the workspace budget", async () => {
    const response = await fetch(memoryUrl("rsi/controls"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ weekly_change_budget: 1, auto_promote_low_risk: true }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { controls: { weekly_change_budget: number } };
    expect(body.controls.weekly_change_budget).toBe(1);

    const negative = await fetch(memoryUrl("rsi/controls"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ weekly_change_budget: -1 }),
    });
    expect(negative.status).toBe(400);
  });
});
