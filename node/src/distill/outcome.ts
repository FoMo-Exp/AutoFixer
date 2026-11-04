/**
 * Outcome envelope parsing and classification (DAT-233).
 *
 * Parsing is strict in the DAT-193 sense: a closed key set at every level,
 * closed vocabularies, bounded strings, and cross-field consistency rules that
 * make a fabricated `accepted`/`merged` outcome impossible to express — an
 * `accepted` outcome exists only with a delivery record whose patch status is
 * `merged` and whose branch/head/PR identities are present, and a non-accepted
 * outcome can never claim a merged patch.
 *
 * Classification is derived from the envelope's terminal state and delivery
 * facts. The producer never supplies the class, so nothing upstream can claim
 * success for a timeout, an unknown delivery result, or an infrastructure
 * failure.
 */

import { ValidationError } from "../control-plane/errors.js";
import { assertNoSecretOrPii } from "./redact.js";
import {
  FAILURE_CAUSES,
  OUTCOME_CHANGE_SUMMARY_MAX,
  OUTCOME_ENVELOPE_CONTRACT_VERSION,
  OUTCOME_EVIDENCE_MAX,
  OUTCOME_EVIDENCE_TYPES,
  OUTCOME_ID_MAX,
  OUTCOME_REASON_MAX,
  OUTCOME_REFERENCE_MAX,
  OUTCOME_TOOL_MAX,
  OUTCOME_VALIDATION_MAX,
  PATCH_STATUSES,
  STOP_DISPOSITIONS,
  TERMINAL_STATES,
} from "./types.js";
import type {
  FailureCause,
  OutcomeClassification,
  OutcomeDelivery,
  OutcomeEnvelope,
  OutcomeEvidenceRef,
  OutcomeValidationEvidence,
  PatchStatus,
  StopDisposition,
  TerminalState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Strict field helpers
// ---------------------------------------------------------------------------

function strictObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`outcome ${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`outcome ${label} carries unknown field ${key}`);
    }
  }
  return record;
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`outcome ${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new ValidationError(`outcome ${field} must not exceed ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, field, max);
}

/**
 * An opaque identifier that will be persisted as an evidence reference. Such
 * strings must never carry secret or personal material — the evidence
 * contract admits no secret or raw sensitive output in a record — so a
 * credential- or PII-shaped reference is rejected, never stored.
 */
function requireReference(value: unknown, field: string, max: number): string {
  const text = requireString(value, field, max);
  assertNoSecretOrPii(text, field);
  return text;
}

function optionalReference(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireReference(value, field, OUTCOME_ID_MAX);
}

function requireEnum<T extends string>(value: unknown, members: readonly T[], field: string): T {
  if (typeof value !== "string" || !(members as readonly string[]).includes(value)) {
    throw new ValidationError(`outcome ${field} must be one of ${members.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  members: readonly T[],
  field: string,
): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireEnum(value, members, field);
}

// ---------------------------------------------------------------------------
// Record parsers
// ---------------------------------------------------------------------------

const EVIDENCE_REF_KEYS = new Set(["evidence_type", "reference"]);
const VALIDATION_KEYS = new Set(["tool", "exit_status", "event_reference"]);
const DELIVERY_KEYS = new Set([
  "patch_status",
  "head_sha",
  "pr_id",
  "change_summary",
  "validation",
]);
const ENVELOPE_KEYS = new Set([
  "contract_version",
  "task_id",
  "run_id",
  "issue_id",
  "terminal_state",
  "stop_disposition",
  "failure_cause",
  "reason",
  "delivery",
  "evidence",
]);

function parseEvidenceRef(value: unknown, index: number): OutcomeEvidenceRef {
  const record = strictObject(value, EVIDENCE_REF_KEYS, `evidence[${index}]`);
  return {
    evidence_type: requireEnum(record["evidence_type"], OUTCOME_EVIDENCE_TYPES, "evidence_type"),
    reference: requireReference(record["reference"], "reference", OUTCOME_REFERENCE_MAX),
  };
}

function parseValidation(value: unknown, index: number): OutcomeValidationEvidence {
  const record = strictObject(value, VALIDATION_KEYS, `validation[${index}]`);
  const exitStatus = record["exit_status"];
  if (exitStatus !== null && exitStatus !== undefined && !Number.isInteger(exitStatus)) {
    throw new ValidationError("outcome validation exit_status must be an integer or null");
  }
  return {
    tool: requireString(record["tool"], "validation tool", OUTCOME_TOOL_MAX),
    exit_status: (exitStatus ?? null) as number | null,
    event_reference: requireReference(
      record["event_reference"],
      "validation event_reference",
      OUTCOME_REFERENCE_MAX,
    ),
  };
}

function parseDelivery(value: unknown): OutcomeDelivery {
  const record = strictObject(value, DELIVERY_KEYS, "delivery");
  const validation = record["validation"];
  if (!Array.isArray(validation) || validation.length > OUTCOME_VALIDATION_MAX) {
    throw new ValidationError(
      `outcome delivery validation must be an array of at most ${OUTCOME_VALIDATION_MAX} entries`,
    );
  }
  const headSha = optionalReference(record["head_sha"], "head_sha");
  const prId = optionalReference(record["pr_id"], "pr_id");
  const patchStatus = requireEnum(record["patch_status"], PATCH_STATUSES, "patch_status");
  // task-evidence-contract-v1 §4: revision identities are present exactly as
  // the patch status says; a fabricated merge cannot smuggle identities in.
  if (patchStatus === "not_created" && (headSha !== null || prId !== null)) {
    throw new ValidationError("not_created delivery must have null head_sha and pr_id");
  }
  if (patchStatus === "prepared_no_pr" && (headSha === null || prId !== null)) {
    throw new ValidationError("prepared_no_pr delivery needs head_sha and null pr_id");
  }
  if (patchStatus === "proposed" && (headSha === null || prId === null)) {
    throw new ValidationError("proposed delivery needs head_sha and pr_id");
  }
  return {
    patch_status: patchStatus as PatchStatus,
    head_sha: headSha,
    pr_id: prId,
    change_summary: requireString(
      record["change_summary"],
      "delivery change_summary",
      OUTCOME_CHANGE_SUMMARY_MAX,
    ),
    validation: validation.map((entry, index) => parseValidation(entry, index)),
  };
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

/**
 * Parse one outcome envelope. Unknown fields, unknown enum values, oversized
 * strings, and inconsistent terminal/delivery combinations are rejected — the
 * envelope contract is the only input shape this write path accepts.
 */
export function parseOutcomeEnvelope(value: unknown): OutcomeEnvelope {
  const record = strictObject(value, ENVELOPE_KEYS, "envelope");
  if (record["contract_version"] !== OUTCOME_ENVELOPE_CONTRACT_VERSION) {
    throw new ValidationError(
      `outcome contract_version must be ${OUTCOME_ENVELOPE_CONTRACT_VERSION}`,
    );
  }
  const terminalState = requireEnum(record["terminal_state"], TERMINAL_STATES, "terminal_state");
  const stopDisposition = optionalEnum(
    record["stop_disposition"],
    STOP_DISPOSITIONS,
    "stop_disposition",
  );
  const failureCause = optionalEnum(record["failure_cause"], FAILURE_CAUSES, "failure_cause");
  const reason = optionalString(record["reason"], "reason", OUTCOME_REASON_MAX);
  const delivery = parseDelivery(record["delivery"]);

  const rawEvidence = record["evidence"];
  if (!Array.isArray(rawEvidence) || rawEvidence.length > OUTCOME_EVIDENCE_MAX) {
    throw new ValidationError(
      `outcome evidence must be an array of at most ${OUTCOME_EVIDENCE_MAX} entries`,
    );
  }
  const evidence = rawEvidence.map((entry, index) => parseEvidenceRef(entry, index));
  const seen = new Set<string>();
  for (const ref of evidence) {
    const key = `${ref.evidence_type}\u0000${ref.reference}`;
    if (seen.has(key)) {
      throw new ValidationError("outcome evidence references must be unique");
    }
    seen.add(key);
  }

  // Cross-field consistency: terminal state, disposition, cause, and reason
  // must agree, and only a merged delivery may claim a merged outcome.
  if (terminalState === "stopped") {
    if (stopDisposition === null) {
      throw new ValidationError("stopped outcome requires a stop_disposition");
    }
    if (stopDisposition === "failed" && failureCause === null) {
      throw new ValidationError("failed stop_disposition requires a classified failure_cause");
    }
  } else {
    if (stopDisposition !== null) {
      throw new ValidationError("stop_disposition is only valid for a stopped outcome");
    }
    if (failureCause !== null) {
      throw new ValidationError("failure_cause is only valid for a failed stop_disposition");
    }
  }
  if ((terminalState === "rejected" || terminalState === "cancelled") && reason === null) {
    throw new ValidationError(`${terminalState} outcome requires a recorded reason`);
  }
  if (terminalState === "merged" && delivery.patch_status !== "merged") {
    throw new ValidationError("merged outcome requires a merged delivery record");
  }
  if (terminalState !== "merged" && delivery.patch_status === "merged") {
    throw new ValidationError("only a merged outcome may carry a merged delivery record");
  }
  if (terminalState === "merged" && delivery.pr_id === null) {
    throw new ValidationError("merged outcome requires a PR identity");
  }

  return {
    contract_version: OUTCOME_ENVELOPE_CONTRACT_VERSION,
    task_id: requireReference(record["task_id"], "task_id", OUTCOME_ID_MAX),
    run_id: requireReference(record["run_id"], "run_id", OUTCOME_ID_MAX),
    issue_id: requireReference(record["issue_id"], "issue_id", OUTCOME_ID_MAX),
    terminal_state: terminalState as TerminalState,
    stop_disposition: stopDisposition as StopDisposition | null,
    failure_cause: failureCause as FailureCause | null,
    reason,
    delivery,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Derive the outcome class from the terminal state and delivery facts.
 *
 * Known outcomes — `accepted`/`merged`, `rejected` with a reason, explicitly
 * `cancelled`, `failed` with a classified cause — may support a distilled
 * candidate. `timeout`, `unknown`, and `infra_failure` are episode-only: they
 * are never counted as success and never carry positive evidence.
 */
export function classifyOutcome(envelope: OutcomeEnvelope): OutcomeClassification {
  let outcomeClass: OutcomeClassification["class"];
  switch (envelope.terminal_state) {
    case "merged":
      outcomeClass = "accepted";
      break;
    case "rejected":
      outcomeClass = "rejected";
      break;
    case "cancelled":
      outcomeClass = "cancelled";
      break;
    case "timed_out":
    case "expired":
      outcomeClass = "timeout";
      break;
    case "stopped":
      outcomeClass =
        envelope.stop_disposition === "failed"
          ? "failed"
          : envelope.stop_disposition === "infra_failure"
            ? "infra_failure"
            : "unknown";
      break;
  }
  const positive = outcomeClass === "accepted";
  const known =
    positive ||
    outcomeClass === "rejected" ||
    outcomeClass === "cancelled" ||
    outcomeClass === "failed";
  return {
    class: outcomeClass,
    known,
    positive,
    episode_only: !known,
  };
}
