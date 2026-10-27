import { app, BrowserWindow, ipcMain } from "electron";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiProxy, installApiProxy } from "./api-proxy.js";
import { discoverNodeService } from "./service-discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let nodeChild: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;
let disposeApiProxy: () => void = () => undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: "#0c1018",
    title: "ForgePilot Workbench",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

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

void app.whenReady().then(async () => {
  try {
    const discovered = await discoverNodeService();
    nodeChild = discovered.child;
    if (discovered.apiBaseUrl) process.env["FORGEPILOT_API_URL"] = discovered.apiBaseUrl;
    if (discovered.apiTokenFile) process.env["FORGEPILOT_API_TOKEN_FILE"] = discovered.apiTokenFile;
    if (discovered.apiToken) process.env["FORGEPILOT_API_TOKEN"] = discovered.apiToken;
  } catch (error) {
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
