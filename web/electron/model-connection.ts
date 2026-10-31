import type { SafeStorage } from "electron";
import { resolveModelConnectionSettings } from "./model-settings-store.js";
import type { ModelConnectionInput, ModelProviderId } from "./model-settings-store.js";

export interface ModelConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  models?: string[];
}

/** Test the endpoint by reading its authenticated model catalogue. */
export async function testModelConnection(
  filePath: string,
  safeStorage: SafeStorage,
  input: ModelConnectionInput,
  dependencies: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelConnectionResult> {
  const settings = resolveModelConnectionSettings(filePath, safeStorage, input);
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, dependencies.timeoutMs ?? 20_000);
    });
    const models = await Promise.race([
      discoverModels(
        settings.provider,
        settings.baseUrl!,
        settings.apiKey,
        controller.signal,
        dependencies.fetchImpl ?? fetch,
      ),
      timeout,
    ]);
    if (!models.length) {
      return {
        ok: false,
        message:
          "No chat models were returned by this endpoint. Check the API key and model access permissions.",
      };
    }
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      models,
      message: `Connection successful. ${models.length} models available.`,
    };
  } catch (error) {
    // Never expose response bodies or transport errors: they may echo keys.
    const status = error instanceof ModelListError ? error.status : undefined;
    if (controller.signal.aborted)
      return {
        ok: false,
        message: "Connection timed out. Check the endpoint and network, then try again.",
      };
    if (status === 401 || status === 403)
      return {
        ok: false,
        message: "Authentication failed. Check the API key and model access permissions.",
      };
    if (status === 404 || status === 405)
      return {
        ok: false,
        message:
          "The model-list endpoint is unavailable. Check the API base URL; you can also enter a Model ID manually.",
      };
    if (status === 429)
      return {
        ok: false,
        message:
          "The provider rate limit or quota was reached. Check your account and try again later.",
      };
    return {
      ok: false,
      message:
        "Could not load models. Check the API base URL, API key and network; you can also enter a Model ID manually.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ModelListError extends Error {
  constructor(readonly status?: number) {
    super("Model discovery failed");
  }
}

function modelListUrl(provider: ModelProviderId, baseUrl: string): URL {
  if (provider === "xiaomi" && /\/anthropic$/.test(baseUrl)) {
    return new URL(`${baseUrl.replace(/\/anthropic$/, "")}/v1/models`);
  }
  if (["anthropic", "minimax", "mistral"].includes(provider) && !/\/v1$/.test(baseUrl)) {
    return new URL(`${baseUrl}/v1/models`);
  }
  return new URL(`${baseUrl}/models`);
}

async function discoverModels(
  provider: ModelProviderId,
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = modelListUrl(provider, baseUrl);
  const headers = new Headers({ Accept: "application/json" });
  if (provider === "google") {
    headers.set("x-goog-api-key", apiKey);
    url.searchParams.set("pageSize", "1000");
  } else if (provider === "xiaomi") {
    headers.set("api-key", apiKey);
  } else if (provider === "anthropic" || provider === "minimax") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
    url.searchParams.set("limit", "1000");
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  const models = new Set<string>();
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    // Provider-supplied next URLs and redirects must never redirect a saved key.
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelListError(response.status);
    }
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new ModelListError();
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new ModelListError();
    const entries = provider === "google" ? body.models : body.data;
    if (!Array.isArray(entries)) throw new ModelListError();
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (
        provider === "google" &&
        Array.isArray(entry.supportedGenerationMethods) &&
        !entry.supportedGenerationMethods.includes("generateContent")
      )
        continue;
      if (isRecord(entry.capabilities) && entry.capabilities.completion_chat === false) continue;
      const id = provider === "google" ? entry.name : entry.id;
      if (typeof id !== "string") continue;
      const modelId = id.replace(/^models\//, "").trim();
      if (
        !modelId ||
        modelId.length > 256 ||
        /\s/.test(modelId) ||
        [...modelId].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        modelId.includes(apiKey)
      )
        continue;
      // Catalogues also contain speech, image and embedding endpoints.
      if (
        /(?:^|[-_/.])(embedding|embed|whisper|tts|asr|dall-e|image|realtime|transcribe|moderation)(?:$|[-_/.])/i.test(
          modelId,
        )
      )
        continue;
      models.add(modelId);
    }
    let cursor: string | undefined;
    let parameter: string;
    if (provider === "google") {
      cursor = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
      parameter = "pageToken";
    } else {
      cursor =
        body.has_more === true && typeof body.last_id === "string" ? body.last_id : undefined;
      if (body.has_more === true && !cursor) throw new ModelListError();
      parameter = "after_id";
    }
    if (!cursor) return [...models].sort((a, b) => a.localeCompare(b));
    if (cursors.has(cursor)) throw new ModelListError();
    cursors.add(cursor);
    url.searchParams.set(parameter, cursor);
  }
  throw new ModelListError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
