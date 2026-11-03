import fs from "node:fs";
import path from "node:path";

/**
 * Service-side provider credential boundary for the model gateway.
 *
 * The gateway, not Pi and not the execution environment, is the only holder of
 * provider credentials. Stores resolve credentials by reference at dispatch
 * time; credential values never appear in policy records, events, errors, or
 * logs. There is deliberately no environment-variable store: an env lookup is
 * exactly the bypass this boundary exists to prevent.
 */
export interface GatewayCredentialStore {
  get(credentialRef: string): string | undefined;
}

/** In-memory store for tests and programmatic service-side injection. */
export function createStaticCredentialStore(
  entries: Readonly<Record<string, string>>,
): GatewayCredentialStore {
  const byRef = new Map(Object.entries(entries));
  return {
    get(credentialRef: string): string | undefined {
      return byRef.get(credentialRef);
    },
  };
}

/**
 * Provider credential environment variables pi-ai's `getEnvApiKey` reads.
 * Mirrored from `@mariozechner/pi-ai/dist/env-api-keys.js`; kept as data (not
 * behavior) so the deployment guard can refuse to run when the ambient
 * environment still carries an env-based credential bypass.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
];

/**
 * Names of provider credential variables present in `env`. The deployment
 * guard refuses to start the orchestrator when any are set: a deployment that
 * wants live model egress must configure the gateway credential file instead.
 */
export function providerCredentialEnvVars(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_CREDENTIAL_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Load provider credentials from a protected JSON file mapping
 * `credentialRef -> secret`. The file must be a regular file with owner-only
 * permissions (0600 or tighter on POSIX) so the service-side boundary cannot
 * be widened by a planted symlink or a world-readable secret.
 */
export function readCredentialFile(file: string): GatewayCredentialStore {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`refusing to read gateway credentials from non-regular file ${file}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `gateway credentials file ${path.basename(file)} must have owner-only permissions (0600)`,
    );
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("gateway credentials file must be a JSON object of credentialRef -> secret");
  }
  const entries: Record<string, string> = {};
  for (const [ref, secret] of Object.entries(parsed)) {
    if (ref.trim() === "" || typeof secret !== "string" || secret === "") {
      throw new Error("gateway credentials file entries must map a non-empty ref to a secret");
    }
    entries[ref] = secret;
  }
  return createStaticCredentialStore(entries);
}
