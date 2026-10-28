import { contextBridge, ipcRenderer } from "electron";

function resolveApiBaseUrl(): string {
  const configuredUrl = process.env["FORGEPILOT_API_URL"]?.trim();
  if (configuredUrl && isLoopbackApiUrl(configuredUrl)) return configuredUrl.replace(/\/$/, "");

  const port = process.env["FORGEPILOT_API_PORT"]?.trim();
  const discoveredUrl = port ? `http://127.0.0.1:${port}` : "";
  return isLoopbackApiUrl(discoveredUrl) ? discoveredUrl : "";
}

function isLoopbackApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

contextBridge.exposeInMainWorld("forgePilotConfig", {
  apiBaseUrl: resolveApiBaseUrl(),
  startupError: process.env["FORGEPILOT_API_STARTUP_ERROR"] ?? "",
});

contextBridge.exposeInMainWorld("forgePilotSettings", {
  listAccounts: () => ipcRenderer.invoke("forgepilot:settings:list-accounts"),
  saveAccount: (input: unknown) => ipcRenderer.invoke("forgepilot:settings:save-account", input),
  removeAccount: (input: unknown) =>
    ipcRenderer.invoke("forgepilot:settings:remove-account", input),
  listRepositories: (input: unknown) =>
    ipcRenderer.invoke("forgepilot:settings:list-repositories", input),
  listBranches: (input: unknown) => ipcRenderer.invoke("forgepilot:settings:list-branches", input),
});

contextBridge.exposeInMainWorld("forgePilotApi", {
  request: (request: unknown) => ipcRenderer.invoke("forgepilot:api-request", request),
  abort: (requestId: string) => ipcRenderer.send("forgepilot:api-abort", requestId),
  onStream: (requestId: string, callback: (message: unknown) => void) => {
    const channel = `forgepilot:api-stream:${requestId}`;
    const listener = (_event: Electron.IpcRendererEvent, message: unknown): void => {
      callback(message);
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
