import { contextBridge } from "electron";
import fs from "node:fs";

function readApiToken(): string {
  const directToken = process.env["FORGEPILOT_API_TOKEN"];
  if (directToken) return directToken;

  const tokenFile = process.env["FORGEPILOT_API_TOKEN_FILE"];
  if (!tokenFile) return "";

  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

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
  token: readApiToken(),
});
