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

import type { ProviderAdapter } from "./adapter.js";
import { buildAdapterOptions } from "./adapter.js";
import type { GatewayCredentialStore } from "./credentials.js";
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
  RequestScanEvidence,
} from "./types.js";
import {
  ModelDispatchError,
  ModelEgressDeniedError,
  MODEL_EGRESS_DENIED,
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

type TerminalOutcome = { outcome: "dispatched" | "failed"; detail?: string };

type AttemptResult =
  | { status: "handed_off"; stream: AssistantMessageEventStream }
  | { status: "failed"; detail: string; retryable: boolean };

const CONTENT_EVENTS = new Set<AssistantMessageEvent["type"]>([
  "text_start",
  "thinking_start",
  "toolcall_start",
]);

/** Client-side errors a retry cannot fix; everything else transport-shaped retries. */
const NON_RETRYABLE_MARKERS =
  /\b(?:HTTP|status)\s*[:=]?\s*(?:400|401|403|404|422)\b|content_filter|invalid api key/i;

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
    return {
      outcome: "failed",
      detail:
        event.error.errorMessage ??
        (event.reason === "aborted" ? "aborted" : "provider stream failed"),
    };
  }
  return { outcome: "dispatched" };
}

/** Terminal error message for a mid-stream transport failure after handoff. */
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
        this.mintIdentity(binding),
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
        this.mintIdentity(binding),
        1,
        "DEPENDENT_WORK_HELD",
        "the run's dependent work is held pending security case disposition",
        undefined,
        undefined,
        SECURITY_REVIEW_REQUIRED,
        hold,
      );
    }
    const scope = { enterpriseId: binding.enterpriseId, workspaceId: binding.workspaceId };
    const schedulePolicy = await this.deps.policyResolver.resolve(scope);
    if (!schedulePolicy) {
      throw this.deny(
        this.mintIdentity(binding),
        1,
        "POLICY_UNAVAILABLE",
        "no model egress policy for this scope",
      );
    }
    const primary = matchEndpoint(schedulePolicy, model);
    if ("deny" in primary) {
      throw this.deny(
        this.mintIdentity(binding),
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
        const identity = this.mintIdentity(binding);
        const prepared = await this.prepare(slot, model, options, identity, attempt, context);
        if (prepared instanceof ModelEgressDeniedError) {
          throw prepared;
        }
        const result = await this.runAttempt(prepared);
        if (result.status === "handed_off") {
          return result.stream;
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
   * Per-attempt checks against a freshly resolved policy. Returns either the
   * fully resolved attempt inputs or the denial to throw. Nothing about a
   * previous attempt is reused: a retry, fallback, or model switch re-resolves
   * policy, endpoint, and credential from scratch — and re-runs the complete
   * request scan gate over the full request, so no path around the checks.
   */
  private async prepare(
    slot: DestinationSlot,
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
    identity: GatewayRequestIdentity,
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
      }
  > {
    const scope = { enterpriseId: identity.enterpriseId, workspaceId: identity.workspaceId };
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
  }): Promise<AttemptResult> {
    const { identity, attempt, endpoint, modelId, policyRevision, credential } = prepared;
    const record = (outcome: TerminalOutcome): Promise<void> =>
      this.recordOutcome(identity, attempt, policyRevision, endpoint, modelId, outcome);
    try {
      const inner = await this.deps.adapter.stream(
        prepared.pinnedModel,
        prepared.context,
        prepared.adapterOptions,
      );
      const head = await this.consumeHead(inner, prepared.pinnedModel, record);
      if (head.status === "failed") {
        await record({
          outcome: "failed",
          detail: scrubSecrets(head.detail, [credential]),
        });
        return head;
      }
      return head;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let retryable = isNetworkFailure(error);
      if (typeof error === "object" && error !== null && "retryable" in error) {
        const flagged = error.retryable;
        if (typeof flagged === "boolean") retryable = flagged;
      }
      await record({ outcome: "failed", detail: scrubSecrets(detail, [credential]) });
      return { status: "failed", detail: scrubSecrets(detail, [credential]), retryable };
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
    record: (outcome: TerminalOutcome) => Promise<void>,
  ): Promise<AttemptResult> {
    const out = createAssistantMessageEventStream();
    const iterator = inner[Symbol.asyncIterator]();
    const buffered: AssistantMessageEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        for (const event of buffered) out.push(event);
        await record({ outcome: "dispatched" });
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
          };
        }
        for (const bufferedEvent of buffered) out.push(bufferedEvent);
        await record(outcomeFromTerminal(event));
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
    record: (outcome: TerminalOutcome) => Promise<void>,
  ): void {
    void (async () => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            await record({ outcome: "dispatched" });
            out.end();
            return;
          }
          if (isTerminalEvent(next.value)) {
            await record(outcomeFromTerminal(next.value));
            out.push(next.value);
            out.end();
            return;
          }
          out.push(next.value);
        }
      } catch (error) {
        const detail = scrubSecrets(error instanceof Error ? error.message : String(error));
        await record({ outcome: "failed", detail });
        out.push({ type: "error", reason: "error", error: syntheticErrorMessage(model, detail) });
        out.end();
      }
    })();
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

  private mintIdentity(binding: GatewayBindingIdentity): GatewayRequestIdentity {
    return {
      ...binding,
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
