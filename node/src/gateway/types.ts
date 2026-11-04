import type { Api } from "@mariozechner/pi-ai";

/**
 * Data classes a request segment may carry (DAT-209, ADR-0005 §1). Every text
 * leaf of a model request belongs to at least one class; a destination may
 * only receive classes an authorized administrator explicitly permitted.
 */
export type DataClass =
  | "system"
  | "user_input"
  | "history"
  | "code"
  | "logs"
  | "diffs"
  | "tool_results"
  | "derived_summaries";

export const DATA_CLASSES: readonly DataClass[] = [
  "system",
  "user_input",
  "history",
  "code",
  "logs",
  "diffs",
  "tool_results",
  "derived_summaries",
];

/**
 * Secret classification of request content (DAT-209). Unknown is the worst
 * classification: content the scanner cannot classify fails closed.
 */
export type SecretClassification = "clean" | "secret_suspected" | "secret_confirmed" | "unknown";

/**
 * Non-secret scan evidence recorded on the pre-dispatch audit record and on
 * detection denials. Detector identities, rule versions, counts, and classes
 * only — never matched material, never content hashes.
 */
export interface RequestScanEvidence {
  scanner: string;
  ruleVersion: string;
  classification: SecretClassification;
  /** Number of request text segments scanned — the complete request. */
  segments: number;
  dataClasses: DataClass[];
  findingCounts: { suspected: number; confirmed: number; unknown: number };
  /** Detector identities that fired, sorted; never their matched values. */
  detectors: string[];
  derivedSegments: number;
  classificationChanges: { policyId: string; policyVersion: string; segments: number }[];
  minimization?: {
    policyId: string;
    policyVersion: string;
    removedFindings: number;
    verified: boolean;
  };
}

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
 * Authority for one caller's authenticated enterprise/workspace scope
 * (DAT-241). The production implementation wraps `resolveRequestScope` over
 * the request's session-derived principal; the gateway calls it on every
 * dispatch and every attempt so revocation, suspension, and membership
 * changes take effect in the same request path with no cached verdict, no
 * default scope, and no per-call override.
 */
export interface GatewayScopeAuthority {
  /**
   * The caller's authenticated scope, re-resolved from live membership state
   * on every call. Throws when no scope can be resolved — missing or revoked
   * membership, a suspended account, an ambiguous or cross-tenant state — and
   * never returns an empty or default scope (fail closed).
   */
  resolve(): GatewayScope;
}

/**
 * The scope half of a run binding: the enterprise/workspace the run claims to
 * act in — sourced from the authenticated request at bind time, never from
 * deployment configuration — plus the authority that resolves the caller's
 * authenticated scope live. The claim is only ever compared against the
 * authority's resolution; a claim that disagrees is a cross-tenant binding
 * and is denied before any policy or credential is touched.
 */
export interface GatewayScopeBinding extends GatewayScope {
  scopeAuthority: GatewayScopeAuthority;
}

/**
 * Identity carried by every gateway request, for audit and metering reuse.
 * The gateway mints one `invocationId` per dispatch attempt; the calling run
 * supplies the rest when it binds to the gateway.
 *
 * The enterprise/workspace recorded on attempt events is always the
 * authenticated scope resolved from {@link GatewayScopeAuthority} — never the
 * binding's claim and never deployment configuration. Only a denial for which
 * no scope could be resolved at all records the binding's claimed values
 * (with `SCOPE_UNAVAILABLE`), because in that case no authenticated scope
 * exists to attribute the attempt to.
 */
export interface GatewayRequestIdentity extends GatewayScope {
  issueId: string;
  runId: string;
  invocationId: string;
  traceId: string;
}

/** Identity of the calling run; the gateway mints invocation ids per attempt. */
export interface GatewayBindingIdentity extends GatewayScopeBinding {
  issueId: string;
  runId: string;
  traceId: string;
}

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
  /**
   * Data classes explicitly permitted at this destination (DAT-209, ADR-0005
   * §1). Absent or empty means no class is authorized and every request is
   * denied — missing authorization fails closed, never open.
   */
  permittedDataClasses?: DataClass[];
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
  /** No authenticated scope could be resolved (missing, revoked, ambiguous, or not session-derived). */
  | "SCOPE_UNAVAILABLE"
  /** The binding's claimed scope is not the authenticated scope (cross-tenant). */
  | "SCOPE_CROSS_TENANT"
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
  /** The required audit evidence could not be persisted (or no sink exists). */
  | "AUDIT_UNAVAILABLE"
  /** The secret scanner failed, timed out, or returned an invalid report. */
  | "SCANNER_UNAVAILABLE"
  /** A suspected or confirmed secret remains and removal cannot be confirmed. */
  | "SENSITIVE_DATA_UNCERTAIN"
  /** The scanner returned an unknown classification; content fails closed. */
  | "CLASSIFICATION_UNKNOWN"
  /** A deterministic policy change was claimed without its authorization. */
  | "AUTHORIZATION_MISSING"
  /** The request carries a data class the destination is not authorized for. */
  | "DATA_CLASS_NOT_AUTHORIZED"
  /**
   * The run's dependent work is held pending security case disposition
   * (DAT-210): the hold is checked at the admission boundary and the run
   * cannot proceed until an authorized human releases it.
   */
  | "DEPENDENT_WORK_HELD";

/** Stable redacted error contract (ADR-0005): all gateway denials share it. */
export const MODEL_EGRESS_DENIED = "MODEL_EGRESS_DENIED";

/**
 * Stable redacted error contract (ADR-0005): the request-scan gate's denial
 * code when secret removal cannot be established by the configured checks.
 */
export const SENSITIVE_DATA_UNCERTAIN = "SENSITIVE_DATA_UNCERTAIN";

/**
 * Stable redacted error contract (ADR-0005): a security case is holding the
 * run's dependent work. Not a retryable failure and never a bypass: only the
 * case disposition releases the hold.
 */
export const SECURITY_REVIEW_REQUIRED = "SECURITY_REVIEW_REQUIRED";

/** A policy, scan, or configuration denial. Never retried, never bypassable. */
export class ModelEgressDeniedError extends Error {
  readonly code: string;
  readonly retryable = false;
  readonly reason: GatewayDenyReason;
  /**
   * Disposal-case correlation id opened for this block (DAT-210). An
   * identifier like the trace id — never authority and never a credential.
   */
  readonly caseId?: string;
  /**
   * Audience-bound case reference minted for the blocked run (DAT-210).
   * Non-transferable: it never verifies for another audience and never grants
   * quarantine access.
   */
  readonly caseReference?: string;

  constructor(
    reason: GatewayDenyReason,
    message: string,
    code: string = MODEL_EGRESS_DENIED,
    caseRef?: { caseId: string; caseReference: string },
  ) {
    super(message);
    this.name = "ModelEgressDeniedError";
    this.reason = reason;
    this.code = code;
    if (caseRef) {
      this.caseId = caseRef.caseId;
      this.caseReference = caseRef.caseReference;
    }
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
      /** Non-secret evidence of the complete-request scan that cleared this dispatch. */
      scan: RequestScanEvidence;
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
      /**
       * Derived from the terminal event: `dispatched` means the request went
       * out and the provider stream completed; `failed` means the attempt
       * failed — a dispatch error, or a stream that terminated in an error
       * (a caller abort is `failed` with detail "aborted"); `denied` is a
       * gateway refusal.
       */
      outcome: "dispatched" | "failed" | "denied";
      denyReason?: GatewayDenyReason;
      /** Non-secret scan evidence when the attempt was denied by the scan gate. */
      scan?: RequestScanEvidence;
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

/**
 * Post-block disposal-case seam (DAT-210, ADR-0005 §2), structurally
 * satisfied by the security module's `SecurityCaseService`. The gateway calls
 * it for every secret-gate block — uncertain sensitive content always needs
 * human handling — and only for those: policy and configuration denials
 * involve no request content to dispose. A failing intake never unblocks the
 * request; the denial stands and an operational incident is raised.
 */
export interface GatewayCaseIntake {
  recordGatewayBlock(input: {
    identity: GatewayRequestIdentity;
    reason: string;
    safeDetail: string;
    /** Raw blocked request for encrypted quarantine; never for logs. */
    rawContent?: string;
  }): Promise<{ caseId: string; caseReference: string }>;
}

/**
 * The dependent-work hold to consult at the work-admission boundary (DAT-210).
 * Structurally satisfied by the security module's `SecurityCaseService`. A
 * held run's dependent work — its later gateway invocations included — is
 * rejected until an authorized disposition releases the hold; unrelated runs
 * are never affected.
 */
export interface DependentWorkHold {
  /** The open security case holding this run's dependent work, if any. */
  heldCaseFor(runId: string): { caseId: string; caseReference: string } | undefined;
}

/**
 * Diagnostic type a provider transport uses to expose the provider's own
 * usage payload on the terminal message (DAT-227). The gateway prefers it
 * over the transport-derived usage report when present, records it as
 * `provider_wire` evidence, and the metering adapter maps it with the
 * provider's native semantics.
 *
 * The pi-ai SDK normalizes usage and exposes no wire payload, so pi-ai-backed
 * terminal messages never carry this diagnostic and their attempts are
 * recorded as transport reports instead — preserved verbatim either way.
 */
export const PROVIDER_USAGE_DIAGNOSTIC = "provider_usage";
