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
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  const port = process.env["FORGEPILOT_API_PORT"]?.trim();
  return port ? `http://127.0.0.1:${port}` : "";
}

contextBridge.exposeInMainWorld("forgePilotConfig", {
  apiBaseUrl: resolveApiBaseUrl(),
  token: readApiToken(),
});
