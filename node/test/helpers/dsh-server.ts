import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DshClient } from "../../src/dsh/client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const binaryPath = path.join(os.tmpdir(), `autofixer-dsh-${process.pid}`);

let buildPromise: Promise<string> | null = null;

/** Build the Go dsh server once per test process. */
function buildDshBinary(): Promise<string> {
  buildPromise ??= Promise.resolve().then(() => {
    execFileSync("go", ["build", "-o", binaryPath, "./cmd/autofixer"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return binaryPath;
  });
  return buildPromise;
}

export interface DshServerHandle {
  socketPath: string;
  client: DshClient;
  stop(): Promise<void>;
}

/**
 * Start the real Go dsh control plane on a private UDS.
 *
 * Integration tests talk to the actual M1 server so allow-list, grant, and
 * stop-condition behavior is the production behavior, not a re-implementation.
 */
export async function startDshServer(options: {
  approver: string;
  workspaceRoot?: string;
}): Promise<DshServerHandle> {
  const binary = await buildDshBinary();
  const socketPath = path.join(os.tmpdir(), `dsh-test-${randomUUID()}.sock`);
  const workspaceRoot = options.workspaceRoot ?? path.join(os.tmpdir(), `dsh-ws-${randomUUID()}`);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const child = spawn(
    binary,
    [
      "dsh",
      "serve",
      "--socket",
      socketPath,
      "--approver",
      options.approver,
      "--workspace-root",
      workspaceRoot,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

  const client = new DshClient({ socketPath });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited early (${child.exitCode}): ${stderr.join("")}`);
    }
    try {
      const health = await client.health();
      if (health.service === "dsh" && health.status === "ready") {
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`dsh did not become ready: ${stderr.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    socketPath,
    client,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.once("error", reject);
        child.kill("SIGTERM");
      }),
  };
}
