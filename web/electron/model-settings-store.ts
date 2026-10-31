import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SafeStorage } from "electron";

import { MODEL_PROVIDERS } from "./model-providers.js";
import type { ModelProviderId } from "./model-providers.js";

export { MODEL_PROVIDERS } from "./model-providers.js";
export type { ModelProviderId } from "./model-providers.js";

export interface StoredModelSettings {
  version: 1;
  provider: ModelProviderId;
  modelId: string;
  baseUrl?: string;
  encryptedApiKey?: string;
}

export interface ModelSettingsInput {
  provider: ModelProviderId;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
}

export type ModelConnectionInput = Omit<ModelSettingsInput, "modelId"> & { modelId?: string };

export interface ModelSettingsSnapshot {
  providers: Array<{ id: ModelProviderId; label: string; defaultBaseUrl?: string }>;
  current?: {
    provider: ModelProviderId;
    modelId: string;
    baseUrl?: string;
    apiKeyConfigured: boolean;
  };
  secureStorageAvailable: boolean;
}

const MAX_MODEL_ID_LENGTH = 256;
const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 8192;

export function loadModelSettings(filePath: string): StoredModelSettings | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const document: unknown = JSON.parse(raw);
    return isStoredModelSettings(document) ? document : undefined;
  } catch {
    return undefined;
  }
}

export function getModelSettingsSnapshot(
  filePath: string,
  safeStorage: SafeStorage,
): ModelSettingsSnapshot {
  const stored = loadModelSettings(filePath);
  return {
    providers: MODEL_PROVIDERS.map(({ id, label, defaultBaseUrl }) => ({
      id,
      label,
      defaultBaseUrl,
    })),
    ...(stored
      ? {
          current: {
            provider: stored.provider,
            modelId: stored.modelId,
            ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
            apiKeyConfigured: !!stored.encryptedApiKey,
          },
        }
      : {}),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  };
}

export function saveModelSettings(
  filePath: string,
  safeStorage: SafeStorage,
  input: ModelSettingsInput,
): void {
  input = normalizeModelSettingsInput(input);
  const provider = requireProvider(input.provider);
  const { modelId, baseUrl } = input;

  const previous = loadModelSettings(filePath);
  const apiKey = input.apiKey?.trim() ?? "";

  let encryptedApiKey: string | undefined;
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("System secure storage is unavailable; the model API key was not saved.");
    }
    encryptedApiKey = safeStorage.encryptString(apiKey).toString("base64");
  } else if (previous?.provider === provider.id) {
    encryptedApiKey = previous.encryptedApiKey;
  }

  if (encryptedApiKey && !safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "System secure storage is unavailable; re-enter the model API key in Settings.",
    );
  }
  if (!encryptedApiKey && provider.id !== "openai-compatible") {
    throw new Error("Enter an API key for the selected provider.");
  }
  if (!encryptedApiKey && provider.id === "openai-compatible" && !isLocalBaseUrl(baseUrl)) {
    throw new Error("Enter an API key for a remote OpenAI-compatible endpoint.");
  }

  const document: StoredModelSettings = {
    version: 1,
    provider: provider.id,
    modelId,
    ...(baseUrl ? { baseUrl } : {}),
    ...(encryptedApiKey ? { encryptedApiKey } : {}),
  };
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

export function normalizeModelSettingsInput(
  input: ModelConnectionInput,
  requireModelId = true,
): ModelSettingsInput {
  const provider = requireProvider(input.provider);
  const modelId = requireModelId
    ? requireText(input.modelId ?? "", "Model ID", MAX_MODEL_ID_LENGTH)
    : "";
  const baseUrl = normalizeBaseUrl(input.baseUrl) ?? provider.defaultBaseUrl;
  if (provider.id === "openai-compatible" && !baseUrl) {
    throw new Error("Base URL is required for an OpenAI-compatible model.");
  }
  const apiKey = input.apiKey?.trim() || undefined;
  if (apiKey && apiKey.length > MAX_API_KEY_LENGTH) {
    throw new Error(`API key must be at most ${MAX_API_KEY_LENGTH} characters.`);
  }
  return { provider: provider.id, modelId, baseUrl, apiKey };
}

/** Main-process only: the cleartext key must never be returned over IPC. */
export function resolveModelConnectionSettings(
  filePath: string,
  safeStorage: SafeStorage,
  input: ModelConnectionInput,
): ModelSettingsInput & { apiKey: string } {
  const normalized = normalizeModelSettingsInput(input, false);
  const stored = loadModelSettings(filePath);
  let apiKey = normalized.apiKey;
  if (!apiKey && stored?.provider === normalized.provider && stored.encryptedApiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("System secure storage is unavailable; re-enter the API key to test.");
    }
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64"));
    } catch {
      throw new Error("The saved API key could not be read; re-enter it to test.");
    }
  }
  if (!apiKey) {
    if (normalized.provider !== "openai-compatible" || !isLocalBaseUrl(normalized.baseUrl)) {
      throw new Error("Enter an API key for the selected provider.");
    }
    apiKey = "local-openai-compatible";
  }
  return { ...normalized, apiKey };
}

export function removeModelSettings(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function modelSettingsEnvironment(
  env: NodeJS.ProcessEnv,
  filePath: string,
  safeStorage: SafeStorage,
): NodeJS.ProcessEnv {
  const stored = loadModelSettings(filePath);
  if (!stored) return env;

  let apiKey = "";
  if (stored.encryptedApiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "System secure storage is unavailable; re-enter the model API key in Settings.",
      );
    }
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64"));
    } catch {
      throw new Error("The saved model API key could not be read; re-enter it in Settings.");
    }
  }

  const provider = requireProvider(stored.provider);
  const effectiveApiKey =
    apiKey || (stored.provider === "openai-compatible" ? "local-openai-compatible" : "");
  return {
    ...env,
    FORGEPILOT_PI_PROVIDER:
      stored.provider === "openai-compatible" ? "openai-compatible" : provider.id,
    FORGEPILOT_PI_MODEL: stored.modelId,
    FORGEPILOT_PI_BASE_URL: stored.baseUrl ?? "",
    [provider.apiKeyEnv]: effectiveApiKey,
  };
}

function requireProvider(providerId: string): (typeof MODEL_PROVIDERS)[number] {
  const provider = MODEL_PROVIDERS.find((entry) => entry.id === providerId);
  if (!provider) throw new Error("Select a supported model provider.");
  return provider;
}

function requireText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength)
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  return normalized;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_BASE_URL_LENGTH) {
    throw new Error(`Base URL must be at most ${MAX_BASE_URL_LENGTH} characters.`);
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Base URL must be a valid HTTP or HTTPS URL.");
  }
  if (!(["http:", "https:"].includes(url.protocol) && !url.username && !url.password)) {
    throw new Error("Base URL must use HTTP or HTTPS and must not contain credentials.");
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  ) {
    throw new Error("Use HTTPS for a non-local model endpoint.");
  }
  if (url.search || url.hash)
    throw new Error("Base URL must not include a query string or fragment.");
  return url.toString().replace(/\/$/, "");
}

function isLocalBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  const hostname = new URL(value).hostname;
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

function isStoredModelSettings(value: unknown): value is StoredModelSettings {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["version"] === 1 &&
    typeof record["provider"] === "string" &&
    MODEL_PROVIDERS.some((provider) => provider.id === record["provider"]) &&
    typeof record["modelId"] === "string" &&
    (record["baseUrl"] === undefined || typeof record["baseUrl"] === "string") &&
    (record["encryptedApiKey"] === undefined || typeof record["encryptedApiKey"] === "string")
  );
}
