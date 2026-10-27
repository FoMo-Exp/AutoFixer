import assert from "node:assert/strict";
import process from "node:process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "forgepilot-electron-node-"));
let service;
let proxy;

try {
  const [{ discoverNodeService }, { createApiProxy }] = await Promise.all([
    import("../dist-electron/service-discovery.js"),
    import("../dist-electron/api-proxy.js"),
  ]);
  const env = {
    ...process.env,
    FORGEPILOT_BASE_SHA: "0000000000000000000000000000000000000000",
    FORGEPILOT_API_TOKEN_FILE: path.join(tempDir, "api-token"),
    FORGEPILOT_TASK_STATE_FILE: path.join(tempDir, "task-state.json"),
    FORGEPILOT_DSH_SOCKET: path.join(tempDir, "missing-dsh.sock"),
    FORGEPILOT_NODE_EXECUTABLE: process.env["FORGEPILOT_NODE_EXECUTABLE"] || "node",
    FORGEPILOT_API_HOST: "127.0.0.1",
  };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
    "FORGEPILOT_NODE_ENTRY",
    "FORGEPILOT_NODE_WORKDIR",
  ]) {
    delete env[name];
  }
  service = await discoverNodeService(env);
  assert.ok(service.apiBaseUrl, "Node service discovery should return a loopback URL");
  assert.ok(service.apiTokenFile, "Node service discovery should return its token file");

  proxy = createApiProxy({
    apiBaseUrl: service.apiBaseUrl,
    apiToken: readFileSync(service.apiTokenFile, "utf8").trim(),
    publish: () => undefined,
  });
  const response = await proxy.request({
    requestId: "2a5e79e0-5c42-4d91-a298-1f696f8274c1",
    url: `${service.apiBaseUrl}/api/v1/tasks`,
    method: "GET",
    headers: { Accept: "application/json", Origin: "null" },
  });
  assert.equal(response.status, 200, "Electron main-process proxy should reach the Node API");
  assert.deepEqual(JSON.parse(response.body || "{}"), { items: [], next_cursor: null });
  const runtime = process.versions.electron
    ? `Electron ${process.versions.electron}`
    : `Node ${process.version}`;
  process.stdout.write(`${runtime} proxy reached Node API at ${service.apiBaseUrl}\n`);
} finally {
  proxy?.dispose();
  if (service?.child) {
    const exited = once(service.child, "exit");
    service.child.kill();
    await exited;
  }
  rmSync(tempDir, { recursive: true, force: true });
}
