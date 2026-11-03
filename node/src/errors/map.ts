/**
 * Mapping from surface vocabulary into the shared error catalog (DAT-226).
 *
 * dsh-control/v1, the model gateway, and the trace model each have their own
 * error codes. This module is the one place that translates them into the
 * shared envelope, with two hard rules from ADR-0008:
 *
 * - A policy/authorization denial maps to a denial category — it is never
 *   rewritten as a generic internal error ("500"), whatever the fallback.
 * - The origin code and raw detail are preserved as sealed diagnostics and
 *   correlation, never in the envelope texts.
 */
import { isErrorCode, type DeniedCapability, type ErrorCode } from "./catalog.js";
import { buildErrorEnvelope, type ErrorEnvelope } from "./envelope.js";
import { sealDiagnostics, type SensitiveDiagnostics } from "./diagnostics.js";

/** The shape of a surface error as this module needs it (structural, not nominal). */
export interface ForeignErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
  readonly retryable?: unknown;
  readonly details?: unknown;
}

export interface MapErrorOptions {
  caseRef?: string | null;
  traceId?: string | null;
  retryAfterMs?: number | null;
  uncertainMutation?: boolean;
  /** Known secret values to scrub from diagnostics (e.g. a used credential). */
  literalSecrets?: readonly string[];
  /** RFC 3339 capture time for the sealed diagnostics. */
  capturedAt?: string;
}

export interface MappedError {
  envelope: ErrorEnvelope;
  diagnostics: SensitiveDiagnostics;
}

/**
 * Explicit dsh-control/v1 mappings. Everything else falls back to the status
 * class below, so a denial can never slip through as an internal error just
 * because its code is new.
 */
const DSH_CODE_MAP: Readonly<
  Record<string, { code: ErrorCode; denied_capability?: DeniedCapability }>
> = Object.freeze({
  DSH_SCOPE_DENIED: { code: "TOOL_SCOPE_DENIED", denied_capability: "path_scope" },
  DSH_POLICY_DENIED: { code: "TOOL_SCOPE_DENIED", denied_capability: "policy" },
  DSH_TOOL_NOT_ALLOWLISTED: { code: "TOOL_SCOPE_DENIED", denied_capability: "tool" },
  TOOL_NOT_REGISTERED: { code: "TOOL_SCOPE_DENIED", denied_capability: "tool" },
  INVALID_TOOL_ARGUMENTS: { code: "INVALID_REQUEST", denied_capability: "arguments" },
  INVALID_ACTION_INTENT: { code: "INVALID_REQUEST", denied_capability: "arguments" },
  INVALID_REQUEST: { code: "INVALID_REQUEST", denied_capability: "arguments" },
  INVALID_BASE_SHA: { code: "INVALID_REQUEST", denied_capability: "arguments" },
  INVALID_REPOSITORY_IDENTITY: { code: "INVALID_REQUEST", denied_capability: "arguments" },
  PROTOCOL_VERSION_UNSUPPORTED: { code: "INVALID_REQUEST", denied_capability: "arguments" },
  DSH_SANDBOX_UNAVAILABLE: { code: "SANDBOX_UNAVAILABLE" },
  DSH_EVIDENCE_STORE_UNAVAILABLE: { code: "TRANSPORT_ERROR" },
  DSH_UNAVAILABLE: { code: "TRANSPORT_ERROR" },
  DSH_GRANT_EXPIRED: { code: "HARNESS_STOP_CONDITION", denied_capability: "grant" },
  DSH_GRANT_REVOKED: { code: "HARNESS_STOP_CONDITION", denied_capability: "grant" },
  DSH_APPROVAL_REQUIRED: { code: "APPROVAL_REQUIRED", denied_capability: "grant" },
  DSH_RISK_PROHIBITED: { code: "RISK_PROHIBITED" },
  DSH_RUN_BUSY: { code: "STATE_CONFLICT", denied_capability: "run_state" },
  TASK_STATE_CONFLICT: { code: "STATE_CONFLICT", denied_capability: "run_state" },
  TASK_ALREADY_HAS_ACTIVE_RUN: { code: "STATE_CONFLICT", denied_capability: "run_state" },
  IDEMPOTENCY_CONFLICT: { code: "STATE_CONFLICT" },
  DSH_APPROVAL_SCOPE_MISMATCH: { code: "STATE_CONFLICT" },
  DSH_APPROVAL_WINDOW_EXPIRED: { code: "STATE_CONFLICT" },
  DSH_CANCELLATION_CONTROL_FAILURE: { code: "INTERNAL_ERROR" },
});

/** Trace-model codes map onto the same shared semantics. */
const TRACE_CODE_MAP: Readonly<Record<string, ErrorCode>> = Object.freeze({
  TRACE_VALIDATION_FAILED: "VALIDATION_FAILED",
  TRACE_ACCESS_DENIED: "FORBIDDEN",
  TRACE_EVENT_CONFLICT: "STATE_CONFLICT",
});

/**
 * Status-class fallback for codes without an explicit mapping. The classes
 * are chosen so that every authorization/policy refusal (401/403/410/422/428)
 * lands on a denial or human-decision outcome and only a genuine 5xx or
 * unclassifiable failure becomes INTERNAL_ERROR.
 */
function codeForStatus(status: number | undefined): ErrorCode {
  switch (status) {
    case 400:
    case 404:
      return "INVALID_REQUEST";
    case 401:
    case 403:
      return "FORBIDDEN";
    case 409:
      return "STATE_CONFLICT";
    case 410:
      return "HARNESS_STOP_CONDITION";
    case 422:
      return "RISK_PROHIBITED";
    case 428:
      return "APPROVAL_REQUIRED";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "TRANSPORT_ERROR";
    default:
      return "INTERNAL_ERROR";
  }
}

function deniedCapabilityForStatus(status: number | undefined): DeniedCapability | null {
  if (status === 401 || status === 403) {
    return "policy";
  }
  if (status === 410 || status === 428) {
    return "grant";
  }
  if (status === 409) {
    return "run_state";
  }
  return null;
}

function diagnosticDetail(error: ForeignErrorLike): string {
  const message = typeof error.message === "string" ? error.message : "";
  if (error.details === undefined || error.details === null) {
    return message;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(error.details);
  } catch {
    serialized = "[unserializable details]";
  }
  return message.length > 0 ? `${message} ${serialized}` : serialized;
}

function finish(
  code: ErrorCode,
  error: ForeignErrorLike,
  deniedCapability: DeniedCapability | null,
  options: MapErrorOptions,
): MappedError {
  const originCode = typeof error.code === "string" ? error.code : null;
  return {
    envelope: buildErrorEnvelope({
      code,
      traceId: options.traceId ?? null,
      caseRef: options.caseRef ?? null,
      retryAfterMs: options.retryAfterMs ?? null,
      deniedCapability,
      facts: {
        ...(options.uncertainMutation === undefined
          ? {}
          : { uncertainMutation: options.uncertainMutation }),
        ...(error.retryable === false ? { serviceRetryAllowed: false } : {}),
      },
    }),
    diagnostics: sealDiagnostics(
      {
        caseRef: options.caseRef ?? null,
        originCode,
        detail: diagnosticDetail(error),
        ...(options.capturedAt === undefined ? {} : { capturedAt: options.capturedAt }),
      },
      options.literalSecrets ?? [],
    ),
  };
}

/**
 * Map one dsh-control/v1 failure (or anything shaped like it) into the
 * shared envelope. Explicit code mappings win; otherwise the HTTP status
 * class decides — a 403 is a denial even for a code this build has never
 * seen.
 */
export function mapDshError(error: ForeignErrorLike, options: MapErrorOptions = {}): MappedError {
  const code = typeof error.code === "string" ? error.code : null;
  const status = typeof error.status === "number" ? error.status : undefined;
  const mapped = code === null ? undefined : DSH_CODE_MAP[code];
  if (mapped !== undefined) {
    return finish(mapped.code, error, mapped.denied_capability ?? null, options);
  }
  // A code that already belongs to the shared vocabulary passes through
  // untouched (MODEL_RATE_LIMITED and friends reach callers directly).
  if (code !== null && isErrorCode(code)) {
    return finish(code, error, null, options);
  }
  const traceTarget = code === null ? undefined : TRACE_CODE_MAP[code];
  if (traceTarget !== undefined) {
    return finish(traceTarget, error, null, options);
  }
  return finish(codeForStatus(status), error, deniedCapabilityForStatus(status), options);
}

/**
 * Map any thrown value into the shared envelope. Recognised surface errors
 * (gateway, trace) map by their own code; anything else goes through the dsh
 * rules, and only a genuinely unclassifiable failure becomes INTERNAL_ERROR.
 */
export function mapForeignError(error: unknown, options: MapErrorOptions = {}): MappedError {
  if (error !== null && typeof error === "object") {
    const candidate = error as ForeignErrorLike;
    const code = typeof candidate.code === "string" ? candidate.code : null;
    if (code !== null && TRACE_CODE_MAP[code] !== undefined) {
      return finish(TRACE_CODE_MAP[code], candidate, null, options);
    }
    return mapDshError(candidate, options);
  }
  return mapDshError(
    {
      message: typeof error === "string" ? error : "unclassifiable failure",
    },
    options,
  );
}
