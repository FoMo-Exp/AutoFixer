import { getModel, getModels } from "@mariozechner/pi-ai";
import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";
import type { OrchestratorConfig } from "../config.js";

/** Resolve the configured provider/model pair through pi-ai's registry. */
export function resolveConfiguredModel(
  config: Pick<OrchestratorConfig, "piModelProvider" | "piModelId" | "piBaseUrl">,
): Model<Api> | undefined {
  if (!config.piModelProvider || !config.piModelId) {
    return undefined;
  }
  if (config.piModelProvider === "openai-compatible") {
    if (!config.piBaseUrl) {
      throw new Error("OpenAI-compatible models require FORGEPILOT_PI_BASE_URL");
    }
    return {
      id: config.piModelId,
      name: config.piModelId,
      api: "openai-completions",
      provider: "openai",
      baseUrl: config.piBaseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    };
  }
  try {
    // Runtime lookup: the registry validates the pair and throws when the
    // provider or model id is unknown to this pi-ai build.
    let model: Model<Api> | undefined = getModel(
      config.piModelProvider as KnownProvider,
      config.piModelId as never,
    );
    // Discovery can return newer models than the bundled registry. An
    // explicitly configured endpoint may use the provider's known protocol.
    if (!model && config.piBaseUrl) {
      const template = getModels(config.piModelProvider as KnownProvider)[0];
      if (template)
        model = {
          id: config.piModelId,
          name: config.piModelId,
          api: template.api,
          provider: template.provider,
          baseUrl: config.piBaseUrl,
          reasoning: false,
          input: ["text"],
          contextWindow: 32_000,
          maxTokens: 4_096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
    }
    if (!model) {
      throw new Error("the model id is not in the provider registry");
    }
    return config.piBaseUrl ? { ...model, baseUrl: config.piBaseUrl } : model;
  } catch (error) {
    throw new Error(
      `Unknown Pi model ${config.piModelProvider}/${config.piModelId}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
