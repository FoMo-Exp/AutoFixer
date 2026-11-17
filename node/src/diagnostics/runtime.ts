import fs from "node:fs";
import path from "node:path";

import type { Api, Model } from "@mariozechner/pi-ai";

import type { OrchestratorConfig } from "../config.js";
import { configFromEnv } from "../config.js";
import { DshClient } from "../dsh/client.js";
import { redactSensitiveText } from "../errors/redact.js";
import {
  matchEndpoint,
  parseScopedPolicies,
  providerCredentialEnvVars,
  readCredentialFile,
} from "../gateway/index.js";
import type {
  GatewayCredentialStore,
  GatewayScope,
  ScopedPolicyBinding,
} from "../gateway/index.js";
import { loadBudgetPolicyFile } from "../budget/index.js";
import { resolveConfiguredModel } from "../pi/model.js";
import { readOAuthCredentialsFile } from "../api/oauth.js";
import { readServiceCredentialFile } from "../provider-access/credentials.js";

/**
 * Runtime configuration diagnostics (DAT-257).
 *
 * The report answers one question at three boundaries — can the process run,
 * can it start a remediation run, can it dispatch model bytes — from the
 * deployment's own configuration and state files. It is safe to serve and to
 * print because it contains no secret material:
 *
 * - no token, credential, client secret, bootstrap token, or key bytes are
 *   ever read into the report; file checks use stat/parse only where a file is
 *   configuration, and the parsed values are reduced to counts and file modes;
 * - provider credential *names* present in the ambient environment are
 *   reported (the startup guard refuses them), never their values;
 * - every message is passed through the shared redactor, so a thrown parser
 *   error cannot smuggle a secret into the report.
 *
 * Read-only by construction: the probes never create, truncate, or repair a
 * state file. A missing state directory is reported as `ready` with
 * "will be created" only when its nearest existing ancestor is writable.
 */

export const RUNTIME_COMPONENT_IDS = [
  "config",
  "dsh",
  "repository",
  "model",
  "gateway",
  "egress",
  "identity",
  "persistence",
  "budget",
] as const;
export type RuntimeComponentId = (typeof RUNTIME_COMPONENT_IDS)[number];

export const DIAGNOSTIC_STATUSES = ["ready", "degraded", "blocked", "not_configured"] as const;
export type DiagnosticStatus = (typeof DIAGNOSTIC_STATUSES)[number];

export const READINESS_STAGES = ["startup", "task", "model"] as const;
export type ReadinessStage = (typeof READINESS_STAGES)[number];

export const READINESS_STATUSES = ["ready", "degraded", "blocked"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export interface RuntimeDiagnosticCheck {
  id: RuntimeComponentId;
  /** Human-facing subsystem name. Never a credential or secret. */
  label: string;
  status: DiagnosticStatus;
  /** Readiness boundaries this component gates. */
  stages: ReadinessStage[];
  /** Redacted, non-secret evidence for the status. */
  detail: string;
  /** Operator action that changes the status; null when nothing is wrong. */
  next_action: string | null;
}

export interface RuntimeReadiness {
  startup: ReadinessStatus;
  task: ReadinessStatus;
  model: ReadinessStatus;
}

export interface RuntimeDiagnostics {
  service: {
    name: string;
    version: string;
    pid: number;
    started_at: string;
    uptime_seconds: number;
    /**
     * One process per state directory. The task projection, budget journal,
     * control-plane database, and append-only audit streams are single-writer;
     * a second orchestrator pointed at the same files is unsupported.
     */
    single_instance: true;
  };
  readiness: RuntimeReadiness;
  checks: RuntimeDiagnosticCheck[];
  /** Component ids whose status blocks at least one readiness boundary. */
  blockers: string[];
  /** Safe operational notes (single-instance limits, optional subsystems). */
  notes: string[];
  generated_at: string;
}

export interface RuntimeDiagnosticsOptions {
  config: OrchestratorConfig;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Process identity seam for tests. */
  pid?: number;
  /** Process start time; the default is "now" for an out-of-process probe. */
  startedAt?: Date;
  /** Environment probed for provider-credential bypass; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * dsh probe. Defaults to a DshClient over the configured socket. Tests pass
   * a fake so an unavailable control plane is deterministic.
   */
  dsh?: Pick<DshClient, "health">;
  /**
   * Resolved Pi model. `undefined` means the deployment resolved no model;
   * omitting the option resolves it from config exactly as startup does.
   */
  model?: Model<Api> | undefined;
  /** Resolve the model from config (default true); tests inject a resolved model. */
  resolveModel?: boolean;
  /** dsh health probe deadline. */
  dshTimeoutMs?: number;
  /** Include absolute state paths (CLI) instead of basenames (API surface). */
  includePaths?: boolean;
  /**
   * Active workspaces the identity surface can authorize (live control-plane
   * rows). When provided, egress coverage is evaluated for every one of them;
   * an uncovered workspace makes model readiness degraded. Absent means the
   * offline probe cannot enumerate memberships and must say so rather than
   * claim readiness.
   */
  activeWorkspaces?: GatewayScope[];
}

interface StateFileSpec {
  path: string | undefined;
  kind: "json" | "jsonl" | "sqlite" | "file";
  role: string;
  /** Read at startup to restore state; a corrupt file blocks startup. */
  startupCritical: boolean;
  /** The service writes this file 0600; a laxer mode is a warning. */
  ownerOnly?: boolean;
}

const DSH_PROBE_TIMEOUT_MS = 1_500;

function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(text);
}

function fileMode(stat: fs.Stats): string {
  return `0${(stat.mode & 0o777).toString(8)}`;
}

function nearestExistingAncestor(target: string): string | undefined {
  let current = path.resolve(target);
  for (;;) {
    const parent = path.dirname(current);
    if (fs.existsSync(current)) return current;
    if (parent === current) return undefined;
    current = parent;
  }
}

function isWritableDirectory(directory: string): boolean {
  try {
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function displayPath(target: string, includePaths: boolean): string {
  return includePaths ? target : path.basename(target);
}

/**
 * Validate one state path without mutating it.
 *
 * Returns `{ status, detail }`; corrupt JSON on a startup-critical file is
 * `blocked` (the process cannot restore that state), a malformed append-only
 * log is `degraded` (the process starts, but evidence needs triage), and a
 * missing file is `ready` when its nearest existing ancestor is writable.
 */
function inspectStateFile(
  spec: StateFileSpec,
  includePaths: boolean,
): { status: DiagnosticStatus; detail: string; nextAction: string | null } {
  if (spec.path === undefined) {
    return { status: "not_configured", detail: `${spec.role}: not configured`, nextAction: null };
  }
  const target = spec.path;
  const shown = displayPath(target, includePaths);
  const parent = path.dirname(target);
  const ancestor = nearestExistingAncestor(parent);
  if (ancestor === undefined || !isWritableDirectory(ancestor)) {
    return {
      status: "blocked",
      detail: `${spec.role} (${shown}): state directory is not writable`,
      nextAction: `Make ${includePaths ? parent : "the state directory"} writable by the service user`,
    };
  }
  if (!fs.existsSync(target)) {
    return {
      status: "ready",
      detail: `${spec.role} (${shown}): absent; will be created on first write`,
      nextAction: null,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return {
      status: spec.startupCritical ? "blocked" : "degraded",
      detail: `${spec.role} (${shown}): ${safeMessage(error)}`,
      nextAction: `Inspect ${shown} and its permissions`,
    };
  }
  if (!stat.isFile()) {
    return {
      status: "blocked",
      detail: `${spec.role} (${shown}): not a regular file`,
      nextAction: `Replace ${shown} with a regular file owned by the service user`,
    };
  }
  if (spec.ownerOnly && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    return {
      status: "degraded",
      detail: `${spec.role} (${shown}): mode ${fileMode(stat)} is not owner-only`,
      nextAction: `chmod 600 ${shown}`,
    };
  }
  try {
    if (spec.kind === "json") {
      const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
      if (spec.role === "task projection" && typeof parsed === "object" && parsed !== null) {
        const state = parsed as { schema_version?: unknown; tasks?: unknown };
        const tasks = Array.isArray(state.tasks) ? state.tasks.length : 0;
        return {
          status: "ready",
          detail:
            `${spec.role} (${shown}): restore point with ${tasks} task(s), ` +
            `schema ${String(state.schema_version ?? "unknown")}`,
          nextAction: null,
        };
      }
      return { status: "ready", detail: `${spec.role} (${shown}): valid JSON`, nextAction: null };
    }
    if (spec.kind === "jsonl") {
      // Bound the read: an append-only audit log can be large, and a
      // diagnostics probe must not allocate it whole.
      const sampleBytes = 2 * 1024 * 1024;
      const sampled = stat.size > sampleBytes;
      let raw: string;
      if (sampled) {
        const buffer = Buffer.alloc(sampleBytes);
        const fd = fs.openSync(target, "r");
        try {
          raw = buffer.subarray(0, fs.readSync(fd, buffer, 0, sampleBytes, 0)).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        raw = raw.slice(0, raw.lastIndexOf("\n") + 1);
      } else {
        raw = fs.readFileSync(target, "utf8");
      }
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      for (const line of lines) {
        JSON.parse(line);
      }
      return {
        status: "ready",
        detail: `${spec.role} (${shown}): ${lines.length} record(s) parse${sampled ? " (first 2 MiB sampled)" : ""}`,
        nextAction: null,
      };
    }
    if (spec.kind === "sqlite") {
      const header = Buffer.alloc(16);
      const fd = fs.openSync(target, "r");
      try {
        fs.readSync(fd, header, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (header.toString("utf8") !== "SQLite format 3\u0000") {
        throw new Error("not a SQLite database");
      }
      return {
        status: "ready",
        detail: `${spec.role} (${shown}): valid SQLite database`,
        nextAction: null,
      };
    }
    return { status: "ready", detail: `${spec.role} (${shown}): readable`, nextAction: null };
  } catch (error) {
    return {
      status: spec.startupCritical ? "blocked" : "degraded",
      detail: `${spec.role} (${shown}): ${safeMessage(error)}`,
      nextAction: spec.startupCritical
        ? `Move ${shown} aside to start with empty state (persisted work is not recovered), or restore it from backup`
        : `Inspect or rotate ${shown}; the service can start but evidence needs triage`,
    };
  }
}

function check(
  id: RuntimeComponentId,
  label: string,
  stages: ReadinessStage[],
  fn: () => { status: DiagnosticStatus; detail: string; nextAction?: string | null },
): RuntimeDiagnosticCheck {
  try {
    const result = fn();
    return {
      id,
      label,
      status: result.status,
      stages,
      detail: redactSensitiveText(result.detail),
      next_action: result.nextAction ? redactSensitiveText(result.nextAction) : null,
    };
  } catch (error) {
    return {
      id,
      label,
      status: "blocked",
      stages,
      detail: redactSensitiveText(`${label}: ${safeMessage(error)}`),
      next_action: "Run `npm run doctor` after correcting the named configuration",
    };
  }
}

/** How a component status maps into one readiness boundary. */
function boundaryStatus(
  checks: RuntimeDiagnosticCheck[],
  stage: ReadinessStage,
  required: ReadonlySet<RuntimeComponentId>,
): ReadinessStatus {
  const gating = checks.filter((entry) => entry.stages.includes(stage));
  if (gating.some((entry) => entry.status === "blocked")) return "blocked";
  if (gating.some((entry) => entry.status === "not_configured" && required.has(entry.id))) {
    return "blocked";
  }
  if (gating.some((entry) => entry.status === "degraded")) return "degraded";
  return "ready";
}

const REQUIRED_BY_STAGE: Record<ReadinessStage, ReadonlySet<RuntimeComponentId>> = {
  startup: new Set<RuntimeComponentId>(["config"]),
  task: new Set<RuntimeComponentId>(["config", "dsh", "repository", "persistence"]),
  model: new Set<RuntimeComponentId>(["model", "gateway", "egress"]),
};

function serviceVersion(): string {
  // Version is informational; the package manifest is the single source. The
  // two candidates cover `src/diagnostics` (vitest) and `dist/src/diagnostics`
  // (built CLI) because ESM has no __dirname.
  for (const candidate of ["../../../package.json", "../../package.json"]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(new URL(candidate, import.meta.url), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // try the next layout
    }
  }
  return "unknown";
}

/**
 * Build the redacted runtime report. Every probe is bounded and read-only; the
 * function itself never throws for a subsystem failure — the failure becomes
 * the component's status.
 */
export async function collectRuntimeDiagnostics(
  options: RuntimeDiagnosticsOptions,
): Promise<RuntimeDiagnostics> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const generatedAt = now();
  const startedAt = options.startedAt ?? generatedAt;
  const includePaths = options.includePaths ?? false;
  const env = options.env ?? process.env;
  const checks: RuntimeDiagnosticCheck[] = [];

  // --- config -----------------------------------------------------------
  checks.push(
    check("config", "configuration", ["startup", "task"], () => {
      const problems: string[] = [];
      if (!/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repositoryId)) {
        problems.push("FORGEPILOT_REPOSITORY_ID must look like github:<owner>/<repo>");
      }
      if (!/^[0-9a-fA-F]{7,40}$/.test(config.baseSha)) {
        problems.push("FORGEPILOT_BASE_SHA must be a 7-40 character hexadecimal commit id");
      }
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.apiHost)) {
        problems.push("FORGEPILOT_API_HOST must be a loopback address");
      }
      if (problems.length > 0) {
        return {
          status: "blocked" as const,
          detail: problems.join("; "),
          nextAction: "Correct the named environment variables and restart",
        };
      }
      return {
        status: "ready" as const,
        detail:
          `${config.repositoryId} on ${config.baseRef}@${config.baseSha.slice(0, 12)}; ` +
          `workspace ${config.workspaceId}; API ${config.apiHost}:${config.apiPort}`,
      };
    }),
  );

  // --- repository / pinned base SHA ------------------------------------
  checks.push(
    check("repository", "repository and base revision", ["task"], () => {
      if (!/^[0-9a-fA-F]{7,40}$/.test(config.baseSha)) {
        return {
          status: "blocked" as const,
          detail: "no pinned base SHA",
          nextAction: "Set FORGEPILOT_BASE_SHA to the reviewed commit id",
        };
      }
      return {
        status: "ready" as const,
        detail:
          `${config.repositoryUrl} @ ${config.baseSha} (base ref ${config.baseRef}); ` +
          `${config.pathHints.length} path root(s), ${config.toolCapabilities.length} tool identit(ies); ` +
          `approver ${config.approverIdentity}`,
      };
    }),
  );

  // --- dsh --------------------------------------------------------------
  const tokenFile = config.dshTokenFile ?? `${config.dshSocketPath}.token`;
  const dshProbe =
    options.dsh ??
    new DshClient({
      socketPath: config.dshSocketPath,
      ...(config.dshTokenFile !== undefined ? { tokenFile: config.dshTokenFile } : {}),
    });
  const tokenStat = fs.existsSync(tokenFile)
    ? fs.statSync(tokenFile, { throwIfNoEntry: false })
    : undefined;
  const tokenProblem =
    tokenStat === undefined || !tokenStat.isFile()
      ? "is missing"
      : tokenStat.size === 0
        ? "is empty"
        : undefined;
  const tokenModeInsecure =
    tokenStat !== undefined &&
    tokenStat.isFile() &&
    process.platform !== "win32" &&
    (tokenStat.mode & 0o077) !== 0;
  let dshCheck: RuntimeDiagnosticCheck;
  if (tokenProblem !== undefined) {
    dshCheck = {
      id: "dsh",
      label: "dsh control plane",
      status: "blocked",
      stages: ["task"],
      detail: `socket ${config.dshSocketPath}; boot token file ${displayPath(tokenFile, includePaths)} ${tokenProblem}`,
      next_action: `Start dsh serve with --socket ${config.dshSocketPath} so it writes a boot token this user can read`,
    };
  } else {
    try {
      const health = await dshProbe.health(options.dshTimeoutMs ?? DSH_PROBE_TIMEOUT_MS);
      if (health.service !== "dsh") {
        dshCheck = {
          id: "dsh",
          label: "dsh control plane",
          status: "blocked",
          stages: ["task"],
          detail: `socket ${config.dshSocketPath}: unexpected health service ${JSON.stringify(health.service)}`,
          next_action: "Point FORGEPILOT_DSH_SOCKET at the dsh control socket",
        };
      } else {
        const modeNote = tokenModeInsecure
          ? `; boot token mode ${fileMode(tokenStat)} is not owner-only`
          : "; boot token present";
        dshCheck = {
          id: "dsh",
          label: "dsh control plane",
          status: health.status === "ready" && !tokenModeInsecure ? "ready" : "degraded",
          stages: ["task"],
          detail:
            `socket ${config.dshSocketPath}: ${health.status}; protocol ${health.protocol.default}; ` +
            `contract ${health.contract_version}; policy ${health.policy_version}${modeNote}`,
          next_action: tokenModeInsecure
            ? `chmod 600 ${includePaths ? tokenFile : displayPath(tokenFile, false)}`
            : health.status === "ready"
              ? null
              : "Inspect dsh logs; runs cannot start until it reports ready",
        };
      }
    } catch (error) {
      dshCheck = {
        id: "dsh",
        label: "dsh control plane",
        status: "blocked",
        stages: ["task"],
        detail: `socket ${config.dshSocketPath}: ${safeMessage(error)}`,
        next_action: `Start dsh serve with --socket ${config.dshSocketPath} (it binds local transport only)`,
      };
    }
  }
  checks.push(dshCheck);

  // Resolve the model and parse the gateway policy once: model readiness and
  // egress coverage must agree on the same destination.
  let resolvedModel: Model<Api> | undefined;
  let modelError: string | undefined;
  if (options.resolveModel === false) {
    resolvedModel = options.model;
  } else {
    try {
      resolvedModel = options.model ?? resolveConfiguredModel(config);
    } catch (error) {
      modelError = safeMessage(error);
    }
  }
  const gatewayConfigured =
    config.gatewayPolicyFile !== undefined && config.gatewayCredentialsFile !== undefined;
  let gatewayProbe: {
    bindings: ScopedPolicyBinding[];
    credentials?: GatewayCredentialStore;
    error?: string;
  } = { bindings: [] };
  if (gatewayConfigured) {
    try {
      // parseScopedPolicies is the same validator production startup uses:
      // per-binding schema plus scope uniqueness. Diagnostics must not accept
      // a policy set the loader would refuse.
      gatewayProbe = {
        bindings: parseScopedPolicies(
          JSON.parse(fs.readFileSync(config.gatewayPolicyFile as string, "utf8")),
        ),
        credentials: readCredentialFile(config.gatewayCredentialsFile as string),
      };
    } catch (error) {
      gatewayProbe = { bindings: [], error: safeMessage(error) };
    }
  }

  // --- model ------------------------------------------------------------
  checks.push(
    check("model", "Pi model", ["startup", "model"], () => {
      if (modelError !== undefined) {
        return {
          status: "blocked" as const,
          detail: modelError,
          nextAction:
            "Correct FORGEPILOT_PI_PROVIDER / FORGEPILOT_PI_MODEL / FORGEPILOT_PI_BASE_URL",
        };
      }
      if (resolvedModel === undefined) {
        return {
          status: "not_configured" as const,
          detail: "no Pi provider/model configured; tasks report PI_UNAVAILABLE",
          nextAction:
            "Set FORGEPILOT_PI_PROVIDER and FORGEPILOT_PI_MODEL (unset means PI_UNAVAILABLE)",
        };
      }
      return {
        status: "ready" as const,
        detail: `${resolvedModel.provider}/${resolvedModel.id}${resolvedModel.baseUrl ? ` via ${resolvedModel.baseUrl}` : ""}`,
      };
    }),
  );

  // --- gateway ----------------------------------------------------------
  checks.push(
    check("gateway", "model gateway", ["startup", "model"], () => {
      const ambient = providerCredentialEnvVars(env);
      if (ambient.length > 0) {
        return {
          status: "blocked" as const,
          detail: `provider credentials are present in the environment: ${ambient.join(", ")}`,
          nextAction:
            "Unset those variables and configure FORGEPILOT_GATEWAY_CREDENTIALS_FILE instead; the orchestrator refuses env credentials",
        };
      }
      if (!gatewayConfigured) {
        return {
          status: "not_configured" as const,
          detail: "no gateway policy/credentials configured; every model dispatch is denied",
          nextAction:
            "Set FORGEPILOT_GATEWAY_POLICY_FILE and FORGEPILOT_GATEWAY_CREDENTIALS_FILE together to enable model egress",
        };
      }
      if (gatewayProbe.error !== undefined) {
        return { status: "blocked" as const, detail: gatewayProbe.error };
      }
      const scopes = gatewayProbe.bindings
        .map((binding) => `${binding.scope.enterpriseId}/${binding.scope.workspaceId}`)
        .join(", ");
      return {
        status: "ready" as const,
        detail:
          `policy ${displayPath(config.gatewayPolicyFile as string, includePaths)} validated for ` +
          `${gatewayProbe.bindings.length} scope(s) [${scopes}]; ` +
          `credentials ${displayPath(config.gatewayCredentialsFile as string, includePaths)} owner-only; ` +
          `audit ${displayPath(config.gatewayAuditFile ?? "not configured", includePaths)}`,
      };
    }),
  );

  // --- egress coverage --------------------------------------------------
  // A syntactically valid policy proves nothing about the scope that will
  // dispatch: resolution is keyed by the authenticated enterprise/workspace
  // pair, so a policy set bound only to another workspace denies every call
  // here. Coverage is therefore evaluated per target scope and never inferred
  // from file validity.
  checks.push(
    check("egress", "model egress coverage", ["model"], () => {
      if (!gatewayConfigured) {
        return {
          status: "not_configured" as const,
          detail: "no gateway policy/credentials configured; no scope can dispatch",
        };
      }
      if (gatewayProbe.error !== undefined) {
        return {
          status: "blocked" as const,
          detail: `gateway configuration is invalid: ${gatewayProbe.error}`,
        };
      }
      if (modelError !== undefined || resolvedModel === undefined) {
        return {
          status: "not_configured" as const,
          detail: "no resolved model to match against the policy",
        };
      }
      const active = options.activeWorkspaces;
      const targets: GatewayScope[] =
        active !== undefined && active.length > 0
          ? active
          : [{ enterpriseId: config.enterpriseId, workspaceId: config.workspaceId }];
      const covered: string[] = [];
      const failures: string[] = [];
      for (const scope of targets) {
        const label = `${scope.enterpriseId}/${scope.workspaceId}`;
        const binding = gatewayProbe.bindings.find(
          (entry) =>
            entry.scope.enterpriseId === scope.enterpriseId &&
            entry.scope.workspaceId === scope.workspaceId,
        );
        if (binding === undefined) {
          failures.push(`${label}: no policy`);
          continue;
        }
        const match = matchEndpoint(binding.policy, resolvedModel);
        if ("deny" in match) {
          failures.push(`${label}: ${match.deny}`);
          continue;
        }
        if (gatewayProbe.credentials?.get(match.endpoint.credentialRef) === undefined) {
          failures.push(
            `${label}: credentialRef ${match.endpoint.credentialRef} is missing from the credentials file`,
          );
          continue;
        }
        covered.push(`${label}→${match.endpoint.endpointId}`);
      }
      const destination = `${resolvedModel.provider}/${resolvedModel.id}`;
      if (covered.length === 0) {
        return {
          status: "blocked" as const,
          detail:
            `policy scopes [${gatewayProbe.bindings.map((binding) => `${binding.scope.enterpriseId}/${binding.scope.workspaceId}`).join(", ") || "none"}]; ` +
            `${destination} is not dispatchable from any target scope: ${failures.join("; ")}; ` +
            "every such dispatch is denied MODEL_EGRESS_DENIED",
          nextAction: `Add or correct a policies entry for ${targets.map((scope) => `${scope.enterpriseId}/${scope.workspaceId}`).join(", ")} approving this model and an endpoint credential`,
        };
      }
      if (failures.length > 0) {
        return {
          status: "degraded" as const,
          detail:
            `verified ${covered.join(", ")}; ${failures.join("; ")}; ` +
            "dispatches from the failed scope(s) are denied MODEL_EGRESS_DENIED",
          nextAction: "Add the missing policy/endpoint/credential for the failed scope(s)",
        };
      }
      // Every target is covered. Without a live control-plane list the probe
      // cannot see workspaces created after the policy file, so an identity
      // deployment must not claim global readiness from an offline scan.
      if ((active === undefined || active.length === 0) && config.oauthClientsFile !== undefined) {
        return {
          status: "degraded" as const,
          detail:
            `verified ${covered.join(", ")} for the configured scope; active workspace ` +
            "coverage is unverified in this offline probe (session memberships may resolve to other scopes)",
          nextAction:
            "Run the API diagnostics while the service is running so live workspace coverage is verified",
        };
      }
      return {
        status: "ready" as const,
        detail: `verified ${covered.join(", ")} for all ${targets.length} target scope(s)`,
      };
    }),
  );

  // --- identity ---------------------------------------------------------
  checks.push(
    check("identity", "enterprise identity", ["startup", "model"], () => {
      if (config.oauthClientsFile === undefined) {
        return {
          status: "not_configured" as const,
          detail:
            "local-operator mode; sessions, invitations, and workspace membership are disabled, " +
            "so no request carries an authenticated model-egress scope",
          nextAction:
            "Set FORGEPILOT_OAUTH_CLIENTS_FILE + FORGEPILOT_BOOTSTRAP_TOKEN to enable session-scoped model egress",
        };
      }
      const credentials = readOAuthCredentialsFile(config.oauthClientsFile);
      if (config.bootstrapToken === undefined) {
        return {
          status: "blocked" as const,
          detail: "identity surfaces enabled without a bootstrap token",
          nextAction: "Set FORGEPILOT_BOOTSTRAP_TOKEN (min 32 characters) before starting",
        };
      }
      if (config.providerServiceCredentialFile !== undefined) {
        readServiceCredentialFile(config.providerServiceCredentialFile);
      }
      return {
        status: "ready" as const,
        detail:
          `identity surfaces enabled for ${credentials.size} provider origin(s); ` +
          `control plane ${displayPath(config.controlPlaneFile ?? "in-memory", includePaths)}; ` +
          `bootstrap token present`,
      };
    }),
  );

  // --- persistence ------------------------------------------------------
  const stateSpecs: StateFileSpec[] = [
    {
      path: config.taskStateFile,
      kind: "json",
      role: "task projection",
      startupCritical: true,
      ownerOnly: true,
    },
    {
      path: config.controlPlaneFile,
      kind: "sqlite",
      role: "identity control plane",
      startupCritical: true,
    },
    {
      path: config.gatewayAuditFile,
      kind: "jsonl",
      role: "gateway attempt audit",
      startupCritical: false,
    },
    { path: config.usageLedgerFile, kind: "json", role: "usage ledger", startupCritical: false },
    {
      path: config.budgetStateFile,
      kind: "jsonl",
      role: "budget journal",
      startupCritical: false,
    },
    {
      path: config.dashboardAuditFile,
      kind: "jsonl",
      role: "dashboard audit",
      startupCritical: false,
    },
    {
      path: config.securityCaseStateFile,
      kind: "json",
      role: "security cases",
      startupCritical: true,
    },
    {
      path: config.securityPauseStateFile,
      kind: "json",
      role: "security holds",
      startupCritical: true,
    },
    {
      path: config.securityQuarantineStateFile,
      kind: "json",
      role: "security quarantine",
      startupCritical: true,
    },
    {
      path: config.securityRuleStateFile,
      kind: "json",
      role: "security rules",
      startupCritical: true,
    },
    {
      path: config.securityNotificationsFile,
      kind: "jsonl",
      role: "security notifications",
      startupCritical: false,
    },
    {
      path: config.securityAuditFile,
      kind: "jsonl",
      role: "security audit",
      startupCritical: false,
    },
  ];
  checks.push(
    check("persistence", "durable state", ["startup", "task"], () => {
      const results = stateSpecs.map((spec) => ({
        spec,
        result: inspectStateFile(spec, includePaths),
      }));
      const blocked = results.filter((entry) => entry.result.status === "blocked");
      const degraded = results.filter((entry) => entry.result.status === "degraded");
      const configured = results.filter((entry) => entry.spec.path !== undefined);
      const detail = results
        .map((entry) => `${entry.spec.role}: ${entry.result.status} — ${entry.result.detail}`)
        .join("\n");
      if (blocked.length > 0) {
        return {
          status: "blocked" as const,
          detail,
          nextAction: blocked[0]?.result.nextAction ?? null,
        };
      }
      if (degraded.length > 0) {
        return {
          status: "degraded" as const,
          detail,
          nextAction: degraded[0]?.result.nextAction ?? null,
        };
      }
      return {
        status: "ready" as const,
        detail: `${configured.length} state path(s) usable; ${detail}`,
      };
    }),
  );

  // --- budget -----------------------------------------------------------
  checks.push(
    check("budget", "budget enforcement", ["startup", "model"], () => {
      if (config.budgetPolicyFile === undefined) {
        return {
          status: "not_configured" as const,
          detail: "no budget policy; invocations are explicitly unbudgeted (not zero-cost)",
          nextAction:
            "Set FORGEPILOT_BUDGET_POLICY_FILE (and optionally FORGEPILOT_BUDGET_STATE_FILE) to enforce limits",
        };
      }
      loadBudgetPolicyFile(config.budgetPolicyFile, {
        enterpriseId: config.enterpriseId,
        workspaceId: config.workspaceId,
      });
      return {
        status: "ready" as const,
        detail:
          `policy ${displayPath(config.budgetPolicyFile, includePaths)} validated for ` +
          `${config.enterpriseId}/${config.workspaceId}; journal ` +
          `${displayPath(config.budgetStateFile ?? "not configured", includePaths)}`,
      };
    }),
  );

  const readiness: RuntimeReadiness = {
    startup: boundaryStatus(checks, "startup", REQUIRED_BY_STAGE.startup),
    task: boundaryStatus(checks, "task", REQUIRED_BY_STAGE.task),
    model: boundaryStatus(checks, "model", REQUIRED_BY_STAGE.model),
  };
  // Identity is optional at startup but gates model egress (DAT-242): without
  // an authenticated workspace scope every dispatch is denied. Surface that as
  // degraded model readiness rather than silently "ready".
  if (readiness.model === "ready") {
    const identity = checks.find((entry) => entry.id === "identity");
    if (identity !== undefined && identity.status !== "ready") {
      readiness.model = "degraded";
    }
  }
  const blockers = checks.filter((entry) => entry.status === "blocked").map((entry) => entry.id);
  for (const stage of READINESS_STAGES) {
    if (readiness[stage] !== "blocked") continue;
    // A stage can be blocked by a not_configured required component (e.g. no
    // gateway files), which must still name the responsible checks.
    for (const entry of checks) {
      if (
        entry.stages.includes(stage) &&
        entry.status === "not_configured" &&
        REQUIRED_BY_STAGE[stage].has(entry.id) &&
        !blockers.includes(entry.id)
      ) {
        blockers.push(entry.id);
      }
    }
  }

  return {
    service: {
      name: "forgepilot-api/v1",
      version: serviceVersion(),
      pid: options.pid ?? process.pid,
      started_at: startedAt.toISOString(),
      uptime_seconds: Math.max(0, Math.floor((generatedAt.getTime() - startedAt.getTime()) / 1000)),
      single_instance: true,
    },
    readiness,
    checks,
    blockers,
    notes: [
      "Single instance per state directory: the task projection, budget journal, control-plane database, and JSONL audit streams are single-writer; do not point a second orchestrator at the same files.",
      "A blocked startup refuses to serve; blocked task readiness refuses to start runs (DSH_UNAVAILABLE); blocked model readiness denies every dispatch (fail closed).",
    ],
    generated_at: generatedAt.toISOString(),
  };
}

/**
 * Diagnose an environment before starting the service. A configuration error
 * that `configFromEnv` refuses becomes a blocked startup report instead of a
 * stack trace, so operators see the next action and never a secret value.
 */
export async function diagnoseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<RuntimeDiagnosticsOptions, "config" | "env"> = {},
): Promise<RuntimeDiagnostics> {
  let config: OrchestratorConfig;
  try {
    config = configFromEnv(env);
  } catch (error) {
    const detail = redactSensitiveText(safeMessage(error), providerCredentialValues(env));
    const now = options.now ?? (() => new Date());
    const generatedAt = now();
    return {
      service: {
        name: "forgepilot-api/v1",
        version: serviceVersion(),
        pid: options.pid ?? process.pid,
        started_at: (options.startedAt ?? generatedAt).toISOString(),
        uptime_seconds: 0,
        single_instance: true,
      },
      readiness: { startup: "blocked", task: "blocked", model: "blocked" },
      checks: [
        {
          id: "config",
          label: "configuration",
          status: "blocked",
          stages: ["startup", "task"],
          detail,
          next_action: "Correct the named environment variables and run `npm run doctor` again",
        },
      ],
      blockers: ["config"],
      notes: [
        "Configuration was refused before any subsystem started; no state file was read or written.",
      ],
      generated_at: generatedAt.toISOString(),
    };
  }
  return collectRuntimeDiagnostics({ ...options, config, env });
}

/** Ambient credential values, used only as redaction literals — never reported. */
function providerCredentialValues(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= 4 && /KEY|TOKEN|SECRET|PASSWORD/.test(name)) {
      values.push(value);
    }
  }
  return values;
}
