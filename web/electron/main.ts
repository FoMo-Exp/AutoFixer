import { app, BrowserWindow } from "electron";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNodeService } from "./service-discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let nodeChild: ChildProcess | undefined;

function createWindow(): void {
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
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(__dirname, "../dist/index.html"));
  }
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  nodeChild?.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
