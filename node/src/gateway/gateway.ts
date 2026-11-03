import { randomUUID } from "node:crypto";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import type { BudgetDenyReason, InvocationBudget } from "../budget/index.js";
import type { ProviderAdapter } from "./adapter.js";
import { buildAdapterOptions } from "./adapter.js";
import type { GatewayCredentialStore } from "./credentials.js";
import { UsageLedgerWriteError } from "../ledger/errors.js";
import type {
  LedgerFinishStatus,
  UsageLedgerSink,
  UsageReportObservation,
} from "../ledger/index.js";
import { matchEndpoint, matchFallback } from "./policy.js";
import type { GatewayPolicyResolver } from "./policy.js";
import { scrubSecrets } from "./redact.js";
import {
  authorizeRequestDataClasses,
  runRequestScanGate,
  type ScanDenyReason,
  type SecretScanPolicy,
  type SecretScanner,
} from "./scan.js";
import type {
  ApprovedEndpoint,
  GatewayAttemptDestination,
  GatewayAttemptEvent,
  GatewayBindingIdentity,
  GatewayCaseIntake,
  GatewayEventSink,
  GatewayFallback,
  GatewayRequestIdentity,
  GatewayScope,
  RequestScanEvidence,
} from "./types.js";
import {
  ModelBudgetReconciliationError,
  ModelDispatchError,
  ModelEgressDeniedError,
  MODEL_BUDGET_EXHAUSTED,
  MODEL_BUDGET_UNAVAILABLE,
  MODEL_EGRESS_DENIED,
  MODEL_TOKEN_CEILING_EXCEEDED,
  MODEL_USAGE_UNKNOWN,
  PROVIDER_USAGE_DIAGNOSTIC,
  SECURITY_REVIEW_REQUIRED,
  SENSITIVE_DATA_UNCERTAIN,
} from "./types.js";
import type { DependentWorkHold, GatewayDenyReason } from "./types.js";

/**
 * Scan-gate denials about uncertain secret handling surface under the stable
 * `SENSITIVE_DATA_UNCERTAIN` error code (ADR-0005); authorization and audit
 * denials stay `MODEL_EGRESS_DENIED`.
 */
function scanDenyErrorCode(reason: ScanDenyReason): string {
  return reason === "AUTHORIZATION_MISSING" ? MODEL_EGRESS_DENIED : SENSITIVE_DATA_UNCERTAIN;
}

export interface ModelGatewayDeps {
  policyResolver: GatewayPolicyResolver;
  credentials: GatewayCredentialStore;
  adapter: ProviderAdapter;
  /**
   * Complete-request secret scanner (DAT-209). A missing or failing scanner
   * is never clean: the gateway blocks the invocation instead of sending.
   */
  scanner?: SecretScanner;
  /** Separately authorized deterministic scan policies (minimization, derived). */
  scanPolicy?: SecretScanPolicy;
  /** Scanner timeout; a hung scanner is unavailable and blocks. */
  scanTimeoutMs?: number;
  /**
   * Required audit/metering sink; every attempt is recorded through it. The
   * gateway denies every dispatch when it is missing — required pre-dispatch
   * evidence (including scan evidence) must be durable before any byte is
   * sent.
   */
  sink?: GatewayEventSink;
  /**
   * Disposal-case intake for secret-gate blocks (DAT-210): opening or
   * associating the scoped human-handling case after the block. Required —
   * the production gateway always configures it; an untyped caller that
   * omits it still gets the full block and an explicit incident, never a
   * silent skip of human handling.
   */
  caseIntake: GatewayCaseIntake;
  /**
   * Dependent-work hold consulted at the admission boundary (DAT-210):
   * a held run's later invocations are rejected before any check or dispatch.
   * Required like `caseIntake`; without hold state the gateway cannot admit
   * work and fails closed.
   */
  dependentWorkHold: DependentWorkHold;
  /**
   * Invocation usage ledger (DAT-227). One usage record per actual dispatch
   * attempt — successes, failures, retries and fallbacks — is written through
   * this seam; attempts denied before dispatch record no usage. Unset leaves
   * attempts unmetered, so a deployment that keeps cost accounting wires it.
   */
  usageLedger?: UsageLedgerSink;
  /**
   * Budget authority (DAT-229). A conservative enterprise/workspace/run bound
   * is reserved before every dispatch attempt and settled against observed
   * usage. Unset leaves invocations unbudgeted; a deployment that enforces
   * cost limits always wires it.
   */
  budget?: InvocationBudget;
  now?: () => Date;
  newInvocationId?: () => string;
  /** Operational-incident channel for post-outcome audit failures. */
  onIncident?: (message: string) => void;
}

/** One dispatch destination slot: the primary model or a policy fallback. */
interface DestinationSlot {
  endpointId: string;
  modelId: string;
  fallback?: GatewayFallback;
}

/**
 * What is known about the provider side of one attempt:
 * - `known`: the provider completed or explicitly failed the attempt.
 * - `unknown`: bytes may have reached the provider but no outcome was read;
 *   the budget reservation is retained and the attempt is never re-sent.
 * - `not_dispatched`: the attempt provably never left the gateway, so its
 *   reservation is refunded.
 */
type ProviderOutcome = "known" | "unknown" | "not_dispatched";

type TerminalOutcome = {
  outcome: "dispatched" | "failed";
  detail?: string;
  /** Usage the provider reported; absent means never reported — not zero. */
  usage?: { tokens: number; completeness: "known" | "estimated" };
  /** Defaults to `known` when the transport reached a terminal decision. */
  providerOutcome?: ProviderOutcome;
};

/**
 * How one attempt closed, for both its audit outcome and its usage ledger
 * record. `terminal` is the transport's terminal message — the only place a
 * provider-reported usage, request id, or returned model can come from.
 * Paths that never saw a provider message (a dispatch failure, a synthetic
 * mid-stream error) pass none: the ledger records their usage as unknown
 * rather than trusting a zero-filled stand-in.
 */
type AttemptClose = {
  outcome: TerminalOutcome;
  finish: LedgerFinishStatus;
  terminal?: AssistantMessage;
};

type AttemptResult =
  | { status: "handed_off"; stream: AssistantMessageEventStream }
  | {
      status: "failed";
      detail: string;
      retryable: boolean;
      finish: LedgerFinishStatus;
      terminal?: AssistantMessage;
      providerOutcome?: ProviderOutcome;
    };

const CONTENT_EVENTS = new Set<AssistantMessageEvent["type"]>([
  "text_start",
  "thinking_start",
  "toolcall_start",
]);

/** Client-side errors a retry cannot fix; everything else transport-shaped retries. */
const NON_RETRYABLE_MARKERS =
  /\b(?:HTTP|status)\s*[:=]?\s*(?:400|401|403|404|422)\b|content_filter|invalid api key/i;

/**
 * Transport failures that prove the request never reached the provider. Only
 * these may refund a budget reservation; a reset or timeout may have been
 * served and keeps the reservation for reconciliation.
 */
const CERTAINLY_UNSENT = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/;

function isCertainlyUnsent(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CERTAINLY_UNSENT.test(code);
}

/** Map a budget-domain refusal into the gateway's stable denial vocabulary. */
function mapBudgetDenial(reason: BudgetDenyReason): {
  reason: GatewayDenyReason;
  code: string;
} {
  switch (reason) {
    case "BUDGET_LIMIT_EXCEEDED":
      return { reason: "BUDGET_EXHAUSTED", code: MODEL_BUDGET_EXHAUSTED };
    case "BUDGET_TOKEN_CEILING_EXCEEDED":
      return { reason: "TOKEN_CEILING_EXCEEDED", code: MODEL_TOKEN_CEILING_EXCEEDED };
    case "BUDGET_BOUND_UNKNOWN":
      return { reason: "BUDGET_BOUND_UNKNOWN", code: MODEL_BUDGET_UNAVAILABLE };
    case "BUDGET_POLICY_UNAVAILABLE":
      return { reason: "BUDGET_UNAVAILABLE", code: MODEL_BUDGET_UNAVAILABLE };
  }
}

/**
 * The conservative token bound of one attempt: the whole input context plus
 * the requested output ceiling. Zero usage is never assumed.
 */
function tokenBoundOf(model: Model<Api>, options: SimpleStreamOptions | undefined): number {
  const output = options?.maxTokens ?? model.maxTokens;
  return model.contextWindow + output;
}

/** Provider-reported usage, or undefined when nothing usable was reported. */
function usageOf(message: AssistantMessage): TerminalOutcome["usage"] {
  const usage = message.usage;
  const categories = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  // `totalTokens` may exclude cache categories; the larger figure is the
  // conservative billable stand-in for this attempt.
  const tokens = Math.max(usage.totalTokens, categories);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    return undefined;
  }
  return { tokens, completeness: "known" };
}

function isTerminalEvent(event: AssistantMessageEvent): boolean {
  return event.type === "done" || event.type === "error";
}

/**
 * The recorded outcome of a terminal event: a stream that ends in an error is
 * a failed invocation — including a caller abort, distinguished by its
 * detail — never a successful dispatch.
 */
function outcomeFromTerminal(event: AssistantMessageEvent): TerminalOutcome {
  if (event.type === "error") {
    const aborted = event.reason === "aborted";
    return {
      outcome: "failed",
      detail: event.error.errorMessage ?? (aborted ? "aborted" : "provider stream failed"),
      // A caller abort leaves the provider side unknown: the request was
      // already sent and its accounting cannot be released.
      providerOutcome: aborted ? "unknown" : "known",
    };
  }
  if (event.type === "done") {
    const usage = usageOf(event.message);
    return {
      outcome: "dispatched",
      providerOutcome: "known",
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return { outcome: "dispatched", providerOutcome: "known" };
}

/** The terminal message a provider-reported usage can only ride on. */
function messageOf(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === "done") {
    return event.message;
  }
  if (event.type === "error") {
    return event.error;
  }
  return undefined;
}

/** Ledger finish status derived from the provider terminal event. */
function finishFromEvent(event: AssistantMessageEvent): LedgerFinishStatus {
  if (event.type === "done") {
    return event.reason === "toolUse" ? "tool_use" : event.reason;
  }
  if (event.type === "error") {
    return event.reason;
  }
  return "unknown";
}

/**
 * The usage evidence for one attempt's ledger record. A transport that sees
 * the provider's own usage payload attaches it to the terminal message under
 * {@link PROVIDER_USAGE_DIAGNOSTIC} and it is passed through as `provider_wire`
 * evidence; otherwise the transport's own usage report is passed through.
 * Either way the ledger preserves the payload verbatim for reconciliation.
 */
function usageReportOf(terminal: AssistantMessage): UsageReportObservation {
  const wire = (terminal.diagnostics ?? []).find(
    (diagnostic) => diagnostic.type === PROVIDER_USAGE_DIAGNOSTIC && diagnostic.details,
  );
  if (wire?.details) {
    return { source: "provider_wire", payload: wire.details };
  }
  return { source: "transport_reported", payload: terminal.usage };
}

/**
 * Terminal error message for a mid-stream transport failure after handoff.
 * The zero-filled usage below is the pi-ai message-shape placeholder only —
 * the provider never reported usage for this attempt, and the usage ledger
 * records it as unknown rather than reading these zeros (DAT-227).
 */
function syntheticErrorMessage(model: Model<Api>, detail: string): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    content: [],
    stopReason: "error",
    errorMessage: detail,
  };
}

/**
 * The model gateway: the single fail-closed egress path for Pi model requests.
 *
 * Every dispatch resolves the enterprise/workspace policy, matches the
 * requested model to an explicitly registered endpoint, resolves the service
 * credential, persists pre-dispatch audit evidence, and only then touches a
 * provider adapter with a pinned endpoint. Retries, fallbacks, and model
 * switches run through exactly the same checks; there is no path around them.
 */
export class ModelGateway {
  private readonly deps: ModelGatewayDeps;

  constructor(deps: ModelGatewayDeps) {
    this.deps = deps;
  }

  /**
   * Bind one run's identity to a stream function. Every call through the
   * returned function is one gateway-checked invocation carrying the
   * enterprise/workspace/issue/run/trace identity for audit and metering.
   */
  bind(identity: GatewayBindingIdentity): StreamFn {
    const bound: StreamFn = (model, context, options) =>
      this.dispatch(model, context, options, identity);
    return bound;
  }

  async dispatch(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    binding: GatewayBindingIdentity,
  ): Promise<AssistantMessageEventStream> {
    // The authenticated scope (DAT-241) is resolved from live membership
    // state on every dispatch and every attempt: revocation, suspension, and
    // membership changes take effect in this request path with no cached
    // verdict, and a binding whose claim disagrees with the authenticated
    // scope is a cross-tenant binding — denied before any policy, credential,
    // or provider adapter is touched.
    const scope = this.resolveScope(binding, 1);
    if (scope instanceof ModelEgressDeniedError) {
      throw scope;
    }
    // Work-admission boundary (DAT-210): a run whose dependent work is held
    // pending security case disposition never re-enters the gateway. The hold
    // is scoped to the affected run alone; unrelated runs proceed untouched.
    const holdState = this.deps.dependentWorkHold;
    if (!holdState) {
      // Defensive (typed construction always provides hold state): without it
      // the gateway cannot establish that the run is unheld, so it fails
      // closed rather than admitting unproven work.
      this.incident("dependent-work hold state is not configured; refusing to admit run work");
      throw this.deny(
        this.mintIdentity(binding, scope),
        1,
        "DEPENDENT_WORK_HELD",
        "dependent-work hold state is unavailable; failing closed",
        undefined,
        undefined,
        SECURITY_REVIEW_REQUIRED,
      );
    }
    const hold = holdState.heldCaseFor(binding.runId);
    if (hold) {
      throw this.deny(
        this.mintIdentity(binding, scope),
        1,
        "DEPENDENT_WORK_HELD",
        "the run's dependent work is held pending security case disposition",
        undefined,
        undefined,
        SECURITY_REVIEW_REQUIRED,
        hold,
      );
    }
    const schedulePolicy = await this.deps.policyResolver.resolve(scope);
    if (!schedulePolicy) {
      throw this.deny(
        this.mintIdentity(binding, scope),
        1,
        "POLICY_UNAVAILABLE",
        "no model egress policy for this scope",
      );
    }
    const primary = matchEndpoint(schedulePolicy, model);
    if ("deny" in primary) {
      throw this.deny(
        this.mintIdentity(binding, scope),
        1,
        primary.deny,
        `model ${model.provider}/${model.id} has no approved endpoint`,
        { policyRevision: schedulePolicy.revision },
      );
    }
    const slots: DestinationSlot[] = [
      { endpointId: primary.endpoint.endpointId, modelId: model.id },
      ...(schedulePolicy.fallbacks ?? []).map((fallback) => ({
        endpointId: fallback.endpointId,
        modelId: fallback.modelId,
        fallback,
      })),
    ];

    let attempt = 0;
    let lastDetail = "model dispatch failed";
    let lastRetryable = true;
    // The retry budget is fixed by the policy the call started with; every
    // attempt still re-resolves the policy for its checks, so a mid-call
    // policy change can deny an attempt but cannot extend or shrink this
    // call's retry/fallback schedule.
    for (const slot of slots) {
      for (let round = 0; round < schedulePolicy.retry.maxAttempts; round += 1) {
        attempt += 1;
        const prepared = await this.prepare(slot, model, options, binding, attempt, context);
        if (prepared instanceof ModelEgressDeniedError) {
          throw prepared;
        }
        const result = await this.runAttempt(prepared);
        if (result.status === "handed_off") {
          return result.stream;
        }
        if (this.deps.budget && result.providerOutcome === "unknown") {
          // The provider may have served this attempt and its reservation is
          // retained; re-sending would consume budget twice. Reconcile first.
          throw new ModelBudgetReconciliationError(
            "model dispatch outcome is unknown; its budget reservation is retained for reconciliation",
            prepared.budgetReservation?.reservationId ?? null,
          );
        }
        lastDetail = result.detail;
        lastRetryable = result.retryable;
        if (!result.retryable) {
          throw new ModelDispatchError(
            `model dispatch failed: ${scrubSecrets(lastDetail, [prepared.credential])}`,
            false,
          );
        }
      }
    }
    throw new ModelDispatchError(
      `model dispatch failed after ${attempt} attempt(s): ${scrubSecrets(lastDetail)}`,
      lastRetryable,
    );
  }

  /**
   * Per-attempt checks against a freshly resolved scope and policy. Returns
   * either the fully resolved attempt inputs or the denial to throw. Nothing
   * about a previous attempt is reused: a retry, fallback, or model switch
   * re-resolves the authenticated scope, policy, endpoint, and credential
   * from scratch — and re-runs the complete request scan gate over the full
   * request, so no path around the checks.
   */
  private async prepare(
    slot: DestinationSlot,
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
    binding: GatewayBindingIdentity,
    attempt: number,
    context: Context,
  ): Promise<
    | ModelEgressDeniedError
    | {
        identity: GatewayRequestIdentity;
        attempt: number;
        endpoint: ApprovedEndpoint;
        modelId: string;
        policyRevision: string;
        credential: string;
        pinnedModel: Model<Api>;
        adapterOptions: SimpleStreamOptions;
        /** The scanned (possibly minimized) request the adapter may dispatch. */
        context: Context;
        /** Budget reservation admitted for this attempt, when budgets are enforced. */
        budgetReservation: { reservationId: string } | null;
      }
  > {
    const scope = this.resolveScope(binding, attempt);
    if (scope instanceof ModelEgressDeniedError) {
      return scope;
    }
    const identity = this.mintIdentity(binding, scope);
    const policy = await this.deps.policyResolver.resolve(scope);
    if (!policy) {
      return this.deny(
        identity,
        attempt,
        "POLICY_UNAVAILABLE",
        "no model egress policy for this scope",
      );
    }
    const match = slot.fallback
      ? matchFallback(policy, slot.fallback)
      : matchEndpoint(policy, model);
    if ("deny" in match) {
      return this.deny(
        identity,
        attempt,
        match.deny,
        `destination ${slot.endpointId}/${slot.modelId} is not approved`,
        { policyRevision: policy.revision },
      );
    }
    const endpoint = match.endpoint;
    if (endpoint.endpointId !== slot.endpointId) {
      return this.deny(
        identity,
        attempt,
        "ENDPOINT_NOT_APPROVED",
        "the policy no longer approves the planned destination",
        { policyRevision: policy.revision },
      );
    }
    const destination = this.destinationOf(endpoint, slot.modelId);
    if (options?.apiKey) {
      return this.deny(
        identity,
        attempt,
        "CALLER_CREDENTIAL_SUPPLIED",
        "the caller must not supply provider credentials",
        { policyRevision: policy.revision, destination },
      );
    }
    const credential = this.deps.credentials.get(endpoint.credentialRef);
    if (!credential) {
      return this.deny(
        identity,
        attempt,
        "CREDENTIAL_MISSING",
        `no credential for ${endpoint.credentialRef}`,
        { policyRevision: policy.revision, destination },
      );
    }
    // Required audit sink: without it there is nowhere to persist the
    // pre-dispatch evidence (scan result included), so nothing may be sent.
    if (!this.deps.sink) {
      return this.deny(
        identity,
        attempt,
        "AUDIT_UNAVAILABLE",
        "no required audit sink is configured",
        { policyRevision: policy.revision, destination },
      );
    }
    // Complete-request scan gate (DAT-209): every string of the request —
    // system prompt, tools, user input, history, code, logs, diffs, tool
    // results, derived summaries — is scanned before any byte is sent. A
    // suspected secret whose removal cannot be confirmed, an unknown
    // classification, or an unavailable scanner blocks with zero bytes.
    const gate = await runRequestScanGate(context, {
      ...(this.deps.scanner ? { scanner: this.deps.scanner } : {}),
      ...(this.deps.scanPolicy ? { scanPolicy: this.deps.scanPolicy } : {}),
      ...(this.deps.scanTimeoutMs !== undefined ? { scanTimeoutMs: this.deps.scanTimeoutMs } : {}),
      // Scope-specific scanner policy (reviewed rule corrections) applies
      // only to the scope this request was resolved for (DAT-211).
      scope: { enterpriseId: identity.enterpriseId, workspaceId: identity.workspaceId },
    });
    if (!gate.ok) {
      // Every scan-gate denial blocks on uncertain sensitive content (or the
      // inability to establish its absence) and needs human handling: open or
      // idempotently associate the disposal case (DAT-210). The denial stands
      // no matter what the intake does with it.
      const caseRef = await this.openDisposalCase(identity, gate);
      return this.deny(
        identity,
        attempt,
        gate.reason,
        gate.detail,
        { policyRevision: policy.revision, destination },
        gate.evidence,
        scanDenyErrorCode(gate.reason),
        caseRef,
      );
    }
    // Destination data-class authorization: a destination is enabled together
    // with its permitted data classes; missing authorization fails closed.
    const authorization = authorizeRequestDataClasses(gate.evidence.dataClasses, endpoint);
    if (!authorization.ok) {
      return this.deny(
        identity,
        attempt,
        authorization.reason,
        authorization.detail,
        { policyRevision: policy.revision, destination },
        gate.evidence,
      );
    }
    const pre: GatewayAttemptEvent = {
      phase: "pre_dispatch",
      identity,
      attempt,
      policyRevision: policy.revision,
      destination,
      scan: gate.evidence,
      timestamp: this.timestamp(),
    };
    try {
      await this.deps.sink.record(pre);
    } catch {
      return this.deny(
        identity,
        attempt,
        "AUDIT_UNAVAILABLE",
        "required pre-dispatch audit evidence could not be recorded",
        { policyRevision: policy.revision, destination },
        gate.evidence,
      );
    }
    // Budget admission is the last gate before bytes leave the gateway. It
    // runs after the required pre-dispatch evidence is durable, reserves a
    // conservative bound, and denies (never shrinks) when no finite safe
    // reservation exists or a scope is exhausted.
    let budgetReservation: { reservationId: string } | null = null;
    if (this.deps.budget) {
      const decision = await this.deps.budget.reserve({
        enterprise_id: identity.enterpriseId,
        workspace_id: identity.workspaceId,
        issue_id: identity.issueId,
        run_id: identity.runId,
        invocation_id: identity.invocationId,
        trace_id: identity.traceId,
        attempt,
        endpoint_id: endpoint.endpointId,
        provider: endpoint.provider,
        model_id: slot.modelId,
        token_bound: tokenBoundOf(model, options),
      });
      if (decision.status === "denied") {
        const mapped = mapBudgetDenial(decision.reason);
        return this.deny(
          identity,
          attempt,
          mapped.reason,
          decision.detail,
          { policyRevision: policy.revision, destination },
          gate.evidence,
          mapped.code,
        );
      }
      budgetReservation = { reservationId: decision.reservation_id };
    }
    return {
      identity,
      attempt,
      endpoint,
      modelId: slot.modelId,
      policyRevision: policy.revision,
      credential,
      context: gate.context,
      pinnedModel: {
        ...model,
        id: slot.modelId,
        name: slot.modelId,
        provider: endpoint.provider,
        api: endpoint.api,
        baseUrl: endpoint.baseUrl,
      },
      // Sanitized here as well as in the pi-ai adapter: no adapter ever sees
      // caller-supplied payload hooks, headers, or retry knobs.
      adapterOptions: buildAdapterOptions(options, credential),
      budgetReservation,
    };
  }

  /** Dispatch one checked attempt and classify its outcome. */
  private async runAttempt(prepared: {
    identity: GatewayRequestIdentity;
    attempt: number;
    endpoint: ApprovedEndpoint;
    modelId: string;
    policyRevision: string;
    credential: string;
    pinnedModel: Model<Api>;
    adapterOptions: SimpleStreamOptions;
    context: Context;
    budgetReservation: { reservationId: string } | null;
  }): Promise<AttemptResult> {
    const { identity, attempt, endpoint, modelId, policyRevision, credential } = prepared;
    const startedAt = this.timestamp();
    // Closing an attempt means its audit outcome, its usage record and its
    // budget settlement are written; record() settles only when all have.
    const record = async (close: AttemptClose): Promise<void> => {
      await this.recordOutcome(identity, attempt, policyRevision, endpoint, modelId, close.outcome);
      await this.recordUsage(prepared, startedAt, close);
      await this.closeBudget(prepared.budgetReservation, close.outcome);
    };
    };
    try {
      const inner = await this.deps.adapter.stream(
        prepared.pinnedModel,
        prepared.context,
        prepared.adapterOptions,
      );
      const head = await this.consumeHead(inner, prepared.pinnedModel, record);
      if (head.status === "failed") {
        // The transport already gave this attempt its verdict: a ledger write
        // failure must not rewrite its retryability (it surfaces as an
        // incident), so the failure close is best-effort here.
        await record({
          outcome: {
            outcome: "failed",
            detail: scrubSecrets(head.detail, [credential]),
            // The provider answered with an explicit failure: the outcome is
            // known, even though no usage was reported for it.
            providerOutcome: "known",
          },
          finish: head.finish,
          ...(head.terminal ? { terminal: head.terminal } : {}),
        }).catch(() => undefined);
        return head;
      }
      return head;
    } catch (error) {
      if (error instanceof UsageLedgerWriteError) {
        // The attempt ran and its outcome is audited, but its usage record
        // could not be persisted: fail closed instead of reporting a success
        // whose metering is missing — and never re-dispatch over an
        // accounting failure.
        return {
          status: "failed",
          detail: "usage ledger write failed",
          retryable: false,
          finish: "unknown",
        };
      }
      const detail = error instanceof Error ? error.message : String(error);
      let retryable = isNetworkFailure(error);
      if (typeof error === "object" && error !== null && "retryable" in error) {
        const flagged = error.retryable;
        if (typeof flagged === "boolean") retryable = flagged;
      }
      // Only a failure that proves nothing was sent refunds the reservation;
      // anything else may have been served and is retained for reconciliation.
      const providerOutcome: ProviderOutcome = isCertainlyUnsent(error)
        ? "not_dispatched"
        : "unknown";
      // The transport failed before any provider message existed: no usage
      // was reported, so the ledger records this attempt as unknown usage.
      await record({
        outcome: {
          outcome: "failed",
          detail: scrubSecrets(detail, [credential]),
          providerOutcome,
        },
        finish: "transport_failed",
      }).catch(() => undefined);
      return {
        status: "failed",
        detail: scrubSecrets(detail, [credential]),
        retryable,
        finish: "transport_failed",
        providerOutcome,
      };
    }
  }

  /**
   * Buffer the head of a provider stream until content starts or the stream
   * terminates, then hand the stream to the caller immediately. A transport
   * failure before any content is retryable per policy; once content is
   * flowing the attempt's stream is forwarded incrementally and never
   * replayed. The attempt's outcome is recorded from the terminal event (a
   * stream that ends in an error is a failed invocation, not a dispatch).
   */
  private async consumeHead(
    inner: AssistantMessageEventStream,
    model: Model<Api>,
    record: (close: AttemptClose) => Promise<void>,
  ): Promise<AttemptResult> {
    const out = createAssistantMessageEventStream();
    const iterator = inner[Symbol.asyncIterator]();
    const buffered: AssistantMessageEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        for (const event of buffered) out.push(event);
        // The stream ended without a terminal signal: no provider outcome and
        // no usage were read, so this is unknown rather than a free success.
        await record({
          outcome: { outcome: "dispatched", providerOutcome: "unknown" },
          finish: "unknown",
        });
        out.end();
        return { status: "handed_off", stream: out };
      }
      const event = next.value;
      if (isTerminalEvent(event)) {
        if (event.type === "error" && event.reason === "error") {
          return {
            status: "failed",
            detail: event.error.errorMessage ?? "provider stream failed",
            retryable: !NON_RETRYABLE_MARKERS.test(event.error.errorMessage ?? ""),
            finish: finishFromEvent(event),
            terminal: event.error,
          };
        }
        for (const bufferedEvent of buffered) out.push(bufferedEvent);
        await record({
          outcome: outcomeFromTerminal(event),
          finish: finishFromEvent(event),
          ...(messageOf(event) ? { terminal: messageOf(event) } : {}),
        });
        out.push(event);
        out.end();
        return { status: "handed_off", stream: out };
      }
      buffered.push(event);
      if (!CONTENT_EVENTS.has(event.type)) {
        continue;
      }
      // Content is flowing: flush the buffered head and hand the stream over
      // now. The rest streams through in the background; the outcome is
      // recorded when the terminal event arrives.
      for (const bufferedEvent of buffered) out.push(bufferedEvent);
      this.forwardRest(iterator, out, model, record);
      return { status: "handed_off", stream: out };
    }
  }

  /**
   * Forward the remainder of a handed-off stream, recording the terminal
   * outcome before the terminal event reaches the caller. A mid-stream
   * transport failure after handoff is never replayed: it is recorded as a
   * failed attempt and forwarded as an error event.
   */
  private forwardRest(
    iterator: AsyncIterator<AssistantMessageEvent>,
    out: AssistantMessageEventStream,
    model: Model<Api>,
    record: (close: AttemptClose) => Promise<void>,
  ): void {
    void (async () => {
      // Post-handoff the content is already with the caller and cannot be
      // retracted: a ledger write failure (already raised as an incident by
      // recordUsage) never corrupts the delivered stream, so the closes here
      // are best-effort.
      const close = (attemptClose: AttemptClose): Promise<void> =>
        record(attemptClose).catch(() => undefined);
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            await close({
              outcome: { outcome: "dispatched", providerOutcome: "unknown" },
              finish: "unknown",
            });
            out.end();
            return;
          }
          if (isTerminalEvent(next.value)) {
            await close({
              outcome: outcomeFromTerminal(next.value),
              finish: finishFromEvent(next.value),
              ...(messageOf(next.value) ? { terminal: messageOf(next.value) } : {}),
            });
            out.push(next.value);
            out.end();
            return;
          }
          out.push(next.value);
        }
      } catch (error) {
        const detail = scrubSecrets(error instanceof Error ? error.message : String(error));
        // A mid-stream transport failure never produced a provider terminal
        // message: record the attempt without usage instead of trusting the
        // synthetic zero-filled stand-in below.
        await close({
          outcome: { outcome: "failed", detail, providerOutcome: "unknown" },
          finish: "transport_failed",
        });
        out.push({ type: "error", reason: "error", error: syntheticErrorMessage(model, detail) });
        out.end();
      }
    })();
  }

  /**
   * Close the attempt's budget reservation against what was observed.
   *
   * - A provably unsent attempt is refunded in full.
   * - An unknown provider outcome retains the conservative reservation; the
   *   dispatch already stopped so it cannot be duplicated.
   * - A known outcome settles observed usage; missing usage stays `unknown`
   *   (the bound remains committed) instead of becoming zero.
   *
   * A settlement failure is an operational incident, never a stream failure:
   * the reservation simply keeps its bound, which cannot overspend.
   */
  private async closeBudget(
    reservation: { reservationId: string } | null,
    outcome: TerminalOutcome,
  ): Promise<void> {
    if (this.deps.budget === undefined || reservation === null) {
      return;
    }
    try {
      const providerOutcome = outcome.providerOutcome ?? "known";
      if (providerOutcome === "not_dispatched") {
        await this.deps.budget.release(
          reservation.reservationId,
          "the dispatch never left the gateway",
        );
        return;
      }
      if (providerOutcome === "unknown") {
        await this.deps.budget.requireReconciliation(
          reservation.reservationId,
          outcome.detail ?? "provider outcome unknown",
        );
        return;
      }
      await this.deps.budget.settleUsage(
        reservation.reservationId,
        outcome.usage ?? { tokens: null, completeness: "unknown" },
      );
    } catch (error) {
      this.incident(
        `gateway budget settlement failed: ${scrubSecrets(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }

  /** Record the per-attempt outcome; a failure raises an incident, never a replay. */
  private async recordOutcome(
    identity: GatewayRequestIdentity,
    attempt: number,
    policyRevision: string,
    endpoint: ApprovedEndpoint,
    modelId: string,
    outcome: { outcome: "dispatched" | "failed" | "denied"; detail?: string },
  ): Promise<void> {
    const event: GatewayAttemptEvent = {
      phase: "outcome",
      identity,
      attempt,
      policyRevision,
      destination: this.destinationOf(endpoint, modelId),
      ...outcome,
      timestamp: this.timestamp(),
    };
    try {
      await this.deps.sink?.record(event);
    } catch (error) {
      const incident = error instanceof Error ? error.message : String(error);
      this.incident(`gateway outcome audit write failed: ${scrubSecrets(incident)}`);
    }
  }

  /**
   * Write this attempt's invocation usage record and wait for it to settle.
   * The ledger is financial evidence: identity, timing, finish status and the
   * usage the provider reported — preserved verbatim for reconciliation, with
   * missing usage recorded as unknown, never as zeros.
   *
   * The write is awaited: a failure raises the operational incident and
   * rejects with `UsageLedgerWriteError`, so no caller treats an unrecorded
   * attempt as recorded. It never replays or drops the attempt's audit
   * outcome, and it is never retried in a way that re-dispatches the model.
   */
  private async recordUsage(
    prepared: {
      identity: GatewayRequestIdentity;
      attempt: number;
      endpoint: ApprovedEndpoint;
      modelId: string;
    },
    startedAt: string,
    close: AttemptClose,
  ): Promise<void> {
    const sink = this.deps.usageLedger;
    if (!sink) {
      return;
    }
    const { identity, attempt, endpoint, modelId } = prepared;
    const terminal = close.terminal;
    try {
      await sink.recordAttempt({
        identity: {
          enterprise_id: identity.enterpriseId,
          workspace_id: identity.workspaceId,
          issue_id: identity.issueId,
          run_id: identity.runId,
          invocation_id: identity.invocationId,
          trace_id: identity.traceId,
        },
        attempt,
        destination: {
          endpoint_id: endpoint.endpointId,
          provider: endpoint.provider,
          model_id: modelId,
          internal: endpoint.internal,
        },
        api: endpoint.api,
        started_at: startedAt,
        ended_at: this.timestamp(),
        finish_status: close.finish,
        provider_request_id: terminal?.responseId ?? null,
        returned_model: terminal?.responseModel ?? null,
        usage_report: terminal ? usageReportOf(terminal) : null,
      });
    } catch (error) {
      const incident = error instanceof Error ? error.message : String(error);
      this.incident(`gateway usage ledger write failed: ${scrubSecrets(incident)}`);
      throw new UsageLedgerWriteError(`usage ledger write failed: ${scrubSecrets(incident)}`);
    }
  }

  /**
   * Resolve the binding's authoritative scope (DAT-241) for one attempt.
   * Every failure — missing, revoked, ambiguous, or cross-tenant membership;
   * a claim that disagrees with the authenticated scope — is a denial:
   * `MODEL_EGRESS_DENIED` with a scope deny reason, never a default scope and
   * never a fallback to the binding's claim. The denial's identity carries
   * the authenticated scope whenever one resolved (the claim is only recorded
   * when no authenticated scope exists at all).
   */
  private resolveScope(
    binding: GatewayBindingIdentity,
    attempt: number,
  ): GatewayScope | ModelEgressDeniedError {
    let resolved: GatewayScope;
    try {
      resolved = binding.scopeAuthority.resolve();
    } catch (error) {
      return this.deny(
        this.mintIdentity(binding, {
          enterpriseId: binding.enterpriseId,
          workspaceId: binding.workspaceId,
        }),
        attempt,
        "SCOPE_UNAVAILABLE",
        `no authenticated scope for this binding: ${scrubSecrets(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    if (
      resolved.enterpriseId !== binding.enterpriseId ||
      resolved.workspaceId !== binding.workspaceId
    ) {
      return this.deny(
        this.mintIdentity(binding, resolved),
        attempt,
        "SCOPE_CROSS_TENANT",
        `binding claims ${binding.enterpriseId}/${binding.workspaceId} but the authenticated scope is ${resolved.enterpriseId}/${resolved.workspaceId}`,
      );
    }
    return resolved;
  }

  /**
   * One attempt's identity: the run's issue/run/trace ids and the
   * authenticated enterprise/workspace scope recorded for audit and metering
   * attribution. The binding's scope claim and its authority are never
   * carried into events.
   */
  private mintIdentity(
    binding: GatewayBindingIdentity,
    scope: GatewayScope,
  ): GatewayRequestIdentity {
    return {
      enterpriseId: scope.enterpriseId,
      workspaceId: scope.workspaceId,
      issueId: binding.issueId,
      runId: binding.runId,
      traceId: binding.traceId,
      invocationId: this.deps.newInvocationId ? this.deps.newInvocationId() : randomUUID(),
    };
  }

  /**
   * Open the scoped disposal case for one secret-gate block (DAT-210). The
   * raw blocked request goes to the intake for encrypted quarantine; the
   * returned case reference is audience-bound to the blocked run. Intake
   * failures raise an incident and return nothing — they never unblock.
   */
  private async openDisposalCase(
    identity: GatewayRequestIdentity,
    gate: { reason: GatewayDenyReason; detail: string; context?: Context },
  ): Promise<{ caseId: string; caseReference: string } | undefined> {
    const intake = this.deps.caseIntake;
    if (!intake) {
      // Typed construction always configures the intake; an untyped caller
      // that omits it still gets the full block — plus a loud incident, never
      // a silent skip of human handling (DAT-210).
      this.incident("security case intake is not configured; the block stands without a case");
      return undefined;
    }
    let rawContent: string | undefined;
    if (gate.context !== undefined) {
      try {
        rawContent = JSON.stringify(gate.context);
      } catch {
        rawContent = undefined;
      }
    }
    try {
      return await intake.recordGatewayBlock({
        identity,
        reason: gate.reason,
        safeDetail: gate.detail,
        ...(rawContent !== undefined ? { rawContent } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.incident(`security case intake failed after block: ${scrubSecrets(detail)}`);
      return undefined;
    }
  }

  private deny(
    identity: GatewayRequestIdentity,
    attempt: number,
    reason: GatewayDenyReason,
    detail: string,
    resolved?: { policyRevision: string; destination?: GatewayAttemptDestination },
    scan?: RequestScanEvidence,
    code: string = MODEL_EGRESS_DENIED,
    caseRef?: { caseId: string; caseReference: string },
  ): ModelEgressDeniedError {
    const event: GatewayAttemptEvent = {
      phase: "outcome",
      identity,
      attempt,
      policyRevision: resolved?.policyRevision ?? null,
      destination: resolved?.destination ?? null,
      outcome: "denied",
      denyReason: reason,
      ...(scan ? { scan } : {}),
      detail: scrubSecrets(detail),
      timestamp: this.timestamp(),
    };
    // Denial evidence is best-effort: when the sink is the failure, recording
    // the denial would fail again and the denial itself must still stand.
    void Promise.resolve(this.deps.sink?.record(event)).catch(() => undefined);
    return new ModelEgressDeniedError(
      reason,
      `model egress denied (${reason}): ${scrubSecrets(detail)}`,
      code,
      caseRef,
    );
  }

  private destinationOf(endpoint: ApprovedEndpoint, modelId: string): GatewayAttemptDestination {
    return {
      endpointId: endpoint.endpointId,
      provider: endpoint.provider,
      modelId,
      internal: endpoint.internal,
    };
  }

  private timestamp(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString();
  }

  private incident(message: string): void {
    if (this.deps.onIncident) {
      this.deps.onIncident(message);
      return;
    }
    console.error(message);
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
      code,
    )
  );
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  return new ModelGateway(deps);
}
