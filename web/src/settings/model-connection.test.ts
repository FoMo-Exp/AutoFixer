import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SafeStorage } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testModelConnection } from "../../electron/model-connection.js";
import {
  MODEL_PROVIDERS,
  getModelSettingsSnapshot,
  modelSettingsEnvironment,
  saveModelSettings,
} from "../../electron/model-settings-store.js";

const storage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
  getSelectedStorageBackend: () => "basic_text",
  setUsePlainTextEncryption: () => undefined,
};

describe("model discovery connection test", () => {
  let directory: string;
  let filePath: string;
  const request = vi.fn<typeof fetch>();
  const dependencies = { fetchImpl: request };
  const input = { provider: "openai" as const, apiKey: "probe-secret" };
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "forgepilot-model-list-"));
    filePath = path.join(directory, "model.json");
    request
      .mockReset()
      .mockImplementation(async () =>
        Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] }),
      );
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("discovers models before a Model ID is entered and normalizes the list", async () => {
    request.mockResolvedValue(
      Response.json({
        data: [
          { id: "model-b" },
          { id: "model-a" },
          { id: "model-a" },
          { id: "text-embedding-3" },
          { id: "echo-probe-secret" },
        ],
      }),
    );
    const result = await testModelConnection(filePath, storage, input, dependencies);
    expect(result).toMatchObject({
      ok: true,
      models: ["model-a", "model-b"],
      latencyMs: expect.any(Number),
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(new Headers(request.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer probe-secret",
    );
    expect(JSON.stringify(result)).not.toContain("probe-secret");
  });

  it("reuses the same provider's saved key without changing settings", async () => {
    saveModelSettings(filePath, storage, {
      provider: "openai",
      modelId: "old",
      apiKey: "saved-secret",
    });
    const before = readFileSync(filePath, "utf8");
    expect(
      (
        await testModelConnection(
          filePath,
          storage,
          { provider: "openai", baseUrl: "https://proxy.invalid/custom/" },
          dependencies,
        )
      ).ok,
    ).toBe(true);
    expect(request.mock.calls[0][0]).toBe("https://proxy.invalid/custom/models");
    expect(new Headers(request.mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer saved-secret",
    );
    expect(readFileSync(filePath, "utf8")).toBe(before);
  });

  it("uses an entered key even when secure storage is unavailable", async () => {
    expect(
      (
        await testModelConnection(
          filePath,
          { ...storage, isEncryptionAvailable: () => false },
          input,
          dependencies,
        )
      ).ok,
    ).toBe(true);
  });

  it("does not reuse another provider's stored key", async () => {
    saveModelSettings(filePath, storage, {
      provider: "openai",
      modelId: "old",
      apiKey: "saved-secret",
    });
    await expect(
      testModelConnection(filePath, storage, { provider: "anthropic" }, dependencies),
    ).rejects.toThrow("Enter an API key");
    expect(request).not.toHaveBeenCalled();
  });

  it("includes Xiaomi and default URLs in the settings snapshot", () => {
    const snapshot = getModelSettingsSnapshot(filePath, storage);
    expect(snapshot.providers.find((provider) => provider.id === "xiaomi")).toMatchObject({
      defaultBaseUrl: "https://api.xiaomimimo.com/anthropic",
    });
    expect(
      snapshot.providers
        .filter((provider) => provider.id !== "openai-compatible")
        .every((provider) => !!provider.defaultBaseUrl),
    ).toBe(true);
    expect(
      snapshot.providers.find((provider) => provider.id === "openai-compatible")?.defaultBaseUrl,
    ).toBeUndefined();
  });

  it("persists Xiaomi and forwards its key and endpoint to the orchestrator", () => {
    saveModelSettings(filePath, storage, {
      provider: "xiaomi",
      modelId: "mimo-new",
      apiKey: "xiaomi-secret",
    });
    expect(modelSettingsEnvironment({}, filePath, storage)).toMatchObject({
      FORGEPILOT_PI_PROVIDER: "xiaomi",
      FORGEPILOT_PI_MODEL: "mimo-new",
      FORGEPILOT_PI_BASE_URL: "https://api.xiaomimimo.com/anthropic",
      XIAOMI_API_KEY: "xiaomi-secret",
    });
  });

  it.each([
    ["anthropic", "https://api.anthropic.com/v1/models?limit=1000", "x-api-key"],
    ["minimax", "https://api.minimax.io/anthropic/v1/models?limit=1000", "x-api-key"],
    ["xiaomi", "https://api.xiaomimimo.com/v1/models", "api-key"],
    ["mistral", "https://api.mistral.ai/v1/models", "Authorization"],
  ] as const)("uses the %s catalogue protocol", async (provider, url, header) => {
    expect(
      (await testModelConnection(filePath, storage, { ...input, provider }, dependencies)).ok,
    ).toBe(true);
    expect(request.mock.calls[0][0]).toBe(url);
    expect(new Headers(request.mock.calls[0][1]?.headers).get(header)).toContain("probe-secret");
  });

  it("follows Gemini pages and includes only generateContent models", async () => {
    request
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { name: "models/gemini-chat", supportedGenerationMethods: ["generateContent"] },
            { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
          ],
          nextPageToken: "next/page",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [{ name: "models/gemini-new", supportedGenerationMethods: ["generateContent"] }],
        }),
      );
    expect(
      await testModelConnection(filePath, storage, { ...input, provider: "google" }, dependencies),
    ).toMatchObject({ ok: true, models: ["gemini-chat", "gemini-new"] });
    const next = new URL(String(request.mock.calls[1][0]));
    expect(next.searchParams.get("pageToken")).toBe("next/page");
    expect(next.searchParams.get("pageSize")).toBe("1000");
    expect(new Headers(request.mock.calls[0][1]?.headers).get("x-goog-api-key")).toBe(
      "probe-secret",
    );
  });

  it("paginates Anthropic on the same endpoint and ignores provider-supplied next URLs", async () => {
    request
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "claude-a" }],
          has_more: true,
          last_id: "claude-a",
          next: "https://attacker.invalid",
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-b" }], has_more: false }));
    expect(
      await testModelConnection(
        filePath,
        storage,
        { ...input, provider: "anthropic" },
        dependencies,
      ),
    ).toMatchObject({ ok: true, models: ["claude-a", "claude-b"] });
    const next = new URL(String(request.mock.calls[1][0]));
    expect(next.origin).toBe("https://api.anthropic.com");
    expect(next.searchParams.get("after_id")).toBe("claude-a");
  });

  it("accepts local OpenAI-compatible endpoints without a key or a Model ID", async () => {
    expect(
      (
        await testModelConnection(
          filePath,
          storage,
          { provider: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
          dependencies,
        )
      ).ok,
    ).toBe(true);
  });

  it("rejects unsafe URL input before fetching", async () => {
    for (const baseUrl of [
      "http://remote.invalid",
      "https://user:password@remote.invalid",
      "https://remote.invalid?key=secret",
    ]) {
      await expect(
        testModelConnection(filePath, storage, { ...input, baseUrl }, dependencies),
      ).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [401, "Authentication"],
    [403, "Authentication"],
    [404, "model-list endpoint"],
    [429, "quota"],
    [500, "Could not load models"],
  ])("reports safe errors for HTTP %s", async (status, expected) => {
    request.mockResolvedValue(new Response("echo-probe-secret", { status: Number(status) }));
    const result = await testModelConnection(filePath, storage, input, dependencies);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(String(expected)) });
    expect(JSON.stringify(result)).not.toContain("probe-secret");
  });

  it.each([{ data: [] }, { data: [{ id: "mimo-v2-tts" }] }, { error: "echo-probe-secret" }])(
    "rejects empty or invalid catalogues",
    async (body) => {
      request.mockResolvedValue(Response.json(body));
      expect((await testModelConnection(filePath, storage, input, dependencies)).ok).toBe(false);
    },
  );

  it("aborts a slow catalogue after the time limit", async () => {
    vi.useFakeTimers();
    request.mockImplementation(() => new Promise(() => undefined));
    const pending = testModelConnection(filePath, storage, input, {
      ...dependencies,
      timeoutMs: 20,
    });
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({
      ok: false,
      message: expect.stringContaining("timed out"),
    });
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("keeps model ID validation when saving", () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(() =>
        saveModelSettings(filePath, storage, {
          provider: provider.id,
          modelId: "",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "probe-secret",
        }),
      ).toThrow("Model ID is required");
    }
  });
});
