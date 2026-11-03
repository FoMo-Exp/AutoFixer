import { createElectronFetch } from "./electron-fetch";
import type { JsonFetch } from "./client";

export type AuthMode = "desktop" | "browser" | "legacy";

export interface ApiConfig {
  baseUrl: string;
  token: string;
  startupError?: string;
  fetchImpl?: JsonFetch;
  /**
   * desktop: Electron main owns the bearer session (renderer sees no token).
   * browser: HttpOnly cookie session plus CSRF header.
   * legacy: local-operator bearer token configured at launch.
   */
  authMode: AuthMode;
}

export function resolveApiConfig(): ApiConfig {
  const electronConfig = typeof window !== "undefined" ? window.forgePilotConfig : undefined;
  const electronBridge = typeof window !== "undefined" ? window.forgePilotApi : undefined;
  const authBridge = typeof window !== "undefined" ? window.forgePilotAuth : undefined;
  const env = import.meta.env;
  const baseUrl = (electronConfig?.apiBaseUrl || env.VITE_FORGEPILOT_API_URL || "").replace(
    /\/$/,
    "",
  );
  const token = electronConfig ? "" : env.VITE_FORGEPILOT_API_TOKEN || "";

  let authMode: AuthMode = "legacy";
  if (electronConfig && authBridge) authMode = "desktop";
  else if (!token && baseUrl) authMode = "browser";

  return {
    baseUrl,
    token,
    authMode,
    ...(electronConfig?.startupError ? { startupError: electronConfig.startupError } : {}),
    ...(electronConfig && electronBridge ? { fetchImpl: createElectronFetch(electronBridge) } : {}),
  };
}
