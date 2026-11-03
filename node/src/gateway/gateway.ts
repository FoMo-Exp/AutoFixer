import { randomUUID } from "node:crypto";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  Api,
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
import type {
  ApprovedEndpoint,
  GatewayAttemptDestination,
  GatewayAttemptEvent,
  GatewayBindingIdentity,
  GatewayEventSink,
  GatewayFallback,
  GatewayRequestIdentity,
} from "./types.js";
import { ModelDispatchError, ModelEgressDeniedError } from "./types.js";
import type { GatewayDenyReason } from "./types.js";

export interface ModelGatewayDeps {
  policyResolver: GatewayPolicyResolver;
  credentials: GatewayCredentialStore;
  adapter: ProviderAdapter;
  /** Audit/metering sink; every attempt is recorded through it. */
  sink?: GatewayEventSink;
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

type AttemptResult =
  | { status: "dispatched"; stream: AssistantMessageEventStream }
  | { status: "failed"; detail: string; retryable: boolean };

const CONTENT_EVENTS = new Set<AssistantMessageEvent["type"]>([
  "text_start",
  "thinking_start",
  "toolcall_start",
]);

/** Client-side errors a retry cannot fix; everything else transport-shaped retries. */
const NON_RETRYABLE_MARKERS = /\b(?:400|401|403|404|422)\b|content_filter|invalid api key/i;

function isTerminalEvent(event: AssistantMessageEvent): boolean {
  return event.type === "done" || event.type === "error";
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
    for (const slot of slots) {
      for (let round = 0; round < schedulePolicy.retry.maxAttempts; round += 1) {
        attempt += 1;
        const identity = this.mintIdentity(binding);
        const prepared = await this.prepare(slot, model, options, identity, attempt);
        if (prepared instanceof ModelEgressDeniedError) {
          throw prepared;
        }
        const result = await this.runAttempt(prepared, context);
        if (result.status === "dispatched") {
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
   * policy, endpoint, and credential from scratch.
   */
  private async prepare(
    slot: DestinationSlot,
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
    identity: GatewayRequestIdentity,
    attempt: number,
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
      );
    }
    const endpoint = match.endpoint;
    if (endpoint.endpointId !== slot.endpointId) {
      return this.deny(
        identity,
        attempt,
        "ENDPOINT_NOT_APPROVED",
        "the policy no longer approves the planned destination",
      );
    }
    if (options?.apiKey) {
      return this.deny(
        identity,
        attempt,
        "CALLER_CREDENTIAL_SUPPLIED",
        "the caller must not supply provider credentials",
      );
    }
    const credential = this.deps.credentials.get(endpoint.credentialRef);
    if (!credential) {
      return this.deny(
        identity,
        attempt,
        "CREDENTIAL_MISSING",
        `no credential for ${endpoint.credentialRef}`,
      );
    }
    const destination = this.destinationOf(endpoint, slot.modelId);
    const pre: GatewayAttemptEvent = {
      phase: "pre_dispatch",
      identity,
      attempt,
      policyRevision: policy.revision,
      destination,
      timestamp: this.timestamp(),
    };
    try {
      await this.deps.sink?.record(pre);
    } catch {
      return this.deny(
        identity,
        attempt,
        "AUDIT_UNAVAILABLE",
        "required pre-dispatch audit evidence could not be recorded",
      );
    }
    return {
      identity,
      attempt,
      endpoint,
      modelId: slot.modelId,
      policyRevision: policy.revision,
      credential,
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
  private async runAttempt(
    prepared: {
      identity: GatewayRequestIdentity;
      attempt: number;
      endpoint: ApprovedEndpoint;
      modelId: string;
      policyRevision: string;
      credential: string;
      pinnedModel: Model<Api>;
      adapterOptions: SimpleStreamOptions;
    },
    context: Context,
  ): Promise<AttemptResult> {
    const { identity, attempt, endpoint, modelId, policyRevision, credential } = prepared;
    try {
      const inner = await this.deps.adapter.stream(
        prepared.pinnedModel,
        context,
        prepared.adapterOptions,
      );
      const head = await this.consumeHead(inner);
      if (head.status === "failed") {
        await this.recordOutcome(identity, attempt, policyRevision, endpoint, modelId, {
          outcome: "failed",
          detail: scrubSecrets(head.detail, [credential]),
        });
        return head;
      }
      await this.recordOutcome(identity, attempt, policyRevision, endpoint, modelId, {
        outcome: "dispatched",
      });
      return head;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      let retryable = isNetworkFailure(error);
      if (typeof error === "object" && error !== null && "retryable" in error) {
        const flagged = error.retryable;
        if (typeof flagged === "boolean") retryable = flagged;
      }
      await this.recordOutcome(identity, attempt, policyRevision, endpoint, modelId, {
        outcome: "failed",
        detail: scrubSecrets(detail, [credential]),
      });
      return { status: "failed", detail: scrubSecrets(detail, [credential]), retryable };
    }
  }

  /**
   * Buffer the head of a provider stream until content starts or the stream
   * terminates. A transport failure before any content is retryable per
   * policy; once content is flowing the attempt's stream is forwarded as-is
   * and never replayed.
   */
  private async consumeHead(inner: AssistantMessageEventStream): Promise<AttemptResult> {
    const out = createAssistantMessageEventStream();
    const iterator = inner[Symbol.asyncIterator]();
    const buffered: AssistantMessageEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        for (const event of buffered) out.push(event);
        out.end();
        return { status: "dispatched", stream: out };
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
        out.push(event);
        out.end();
        return { status: "dispatched", stream: out };
      }
      buffered.push(event);
      if (!CONTENT_EVENTS.has(event.type)) {
        continue;
      }
      for (const bufferedEvent of buffered) out.push(bufferedEvent);
      for (;;) {
        const rest = await iterator.next();
        if (rest.done) break;
        out.push(rest.value);
        if (isTerminalEvent(rest.value)) break;
      }
      out.end();
      return { status: "dispatched", stream: out };
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

  private mintIdentity(binding: GatewayBindingIdentity): GatewayRequestIdentity {
    return {
      ...binding,
      invocationId: this.deps.newInvocationId ? this.deps.newInvocationId() : randomUUID(),
    };
  }

  private deny(
    identity: GatewayRequestIdentity,
    attempt: number,
    reason: GatewayDenyReason,
    detail: string,
  ): ModelEgressDeniedError {
    const event: GatewayAttemptEvent = {
      phase: "outcome",
      identity,
      attempt,
      policyRevision: null,
      destination: null,
      outcome: "denied",
      denyReason: reason,
      detail: scrubSecrets(detail),
      timestamp: this.timestamp(),
    };
    // Denial evidence is best-effort: when the sink is the failure, recording
    // the denial would fail again and the denial itself must still stand.
    void Promise.resolve(this.deps.sink?.record(event)).catch(() => undefined);
    return new ModelEgressDeniedError(
      reason,
      `model egress denied (${reason}): ${scrubSecrets(detail)}`,
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
