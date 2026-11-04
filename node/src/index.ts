import type http from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

import type { Api, Model } from "@mariozechner/pi-ai";

import { buildOpenApiDocument } from "./api/openapi.js";
import { BudgetAuthority, createBudgetStore, loadBudgetPolicyFile } from "./budget/index.js";
import { readOrCreateApiToken } from "./api/auth.js";
import { AuthService } from "./api/auth-service.js";
import { createInvitationAuthority } from "./api/invitation-authority.js";
import { InvitationService, readOrCreateInvitationDigestKey } from "./api/invitation-service.js";
import type { InvitationRateLimits } from "./api/invitation-service.js";
import { ProviderOAuth, readOAuthCredentialsFile } from "./api/oauth.js";
import { createApiServer } from "./api/server.js";
import { createTaskRunOutcomes } from "./api/run-outcomes.js";
import { createRequestAuthority } from "./api/request-authority.js";
import type { RequestAuthority } from "./api/request-authority.js";
import { TaskService } from "./api/task-service.js";
import { TaskStore } from "./api/task-store.js";
import {
  createConfiguredWorkspaceRunBindingResolver,
  createWorkspaceRunBindingResolver,
} from "./api/workspace-bindings.js";
import type { OrchestratorConfig } from "./config.js";
import { configFromEnv, defaultSecurityStatePath } from "./config.js";
import type { ControlPlaneDb } from "./control-plane/index.js";
import {
  createIdentityRepositories,
  createInvitationRepository,
  createProviderAccessRepositories,
  createRepositories,
  openControlPlaneDb,
} from "./control-plane/index.js";
import type { AuthenticatedPrincipal, RequestScopeDeps } from "./control-plane/request-scope.js";
import { resolveRequestScope } from "./control-plane/request-scope.js";
import { DshClient } from "./dsh/client.js";
import {
  createFileEventSink,
  createModelGateway,
  createPatternSecretScanner,
  createStaticCredentialStore,
  denyAllPolicyResolver,
  loadGatewayPolicyFile,
  piAiProviderAdapter,
  providerCredentialEnvVars,
  readCredentialFile,
} from "./gateway/index.js";
import type { GatewayScope, GatewayScopeBinding, ModelGateway } from "./gateway/index.js";
import { createUsageLedgerStore } from "./ledger/index.js";
import {
  createMemoryConsolidationRunner,
  createMemoryGovernanceService,
  createMemoryLifecycleStore,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  createRsiService,
  createRsiStore,
} from "./memory/index.js";
import type {
  MemoryConsolidationRunner,
  MemoryGovernanceService,
  MemoryRepositories,
  MemoryRetrievalService,
  RsiService,
  RsiStore,
} from "./memory/index.js";
import { resolveConfiguredModel } from "./pi/model.js";
import {
  DependentWorkPauseLedger,
  EncryptedQuarantine,
  RuleCorrectionService,
  SecurityCaseService,
  SecurityCaseStore,
  SecurityNotifier,
  createFileNotificationSink,
  staticDutyDirectory,
} from "./security/index.js";
import type { QuarantineKeyProvider, SecurityRoleDirectory } from "./security/index.js";
import {
  createStaticServiceCredentialStore,
  readServiceCredentialFile,
} from "./provider-access/credentials.js";
import type { ServiceCredentialStore } from "./provider-access/credentials.js";

export interface OrchestratorOptions {
  config: OrchestratorConfig;
  /**
   * Explicit model gateway (tests inject a scripted adapter behind real
   * gateway checks). Unset builds the deployment gateway from config; its
   * policy and credentials come only from the protected gateway files.
   */
  gateway?: ModelGateway;
  /** Explicit Pi model; unset resolves from config, then PI_UNAVAILABLE. */
  model?: Model<Api>;
  /**
   * Explicit run scope binding (tests exercise runs behind the real gateway
   * checks). Unset binds each run's scope from the authenticated request's
   * live membership through the DAT-241 helper; requests without an
   * authenticated scope dispatch nothing (fail closed).
   */
  runScope?: (principal: AuthenticatedPrincipal | null) => GatewayScopeBinding;
  /** Injectable provider HTTP for the OAuth login surface (tests). */
  authFetchImpl?: typeof fetch;
  /** Injectable DNS lookup for the provider-origin policy (tests). */
  authDnsLookup?: (hostname: string) => Promise<string[]>;
  /** Rate-limit overrides for the invitation surface (tests). */
  invitationRateLimits?: InvitationRateLimits;
  /** DAT-247 service credentials for the redemption point refresh (tests). */
  providerServiceCredentials?: ServiceCredentialStore;
  /** Provider API base override for the point refresh (tests: fake provider). */
  providerApiBaseUrl?: string;
}

export interface OrchestratorHandle {
  server: http.Server;
  service: TaskService;
  store: TaskStore;
  dsh: DshClient;
  gateway: ModelGateway;
  model: Model<Api> | undefined;
  /** Identity/session subsystem; set when OAuth clients are configured. */
  auth: AuthService | undefined;
  /** Owner-created invitation surface (DAT-204); set with the identity subsystem. */
  invitations: InvitationService | undefined;
  /** Control-plane database behind the identity subsystem. */
  controlPlane: ControlPlaneDb | undefined;
  /**
   * Provider-authority request boundary (DAT-203); set with the identity
   * subsystem. Exposed so revocation paths (provider events, reconcile) share
   * its authority-change signal.
   */
  providerAuthority: RequestAuthority | undefined;
  /**
   * Scheduled memory consolidation (DAT-235); set with the identity control
   * plane. Registered on `start()` and stopped with the orchestrator.
   */
  memoryConsolidation: MemoryConsolidationRunner | undefined;
  /** Workspace memory retrieval service; set when the control plane is on. */
  memory: MemoryRetrievalService | undefined;
  /** Scoped memory repositories, for memory lifecycle wiring and tests. */
  memoryRepositories: MemoryRepositories | undefined;
  /** Bounded RSI governance service; set when the control plane is on. */
  rsi: RsiService | undefined;
  /** Scoped RSI store, for dataset provisioning and tests. */
  rsiStore: RsiStore | undefined;
  /** Per-process bearer token callers must present on every API request. */
  apiToken: string;
  /** Start listening; resolves with the bound loopback address. */
  start(): Promise<{ host: string; port: number }>;
  /** Stop listening and release Pi sessions. */
  stop(): Promise<void>;
}

/**
 * Quarantine key seam backed by a protected key file. Missing, unreadable, or
 * malformed key material returns nothing: seals fail closed and nothing is
 * ever stored in plaintext (DAT-210).
 */
function fileQuarantineKeyProvider(keyFile: string | undefined): QuarantineKeyProvider {
  return {
    keyId: "quarantine-key-file",
    currentKey(): Buffer | undefined {
      if (!keyFile) return undefined;
      try {
        const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
        return key.length === 32 ? key : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The deployment security disposal machinery (DAT-210, DAT-211): durable
 * case history, durable dependent-work holds, encrypted quarantine, handler
 * notification with escalation, and the versioned rule-correction lifecycle
 * behind the separated security duties. The production gateway receives the
 * case service as both its disposal-case intake and its admission-boundary
 * hold — the gateway cannot be deployed without either — and scans under the
 * currently activated rule corrections.
 */
function deploymentSecurity(config: OrchestratorConfig): {
  security: SecurityCaseService;
  rules: RuleCorrectionService;
} {
  const referenceSecret = config.securityReferenceSecret
    ? Buffer.from(config.securityReferenceSecret, "utf8")
    : randomBytes(32);
  const directory: SecurityRoleDirectory = {
    resolve: () => ({
      workspaceHandlers: (config.securityHandlerIds ?? []).map((recipientId) => ({
        recipientId,
        role: "workspace_security_handler" as const,
      })),
      enterpriseAdmins: (config.securityAdminIds ?? []).map((recipientId) => ({
        recipientId,
        role: "enterprise_security_admin" as const,
      })),
    }),
  };
  // Duties (DAT-211) are granted only by explicit listing; missing handlers,
  // reviewers, or admins leave their actions unavailable — never waived.
  const duties = staticDutyDirectory({
    taskOwners: config.securityTaskOwnerIds ?? [],
    handlers: config.securityHandlerIds ?? [],
    reviewers: config.securityReviewerIds ?? [],
    admins: config.securityAdminIds ?? [],
  });
  return {
    security: new SecurityCaseService({
      caseStore: new SecurityCaseStore(
        config.securityCaseStateFile ? { persistencePath: config.securityCaseStateFile } : {},
      ),
      pauses: new DependentWorkPauseLedger(
        config.securityPauseStateFile ? { persistencePath: config.securityPauseStateFile } : {},
      ),
      notifier: new SecurityNotifier({
        directory,
        sink: createFileNotificationSink(
          config.securityNotificationsFile ??
            defaultSecurityStatePath("security-notifications.jsonl"),
        ),
        referenceSecret,
      }),
      quarantine: new EncryptedQuarantine({
        keyProvider: fileQuarantineKeyProvider(config.quarantineKeyFile),
        // Bounded retention; the enterprise lifecycle governs longer terms.
        retentionSeconds: 30 * 24 * 60 * 60,
        ...(config.securityQuarantineStateFile
          ? { persistencePath: config.securityQuarantineStateFile }
          : {}),
      }),
      referenceSecret,
      duties,
    }),
    rules: new RuleCorrectionService({
      directory: duties,
      ...(config.securityRuleStateFile ? { persistencePath: config.securityRuleStateFile } : {}),
    }),
  };
}

/**
 * The deployment model gateway: policy and credentials come from the
 * protected gateway files only. Policies are scope-bound (DAT-242): the file
 * carries one policy per enterprise/workspace pair and resolution is keyed by
 * the caller's authenticated scope — there is no deployment-config scope and
 * no single-scope default path.
 *
 * Deployment-layer direct-connection block: the orchestrator refuses to run
 * while provider credentials are present in the environment, because an
 * ambient env credential is exactly the bypass the gateway boundary exists to
 * prevent. Model egress without both gateway files fails closed — every
 * dispatch is denied.
 */
function deploymentGateway(config: OrchestratorConfig): ModelGateway {
  const ambient = providerCredentialEnvVars(process.env);
  if (ambient.length > 0) {
    throw new Error(
      `provider credentials must not be configured via the environment (found: ${ambient.join(", ")}); ` +
        "configure FORGEPILOT_GATEWAY_CREDENTIALS_FILE and unset these variables",
    );
  }
  // Secret-gate blocks always open a disposal case and hold the affected
  // run's dependent work (DAT-210): the production gateway carries both.
  const { security, rules } = deploymentSecurity(config);
  const scope = { enterpriseId: config.enterpriseId, workspaceId: config.workspaceId };
  // Budget authority (DAT-229): configured with a policy file, it enforces
  // enterprise/workspace/run limits with a durable journal; without one the
  // deployment is explicitly unbudgeted rather than silently zero-cost.
  const budget = config.budgetPolicyFile
    ? new BudgetAuthority({
        store: createBudgetStore({ persistencePath: config.budgetStateFile }),
        policyResolver: loadBudgetPolicyFile(config.budgetPolicyFile, scope),
      })
    : undefined;
  return createModelGateway({
    policyResolver: config.gatewayPolicyFile
      ? loadGatewayPolicyFile(config.gatewayPolicyFile)
      : denyAllPolicyResolver,
    credentials: config.gatewayCredentialsFile
      ? readCredentialFile(config.gatewayCredentialsFile)
      : createStaticCredentialStore({}),
    adapter: piAiProviderAdapter,
    // Complete-request secret scanning is part of the egress boundary: the
    // deployment always scans with the built-in deterministic detector set
    // (DAT-209), narrowed only by the currently activated, independently
    // reviewed rule corrections (DAT-211). A deployment may swap in another
    // SecretScanner backend.
    scanner: createPatternSecretScanner({ corrections: () => rules.activeCorrections() }),
    ...(config.gatewayAuditFile ? { sink: createFileEventSink(config.gatewayAuditFile) } : {}),
    caseIntake: security,
    dependentWorkHold: security,
    // Invocation usage ledger (DAT-227): every actual dispatch attempt is
    // metered here — failures, retries and fallbacks included — so cost
    // accounting reconciles against real attempts instead of guesses.
    ...(config.usageLedgerFile
      ? { usageLedger: createUsageLedgerStore({ persistencePath: config.usageLedgerFile }) }
      : {}),
    ...(budget ? { budget } : {}),
  });
}

/**
 * Run scope binding for the deployment (DAT-242): the binding's
 * enterprise/workspace comes from the authenticated request's live membership
 * resolution (DAT-241 `resolveRequestScope`) — never from deployment
 * configuration — and every dispatch re-resolves the same way.
 *
 * A request without a session-derived scope (the local-operator bearer, or an
 * identity-less deployment) binds the deny-everything scope: its model
 * dispatches resolve no authenticated scope, deny `MODEL_EGRESS_DENIED`, and
 * never fall back to a configured default (fail closed).
 */
function deploymentRunScope(
  scopeDeps: RequestScopeDeps | undefined,
): (principal: AuthenticatedPrincipal | null) => GatewayScopeBinding {
  return (principal) => {
    if (principal === null || scopeDeps === undefined) {
      return {
        enterpriseId: "",
        workspaceId: "",
        scopeAuthority: {
          resolve(): GatewayScope {
            throw new Error("this request carries no authenticated enterprise/workspace scope");
          },
        },
      };
    }
    const bound = resolveRequestScope(scopeDeps, principal);
    return {
      enterpriseId: bound.enterprise_id,
      workspaceId: bound.workspace_id,
      scopeAuthority: {
        resolve(): GatewayScope {
          // Re-resolved from live membership state on every dispatch:
          // revocation, suspension, and role changes deny the next attempt in
          // the same request path (no cached verdict, no default scope).
          const live = resolveRequestScope(scopeDeps, principal);
          return { enterpriseId: live.enterprise_id, workspaceId: live.workspace_id };
        },
      },
    };
  };
}

/**
 * Composition root for the orchestrator process.
 *
 * Wires config → dsh client → gateway → task service → API server. Tests
 * construct the same handle with an injected gateway whose adapter is
 * scripted; every model call still passes the gateway's checks.
 */
export function createOrchestrator(options: OrchestratorOptions): OrchestratorHandle {
  const { config } = options;
  const store = new TaskStore({
    ...(config.taskStateFile ? { persistencePath: config.taskStateFile } : {}),
    // Pre-DAT-244 projections had no workspace ownership; one deployment
    // served exactly one workspace, so that workspace is their owner.
    legacyWorkspaceId: config.workspaceId,
    // Pre-DAT-245 projections had no enterprise ownership; one deployment
    // served exactly one enterprise, so that enterprise is their owner.
    legacyEnterpriseId: config.enterpriseId,
  });
  const dsh = new DshClient({
    socketPath: config.dshSocketPath,
    ...(config.dshTokenFile ? { tokenFile: config.dshTokenFile } : {}),
  });
  const model = options.model ?? resolveConfiguredModel(config);
  const gateway = options.gateway ?? deploymentGateway(config);
  // Fresh per-process token: possessing it is what authorizes API callers,
  // approvals included; the configured dsh identity alone is not proof of a
  // human decision.
  const apiToken = readOrCreateApiToken(config.apiTokenFile);
  // Enterprise identity (ADR-0006) is enabled by the OAuth client file; its
  // absence keeps the local-operator surface exactly as before.
  let auth: AuthService | undefined;
  let invitations: InvitationService | undefined;
  let controlPlane: ControlPlaneDb | undefined;
  let providerAuthority: RequestAuthority | undefined;
  let workspaceBindings = createConfiguredWorkspaceRunBindingResolver(config);
  let requestScopeDeps: RequestScopeDeps | undefined;
  let memoryConsolidation: MemoryConsolidationRunner | undefined;
  let memory: MemoryRetrievalService | undefined;
  let memoryRepositories: MemoryRepositories | undefined;
  let memoryGovernance: MemoryGovernanceService | undefined;
  let rsi: RsiService | undefined;
  let rsiStore: RsiStore | undefined;
  if (config.oauthClientsFile !== undefined) {
    controlPlane = openControlPlaneDb({ path: config.controlPlaneFile ?? ":memory:" });
    const repos = createRepositories(controlPlane);
    const identity = createIdentityRepositories(controlPlane);
    requestScopeDeps = {
      sessions: identity.sessions,
      users: identity.users,
      memberships: repos.memberships,
      workspaces: repos.workspaces,
    };
    auth = new AuthService({
      repos,
      identity,
      config: {
        enterpriseId: config.enterpriseId,
        workspaceId: config.workspaceId,
        sessionTtlSeconds: config.sessionTtlSeconds ?? 12 * 60 * 60,
        oauthFlowTtlSeconds: config.oauthFlowTtlSeconds ?? 600,
        desktopFlowTtlSeconds: config.desktopFlowTtlSeconds ?? 600,
        ...(config.bootstrapToken !== undefined ? { bootstrapToken: config.bootstrapToken } : {}),
        desktopMaxAttempts: 5,
      },
      credentials: readOAuthCredentialsFile(config.oauthClientsFile),
      ...(options.authFetchImpl !== undefined
        ? { providerOAuth: new ProviderOAuth({ fetchImpl: options.authFetchImpl }) }
        : {}),
      ...(options.authDnsLookup !== undefined ? { lookup: options.authDnsLookup } : {}),
    });
    // Provider authority (DAT-203) shares the control plane with identity:
    // the request boundary enforces effective access for session requests
    // whenever a service integration is installed for this workspace.
    const providerAccess = createProviderAccessRepositories(controlPlane);
    // Workspace memory retrieval (DAT-236) shares the control-plane store. The
    // service is read-only over memory: it assembles bounded, cited bundles and
    // records audit rows; it cannot promote, edit, or grant anything.
    memoryRepositories = createMemoryRepositories(controlPlane);
    const retrievalStore = createRetrievalStore(controlPlane);
    memory = createMemoryRetrievalService({
      memory: memoryRepositories,
      store: retrievalStore,
    });
    // Memory governance (DAT-251) is the named-human half of the lifecycle:
    // detail, per-version content, the audit timeline, and promote/deprecate/
    // quarantine/restore. It reads the same scoped store as retrieval, and
    // resolves team leadership from the workspace's team rows so authority is
    // never a client claim.
    memoryGovernance = createMemoryGovernanceService({
      memory: memoryRepositories,
      retrieval: memory,
      lifecycle: createMemoryLifecycleStore(controlPlane),
      teams: repos.teams,
    });
    // Bounded RSI (DAT-238) shares the same store. Offline replay uses the
    // retrieval preview path, so an evaluated candidate policy is never
    // stored or retrievable before promotion; promotion publishes a version.
    rsiStore = createRsiStore(controlPlane);
    rsi = createRsiService({
      store: rsiStore,
      memory: memoryRepositories,
      retrieval: memory,
      retrievalStore,
      // Canary samples come only from the task projection for pinned runs.
      outcomes: createTaskRunOutcomes(store),
    });
    providerAuthority = createRequestAuthority({
      access: providerAccess,
      memberships: repos.memberships,
      workspaces: repos.workspaces,
      users: identity.users,
      identities: identity.identities,
      enterpriseId: config.enterpriseId,
      workspaceId: config.workspaceId,
    });
    // The workspace-scoped task family resolves each locator against the
    // authenticated control plane, not against process config (DAT-245).
    workspaceBindings = createWorkspaceRunBindingResolver({
      config,
      workspaces: repos.workspaces,
      providerInstances: repos.providerInstances,
    });
    // The invitation digest key is deployment-owned and durable: a file next
    // to the control-plane database unless configured explicitly. An ephemeral
    // (in-memory) control plane gets a per-process key, which fails closed —
    // its invitations die with the process anyway.
    const digestKey =
      config.invitationDigestKeyFile !== undefined
        ? readOrCreateInvitationDigestKey(config.invitationDigestKeyFile)
        : config.controlPlaneFile !== undefined
          ? readOrCreateInvitationDigestKey(`${config.controlPlaneFile}.invitation-key`)
          : randomBytes(32);
    // DAT-247's service credential boundary: secrets come from a protected
    // file (or explicit injection), never from a user OAuth token. An empty
    // store makes the point refresh fail closed.
    const serviceCredentials =
      options.providerServiceCredentials ??
      (config.providerServiceCredentialFile !== undefined
        ? readServiceCredentialFile(config.providerServiceCredentialFile)
        : createStaticServiceCredentialStore({}));
    const providerApiBaseUrl = options.providerApiBaseUrl;
    invitations = new InvitationService({
      repos,
      identity,
      invitations: createInvitationRepository(controlPlane, providerAccess),
      authority: createInvitationAuthority({
        access: providerAccess,
        identities: identity.identities,
        providerInstances: repos.providerInstances,
        credentials: serviceCredentials,
        epoch: providerAuthority.epoch,
        ...(providerApiBaseUrl !== undefined ? { apiBaseUrl: () => providerApiBaseUrl } : {}),
      }),
      config: {
        enterpriseId: config.enterpriseId,
        digestKey,
        ...(options.invitationRateLimits !== undefined
          ? { rateLimits: options.invitationRateLimits }
          : {}),
      },
    });
    // Sleep-time memory consolidation (DAT-235): the control plane owns the
    // memory store, so the deployment runs the bounded consolidation pass
    // over every active workspace on the configured cadence. Started with the
    // service and stopped with it; a failed workspace pass is logged and the
    // schedule survives.
    memoryConsolidation = createMemoryConsolidationRunner({
      db: controlPlane,
      enterpriseId: config.enterpriseId,
      actorId: config.actorId,
      ...(config.memoryConsolidationIntervalMs !== undefined
        ? { intervalMs: config.memoryConsolidationIntervalMs }
        : {}),
      onReport: (workspaceId, report) => {
        if (report.ops_applied > 0 || report.counts_recomputed > 0 || report.budget_exhausted) {
          console.log(
            `memory consolidation ${workspaceId}: run ${report.run_id} scanned=${report.items_scanned} ` +
              `applied=${report.ops_applied} skipped=${report.ops_skipped} ` +
              `budget_exhausted=${report.budget_exhausted}`,
          );
        }
      },
      onError: (error) => {
        console.error("memory consolidation pass failed:", error);
      },
    });
  }
  // The task service starts runs, so it receives the same memory/RSI pair:
  // every run pins its versions here and the canary overlay is consumed by the
  // retrieval call above the prompt.
  const service = new TaskService({
    config,
    dsh,
    store,
    gateway,
    workspaceBindings,
    ...(model ? { model } : {}),
    runScope: options.runScope ?? deploymentRunScope(requestScopeDeps),
    ...(memory !== undefined && rsi !== undefined ? { memory: { memory, rsi } } : {}),
  });
  const server = createApiServer({
    service,
    apiToken,
    legacyWorkspaceId: config.workspaceId,
    ...(auth !== undefined ? { auth } : {}),
    ...(providerAuthority !== undefined ? { authority: providerAuthority } : {}),
    ...(invitations !== undefined ? { invitations } : {}),
    ...(memory !== undefined && auth !== undefined
      ? {
          memory: {
            auth,
            service: memory,
            apiToken,
            ...(providerAuthority !== undefined ? { authority: providerAuthority } : {}),
            ...(rsi !== undefined ? { rsi } : {}),
            ...(memoryGovernance !== undefined ? { governance: memoryGovernance } : {}),
          },
        }
      : {}),
    ...(config.publicOrigin !== undefined ? { publicOrigin: config.publicOrigin } : {}),
  });
  return {
    server,
    service,
    store,
    dsh,
    gateway,
    model,
    auth,
    invitations,
    controlPlane,
    providerAuthority,
    memoryConsolidation,
    memory,
    memoryRepositories,
    rsi,
    rsiStore,
    apiToken,
    start: () => {
      const { promise, resolve, reject } = Promise.withResolvers<{ host: string; port: number }>();
      server.once("error", reject);
      server.listen(config.apiPort, config.apiHost, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("orchestrator did not bind a TCP loopback port"));
          return;
        }
        resolve({ host: config.apiHost, port: address.port });
      });
      return promise.then(async (bound) => {
        // Re-associate any persisted tasks with their dsh runs before the API
        // serves reads, so the first GET after a restart already reflects the
        // authoritative run state. Failures leave the projection as persisted:
        // recovery never fabricates an outcome dsh did not report.
        await service.recoverFromDsh().catch((error: unknown) => {
          console.error("task recovery skipped:", error);
        });
        // Sleep-time consolidation begins with the service, never before it.
        memoryConsolidation?.start();
        return bound;
      });
    },
    stop: () => {
      memoryConsolidation?.stop();
      service.disposeAll();
      // Durability boundary: a clean shutdown must not lose projected events.
      store.flushSync();
      controlPlane?.close();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

export { buildOpenApiDocument, configFromEnv };
export * from "./gateway/index.js";
export * from "./security/index.js";
export * from "./ledger/index.js";
export * from "./budget/index.js";

async function main(): Promise<void> {
  const config = configFromEnv();
  const orchestrator = createOrchestrator({ config });
  const { host, port } = await orchestrator.start();
  console.log(`forgepilot-api/v1 listening on http://${host}:${port}`);
  console.log(`dsh control plane: ${config.dshSocketPath}`);
  console.log(`API token file (Authorization: Bearer <token>): ${config.apiTokenFile}`);
  console.log(
    config.gatewayPolicyFile
      ? `model gateway: ${config.gatewayPolicyFile} (audit: ${config.gatewayAuditFile})`
      : "model gateway: no policy configured (all model calls fail closed)",
  );
  console.log(
    orchestrator.model
      ? `Pi model: ${orchestrator.model.provider}/${orchestrator.model.id}`
      : "Pi model: not configured (tasks will report PI_UNAVAILABLE)",
  );
  const shutdown = (): void => {
    void orchestrator.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run the server when executed directly (node dist/src/index.js), not
// when imported by tests or the export script.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void main();
}
