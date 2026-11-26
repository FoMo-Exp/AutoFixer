import type http from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

import type { Api, Model } from "@mariozechner/pi-ai";

import { buildOpenApiDocument } from "./api/openapi.js";
import { BudgetAuthority, createBudgetStore, loadBudgetPolicyFile } from "./budget/index.js";
import { readOrCreateApiToken } from "./api/auth.js";
import { AuthService } from "./api/auth-service.js";
import { ApprovalService } from "./collab/approval-service.js";
import { CandidateReviewService } from "./collab/candidate-service.js";
import { DeliveryBroker } from "./collab/delivery-broker.js";
import type { DeliveryProvider } from "./collab/delivery-broker.js";
import { createGitHubDeliveryProvider } from "./collab/github-delivery.js";
import { createGitHubGovernanceProvider } from "./collab/github-pr-governance.js";
import { PullRequestGovernanceService } from "./collab/pr-governance.js";
import type { PRGovernanceProvider } from "./collab/pr-governance.js";
import { createApprovalDirectory, createDeliveryPermission } from "./api/collab-authority.js";
import type { CollabHttpDeps } from "./api/collab-http.js";
import { createInvitationAuthority } from "./api/invitation-authority.js";
import { InvitationService, readOrCreateInvitationDigestKey } from "./api/invitation-service.js";
import { WorkspaceMemberService } from "./api/workspace-member-service.js";
import type { InvitationRateLimits } from "./api/invitation-service.js";
import { ProviderOAuth, readOAuthCredentialsFile } from "./api/oauth.js";
import { createApiServer } from "./api/server.js";
import { createTaskRunOutcomes } from "./api/run-outcomes.js";
import { CollabMachine } from "./collab/machine.js";
import { CandidateContentStore } from "./collab/candidate-store.js";
import { PreparationBridge } from "./collab/preparation.js";
import { createRequestAuthority } from "./api/request-authority.js";
import type { RequestAuthority } from "./api/request-authority.js";
import { createServiceIntegrationService } from "./api/service-integration-service.js";
import type { ServiceIntegrationService } from "./api/service-integration-service.js";
import { TaskService } from "./api/task-service.js";
import type { RunStepAuthority } from "./api/task-service.js";
import { TaskStore } from "./api/task-store.js";
import {
  createConfiguredWorkspaceRunBindingResolver,
  createWorkspaceRunBindingResolver,
} from "./api/workspace-bindings.js";
import { createRunStepAuthority } from "./api/run-step-authority.js";
import type { OrchestratorConfig } from "./config.js";
import { configFromEnv, defaultSecurityStatePath } from "./config.js";
import type { ControlPlaneDb } from "./control-plane/index.js";
import {
  createIdentityRepositories,
  createInvitationRepository,
  createMemberCapabilityRepository,
  createProviderAccessRepositories,
  createRepositories,
  createRepositorySetChangeRepository,
  createWorkspaceRepositorySetRepository,
  openControlPlaneDb,
} from "./control-plane/index.js";
import { createAuthorityEpoch } from "./provider-access/access-gate.js";
import { createCapabilityCeilingService } from "./provider-access/capability-ceiling.js";
import { createMemberAdmissionService } from "./provider-access/member-admission.js";
import { createRepositorySetChangeService } from "./provider-access/repository-set-change.js";
import { WorkspaceRepositorySetChangeService } from "./api/repository-set-change-service.js";
import { WorkspaceRepositoryCandidateService } from "./api/repository-candidate-service.js";
import type { AuthenticatedPrincipal, RequestScopeDeps } from "./control-plane/request-scope.js";
import { resolveRequestScope } from "./control-plane/request-scope.js";
import { DashboardAuditLog, DashboardService } from "./dashboard/index.js";
import type { DashboardSources } from "./dashboard/index.js";
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
import type { UsageLedgerStore } from "./ledger/index.js";
import type { BudgetStore } from "./budget/index.js";
import {
  createMemoryAdmissionRepository,
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
import {
  createDeliveryMergeWatcher,
  createMemoryDistillationRunner,
  createOutcomeCaptureScheduler,
  isCaptureTerminalState,
  readDeliveryOutcome,
} from "./distill/index.js";
import type {
  DeliveryMergeWatcher,
  MemoryDistillationRunner,
  OutcomeCaptureScheduler,
  TerminalRunRegistration,
} from "./distill/index.js";
import { resolveConfiguredModel } from "./pi/model.js";
import {
  DependentWorkPauseLedger,
  EncryptedQuarantine,
  RuleCorrectionService,
  SecurityCaseService,
  SecurityCaseStore,
  SecurityNotifier,
  auditEventFromCaseEvent,
  auditEventFromRuleEvent,
  createFileNotificationSink,
  createFileSecurityAuditTrail,
  createSecurityAuditGatewaySink,
  readOrCreateSecurityAuditKey,
  staticDutyDirectory,
} from "./security/index.js";
import type {
  QuarantineKeyProvider,
  SecurityAuditTrail,
  SecurityDutyDirectory,
  SecurityRoleDirectory,
} from "./security/index.js";
import {
  createStaticServiceCredentialStore,
  readServiceCredentialFile,
} from "./provider-access/credentials.js";
import type { ServiceCredentialStore } from "./provider-access/credentials.js";
import { IssueSyncService } from "./issue-sync/service.js";
import { IssueSyncStore } from "./issue-sync/store.js";
import { collectRuntimeDiagnostics } from "./diagnostics/runtime.js";
import type { RuntimeDiagnostics } from "./diagnostics/runtime.js";
import { redactSensitiveText } from "./errors/redact.js";

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
  /**
   * Dashboard read-model sources (tests inject in-memory stores). Unset uses
   * the deployment's ledger/budget stores; a source that is still absent is
   * reported as `missing_source`, never as zero.
   */
  dashboardSources?: Partial<DashboardSources>;
  /**
   * Provider write seam for the delivery broker (ADR-0007). The deployment
   * ships no provider adapter here yet, so delivery is blocked; DAT-260 adds
   * the real GitHub adapter and tests inject a scripted fake. A test double is
   * never a delivery: production wiring supplies nothing by default.
   */
  deliveryProviders?: Partial<Record<"github" | "gitlab", DeliveryProvider>>;
  /**
   * Explicit, human-only security duty assignments (DAT-278). Duties are
   * granted only by listing; unset grants nobody a security action. The
   * projection reads this directory, and workspace role changes never alter it.
   */
  securityDutyDirectory?: SecurityDutyDirectory;
  /**
   * Read-only pull-request governance reader (DAT-261). Unset uses the
   * reviewed GitHub reader over the integration's read-only source
   * credential; a repository without an active integration yields a blocked
   * observation, never a borrowed credential. Tests inject a scripted reader.
   */
  prGovernanceProvider?: PRGovernanceProvider;
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
  /**
   * Durable terminal-outcome capture (DAT-264); set with the control plane and
   * memory store. Its retry cadence starts with the service.
   */
  memoryCapture: OutcomeCaptureScheduler | undefined;
  /**
   * Durable distillation of captured known outcomes (DAT-265); set with the
   * control plane and memory store. It derives its work from the capture
   * outbox, so it shares its lifecycle with capture.
   */
  memoryDistillation: MemoryDistillationRunner | undefined;
  /** Bounded RSI governance service; set when the control plane is on. */
  rsi: RsiService | undefined;
  /** Scoped RSI store, for dataset provisioning and tests. */
  rsiStore: RsiStore | undefined;
  /** Workspace dashboard read model (DAT-230); set with the identity surface. */
  dashboard: DashboardService | undefined;
  /**
   * Durable collaboration record (DAT-215/219/220): issues, runs, immutable
   * candidates, approvals, and deliveries. Constructed unconditionally.
   */
  collaboration: CollabMachine;
  /** Retained candidate content outside every ephemeral worktree. */
  candidateStore: CandidateContentStore;
  /**
   * Candidate review, approval, and delivery API wiring (DAT-259); set with
   * the identity surface. Exposed so tests drive the same objects the server
   * serves instead of rebuilding them.
   */
  collab: CollabHttpDeps | undefined;
  /** Per-process bearer token callers must present on every API request. */
  apiToken: string;
  /** Redacted configuration/readiness report (DAT-257). */
  diagnostics: () => Promise<RuntimeDiagnostics>;
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
 * Read the protected audit-chain key, creating it 0600 on first use. An
 * existing key that is a symlink, non-regular file, group/world-accessible, or
 * malformed fails startup instead of silently starting a new chain (which
 * would orphan the anchored history and let a forged log verify).
 */
function readOrCreateAuditKey(keyFile: string): Buffer {
  return readOrCreateSecurityAuditKey(keyFile);
}

/**
 * The deployment security disposal machinery (DAT-210, DAT-211): durable
 * case history, durable dependent-work holds, encrypted quarantine, handler
 * notification with escalation, and the versioned rule-correction lifecycle
 * behind the separated security duties. The production gateway receives the
 * case service as both its disposal-case intake and its admission-boundary
 * hold — the gateway cannot be deployed without either — and scans under the
 * currently activated rule corrections.
 *
 * DAT-213 adds the unified audit trail: every case event and every rule event
 * is chained into one tamper-evident, non-secret log before the operation
 * reports success. A failed trail write fails the operation (fail closed).
 */
function deploymentSecurity(config: OrchestratorConfig): {
  security: SecurityCaseService;
  rules: RuleCorrectionService;
  audit: SecurityAuditTrail;
} {
  const referenceSecret = config.securityReferenceSecret
    ? Buffer.from(config.securityReferenceSecret, "utf8")
    : randomBytes(32);
  const auditFile = config.securityAuditFile ?? defaultSecurityStatePath("security-audit.jsonl");
  const auditKeyFile =
    config.securityAuditKeyFile ?? defaultSecurityStatePath("security-audit.key");
  const audit = createFileSecurityAuditTrail(auditFile, {
    key: readOrCreateAuditKey(auditKeyFile),
  });
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
    audit,
    security: new SecurityCaseService({
      caseStore: new SecurityCaseStore({
        ...(config.securityCaseStateFile ? { persistencePath: config.securityCaseStateFile } : {}),
        // DAT-213: every case event is chained into the unified non-secret
        // audit trail. A throwing trail write fails the case operation.
        onEvent: (event, record) => {
          audit.record(auditEventFromCaseEvent(record, event));
        },
      }),
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
      // DAT-213: rule proposal/review/activation/rollback events join the one
      // audit chain; the rule transaction rolls back if the write fails.
      onEvent: (event) => {
        audit.record(auditEventFromRuleEvent(event));
      },
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
interface DeploymentStores {
  usageLedger?: UsageLedgerStore;
  budgetStore?: BudgetStore;
}

function deploymentGateway(
  config: OrchestratorConfig,
  stores: DeploymentStores = {},
): ModelGateway {
  const ambient = providerCredentialEnvVars(process.env);
  if (ambient.length > 0) {
    throw new Error(
      `provider credentials must not be configured via the environment (found: ${ambient.join(", ")}); ` +
        "configure FORGEPILOT_GATEWAY_CREDENTIALS_FILE and unset these variables",
    );
  }
  // Secret-gate blocks always open a disposal case and hold the affected
  // run's dependent work (DAT-210): the production gateway carries both.
  const { security, rules, audit } = deploymentSecurity(config);
  const scope = { enterpriseId: config.enterpriseId, workspaceId: config.workspaceId };
  // Budget authority (DAT-229): configured with a policy file, it enforces
  // enterprise/workspace/run limits with a durable journal; without one the
  // deployment is explicitly unbudgeted rather than silently zero-cost.
  const budgetStore = config.budgetPolicyFile
    ? createBudgetStore({ persistencePath: config.budgetStateFile })
    : undefined;
  const budget = budgetStore
    ? new BudgetAuthority({
        store: budgetStore,
        policyResolver: loadBudgetPolicyFile(config.budgetPolicyFile as string, scope),
      })
    : undefined;
  const gatewayFileSink = config.gatewayAuditFile
    ? createFileEventSink(config.gatewayAuditFile)
    : undefined;
  const gatewaySecurityAuditSink = createSecurityAuditGatewaySink(audit);
  const usageLedger = config.usageLedgerFile
    ? createUsageLedgerStore({ persistencePath: config.usageLedgerFile })
    : undefined;
  if (usageLedger !== undefined) {
    stores.usageLedger = usageLedger;
  }
  if (budgetStore !== undefined) {
    stores.budgetStore = budgetStore;
  }
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
    // The gateway's attempt stream keeps its own file sink (the required
    // pre-dispatch evidence) and additionally feeds the unified security
    // trail (DAT-213). Without the file sink the gateway still fails closed.
    ...(gatewayFileSink
      ? {
          sink: {
            record: (event) => {
              gatewayFileSink.record(event);
              gatewaySecurityAuditSink.record(event);
            },
          },
        }
      : {}),
    caseIntake: security,
    dependentWorkHold: security,
    // Invocation usage ledger (DAT-227): every actual dispatch attempt is
    // metered here — failures, retries and fallbacks included — so cost
    // accounting reconciles against real attempts instead of guesses.
    ...(usageLedger !== undefined ? { usageLedger } : {}),
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
  const startedAt = new Date();
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
  // Durable collaboration record (DAT-215/218/219). Constructed unconditionally:
  // a completed local preparation must produce its immutable candidate even in
  // the local-operator deployment, where the identity/control-plane surface is
  // off. Retained candidate content lives outside every ephemeral worktree.
  const collaborationPath = config.controlPlaneFile
    ? `${config.controlPlaneFile}.collaboration.json`
    : defaultSecurityStatePath("collaboration-state.json");
  const candidateStore = new CandidateContentStore(
    config.candidateStoreRoot ?? defaultSecurityStatePath("candidate-content"),
  );
  const collaboration = new CollabMachine({
    persistencePath: collaborationPath,
    candidateStore,
  });
  const preparation = new PreparationBridge({
    machine: collaboration,
    dsh,
    actor: config.actorId,
    policy: {
      checks: config.testChecks ?? ["go.test"],
      environment: config.testEnvironment ?? "dsh-isolated-v1",
      ...(config.testConfigDigest !== undefined ? { configDigest: config.testConfigDigest } : {}),
    },
  });
  const model = options.model ?? resolveConfiguredModel(config);
  const deploymentStores: DeploymentStores = {};
  const gateway = options.gateway ?? deploymentGateway(config, deploymentStores);
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
  /**
   * Sensitive worker-step re-authorization (DAT-285). Set with the identity
   * surface so every `dsh_request_action` re-reads the requester's current
   * authority and the versioned set before dispatch; unset in the
   * identity-less deployment, where the dsh grant is the only boundary.
   */
  let runStepAuthority: RunStepAuthority | undefined;
  let members: WorkspaceMemberService | undefined;
  let repositorySetChanges: WorkspaceRepositorySetChangeService | undefined;
  /**
   * Approved-repository discovery (DAT-289). Read-only: it lists the
   * repositories an authorized manager may select for this workspace, with the
   * installation each one would be proposed through. It never creates an
   * installation or a binding and never opens the multi-repository gate.
   */
  let repositoryCandidates: WorkspaceRepositoryCandidateService | undefined;
  let workspaceBindings = createConfiguredWorkspaceRunBindingResolver(config);
  let requestScopeDeps: RequestScopeDeps | undefined;
  // Live workspace rows for egress-coverage diagnostics (DAT-257). Read at
  // probe time so a workspace created after startup is still seen; an
  // unreadable control plane degrades coverage to "unverified" rather than
  // fabricating readiness.
  let listDiagnosticScopes: (() => GatewayScope[]) | undefined;
  let memoryConsolidation: MemoryConsolidationRunner | undefined;
  let memory: MemoryRetrievalService | undefined;
  let memoryRepositories: MemoryRepositories | undefined;
  let memoryCapture: OutcomeCaptureScheduler | undefined;
  let deliveryWatcher: DeliveryMergeWatcher | undefined;
  let memoryDistillation: MemoryDistillationRunner | undefined;
  let memoryGovernance: MemoryGovernanceService | undefined;
  let rsi: RsiService | undefined;
  let rsiStore: RsiStore | undefined;
  let issues: IssueSyncService | undefined;
  let collab: CollabHttpDeps | undefined;
  let serviceIntegrations: ServiceIntegrationService | undefined;
  if (config.oauthClientsFile !== undefined) {
    controlPlane = openControlPlaneDb({ path: config.controlPlaneFile ?? ":memory:" });
    const repos = createRepositories(controlPlane);
    listDiagnosticScopes = () =>
      repos.workspaces
        .list({ enterprise_id: config.enterpriseId, actor_id: config.actorId }, "active")
        .map((workspace) => ({
          enterpriseId: config.enterpriseId,
          workspaceId: workspace.id,
        }));
    const identity = createIdentityRepositories(controlPlane);
    requestScopeDeps = {
      sessions: identity.sessions,
      users: identity.users,
      memberships: repos.memberships,
      workspaces: repos.workspaces,
      enterpriseUsers: identity.enterpriseUsers,
    };
    // Provider authority (DAT-203) and the repository capability ceiling
    // (DAT-276) share the control plane with identity, and one authority epoch
    // so a confirmed capability reduction closes live streams in this process
    // while the persisted ceiling applies in every process.
    const providerAccess = createProviderAccessRepositories(controlPlane);
    const workspaceRepositorySets = createWorkspaceRepositorySetRepository(controlPlane);
    const providerEpoch = createAuthorityEpoch();
    const capabilityCeilings = createCapabilityCeilingService({
      repositorySets: workspaceRepositorySets,
      access: providerAccess,
      memberships: repos.memberships,
      providerInstances: repos.providerInstances,
      identity,
      capabilities: createMemberCapabilityRepository(controlPlane),
      epoch: providerEpoch,
    });
    // Admission across the whole repository set (DAT-283). One evaluation feeds
    // the request path's last-effective-owner guard today and the repository
    // addition preview a later route consumes; it never opens the
    // multi-repository gate or writes a binding.
    const memberAdmission = createMemberAdmissionService({
      repositorySets: workspaceRepositorySets,
      access: providerAccess,
      memberships: repos.memberships,
      identity,
      capabilityCeilings,
    });
    // Repository additions (DAT-284/286). The domain service owns the two-step
    // decision — a durable, actor-bound confirmation of the exact impact and a
    // single revalidating transaction that commits the bindings, set version,
    // approved ceiling reductions, revocations and audit row together. The API
    // service only resolves the path workspace and projects safe views; the
    // multi-repository gate stays the rollout switch, so no route can store a
    // set that no access path enforces.
    repositorySetChanges = new WorkspaceRepositorySetChangeService({
      repos,
      enterpriseId: config.enterpriseId,
      changes: createRepositorySetChangeService({
        db: controlPlane,
        repositorySets: workspaceRepositorySets,
        changes: createRepositorySetChangeRepository(controlPlane),
        access: providerAccess,
        memberships: repos.memberships,
        identity,
        capabilityCeilings,
        admission: memberAdmission,
        epoch: providerEpoch,
      }),
    });
    repositoryCandidates = new WorkspaceRepositoryCandidateService({
      repos,
      identity,
      access: providerAccess,
      repositorySets: workspaceRepositorySets,
      capabilityCeilings,
      enterpriseId: config.enterpriseId,
    });
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
      capabilityCeilings,
    });
    // Provider authority (DAT-203) shares the control plane with identity:
    // the request boundary enforces effective access for session requests
    // whenever a service integration is installed for this workspace.
    // Workspace memory retrieval (DAT-236) shares the control-plane store. The
    // service is read-only over memory: it assembles bounded, cited bundles and
    // records audit rows; it cannot promote, edit, or grant anything.
    memoryRepositories = createMemoryRepositories(controlPlane);
    // Distillation of captured known outcomes (DAT-265): derived from the
    // capture outbox's snapshots, dispatched through the ADR-0005 gateway under
    // the job's server-side workspace, and persisted as `proposed` only after
    // the DAT-233 validation and DAT-234 admission gate pass.
    memoryDistillation = createMemoryDistillationRunner({
      db: controlPlane,
      memory: memoryRepositories,
      admission: createMemoryAdmissionRepository(controlPlane),
      gateway,
      model,
      actorId: config.actorId,
      onDistilled: (job, report) => {
        if (report.state === "distilled") {
          console.log(
            `memory distillation ${job.workspace_id}: run ${report.run_id} ` +
              `accepted=${report.accepted} dropped=${report.dropped}`,
          );
        }
      },
      onError: (error) => {
        console.error("memory distillation:", error);
      },
    });
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
      enterpriseUsers: identity.enterpriseUsers,
      capabilityCeilings,
      // The memory team-leader exception reads the live team rows; enterprise
      // administration is checked from the separate enterprise grant.
      teams: repos.teams,
      isEnterpriseAdmin: (userId) =>
        identity.enterpriseRoles.getByUser(config.enterpriseId, userId)?.role === "admin",
      // Duties come only from explicit deployment/configuration listing. An
      // ordinary role change never edits this directory.
      securityDuties:
        options.securityDutyDirectory ??
        staticDutyDirectory({
          taskOwners: config.securityTaskOwnerIds ?? [],
          handlers: config.securityHandlerIds ?? [],
          reviewers: config.securityReviewerIds ?? [],
          admins: config.securityAdminIds ?? [],
        }),
      epoch: providerEpoch,
      enterpriseId: config.enterpriseId,
      workspaceId: config.workspaceId,
    });
    // Sensitive worker steps (DAT-285). A remediation run outlives the request
    // that created it, so every `dsh_request_action` re-asks the live boundary:
    // the bound repository set must still be the version the run was created
    // against, and the recorded requester must still hold `write` authority in
    // that workspace. Both reads are durable, so a revocation or downgrade
    // observed by another process (or before a restart) applies here too.
    runStepAuthority = createRunStepAuthority({
      enterpriseId: config.enterpriseId,
      actorId: config.actorId,
      repositorySets: workspaceRepositorySets,
      authority: providerAuthority,
    });

    // Workspace membership (DAT-277) is decided from the caller's live role
    // plus the target's verified provider capabilities, and every mutation
    // commits with its audit row. It shares the request authority and the
    // invalidation hub so a removal/downgrade cuts derived access and streams.
    members = new WorkspaceMemberService({
      repos,
      identity,
      access: providerAccess,
      repositorySets: workspaceRepositorySets,
      capabilityCeilings,
      admission: memberAdmission,
      authority: providerAuthority,
      hub: auth.hub,
      epoch: providerEpoch,
      enterpriseId: config.enterpriseId,
    });
    // DAT-247's service credential boundary: secrets come from a protected
    // file (or explicit injection), never from a user OAuth token. An empty
    // store makes the point refresh fail closed.
    const serviceCredentials =
      options.providerServiceCredentials ??
      (config.providerServiceCredentialFile !== undefined
        ? readServiceCredentialFile(config.providerServiceCredentialFile)
        : createStaticServiceCredentialStore({}));
    // Administrator-controlled integration initialization (DAT-267). Every
    // binding is resolved from the workspace row, the referenced credentials
    // must already resolve in the boundary above, and the audit row commits in
    // the same transaction as the state change.
    serviceIntegrations = createServiceIntegrationService({
      db: controlPlane,
      enterpriseId: config.enterpriseId,
      workspaces: repos.workspaces,
      providerInstances: repos.providerInstances,
      enterpriseRoles: identity.enterpriseRoles,
      enterpriseUsers: identity.enterpriseUsers,
      integrations: providerAccess.integrations,
      credentials: serviceCredentials,
      audit: identity.authAudit,
    });
    const providerApiBaseUrl = options.providerApiBaseUrl;
    // Candidate review, candidate-bound human approval, and broker-controlled
    // delivery (DAT-259). Constructed with the identity surface, because every
    // route is membership-scoped and approval eligibility is a live
    // control-plane + provider-roster fact. The real GitHub adapter (DAT-260)
    // resolves the *active* repository integration's delivery credential at
    // the moment of each call; an absent, suspended or credential-less
    // integration resolves to null and the adapter refuses every operation.
    const approvalDirectory = createApprovalDirectory({
      enterprise_id: config.enterpriseId,
      memberships: repos.memberships,
      users: identity.users,
      identities: identity.identities,
      access: providerAccess,
      // Approval eligibility is a workspace action: the issue repository's
      // roster fact alone is not enough once the workspace has a repository
      // set, so the gate's verified intersection decides (DAT-285).
      workspaceActionAllowed: (input) => {
        const decision = providerAuthority?.check(input.user_id, "approval", input.workspace_id);
        return decision?.allowed === true;
      },
    });
    // The delivery provider is the only write path to a repository, and the
    // read-only observer of the human merge (DAT-266). Both use the same
    // adapter and the same per-call credential resolution.
    const deliveryProviders: Partial<Record<"github" | "gitlab", DeliveryProvider>> =
      options.deliveryProviders ?? {
        github: createGitHubDeliveryProvider({
          credentials: serviceCredentials,
          resolve: (repository) => {
            const integration = providerAccess.integrations.getByRepository(
              {
                enterprise_id: config.enterpriseId,
                actor_id: "collab-delivery-provider",
              },
              repository.repository_id,
            );
            if (
              integration === undefined ||
              integration.install_status !== "active" ||
              integration.delivery_credential_ref === null
            ) {
              return null;
            }
            return {
              canonical_repository_id: integration.repository_id,
              credential_ref: integration.delivery_credential_ref,
            };
          },
          ...(providerApiBaseUrl !== undefined ? { api_base_url: providerApiBaseUrl } : {}),
        }),
      };
    const deliveryProviderFor = (provider: "github" | "gitlab"): DeliveryProvider | undefined =>
      deliveryProviders[provider];
    // Terminal-outcome capture (DAT-264): a durable outbox over the same
    // control-plane database. The enqueue comes from the task projection's
    // server-side enterprise/workspace; the worker re-reads authoritative dsh
    // evidence and writes exactly one episode per terminal snapshot. A
    // provider-observed merge (DAT-266) is a second, delivery-keyed source:
    // it is built from the delivery record, its candidate, and a live provider
    // read, never from a dsh state.
    memoryCapture = createOutcomeCaptureScheduler({
      db: controlPlane,
      memory: memoryRepositories,
      dsh,
      actorId: config.actorId,
      deliveryOutcomes: {
        read: (deliveryId) => readDeliveryOutcome(collaboration, deliveryProviderFor, deliveryId),
      },
      onError: (error) => {
        console.error("memory outcome capture:", error);
      },
    });
    // The human merge is never announced to the service. This bounded watcher
    // observes delivered PRs and enqueues exactly one capture per merge; an
    // unreadable or unmerged PR enqueues nothing.
    deliveryWatcher = createDeliveryMergeWatcher({
      machine: collaboration,
      providerFor: deliveryProviderFor,
      capture: memoryCapture,
      onError: (error) => {
        console.error("delivery merge watch:", error);
      },
    });
    collab = {
      machine: collaboration,
      candidates: new CandidateReviewService(collaboration, candidateStore),
      approvals: new ApprovalService(collaboration, approvalDirectory),
      deliveries: new DeliveryBroker({
        machine: collaboration,
        providers: deliveryProviders,
        approvalDirectory,
        // The exact retained patch the approval covered. `read` re-hashes the
        // bytes, so a corrupted or substituted blob can never be pushed.
        candidateContent: { read: (digest) => candidateStore.read(digest) },
        deliveryAuthorized: createDeliveryPermission({
          machine: collaboration,
          access: providerAccess,
          workspaces: repos.workspaces,
          enterprise_id: config.enterpriseId,
          // Re-check the requester's capability immediately before each
          // provider write (DAT-276): a recorded "was authorized" boolean does
          // not survive a confirmed downgrade.
          requesterCapability: (input) => {
            const decision = providerAuthority?.check(
              input.user_id,
              "delivery",
              input.workspace_id,
            );
            return decision?.allowed === true;
          },
        }),
        auditAvailable: () => collaboration.auditAvailable(),
      }),
      // Read-only governance observation (DAT-261). GitHub check runs,
      // decisive reviews, and review-thread resolution are read through the
      // integration's *source* credential; the adapter has no approve, merge,
      // dismiss, or check-waiver operation, and a failed read is reported as
      // blocked/unknown instead of reusing the last head's facts.
      governance: new PullRequestGovernanceService({
        provider:
          options.prGovernanceProvider ??
          createGitHubGovernanceProvider({
            credentials: serviceCredentials,
            resolve: (repository) => {
              const integration = providerAccess.integrations.getByRepository(
                {
                  enterprise_id: config.enterpriseId,
                  actor_id: "collab-governance-observer",
                },
                repository.repository_id,
              );
              if (integration === undefined || integration.install_status !== "active") {
                return null;
              }
              return {
                canonical_repository_id: integration.repository_id,
                credential_ref: integration.source_credential_ref,
              };
            },
            ...(providerApiBaseUrl !== undefined ? { api_base_url: providerApiBaseUrl } : {}),
          }),
      }),
    };
    // The workspace-scoped task family resolves each locator against the
    // authenticated control plane, not against process config (DAT-245).
    workspaceBindings = createWorkspaceRunBindingResolver({
      config,
      workspaces: repos.workspaces,
      providerInstances: repos.providerInstances,
      // DAT-281: the workspace's versioned repository set is cross-checked on
      // every workspace-scoped run binding. A multi-repository or missing set
      // fails closed instead of dispatching against one repository.
      repositorySets: workspaceRepositorySets,
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
    issues = new IssueSyncService({
      enterprise_id: config.enterpriseId,
      actor_id: config.actorId,
      workspaces: repos.workspaces,
      providerInstances: repos.providerInstances,
      integrations: providerAccess.integrations,
      bindings: workspaceBindings,
      machine: collaboration,
      store: new IssueSyncStore(controlPlane),
      credentials: serviceCredentials,
    });
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
    preparation,
    ...(memory !== undefined && rsi !== undefined ? { memory: { memory, rsi } } : {}),
    ...(memoryCapture !== undefined ? { capture: memoryCapture } : {}),
    ...(runStepAuthority !== undefined ? { runStepAuthority } : {}),
  });
  // Workspace dashboard (DAT-230): a read-only projection over the ledger,
  // budget journal, trace and task event log. It is only served when the
  // identity surface exists, because every route is session-scoped; an
  // injected test source wins over the deployment store.
  const dashboardSources: DashboardSources = {
    ...(deploymentStores.usageLedger !== undefined ? { ledger: deploymentStores.usageLedger } : {}),
    ...(deploymentStores.budgetStore !== undefined ? { budget: deploymentStores.budgetStore } : {}),
    ...options.dashboardSources,
    tasks: options.dashboardSources?.tasks ?? store,
  };
  const dashboard =
    auth !== undefined && requestScopeDeps !== undefined
      ? new DashboardService({
          sources: dashboardSources,
          audit: new DashboardAuditLog({
            ...(config.dashboardAuditFile !== undefined
              ? { persistencePath: config.dashboardAuditFile }
              : {}),
          }),
        })
      : undefined;

  // Runtime diagnostics (DAT-257) reuse the exact objects this process runs
  // with: the resolved model and live dsh client, never a second configuration
  // read. Paths stay basenames on the API; the CLI reports full paths.
  const diagnostics = (): Promise<RuntimeDiagnostics> => {
    let activeWorkspaces: GatewayScope[] | undefined;
    try {
      activeWorkspaces = listDiagnosticScopes?.();
    } catch {
      activeWorkspaces = undefined;
    }
    return collectRuntimeDiagnostics({
      config,
      dsh,
      model,
      resolveModel: false,
      startedAt,
      ...(activeWorkspaces !== undefined ? { activeWorkspaces } : {}),
    });
  };

  const server = createApiServer({
    service,
    apiToken,
    legacyWorkspaceId: config.workspaceId,
    runtimeDiagnostics: diagnostics,
    ...(auth !== undefined ? { auth } : {}),
    ...(providerAuthority !== undefined ? { authority: providerAuthority } : {}),
    ...(invitations !== undefined ? { invitations } : {}),
    ...(members !== undefined ? { members } : {}),
    ...(repositorySetChanges !== undefined ? { repositorySetChanges } : {}),
    ...(repositoryCandidates !== undefined ? { repositoryCandidates } : {}),
    ...(serviceIntegrations !== undefined ? { serviceIntegrations } : {}),
    ...(issues !== undefined ? { issues } : {}),
    ...(collab !== undefined ? { collab } : {}),
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
    ...(dashboard !== undefined && auth !== undefined && requestScopeDeps !== undefined
      ? {
          dashboard: {
            auth,
            service: dashboard,
            scope: requestScopeDeps,
            ...(providerAuthority !== undefined ? { authority: providerAuthority } : {}),
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
    memoryCapture,
    memoryDistillation,
    rsi,
    rsiStore,
    dashboard,
    collaboration,
    candidateStore,
    collab,
    apiToken,
    diagnostics,
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
        // Capture every terminal run the recovered projection holds before the
        // API serves reads: a restart resumes the outbox instead of losing the
        // outcomes that reached dsh terminal states while this process was
        // down. Failures stay pending in the outbox for the retry cadence.
        if (memoryCapture !== undefined) {
          const registrations: TerminalRunRegistration[] = [];
          for (const record of store.list()) {
            for (const run of record.runs) {
              if (!isCaptureTerminalState(run.state)) {
                continue;
              }
              registrations.push({
                enterprise_id: record.enterpriseId,
                workspace_id: record.workspaceId,
                task_id: record.id,
                run_id: run.run_id,
                state: run.state,
              });
            }
          }
          await memoryCapture.recover(registrations).catch((error: unknown) => {
            console.error("memory outcome capture recovery skipped:", error);
          });
        }
        memoryCapture?.start();
        // Observe already-open deliveries once at startup, then on the watch
        // cadence: a merge that happened while the service was down is picked
        // up without waiting for a fresh delivery.
        deliveryWatcher?.start();
        void deliveryWatcher?.scan().catch((error: unknown) => {
          console.error("delivery merge watch skipped:", error);
        });
        // Distillation derives its work from the capture outbox before the API
        // serves reads (a DB-only step), then processes rows on its retry
        // cadence plus one immediate pass: snapshots captured while this
        // process was down resume once, never twice, and a slow gateway call
        // never delays readiness.
        if (memoryDistillation !== undefined) {
          try {
            memoryDistillation.sync();
          } catch (error: unknown) {
            console.error("memory distillation recovery skipped:", error);
          }
          memoryDistillation.start();
          void memoryDistillation
            .drain()
            .catch((error: unknown) =>
              console.error("memory distillation recovery skipped:", error),
            );
        }
        // Sleep-time consolidation begins with the service, never before it.
        memoryConsolidation?.start();
        issues?.startPolling();
        return bound;
      });
    },
    stop: () => {
      deliveryWatcher?.stop();
      memoryConsolidation?.stop();
      memoryDistillation?.stop();
      memoryCapture?.stop();
      issues?.stopPolling();
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
  let config: OrchestratorConfig;
  let orchestrator: OrchestratorHandle;
  try {
    config = configFromEnv();
    orchestrator = createOrchestrator({ config });
  } catch (error) {
    // A refused configuration is a blocked startup, not a stack trace: name
    // the problem and the next command, and never echo a secret value.
    const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
    console.error(`runtime blocked: ${detail}`);
    console.error("Run `npm run doctor` for a redacted configuration report, then restart.");
    process.exitCode = 2;
    return;
  }
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
  console.log(
    `runtime diagnostics: GET http://${host}:${port}/api/v1/runtime/diagnostics (operator bearer)`,
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
