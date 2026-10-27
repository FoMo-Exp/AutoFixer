import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { clearTimeout as clearTimer, setTimeout as setTimer } from "node:timers";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "forgepilot-electron-window-"));
const electronArchive = process.env["ELECTRON_ARCHIVE"];
if (electronArchive) {
  try {
    execFileSync("unzip", ["-q", electronArchive, "-d", tempDir], { stdio: "pipe" });
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
const electronCommand =
  process.env["ELECTRON_BINARY"] ||
  (electronArchive
    ? path.join(
        tempDir,
        process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
      )
    : path.join(webRoot, "node_modules", ".bin", "electron"));
const mainEntry = path.join(webRoot, "dist-electron", "main.js");
const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
let dsh;
let nodeService;

try {
  const dshBinary = path.join(tempDir, "autofixer-dsh");
  execFileSync("go", ["build", "-o", dshBinary, "./cmd/autofixer"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const socketPath = path.join(tempDir, "dsh-control.sock");
  const workspaceRoot = path.join(tempDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  dsh = spawn(
    dshBinary,
    [
      "dsh",
      "serve",
      "--socket",
      socketPath,
      "--approver",
      "github:local-operator",
      "--workspace-root",
      workspaceRoot,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const dshErrors = [];
  dsh.stderr.on("data", (chunk) => dshErrors.push(chunk.toString("utf8")));

  const { DshClient } = await import(
    pathToFileURL(path.join(repoRoot, "node", "dist", "src", "dsh", "client.js")).href
  );
  const dshClient = new DshClient({ socketPath });
  await waitForDsh(dsh, dshClient, dshErrors);

  const tokenFile = path.join(tempDir, "api-token");
  const serviceEnv = {
    ...process.env,
    FORGEPILOT_BASE_SHA: baseSha,
    FORGEPILOT_REPOSITORY_ID: "github:Luthiel/AutoFixer",
    FORGEPILOT_DSH_SOCKET: socketPath,
    FORGEPILOT_API_TOKEN_FILE: tokenFile,
    FORGEPILOT_TASK_STATE_FILE: path.join(tempDir, "task-state.json"),
    FORGEPILOT_NODE_ENTRY: path.join(repoRoot, "node", "dist", "src", "index.js"),
    FORGEPILOT_NODE_WORKDIR: path.join(repoRoot, "node"),
    FORGEPILOT_NODE_EXECUTABLE: process.execPath,
    FORGEPILOT_API_HOST: "127.0.0.1",
  };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
    "FORGEPILOT_API_STARTUP_ERROR",
  ]) {
    delete serviceEnv[name];
  }

  const { discoverNodeService } = await import(
    pathToFileURL(path.join(webRoot, "dist-electron", "service-discovery.js")).href
  );
  nodeService = await discoverNodeService(serviceEnv);
  if (!nodeService.apiBaseUrl || !nodeService.apiTokenFile) {
    throw new Error("The real Node service did not publish its API URL and token file.");
  }

  await runElectron({
    ...serviceEnv,
    FORGEPILOT_API_URL: nodeService.apiBaseUrl,
    FORGEPILOT_API_TOKEN_FILE: nodeService.apiTokenFile,
    FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1",
  });
  process.stdout.write("Real Electron window + Node REST/SSE smoke passed.\n");

  const startupEnv = { ...serviceEnv, FORGEPILOT_ELECTRON_WINDOW_SMOKE: "1" };
  for (const name of [
    "FORGEPILOT_API_URL",
    "FORGEPILOT_API_PORT",
    "FORGEPILOT_API_DISCOVERY_FILE",
    "FORGEPILOT_API_TOKEN",
    "FORGEPILOT_API_TOKEN_FILE",
    "FORGEPILOT_BASE_SHA",
    "FORGEPILOT_NODE_ENTRY",
    "FORGEPILOT_NODE_WORKDIR",
  ]) {
    delete startupEnv[name];
  }
  await runElectron(startupEnv);
  process.stdout.write("Default-startup configuration guidance smoke passed.\n");
} finally {
  await stopChild(nodeService?.child);
  await stopChild(dsh);
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForDsh(child, client, errorChunks) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited early (${child.exitCode}): ${errorChunks.join("")}`);
    }
    try {
      const health = await client.health();
      if (health.service === "dsh" && health.status === "ready") return;
    } catch {
      // The socket is not accepting requests until dsh finishes startup.
    }
    await new Promise((resolve) => setTimer(resolve, 50));
  }
  throw new Error(`dsh did not become ready: ${errorChunks.join("")}`);
}

async function runElectron(env) {
  await new Promise((resolve, reject) => {
    const child = spawn(electronCommand, [mainEntry], {
      cwd: webRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
    let timedOut = false;
    let forceKillTimeout;
    const timeout = setTimer(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimer(() => child.kill("SIGKILL"), 5000);
    }, 30_000);
    child.once("error", (error) => {
      clearTimer(timeout);
      if (forceKillTimeout) clearTimer(forceKillTimeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimer(timeout);
      if (forceKillTimeout) clearTimer(forceKillTimeout);
      if (timedOut) {
        reject(new Error("Electron window smoke timed out."));
        return;
      }
      const output = stdout.join("");
      const errors = stderr.join("");
      if (code === 0 && output.includes("Electron window smoke passed:")) {
        process.stdout.write(output);
        if (errors) process.stderr.write(errors);
        resolve();
      } else {
        reject(
          new Error(
            `Electron exited with code ${code ?? "null"} (${signal ?? "no signal"}).\n${output}${errors}`,
          ),
        );
      }
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
