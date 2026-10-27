import { app, BrowserWindow, ipcMain } from "electron";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiProxy, installApiProxy } from "./api-proxy.js";
import { discoverNodeService, NodeServiceStartupError } from "./service-discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let nodeChild: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;
let disposeApiProxy: () => void = () => undefined;
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
  }, 20_000);
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
            const summary = await waitFor(() => document.querySelector(".pi-summary")?.innerText, 8000);
            if (!summary) throw new Error("Pi summary did not render for the selected task timeline");
            if (!summary.includes("Pi summary")) throw new Error("Pi summary card is missing its label");
            const renderedEvents = document.querySelectorAll(".timeline-event").length;
            if (renderedEvents === 0) throw new Error("Selected task timeline rendered no events");
            return { mode: "electron-node-rest-sse", status: list.status, taskId: task.id, sse: true, piSummary: summary.replaceAll("\\n", " | "), renderedEvents };
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
  try {
    const discovered = await discoverNodeService();
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  disposeApiProxy();
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
