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

/**
 * A launch problem the operator can fix with a concrete action. The message is
 * shown verbatim in the workbench startup banner, so it must stay actionable
 * and must never include credentials.
 */
export class NodeServiceStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeServiceStartupError";
  }
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
  const tokenFile = /API token file .*:\s+(\S.*)$/i.exec(line);
  const apiBaseUrl = listening ? normalizeUnbracketedIpv6Url(listening[1]) : undefined;
  return {
    ...(apiBaseUrl && isLoopbackApiUrl(apiBaseUrl) ? { apiBaseUrl } : {}),
    ...(tokenFile ? { apiTokenFile: tokenFile[1].trim() } : {}),
  };
}

function normalizeUnbracketedIpv6Url(value: string): string {
  const match = /^http:\/\/(::1):(\d+)(\/.*)?$/i.exec(value);
  if (!match) return value;
  return `http://[${match[1]}]:${match[2]}${match[3] ?? ""}`;
}

export function resolveNodeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env["FORGEPILOT_NODE_EXECUTABLE"]?.trim() || "node";
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
  if (!existsSync(nodeEntry)) {
    throw new NodeServiceStartupError(
      'ForgePilot Node service entrypoint was not found. Build it with "cd node && npm run build", or point FORGEPILOT_API_URL / FORGEPILOT_API_PORT at an already running loopback service, set FORGEPILOT_API_DISCOVERY_FILE to its discovery file, or set FORGEPILOT_NODE_ENTRY to a built entrypoint.',
    );
  }
  if (!/^[0-9a-fA-F]{7,40}$/.test(env["FORGEPILOT_BASE_SHA"] ?? "")) {
    throw new NodeServiceStartupError(
      "Set FORGEPILOT_BASE_SHA to the repository base commit (7–40 hexadecimal characters) before starting the local Node service.",
    );
  }
  return spawnAndDiscover(nodeEntry, env);
}

function configuredService(env: NodeJS.ProcessEnv): DiscoveredNodeService | undefined {
  const apiBaseUrl = env["FORGEPILOT_API_URL"]?.trim();
  const port = env["FORGEPILOT_API_PORT"]?.trim();
  const candidate = apiBaseUrl || (port ? `http://127.0.0.1:${port}` : "");
  if (!candidate) return undefined;
  if (!isLoopbackApiUrl(candidate)) {
    throw new NodeServiceStartupError("FORGEPILOT_API_URL must be an HTTP loopback URL.");
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
  const child = spawn(resolveNodeExecutable(env), [nodeEntry], {
    cwd: env["FORGEPILOT_NODE_WORKDIR"] || path.dirname(nodeEntry),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let apiBaseUrl: string | undefined;
    let apiTokenFile = env["FORGEPILOT_API_TOKEN_FILE"];
    let stdoutBuffer = "";
    let stderrBuffer = "";
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
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-8192);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled)
        finish(new NodeServiceStartupError(startupFailureMessage(stderrBuffer, code)));
    });
  });
}

function startupFailureMessage(stderr: string, code: number | null): string {
  if (/Unknown Pi model\s+[^\r\n]+/i.test(stderr)) {
    return "The selected provider/model ID is not supported by the orchestrator. Update it in Settings.";
  }
  if (/FORGEPILOT_PI_BASE_URL/i.test(stderr)) {
    return "The model API base URL is invalid. Review it in Settings.";
  }
  return `ForgePilot Node service exited before discovery (${code ?? "unknown"}).`;
}
