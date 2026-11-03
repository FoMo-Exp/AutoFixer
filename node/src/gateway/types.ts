import type { Api } from "@mariozechner/pi-ai";

/**
 * Enterprise/workspace scope a gateway policy is resolved for.
 *
 * This is the ADR-0006 seam: the gateway asks a {@link GatewayPolicyResolver}
 * for the policy that governs one authenticated scope and never trusts a
 * caller-supplied scope as authority by itself.
 */
export interface GatewayScope {
  enterpriseId: string;
  workspaceId: string;
}

/**
 * Identity carried by every gateway request, for audit and metering reuse.
 * The gateway mints one `invocationId` per dispatch attempt; the calling run
 * supplies the rest when it binds to the gateway.
 */
export interface GatewayRequestIdentity extends GatewayScope {
  issueId: string;
  runId: string;
  invocationId: string;
  traceId: string;
}

/** Identity of the calling run; the gateway mints invocation ids per attempt. */
export type GatewayBindingIdentity = Omit<GatewayRequestIdentity, "invocationId">;

/**
 * One explicitly registered model endpoint. Registration is the only evidence
 * of trust: a private-looking hostname alone never approves an endpoint, and
 * internal endpoints are blocked unless they appear here with `internal: true`.
 */
export interface ApprovedEndpoint {
  endpointId: string;
  /** Provider key the approved instance speaks (pi-ai provider identity). */
  provider: string;
  /** Provider protocol adapter (pi-ai api identity, e.g. "anthropic-messages"). */
  api: Api;
  /** Pinned endpoint origin; the SDK default endpoint is never used. */
  baseUrl: string;
  /** Explicitly registered internal instance; never inferred from the hostname. */
  internal: boolean;
  /** Reference into the gateway credential store; never a literal secret. */
  credentialRef: string;
  /** Model ids approved at this endpoint. Wildcards are not accepted. */
  models: string[];
}

/** A policy-declared fallback destination; checked exactly like the primary. */
export interface GatewayFallback {
  endpointId: string;
  modelId: string;
}

export interface GatewayPolicy {
  /** Opaque policy revision recorded on every attempt event. */
  revision: string;
  endpoints: ApprovedEndpoint[];
  retry: {
    /** Total dispatch attempts per destination, including the first. */
    maxAttempts: number;
  };
  /** Optional ordered fallback destinations, used only after retryable exhaustion. */
  fallbacks?: GatewayFallback[];
}

export type GatewayDenyReason =
  /** No policy resolved for the scope (missing or incomplete configuration). */
  | "POLICY_UNAVAILABLE"
  /** The requested model is not approved anywhere in the policy. */
  | "MODEL_NOT_APPROVED"
  /** An endpoint was requested that is not the registered one for the model. */
  | "ENDPOINT_NOT_APPROVED"
  /** The approved destination's credential is missing from the store. */
  | "CREDENTIAL_MISSING"
  /** The caller tried to supply its own credential through the stream options. */
  | "CALLER_CREDENTIAL_SUPPLIED"
  /** The required audit evidence could not be persisted. */
  | "AUDIT_UNAVAILABLE";

/** Stable redacted error contract (ADR-0005): all gateway denials share it. */
export const MODEL_EGRESS_DENIED = "MODEL_EGRESS_DENIED";

/** A policy or configuration denial. Never retried, never bypassable. */
export class ModelEgressDeniedError extends Error {
  readonly code = MODEL_EGRESS_DENIED;
  readonly retryable = false;
  readonly reason: GatewayDenyReason;

  constructor(reason: GatewayDenyReason, message: string) {
    super(message);
    this.name = "ModelEgressDeniedError";
    this.reason = reason;
  }
}

/** A dispatch failure after the gateway's checks passed. */
export class ModelDispatchError extends Error {
  readonly code = "MODEL_DISPATCH_FAILED";

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ModelDispatchError";
  }
}

/** Destination identity recorded on attempt events. */
export interface GatewayAttemptDestination {
  endpointId: string;
  provider: string;
  modelId: string;
  internal: boolean;
}

export type GatewayAttemptEvent =
  | {
      /**
       * Required pre-dispatch evidence. The gateway blocks the dispatch when
       * this record cannot be persisted (ADR-0005: audit-write failure blocks).
       */
      phase: "pre_dispatch";
      identity: GatewayRequestIdentity;
      /** 1-based attempt number within the dispatch call. */
      attempt: number;
      policyRevision: string;
      destination: GatewayAttemptDestination;
      timestamp: string;
    }
  | {
      phase: "outcome";
      identity: GatewayRequestIdentity;
      attempt: number;
      /** Null when the attempt was denied before a policy could be resolved. */
      policyRevision: string | null;
      /** Null when the attempt was denied before a destination was resolved. */
      destination: GatewayAttemptDestination | null;
      outcome: "dispatched" | "failed" | "denied";
      denyReason?: GatewayDenyReason;
      /** Redacted failure detail; never contains provider credentials. */
      detail?: string;
      timestamp: string;
    };

/**
 * Audit and metering seam. Every gateway attempt produces a `pre_dispatch`
 * record and an `outcome` record carrying the full request identity, so audit
 * and metering consumers can reuse one event stream.
 */
export interface GatewayEventSink {
  record(event: GatewayAttemptEvent): void | Promise<void>;
}
