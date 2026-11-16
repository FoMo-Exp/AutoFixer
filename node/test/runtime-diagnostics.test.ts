import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTaskRecord } from "../src/api/task-store.js";
import { configFromEnv } from "../src/config.js";
import type { OrchestratorConfig } from "../src/config.js";
import { collectRuntimeDiagnostics, diagnoseEnvironment } from "../src/diagnostics/runtime.js";
import type { RuntimeDiagnostics } from "../src/diagnostics/runtime.js";
import { doctorExitCode } from "../src/doctor.js";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "../src/gateway/index.js";
import { createOrchestrator } from "../src/index.js";
import type { OrchestratorHandle } from "../src/index.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { startDshServer } from "./helpers/dsh-server.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import { TEST_MODEL } from "./helpers/scripted-stream.js";
import {
  TEST_CREDENTIAL,
  TEST_CREDENTIAL_REF,
  TEST_SCOPE,
  testPolicyFor,
} from "./helpers/test-gateway.js";

/**
 * Runtime configuration diagnostics (DAT-257): the report must be honest about
 * three separate boundaries, block clearly on missing configuration, never
 * carry a secret, and prove that a restart re-reads the same private state.
 */

const BASE_ENV = {
  FORGEPILOT_BASE_SHA: "abcdef1234567890",
  FORGEPILOT_REPOSITORY_ID: "github:FoMo-Exp/AutoFixer",
} satisfies NodeJS.ProcessEnv;

// The deployment gateway refuses ambient provider credentials at startup, so
// the process under test must not inherit the developer shell's keys.
const savedAmbientCredentials = new Map<string, string | undefined>(
  PROVIDER_CREDENTIAL_ENV_VARS.map((name) => [name, process.env[name]]),
);

beforeAll(() => {
  for (const name of PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name];
});

afterAll(() => {
  for (const [name, value] of savedAmbientCredentials) {
    if (value !== undefined) process.env[name] = value;
  }
});

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

function stateEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...BASE_ENV,
    FORGEPILOT_API_TOKEN_FILE: path.join(dir, "api-token"),
    FORGEPILOT_TASK_STATE_FILE: path.join(dir, "task-state.json"),
    FORGEPILOT_GATEWAY_AUDIT_FILE: path.join(dir, "gateway-audit.jsonl"),
    FORGEPILOT_USAGE_LEDGER_FILE: path.join(dir, "usage-ledger.json"),
    FORGEPILOT_DASHBOARD_AUDIT_FILE: path.join(dir, "dashboard-audit.jsonl"),
    FORGEPILOT_SECURITY_CASE_STATE_FILE: path.join(dir, "security-cases.json"),
    FORGEPILOT_SECURITY_PAUSE_STATE_FILE: path.join(dir, "security-pauses.json"),
    FORGEPILOT_SECURITY_QUARANTINE_STATE_FILE: path.join(dir, "security-quarantine.json"),
    FORGEPILOT_SECURITY_RULE_STATE_FILE: path.join(dir, "security-rules.json"),
    FORGEPILOT_SECURITY_NOTIFICATIONS_FILE: path.join(dir, "security-notifications.jsonl"),
    FORGEPILOT_SECURITY_AUDIT_FILE: path.join(dir, "security-audit.jsonl"),
    FORGEPILOT_SECURITY_AUDIT_KEY_FILE: path.join(dir, "security-audit.key"),
  };
}

function checkById(report: RuntimeDiagnostics, id: string) {
  return report.checks.find((entry) => entry.id === id);
}

function writeGatewayFiles(
  dir: string,
  scopes: Array<{ enterpriseId: string; workspaceId: string }>,
): { policyFile: string; credentialsFile: string } {
  const policyFile = path.join(dir, "gateway-policy.json");
  const credentialsFile = path.join(dir, "gateway-credentials.json");
  writeFileSync(
    policyFile,
    JSON.stringify({
      policies: scopes.map((scope) => ({ scope, ...testPolicyFor(TEST_MODEL) })),
    }),
  );
  writeFileSync(credentialsFile, JSON.stringify({ [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL }), {
    mode: 0o600,
  });
  chmodSync(credentialsFile, 0o600);
  return { policyFile, credentialsFile };
}

describe("runtime diagnostics (DAT-257)", () => {
  test("invalid configuration blocks startup before any subsystem runs", async () => {
    const report = await diagnoseEnvironment({ FORGEPILOT_BASE_SHA: "not-a-sha" });
    expect(report.readiness.startup).toBe("blocked");
    expect(report.blockers).toContain("config");
    expect(checkById(report, "config")?.detail).toMatch(/FORGEPILOT_BASE_SHA/);
    expect(doctorExitCode(report)).toBe(2);
    expect(report.notes.join(" ")).toMatch(/no state file was read or written/);
  });

  test("an unavailable dsh blocks task readiness without exposing the boot token", async () => {
    const dir = tempDir("diagnostics-dsh");
    const socketPath = path.join(dir, "missing.sock");
    const tokenFile = `${socketPath}.token`;
    writeFileSync(tokenFile, "boot-token-value-0123456789");
    chmodSync(tokenFile, 0o600);
    const env = { ...stateEnv(dir), FORGEPILOT_DSH_SOCKET: socketPath };
    const report = await diagnoseEnvironment(env, { includePaths: true, dshTimeoutMs: 250 });
    expect(report.readiness.startup).not.toBe("blocked");
    expect(report.readiness.task).toBe("blocked");
    expect(checkById(report, "dsh")?.status).toBe("blocked");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("boot-token-value-0123456789");
    expect(serialized).toContain("missing.sock");
    expect(doctorExitCode(report)).toBe(1);
  });

  test("a missing dsh boot token names the startup action, not the token", async () => {
    const dir = tempDir("diagnostics-token");
    const env = { ...stateEnv(dir), FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock") };
    const report = await diagnoseEnvironment(env, { includePaths: false });
    const dsh = checkById(report, "dsh");
    expect(dsh?.status).toBe("blocked");
    expect(dsh?.detail).toMatch(/boot token file .* is missing/);
    expect(dsh?.next_action).toMatch(/dsh serve/);
  });

  test("ambient provider credentials block startup by name, never by value", async () => {
    const dir = tempDir("diagnostics-ambient");
    const secret = "sk-ant-supersecret-value-0123456789";
    const report = await diagnoseEnvironment({
      ...stateEnv(dir),
      FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
      ANTHROPIC_API_KEY: secret,
    });
    expect(report.readiness.startup).toBe("blocked");
    expect(checkById(report, "gateway")?.status).toBe("blocked");
    expect(checkById(report, "gateway")?.detail).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(doctorExitCode(report)).toBe(2);
  });

  test("an invalid gateway policy blocks startup and model readiness", async () => {
    const dir = tempDir("diagnostics-gateway");
    const policyFile = path.join(dir, "policy.json");
    const credentialsFile = path.join(dir, "credentials.json");
    writeFileSync(policyFile, "{not json");
    writeFileSync(credentialsFile, JSON.stringify({ cred: "secret-value" }));
    chmodSync(credentialsFile, 0o600);
    const report = await diagnoseEnvironment({
      ...stateEnv(dir),
      FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
      FORGEPILOT_GATEWAY_POLICY_FILE: policyFile,
      FORGEPILOT_GATEWAY_CREDENTIALS_FILE: credentialsFile,
    });
    expect(checkById(report, "gateway")?.status).toBe("blocked");
    expect(report.readiness.startup).toBe("blocked");
    expect(report.readiness.model).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  test("an invalid budget policy blocks startup when configured", async () => {
    const dir = tempDir("diagnostics-budget");
    const policyFile = path.join(dir, "budget.json");
    writeFileSync(policyFile, JSON.stringify({ revision: "bad" }));
    const report = await diagnoseEnvironment({
      ...stateEnv(dir),
      FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
      FORGEPILOT_BUDGET_POLICY_FILE: policyFile,
      FORGEPILOT_BUDGET_STATE_FILE: path.join(dir, "budget.jsonl"),
    });
    expect(checkById(report, "budget")?.status).toBe("blocked");
    expect(report.readiness.startup).toBe("blocked");
  });

  test("a policy bound only to another workspace blocks model readiness", async () => {
    const dir = tempDir("diagnostics-egress-other");
    const files = writeGatewayFiles(dir, [{ enterpriseId: "ent_other", workspaceId: "ws_other" }]);
    const report = await diagnoseEnvironment(
      {
        ...stateEnv(dir),
        FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
        FORGEPILOT_GATEWAY_POLICY_FILE: files.policyFile,
        FORGEPILOT_GATEWAY_CREDENTIALS_FILE: files.credentialsFile,
      },
      { model: TEST_MODEL, resolveModel: false },
    );
    // File validity alone is not readiness: the policy parses, but no policy
    // binds the scope this deployment would dispatch from.
    expect(checkById(report, "gateway")?.status).toBe("ready");
    expect(checkById(report, "gateway")?.detail).toContain("ent_other/ws_other");
    expect(checkById(report, "egress")?.status).toBe("blocked");
    expect(checkById(report, "egress")?.detail).toMatch(/no policy/);
    expect(checkById(report, "egress")?.detail).toContain("ent_other/ws_other");
    expect(report.readiness.model).toBe("blocked");
    expect(JSON.stringify(report)).not.toContain(TEST_CREDENTIAL);
  });

  test("verified coverage for every active workspace is ready; extra workspaces degrade", async () => {
    const dir = tempDir("diagnostics-egress-active");
    const files = writeGatewayFiles(dir, [TEST_SCOPE]);
    const config = configFromEnv({
      ...stateEnv(dir),
      FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
      FORGEPILOT_ENTERPRISE_ID: TEST_SCOPE.enterpriseId,
      FORGEPILOT_WORKSPACE_ID: TEST_SCOPE.workspaceId,
      FORGEPILOT_GATEWAY_POLICY_FILE: files.policyFile,
      FORGEPILOT_GATEWAY_CREDENTIALS_FILE: files.credentialsFile,
    });

    const covered = await collectRuntimeDiagnostics({
      config,
      model: TEST_MODEL,
      resolveModel: false,
      activeWorkspaces: [TEST_SCOPE],
    });
    expect(checkById(covered, "egress")?.status).toBe("ready");
    expect(checkById(covered, "egress")?.detail).toContain("all 1 target scope");
    // The identity surface is absent, so no request carries an authenticated
    // egress scope: the boundary is degraded even though coverage is verified.
    expect(covered.readiness.model).toBe("degraded");

    const partial = await collectRuntimeDiagnostics({
      config,
      model: TEST_MODEL,
      resolveModel: false,
      activeWorkspaces: [
        TEST_SCOPE,
        { enterpriseId: TEST_SCOPE.enterpriseId, workspaceId: "ws_other" },
      ],
    });
    expect(checkById(partial, "egress")?.status).toBe("degraded");
    expect(checkById(partial, "egress")?.detail).toContain("ws_other: no policy");
    expect(partial.readiness.model).toBe("degraded");

    // With the identity surface present, verified coverage for every active
    // workspace is the only state that may report the model boundary ready.
    const oauthFile = path.join(dir, "oauth-clients.json");
    writeFileSync(
      oauthFile,
      JSON.stringify({
        "https://github.com": { client_id: "client-id", client_secret: "client-secret" },
      }),
      { mode: 0o600 },
    );
    chmodSync(oauthFile, 0o600);
    const identityConfig = configFromEnv({
      ...stateEnv(dir),
      FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
      FORGEPILOT_ENTERPRISE_ID: TEST_SCOPE.enterpriseId,
      FORGEPILOT_WORKSPACE_ID: TEST_SCOPE.workspaceId,
      FORGEPILOT_GATEWAY_POLICY_FILE: files.policyFile,
      FORGEPILOT_GATEWAY_CREDENTIALS_FILE: files.credentialsFile,
      FORGEPILOT_OAUTH_CLIENTS_FILE: oauthFile,
      FORGEPILOT_BOOTSTRAP_TOKEN: "bootstrap-token-0123456789abcdef0123456789",
      FORGEPILOT_CONTROL_PLANE_DB: path.join(dir, "control.sqlite"),
    });
    const ready = await collectRuntimeDiagnostics({
      config: identityConfig,
      model: TEST_MODEL,
      resolveModel: false,
      activeWorkspaces: [TEST_SCOPE],
    });
    expect(checkById(ready, "identity")?.status).toBe("ready");
    expect(checkById(ready, "egress")?.status).toBe("ready");
    expect(ready.readiness.model).toBe("ready");

    // The offline CLI probe cannot enumerate workspaces; with identity enabled
    // it must degrade coverage rather than claim readiness.
    const offline = await collectRuntimeDiagnostics({
      config: identityConfig,
      model: TEST_MODEL,
      resolveModel: false,
    });
    expect(checkById(offline, "egress")?.status).toBe("degraded");
    expect(checkById(offline, "egress")?.detail).toMatch(/coverage is unverified/);
    expect(offline.readiness.model).toBe("degraded");
  });

  test("unconfigured optional subsystems are explicit, not failures", async () => {
    const dir = tempDir("diagnostics-optional");
    const report = await diagnoseEnvironment({
      ...stateEnv(dir),
      FORGEPILOT_DSH_SOCKET: path.join(dir, "absent.sock"),
    });
    expect(checkById(report, "identity")?.status).toBe("not_configured");
    expect(checkById(report, "budget")?.status).toBe("not_configured");
    expect(checkById(report, "gateway")?.status).toBe("not_configured");
    expect(checkById(report, "model")?.status).toBe("not_configured");
    // Missing model/gateway deny model egress; that is a blocked model
    // boundary, never a "ready" claim.
    expect(report.readiness.model).toBe("blocked");
    expect(report.blockers).toContain("gateway");
    expect(report.service.single_instance).toBe(true);
    expect(report.notes.join(" ")).toMatch(/Single instance per state directory/);
  });
});

describe("runtime diagnostics over HTTP and across a restart (DAT-257)", () => {
  let dsh: DshServerHandle;
  const dir = tempDir("diagnostics-http");

  beforeAll(async () => {
    dsh = await startDshServer({ approver: "github:local-operator" });
  }, 120_000);

  afterAll(async () => {
    await dsh.stop();
  });

  function configFor(runDir: string): OrchestratorConfig {
    return configFromEnv({
      ...stateEnv(runDir),
      FORGEPILOT_DSH_SOCKET: dsh.socketPath,
    });
  }

  test("operator bearer reads the report; unauthenticated callers do not", async () => {
    const runDir = path.join(dir, "http");
    const orchestrator: OrchestratorHandle = createOrchestrator({ config: configFor(runDir) });
    const { host, port } = await orchestrator.start();
    const base = `http://${host}:${port}`;
    try {
      const unauthorized = await fetch(`${base}/api/v1/runtime/diagnostics`);
      expect(unauthorized.status).toBe(401);
      const response = await fetch(`${base}/api/v1/runtime/diagnostics`, {
        headers: { Authorization: `Bearer ${orchestrator.apiToken}` },
      });
      expect(response.status).toBe(200);
      const report = (await response.json()) as RuntimeDiagnostics;
      expect(report.readiness.startup).toBe("ready");
      expect(report.readiness.task).toBe("ready");
      expect(checkById(report, "dsh")?.status).toBe("ready");
      expect(report.service.pid).toBe(process.pid);
      // The API reports basenames, not deployment absolute paths.
      expect(checkById(report, "persistence")?.detail).not.toContain(runDir);
      expect(checkById(report, "persistence")?.detail).toContain("task-state.json");
    } finally {
      await orchestrator.stop();
    }
  }, 120_000);

  test("a workspace session cannot read deployment diagnostics", async () => {
    const app = await startAuthApp({ dsh });
    try {
      const session = await webLogin(app);
      const response = await fetch(`${app.base}/api/v1/runtime/diagnostics`, {
        headers: cookieSessionHeaders(session),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
    } finally {
      await app.stop();
    }
  }, 120_000);

  test("restart restores the same private task projection", async () => {
    const runDir = path.join(dir, "restart");
    const config = configFor(runDir);
    const task = createTaskRecord({
      id: "tsk_restart_1",
      workspaceId: config.workspaceId,
      enterpriseId: config.enterpriseId,
      repository: {
        id: config.repositoryId,
        display_name: "FoMo-Exp/AutoFixer",
        base_ref: config.baseRef,
        base_sha: config.baseSha,
      },
      summary: "restart baseline",
      sourceReference: null,
      acceptanceCriteria: [],
    });

    const first = createOrchestrator({ config });
    await first.start();
    first.store.put(task);
    first.store.flushSync();
    const firstReport = await first.diagnostics();
    expect(firstReport.readiness.task).toBe("ready");
    expect(checkById(firstReport, "persistence")?.detail).toMatch(/restore point with 1 task/);
    await first.stop();

    const second = createOrchestrator({ config: configFor(runDir) });
    await second.start();
    try {
      expect(second.store.get(task.id)?.summary).toBe("restart baseline");
      const secondReport = await second.diagnostics();
      expect(secondReport.readiness.startup).toBe("ready");
      expect(secondReport.readiness.task).toBe("ready");
      expect(checkById(secondReport, "persistence")?.detail).toMatch(/restore point with 1 task/);
      expect(secondReport.service.started_at).not.toBe(firstReport.service.started_at);
    } finally {
      await second.stop();
    }
  }, 120_000);

  test("a corrupt task projection blocks startup readiness and names recovery", async () => {
    const runDir = path.join(dir, "corrupt");
    mkdirSync(runDir, { recursive: true });
    const config = configFor(runDir);
    writeFileSync(config.taskStateFile as string, "{broken");
    chmodSync(config.taskStateFile as string, 0o600);
    const report = await collectRuntimeDiagnostics({ config, includePaths: true });
    expect(checkById(report, "persistence")?.status).toBe("blocked");
    expect(report.readiness.startup).toBe("blocked");
    expect(checkById(report, "persistence")?.next_action).toMatch(/Move .* aside/);
  }, 120_000);
});
