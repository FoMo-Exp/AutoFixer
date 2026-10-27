import type http from "node:http";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";

import { buildOpenApiDocument } from "./api/openapi.js";
import { readOrCreateApiToken } from "./api/auth.js";
import { createApiServer } from "./api/server.js";
import { TaskService } from "./api/task-service.js";
import { TaskStore } from "./api/task-store.js";
import type { OrchestratorConfig } from "./config.js";
import { configFromEnv } from "./config.js";
import { DshClient } from "./dsh/client.js";

export interface OrchestratorOptions {
  config: OrchestratorConfig;
  /** Deterministic model stream for tests; unset means live pi-ai streaming. */
  streamFn?: StreamFn;
  /** Explicit Pi model; unset resolves from config, then PI_UNAVAILABLE. */
  model?: Model<Api>;
}

export interface OrchestratorHandle {
  server: http.Server;
  service: TaskService;
  store: TaskStore;
  dsh: DshClient;
  model: Model<Api> | undefined;
  /** Per-process bearer token callers must present on every API request. */
  apiToken: string;
  /** Start listening; resolves with the bound loopback address. */
  start(): Promise<{ host: string; port: number }>;
  /** Stop listening and release Pi sessions. */
  stop(): Promise<void>;
}

/**
 * Composition root for the orchestrator process.
 *
 * Wires config → dsh client → task service → API server. Tests construct the
 * same handle with an injected deterministic stream instead of a live model.
 */
export function createOrchestrator(options: OrchestratorOptions): OrchestratorHandle {
  const { config } = options;
  const store = new TaskStore();
  const dsh = new DshClient({
    socketPath: config.dshSocketPath,
    ...(config.dshTokenFile ? { tokenFile: config.dshTokenFile } : {}),
  });
  const model = options.model ?? resolveConfiguredModel(config);
  const service = new TaskService({
    config,
    dsh,
    store,
    ...(model ? { model } : {}),
    ...(options.streamFn ? { streamFn: options.streamFn } : {}),
  });
  // Fresh per-process token: possessing it is what authorizes API callers,
  // approvals included; the configured dsh identity alone is not proof of a
  // human decision.
  const apiToken = readOrCreateApiToken(config.apiTokenFile);
  const server = createApiServer({ service, apiToken });
  return {
    server,
    service,
    store,
    dsh,
    model,
    apiToken,
    start: () => {
      const { promise, resolve, reject } = Promise.withResolvers<{ host: string; port: number }>();
      server.once("error", reject);
      server.listen(config.apiPort, config.apiHost, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("orchestrator did not bind a TCP loopback port"));
          return;
        }
        resolve({ host: config.apiHost, port: address.port });
      });
      return promise;
    },
    stop: () => {
      service.disposeAll();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

/** Resolve the configured provider/model pair through pi-ai's registry. */
function resolveConfiguredModel(config: OrchestratorConfig): Model<Api> | undefined {
  if (!config.piModelProvider || !config.piModelId) {
    return undefined;
  }
  try {
    // Runtime lookup: the registry validates the pair and throws when the
    // provider or model id is unknown to this pi-ai build.
    return getModel(config.piModelProvider as KnownProvider, config.piModelId as never);
  } catch (error) {
    throw new Error(
      `Unknown Pi model ${config.piModelProvider}/${config.piModelId}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export { buildOpenApiDocument, configFromEnv, getEnvApiKey };

async function main(): Promise<void> {
  const config = configFromEnv();
  const orchestrator = createOrchestrator({ config });
  const { host, port } = await orchestrator.start();
  console.log(`forgepilot-api/v1 listening on http://${host}:${port}`);
  console.log(`dsh control plane: ${config.dshSocketPath}`);
  console.log(`API token file (Authorization: Bearer <token>): ${config.apiTokenFile}`);
  console.log(
    orchestrator.model
      ? `Pi model: ${orchestrator.model.provider}/${orchestrator.model.id}`
      : "Pi model: not configured (tasks will report PI_UNAVAILABLE)",
  );
  const shutdown = (): void => {
    void orchestrator.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run the server when executed directly (node dist/src/index.js), not
// when imported by tests or the export script.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void main();
}
