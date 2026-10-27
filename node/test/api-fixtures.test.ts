import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createOrchestrator } from "../src/index.js";
import type { OrchestratorHandle } from "../src/index.js";
import type { OrchestratorConfig } from "../src/config.js";
import type { TaskResource, TimelineItem } from "../src/api/task-store.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { getJson, postJson, setAuthToken, waitUntil } from "./helpers/http.js";
import { scriptedStream, TEST_MODEL } from "./helpers/scripted-stream.js";
import type { ScriptedTurn } from "./helpers/scripted-stream.js";

/**
 * Real-response golden fixtures for the safe Pi summary contract (DAT-191).
 *
 * These are captured from a live orchestrator + the real Go dsh control
 * plane, exactly like the client-facing API returns them, then normalized
 * only where the response is inherently volatile (random ids, timestamps).
 * DAT-189-style clients must be able to build UI fixtures from these files
 * without standing up the stack.
 *
 * Regenerate with: FORGEPILOT_UPDATE_FIXTURES=1 npm test
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "forgepilot-api-v1");

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

function testConfig(): OrchestratorConfig {
  tokenDirCounter += 1;
  const tokenDir = mkdtempSync(path.join(tmpdir(), `forgepilot-fixture-${tokenDirCounter}-`));
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
    toolCapabilities: ["echo"],
    maxWallClockSeconds: 60,
  };
}

async function startApp(turns: ScriptedTurn[]): Promise<string> {
  const scripted = scriptedStream(turns);
  const orchestrator = createOrchestrator({
    config: testConfig(),
    model: TEST_MODEL,
    streamFn: scripted.streamFn,
  });
  apps.push(orchestrator);
  setAuthToken(orchestrator.apiToken);
  const { port } = await orchestrator.start();
  return `http://127.0.0.1:${port}`;
}

async function createApprovedTask(base: string): Promise<TaskResource> {
  const created = await postJson<TaskResource>(`${base}/api/v1/tasks`, {
    repository_id: REPOSITORY_ID,
    base_ref: "main",
    summary: "Verify the echo tool works",
    source_reference: "https://github.com/Luthiel/AutoFixer/issues/42",
    acceptance_criteria: ["echo prints hello"],
  });
  expect(created.status).toBe(201);
  // See integration.test.ts: approved_at is millisecond-truncated while dsh
  // stamps creation with microseconds; pacing the approval keeps the window
  // check deterministic (DSH_APPROVAL_WINDOW_EXPIRED).
  await new Promise((resolve) => setTimeout(resolve, 5));
  const timeline = await getJson<{ items: TimelineItem[] }>(
    `${base}/api/v1/tasks/${created.body.id}/timeline`,
  );
  const required = timeline.body.items.find((event) => event.type === "approval.required");
  const approved = await postJson<TaskResource>(
    `${base}/api/v1/tasks/${created.body.id}/approvals`,
    {
      decision: "approve",
      scope_digest: String(required?.data["scope_digest"]),
    },
  );
  expect(approved.status).toBe(200);
  return approved.body;
}

const VOLATILE_ID = /\b(?:tsk|run|evt|req|pis|apr|act)_[0-9a-f]{8,}\b/g;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/**
 * Normalize one real response: map every volatile identifier to a stable
 * placeholder (first-encounter order) and freeze timestamps. Everything else
 * — fields, enums, texts, ordering — stays byte-identical to the live
 * response.
 */
function normalizeResponse(value: unknown): unknown {
  const placeholders = new Map<string, string>();
  const seen = new Map<string, number>();
  const replaceIds = (raw: string): string =>
    raw.replace(VOLATILE_ID, (id) => {
      const prefix = id.split("_")[0] ?? "id";
      let placeholder = placeholders.get(id);
      if (placeholder === undefined) {
        const next = (seen.get(prefix) ?? 0) + 1;
        seen.set(prefix, next);
        placeholder = `${prefix}_${String(next).padStart(32, "0")}`;
        placeholders.set(id, placeholder);
      }
      return placeholder;
    });
  const walk = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      return replaceIds(entry).replace(ISO_TIMESTAMP, "2099-01-01T00:00:00.000Z");
    }
    if (Array.isArray(entry)) {
      return entry.map(walk);
    }
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, item]) => [key, walk(item)]),
      );
    }
    return entry;
  };
  return walk(value);
}

function checkFixture(name: string, payload: unknown): void {
  const normalized = normalizeResponse(payload);
  const encoded = `${JSON.stringify(normalized, null, 2)}\n`;
  const fixturePath = path.join(fixtureDir, name);
  if (process.env["FORGEPILOT_UPDATE_FIXTURES"] === "1") {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixturePath, encoded, "utf8");
    return;
  }
  expect(
    readFileSync(fixturePath, "utf8"),
    `fixture ${name} diverged from the live response (regenerate with FORGEPILOT_UPDATE_FIXTURES=1)`,
  ).toBe(encoded);
}

describe("real-response fixtures for pi_summary (DAT-191)", () => {
  test("an available summary round-trips as a frozen live response", async () => {
    const benignText = "Checked the echo tool and confirmed it prints hello.";
    const base = await startApp([{ kind: "text", text: benignText }]);
    const task = await createApprovedTask(base);
    // Wait for the full settled projection (summary + the refresh-projected
    // phase) so the captured response is deterministic, not mid-transition.
    await waitUntil(async () => {
      const current = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
      return (
        current.body.pi_summary?.status === "available" &&
        current.body.progress.phase === "validating"
      );
    }, "summary available and projection settled");

    const resource = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
    expect(resource.body.pi_summary?.text).toBe(benignText);
    checkFixture("task-pi-summary-available.json", resource.body);

    const events = await getJson<{ items: TimelineItem[] }>(
      `${base}/api/v1/tasks/${task.id}/timeline`,
    );
    const summaryEvents = events.body.items.filter((event) => event.type === "pi.summary.updated");
    expect(summaryEvents).toHaveLength(2);
    checkFixture("pi-summary-events-available.json", summaryEvents);
  });

  test("an unavailable summary round-trips without its raw content", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwx123456";
    const base = await startApp([
      { kind: "text", text: `The credential ${secret} was exposed during the run.` },
    ]);
    const task = await createApprovedTask(base);
    await waitUntil(async () => {
      const current = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
      return (
        current.body.pi_summary?.status === "unavailable" &&
        current.body.progress.phase === "validating"
      );
    }, "summary unavailable and projection settled");

    const resource = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
    expect(resource.body.pi_summary).toMatchObject({
      status: "unavailable",
      text: null,
      unavailable_reason: "unsafe_content",
    });
    expect(JSON.stringify(resource.body.pi_summary)).not.toContain(secret);
    checkFixture("task-pi-summary-unavailable.json", resource.body);
  });

  test("a command-shaped turn round-trips as an unavailable real response", async () => {
    const command = "cat package.json";
    const base = await startApp([
      { kind: "text", text: "I ran cat package.json to inspect the manifest." },
    ]);
    const task = await createApprovedTask(base);
    await waitUntil(async () => {
      const current = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
      return (
        current.body.pi_summary?.status === "unavailable" &&
        current.body.progress.phase === "validating"
      );
    }, "summary unavailable and projection settled");

    const resource = await getJson<TaskResource>(`${base}/api/v1/tasks/${task.id}`);
    expect(resource.body.pi_summary).toMatchObject({
      status: "unavailable",
      text: null,
      unavailable_reason: "unsafe_content",
    });
    expect(JSON.stringify(resource.body.pi_summary)).not.toContain(command);
    checkFixture("task-pi-summary-unavailable-command.json", resource.body);
  });
});
