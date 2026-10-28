/* global fetch, AbortController, TextDecoder, queueMicrotask */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { clearTimeout as clearTimer, setTimeout as setTimer } from "node:timers";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "forgepilot-electron-window-"));
const electronArchive = process.env["ELECTRON_ARCHIVE"];
if (electronArchive) {
  try {
    execFileSync("unzip", ["-q", electronArchive, "-d", tempDir], { stdio: "pipe" });
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
const electronCommand =
  process.env["ELECTRON_BINARY"] ||
  (electronArchive
    ? path.join(
        tempDir,
        process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
      )
    : path.join(webRoot, "node_modules", ".bin", "electron"));
const mainEntry = path.join(webRoot, "dist-electron", "main.js");
const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
let dsh;
let nodeService;

try {
  const dshBinary = path.join(tempDir, "autofixer-dsh");
  execFileSync("go", ["build", "-o", dshBinary, "./cmd/autofixer"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const socketPath = path.join(tempDir, "dsh-control.sock");
  const workspaceRoot = path.join(tempDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  dsh = spawn(
    dshBinary,
    [
      "dsh",
      "serve",
      "--socket",
      socketPath,
      "--approver",
      "github:local-operator",
      "--workspace-root",
      workspaceRoot,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const dshErrors = [];
  dsh.stderr.on("data", (chunk) => dshErrors.push(chunk.toString("utf8")));

  const { DshClient } = await import(
    pathToFileURL(path.join(repoRoot, "node", "dist", "src", "dsh", "client.js")).href
  );
  const dshClient = new DshClient({ socketPath });
  await waitForDsh(dsh, dshClient, dshErrors);

  const tokenFile = path.join(tempDir, "api-token");
  const serviceEnv = {
    ...process.env,
    FORGEPILOT_BASE_SHA: baseSha,
    FORGEPILOT_REPOSITORY_ID: "github:Luthiel/AutoFixer",
    FORGEPILOT_DSH_SOCKET: socketPath,
    FORGEPILOT_API_TOKEN_FILE: tokenFile,
    FORGEPILOT_TASK_STATE_FILE: path.join(tempDir, "task-state.json"),
    FORGEPILOT_NODE_ENTRY: path.join(repoRoot, "node", "dist", "src", "index.js"),
    FORGEPILOT_NODE_WORKDIR: path.join(repoRoot, "node"),
    FORGEPILOT_NODE_EXECUTABLE: process.execPath,
    FORGEPILOT_API_HOST: "127.0.0.1",
  };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
    "FORGEPILOT_API_STARTUP_ERROR",
  ]) {
    delete serviceEnv[name];
  }

  const { discoverNodeService } = await import(
    pathToFileURL(path.join(webRoot, "dist-electron", "service-discovery.js")).href
  );
  nodeService = await discoverNodeService(serviceEnv);
  if (!nodeService.apiBaseUrl || !nodeService.apiTokenFile) {
    throw new Error("The real Node service did not publish its API URL and token file.");
  }

  await runElectron({
    ...serviceEnv,
    FORGEPILOT_API_URL: nodeService.apiBaseUrl,
    FORGEPILOT_API_TOKEN_FILE: nodeService.apiTokenFile,
    FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1",
  });
  process.stdout.write("Real Electron window + Node REST/SSE smoke passed.\n");

  // Stop the externally started service so the next mode proves the main
  // process launches Node itself and discovers the URL it publishes.
  await stopChild(nodeService?.child);
  nodeService = undefined;

  const selfStartEnv = {
    ...serviceEnv,
    FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1",
    FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY: "1",
  };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
  ]) {
    delete selfStartEnv[name];
  }
  await runElectron(selfStartEnv);
  process.stdout.write("Electron self-start + Node REST/SSE smoke passed.\n");

  // A checkout without a built Node entrypoint must explain the remediation.
  const unbuiltEnv = {
    ...serviceEnv,
    FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1",
    FORGEPILOT_NODE_ENTRY: path.join(tempDir, "missing", "index.js"),
    FORGEPILOT_ELECTRON_EXPECTED_GUIDANCE: "cd node && npm run build",
  };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
  ]) {
    delete unbuiltEnv[name];
  }
  await runElectron(unbuiltEnv);
  process.stdout.write("Unbuilt Node entrypoint guidance smoke passed.\n");

  const startupEnv = { ...serviceEnv, FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1" };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
    "FORGEPILOT_API_TOKEN_FILE",
    "FORGEPILOT_BASE_SHA",
    "FORGEPILOT_NODE_ENTRY",
    "FORGEPILOT_NODE_WORKDIR",
  ]) {
    delete startupEnv[name];
  }
  await runElectron(startupEnv);
  process.stdout.write("Default-startup configuration guidance smoke passed.\n");

  // Real Pi summaries through the test-only scripted provider. The real
  // orchestrator, summary gate, REST API, SSE replay and Electron window run
  // unchanged: only inference is replaced through the existing
  // createOrchestrator({ model, streamFn }) test seam. No production debug
  // endpoint, network transfer, or credential is involved.
  const { createOrchestrator, configFromEnv } = await import(
    pathToFileURL(path.join(repoRoot, "node", "dist", "src", "index.js")).href
  );
  const { createAssistantMessageEventStream } = await import(
    pathToFileURL(
      path.join(repoRoot, "node", "node_modules", "@mariozechner", "pi-ai", "dist", "index.js"),
    ).href
  );
  const scriptedModel = {
    id: "scripted",
    name: "scripted",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "",
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  const assistantBase = () => ({
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "scripted",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  });
  const emitText = (stream, text) => {
    const content = [{ type: "text", text }];
    stream.push({
      type: "start",
      partial: { ...assistantBase(), content: [], stopReason: "stop" },
    });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...assistantBase(), content, stopReason: "stop" },
    });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: { ...assistantBase(), content, stopReason: "stop" },
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial: { ...assistantBase(), content, stopReason: "stop" },
    });
    stream.push({
      type: "done",
      reason: "stop",
      message: { ...assistantBase(), content, stopReason: "stop" },
    });
  };
  const emitReportCall = (stream, report, callIndex) => {
    const toolCall = {
      type: "toolCall",
      id: `call_${callIndex}`,
      name: "report_turn_summary",
      arguments: report,
    };
    const content = [toolCall];
    const partial = { ...assistantBase(), content, stopReason: "toolUse" };
    stream.push({
      type: "start",
      partial: { ...assistantBase(), content: [], stopReason: "toolUse" },
    });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    stream.push({
      type: "done",
      reason: "toolUse",
      message: { ...assistantBase(), content, stopReason: "toolUse" },
    });
  };
  const scriptedTurns = (turns) => {
    let index = 0;
    return () => {
      const stream = createAssistantMessageEventStream();
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      queueMicrotask(() => {
        if (turn.kind === "report") {
          emitReportCall(stream, turn.report, index);
          return;
        }
        emitText(stream, turn.text);
      });
      return stream;
    };
  };

  const reportTurn = {
    kind: "report",
    report: {
      areas: ["manifest", "lockfile"],
      activities: ["inspected", "updated"],
      outcome: "ready_for_review",
    },
  };
  const renderedReport =
    "Pi reported that it inspected and updated the package manifest and the lockfile and that the change is ready for review.";
  const withheldFreeText = "The team used poetry lock to pin versions.";

  const startScriptedOrchestrator = async (stateFile, turns) => {
    const config = configFromEnv({
      ...serviceEnv,
      FORGEPILOT_TASK_STATE_FILE: path.join(tempDir, stateFile),
    });
    const orchestrator = createOrchestrator({
      config,
      model: scriptedModel,
      streamFn: scriptedTurns(turns),
    });
    const { host, port } = await orchestrator.start();
    return { orchestrator, base: `http://${host}:${port}` };
  };

  // Trusted path: a validated structured report settles `available` with the
  // fixed wording composed by Node; the turn's free text is never displayed.
  const trusted = await startScriptedOrchestrator("summary-trusted-state.json", [
    reportTurn,
    { kind: "text", text: "Checking the manifest and the lockfile." },
  ]);
  try {
    const trustedEnv = {
      ...serviceEnv,
      FORGEPILOT_API_URL: trusted.base,
      FORGEPILOT_API_TOKEN: trusted.orchestrator.apiToken,
      FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1",
      FORGEPILOT_ELECTRON_EXPECTED_SUMMARY_TEXT: renderedReport,
      FORGEPILOT_ELECTRON_FORBIDDEN_TEXT: withheldFreeText,
    };
    const settled = await runElectron({
      ...trustedEnv,
      FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY: "settled",
    });
    const taskId = settled?.result?.taskId;
    if (!taskId) throw new Error("settled summary smoke did not report a task id");
    await assertSummaryPublished(trusted.base, trusted.orchestrator.apiToken, taskId, {
      status: "available",
      text: renderedReport,
      forbidden: withheldFreeText,
    });
    await runElectron({
      ...trustedEnv,
      FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY: "settled-existing",
      FORGEPILOT_ELECTRON_SMOKE_TASK_ID: taskId,
    });
    process.stdout.write("Scripted structured Pi report + Electron replay smoke passed.\n");
  } finally {
    await trusted.orchestrator.stop();
  }

  // Untrusted path: a free-text-only turn settles `unavailable` as
  // untrusted_source, carries no text anywhere, and renders as unavailable.
  const untrusted = await startScriptedOrchestrator("summary-untrusted-state.json", [
    { kind: "text", text: withheldFreeText },
  ]);
  try {
    const untrustedEnv = {
      ...serviceEnv,
      FORGEPILOT_API_URL: untrusted.base,
      FORGEPILOT_API_TOKEN: untrusted.orchestrator.apiToken,
      FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1",
      FORGEPILOT_ELECTRON_FORBIDDEN_TEXT: withheldFreeText,
    };
    const settled = await runElectron({
      ...untrustedEnv,
      FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY: "untrusted",
    });
    const taskId = settled?.result?.taskId;
    if (!taskId) throw new Error("untrusted summary smoke did not report a task id");
    await assertSummaryPublished(untrusted.base, untrusted.orchestrator.apiToken, taskId, {
      status: "unavailable",
      reason: "untrusted_source",
      forbidden: withheldFreeText,
    });
    await runElectron({
      ...untrustedEnv,
      FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY: "untrusted-existing",
      FORGEPILOT_ELECTRON_SMOKE_TASK_ID: taskId,
    });
    process.stdout.write("Scripted free-text Pi turn withheld + Electron render smoke passed.\n");
  } finally {
    await untrusted.orchestrator.stop();
  }
} finally {
  await stopChild(nodeService?.child);
  await stopChild(dsh);
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForDsh(child, client, errorChunks) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited early (${child.exitCode}): ${errorChunks.join("")}`);
    }
    try {
      const health = await client.health();
      if (health.service === "dsh" && health.status === "ready") return;
    } catch {
      // The socket is not accepting requests until dsh finishes startup.
    }
    await new Promise((resolve) => setTimer(resolve, 50));
  }
  throw new Error(`dsh did not become ready: ${errorChunks.join("")}`);
}

async function runElectron(env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(electronCommand, [mainEntry], {
      cwd: webRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    let timedOut = false;
    let forceKillTimeout;
    const timeout = setTimer(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimer(() => child.kill("SIGKILL"), 5000);
    }, 90_000);
    child.once("error", (error) => {
      clearTimer(timeout);
      if (forceKillTimeout) clearTimer(forceKillTimeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimer(timeout);
      if (forceKillTimeout) clearTimer(forceKillTimeout);
      if (timedOut) {
        reject(new Error("Electron window smoke timed out."));
        return;
      }
      const output = stdout.join("");
      const errors = stderr.join("");
      if (code === 0 && output.includes("Electron window smoke passed:")) {
        process.stdout.write(output);
        if (errors) process.stderr.write(errors);
        const marker = "Electron window smoke passed:";
        const payload = output.slice(output.indexOf(marker) + marker.length).split("\n")[0];
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          parsed = undefined;
        }
        resolve(parsed);
      } else {
        reject(
          new Error(
            `Electron exited with code ${code ?? "null"} (${signal ?? "no signal"}).\n${output}${errors}`,
          ),
        );
      }
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function apiJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `API ${options.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

/** Read SSE text until the window elapses; the stream stays open for a live task. */
async function readStreamWindow(url, token, lastEventId, windowMs) {
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), windowMs);
  let text = "";
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`SSE stream failed: ${response.status}`);
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  } finally {
    clearTimer(timer);
  }
  return text;
}

/**
 * Verify one settled summary over the real API: a single settlement event for
 * the expected outcome, projection equality, current-run attribution,
 * Last-Event-ID replay that does not repeat it, and no withheld text anywhere.
 */
async function assertSummaryPublished(base, token, taskId, expected) {
  const taskUrl = `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  const task = await apiJson(taskUrl, token);
  const timeline = await apiJson(`${taskUrl}/timeline`, token);
  const summaryEvents = timeline.items.filter((event) => event.type === "pi.summary.updated");
  const settled = summaryEvents.filter((event) => event.data?.summary?.status === expected.status);
  if (settled.length !== 1) {
    throw new Error(`expected exactly one ${expected.status} summary event, got ${settled.length}`);
  }
  const summary = settled[0].data.summary;
  if (summary.task_id !== task.id || summary.run_id !== task.current_run_id) {
    throw new Error("the settled summary is not attributed to the task's current run");
  }
  if (JSON.stringify(task.pi_summary) !== JSON.stringify(summary)) {
    throw new Error("the task projection does not equal the last summary event");
  }
  if (expected.status === "available") {
    if (summary.text !== expected.text) {
      throw new Error("the available summary is not the structured report rendering");
    }
  } else {
    if (summary.text !== null || summary.unavailable_reason !== expected.reason) {
      throw new Error("the unavailable summary carries text or an unexpected reason");
    }
  }
  if (expected.forbidden) {
    // Raw pi.text_delta events keep their M0 payload; only the summary
    // projection and every summary event are display surfaces.
    const surfaces = JSON.stringify([task.pi_summary, summaryEvents.map((event) => event.data)]);
    if (surfaces.includes(expected.forbidden)) {
      throw new Error("withheld Pi text appears in the summary projection or events");
    }
  }

  const replay = await readStreamWindow(`${taskUrl}/stream`, token, settled[0].event_id, 2000);
  if (replay.includes("event: pi.summary.updated")) {
    throw new Error("Last-Event-ID replay repeated an already-delivered summary event");
  }
}
