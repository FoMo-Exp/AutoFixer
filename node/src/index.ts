import type http from "node:http";

import type { Api, Model } from "@mariozechner/pi-ai";

import { buildOpenApiDocument } from "./api/openapi.js";
import { readOrCreateApiToken } from "./api/auth.js";
import { createApiServer } from "./api/server.js";
import { TaskService } from "./api/task-service.js";
import { TaskStore } from "./api/task-store.js";
import type { OrchestratorConfig } from "./config.js";
import { configFromEnv } from "./config.js";
import { DshClient } from "./dsh/client.js";
import {
  createFileEventSink,
  createModelGateway,
  createStaticCredentialStore,
  denyAllPolicyResolver,
  loadGatewayPolicyFile,
  piAiProviderAdapter,
  providerCredentialEnvVars,
  readCredentialFile,
} from "./gateway/index.js";
import type { ModelGateway } from "./gateway/index.js";
import { resolveConfiguredModel } from "./pi/model.js";

export interface OrchestratorOptions {
  config: OrchestratorConfig;
  /**
   * Explicit model gateway (tests inject a scripted adapter behind real
   * gateway checks). Unset builds the deployment gateway from config; its
   * policy and credentials come only from the protected gateway files.
   */
  gateway?: ModelGateway;
  /** Explicit Pi model; unset resolves from config, then PI_UNAVAILABLE. */
  model?: Model<Api>;
}

export interface OrchestratorHandle {
  server: http.Server;
  service: TaskService;
  store: TaskStore;
  dsh: DshClient;
  gateway: ModelGateway;
  model: Model<Api> | undefined;
  /** Per-process bearer token callers must present on every API request. */
  apiToken: string;
  /** Start listening; resolves with the bound loopback address. */
  start(): Promise<{ host: string; port: number }>;
  /** Stop listening and release Pi sessions. */
  stop(): Promise<void>;
}

/**
 * The deployment model gateway: policy and credentials come from the
 * protected gateway files only.
 *
 * Deployment-layer direct-connection block: the orchestrator refuses to run
 * while provider credentials are present in the environment, because an
 * ambient env credential is exactly the bypass the gateway boundary exists to
 * prevent. Model egress without both gateway files fails closed — every
 * dispatch is denied.
 */
function deploymentGateway(config: OrchestratorConfig): ModelGateway {
  const ambient = providerCredentialEnvVars(process.env);
  if (ambient.length > 0) {
    throw new Error(
      `provider credentials must not be configured via the environment (found: ${ambient.join(", ")}); ` +
        "configure FORGEPILOT_GATEWAY_CREDENTIALS_FILE and unset these variables",
    );
  }
  const scope = { enterpriseId: config.enterpriseId, workspaceId: config.workspaceId };
  return createModelGateway({
    policyResolver: config.gatewayPolicyFile
      ? loadGatewayPolicyFile(config.gatewayPolicyFile, scope)
      : denyAllPolicyResolver,
    credentials: config.gatewayCredentialsFile
      ? readCredentialFile(config.gatewayCredentialsFile)
      : createStaticCredentialStore({}),
    adapter: piAiProviderAdapter,
    ...(config.gatewayAuditFile ? { sink: createFileEventSink(config.gatewayAuditFile) } : {}),
  });
}

/**
 * Composition root for the orchestrator process.
 *
 * Wires config → dsh client → gateway → task service → API server. Tests
 * construct the same handle with an injected gateway whose adapter is
 * scripted; every model call still passes the gateway's checks.
 */
export function createOrchestrator(options: OrchestratorOptions): OrchestratorHandle {
  const { config } = options;
  const store = new TaskStore(
    config.taskStateFile ? { persistencePath: config.taskStateFile } : {},
  );
  const dsh = new DshClient({
    socketPath: config.dshSocketPath,
    ...(config.dshTokenFile ? { tokenFile: config.dshTokenFile } : {}),
  });
  const model = options.model ?? resolveConfiguredModel(config);
  const gateway = options.gateway ?? deploymentGateway(config);
  const service = new TaskService({
    config,
    dsh,
    store,
    gateway,
    ...(model ? { model } : {}),
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
    gateway,
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
      return promise.then(async (bound) => {
        // Re-associate any persisted tasks with their dsh runs before the API
        // serves reads, so the first GET after a restart already reflects the
        // authoritative run state. Failures leave the projection as persisted:
        // recovery never fabricates an outcome dsh did not report.
        await service.recoverFromDsh().catch((error: unknown) => {
          console.error("task recovery skipped:", error);
        });
        return bound;
      });
    },
    stop: () => {
      service.disposeAll();
      // Durability boundary: a clean shutdown must not lose projected events.
      store.flushSync();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

export { buildOpenApiDocument, configFromEnv };
export * from "./gateway/index.js";

async function main(): Promise<void> {
  const config = configFromEnv();
  const orchestrator = createOrchestrator({ config });
  const { host, port } = await orchestrator.start();
  console.log(`forgepilot-api/v1 listening on http://${host}:${port}`);
  console.log(`dsh control plane: ${config.dshSocketPath}`);
  console.log(`API token file (Authorization: Bearer <token>): ${config.apiTokenFile}`);
  console.log(
    config.gatewayPolicyFile
      ? `model gateway: ${config.gatewayPolicyFile} (audit: ${config.gatewayAuditFile})`
      : "model gateway: no policy configured (all model calls fail closed)",
  );
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
