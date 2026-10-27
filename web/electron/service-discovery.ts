import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DiscoveredNodeService {
  apiBaseUrl: string;
  apiTokenFile?: string;
  apiToken?: string;
  child?: ChildProcess;
}

interface DiscoveryRecord {
  api_url?: unknown;
  url?: unknown;
  api_token_file?: unknown;
  token_file?: unknown;
}

export function isLoopbackApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function parseNodeServiceLine(line: string): {
  apiBaseUrl?: string;
  apiTokenFile?: string;
} {
  const listening = /forgepilot-api\/v1 listening on (https?:\/\/\S+)/i.exec(line);
  const tokenFile = /API token file .*:\s*(\S.*)$/i.exec(line);
  return {
    ...(listening && isLoopbackApiUrl(listening[1]) ? { apiBaseUrl: listening[1] } : {}),
    ...(tokenFile ? { apiTokenFile: tokenFile[1].trim() } : {}),
  };
}

export async function discoverNodeService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredNodeService> {
  const configured = configuredService(env);
  if (configured) return configured;

  const discoveryFile = env["FORGEPILOT_API_DISCOVERY_FILE"];
  if (discoveryFile) {
    const discovered = readDiscoveryFile(discoveryFile);
    if (discovered) return discovered;
  }

  const defaultEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../node/dist/src/index.js",
  );
  const nodeEntry = env["FORGEPILOT_NODE_ENTRY"]?.trim() || defaultEntry;
  if (!existsSync(nodeEntry)) return { apiBaseUrl: "" };
  return spawnAndDiscover(nodeEntry, env);
}

function configuredService(env: NodeJS.ProcessEnv): DiscoveredNodeService | undefined {
  const apiBaseUrl = env["FORGEPILOT_API_URL"]?.trim();
  const port = env["FORGEPILOT_API_PORT"]?.trim();
  const candidate = apiBaseUrl || (port ? `http://127.0.0.1:${port}` : "");
  if (!candidate) return undefined;
  if (!isLoopbackApiUrl(candidate)) {
    throw new Error("FORGEPILOT_API_URL must be an HTTP loopback URL.");
  }
  return {
    apiBaseUrl: candidate.replace(/\/$/, ""),
    ...(env["FORGEPILOT_API_TOKEN_FILE"] ? { apiTokenFile: env["FORGEPILOT_API_TOKEN_FILE"] } : {}),
    ...(env["FORGEPILOT_API_TOKEN"] ? { apiToken: env["FORGEPILOT_API_TOKEN"] } : {}),
  };
}

function readDiscoveryFile(filePath: string): DiscoveredNodeService | undefined {
  try {
    const record = JSON.parse(readFileSync(filePath, "utf8")) as DiscoveryRecord;
    const apiBaseUrl = typeof record.api_url === "string" ? record.api_url : record.url;
    const tokenFileCandidate =
      typeof record.api_token_file === "string" ? record.api_token_file : record.token_file;
    const apiTokenFile = typeof tokenFileCandidate === "string" ? tokenFileCandidate : undefined;
    if (typeof apiBaseUrl !== "string" || !isLoopbackApiUrl(apiBaseUrl)) return undefined;
    return {
      apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
      ...(apiTokenFile ? { apiTokenFile } : {}),
    };
  } catch {
    return undefined;
  }
}

function spawnAndDiscover(
  nodeEntry: string,
  env: NodeJS.ProcessEnv,
): Promise<DiscoveredNodeService> {
  const child = spawn(process.execPath, [nodeEntry], {
    cwd: env["FORGEPILOT_NODE_WORKDIR"] || path.dirname(nodeEntry),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let apiBaseUrl: string | undefined;
    let apiTokenFile = env["FORGEPILOT_API_TOKEN_FILE"];
    let stdoutBuffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while discovering the local ForgePilot Node service."));
    }, 10_000);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill();
        reject(error);
        return;
      }
      resolve({ apiBaseUrl: apiBaseUrl ?? "", ...(apiTokenFile ? { apiTokenFile } : {}), child });
    };

    const consume = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const found = parseNodeServiceLine(line);
        apiBaseUrl ??= found.apiBaseUrl;
        apiTokenFile ??= found.apiTokenFile;
        if (apiBaseUrl && apiTokenFile) finish();
      }
    };

    child.stdout.on("data", consume);
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled)
        finish(
          new Error(`ForgePilot Node service exited before discovery (${code ?? "unknown"}).`),
        );
    });
  });
}
