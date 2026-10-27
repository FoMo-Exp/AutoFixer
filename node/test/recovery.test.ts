import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createOrchestrator } from "../src/index.js";
import type { OrchestratorHandle } from "../src/index.js";
import type { OrchestratorConfig } from "../src/config.js";
import type { ApiErrorBody } from "../src/api/errors.js";
import type { TaskResource, TimelineItem } from "../src/api/task-store.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import {
  getJson,
  postJson,
  readSse,
  readSseResult,
  setAuthToken,
  waitUntil,
} from "./helpers/http.js";
import type { ScriptedTurn } from "./helpers/scripted-stream.js";
import { scriptedStream, TEST_MODEL } from "./helpers/scripted-stream.js";

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

function baseConfig(stateFile: string): OrchestratorConfig {
  tokenDirCounter += 1;
  const tokenDir = mkdtempSync(path.join(tmpdir(), `forgepilot-recovery-${tokenDirCounter}-`));
  return {
    dshSocketPath: dsh.socketPath,
    apiHost: "127.0.0.1",
    apiPort: 0,
    apiTokenFile: path.join(tokenDir, "api-token"),
    taskStateFile: stateFile,
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
  };
}

/**
 * Start an orchestrator on the given durable state file. Passing the same
 * file twice simulates a process restart against the same projection.
 */
async function startApp(stateFile: string, turns: ScriptedTurn[]) {
  const scripted = scriptedStream(turns);
  const orchestrator = createOrchestrator({
    config: baseConfig(stateFile),
    model: TEST_MODEL,
    streamFn: scripted.streamFn,
  });
  apps.push(orchestrator);
  setAuthToken(orchestrator.apiToken);
  const { port } = await orchestrator.start();
  return { orchestrator, base: `http://127.0.0.1:${port}` };
}

async function timeline(base: string, taskId: string): Promise<TimelineItem[]> {
  const response = await getJson<{ items: TimelineItem[] }>(
    `${base}/api/v1/tasks/${taskId}/timeline`,
  );
  expect(response.status).toBe(200);
  return response.body.items;
}

async function createAndApprove(base: string): Promise<TaskResource> {
  const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
    repository_id: REPOSITORY_ID,
    base_ref: "main",
    summary: "Verify restart recovery",
    source_reference: "https://github.com/Luthiel/AutoFixer/issues/77",
    acceptance_criteria: ["recovery works"],
  });
  expect(created.status).toBe(201);
  const taskId = created.body.id;
  const required = (await timeline(base, taskId)).find(
    (event) => event.type === "approval.required",
  );
  const approved = await postJson<TaskResource>(`${base}/api/v1/tasks/${taskId}/approvals`, {
    decision: "approve",
    scope_digest: String(required?.data["scope_digest"]),
  });
  expect(approved.status).toBe(200);
  return { ...approved.body, id: taskId };
}

/** A brand-new state file in a private temp directory. */
function freshStateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "forgepilot-state-")), "task-state.json");
}

describe("restart recovery (M3 acceptance 1)", () => {
  test("a terminal task survives a restart byte-for-byte and replays cleanly", async () => {
    const stateFile = freshStateFile();
    // Run 1: an out-of-grant intent stops the task terminally.
    const first = await startApp(stateFile, [
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["secrets/keys.md"],
        rationale: "outside the grant",
      },
      { kind: "text", text: "Stopped." },
    ]);
    const task = await createAndApprove(first.base);
    await waitUntil(async () => {
      const current = await getJson<TaskResource>(`${first.base}/api/v1/tasks/${task.id}`);
      return current.body.status === "stopped";
    }, "task terminal before restart");
    const beforeEvents = await timeline(first.base, task.id);
    expect(beforeEvents.at(-1)?.type).toBe("task.terminal");
    // Shut the process down (afterEach) and restart on the same state file.
    await apps.pop()?.stop();

    const second = await startApp(stateFile, []);
    // The projection is restored exactly: same status, same events, no
    // duplicates, no renumbering, and recovery appended nothing.
    const restored = await getJson<TaskResource>(`${second.base}/api/v1/tasks/${task.id}`);
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("stopped");
    expect(restored.body.current_run_id).toBe(task.current_run_id);
    const afterEvents = await timeline(second.base, task.id);
    expect(afterEvents).toEqual(beforeEvents);

    // Full SSE replay after the restart ends at task.terminal, in sequence
    // order, with every business event exactly once.
    const frames = await readSse(`${second.base}/api/v1/tasks/${task.id}/stream`, {
      untilType: "task.terminal",
    });
    expect(frames.map((frame) => frame.data?.sequence)).toEqual(
      beforeEvents.map((event) => event.sequence),
    );
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(frames.length);
    expect(frames.at(-1)?.event).toBe("task.terminal");
  });

  test("a mid-run task re-associates with its dsh run and stays cancellable", async () => {
    const stateFile = freshStateFile();
    // Run 1: one accepted action, then a turn that never settles. Stopping the
    // orchestrator kills the Pi session while dsh still reports `running`.
    const first = await startApp(stateFile, [
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["node/recover.txt"],
        rationale: "accepted before the restart",
      },
      { kind: "hang" },
    ]);
    const task = await createAndApprove(first.base);
    await waitUntil(
      async () =>
        (await timeline(first.base, task.id)).some((event) => event.type === "tool.completed"),
      "action completed before the restart",
    );
    const beforeEvents = await timeline(first.base, task.id);
    await apps.pop()?.stop();

    // Run 2: same state file, fresh process, no Pi session for the old run.
    const second = await startApp(stateFile, []);
    const recovered = await getJson<TaskResource>(`${second.base}/api/v1/tasks/${task.id}`);
    expect(recovered.status).toBe(200);
    // dsh is the fact source: the run is still running, so the task is not
    // terminal, but the projection says why it is stalled.
    expect(recovered.body.status).toBe("executing");
    expect(recovered.body.status_reason).toContain("restart");
    expect(recovered.body.current_run_id).toBe(task.current_run_id);
    expect(recovered.body.progress.actions_completed).toBe(1);

    // The timeline keeps every pre-restart event unchanged; recovery only
    // appended the reason transition — no duplicates, no reordering.
    const afterEvents = await timeline(second.base, task.id);
    expect(afterEvents.slice(0, beforeEvents.length)).toEqual(beforeEvents);
    expect(afterEvents.map((event) => event.sequence)).toEqual(
      afterEvents.map((_, index) => index + 1),
    );
    expect(new Set(afterEvents.map((event) => event.event_id)).size).toBe(afterEvents.length);

    // SSE reconnect with a pre-restart Last-Event-ID resumes exactly after the
    // anchor: ordered, gap-free, and without repeating business events.
    const anchor = beforeEvents.at(-2)!;
    const resumed = await readSse(`${second.base}/api/v1/tasks/${task.id}/stream`, {
      lastEventId: anchor.event_id,
      timeoutMs: 2_000,
    });
    const resumedSequences = resumed.map((frame) => frame.data?.sequence ?? 0);
    expect(resumedSequences).toEqual(
      afterEvents.slice(anchor.sequence).map((event) => event.sequence),
    );

    // The recovered task is re-associated with dsh: cancelling through the
    // product API drives the real run to its terminal state.
    const runId = recovered.body.current_run_id;
    expect(typeof runId).toBe("string");
    const cancelled = await postJson<TaskResource>(
      `${second.base}/api/v1/tasks/${task.id}/cancel`,
      { reason: "operator cleaned up the recovered task" },
    );
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.status).toBe("cancelled");
    const run = await dsh.client.getRun(runId!);
    expect(run.state).toBe("cancelled");
  });

  test("an awaiting-approval task can still be approved after a restart", async () => {
    const stateFile = freshStateFile();
    const first = await startApp(stateFile, [{ kind: "text", text: "Done." }]);
    const created = await postJson<TaskResource>(`${first.base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Approve me after the restart",
      acceptance_criteria: ["approval survives"],
    });
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const beforeEvents = await timeline(first.base, taskId);
    await apps.pop()?.stop();

    const second = await startApp(stateFile, [{ kind: "text", text: "Done." }]);
    const restored = await getJson<TaskResource>(`${second.base}/api/v1/tasks/${taskId}`);
    expect(restored.body.status).toBe("awaiting_approval");
    // Recovery re-projected the unchanged dsh state without appending events.
    expect(await timeline(second.base, taskId)).toEqual(beforeEvents);

    const required = beforeEvents.find((event) => event.type === "approval.required");
    const approved = await postJson<TaskResource>(
      `${second.base}/api/v1/tasks/${taskId}/approvals`,
      { decision: "approve", scope_digest: String(required?.data["scope_digest"]) },
    );
    expect(approved.status).toBe(200);
    await waitUntil(
      async () =>
        (await timeline(second.base, taskId)).some((event) => event.type === "pi.turn_settled"),
      "Pi turn settled after restart-then-approve",
    );
  });

  test("a stream reconnect anchored at task.terminal closes instead of dangling (QA B1)", async () => {
    const stateFile = freshStateFile();
    const { base } = await startApp(stateFile, [
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["secrets/keys.md"],
        rationale: "outside the grant",
      },
      { kind: "text", text: "Stopped." },
    ]);
    const task = await createAndApprove(base);
    await waitUntil(async () => {
      const current = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
      return current.body.status === "stopped";
    }, "task terminal for the anchored reconnect");

    const events = await timeline(base, task.id);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("task.terminal");

    // A browser EventSource reconnects with Last-Event-ID set to the last
    // frame it saw — for a completed task that is the terminal event id.
    // The replay has nothing left to write; the server must still commit
    // headers and close rather than subscribe and hang forever.
    const anchored = await readSseResult(`${base}/api/v1/tasks/${task.id}/stream`, {
      lastEventId: terminal!.event_id,
      timeoutMs: 5_000,
    });
    expect(anchored.frames).toHaveLength(0);
    expect(anchored.closedByServer).toBe(true);

    // Same for an id anchored one frame before the terminal event: the
    // replay delivers the closing frame and closes.
    const beforeTerminal = events.at(-2)!;
    const tail = await readSseResult(`${base}/api/v1/tasks/${task.id}/stream`, {
      lastEventId: beforeTerminal.event_id,
      timeoutMs: 5_000,
    });
    expect(tail.frames.map((frame) => frame.event)).toEqual(["task.terminal"]);
    expect(tail.closedByServer).toBe(true);

    // And an unknown anchor replays the full history, ends at the closing
    // frame, and closes — the same guarantee for a fresh client.
    const full = await readSseResult(`${base}/api/v1/tasks/${task.id}/stream`, {
      timeoutMs: 5_000,
    });
    expect(full.frames.map((frame) => frame.event)).toEqual(events.map((e) => e.type));
    expect(full.closedByServer).toBe(true);
  });

  test("recovery heals a terminal record missing its closing frame, and its stream closes", async () => {
    const stateFile = freshStateFile();
    const { base } = await startApp(stateFile, [
      {
        kind: "tool",
        toolId: "echo",
        args: { message: "hello" },
        pathScope: ["secrets/keys.md"],
        rationale: "outside the grant",
      },
      { kind: "text", text: "Stopped." },
    ]);
    const task = await createAndApprove(base);
    await waitUntil(async () => {
      const current = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
      return current.body.status === "stopped";
    }, "task terminal before stripping the closing frame");
    await apps.pop()?.stop();

    // Simulate a damaged/hand-migrated projection: the record is terminal
    // but its task.terminal event was lost.
    const document = JSON.parse(readFileSync(stateFile, "utf8")) as {
      tasks: Array<{ id: string; events: Array<{ type: string }> }>;
    };
    const damaged = document.tasks.find((record) => record.id === task.id)!;
    damaged.events = damaged.events.filter((event) => event.type !== "task.terminal");
    writeFileSync(stateFile, JSON.stringify(document), "utf8");

    const second = await startApp(stateFile, []);
    // Recovery records the missing closing frame exactly once…
    const events = await timeline(second.base, task.id);
    expect(events.at(-1)?.type).toBe("task.terminal");
    expect(events.filter((event) => event.type === "task.terminal")).toHaveLength(1);
    // …and the stream for that healed task closes after its replay.
    const replay = await readSseResult(`${second.base}/api/v1/tasks/${task.id}/stream`, {
      timeoutMs: 5_000,
    });
    expect(replay.frames.at(-1)?.event).toBe("task.terminal");
    expect(replay.closedByServer).toBe(true);
  });

  test("recovery never fabricates a run dsh does not know", async () => {
    const stateFile = freshStateFile();
    const first = await startApp(stateFile, []);
    const created = await postJson<TaskResource>(`${first.base}/api/v1/tasks`, {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Vanishing run",
      acceptance_criteria: ["honesty"],
    });
    expect(created.status).toBe(201);
    const taskId = created.body.id;
    const runId = created.body.current_run_id;
    expect(typeof runId).toBe("string");
    await apps.pop()?.stop();

    // dsh restarted too (fresh server = no memory of the run): the recovered
    // task must surface that truth instead of keeping a phantom association.
    const freshDsh = await startDshServer({ approver: APPROVER });
    try {
      tokenDirCounter += 1;
      const tokenDir = mkdtempSync(path.join(tmpdir(), `forgepilot-recovery-${tokenDirCounter}-`));
      const scripted = scriptedStream([]);
      const orchestrator = createOrchestrator({
        config: {
          ...baseConfig(stateFile),
          dshSocketPath: freshDsh.socketPath,
          apiTokenFile: path.join(tokenDir, "api-token"),
        },
        model: TEST_MODEL,
        streamFn: scripted.streamFn,
      });
      apps.push(orchestrator);
      setAuthToken(orchestrator.apiToken);
      const { port } = await orchestrator.start();
      const base = `http://127.0.0.1:${port}`;

      const recovered = await getJson<TaskResource>(`${base}/api/v1/tasks/${taskId}`);
      // A run dsh no longer knows is projected stopped with a reason and one
      // terminal event — never left silently "running" on a phantom
      // association, and never with duplicate terminal frames.
      expect(recovered.body.status).toBe("stopped");
      const events = await timeline(base, taskId);
      expect(
        events.some(
          (event) => event.type === "task.status_changed" && event.data["to"] === "stopped",
        ),
      ).toBe(true);
      expect(
        events.filter(
          (event) => event.type === "task.terminal" && event.data["status"] === "stopped",
        ),
      ).toHaveLength(1);
    } finally {
      await freshDsh.stop();
    }
  });
});

describe("create idempotency (M3 acceptance 3)", () => {
  test("the same Idempotency-Key and payload return one task, not two runs", async () => {
    const { base } = await startApp(freshStateFile(), []);
    const body = {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Idempotent create",
      acceptance_criteria: ["one task"],
    };
    const headers = { "Idempotency-Key": "client-key-1" };
    const first = await postJson<TaskResource>(`${base}/api/v1/tasks`, body, headers);
    const second = await postJson<TaskResource>(`${base}/api/v1/tasks`, body, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.current_run_id).toBe(first.body.current_run_id);

    const list = await getJson<{ items: TaskResource[] }>(`${base}/api/v1/tasks`);
    expect(
      list.body.items.filter((item) => item.request.summary === "Idempotent create"),
    ).toHaveLength(1);
  });

  test("concurrent creates with one key join a single run", async () => {
    const { base } = await startApp(freshStateFile(), []);
    const body = {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Concurrent idempotent create",
      acceptance_criteria: ["still one task"],
    };
    const headers = { "Idempotency-Key": "client-key-race" };
    const [a, b] = await Promise.all([
      postJson<TaskResource>(`${base}/api/v1/tasks`, body, headers),
      postJson<TaskResource>(`${base}/api/v1/tasks`, body, headers),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect(a.body.current_run_id).toBe(b.body.current_run_id);
  });

  test("the same key with a different payload is 409 IDEMPOTENCY_CONFLICT", async () => {
    const { base } = await startApp(freshStateFile(), []);
    const headers = { "Idempotency-Key": "client-key-conflict" };
    const first = await postJson<TaskResource>(
      `${base}/api/v1/tasks`,
      {
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "Original payload",
        acceptance_criteria: ["a"],
      },
      headers,
    );
    expect(first.status).toBe(201);
    const conflicting = await postJson<ApiErrorBody>(
      `${base}/api/v1/tasks`,
      {
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "Different payload",
        acceptance_criteria: ["b"],
      },
      headers,
    );
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("an idempotency key survives a restart: the replay returns the original task", async () => {
    const stateFile = freshStateFile();
    const first = await startApp(stateFile, []);
    const body = {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "Replay across restart",
      acceptance_criteria: ["durable key"],
    };
    const headers = { "Idempotency-Key": "client-key-durable" };
    const created = await postJson<TaskResource>(`${first.base}/api/v1/tasks`, body, headers);
    expect(created.status).toBe(201);
    await apps.pop()?.stop();

    const second = await startApp(stateFile, []);
    const replayed = await postJson<TaskResource>(`${second.base}/api/v1/tasks`, body, headers);
    expect(replayed.status).toBe(201);
    expect(replayed.body.id).toBe(created.body.id);

    const conflicting = await postJson<ApiErrorBody>(
      `${second.base}/api/v1/tasks`,
      { ...body, summary: "Different after restart" },
      headers,
    );
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("an Idempotency-Key longer than 256 characters is rejected with 400", async () => {
    const { base } = await startApp(freshStateFile(), []);
    const response = await postJson<ApiErrorBody>(
      `${base}/api/v1/tasks`,
      {
        repository_id: REPOSITORY_ID,
        base_ref: "main",
        summary: "Overlong key",
        acceptance_criteria: ["bounded"],
      },
      { "Idempotency-Key": "k".repeat(257) },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_REQUEST");
  });

  test("without a key every create is a new task", async () => {
    const { base } = await startApp(freshStateFile(), []);
    const body = {
      repository_id: REPOSITORY_ID,
      base_ref: "main",
      summary: "No key at all",
      acceptance_criteria: ["distinct tasks"],
    };
    const first = await postJson<TaskResource>(`${base}/api/v1/tasks`, body);
    const second = await postJson<TaskResource>(`${base}/api/v1/tasks`, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.current_run_id).not.toBe(first.body.current_run_id);
  });
});
