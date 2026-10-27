import { createElectronFetch } from "./electron-fetch";
import type { JsonFetch } from "./client";

export interface ApiConfig {
  baseUrl: string;
  token: string;
  startupError?: string;
  fetchImpl?: JsonFetch;
}

export function resolveApiConfig(): ApiConfig {
  const electronConfig = typeof window !== "undefined" ? window.forgePilotConfig : undefined;
  const electronBridge = typeof window !== "undefined" ? window.forgePilotApi : undefined;
  const env = import.meta.env;

  return {
    baseUrl: (electronConfig?.apiBaseUrl || env.VITE_FORGEPILOT_API_URL || "").replace(/\/$/, ""),
    token: electronConfig ? "" : env.VITE_FORGEPILOT_API_TOKEN || "",
    ...(electronConfig?.startupError ? { startupError: electronConfig.startupError } : {}),
    ...(electronConfig && electronBridge ? { fetchImpl: createElectronFetch(electronBridge) } : {}),
  };
}
