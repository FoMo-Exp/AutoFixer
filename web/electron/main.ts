import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiProxy, installApiProxy } from "./api-proxy.js";
import { createProviderClient } from "./git-providers.js";
import { modelSettingsEnvironment } from "./model-settings-store.js";
import { discoverNodeService, NodeServiceStartupError } from "./service-discovery.js";
import { installSettingsIpc } from "./settings-ipc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const launchApiEnvironment = {
  FORGEPILOT_API_URL: process.env["FORGEPILOT_API_URL"],
  FORGEPILOT_API_TOKEN_FILE: process.env["FORGEPILOT_API_TOKEN_FILE"],
  FORGEPILOT_API_TOKEN: process.env["FORGEPILOT_API_TOKEN"],
};
let nodeChild: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;
let disposeApiProxy: () => void = () => undefined;
let disposeSettingsIpc: () => void = () => undefined;
let startupError = "";

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: "#0c1018",
    title: "ForgePilot Workbench",
    show: process.env["FORGEPILOT_ELECTRON_WINDOW_SMOKE"] !== "1",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  if (process.env["FORGEPILOT_ELECTRON_WINDOW_SMOKE"] === "1") {
    runWindowSmoke(window);
  }

  const devServerUrl = process.env["VITE_DEV_SERVER_URL"];
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  return window;
}

function runWindowSmoke(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("Electron window smoke timed out.");
    app.exit(1);
  }, 45_000);
  window.webContents.once("did-finish-load", () => {
    void window.webContents
      .executeJavaScript(
        `(async () => {
          const waitFor = async (predicate, timeoutMs = 5000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              const result = predicate();
              if (result) return result;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return undefined;
          };
          if (!window.forgePilotApi?.request) throw new Error("preload IPC bridge is missing");
          const expectedConfigError = window.forgePilotConfig?.startupError || "";
          if (expectedConfigError) {
            const banner = await waitFor(() => document.querySelector(".connection-banner")?.innerText);
            if (!banner?.includes(expectedConfigError)) throw new Error("startup configuration guidance is not visible");
            const expectedGuidance = ${JSON.stringify(process.env["FORGEPILOT_ELECTRON_EXPECTED_GUIDANCE"] ?? "")};
            if (expectedGuidance && !banner.includes(expectedGuidance)) throw new Error("startup guidance does not include the expected remediation: " + expectedGuidance);
            return { mode: "startup-guidance", banner };
          }
          const brand = await waitFor(() => document.querySelector(".brand-name")?.textContent);
          if (brand !== "ForgePilot") throw new Error("relative file:// app assets did not render");
          const apiBaseUrl = window.forgePilotConfig?.apiBaseUrl;
          if (!apiBaseUrl) throw new Error("preload did not expose the local API endpoint");
          const summaryMode = ${JSON.stringify(process.env["FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY"] ?? "")};
          const trustedMode = summaryMode === "settled" || summaryMode === "settled-existing";
          const untrustedMode = summaryMode === "untrusted" || summaryMode === "untrusted-existing";
          if (trustedMode || untrustedMode) {
            const expectedSummaryText = ${JSON.stringify(process.env["FORGEPILOT_ELECTRON_EXPECTED_SUMMARY_TEXT"] ?? "")};
            const forbiddenText = ${JSON.stringify(process.env["FORGEPILOT_ELECTRON_FORBIDDEN_TEXT"] ?? "")};
            const createMode = summaryMode === "settled" || summaryMode === "untrusted";
            const call = (requestId, method, requestPath, body, headers) =>
              window.forgePilotApi.request({
                requestId,
                url: apiBaseUrl + requestPath,
                method,
                headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(headers || {}) },
                ...(body ? { body: JSON.stringify(body) } : {})
              });
            const read = (response) => JSON.parse(response.body || "{}");
            const delay = (ms) => {
              const { promise, resolve } = Promise.withResolvers();
              setTimeout(resolve, ms);
              return promise;
            };
            let taskId = ${JSON.stringify(process.env["FORGEPILOT_ELECTRON_SMOKE_TASK_ID"] ?? "")};
            if (createMode) {
              const created = await call("00000000-0000-4000-8000-0000000000a1", "POST", "/api/v1/tasks", {
                repository_id: "github:Luthiel/AutoFixer",
                base_ref: "main",
                summary: "Scripted Pi summary window smoke"
              }, { "Idempotency-Key": "electron-window-pi-summary-" + summaryMode });
              if (created.status !== 201) throw new Error("task creation for the scripted Pi turn failed: " + created.status + " " + (created.body || ""));
              taskId = read(created).id;
              await delay(15);
              const timeline = read(await call("00000000-0000-4000-8000-0000000000a2", "GET", "/api/v1/tasks/" + encodeURIComponent(taskId) + "/timeline"));
              const digest = (timeline.items || [])
                .filter((event) => event.type === "approval.required")
                .map((event) => event.data && event.data.scope_digest)
                .find(Boolean);
              if (!digest) throw new Error("approval.required scope digest is missing");
              const approved = await call("00000000-0000-4000-8000-0000000000a3", "POST", "/api/v1/tasks/" + encodeURIComponent(taskId) + "/approvals", { decision: "approve", scope_digest: digest });
              if (approved.status !== 200) throw new Error("approval failed: " + approved.status + " " + (approved.body || ""));
            }
            const deadline = Date.now() + 20000;
            let summary;
            while (Date.now() < deadline) {
              summary = read(await call("00000000-0000-4000-8000-0000000000a4", "GET", "/api/v1/tasks/" + encodeURIComponent(taskId))).pi_summary;
              if (summary && summary.status !== "pending") break;
              await delay(100);
            }
            if (!summary || summary.status === "pending") throw new Error("the scripted Pi turn never settled a summary");
            if (trustedMode) {
              if (summary.status !== "available") throw new Error("the structured Pi report was not published as available: " + JSON.stringify(summary));
              if (summary.text !== expectedSummaryText) throw new Error("the available summary is not the fixed report wording");
            } else {
              if (summary.status !== "unavailable" || summary.unavailable_reason !== "untrusted_source" || summary.text !== null) {
                throw new Error("a free-text-only turn was not withheld as untrusted_source: " + JSON.stringify(summary));
              }
            }
            if (!createMode) {
              const expected = trustedMode ? "available · text withheld" : "unavailable";
              const card = await waitFor(() => {
                const rendered = document.querySelector(".pi-summary-card")?.innerText || "";
                return rendered.toLowerCase().includes(expected) ? rendered : undefined;
              }, 15000);
              if (!card) {
                const rendered = document.querySelector(".pi-summary-card")?.innerText || "(no card)";
                const taskItems = document.querySelectorAll(".task-item").length;
                const banner = document.querySelector(".connection-banner")?.innerText || "";
                throw new Error("Pi summary card did not render the expected state: card=" + rendered.replaceAll("\\n", " | ") + " tasks=" + taskItems + " banner=" + banner.replaceAll("\\n", " | "));
              }
              const bodyText = document.body.innerText;
              if (expectedSummaryText && bodyText.includes(expectedSummaryText)) throw new Error("server summary text leaked into the rendered window");
              if (forbiddenText && bodyText.includes(forbiddenText)) throw new Error("withheld Pi text leaked into the rendered window");
              return { mode: "pi-summary-" + summaryMode, taskId, summaryStatus: summary.status, summaryReason: summary.unavailable_reason, card: card.replaceAll("\\n", " | ") };
            }
            return { mode: "pi-summary-" + summaryMode, taskId, summaryStatus: summary.status, summaryReason: summary.unavailable_reason };
          }
          const list = await window.forgePilotApi.request({
            requestId: "00000000-0000-4000-8000-000000000001",
            url: apiBaseUrl + "/api/v1/tasks",
            method: "GET",
            headers: { Accept: "application/json" }
          });
          if (list.status !== 200 || !JSON.parse(list.body || "{}").items) {
            throw new Error("real Node REST request did not pass through the preload IPC bridge");
          }
          const created = await window.forgePilotApi.request({
            requestId: "00000000-0000-4000-8000-000000000002",
            url: apiBaseUrl + "/api/v1/tasks",
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": "electron-window-smoke" },
            body: JSON.stringify({ repository_id: "github:Luthiel/AutoFixer", base_ref: "main", summary: "Electron window smoke task" })
          });
          if (created.status !== 201) {
            throw new Error("real Node task creation failed: " + created.status + " " + (created.body || ""));
          }
          const task = JSON.parse(created.body || "{}");
          if (!Object.prototype.hasOwnProperty.call(task, "pi_summary")) {
            throw new Error("real Node Task response is missing the contract pi_summary field");
          }
          const requestId = "00000000-0000-4000-8000-000000000003";
          let unsubscribe = () => {};
          const firstChunk = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("SSE event did not reach the renderer")), 5000);
            unsubscribe = window.forgePilotApi.onStream(requestId, (message) => {
              if (message.type === "chunk") {
                clearTimeout(timer);
                resolve(message.text || "");
              } else if (message.type === "error") {
                clearTimeout(timer);
                reject(new Error(message.message || "SSE proxy failed"));
              }
            });
          });
          const stream = await window.forgePilotApi.request({
            requestId,
            url: apiBaseUrl + "/api/v1/tasks/" + encodeURIComponent(task.id) + "/stream",
            method: "GET",
            headers: { Accept: "text/event-stream" }
          });
          if (stream.status !== 200 || !stream.stream) throw new Error("Node SSE stream was not proxied");
          const eventText = await firstChunk;
          window.forgePilotApi.abort(requestId);
          unsubscribe();
          if (!eventText.includes("data:")) throw new Error("Node SSE event frame was empty");
          const expectPiSummary = ${JSON.stringify(process.env["FORGEPILOT_ELECTRON_EXPECT_PI_SUMMARY"] ?? "")};
          if (expectPiSummary === "1") {
            const renderedEvents = await waitFor(
              () => document.querySelectorAll(".timeline-event").length,
              8000
            );
            if (!renderedEvents) throw new Error("Selected task timeline rendered no events");
            const card = await waitFor(() => document.querySelector(".pi-summary-card")?.innerText, 8000);
            if (!card) throw new Error("Pi summary card did not render for the selected task");
            if (!card.includes("Pi summary")) throw new Error("Pi summary card is missing its label");
            if (!card.includes("No Pi summary yet.")) throw new Error("Pi summary card did not render the real projection state: " + card);
            return { mode: "electron-node-rest-sse", status: list.status, taskId: task.id, sse: true, piSummary: card.replaceAll("\\n", " | "), renderedEvents };
          }
          return { mode: "electron-node-rest-sse", status: list.status, taskId: task.id, sse: true };
        })()`,
      )
      .then((result: unknown) => {
        clearTimeout(timeout);
        console.log(
          "Electron window smoke passed:",
          JSON.stringify({ electronVersion: process.versions.electron, result }),
        );
        app.quit();
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        console.error("Electron window smoke failed:", error);
        app.exit(1);
      });
  });
}

void app.whenReady().then(async () => {
  delete process.env["FORGEPILOT_API_STARTUP_ERROR"];
  const modelSettingsPath = path.join(app.getPath("userData"), "orchestrator-model.json");
  try {
    let serviceEnv: NodeJS.ProcessEnv;
    try {
      serviceEnv = modelSettingsEnvironment(process.env, modelSettingsPath, safeStorage);
    } catch (error) {
      throw new NodeServiceStartupError(
        error instanceof Error ? error.message : "Saved model settings could not be loaded.",
      );
    }
    const discovered = await discoverNodeService(serviceEnv);
    nodeChild = discovered.child;
    if (discovered.apiBaseUrl) process.env["FORGEPILOT_API_URL"] = discovered.apiBaseUrl;
    if (discovered.apiTokenFile) process.env["FORGEPILOT_API_TOKEN_FILE"] = discovered.apiTokenFile;
    if (discovered.apiToken) process.env["FORGEPILOT_API_TOKEN"] = discovered.apiToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    startupError =
      error instanceof NodeServiceStartupError && message
        ? message
        : "Node service could not start. Check the local launch configuration and Node service logs.";
    process.env["FORGEPILOT_API_STARTUP_ERROR"] = startupError;
    console.error("ForgePilot Node service discovery failed:", error);
  }
  const apiBaseUrl = process.env["FORGEPILOT_API_URL"] ?? "";
  const apiToken = readApiToken();
  const proxy = createApiProxy({
    apiBaseUrl,
    apiToken,
    publish: (requestId, message) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(`forgepilot:api-stream:${requestId}`, message);
    },
  });
  disposeApiProxy = installApiProxy(ipcMain, () => mainWindow, proxy, isTrustedRendererUrl);
  disposeSettingsIpc = installSettingsIpc(ipcMain, () => mainWindow, isTrustedRendererUrl, {
    statePath: path.join(app.getPath("userData"), "provider-accounts.json"),
    modelSettingsPath,
    safeStorage,
    client: createProviderClient(),
    restartApp: () => {
      restoreLaunchApiEnvironment();
      app.relaunch();
      app.quit();
    },
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  disposeApiProxy();
  disposeSettingsIpc();
  nodeChild?.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function readApiToken(): string {
  const directToken = process.env["FORGEPILOT_API_TOKEN"];
  if (directToken) return directToken;
  const tokenFile = process.env["FORGEPILOT_API_TOKEN_FILE"];
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function restoreLaunchApiEnvironment(): void {
  for (const [key, value] of Object.entries(launchApiEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env["FORGEPILOT_API_STARTUP_ERROR"];
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const actualUrl = new URL(value);
    const devServerUrl = process.env["VITE_DEV_SERVER_URL"];
    if (devServerUrl) return actualUrl.origin === new URL(devServerUrl).origin;
    return actualUrl.href === pathToFileURL(path.resolve(__dirname, "../dist/index.html")).href;
  } catch {
    return false;
  }
}
