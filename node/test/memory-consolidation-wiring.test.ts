import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import type { OrchestratorConfig } from "../src/config.js";
import { configFromEnv } from "../src/config.js";
import {
  createModelGateway,
  createPatternSecretScanner,
  createStaticCredentialStore,
  denyAllPolicyResolver,
  piAiProviderAdapter,
} from "../src/gateway/index.js";
import { createOrchestrator } from "../src/index.js";
import { securityStubs } from "./helpers/test-gateway.js";

// ---------------------------------------------------------------------------
// Production wiring: the scheduled consolidation job is registered by the
// orchestrator itself, starts with the service, and stops with it.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "forgepilot-memory-wiring-"));
  dirs.push(dir);
  return dir;
}

function baseConfig(dir: string): OrchestratorConfig {
  return {
    dshSocketPath: path.join(dir, "dsh.sock"),
    apiHost: "127.0.0.1",
    apiPort: 0,
    apiTokenFile: path.join(dir, "api-token"),
    repositoryId: "github:Luthiel/AutoFixer",
    repositoryUrl: "https://github.com/Luthiel/AutoFixer.git",
    baseRef: "main",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    actorId: "usr_test_operator",
    actorDisplayName: "Test Operator",
    approverIdentity: "github:test-approver",
    enterpriseId: "ent_test",
    workspaceId: "ws_test",
    pathHints: ["node"],
    toolCapabilities: ["echo"],
    maxWallClockSeconds: 60,
  };
}

/** Owner-only OAuth client file; an empty map is a valid local deployment. */
function credentialsFile(dir: string): string {
  const file = path.join(dir, "oauth-clients.json");
  writeFileSync(file, JSON.stringify({}), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function testGateway() {
  return createModelGateway({
    policyResolver: denyAllPolicyResolver,
    credentials: createStaticCredentialStore({}),
    adapter: piAiProviderAdapter,
    scanner: createPatternSecretScanner(),
    ...securityStubs(),
  });
}

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("orchestrator consolidation wiring", () => {
  test("registers the consolidation runner with the identity control plane", () => {
    const dir = tempDir();
    const config = { ...baseConfig(dir), oauthClientsFile: credentialsFile(dir) };
    const orchestrator = createOrchestrator({ config, gateway: testGateway() });
    expect(orchestrator.memoryConsolidation).toBeDefined();
    // A manual tick over an empty control plane is a clean no-op.
    expect(() => orchestrator.memoryConsolidation?.tick()).not.toThrow();
  });

  test("has no consolidation runner without the control plane", () => {
    const dir = tempDir();
    const orchestrator = createOrchestrator({ config: baseConfig(dir), gateway: testGateway() });
    expect(orchestrator.memoryConsolidation).toBeUndefined();
  });

  test("starts the schedule with the service and stops it on shutdown", async () => {
    const dir = tempDir();
    const config = {
      ...baseConfig(dir),
      oauthClientsFile: credentialsFile(dir),
      memoryConsolidationIntervalMs: 60 * 60 * 1000,
    };
    const orchestrator = createOrchestrator({ config, gateway: testGateway() });
    const bound = await orchestrator.start();
    expect(bound.port).toBeGreaterThan(0);
    // Shutdown stops the consolidation schedule before closing the store.
    await orchestrator.stop();
  });

  test("reads the consolidation cadence from the environment", () => {
    const config = configFromEnv({
      FORGEPILOT_BASE_SHA: "0123456",
      FORGEPILOT_MEMORY_CONSOLIDATION_INTERVAL_MS: "900000",
    });
    expect(config.memoryConsolidationIntervalMs).toBe(900000);
    expect(() =>
      configFromEnv({
        FORGEPILOT_BASE_SHA: "0123456",
        FORGEPILOT_MEMORY_CONSOLIDATION_INTERVAL_MS: "-1",
      }),
    ).toThrow(/FORGEPILOT_MEMORY_CONSOLIDATION_INTERVAL_MS/);
  });
});
