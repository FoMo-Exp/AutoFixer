import { describe, expect, it } from "vitest";
import { resolveConfiguredModel } from "../src/pi/model.js";

describe("configured Pi model", () => {
  it("resolves registered Xiaomi models with the native protocol", () => {
    expect(
      resolveConfiguredModel({ piModelProvider: "xiaomi", piModelId: "mimo-v2.5" }),
    ).toMatchObject({
      provider: "xiaomi",
      api: "anthropic-messages",
      baseUrl: "https://api.xiaomimimo.com/anthropic",
    });
  });
  it("runs newly discovered Xiaomi models through the known provider protocol", () => {
    expect(
      resolveConfiguredModel({
        piModelProvider: "xiaomi",
        piModelId: "new-discovered-mimo",
        piBaseUrl: "https://api.xiaomimimo.com/anthropic",
      }),
    ).toMatchObject({
      provider: "xiaomi",
      api: "anthropic-messages",
      id: "new-discovered-mimo",
      maxTokens: 4096,
    });
  });
  it("keeps model validation for unconfigured endpoints and unknown providers", () => {
    expect(() =>
      resolveConfiguredModel({ piModelProvider: "xiaomi", piModelId: "unknown" }),
    ).toThrow("Unknown Pi model");
    expect(() =>
      resolveConfiguredModel({
        piModelProvider: "unknown-provider",
        piModelId: "unknown",
        piBaseUrl: "https://example.invalid",
      }),
    ).toThrow("Unknown Pi model");
  });
  it("preserves OpenAI-compatible custom model support", () => {
    expect(
      resolveConfiguredModel({
        piModelProvider: "openai-compatible",
        piModelId: "custom",
        piBaseUrl: "http://localhost:1234/v1",
      }),
    ).toMatchObject({
      api: "openai-completions",
      id: "custom",
      baseUrl: "http://localhost:1234/v1",
    });
  });
});
