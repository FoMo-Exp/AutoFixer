import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { WorkspaceScope } from "../src/control-plane/index.js";
import type { TaskResource } from "../src/api/task-store.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson } from "./helpers/http.js";
import { startAuthApp } from "./helpers/auth-app.js";
import type { AuthApp } from "./helpers/auth-app.js";

/**
 * DAT-238 blocker 3: run creation pins memory versions through the production
 * task path. Creating and approving a real dsh-backed task must record the
 * pin on the task resource and in the RSI pin table.
 */

let dsh: DshServerHandle;
let app: AuthApp;
let scope: WorkspaceScope;
let lessonId: string;

const REPOSITORY_ID = "github:Luthiel/AutoFixer";

function operatorHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${app.orchestrator.apiToken}` };
}

async function createAndApprove(): Promise<TaskResource> {
  const created = await postJson<TaskResource>(
    `${app.base}/api/v1/tasks`,
    {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Run node memory tests build command",
      acceptance_criteria: ["memory used"],
    },
    { "Content-Type": "application/json", ...operatorHeaders() },
  );
  expect(created.status).toBe(201);
  const taskId = created.body.id;
  // dsh stamps the run with microsecond precision while Node's approved_at is
  // millisecond-truncated; approving in the same millisecond is rejected as
  // before the run existed. Real approvals are human-paced, so this pins the
  // integration boundary rather than a unit timer.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const timeline = await getJson<{
    items: Array<{ type: string; data: Record<string, unknown> }>;
  }>(`${app.base}/api/v1/tasks/${taskId}/timeline`, operatorHeaders());
  const digest = timeline.body.items.find((event) => event.type === "approval.required")?.data[
    "scope_digest"
  ];
  expect(typeof digest).toBe("string");
  const approved = await postJson<TaskResource>(
    `${app.base}/api/v1/tasks/${taskId}/approvals`,
    { decision: "approve", scope_digest: String(digest) },
    { "Content-Type": "application/json", ...operatorHeaders() },
  );
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return approved.body;
}

beforeAll(async () => {
  dsh = await startDshServer({ approver: "github:local-operator" });
  app = await startAuthApp({ dsh });
  scope = {
    enterprise_id: app.enterpriseId,
    workspace_id: app.workspaceId,
    actor_id: "usr_seed",
  };
  const memory = app.orchestrator.memoryRepositories;
  if (memory === undefined) {
    throw new Error("memory is not wired");
  }
  const lesson = memory.items.create(scope, {
    kind: "lesson",
    scope: {},
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
    reference: "pr:memory-run-pin",
  });
  memory.items.reviewVersion(scope, lesson.item.id, 1, "usr_reviewer");
  memory.items.setStatus(scope, lesson.item.id, "candidate", 1);
  memory.items.setStatus(scope, lesson.item.id, "active", 1);
  lessonId = lesson.item.id;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await dsh?.stop();
});

describe("run path version pinning", () => {
  test("task creation consumes the resolver and records the pin", async () => {
    const task = await createAndApprove();
    expect(task.current_run_id).toBeTruthy();
    const runId = String(task.current_run_id);
    expect(task.memory).not.toBeNull();
    expect(task.memory?.run_id).toBe(runId);
    expect(task.memory?.canary).toBe(false);
    expect(task.memory?.policy_version).toBe(1);
    expect(task.memory?.degraded).toBe(false);
    expect(task.memory?.item_ids).toContain(lessonId);

    const pin = app.orchestrator.rsi?.getRunPin(scope, runId);
    expect(pin).toBeDefined();
    expect(pin?.memory_version).toBe(task.memory?.memory_version);
    expect(pin?.policy_version).toBe(task.memory?.policy_version);
    expect(pin?.policy_hash).toBe(task.memory?.policy_hash);
  });
});
