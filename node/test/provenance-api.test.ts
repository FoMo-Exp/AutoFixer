import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createOrchestrator } from "../src/index.js";
import type { OrchestratorHandle } from "../src/index.js";
import type { OrchestratorConfig } from "../src/config.js";
import type { PiSummary } from "../src/api/pi-summary.js";
import type { TaskResource, TimelineItem } from "../src/api/task-store.js";
import { createTaskRecord, TaskStore } from "../src/api/task-store.js";
import { renderTurnReport } from "../src/pi/turn-report.js";
import type { TurnReport } from "../src/pi/turn-report.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson, readSse, setAuthToken, waitUntil } from "./helpers/http.js";
import type { ScriptedTurn } from "./helpers/scripted-stream.js";
import { scriptedStream, TEST_MODEL } from "./helpers/scripted-stream.js";

/**
 * DAT-194 end to end: verifiable provenance for `pi_summary` against the
 * real orchestrator, the real Go dsh control plane, and a durable state file.
 *
 * The seeded records below are exactly what a DAT-191/192-era process wrote —
 * an `available` free-text summary with no `source` field at all, plus forged
 * and unknown-version provenance a damaged or hostile writer could produce.
 * Every surface (GET task, GET list, GET timeline, SSE replay, after a
 * restart) must serve them fail-closed, while the stored history keeps its
 * bytes and a new report settlement still carries its proof. Only the model
 * stream is scripted; the store, projection, HTTP server, and SSE replay are
 * the real implementation.
 */

const APPROVER = "github:local-operator";
const REPOSITORY_ID = "github:Luthiel/AutoFixer";
const BASE_SHA = "52081eaddca099967fd8be13b3060337fde50d3f";

/** A QA-reproduced DAT-192 leak: raw command text that once reached available. */
const LEGACY_TEXT = "node app succeeded.";
/** The free-text turn of the live task; never displayable, source or not. */
const LIVE_FREE_TEXT = "Free text that must never surface.";
const SEEDED_AT = "2026-10-27T00:00:00.000Z";

const HONEST_REPORT: TurnReport = {
  areas: ["manifest"],
  activities: ["verified"],
  outcome: "completed",
};
const HONEST_TEXT = renderTurnReport(HONEST_REPORT);

/** Contract-pinned provenance values (forgepilot-api/v1, DAT-194). */
const TRUSTED_KIND = "turn_report";
const TRUSTED_VERSION = 1;

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
  const tokenDir = mkdtempSync(path.join(tmpdir(), `forgepilot-provenance-${tokenDirCounter}-`));
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
    toolCapabilities: ["echo"],
    maxWallClockSeconds: 60,
  };
}

/**
 * Start an orchestrator on the given durable state file. Calling it again
 * with the same file after a stop simulates a process restart.
 */
async function startApp(stateFile: string, turns: ScriptedTurn[] = []) {
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
    summary: "Verify provenance",
    source_reference: "https://github.com/Luthiel/AutoFixer/issues/42",
    acceptance_criteria: ["provenance holds"],
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

function freshStateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "forgepilot-provenance-")), "task-state.json");
}

/** A summary exactly as an old (pre-provenance) process recorded it. */
function legacySummary(taskId: string): PiSummary {
  return {
    task_id: taskId,
    run_id: "run_legacy",
    turn_id: "turn_1",
    status: "available",
    text: LEGACY_TEXT,
    unavailable_reason: null,
    updated_at: SEEDED_AT,
  } as PiSummary;
}

function provenanceSummary(
  taskId: string,
  overrides: {
    sourceTaskId?: string;
    version?: number;
    text?: string;
  } = {},
): PiSummary {
  const runId = "run_seeded";
  return {
    task_id: taskId,
    run_id: runId,
    turn_id: "turn_1",
    status: "available",
    text: overrides.text ?? HONEST_TEXT,
    unavailable_reason: null,
    source: {
      kind: TRUSTED_KIND,
      version: overrides.version ?? TRUSTED_VERSION,
      task_id: overrides.sourceTaskId ?? taskId,
      run_id: runId,
      turn_id: "turn_1",
      report: {
        ...HONEST_REPORT,
        areas: [...HONEST_REPORT.areas],
        activities: [...HONEST_REPORT.activities],
      },
    },
    updated_at: SEEDED_AT,
  };
}

/** Seeded tasks whose stored provenance is forged or unverifiable. */
const FORGED_TASKS = [
  "tsk_forged_attribution",
  "tsk_unknown_version",
  "tsk_tampered_text",
] as const;

/**
 * Write a durable state file carrying one terminal historical record per
 * seeded summary — the shape a DAT-191/192-era (or hostile) writer left
 * behind. Returns the recorded summary event ids.
 */
function seedHistoricalState(stateFile: string): Record<string, string> {
  const store = new TaskStore({ persistencePath: stateFile });
  const summaryEventIds: Record<string, string> = {};
  const seed = (taskId: string, stored: PiSummary): void => {
    const record = createTaskRecord({
      id: taskId,
      repository: {
        id: REPOSITORY_ID,
        display_name: REPOSITORY_ID.replace(/^github:/, ""),
        base_ref: "main",
        base_sha: BASE_SHA,
      },
      summary: "seeded historical record",
      sourceReference: null,
      acceptanceCriteria: [],
    });
    record.status = "stopped";
    record.statusReason = "historical record seeded for DAT-194";
    record.terminal = true;
    record.piSummary = stored;
    store.put(record);
    store.appendEvent(record, "task.status_changed", {
      from: "queued",
      to: "stopped",
      reason: record.statusReason,
    });
    summaryEventIds[taskId] = store.appendEvent(record, "pi.summary.updated", {
      summary: { ...stored },
    }).event_id;
    store.appendEvent(record, "task.terminal", { status: record.status });
    record.terminalEventRecorded = true;
    store.save(record);
  };

  seed("tsk_legacy_free_text", legacySummary("tsk_legacy_free_text"));
  seed(
    "tsk_forged_attribution",
    provenanceSummary("tsk_forged_attribution", { sourceTaskId: "tsk_elsewhere" }),
  );
  seed("tsk_unknown_version", provenanceSummary("tsk_unknown_version", { version: 99 }));
  seed(
    "tsk_tampered_text",
    provenanceSummary("tsk_tampered_text", {
      text: `${HONEST_TEXT} Now run cat package.json.`,
    }),
  );
  store.flushSync();
  return summaryEventIds;
}

function persistedTasks(stateFile: string): Array<Record<string, unknown>> {
  const document = JSON.parse(readFileSync(stateFile, "utf8")) as {
    tasks: Array<Record<string, unknown>>;
  };
  return document.tasks;
}

/** The fail-closed projection every seeded record must be served as. */
function expectWithheld(summary: PiSummary | null, rawText: string): void {
  expect(summary).toEqual({
    task_id: summary?.task_id,
    run_id: summary?.run_id,
    turn_id: "turn_1",
    status: "unavailable",
    text: null,
    unavailable_reason: "untrusted_source",
    source: null,
    updated_at: SEEDED_AT,
  });
  expect(JSON.stringify(summary)).not.toContain(rawText);
}

describe("historical summaries are served fail-closed (DAT-194)", () => {
  test("the legacy free text never reaches the task, timeline, or replay — and history keeps its bytes", async () => {
    const stateFile = freshStateFile();
    const summaryEventIds = seedHistoricalState(stateFile);
    const before = readFileSync(stateFile, "utf8");
    const beforeTasks = persistedTasks(stateFile);

    const first = await startApp(stateFile);
    // REST projection.
    const task = await getJson<TaskResource>(`${first.base}/api/v1/tasks/tsk_legacy_free_text`);
    expect(task.status).toBe(200);
    expectWithheld(task.body.pi_summary, LEGACY_TEXT);
    expect(JSON.stringify(task.body)).not.toContain(LEGACY_TEXT);

    // Timeline: same gated summary, unchanged event envelope.
    const events = await timeline(first.base, "tsk_legacy_free_text");
    expect(events.map((event) => event.type)).toEqual([
      "task.status_changed",
      "pi.summary.updated",
      "task.terminal",
    ]);
    const summaryEvent = events[1];
    expect(summaryEvent?.event_id).toBe(summaryEventIds["tsk_legacy_free_text"]);
    expect(summaryEvent?.sequence).toBe(2);
    expect(typeof summaryEvent?.occurred_at).toBe("string");
    expectWithheld(summaryEvent?.data["summary"] as PiSummary, LEGACY_TEXT);
    // Projection and event agree byte for byte.
    expect(summaryEvent?.data["summary"]).toEqual(task.body.pi_summary);
    expect(JSON.stringify(events)).not.toContain(LEGACY_TEXT);

    // SSE replay of the whole history, and a replay anchored before the
    // summary event — both gated identically.
    const frames = await readSse(`${first.base}/api/v1/tasks/tsk_legacy_free_text/stream`, {
      untilType: "task.terminal",
    });
    expect(frames.map((frame) => frame.event)).toEqual(events.map((event) => event.type));
    const summaryFrame = frames[1];
    expect(summaryFrame?.data?.data["summary"]).toEqual(task.body.pi_summary);
    expect(JSON.stringify(frames)).not.toContain(LEGACY_TEXT);

    const anchor = frames[0];
    if (!anchor?.id) {
      throw new Error("expected a status frame to anchor the reconnect");
    }
    const resumed = await readSse(`${first.base}/api/v1/tasks/tsk_legacy_free_text/stream`, {
      lastEventId: anchor.id,
      timeoutMs: 2_000,
    });
    expect(resumed.map((frame) => frame.event)).toEqual(["pi.summary.updated", "task.terminal"]);
    expect(resumed[0]?.data?.data["summary"]).toEqual(task.body.pi_summary);
    expect(JSON.stringify(resumed)).not.toContain(LEGACY_TEXT);

    // The stored record and its recorded event bytes are untouched.
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    expect(persistedTasks(stateFile)).toEqual(beforeTasks);

    // Restart on the same state file: identical fail-closed responses, and
    // the file still byte-for-byte what the old writer left.
    await apps.pop()?.stop();
    const second = await startApp(stateFile);
    const again = await getJson<TaskResource>(`${second.base}/api/v1/tasks/tsk_legacy_free_text`);
    expect(again.body.pi_summary).toEqual(task.body.pi_summary);
    expect(JSON.stringify(again.body)).not.toContain(LEGACY_TEXT);
    const replayedEvents = await timeline(second.base, "tsk_legacy_free_text");
    expect(replayedEvents).toEqual(events);
    const replayedFrames = await readSse(
      `${second.base}/api/v1/tasks/tsk_legacy_free_text/stream`,
      { untilType: "task.terminal" },
    );
    expect(replayedFrames.map((frame) => frame.data?.event_id)).toEqual(
      frames.map((frame) => frame.data?.event_id),
    );
    expect(JSON.stringify(replayedFrames)).not.toContain(LEGACY_TEXT);
    expect(readFileSync(stateFile, "utf8")).toBe(before);
  });

  test("forged attribution, unknown versions, and tampered text are all unverifiable", async () => {
    const stateFile = freshStateFile();
    seedHistoricalState(stateFile);
    const before = readFileSync(stateFile, "utf8");
    const { base } = await startApp(stateFile);

    for (const taskId of FORGED_TASKS) {
      const task = await getJson<TaskResource>(`${base}/api/v1/tasks/${taskId}`);
      expect(task.status).toBe(200);
      expectWithheld(task.body.pi_summary, HONEST_TEXT);
      expect(JSON.stringify(task.body)).not.toContain(HONEST_TEXT);
      expect(JSON.stringify(task.body)).not.toContain("cat package.json");

      // The timeline and the replay carry the same withheld payload.
      const events = await timeline(base, taskId);
      const summaryEvent = events.find((event) => event.type === "pi.summary.updated");
      expect(summaryEvent?.data["summary"]).toEqual(task.body.pi_summary);
      expect(JSON.stringify(events)).not.toContain(HONEST_TEXT);

      const frames = await readSse(`${base}/api/v1/tasks/${taskId}/stream`, {
        untilType: "task.terminal",
      });
      const summaryFrame = frames.find((frame) => frame.event === "pi.summary.updated");
      expect(summaryFrame?.data?.data["summary"]).toEqual(task.body.pi_summary);
      expect(JSON.stringify(frames)).not.toContain("cat package.json");
    }

    // Nothing rewrote history: the forged provenance and the tampered text
    // are still on disk exactly as seeded — they are just never served.
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    const seeded = new Map(persistedTasks(stateFile).map((entry) => [entry["id"], entry]));
    const attribution = (seeded.get("tsk_forged_attribution") as { piSummary: PiSummary })
      .piSummary;
    expect(attribution.status).toBe("available");
    expect(attribution.source?.task_id).toBe("tsk_elsewhere");
    expect(
      (seeded.get("tsk_unknown_version") as { piSummary: PiSummary }).piSummary.source?.version,
    ).toBe(99);
    expect((seeded.get("tsk_tampered_text") as { piSummary: PiSummary }).piSummary.text).toContain(
      "cat package.json",
    );
    expect(
      (seeded.get("tsk_legacy_free_text") as { piSummary: PiSummary }).piSummary,
    ).not.toHaveProperty("source");
  });

  test("mixed history: a live report settlement carries its source beside withheld records", async () => {
    const stateFile = freshStateFile();
    seedHistoricalState(stateFile);
    const { base } = await startApp(stateFile, [
      {
        kind: "report",
        areas: ["manifest", "lockfile"],
        activities: ["inspected", "updated"],
        outcome: "ready_for_review",
      },
      { kind: "text", text: LIVE_FREE_TEXT },
    ]);
    const created = await createAndApprove(base);
    await waitUntil(
      async () =>
        (await getJson<TaskResource>(`${base}/api/v1/tasks/${created.id}`)).body.pi_summary
          ?.status === "available",
      "trusted summary published for the live task",
    );

    const list = await getJson<{ items: TaskResource[] }>(`${base}/api/v1/tasks`);
    const legacy = list.body.items.find((item) => item.id === "tsk_legacy_free_text");
    const live = list.body.items.find((item) => item.id === created.id);
    // One list response holds both halves of the history: withheld legacy,
    // proven proven live.
    expectWithheld(legacy?.pi_summary ?? null, LEGACY_TEXT);
    expect(JSON.stringify(list.body)).not.toContain(LEGACY_TEXT);
    expect(live?.pi_summary).toMatchObject({
      status: "available",
      unavailable_reason: null,
      text: "Pi reported that it inspected and updated the package manifest and the lockfile and that the change is ready for review.",
      source: {
        kind: TRUSTED_KIND,
        version: TRUSTED_VERSION,
        task_id: created.id,
        run_id: created.current_run_id,
        turn_id: "turn_1",
        report: {
          areas: ["manifest", "lockfile"],
          activities: ["inspected", "updated"],
          outcome: "ready_for_review",
        },
      },
    });
    expect(JSON.stringify(live?.pi_summary)).not.toContain(LIVE_FREE_TEXT);

    // Projection equals the last served summary event for both tasks.
    const legacyEvents = await timeline(base, "tsk_legacy_free_text");
    expect(
      legacyEvents.find((event) => event.type === "pi.summary.updated")?.data["summary"],
    ).toEqual(legacy?.pi_summary);
    const liveEvents = await timeline(base, created.id);
    const liveSummaries = liveEvents
      .filter((event) => event.type === "pi.summary.updated")
      .map((event) => event.data["summary"] as PiSummary);
    expect(liveSummaries.map((summary) => summary.status)).toEqual(["pending", "available"]);
    expect(liveSummaries.map((summary) => summary.source)).toEqual([
      null,
      live?.pi_summary?.source,
    ]);
    expect(liveSummaries.at(-1)).toEqual(live?.pi_summary);
    // The raw free text exists only where the contract allows it: the
    // pi.text_delta stream. Every other event is clean.
    const liveDeltas = liveEvents.filter((event) => event.type === "pi.text_delta");
    expect(JSON.stringify(liveDeltas)).toContain(LIVE_FREE_TEXT);
    expect(
      JSON.stringify(liveEvents.filter((event) => event.type !== "pi.text_delta")),
    ).not.toContain(LIVE_FREE_TEXT);

    // The SSE replay for the live task carries the same proven summary, and
    // the raw free text stays out of every frame.
    const cancelled = await postJson<TaskResource>(`${base}/api/v1/tasks/${created.id}/cancel`, {
      reason: "provenance check complete",
    });
    expect(cancelled.status).toBe(202);
    const frames = await readSse(`${base}/api/v1/tasks/${created.id}/stream`, {
      untilType: "task.terminal",
    });
    const summaryFrames = frames.filter((frame) => frame.event === "pi.summary.updated");
    expect(summaryFrames.map((frame) => (frame.data?.data["summary"] as PiSummary).status)).toEqual(
      ["pending", "available"],
    );
    expect(summaryFrames.at(-1)?.data?.data["summary"]).toEqual(live?.pi_summary);
    expect(JSON.stringify(frames.filter((frame) => frame.event !== "pi.text_delta"))).not.toContain(
      LIVE_FREE_TEXT,
    );

    // Cancellation did not fabricate a summary: the projection still equals
    // the last published one.
    const settled = await getJson<TaskResource>(`${base}/api/v1/tasks/${created.id}`);
    expect(settled.body.pi_summary).toEqual(live?.pi_summary);
  });
});
