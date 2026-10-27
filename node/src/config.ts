import path from "node:path";

import { isLoopbackHost } from "./api/auth.js";

/** Runtime configuration for the orchestrator, sourced from the environment. */
export interface OrchestratorConfig {
  /** dsh control-plane socket (unix socket path or Windows pipe name). */
  dshSocketPath: string;
  /** dsh boot-token file; defaults to `<dshSocketPath>.token`. */
  dshTokenFile?: string;
  /** Loopback bind host for the product API. Never a non-loopback address. */
  apiHost: string;
  /** Loopback bind port; 0 picks an ephemeral port. */
  apiPort: number;
  /** Per-process API bearer-token file (0600, user-private directory). */
  apiTokenFile: string;
  /** Repository the pilot fronts; dsh only accepts the AutoFixer repository. */
  repositoryId: string;
  repositoryUrl: string;
  baseRef: string;
  /** Base revision the pilot operates on; resolved at config time, not per task. */
  baseSha: string;
  /** Operator identity recorded on runs, approvals, and cancellations. */
  actorId: string;
  actorDisplayName: string;
  /** Identity dsh authorizes for approvals/cancellations (must match dsh --approver). */
  approverIdentity: string;
  /** Repository-relative roots granted to tasks. */
  pathHints: string[];
  /** dsh tool identities tasks may request. */
  toolCapabilities: string[];
  /** Wall-clock bound requested for each run, in seconds. */
  maxWallClockSeconds: number;
  /** Pi model provider and id; both unset means PI_UNAVAILABLE. */
  piModelProvider?: string;
  piModelId?: string;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function defaultSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\autofixer-dsh-control";
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `dsh-${uid}`, "dsh-control.sock");
}

function defaultApiTokenPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, "api-token");
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const repositoryId = env["FORGEPILOT_REPOSITORY_ID"] ?? "github:Luthiel/AutoFixer";
  const idMatch = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repositoryId);
  if (!idMatch) {
    throw new Error(
      `FORGEPILOT_REPOSITORY_ID must look like github:<owner>/<repo>, got ${repositoryId}`,
    );
  }
  const baseSha = env["FORGEPILOT_BASE_SHA"] ?? "";
  if (!/^[0-9a-fA-F]{7,40}$/.test(baseSha)) {
    throw new Error("FORGEPILOT_BASE_SHA must be a hexadecimal commit id (7-40 chars)");
  }
  const apiHost = env["FORGEPILOT_API_HOST"] ?? "127.0.0.1";
  // The contract binds the product API to an ephemeral loopback address; a
  // non-loopback bind would expose an approval-capable surface off-host.
  if (!isLoopbackHost(apiHost)) {
    throw new Error(
      `FORGEPILOT_API_HOST must be a loopback address (127.0.0.1, localhost, ::1), got ${apiHost}`,
    );
  }
  const config: OrchestratorConfig = {
    dshSocketPath: env["FORGEPILOT_DSH_SOCKET"] ?? defaultSocketPath(),
    apiHost,
    apiPort: positiveInt(env["FORGEPILOT_API_PORT"], 0, "FORGEPILOT_API_PORT"),
    apiTokenFile: env["FORGEPILOT_API_TOKEN_FILE"] ?? defaultApiTokenPath(),
    repositoryId,
    repositoryUrl: `https://github.com/${idMatch[1]}/${idMatch[2]}.git`,
    baseRef: env["FORGEPILOT_BASE_REF"] ?? "main",
    baseSha,
    actorId: env["FORGEPILOT_ACTOR_ID"] ?? "usr_forgepilot_local",
    actorDisplayName: env["FORGEPILOT_ACTOR_DISPLAY_NAME"] ?? "ForgePilot Local Operator",
    approverIdentity: env["FORGEPILOT_APPROVER_IDENTITY"] ?? "github:local-operator",
    pathHints: csv(env["FORGEPILOT_PATH_HINTS"], ["node"]),
    toolCapabilities: csv(env["FORGEPILOT_TOOL_CAPABILITIES"], ["echo", "sleep"]),
    maxWallClockSeconds: positiveInt(
      env["FORGEPILOT_MAX_WALL_CLOCK_SECONDS"],
      120,
      "FORGEPILOT_MAX_WALL_CLOCK_SECONDS",
    ),
  };
  if (env["FORGEPILOT_DSH_TOKEN_FILE"]) {
    config.dshTokenFile = env["FORGEPILOT_DSH_TOKEN_FILE"];
  }
  if (env["FORGEPILOT_PI_PROVIDER"] && env["FORGEPILOT_PI_MODEL"]) {
    config.piModelProvider = env["FORGEPILOT_PI_PROVIDER"];
    config.piModelId = env["FORGEPILOT_PI_MODEL"];
  }
  return config;
}
