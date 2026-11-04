import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRepositories } from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import type { MemoryBundle, MemoryItemsPage, MemoryVersionsView } from "../src/memory/index.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import { getJson, postJson, postRaw } from "./helpers/http.js";

/**
 * DAT-236 HTTP contract: the memory v1 surface is session-authenticated,
 * workspace-scoped, CSRF-protected, and read-mostly. These tests drive the real
 * orchestrator, session store, memory repositories, and route handler; no dsh
 * process is needed because memory never executes anything.
 */

const MISSING_DSH = {
  socketPath: path.join(process.env["TMPDIR"] ?? "/tmp", "dat-236-no-such-dsh.sock"),
};

let app: AuthApp;
let session: LoggedInSession;
let db: ControlPlaneDb;
let scope: WorkspaceScope;
let injectedItemId: string;

function memoryUrl(suffix: string, workspaceId = app.workspaceId): string {
  return `${app.base}/api/v1/workspaces/${workspaceId}/memory/${suffix}`;
}

function sessionHeaders(): Record<string, string> {
  return cookieSessionHeaders(session);
}

function setRole(role: "owner" | "viewer"): void {
  const repos = createRepositories(db);
  const membership = repos.memberships.getByUser(scope, session.userId);
  if (membership === undefined) {
    repos.memberships.create(scope, { user_id: session.userId, role });
    return;
  }
  repos.memberships.updateRole(scope, membership.id, role, membership.version);
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

  const memory = app.orchestrator.memoryRepositories;
  if (memory === undefined) {
    throw new Error("memory repositories are not wired");
  }
  const lesson = memory.items.create(scope, {
    kind: "lesson",
    scope: { path_prefix: "node/src/memory" },
    statement: "Run the node memory tests before claiming a retrieval change is done",
    preconditions: ["node workspace"],
    provenance: { author_type: "human" },
    trust: "human",
    sensitivity: "internal",
    valid_from: "2026-11-01T00:00:00.000Z",
    valid_to: null,
  });
  memory.items.reviewVersion(scope, lesson.item.id, 1, "usr_reviewer");
  memory.evidence.add(scope, lesson.item.id, {
    evidence_type: "reviewer_decision",
    reference: "pr:memory-retrieval",
  });
  memory.items.setStatus(scope, lesson.item.id, "candidate", 1);
  memory.items.setStatus(scope, lesson.item.id, "active", 1);
  injectedItemId = lesson.item.id;
});

afterAll(async () => {
  await app?.stop();
});

describe("workspace memory v1 HTTP surface", () => {
  test("rejects unauthenticated retrieval", async () => {
    const response = await postRaw(memoryUrl("search"), {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "node memory" }),
    });
    expect(response.status).toBe(401);
  });

  test("enforces the CSRF echo on cookie-authenticated writes", async () => {
    const response = await postRaw(memoryUrl("search"), {
      headers: { "Content-Type": "application/json", Cookie: `fp_session=${session.session}` },
      body: JSON.stringify({ query: "node memory" }),
    });
    expect(response.status).toBe(403);
  });

  test("serves a bounded bundle with the caller's workspace and version", async () => {
    const response = await postJson<MemoryBundle>(
      memoryUrl("search"),
      {
        purpose: "run_plan",
        query: "node memory tests",
        scope: { path_prefix: "node/src/memory" },
        run_id: "run_http_1",
      },
      sessionHeaders(),
    );
    expect(response.status).toBe(200);
    expect(response.body.workspace_id).toBe(app.workspaceId);
    expect(response.body.degraded).toBe(false);
    expect(response.body.lessons.map((item) => item.item_id)).toContain(injectedItemId);
    expect(response.body.version.policy_version).toBeGreaterThanOrEqual(1);
    expect(response.body.version.memory_version).toMatch(/^m1\./);
    expect(response.body.trust_boundary.tool_control_authority).toBe("dsh");
    expect(response.body.budget.max_items).toBe(8);
    expect(response.body.budget.max_tokens).toBe(1_500);
  });

  test("never accepts a client-supplied scope identifier", async () => {
    const response = await postJson<{ error: { code: string } }>(
      memoryUrl("search"),
      { query: "node memory", workspace_id: app.workspaceId },
      sessionHeaders(),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  test("hides workspaces outside the caller's membership", async () => {
    const response = await postJson(
      memoryUrl("search", "ws_not_a_member"),
      { query: "node memory" },
      sessionHeaders(),
    );
    expect(response.status).toBe(404);
  });

  test("browses and pages memory items", async () => {
    const first = await getJson<MemoryItemsPage>(memoryUrl("items?limit=1"), sessionHeaders());
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]?.evidence.length).toBeGreaterThan(0);

    const filtered = await getJson<MemoryItemsPage>(
      memoryUrl("items?kind=lesson&status=active"),
      sessionHeaders(),
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.items.every((item) => item.kind === "lesson")).toBe(true);

    const invalid = await getJson<{ error: { code: string } }>(
      memoryUrl("items?kind=nonsense"),
      sessionHeaders(),
    );
    expect(invalid.status).toBe(400);
  });

  test("exposes policy and corpus versions", async () => {
    const response = await getJson<MemoryVersionsView>(memoryUrl("versions"), sessionHeaders());
    expect(response.status).toBe(200);
    expect(response.body.retrieval_policy.version).toBeGreaterThanOrEqual(1);
    expect(response.body.policy_versions.length).toBeGreaterThanOrEqual(1);
    expect(response.body.corpus.items).toBeGreaterThanOrEqual(1);
    expect(response.body.items.some((item) => item.item_id === injectedItemId)).toBe(true);
  });

  test("records feedback for injected items only", async () => {
    const bundle = (
      await postJson<MemoryBundle>(
        memoryUrl("search"),
        { query: "node memory tests", scope: { path_prefix: "node/src/memory" } },
        sessionHeaders(),
      )
    ).body;
    const injected = bundle.lessons[0];
    expect(injected).toBeDefined();

    const accepted = await postJson<{ feedback_id: string; outcome: string }>(
      memoryUrl("feedback"),
      {
        bundle_id: bundle.bundle_id,
        run_id: "run_http_1",
        outcome: "accepted",
        items: [
          {
            item_id: injected?.item_id ?? "",
            item_version: injected?.item_version ?? 0,
            useful: true,
          },
        ],
      },
      sessionHeaders(),
    );
    expect(accepted.status).toBe(201);
    expect(accepted.body.outcome).toBe("accepted");

    const invalid = await postJson<{ error: { code: string } }>(
      memoryUrl("feedback"),
      {
        bundle_id: bundle.bundle_id,
        run_id: "run_http_1",
        outcome: "accepted",
        items: [{ item_id: "mem_not_injected", item_version: 1 }],
      },
      sessionHeaders(),
    );
    expect(invalid.status).toBe(400);

    const missingBundle = await postJson<{ error: { code: string } }>(
      memoryUrl("feedback"),
      { bundle_id: "mb_missing", run_id: "run_http_1", outcome: "unknown" },
      sessionHeaders(),
    );
    expect(missingBundle.status).toBe(404);
  });

  test("only an owner may record an evaluation result", async () => {
    const versions = (await getJson<MemoryVersionsView>(memoryUrl("versions"), sessionHeaders()))
      .body;
    const body = {
      kind: "offline_replay",
      dataset: { name: "workspace golden set", sample_size: 20, holdout: true },
      policy_version: versions.retrieval_policy.version,
      memory_version: versions.memory_version,
      metrics: { sample_size: 20, success_rate_delta: 0.05 },
      verdict: "pass",
    };
    const created = await postJson<{ eval_run_id: string }>(
      memoryUrl("eval-runs"),
      body,
      sessionHeaders(),
    );
    expect(created.status).toBe(201);
    expect(created.body.eval_run_id).toMatch(/^mer_/);

    setRole("viewer");
    const denied = await postJson<{ error: { code: string } }>(
      memoryUrl("eval-runs"),
      body,
      sessionHeaders(),
    );
    expect(denied.status).toBe(403);

    const readOnlySearch = await postJson<MemoryBundle>(
      memoryUrl("search"),
      { query: "node memory tests" },
      sessionHeaders(),
    );
    expect(readOnlySearch.status).toBe(200);

    const viewerFeedback = await postJson<{ error: { code: string } }>(
      memoryUrl("feedback"),
      { bundle_id: "mb_any", run_id: "run_http_1", outcome: "accepted" },
      sessionHeaders(),
    );
    expect(viewerFeedback.status).toBe(403);

    setRole("owner");
  });
});
