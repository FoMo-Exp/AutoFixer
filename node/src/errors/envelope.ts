/**
 * The versioned shared error envelope (DAT-226).
 *
 * One shape for every actionable failure: stable machine code, stage,
 * category, safe message, service-decided retryability, retry-after, a
 * trace/case reference, and the single authorized next action. The envelope
 * is what an agent and a human both see; it never carries secrets, policy
 * internals, or raw diagnostic text — those live behind the separate
 * diagnostics access check in `diagnostics.ts`.
 *
 * Schema policy follows the trace envelope (DAT-224): writers emit the
 * current version, `migrateErrorEnvelope` upgrades legacy shapes forward,
 * a current-version record is validated strictly, and a newer version is
 * refused loudly instead of being misread.
 */
import {
  DENIED_CAPABILITIES,
  ERROR_CATEGORIES,
  ERROR_STAGES,
  ERROR_CATALOG,
  NEXT_ACTIONS,
  type DeniedCapability,
  type ErrorCategory,
  type ErrorCodeSpec,
  type ErrorStage,
  type NextAction,
} from "./catalog.js";
import { redactSensitiveText } from "./redact.js";

export const ERROR_ENVELOPE_VERSION = 1;

export interface ErrorEnvelope {
  /** Envelope schema version. */
  envelope_version: number;
  /** Stable machine code from the closed catalog. Never changed by translation. */
  code: string;
  stage: ErrorStage;
  category: ErrorCategory;
  /** Safe display text; localizable through `message_key`. */
  message: string;
  message_key: string;
  /** Service-decided retry eligibility. Never model-influenced. */
  retryable: boolean;
  /** Earliest safe retry delay in milliseconds; null when retry is not eligible. */
  retry_after_ms: number | null;
  /** Correlation references; a trace ID alone is never the only guidance. */
  trace_ref: { trace_id: string | null; case_ref: string | null };
  /** The single authorized next action. Never widens a grant. */
  next_action: NextAction;
  /** Safe instruction for the agent; localizable through `agent_guidance_key`. */
  agent_guidance: string;
  agent_guidance_key: string;
  /** Safe instruction for humans; localizable through `human_guidance_key`. */
  human_guidance: string;
  human_guidance_key: string;
  /** Denied capability category, when one is known; never the policy behind it. */
  denied_capability: DeniedCapability | null;
}

/** A contract violation in the error envelope itself. */
export class ErrorEnvelopeContractError extends Error {
  readonly code = "ERROR_ENVELOPE_CONTRACT";

  constructor(message: string) {
    super(message);
    this.name = "ErrorEnvelopeContractError";
  }
}

/**
 * Verified service facts that can narrow retry eligibility. They can only
 * make an envelope less retryable, never more: a model-supplied hint is not a
 * fact and has no field here.
 */
export interface EnvelopeFacts {
  /** An uncertain mutation exists, blocking guarded retries. */
  uncertainMutation?: boolean;
  /** The producing service has ruled a retry out for this occurrence. */
  serviceRetryAllowed?: boolean;
}

export interface BuildErrorEnvelopeInput {
  code: string;
  traceId?: string | null;
  caseRef?: string | null;
  /** Provider- or service-stated earliest retry delay. */
  retryAfterMs?: number | null;
  deniedCapability?: DeniedCapability | null;
  facts?: EnvelopeFacts;
}

function computeRetryable(spec: ErrorCodeSpec, facts: EnvelopeFacts | undefined): boolean {
  switch (spec.retry) {
    case "never":
    case "reconcile":
      return false;
    case "bounded":
      return facts?.serviceRetryAllowed !== false;
    case "guarded":
      return facts?.serviceRetryAllowed !== false && facts?.uncertainMutation === false;
  }
}

function computeNextAction(spec: ErrorCodeSpec, retryable: boolean): NextAction {
  if (retryable || spec.exhausted_action === undefined) {
    return spec.next_action;
  }
  return spec.exhausted_action;
}

/**
 * Build one envelope from the closed catalog.
 *
 * Everything user- or model-visible comes from the catalog, so the texts are
 * safe by construction; they are redacted again as defense in depth. Unknown
 * codes are refused loudly — surfaces map their own codes in first (see
 * `map.ts`) instead of inventing vocabulary here.
 */
export function buildErrorEnvelope(input: BuildErrorEnvelopeInput): ErrorEnvelope {
  const spec = ERROR_CATALOG[input.code];
  if (spec === undefined) {
    throw new ErrorEnvelopeContractError(`unknown error code ${JSON.stringify(input.code)}`);
  }
  if (input.deniedCapability != null && !DENIED_CAPABILITIES.includes(input.deniedCapability)) {
    throw new ErrorEnvelopeContractError(
      `unknown denied capability ${JSON.stringify(input.deniedCapability)}`,
    );
  }
  const retryable = computeRetryable(spec, input.facts);
  return {
    envelope_version: ERROR_ENVELOPE_VERSION,
    code: spec.code,
    stage: spec.stage,
    category: spec.category,
    message: redactSensitiveText(spec.message),
    message_key: spec.message_key,
    retryable,
    retry_after_ms: retryable ? (input.retryAfterMs ?? null) : null,
    trace_ref: {
      trace_id: input.traceId ?? null,
      case_ref: input.caseRef ?? null,
    },
    next_action: computeNextAction(spec, retryable),
    agent_guidance: redactSensitiveText(spec.agent_guidance),
    agent_guidance_key: spec.agent_guidance_key,
    human_guidance: redactSensitiveText(spec.human_guidance),
    human_guidance_key: spec.human_guidance_key,
    denied_capability: input.deniedCapability ?? null,
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ErrorEnvelopeContractError(`error envelope ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ErrorEnvelopeContractError(
      `error envelope field "${field}" must be a non-empty string`,
    );
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, field);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const text = asString(value, field);
  if (!allowed.includes(text as T)) {
    throw new ErrorEnvelopeContractError(`error envelope field "${field}" has unknown value`);
  }
  return text as T;
}

/**
 * Validate one fully-shaped current-version envelope. A missing field, an
 * unknown enum value, or a code outside the catalog is a control failure,
 * never a defaulted value.
 */
export function validateErrorEnvelope(value: unknown): ErrorEnvelope {
  const record = asRecord(value, "envelope");
  const version = record["envelope_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new ErrorEnvelopeContractError(
      `error envelope field "envelope_version" must be an integer`,
    );
  }
  if (version > ERROR_ENVELOPE_VERSION) {
    throw new ErrorEnvelopeContractError(
      `error envelope schema ${version} is newer than ${ERROR_ENVELOPE_VERSION}`,
    );
  }
  if (version !== ERROR_ENVELOPE_VERSION) {
    throw new ErrorEnvelopeContractError(
      `error envelope schema ${version} must be migrated to ${ERROR_ENVELOPE_VERSION} first`,
    );
  }
  const code = asString(record["code"], "code");
  const spec = ERROR_CATALOG[code];
  if (spec === undefined) {
    throw new ErrorEnvelopeContractError(
      `error envelope code ${JSON.stringify(code)} is not in the catalog`,
    );
  }
  oneOf(record["stage"], ERROR_STAGES, "stage");
  oneOf(record["category"], ERROR_CATEGORIES, "category");
  asString(record["message"], "message");
  asString(record["message_key"], "message_key");
  if (typeof record["retryable"] !== "boolean") {
    throw new ErrorEnvelopeContractError(`error envelope field "retryable" must be a boolean`);
  }
  const retryAfter = record["retry_after_ms"];
  if (retryAfter !== null && (typeof retryAfter !== "number" || retryAfter < 0)) {
    throw new ErrorEnvelopeContractError(
      `error envelope field "retry_after_ms" must be a non-negative number or null`,
    );
  }
  const traceRef = asRecord(record["trace_ref"], "trace_ref");
  asNullableString(traceRef["trace_id"], "trace_ref.trace_id");
  asNullableString(traceRef["case_ref"], "trace_ref.case_ref");
  oneOf(record["next_action"], NEXT_ACTIONS, "next_action");
  asString(record["agent_guidance"], "agent_guidance");
  asString(record["agent_guidance_key"], "agent_guidance_key");
  asString(record["human_guidance"], "human_guidance");
  asString(record["human_guidance_key"], "human_guidance_key");
  const denied = record["denied_capability"];
  if (denied !== null) {
    oneOf(denied, DENIED_CAPABILITIES, "denied_capability");
  }
  return record as unknown as ErrorEnvelope;
}

/**
 * Upgrade one legacy error record to the current envelope and validate it.
 *
 * Only the unversioned (v0) legacy shape — a bare `{ code }` error object —
 * is upgraded, by rebuilding from the catalog with neutral correlation
 * fields. A record that already claims the current version must be complete
 * (validated strictly), and a newer version is refused instead of misread.
 */
export function migrateErrorEnvelope(raw: unknown): ErrorEnvelope {
  const record = asRecord(raw, "envelope");
  const version = record["envelope_version"];
  if (version !== undefined && version !== null) {
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new ErrorEnvelopeContractError(
        `error envelope field "envelope_version" must be an integer`,
      );
    }
    if (version > ERROR_ENVELOPE_VERSION) {
      throw new ErrorEnvelopeContractError(
        `error envelope schema ${version} is newer than ${ERROR_ENVELOPE_VERSION}`,
      );
    }
    if (version === ERROR_ENVELOPE_VERSION) {
      return validateErrorEnvelope(record);
    }
  }
  const code = asString(record["code"], "code");
  return validateErrorEnvelope(buildErrorEnvelope({ code }));
}

/**
 * Swap display text for a locale without touching the machine contract.
 *
 * `texts` maps stable keys (message_key, agent_guidance_key,
 * human_guidance_key) to translated strings. Codes, categories, retry
 * decisions, and the authorized next action are never localized.
 */
export function localizeError(
  envelope: ErrorEnvelope,
  texts: Readonly<Record<string, string>>,
): ErrorEnvelope {
  return {
    ...envelope,
    message: texts[envelope.message_key] ?? envelope.message,
    agent_guidance: texts[envelope.agent_guidance_key] ?? envelope.agent_guidance,
    human_guidance: texts[envelope.human_guidance_key] ?? envelope.human_guidance,
  };
}

/**
 * Render the model-facing error text: the safe message, the service-decided
 * next action, and the agent guidance — never raw diagnostics. The origin
 * code (dsh, gateway) is correlation vocabulary, not a secret, so it is kept
 * when it differs from the shared code.
 */
export function renderAgentError(envelope: ErrorEnvelope, originCode?: string | null): string {
  const origin =
    typeof originCode === "string" && originCode.length > 0 && originCode !== envelope.code
      ? ` (origin: ${originCode})`
      : "";
  return (
    `[${envelope.code}] ${envelope.message}${origin} ` +
    `Next action: ${envelope.next_action}. ${envelope.agent_guidance}`
  );
}
