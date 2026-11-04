import path from "node:path";

import { isLoopbackHost } from "./api/auth.js";
import { DEFAULT_MEMORY_CONSOLIDATION_INTERVAL_MS } from "./memory/lifecycle/runner.js";

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
  /**
   * Durable task-projection file (0600, user-private directory). Unset
   * means a process-local store — tests use that; a real deployment sets it
   * so a restart can re-associate tasks with their dsh runs.
   */
  taskStateFile?: string;
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
  /** Optional API origin override for a compatible provider endpoint. */
  piBaseUrl?: string;
  /**
   * The task surface's enterprise/workspace (ADR-0006): session access
   * gating and the DAT-203 provider-authority boundary consult membership in
   * this workspace. Since DAT-242 these values no longer govern model egress:
   * gateway policy resolution and each run's binding scope come from the
   * authenticated request's live membership (`resolveRequestScope`, DAT-241),
   * never from deployment configuration.
   */
  enterpriseId: string;
  workspaceId: string;
  /**
   * Model gateway configuration. Both files are required to enable live model
   * egress; missing configuration fails closed (every dispatch is denied).
   */
  gatewayPolicyFile?: string;
  gatewayCredentialsFile?: string;
  /** Durable gateway audit/metering event sink (JSONL, 0600). */
  gatewayAuditFile?: string;
  // --- Security disposal cases (DAT-210, ADR-0005) ------------------------
  /**
   * Durable state files for the security disposal machinery: append-only
   * case history, the dependent-work hold ledger, and the encrypted
   * quarantine index. Defaults keep holds and cases alive across restarts.
   */
  securityCaseStateFile?: string;
  securityPauseStateFile?: string;
  securityQuarantineStateFile?: string;
  /**
   * Protected file holding a base64 32-byte quarantine key. Unset (or an
   * unreadable/invalid key) fails seals closed: nothing is ever stored in
   * plaintext, and every seal raises an explicit incident.
   */
  quarantineKeyFile?: string;
  /** Designated workspace security handlers and enterprise security admins. */
  securityHandlerIds?: string[];
  securityAdminIds?: string[];
  /**
   * Separated security duties (DAT-211): task owners and independent
   * reviewers alongside handlers and admins. Duties are granted only by
   * explicit listing; an empty reviewer list keeps cases blocked and
   * escalated, never waived.
   */
  securityTaskOwnerIds?: string[];
  securityReviewerIds?: string[];
  /** Durable versioned rule-correction state (DAT-211). */
  securityRuleStateFile?: string;
  /** Durable notification record sink (JSONL, 0600; non-secret content). */
  securityNotificationsFile?: string;
  /**
   * Secret for minting authenticated, non-transferable case references.
   * Unset uses a per-process secret (references then only verify within the
   * process that minted them); a deployment sets it for cross-restart use.
   */
  securityReferenceSecret?: string;
  /**
   * Durable invocation usage ledger (JSON, 0600) — one reconcilable usage
   * record per gateway invocation attempt (DAT-227). Separate from the audit
   * stream: financial records are queried and retained on their own terms.
   */
  usageLedgerFile?: string;
  /**
   * Budget policy JSON (DAT-229). Setting it enables enterprise/workspace/run
   * budget enforcement at the gateway; unset leaves invocations unbudgeted.
   */
  budgetPolicyFile?: string;
  /** Durable budget journal (JSONL, 0600); required alongside the policy. */
  budgetStateFile?: string;
  // --- Enterprise identity (ADR-0006) -------------------------------------
  /**
   * External origin for OAuth redirect URLs and desktop login links. Unset
   * derives a loopback origin per request (local development).
   */
  publicOrigin?: string;
  /**
   * Protected JSON file mapping provider origins to OAuth application
   * credentials. Setting it enables the /api/v1/auth and /api/v1/admin
   * surfaces together with server-side sessions.
   */
  oauthClientsFile?: string;
  /** Durable control-plane database for identity/session state. */
  controlPlaneFile?: string;
  /**
   * Deployment-owned HMAC key file for the invitation token digest. Durable
   * across restarts (invitations outlive processes); unset derives one next to
   * the control-plane database. Losing the key fails closed — outstanding
   * invitations become unredeemable.
   */
  invitationDigestKeyFile?: string;
  /**
   * Protected JSON file mapping service credential references to secrets
   * (DAT-247 boundary). Invitation redemption point-refreshes the invitee's
   * repository authority with the repository-scoped service credential; when
   * unset the credential store is empty and every redemption fails closed
   * (403) rather than falling back to any user credential.
   */
  providerServiceCredentialFile?: string;
  /** Deployment-owned bootstrap secret; unset disables admin bootstrap. */
  bootstrapToken?: string;
  /** Session lifetime in seconds (default 12 hours). */
  sessionTtlSeconds?: number;
  /** OAuth authorization-flow lifetime in seconds (default 10 minutes). */
  oauthFlowTtlSeconds?: number;
  /** Desktop system-browser flow lifetime in seconds (default 10 minutes). */
  desktopFlowTtlSeconds?: number;
  /**
   * Sleep-time memory consolidation interval in milliseconds (DAT-235).
   * Applies whenever the identity control plane is enabled; defaults to six
   * hours. The scheduled job never holds the process open and stops with the
   * orchestrator.
   */
  memoryConsolidationIntervalMs?: number;
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

function defaultTaskStatePath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, "task-state.json");
}

function defaultGatewayAuditPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, "gateway-audit.jsonl");
}

/** Default state-file path under the per-user forgepilot directory. */
export function defaultSecurityStatePath(name: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, name);
}

function defaultUsageLedgerPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, "usage-ledger.json");
}

function defaultBudgetStatePath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, "budget-journal.jsonl");
}

function defaultControlPlanePath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(process.env["TMPDIR"] ?? "/tmp", `forgepilot-${uid}`, "control-plane.sqlite");
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
    taskStateFile: env["FORGEPILOT_TASK_STATE_FILE"] ?? defaultTaskStatePath(),
    enterpriseId: env["FORGEPILOT_ENTERPRISE_ID"] ?? "ent_forgepilot_local",
    workspaceId: env["FORGEPILOT_WORKSPACE_ID"] ?? "ws_autofixer",
    gatewayAuditFile: env["FORGEPILOT_GATEWAY_AUDIT_FILE"] ?? defaultGatewayAuditPath(),
    securityCaseStateFile:
      env["FORGEPILOT_SECURITY_CASE_STATE_FILE"] ?? defaultSecurityStatePath("security-cases.json"),
    securityPauseStateFile:
      env["FORGEPILOT_SECURITY_PAUSE_STATE_FILE"] ??
      defaultSecurityStatePath("security-pauses.json"),
    securityQuarantineStateFile:
      env["FORGEPILOT_SECURITY_QUARANTINE_STATE_FILE"] ??
      defaultSecurityStatePath("security-quarantine.json"),
    securityNotificationsFile:
      env["FORGEPILOT_SECURITY_NOTIFICATIONS_FILE"] ??
      defaultSecurityStatePath("security-notifications.jsonl"),
    securityHandlerIds: csv(env["FORGEPILOT_SECURITY_HANDLER_IDS"], []),
    securityAdminIds: csv(env["FORGEPILOT_SECURITY_ADMIN_IDS"], []),
    usageLedgerFile: env["FORGEPILOT_USAGE_LEDGER_FILE"] ?? defaultUsageLedgerPath(),
    securityTaskOwnerIds: csv(env["FORGEPILOT_SECURITY_TASK_OWNER_IDS"], []),
    securityReviewerIds: csv(env["FORGEPILOT_SECURITY_REVIEWER_IDS"], []),
    securityRuleStateFile:
      env["FORGEPILOT_SECURITY_RULE_STATE_FILE"] ?? defaultSecurityStatePath("security-rules.json"),
  };
  // Security disposal options (DAT-210). Absent values keep fail-closed
  // defaults: no quarantine key means nothing is ever retained in plaintext,
  // and no designated handlers escalates every notification to an explicit
  // undeliverable incident.
  const quarantineKeyFile = env["FORGEPILOT_QUARANTINE_KEY_FILE"]?.trim();
  if (quarantineKeyFile) {
    config.quarantineKeyFile = quarantineKeyFile;
  }
  const securityReferenceSecret = env["FORGEPILOT_SECURITY_REFERENCE_SECRET"];
  if (securityReferenceSecret !== undefined && securityReferenceSecret !== "") {
    if (securityReferenceSecret.length < 32) {
      throw new Error("FORGEPILOT_SECURITY_REFERENCE_SECRET must be at least 32 characters");
    }
    config.securityReferenceSecret = securityReferenceSecret;
  }
  if (env["FORGEPILOT_DSH_TOKEN_FILE"]) {
    config.dshTokenFile = env["FORGEPILOT_DSH_TOKEN_FILE"];
  }
  // Model egress is enabled only with both halves of the gateway
  // configuration; a partial setup fails closed at startup rather than
  // degrading to any ambient credential or endpoint.
  const gatewayPolicyFile = env["FORGEPILOT_GATEWAY_POLICY_FILE"]?.trim();
  const gatewayCredentialsFile = env["FORGEPILOT_GATEWAY_CREDENTIALS_FILE"]?.trim();
  if (gatewayPolicyFile && gatewayCredentialsFile) {
    config.gatewayPolicyFile = gatewayPolicyFile;
    config.gatewayCredentialsFile = gatewayCredentialsFile;
  } else if (gatewayPolicyFile || gatewayCredentialsFile) {
    throw new Error(
      "FORGEPILOT_GATEWAY_POLICY_FILE and FORGEPILOT_GATEWAY_CREDENTIALS_FILE must be configured together",
    );
  }
  // Budget enforcement is opt-in by configuration, not by accident: a
  // deployment that sets the policy file gets the authority and a durable
  // journal; leaving it unset keeps the historical unbudgeted behavior.
  const budgetPolicyFile = env["FORGEPILOT_BUDGET_POLICY_FILE"]?.trim();
  if (budgetPolicyFile) {
    config.budgetPolicyFile = budgetPolicyFile;
    config.budgetStateFile =
      env["FORGEPILOT_BUDGET_STATE_FILE"]?.trim() || defaultBudgetStatePath();
  }
  if (env["FORGEPILOT_PI_PROVIDER"] && env["FORGEPILOT_PI_MODEL"]) {
    config.piModelProvider = env["FORGEPILOT_PI_PROVIDER"];
    config.piModelId = env["FORGEPILOT_PI_MODEL"];
  }
  const piBaseUrl = env["FORGEPILOT_PI_BASE_URL"]?.trim();
  if (piBaseUrl) config.piBaseUrl = validateModelBaseUrl(piBaseUrl);
  // Enterprise identity options (ADR-0006). Absent values keep the
  // local-operator behavior unchanged.
  const publicOrigin = env["FORGEPILOT_PUBLIC_ORIGIN"]?.trim();
  if (publicOrigin) {
    config.publicOrigin = validateModelBaseUrl(publicOrigin, "FORGEPILOT_PUBLIC_ORIGIN");
  }
  const oauthClientsFile = env["FORGEPILOT_OAUTH_CLIENTS_FILE"]?.trim();
  if (oauthClientsFile) {
    config.oauthClientsFile = oauthClientsFile;
    config.controlPlaneFile =
      env["FORGEPILOT_CONTROL_PLANE_DB"]?.trim() || defaultControlPlanePath();
  } else if (env["FORGEPILOT_CONTROL_PLANE_DB"]?.trim()) {
    throw new Error(
      "FORGEPILOT_CONTROL_PLANE_DB requires FORGEPILOT_OAUTH_CLIENTS_FILE to enable the identity surfaces",
    );
  }
  const invitationDigestKeyFile = env["FORGEPILOT_INVITATION_DIGEST_KEY_FILE"]?.trim();
  if (invitationDigestKeyFile) {
    if (config.oauthClientsFile === undefined) {
      throw new Error(
        "FORGEPILOT_INVITATION_DIGEST_KEY_FILE requires FORGEPILOT_OAUTH_CLIENTS_FILE to enable the identity surfaces",
      );
    }
    config.invitationDigestKeyFile = invitationDigestKeyFile;
  }
  const providerServiceCredentialFile = env["FORGEPILOT_SERVICE_CREDENTIAL_FILE"]?.trim();
  if (providerServiceCredentialFile) {
    if (config.oauthClientsFile === undefined) {
      throw new Error(
        "FORGEPILOT_SERVICE_CREDENTIAL_FILE requires FORGEPILOT_OAUTH_CLIENTS_FILE to enable the identity surfaces",
      );
    }
    config.providerServiceCredentialFile = providerServiceCredentialFile;
  }
  const bootstrapToken = env["FORGEPILOT_BOOTSTRAP_TOKEN"];
  if (bootstrapToken !== undefined && bootstrapToken !== "") {
    if (bootstrapToken.length < 32) {
      throw new Error("FORGEPILOT_BOOTSTRAP_TOKEN must be at least 32 characters");
    }
    config.bootstrapToken = bootstrapToken;
  }
  if (config.oauthClientsFile && config.bootstrapToken === undefined) {
    // Without a bootstrap token nobody can register the first provider
    // instance or grant the first administrator: fail closed at startup
    // instead of shipping an unwinnable deployment.
    throw new Error(
      "FORGEPILOT_BOOTSTRAP_TOKEN is required when FORGEPILOT_OAUTH_CLIENTS_FILE enables the identity surfaces",
    );
  }
  config.sessionTtlSeconds = positiveInt(
    env["FORGEPILOT_SESSION_TTL_SECONDS"],
    12 * 60 * 60,
    "FORGEPILOT_SESSION_TTL_SECONDS",
  );
  config.oauthFlowTtlSeconds = positiveInt(
    env["FORGEPILOT_OAUTH_FLOW_TTL_SECONDS"],
    600,
    "FORGEPILOT_OAUTH_FLOW_TTL_SECONDS",
  );
  config.desktopFlowTtlSeconds = positiveInt(
    env["FORGEPILOT_DESKTOP_FLOW_TTL_SECONDS"],
    600,
    "FORGEPILOT_DESKTOP_FLOW_TTL_SECONDS",
  );
  config.memoryConsolidationIntervalMs = positiveInt(
    env["FORGEPILOT_MEMORY_CONSOLIDATION_INTERVAL_MS"],
    DEFAULT_MEMORY_CONSOLIDATION_INTERVAL_MS,
    "FORGEPILOT_MEMORY_CONSOLIDATION_INTERVAL_MS",
  );
  return config;
}

export function validateModelBaseUrl(
  value: string,
  name = "FORGEPILOT_PI_BASE_URL",
  allowHttp = false,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
  }
  if (!(["http:", "https:"].includes(url.protocol) && !url.username && !url.password)) {
    throw new Error(`${name} must use HTTP or HTTPS and must not contain credentials`);
  }
  // Non-local endpoints require HTTPS unless the caller explicitly registered
  // an internal instance (allowHttp); a private-looking hostname alone is not
  // evidence of trust.
  if (
    !allowHttp &&
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  ) {
    throw new Error(`${name} must use HTTPS for a non-local endpoint`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include a query string or fragment`);
  }
  return url.toString().replace(/\/$/, "");
}
