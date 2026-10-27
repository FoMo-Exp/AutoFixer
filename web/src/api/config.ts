export interface ApiConfig {
  baseUrl: string;
  token: string;
}

export function resolveApiConfig(): ApiConfig {
  const electronConfig = typeof window !== "undefined" ? window.forgePilotConfig : undefined;
  const env = import.meta.env;

  return {
    baseUrl: (electronConfig?.apiBaseUrl || env.VITE_FORGEPILOT_API_URL || "").replace(/\/$/, ""),
    token: electronConfig?.token || env.VITE_FORGEPILOT_API_TOKEN || "",
  };
}
