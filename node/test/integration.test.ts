import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createOrchestrator } from "../src/index.js";
import type { OrchestratorHandle } from "../src/index.js";
import type { OrchestratorConfig } from "../src/config.js";
import { configFromEnv } from "../src/config.js";
import type { ApiErrorBody } from "../src/api/errors.js";
import type { RunSummary, TaskResource, TimelineItem } from "../src/api/task-store.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson, postRaw, readSse, setAuthToken, waitUntil } from "./helpers/http.js";
import type { ScriptedTurn } from "./helpers/scripted-stream.js";
import { makeGate, scriptedStream, TEST_MODEL } from "./helpers/scripted-stream.js";

const APPROVER = "github:local-operator";
const REPOSITORY_ID = "github:Luthiel/AutoFixer";
const BASE_SHA = "52081eaddca099967fd8be13b3060337fde50d3f";

let dsh: DshServerHandle;
const apps: OrchestratorHandle[] = [];
let tokenDirCounter = 0;

beforeAll(async () => {
  dsh = await startDshServer({ approver: APPROVER });
}, 120_000);

afterAll(async () => {
  await dsh.stop();
});

afterEach(async () => {
  const app = apps.pop();
  if (app) {
    await app.stop();
  }
});

function testConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  tokenDirCounter += 1;
  const tokenDir = mkdtempSync(path.join(tmpdir(), `forgepilot-test-${tokenDirCounter}-`));
  return {
    dshSocketPath: dsh.socketPath,
    apiHost: "127.0.0.1",
    apiPort: 0,
    apiTokenFile: path.join(tokenDir, "api-token"),
    repositoryId: REPOSITORY_ID,
    repositoryUrl: "https://github.com/Luthiel/AutoFixer.git",
    baseRef: "main",
    baseSha: BASE_SHA,
    actorId: "usr_test_operator",
    actorDisplayName: "Test Operator",
    approverIdentity: APPROVER,
    pathHints: ["node"],
    toolCapabilities: ["echo", "sleep"],
    maxWallClockSeconds: 60,
    ...overrides,
  };
}

async function startApp(turns: ScriptedTurn[], overrides: Partial<OrchestratorConfig> = {}) {
  const scripted = scriptedStream(turns);
  const orchestrator = createOrchestrator({
    config: testConfig(overrides),
    model: TEST_MODEL,
    streamFn: scripted.streamFn,
  });
  apps.push(orchestrator);
  setAuthToken(orchestrator.apiToken);
  const { port } = await orchestrator.start();
  return { orchestrator, scripted, base: `http://127.0.0.1:${port}` };
}

async function timeline(base: string, taskId: string): Promise<TimelineItem[]> {
  const response = await getJson<{ items: TimelineItem[] }>(
    `${base}/api/v1/tasks/${taskId}/timeline`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

/**
 * Create a task and record the pre-grant approval. Since Node fails closed to
 * elevated (no authenticated risk facts exist in the v1 body), every task
 * needs the scoped approval before Pi starts.
 */
async function createAndApprove(
  base: string,
  body: Record<string, unknown> = {},
): Promise<TaskResource> {
  const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
    repository_id: REPOSITORY_ID,
    base_ref: "main",
    summary: "Verify the echo tool works",
    source_reference: "https://github.com/Luthiel/AutoFixer/issues/42",
    acceptance_criteria: ["echo prints hello"],
    ...body,
  });
  expect(created.status).toBe(201);
  const taskId = created.body.id;
  const required = (await timeline(base, taskId)).find(
    (event) => event.type === "approval.required",
  );
  const digest = required?.data["scope_digest"];
  expect(typeof digest).toBe("string");
  const approved = await postJson<TaskResource>(`${base}/api/v1/tasks/${taskId}/approvals`, {
    decision: "approve",
    scope_digest: String(digest),
  });
  expect(approved.status).toBe(200);
  return approved.body;
}

function requireRunId(task: TaskResource): string {
  if (typeof task.current_run_id !== "string") {
    throw new Error(`task ${task.id} has no current_run_id`);
  }
  return task.current_run_id;
}

describe("forgepilot-api/v1 against the real dsh control plane", () => {
  test("every task fails closed to elevated and streams Pi events after approval", async () => {
    const { base } = await startApp([
      {
        kind: "tool",
        text: "Checking the echo tool.",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["node/check.txt"],
        rationale: "verify echo works",
      },
      { kind: "text", text: "Echo verified." },
    ]);
    // Create with acceptance criteria — the old heuristic would have granted
    // low risk here; the fail-closed posture must classify it elevated.
    const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Verify the echo tool works",
      source_reference: "https://github.com/Luthiel/AutoFixer/issues/42",
      acceptance_criteria: ["echo prints hello"],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("awaiting_approval");
    expect(created.body.risk?.class).toBe("elevated");
    expect(created.body.risk?.requires_human_approval).toBe(true);
    const taskId = created.body.id;
    const runId = requireRunId(created.body);

    // Approve with the scope digest from the approval.required event.
    const required = (await timeline(base, taskId)).find(
      (event) => event.type === "approval.required",
    );
    const digest = String(required?.data["scope_digest"]);
    const approved = await postJson<TaskResource>(`${base}/api/v1/tasks/${taskId}/approvals`, {
      decision: "approve",
      scope_digest: digest,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");

    await waitUntil(
      async () => (await timeline(base, taskId)).some((event) => event.type === "pi.turn_settled"),
      "Pi turn settled",
    );

    const events = await timeline(base, taskId);
    const types = events.map((event) => event.type);
    expect(types).toContain("task.status_changed");
    expect(types).toContain("approval.resolved");
    expect(types).toContain("pi.text_delta");
    expect(types).toContain("tool.requested");
    expect(types).toContain("tool.completed");
    expect(types).toContain("pi.turn_settled");

    const text = events.find((event) => event.type === "pi.text_delta");
    expect(text?.data["delta"]).toBe("Checking the echo tool.");

    const requested = events.find((event) => event.type === "tool.requested");
    expect(requested?.data["tool_id"]).toBe("echo");
    expect(requested?.data["path_scope"]).toEqual(["node/check.txt"]);

    const completed = events.find((event) => event.type === "tool.completed");
    expect(String(completed?.data["action_id"])).toMatch(/^act_/);
    expect(completed?.data["state"]).toBe("running");

    // An accepted action appends dsh audit evidence.
    const evidence = events.find((event) => event.type === "evidence.appended");
    expect(String(evidence?.data["audit_event_reference"])).toMatch(/^evidence:\/\//);

    const task = await getJson<TaskResource>(`${base}/api/v1/tasks/${taskId}`);
    expect(task.body.status).toBe("validating");
    expect(task.body.progress.actions_completed).toBe(1);

    // dsh is the fact source: the run really executed one allowed action.
    const run = await dsh.client.getRun(runId);
    expect(run.state).toBe("running");
    expect(run.execution_counts.actions_allowed).toBe(1);

    const runs = await getJson<{ items: RunSummary[] }>(`${base}/api/v1/tasks/${taskId}/runs`);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0]?.state).toBe("running");

    const list = await getJson<{ items: TaskResource[] }>(`${base}/api/v1/tasks`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.id)).toContain(taskId);
  });

  test("messages are blocked and wrong scope digests are refused before approval", async () => {
    const { base } = await startApp([]);
    const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Unbounded request without acceptance criteria",
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("awaiting_approval");
    const taskId = created.body.id;

    // No Pi session exists before approval: messages are refused, not faked.
    const early = await postJson<ApiErrorBody>(`${base}/api/v1/tasks/${taskId}/messages`, {
      mode: "steer",
      content: "nudge",
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("TASK_STATE_CONFLICT");

    // Wrong scope digest: dsh refuses the mismatch, Node maps it to 409.
    const wrong = await postJson<ApiErrorBody>(`${base}/api/v1/tasks/${taskId}/approvals`, {
      decision: "approve",
      scope_digest: "sha256:deadbeef",
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe("TASK_STATE_CONFLICT");
    expect(wrong.body.error.details["dsh_code"]).toBe("DSH_APPROVAL_SCOPE_MISMATCH");
  });

  test("an out-of-grant action intent is refused by dsh and stops the task", async () => {
    const { base } = await startApp([
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["secrets/keys.md"],
        rationale: "attempt outside the grant",
      },
      { kind: "text", text: "Stopped by policy." },
    ]);
    const created = await createAndApprove(base);
    const runId = requireRunId(created);

    await waitUntil(async () => {
      const task = await getJson<TaskResource>(`${base}/api/v1/tasks/${created.id}`);
      return task.body.status === "stopped";
    }, "task stopped by the out-of-grant refusal");

    const events = await timeline(base, created.id);
    const types = events.map((event) => event.type);
    expect(types).not.toContain("tool.completed");
    const denied = events.find((event) => event.type === "tool.denied");
    expect(denied?.data["error_code"]).toBe("DSH_SCOPE_DENIED");
    expect(
      events.some((event) => event.type === "task.terminal" && event.data["status"] === "stopped"),
    ).toBe(true);

    // The stop condition is dsh's, not Node's.
    const run = await dsh.client.getRun(runId);
    expect(run.state).toBe("stopped");

    // Terminal tasks refuse further mutation.
    const cancel = await postJson<ApiErrorBody>(`${base}/api/v1/tasks/${created.id}/cancel`, {});
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("TASK_STATE_CONFLICT");
  });

  test("a terminal task is absorbing: a stale dsh read cannot revive it", async () => {
    const { base, orchestrator } = await startApp([
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["secrets/keys.md"],
        rationale: "attempt outside the grant",
      },
      { kind: "text", text: "Stopped." },
    ]);
    const created = await createAndApprove(base);
    await waitUntil(async () => {
      const task = await getJson<TaskResource>(`${base}/api/v1/tasks/${created.id}`);
      return task.body.status === "stopped";
    }, "task terminal");

    // Re-run the refresh path directly: it must be a no-op on a terminal task.
    const record = orchestrator.store.get(created.id);
    expect(record?.terminal).toBe(true);
    const versionBefore = record?.version;
    // Await the actual refresh; the absorbing terminal guard keeps the task
    // terminal and leaves the version untouched (no fixed wait: the refresh
    // promise is the signal).
    await orchestrator.service["refreshRunState"](record!);
    expect(orchestrator.store.get(created.id)?.status).toBe("stopped");
    expect(orchestrator.store.get(created.id)?.terminal).toBe(true);
    expect(orchestrator.store.get(created.id)?.version).toBe(versionBefore);

    // Timeline must not contain a status change after the terminal event.
    const events = await timeline(base, created.id);
    const terminalIndex = events.findIndex((event) => event.type === "task.terminal");
    const statusAfterTerminal = events
      .slice(terminalIndex + 1)
      .filter((event) => event.type === "task.status_changed");
    expect(statusAfterTerminal).toHaveLength(0);
  });

  test("shell-shaped requests never execute: vocabulary is refused, unregistered tools are denied", async () => {
    const { base } = await startApp([
      {
        // `command` is a forbidden request key in dsh-control/v1: shell
        // vocabulary is refused at the protocol layer, before any dispatch.
        kind: "tool",
        toolId: "sh",
        args: { command: "echo pwned" },
        pathScope: ["node/x.txt"],
        rationale: "try a shell",
      },
      {
        // A tool id that is not in dsh's registry is denied by the registry
        // and recorded in the evidence chain.
        kind: "tool",
        toolId: "sh",
        args: { script: "pwned" },
        pathScope: ["node/x.txt"],
        rationale: "try an unregistered tool",
      },
      { kind: "text", text: "I cannot run shells." },
    ]);
    const created = await createAndApprove(base);
    const runId = requireRunId(created);

    await waitUntil(async () => {
      const denied = (await timeline(base, created.id)).filter(
        (event) => event.type === "tool.denied",
      );
      return denied.length >= 2;
    }, "both shell attempts denied");
    const events = await timeline(base, created.id);
    const denialCodes = events
      .filter((event) => event.type === "tool.denied")
      .map((event) => event.data["error_code"]);
    expect(denialCodes).toContain("INVALID_REQUEST");
    expect(denialCodes).toContain("TOOL_NOT_REGISTERED");
    expect(events.map((event) => event.type)).not.toContain("tool.completed");

    const run = await dsh.client.getRun(runId);
    expect(run.execution_counts.actions_allowed).toBe(0);
    expect(run.execution_counts.actions_denied).toBe(1);
  });

  test("cancel aborts the Pi run and projects dsh's cancelled state", async () => {
    const { base } = await startApp([
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["node/cancel.txt"],
        rationale: "start work that will hang next",
      },
      { kind: "hang" },
    ]);
    const created = await createAndApprove(base);
    const runId = requireRunId(created);

    await waitUntil(
      async () =>
        (await timeline(base, created.id)).some((event) => event.type === "tool.completed"),
      "first action completed before cancel",
    );

    const cancelled = await postJson<TaskResource>(`${base}/api/v1/tasks/${created.id}/cancel`, {
      reason: "operator stopped it",
    });
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.status).toBe("cancelled");

    const events = await timeline(base, created.id);
    expect(
      events.some(
        (event) => event.type === "task.terminal" && event.data["status"] === "cancelled",
      ),
    ).toBe(true);
    const run = await dsh.client.getRun(runId);
    expect(run.state).toBe("cancelled");
  });

  test("a wall-clock timeout inside dsh projects timed_out", async () => {
    const { base } = await startApp(
      [
        {
          kind: "tool",
          toolId: "sleep",
          args: { seconds: "5" },
          pathScope: ["node/sleep.txt"],
          rationale: "sleep past the wall clock",
        },
        { kind: "text", text: "Woke up." },
      ],
      { maxWallClockSeconds: 2 },
    );
    const created = await createAndApprove(base);
    const runId = requireRunId(created);

    await waitUntil(
      async () => {
        const task = await getJson<TaskResource>(`${base}/api/v1/tasks/${created.id}`);
        return task.body.status === "timed_out";
      },
      "task timed out by dsh",
      30_000,
    );
    const run = await dsh.client.getRun(runId);
    expect(run.state).toBe("timed_out");

    const events = await timeline(base, created.id);
    const completed = events.find((event) => event.type === "tool.completed");
    expect(completed?.data["state"]).toBe("timed_out");
    expect(
      events.some(
        (event) => event.type === "task.terminal" && event.data["status"] === "timed_out",
      ),
    ).toBe(true);
  });

  test("SSE replays the event history and resumes after Last-Event-ID", async () => {
    const { base } = await startApp([
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["secrets/keys.md"],
        rationale: "outside the grant",
      },
      { kind: "text", text: "Stopped." },
    ]);
    const created = await createAndApprove(base);
    await waitUntil(async () => {
      const task = await getJson<TaskResource>(`${base}/api/v1/tasks/${created.id}`);
      return task.body.status === "stopped";
    }, "task terminal for the stream");

    const frames = await readSse(`${base}/api/v1/tasks/${created.id}/stream`, {
      untilType: "task.terminal",
    });
    const types = frames.map((frame) => frame.event);
    expect(types).toContain("task.status_changed");
    expect(types).toContain("tool.requested");
    expect(types).toContain("tool.denied");
    expect(types[types.length - 1]).toBe("task.terminal");

    const anchor = frames[1];
    if (!anchor?.id || typeof anchor.data?.sequence !== "number") {
      throw new Error("expected a replay anchor frame with an id and sequence");
    }
    const anchorSequence = anchor.data.sequence;
    const resumed = await readSse(`${base}/api/v1/tasks/${created.id}/stream`, {
      lastEventId: anchor.id,
      timeoutMs: 2_000,
    });
    for (const frame of resumed) {
      expect(typeof frame.data?.sequence).toBe("number");
      expect(Number(frame.data?.sequence)).toBeGreaterThan(anchorSequence);
    }
  });

  test("steer and follow_up messages reach the Pi session", async () => {
    const gate = makeGate();
    const { base, scripted } = await startApp([
      { kind: "gate", text: "Working on it.", gate },
      { kind: "text", text: "Plan B applied." },
      { kind: "text", text: "Extra check done." },
    ]);
    const created = await createAndApprove(base);

    await waitUntil(() => scripted.calls.length >= 1, "first model call");
    const steer = await postJson<{ task_id: string; queued: boolean }>(
      `${base}/api/v1/tasks/${created.id}/messages`,
      { mode: "steer", content: "switch to plan B" },
    );
    expect(steer.status).toBe(202);
    expect(steer.body.queued).toBe(true);

    gate.release();
    await waitUntil(
      async () =>
        (await timeline(base, created.id)).filter((event) => event.type === "pi.turn_settled")
          .length >= 1,
      "first turn settled",
    );
    // The steering message was drained into the next model call's context.
    await waitUntil(() => scripted.calls.length >= 2, "steered model call");
    expect(scripted.calls[1]?.some((content) => content.includes("switch to plan B"))).toBe(true);

    const followUp = await postJson<{ task_id: string; queued: boolean }>(
      `${base}/api/v1/tasks/${created.id}/messages`,
      { mode: "follow_up", content: "run one more check" },
    );
    expect(followUp.status).toBe(202);
    await waitUntil(() => scripted.calls.length >= 3, "follow-up model call");
    expect(scripted.calls[2]?.some((content) => content.includes("run one more check"))).toBe(true);
  });

  test("foreign repositories are refused before contacting dsh", async () => {
    const { base } = await startApp([]);
    const response = await postJson<ApiErrorBody>(`${base}/api/v1/tasks`, {
      repository_id: "github:acme/payments",
      base_ref: "main",
      summary: "Fix the export",
      acceptance_criteria: ["export works"],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  test("unknown tasks 404 with the contract error envelope", async () => {
    const { base } = await startApp([]);
    const response = await getJson<ApiErrorBody>(`${base}/api/v1/tasks/tsk_missing`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("TASK_NOT_FOUND");
    expect(response.body.error.request_id).toMatch(/^req_/);
  });
});

describe("API authentication and origin guards (QA round-1 blocker)", () => {
  test("every endpoint requires the bearer token", async () => {
    const { base } = await startApp([]);
    setAuthToken(""); // strip credentials to reproduce the QA finding
    const created = await postRaw(`${base}/api/v1/tasks`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "sneaky",
      }),
    });
    expect(created.status).toBe(401);
    const read = await fetch(`${base}/api/v1/tasks`);
    expect(read.status).toBe(401);
    const stream = await fetch(`${base}/api/v1/tasks/tsk_x/stream`);
    expect(stream.status).toBe(401);
  });

  test("a wrong token is rejected", async () => {
    const { base } = await startApp([]);
    setAuthToken("0000000000000000000000000000000000000000000000000000000000000000");
    const created = await postJson<ApiErrorBody>(`${base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "sneaky",
    });
    expect(created.status).toBe(401);
  });

  test("a cross-site Origin and a non-JSON content type are refused", async () => {
    const { base, orchestrator } = await startApp([]);
    // Restore a valid token after the negative tests above.
    setAuthToken(orchestrator.apiToken);

    // Cross-site origin, even with a valid token.
    const crossSite = await postRaw(`${base}/api/v1/tasks`, {
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: JSON.stringify({ repository_id: REPOSITORY_ID, base_ref: "main", summary: "x" }),
    });
    expect(crossSite.status).toBe(403);

    // Simple-request content type (text/plain) is refused: bodies must be JSON.
    const plain = await postRaw(`${base}/api/v1/tasks`, {
      headers: { "Content-Type": "text/plain", Origin: "https://untrusted.example" },
      body: JSON.stringify({ repository_id: REPOSITORY_ID, base_ref: "main", summary: "x" }),
    });
    expect([400, 403]).toContain(plain.status);

    // The loopback origin is allowed.
    const port = new URL(base).port;
    const sameOrigin = await postJson<ApiErrorBody>(`${base}/api/v1/tasks`, {
      repository_id: "github:acme/payments",
      base_ref: "main",
      summary: "x",
    });
    expect(sameOrigin.status).toBe(400); // reaches validation, i.e. auth+origin passed
    expect(port).toBeTruthy();
  });

  test("config refuses a non-loopback bind address", () => {
    expect(() =>
      configFromEnv({
        FORGEPILOT_BASE_SHA: BASE_SHA,
        FORGEPILOT_API_HOST: "0.0.0.0",
      } as NodeJS.ProcessEnv),
    ).toThrow(/loopback/);
  });
});

describe("risk classification fails closed (QA round-1 blocker)", () => {
  test("a dependency-change task with acceptance criteria still requires approval", async () => {
    const { base } = await startApp([]);
    const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Upgrade the export dependency and change its data shape",
      acceptance_criteria: ["export still works", "no regression"],
    });
    expect(created.status).toBe(201);
    // A single acceptance criterion must NOT unlock the low-risk path.
    expect(created.body.risk?.class).toBe("elevated");
    expect(created.body.status).toBe("awaiting_approval");
    expect(created.body.risk?.requires_human_approval).toBe(true);
  });
});

describe("PI_UNAVAILABLE at approval (QA round-1 blocker)", () => {
  test("approving without a configured model fails closed with PI_UNAVAILABLE", async () => {
    const scripted = scriptedStream([]);
    const orchestrator = createOrchestrator({
      config: testConfig(),
      // no model → PI_UNAVAILABLE
      streamFn: scripted.streamFn,
    });
    apps.push(orchestrator);
    setAuthToken(orchestrator.apiToken);
    const { port } = await orchestrator.start();
    const base = `http://127.0.0.1:${port}`;

    const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Needs a model",
      acceptance_criteria: ["something verifiable"],
    });
    // Creating is allowed (fail-closed to elevated); the approval that would
    // start Pi is what fails.
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const required = (await timeline(base, taskId)).find(
      (event) => event.type === "approval.required",
    );
    const approved = await postJson<ApiErrorBody>(`${base}/api/v1/tasks/${taskId}/approvals`, {
      decision: "approve",
      scope_digest: String(required?.data["scope_digest"]),
    });
    expect(approved.status).toBe(503);
    expect(approved.body.error.code).toBe("PI_UNAVAILABLE");
  });
});
