#!/usr/bin/env node
/**
 * Isolated verification pack for real-model memory distillation (DAT-270).
 *
 * The DAT-265/DAT-266 pipeline is exercised end to end in one process:
 *
 *   trusted terminal outcome -> capture snapshot -> distillation outbox ->
 *   ADR-0005 model gateway (scan gate, credentials, policy, budget, audit) ->
 *   schema/evidence validation -> DAT-234 admission -> `candidate` item ->
 *   subsequent-run retrieval reference.
 *
 * Two modes, never confused with each other:
 *
 * - `fixture` (default): the model transport is a loopback OpenAI-compatible
 *   server inside this process. It proves the harness and every gateway
 *   boundary work, and it is labelled `fixture_local_provider` in the evidence.
 *   It is NOT real-model evidence and the script refuses to claim otherwise.
 * - `real`: requires explicit authorization (`--authorization-ref`), a real
 *   captured outcome (`--envelope-file`), the protected gateway policy and
 *   credential files, an approved Pi model, and a budget policy. Ambient
 *   provider credential variables are refused. Only then is the deployment's
 *   approved endpoint called, and only through the gateway.
 *
 * The output is a redacted evidence document: identifiers, versions, counts,
 * digests, and stable reason codes. It never contains a statement, a change
 * summary, a credential, an email address, a home path, or a raw envelope.
 *
 * Nothing here approves memory, writes to a provider, or widens a grant. The
 * only persistence is the isolated SQLite database under `--state-dir`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Api, Context, Model } from "@mariozechner/pi-ai";

import {
  BudgetAuthority,
  createBudgetStore,
  createStaticBudgetPolicyResolver,
  validateBudgetPolicy,
} from "../src/budget/index.js";
import type { BudgetPolicy } from "../src/budget/index.js";
import {
  ScopeError,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import {
  captureOutcome,
  classifyOutcome,
  createCaptureJobStore,
  createMemoryDistillationRunner,
  buildDistillationContext,
  buildEvidenceLedger,
  parseDistillationOutput,
  parseOutcomeEnvelope,
  redactText,
  validateCandidates,
  assertNoSecretOrPii,
  DISTILL_PROMPT_VERSION,
} from "../src/distill/index.js";
import type { CapturedOutcome } from "../src/distill/index.js";
import {
  DATA_CLASSES,
  ModelEgressDeniedError,
  SENSITIVE_DATA_UNCERTAIN,
  createFileEventSink,
  createModelGateway,
  createPatternSecretScanner,
  createScopeBackedPolicyResolver,
  createStaticCredentialStore,
  parseScopedPolicies,
  piAiProviderAdapter,
  providerCredentialEnvVars,
  readCredentialFile,
} from "../src/gateway/index.js";
import type {
  GatewayAttemptEvent,
  GatewayBindingIdentity,
  GatewayPolicy,
  GatewayScope,
  ModelGateway,
  ScopedPolicyBinding,
} from "../src/gateway/index.js";
import { createUsageLedgerStore } from "../src/ledger/index.js";
import {
  admitCandidate,
  createMemoryAdmissionRepository,
  createMemoryRepositories,
  createMemoryRetrievalService,
  createRetrievalStore,
  ledgerEvidenceResolver,
} from "../src/memory/index.js";
import type {
  AdmissionCandidate,
  EvidenceResolution,
  MemoryAdmissionRepository,
  MemoryRepositories,
} from "../src/memory/index.js";
import { resolveConfiguredModel } from "../src/pi/model.js";

export const EVIDENCE_SCHEMA_VERSION = 1;
export const ISSUE_KEY = "DAT-270";

/** Stable identities used by the synthetic fixture outcome. */
export const FIXTURE_RUN_ID = "run-dat270-verify";
export const FIXTURE_TASK_ID = "task-dat270-verify";
export const FIXTURE_ISSUE_ID = "issue-dat270-verify";
export const FIXTURE_TEST_EVIDENCE = `evidence://events/${FIXTURE_RUN_ID}/vitest`;
export const FIXTURE_REVIEW_EVIDENCE = `evidence://review/${FIXTURE_RUN_ID}/approval`;

/**
 * The one candidate the fixture provider emits. The duplicate probe re-admits
 * exactly this content, so admission's content hash is what it is asserted on.
 */
export const FIXTURE_CANDIDATE_STATEMENT =
  "The focused vitest suite is the required check before a change is proposed in the node workspace.";
export const FIXTURE_CANDIDATE_PRECONDITIONS = ["node workspace with vitest configured"];
export const FIXTURE_CANDIDATE_OUTPUT = JSON.stringify({
  candidates: [
    {
      kind: "lesson",
      statement: FIXTURE_CANDIDATE_STATEMENT,
      preconditions: FIXTURE_CANDIDATE_PRECONDITIONS,
      scope: { path_prefix: "node/" },
      evidence: [
        { evidence_type: "test", reference: FIXTURE_TEST_EVIDENCE },
        { evidence_type: "reviewer_decision", reference: FIXTURE_REVIEW_EVIDENCE },
      ],
    },
  ],
});

/** Environment names this harness reads; none of them may hold a secret. */
export const VERIFICATION_ENV = {
  gatewayPolicyFile: "FORGEPILOT_GATEWAY_POLICY_FILE",
  gatewayCredentialsFile: "FORGEPILOT_GATEWAY_CREDENTIALS_FILE",
  modelProvider: "FORGEPILOT_PI_PROVIDER",
  modelId: "FORGEPILOT_PI_MODEL",
  modelBaseUrl: "FORGEPILOT_PI_BASE_URL",
  budgetPolicyFile: "FORGEPILOT_BUDGET_POLICY_FILE",
} as const;

// ---------------------------------------------------------------------------
// CLI and guards
// ---------------------------------------------------------------------------

export type VerificationMode = "fixture" | "real";

export interface VerificationArgs {
  mode: VerificationMode;
  /** Non-secret reference to the human authorization, e.g. an issue comment. */
  authorizationRef: string | null;
  /** Real captured outcome envelope; required in real mode. */
  envelopeFile: string | null;
  evidenceOut: string;
  stateDir: string | null;
  keepState: boolean;
  /** Selects one policy scope when the policy file holds several. */
  policyScope: string | null;
  help: boolean;
}

const USAGE = `Usage: node dist/scripts/real-model-distillation-verify.js [options]

  --fixture                     Run with the in-process loopback fixture provider (default).
  --real                        Call the deployment's approved provider via the gateway.
                                Requires --authorization-ref, --envelope-file, gateway
                                policy/credential files, an approved Pi model, and a
                                budget policy. Ambient provider credentials are refused.
  --authorization-ref <ref>     Non-secret human authorization reference (real mode).
  --envelope-file <path>        Redacted envelope captured from a trusted terminal outcome.
  --policy-scope <ent>/<ws>     Pick one policy binding when the file has several.
  --evidence-out <path>         Where to write the redacted evidence JSON (required).
  --state-dir <path>            Durable isolated state directory (default: temp dir).
  --keep-state                  Keep the isolated database after the run.
  --help

Exit codes: 0 verified, 1 a verification assertion failed, 2 blocked before
any dispatch (missing authorization/configuration, ambient credentials).`;

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseVerificationArgs(argv: readonly string[]): VerificationArgs {
  const args: VerificationArgs = {
    mode: "fixture",
    authorizationRef: null,
    envelopeFile: null,
    evidenceOut: "",
    stateDir: null,
    keepState: false,
    policyScope: null,
    help: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (seen.has(flag)) {
      throw new Error(`${flag} may only be given once`);
    }
    seen.add(flag);
    switch (flag) {
      case "--fixture":
        args.mode = "fixture";
        break;
      case "--real":
        args.mode = "real";
        break;
      case "--authorization-ref":
        args.authorizationRef = takeValue(argv, index, flag);
        index += 1;
        break;
      case "--envelope-file":
        args.envelopeFile = takeValue(argv, index, flag);
        index += 1;
        break;
      case "--policy-scope":
        args.policyScope = takeValue(argv, index, flag);
        index += 1;
        break;
      case "--evidence-out":
        args.evidenceOut = takeValue(argv, index, flag);
        index += 1;
        break;
      case "--state-dir":
        args.stateDir = takeValue(argv, index, flag);
        index += 1;
        break;
      case "--keep-state":
        args.keepState = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!args.help && args.evidenceOut.trim() === "") {
    throw new Error("--evidence-out is required");
  }
  return args;
}

/**
 * Everything that must be true before real-model egress is even attempted.
 * Each entry is a stable code plus a non-secret explanation. An empty list is
 * the only condition under which real mode may dispatch.
 */
export function realModeBlockers(
  args: Pick<VerificationArgs, "authorizationRef" | "envelopeFile">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const blockers: string[] = [];
  const ambient = providerCredentialEnvVars(env);
  if (ambient.length > 0) {
    blockers.push(`AMBIENT_PROVIDER_CREDENTIALS:${ambient.join(",")}`);
  }
  if ((args.authorizationRef ?? "").trim().length === 0) {
    blockers.push("AUTHORIZATION_REFERENCE_MISSING");
  }
  if ((args.envelopeFile ?? "").trim() === "") {
    blockers.push("TRUSTED_OUTCOME_ENVELOPE_MISSING");
  } else if (!fs.existsSync(args.envelopeFile as string)) {
    blockers.push("TRUSTED_OUTCOME_ENVELOPE_UNREADABLE");
  }
  for (const [name, value] of Object.entries(VERIFICATION_ENV)) {
    if (name === "modelBaseUrl") {
      continue;
    }
    if ((env[value] ?? "").trim() === "") {
      blockers.push(`CONFIG_MISSING:${value}`);
    }
  }
  return blockers;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = (env[name] ?? "").trim();
  if (value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixture provider (loopback OpenAI-compatible transport)
// ---------------------------------------------------------------------------

export interface FixtureProvider {
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
}

/**
 * A loopback OpenAI-compatible chat-completions endpoint that streams one
 * fixed distillation-response object. It exists so the harness can exercise
 * the real `piAiProviderAdapter`, gateway scan gate, usage ledger, and budget
 * path without any network egress. The evidence labels it as a fixture.
 */
export async function startFixtureProvider(
  responseText: string = FIXTURE_CANDIDATE_OUTPUT,
  modelId = "fixture-distill-v1",
): Promise<FixtureProvider> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      if (request.method !== "POST" || request.url !== "/chat/completions") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected fixture request" }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = {
        id: "chatcmpl-dat270-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: modelId,
        choices: [
          { index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null },
        ],
      };
      const done = {
        id: "chatcmpl-dat270-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 },
      };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(`data: ${JSON.stringify(done)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// Synthetic trusted outcome (fixture mode only)
// ---------------------------------------------------------------------------

export function fixtureEnvelope(): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    task_id: FIXTURE_TASK_ID,
    run_id: FIXTURE_RUN_ID,
    issue_id: FIXTURE_ISSUE_ID,
    terminal_state: "merged",
    delivery: {
      patch_status: "merged",
      head_sha: "head-dat270-verify",
      pr_id: "pr-dat270-verify",
      change_summary: "Verification fixture: a merged change with retained test evidence.",
      validation: [
        {
          tool: "npm test -- --run",
          exit_status: 0,
          event_reference: FIXTURE_TEST_EVIDENCE,
        },
      ],
    },
    evidence: [{ evidence_type: "reviewer_decision", reference: FIXTURE_REVIEW_EVIDENCE }],
  };
}

function episodeOnlyEnvelope(terminalState: "timed_out" | "stopped", suffix: string) {
  const base: Record<string, unknown> = {
    contract_version: "1.0.0",
    task_id: `task-dat270-${suffix}`,
    run_id: `run-dat270-${suffix}`,
    issue_id: `issue-dat270-${suffix}`,
    terminal_state: terminalState,
    delivery: {
      patch_status: "not_created",
      head_sha: null,
      pr_id: null,
      change_summary: "Episode-only verification outcome.",
      validation: [],
    },
    evidence: [{ evidence_type: "run", reference: `evidence://events/run-dat270-${suffix}/1` }],
  };
  if (terminalState === "stopped") {
    base["stop_disposition"] = "unknown";
  }
  return base;
}

// ---------------------------------------------------------------------------
// Evidence document
// ---------------------------------------------------------------------------

export type ScenarioStatus = "passed" | "failed";

export interface ScenarioResult {
  id: string;
  status: ScenarioStatus;
  /** Stable, content-free description of what was observed. */
  detail: string;
}

export interface UsageEvidence {
  records: Array<{
    invocation_id: string;
    attempt: number;
    finish_status: string;
    completeness: string;
    total_tokens: number | null;
    returned_model: string | null;
    provider_request_id: string | null;
  }>;
  /** Cost is what the provider/transport reported; never zero-filled. */
  cost_semantics: "provider_reported_estimate_or_unknown_never_zero_filled";
}

export interface VerificationEvidence {
  schema_version: number;
  issue: string;
  verification_mode: "fixture_local_provider" | "real_model";
  /** True only for a real-provider run with authorization and configuration. */
  accepted_as_real_model_evidence: boolean;
  status: "verified" | "failed" | "blocked";
  created_at: string;
  baseline: { commit: string | null; node_version: string };
  authorization: { present: boolean; reference: string | null };
  configuration: {
    model_provider: string;
    model_id: string;
    endpoint_base_url: string;
    gateway_policy_revision: string;
    gateway_endpoint_id: string;
    credential_ref: string;
    budget: { configured: boolean; revision: string | null };
    policy_binding: "deployment_policy_rebound_to_isolated_scope" | "fixture_policy";
  };
  outcome: {
    source: "supplied_envelope" | "synthetic_fixture";
    envelope_digest: string;
    terminal_state: string;
    outcome_class: string;
    run_id: string;
    task_id: string;
    issue_id: string;
    capture_job_id: string;
  } | null;
  distillation: {
    job_id: string;
    state: string;
    prompt_template_version: string;
    model_id: string;
    accepted: number;
    dropped: number;
    last_error: string | null;
  } | null;
  candidate: {
    item_id: string;
    item_version: number;
    status: string;
    kind: string;
    evidence_references: string[];
    candidate_hash: string | null;
    admission_disposition: string | null;
  } | null;
  human_review: {
    status: "required" | "not_available";
    item_id: string | null;
    item_version: number | null;
    action: string;
  };
  next_run_reference: {
    verified: boolean;
    purpose: string;
    bundle_id: string | null;
    item_status: string | null;
    approved: boolean;
    candidate: boolean;
    tier: string | null;
  };
  usage: UsageEvidence;
  scenarios: ScenarioResult[];
  blockers: string[];
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Error class only; a message can carry request or provider content. */
function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return name === "" ? "UNKNOWN" : name;
}

/**
 * Final fail-closed self-check: the evidence document itself must not carry
 * secret- or personal-shaped material. Called before anything is written.
 */
export function assertEvidenceRedacted(evidence: VerificationEvidence): void {
  assertNoSecretOrPii(JSON.stringify(evidence), "verification evidence");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface VerificationDeps {
  env: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to the real loopback fixture server. */
  fixtureProvider?: (responseText: string) => Promise<FixtureProvider>;
  now?: () => Date;
}

interface GatewayBundle {
  gateway: ModelGateway;
  model: Model<Api>;
  policy: GatewayPolicy;
  endpointId: string;
  credentialRef: string;
  events: GatewayAttemptEvent[];
  budgetRevision: string | null;
  usageLedger: ReturnType<typeof createUsageLedgerStore>;
}

function fixtureModel(baseUrl: string): Model<Api> {
  return {
    id: "fixture-distill-v1",
    name: "fixture-distill-v1",
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
}

function loadPolicyForRealMode(
  policyFile: string,
  policyScope: string | null,
  isolatedScope: GatewayScope,
): { binding: ScopedPolicyBinding; policy: GatewayPolicy } {
  const parsed: unknown = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  const bindings = parseScopedPolicies(parsed);
  const selected =
    policyScope === null
      ? bindings.length === 1
        ? bindings[0]
        : undefined
      : (() => {
          const [enterpriseId, workspaceId] = policyScope.split("/");
          return bindings.find(
            (binding) =>
              binding.scope.enterpriseId === enterpriseId &&
              binding.scope.workspaceId === workspaceId,
          );
        })();
  if (selected === undefined) {
    throw new Error(
      "the gateway policy file must contain exactly one binding or --policy-scope must select one",
    );
  }
  // The approved endpoint/model/data-class configuration is preserved exactly;
  // only the scope it resolves for is the isolated verification workspace. The
  // gateway still enforces scope resolution, scan, credentials, and audit.
  return {
    binding: { scope: isolatedScope, policy: selected.policy },
    policy: selected.policy,
  };
}

function fixtureBudgetPolicy(): BudgetPolicy {
  return validateBudgetPolicy({
    revision: "dat270-fixture-budget-1",
    enterprise: { monetary: [], tokens: 400_000 },
    workspace: { monetary: [], tokens: 200_000 },
    run: { monetary: [], tokens: 100_000 },
    max_tokens_per_invocation: 50_000,
    token_only: { enabled: true, reason: "DAT-270 offline verification fixture" },
    cost_ceilings: [],
  });
}

async function prepareGateway(input: {
  mode: VerificationMode;
  env: NodeJS.ProcessEnv;
  isolatedScope: GatewayScope;
  stateDir: string;
  policyScope: string | null;
  fixtureBaseUrl: string | null;
}): Promise<GatewayBundle> {
  const events: GatewayAttemptEvent[] = [];
  const sink = {
    record: (event: GatewayAttemptEvent): void => {
      events.push(event);
      fileSink.record(event);
    },
  };
  const fileSink = createFileEventSink(path.join(input.stateDir, "gateway-audit.jsonl"));
  const usageLedger = createUsageLedgerStore({
    persistencePath: path.join(input.stateDir, "usage-ledger.jsonl"),
  });

  let policy: GatewayPolicy;
  let model: Model<Api>;
  let credentials;
  let budgetPolicy: BudgetPolicy;
  let budgetRevision: string | null;
  if (input.mode === "fixture") {
    policy = {
      revision: "dat270-fixture-policy-1",
      endpoints: [
        {
          endpointId: "ep_dat270_fixture",
          provider: "openai",
          api: "openai-completions",
          baseUrl: input.fixtureBaseUrl as string,
          internal: true,
          credentialRef: "dat270-fixture-credential",
          models: ["fixture-distill-v1"],
          permittedDataClasses: [...DATA_CLASSES],
        },
      ],
      retry: { maxAttempts: 1 },
    };
    model = fixtureModel(input.fixtureBaseUrl as string);
    credentials = createStaticCredentialStore({
      "dat270-fixture-credential": "fixture-only-credential",
    });
    budgetPolicy = fixtureBudgetPolicy();
    budgetRevision = budgetPolicy.revision;
  } else {
    const policyFile = requireEnv(input.env, VERIFICATION_ENV.gatewayPolicyFile);
    const loaded = loadPolicyForRealMode(policyFile, input.policyScope, input.isolatedScope);
    policy = loaded.policy;
    credentials = readCredentialFile(
      requireEnv(input.env, VERIFICATION_ENV.gatewayCredentialsFile),
    );
    model = resolveConfiguredModel({
      piModelProvider: requireEnv(input.env, VERIFICATION_ENV.modelProvider),
      piModelId: requireEnv(input.env, VERIFICATION_ENV.modelId),
      ...(input.env[VERIFICATION_ENV.modelBaseUrl]?.trim()
        ? { piBaseUrl: input.env[VERIFICATION_ENV.modelBaseUrl]?.trim() }
        : {}),
    }) as Model<Api>;
    budgetPolicy = validateBudgetPolicy(
      JSON.parse(fs.readFileSync(requireEnv(input.env, VERIFICATION_ENV.budgetPolicyFile), "utf8")),
    );
    budgetRevision = budgetPolicy.revision;
  }

  const budgetStore = createBudgetStore({
    persistencePath: path.join(input.stateDir, "budget-journal.jsonl"),
  });
  const budget = new BudgetAuthority({
    store: budgetStore,
    policyResolver: createStaticBudgetPolicyResolver(budgetPolicy, input.isolatedScope),
  });
  const endpoint = policy.endpoints[0];
  if (endpoint === undefined) {
    throw new Error("gateway policy has no endpoint");
  }
  const gateway = createModelGateway({
    policyResolver: createScopeBackedPolicyResolver([{ scope: input.isolatedScope, policy }]),
    credentials,
    adapter: piAiProviderAdapter,
    scanner: createPatternSecretScanner(),
    sink,
    // The disposal-case machinery is a deployment service. Verification only
    // needs the block to fail closed and stay audited; the stub records the
    // block location without moving any case or hold state.
    caseIntake: {
      recordGatewayBlock: () =>
        Promise.resolve({
          caseId: "case_dat270_verification_block",
          caseReference: "cr1.dat270_verification_block",
        }),
    },
    dependentWorkHold: { heldCaseFor: () => undefined },
    usageLedger,
    budget,
  });
  return {
    gateway,
    model,
    policy,
    endpointId: endpoint.endpointId,
    credentialRef: endpoint.credentialRef,
    events,
    budgetRevision,
    usageLedger,
  };
}

function bindingFor(
  scope: GatewayScope,
  issueId: string,
  runId: string,
  traceId: string,
): GatewayBindingIdentity {
  return {
    enterpriseId: scope.enterpriseId,
    workspaceId: scope.workspaceId,
    scopeAuthority: { resolve: () => ({ ...scope }) },
    issueId,
    runId,
    traceId,
  };
}

/** Scan gate: a secret-shaped request must be denied before any dispatch. */
async function scanBlockProbe(bundle: GatewayBundle, scope: GatewayScope): Promise<ScenarioResult> {
  const traceId = "probe-dat270-scan-block";
  const context: Context = {
    messages: [
      {
        role: "user",
        content: "deployment token ghp_DAT270VerificationNeverReal0123456789",
        timestamp: Date.now(),
      },
    ],
  };
  try {
    await bundle.gateway.dispatch(
      bundle.model,
      context,
      undefined,
      bindingFor(scope, "issue-dat270-probe", "run-dat270-probe", traceId),
    );
    return {
      id: "request_scan_block",
      status: "failed",
      detail: "the gateway dispatched a secret-shaped request",
    };
  } catch (error) {
    if (!(error instanceof ModelEgressDeniedError)) {
      return {
        id: "request_scan_block",
        status: "failed",
        detail: `unexpected error class ${error instanceof Error ? error.name : typeof error}`,
      };
    }
    const preDispatch = bundle.events.filter(
      (event) => event.phase === "pre_dispatch" && event.identity.traceId === traceId,
    );
    const codeOk = error.code === SENSITIVE_DATA_UNCERTAIN;
    const noDispatch = preDispatch.length === 0;
    return {
      id: "request_scan_block",
      status: codeOk && noDispatch ? "passed" : "failed",
      detail: `code=${error.code}; pre_dispatch_records=${String(preDispatch.length)}`,
    };
  }
}

/** Redaction: secret and personal material is minimized, then fails closed. */
function redactionProbe(): ScenarioResult {
  const raw =
    "contact ada@example.com at /Users/ada/private token ghp_DAT270RedactionNeverReal0123456789";
  const report = redactText(raw);
  const clean = report.text;
  const rawGone =
    !clean.includes("ada@example.com") &&
    !clean.includes("/Users/ada/private") &&
    !clean.includes("ghp_DAT270RedactionNeverReal0123456789");
  const kindsCovered =
    report.kinds.includes("secret") &&
    report.kinds.includes("email") &&
    report.kinds.includes("user_path");
  let rawRejected = false;
  try {
    assertNoSecretOrPii(raw, "probe");
  } catch {
    rawRejected = true;
  }
  return {
    id: "redaction",
    status: rawGone && kindsCovered && rawRejected ? "passed" : "failed",
    detail: `kinds=${report.kinds.sort().join(",")}; raw_rejected=${String(rawRejected)}`,
  };
}

/** Insufficient evidence: fabricated and empty citations are dropped. */
function insufficientEvidenceProbe(outcome: CapturedOutcome): ScenarioResult {
  const ledger = buildEvidenceLedger([outcome]);
  const output = parseDistillationOutput(
    JSON.stringify({
      candidates: [
        {
          kind: "lesson",
          statement: "Fabricated citation must not be persisted.",
          preconditions: ["node workspace with vitest configured"],
          evidence: [{ evidence_type: "test", reference: "evidence://events/fabricated/1" }],
        },
        {
          kind: "lesson",
          statement: "Empty citation list must not be persisted.",
          preconditions: ["node workspace with vitest configured"],
          evidence: [],
        },
      ],
    }),
  );
  const result = validateCandidates(output, ledger);
  const reasons = new Set(result.dropped.map((entry) => entry.reason));
  const ok =
    result.accepted.length === 0 &&
    reasons.has("unresolved_evidence") &&
    reasons.has("missing_evidence");
  return {
    id: "insufficient_evidence",
    status: ok ? "passed" : "failed",
    detail: `accepted=${String(result.accepted.length)}; reasons=${[...reasons].sort().join(",")}`,
  };
}

/** Episode-only outcomes never reach a model call. */
function timeoutUnknownProbe(memory: MemoryRepositories, scope: WorkspaceScope): ScenarioResult {
  const timedOut = classifyOutcome(
    parseOutcomeEnvelope(episodeOnlyEnvelope("timed_out", "timeout")),
  );
  const unknown = classifyOutcome(parseOutcomeEnvelope(episodeOnlyEnvelope("stopped", "unknown")));
  const ok =
    timedOut.episode_only &&
    !timedOut.known &&
    unknown.episode_only &&
    !unknown.known &&
    memory.items.list(scope, { kind: "episode" }).length > 0;
  return {
    id: "timeout_unknown_episode_only",
    status: ok ? "passed" : "failed",
    detail: `timed_out=${timedOut.class}/${String(timedOut.episode_only)}; unknown=${unknown.class}/${String(unknown.episode_only)}`,
  };
}

/** Cross-workspace composition is refused before any line is built. */
function crossWorkspaceProbe(
  memory: MemoryRepositories,
  scope: WorkspaceScope,
  foreign: CapturedOutcome,
): ScenarioResult {
  let refused = false;
  try {
    buildDistillationContext({ scope, outcomes: [foreign] });
  } catch (error) {
    refused = error instanceof ScopeError;
  }
  return {
    id: "cross_workspace_isolation",
    status: refused ? "passed" : "failed",
    detail: `foreign_workspace_refused=${String(refused)}`,
  };
}

/** Duplicate content re-admits into the same item, never a second one. */
function duplicateProbe(
  memory: MemoryRepositories,
  admission: MemoryAdmissionRepository,
  scope: WorkspaceScope,
  outcome: CapturedOutcome,
  provenance: AdmissionCandidate["provenance"],
  priorItemId: string,
): ScenarioResult {
  const ledger = buildEvidenceLedger([outcome]);
  const resolver = ledgerEvidenceResolver(
    [...ledger.values()].map((entry): EvidenceResolution => ({
      evidence_type: entry.evidence_type,
      reference: entry.reference,
      known: entry.known,
      positive: entry.positive,
    })),
  );
  const candidate: AdmissionCandidate = {
    kind: "lesson",
    scope: { path_prefix: "node/" },
    statement: FIXTURE_CANDIDATE_STATEMENT,
    preconditions: [...FIXTURE_CANDIDATE_PRECONDITIONS],
    provenance,
    trust: "agent",
    sensitivity: "internal",
    source_run_id: outcome.envelope.run_id,
    evidence: [
      { evidence_type: "test", reference: FIXTURE_TEST_EVIDENCE },
      { evidence_type: "reviewer_decision", reference: FIXTURE_REVIEW_EVIDENCE },
    ],
  };
  const outcomeValue = admitCandidate(memory, admission, scope, candidate, {
    evidence: resolver,
    run_id: outcome.envelope.run_id,
  });
  const merged = outcomeValue.item?.item.id === priorItemId;
  return {
    id: "duplicate_content_merges",
    status: merged ? "passed" : "failed",
    detail: `same_item=${String(merged)}; disposition=${outcomeValue.verdict.disposition}`,
  };
}

export async function runVerification(
  args: VerificationArgs,
  deps: VerificationDeps = { env: process.env },
): Promise<VerificationEvidence> {
  const env = deps.env;
  const mode: VerificationEvidence["verification_mode"] =
    args.mode === "real" ? "real_model" : "fixture_local_provider";
  const base: VerificationEvidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    issue: ISSUE_KEY,
    verification_mode: mode,
    accepted_as_real_model_evidence: false,
    status: "blocked",
    created_at: (deps.now ?? (() => new Date()))().toISOString(),
    baseline: { commit: gitCommit(), node_version: process.version },
    authorization: {
      present: (args.authorizationRef ?? "").trim().length > 0,
      reference: args.authorizationRef,
    },
    configuration: {
      model_provider: "",
      model_id: "",
      endpoint_base_url: "",
      gateway_policy_revision: "",
      gateway_endpoint_id: "",
      credential_ref: "",
      budget: { configured: false, revision: null },
      policy_binding:
        args.mode === "real" ? "deployment_policy_rebound_to_isolated_scope" : "fixture_policy",
    },
    outcome: null,
    distillation: null,
    candidate: null,
    human_review: {
      status: "not_available",
      item_id: null,
      item_version: null,
      action:
        "Named-human promotion through the DAT-251 memory governance surface; this harness never approves memory.",
    },
    next_run_reference: {
      verified: false,
      purpose: "run_plan",
      bundle_id: null,
      item_status: null,
      approved: false,
      candidate: false,
      tier: null,
    },
    usage: {
      records: [],
      cost_semantics: "provider_reported_estimate_or_unknown_never_zero_filled",
    },
    scenarios: [],
    blockers: [],
  };

  if (args.mode === "real") {
    const blockers = realModeBlockers(args, env);
    if (blockers.length > 0) {
      return { ...base, status: "blocked", blockers };
    }
  }

  const stateDir =
    args.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-dat270-verify-"));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db: ControlPlaneDb = openControlPlaneDb({
    path: path.join(stateDir, "verification.sqlite"),
  });
  let fixture: FixtureProvider | null = null;
  try {
    const { enterprise, admin_scope } = seedEnterprise(db, {
      enterprise_name: "DAT-270 Verification Enterprise",
      enterprise_slug: "dat270-verification",
      admin_user_id: "usr_dat270_operator",
    });
    const provider = seedProviderInstance(db, admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    const workspace = seedWorkspace(db, admin_scope, {
      name: "DAT-270 Verification Workspace",
      repository_id: "github:FoMo-Exp/AutoFixer",
      provider_instance_id: provider.id,
    });
    const sibling = seedWorkspace(db, admin_scope, {
      name: "DAT-270 Sibling Workspace",
      repository_id: "github:FoMo-Exp/Sibling",
      provider_instance_id: provider.id,
    });
    const scope: WorkspaceScope = {
      enterprise_id: enterprise.id,
      workspace_id: workspace.id,
      actor_id: "usr_dat270_operator",
    };
    const siblingScope: WorkspaceScope = {
      enterprise_id: enterprise.id,
      workspace_id: sibling.id,
      actor_id: "usr_dat270_operator",
    };
    const memory = createMemoryRepositories(db);
    const admission = createMemoryAdmissionRepository(db);
    const retrieval = createMemoryRetrievalService({
      memory,
      store: createRetrievalStore(db),
    });

    let fixtureBaseUrl: string | null = null;
    if (args.mode === "fixture") {
      const start = deps.fixtureProvider ?? startFixtureProvider;
      fixture = await start(FIXTURE_CANDIDATE_OUTPUT);
      fixtureBaseUrl = fixture.baseUrl;
    }
    let bundle: GatewayBundle;
    try {
      bundle = await prepareGateway({
        mode: args.mode,
        env,
        isolatedScope: { enterpriseId: scope.enterprise_id, workspaceId: scope.workspace_id },
        stateDir,
        policyScope: args.policyScope,
        fixtureBaseUrl,
      });
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        blockers: [`CONFIGURATION_INVALID:${safeErrorName(error)}`],
      };
    }

    let rawEnvelope: unknown;
    let storedEnvelope: string;
    try {
      rawEnvelope =
        args.mode === "real"
          ? (JSON.parse(fs.readFileSync(args.envelopeFile as string, "utf8")) as unknown)
          : fixtureEnvelope();
      storedEnvelope = JSON.stringify(parseOutcomeEnvelope(rawEnvelope));
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        blockers: [`TRUSTED_OUTCOME_ENVELOPE_INVALID:${safeErrorName(error)}`],
      };
    }

    const captured = captureOutcome(memory, scope, rawEnvelope);
    const captureJobs = createCaptureJobStore(db);
    const captureJob = captureJobs.enqueue({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      task_id: captured.envelope.task_id,
      run_id: captured.envelope.run_id,
      terminal_state: captured.envelope.terminal_state,
    });
    captureJobs.markCaptured(captureJob.id, captured.episode.item.id, {
      envelope: storedEnvelope,
      outcome_class: captured.classification.class,
      envelope_digest: sha256(storedEnvelope),
    });

    // Episode-only captures: no distillation row, no model call.
    for (const raw of [
      episodeOnlyEnvelope("timed_out", "timeout"),
      episodeOnlyEnvelope("stopped", "unknown"),
    ]) {
      const episode = captureOutcome(memory, scope, raw);
      const job = captureJobs.enqueue({
        enterprise_id: scope.enterprise_id,
        workspace_id: scope.workspace_id,
        task_id: episode.envelope.task_id,
        run_id: episode.envelope.run_id,
        terminal_state: episode.envelope.terminal_state,
      });
      const serialized = JSON.stringify(episode.envelope);
      captureJobs.markCaptured(job.id, episode.episode.item.id, {
        envelope: serialized,
        outcome_class: episode.classification.class,
        envelope_digest: sha256(serialized),
      });
    }

    // A foreign-workspace outcome for the isolation probe.
    const foreign = captureOutcome(memory, siblingScope, {
      ...fixtureEnvelope(),
      task_id: "task-dat270-foreign",
      run_id: "run-dat270-foreign",
      issue_id: "issue-dat270-foreign",
    });

    const runner = createMemoryDistillationRunner({
      db,
      memory,
      admission,
      gateway: bundle.gateway,
      model: bundle.model,
      actorId: scope.actor_id,
      leaseMs: 60_000,
      retryDelayMs: 60_000,
      intervalMs: 60 * 60 * 1000,
      batchSize: 10,
      ...(args.mode === "fixture"
        ? {
            onError: (error: unknown): void => {
              console.error("fixture distillation error:", error);
            },
          }
        : {}),
    });
    const derived = runner.sync();
    const drain = await runner.drain();
    const jobs = runner.jobs.list({ workspace_id: scope.workspace_id });
    const job = jobs[0];
    const itemId = job === undefined ? null : ((JSON.parse(job.item_ids) as string[])[0] ?? null);
    const record = itemId === null ? undefined : memory.items.getById(scope, itemId);

    const provenance = {
      author_type: "agent" as const,
      agent_model: bundle.model.id,
      prompt_template_version: DISTILL_PROMPT_VERSION,
    };
    const decisions = itemId === null ? [] : admission.listDecisionsForItem(scope, itemId);

    base.configuration = {
      model_provider: bundle.model.provider,
      model_id: bundle.model.id,
      endpoint_base_url: new URL(bundle.policy.endpoints[0]?.baseUrl ?? "http://127.0.0.1").origin,
      gateway_policy_revision: bundle.policy.revision,
      gateway_endpoint_id: bundle.endpointId,
      credential_ref: bundle.credentialRef,
      budget: { configured: true, revision: bundle.budgetRevision },
      policy_binding:
        args.mode === "real" ? "deployment_policy_rebound_to_isolated_scope" : "fixture_policy",
    };
    base.outcome = {
      source: args.mode === "real" ? "supplied_envelope" : "synthetic_fixture",
      envelope_digest: sha256(storedEnvelope),
      terminal_state: captured.envelope.terminal_state,
      outcome_class: captured.classification.class,
      run_id: captured.envelope.run_id,
      task_id: captured.envelope.task_id,
      issue_id: captured.envelope.issue_id,
      capture_job_id: captureJob.id,
    };
    if (job !== undefined) {
      base.distillation = {
        job_id: job.id,
        state: job.state,
        prompt_template_version: job.prompt_template_version,
        model_id: job.model_id ?? bundle.model.id,
        accepted: job.accepted,
        dropped: job.dropped,
        last_error: job.last_error,
      };
    }
    if (record !== undefined && itemId !== null) {
      base.candidate = {
        item_id: itemId,
        item_version: record.item.current_version,
        status: record.item.status,
        kind: record.current.kind,
        evidence_references: memory.evidence
          .listByItem(scope, itemId)
          .map((entry) => entry.reference),
        candidate_hash: decisions[0]?.candidate_hash ?? null,
        admission_disposition: decisions[0]?.disposition ?? null,
      };
      base.human_review = {
        status: "required",
        item_id: itemId,
        item_version: record.item.current_version,
        action:
          "A named human reviews this exact version and promotes it through the DAT-251 memory governance surface; this harness never approves memory.",
      };
      const bundleForRun = retrieval.search(scope, {
        purpose: "run_plan",
        query: "focused vitest check proposed change node workspace",
        path_prefix: "node",
        role: "owner",
        run_id: "run-dat270-next",
      });
      const served = [
        ...bundleForRun.lessons,
        ...bundleForRun.facts,
        ...bundleForRun.episodes,
        ...bundleForRun.candidates,
      ].find((entry) => entry.item_id === itemId);
      base.next_run_reference = {
        verified: served !== undefined,
        purpose: "run_plan",
        bundle_id: bundleForRun.bundle_id,
        item_status: served?.status ?? null,
        approved: served?.approved ?? false,
        candidate: served?.candidate ?? false,
        tier: served?.tier ?? null,
      };
    }

    base.usage = {
      records: bundle.usageLedger
        .query({
          enterprise_id: scope.enterprise_id,
          workspace_id: scope.workspace_id,
          subject: scope.actor_id,
        })
        .map((record) => ({
          invocation_id: record.invocation_id,
          attempt: record.attempt,
          finish_status: record.finish_status,
          completeness: record.usage.completeness,
          total_tokens: record.usage.total_tokens,
          returned_model: record.returned_model,
          provider_request_id: record.provider_request_id,
        })),
      cost_semantics: "provider_reported_estimate_or_unknown_never_zero_filled",
    };

    const scenarios: ScenarioResult[] = [
      await scanBlockProbe(bundle, {
        enterpriseId: scope.enterprise_id,
        workspaceId: scope.workspace_id,
      }),
      redactionProbe(),
      insufficientEvidenceProbe(captured),
      timeoutUnknownProbe(memory, scope),
      crossWorkspaceProbe(memory, scope, foreign),
      itemId === null
        ? {
            id: "duplicate_content_merges",
            status: "failed" as const,
            detail: "no candidate was persisted to merge into",
          }
        : duplicateProbe(memory, admission, scope, captured, provenance, itemId),
    ];
    const pipelineOk =
      derived === 1 &&
      drain.distilled === 1 &&
      job?.state === "distilled" &&
      record?.item.status === "candidate" &&
      base.next_run_reference.verified;
    if (!pipelineOk) {
      scenarios.push({
        id: "known_outcome_to_candidate",
        status: "failed",
        detail: `derived=${String(derived)}; distilled=${String(drain.distilled)}; state=${job?.state ?? "none"}; status=${record?.item.status ?? "none"}`,
      });
    } else {
      scenarios.push({
        id: "known_outcome_to_candidate",
        status: "passed",
        detail: `derived=${String(derived)}; distilled=${String(drain.distilled)}; status=candidate`,
      });
    }

    const failed = scenarios.filter((scenario) => scenario.status === "failed");
    base.scenarios = scenarios;
    base.status = failed.length === 0 ? "verified" : "failed";
    // Real-model acceptance also needs the human review to happen later; the
    // harness can only certify the automated half.
    base.accepted_as_real_model_evidence = false;
    if (args.mode === "real" && failed.length === 0) {
      base.blockers = [
        "HUMAN_REVIEW_REQUIRED: a named human must promote the candidate before the chain is accepted",
      ];
    }
    return base;
  } finally {
    if (fixture !== null) {
      await fixture.close();
    }
    db.close();
    if (!args.keepState && args.stateDir === null) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

export function writeEvidence(evidence: VerificationEvidence, file: string): void {
  assertEvidenceRedacted(evidence);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseVerificationArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const evidence = await runVerification(args, { env: process.env });
  writeEvidence(evidence, args.evidenceOut);
  console.log(
    `verification ${evidence.status} (${evidence.verification_mode}); evidence: ${args.evidenceOut}`,
  );
  for (const scenario of evidence.scenarios) {
    console.log(
      `  ${scenario.status === "passed" ? "PASS" : "FAIL"} ${scenario.id}: ${scenario.detail}`,
    );
  }
  for (const blocker of evidence.blockers) {
    console.log(`  BLOCKED ${blocker}`);
  }
  if (evidence.status === "blocked") {
    return 2;
  }
  return evidence.status === "verified" ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error("verification failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
