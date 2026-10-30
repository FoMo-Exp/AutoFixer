// Shared by the renderer and main process; keep this catalogue free of Node/Electron APIs.
export const MODEL_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "google",
    label: "Google Gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  {
    id: "mistral",
    label: "Mistral",
    apiKeyEnv: "MISTRAL_API_KEY",
    defaultBaseUrl: "https://api.mistral.ai",
  },
  {
    id: "groq",
    label: "Groq",
    apiKeyEnv: "GROQ_API_KEY",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  },
  { id: "xai", label: "xAI", apiKeyEnv: "XAI_API_KEY", defaultBaseUrl: "https://api.x.ai/v1" },
  {
    id: "minimax",
    label: "MiniMax",
    apiKeyEnv: "MINIMAX_API_KEY",
    defaultBaseUrl: "https://api.minimax.io/anthropic",
  },
  {
    id: "moonshotai",
    label: "Moonshot AI",
    apiKeyEnv: "MOONSHOT_API_KEY",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
  },
  {
    id: "zai",
    label: "Z.AI",
    apiKeyEnv: "ZAI_API_KEY",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    apiKeyEnv: "XIAOMI_API_KEY",
    defaultBaseUrl: "https://api.xiaomimimo.com/anthropic",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultBaseUrl: undefined,
  },
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDERS)[number]["id"];

export function defaultModelBaseUrl(provider: string): string {
  return MODEL_PROVIDERS.find((entry) => entry.id === provider)?.defaultBaseUrl ?? "";
}
