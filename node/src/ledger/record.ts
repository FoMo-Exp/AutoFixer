/**
 * Invocation usage ledger records (DAT-227, ADR-0008 "Invocation ledger").
 *
 * One immutable record per actual invocation attempt — successes, failures,
 * retries and fallbacks alike. The record is the reconciliation evidence for
 * that attempt: provider request id, requested and returned model identity,
 * start/end time, finish status, token categories with their inclusion
 * relations, usage provenance, and a known/estimated/unknown completeness
 * that is queryable in its own right.
 *
 * Honesty rules enforced here:
 * - A missing usage figure is `null` with completeness `unknown`. It is never
 *   recorded as zero (zero-filled missing usage is exactly what ADR-0008
 *   rejects).
 * - Figures from an attempt that did not complete are `estimated`, and its
 *   completion-dependent figures stay unknown — never a stale partial count,
 *   never a reconciled amount.
 * - Without provider-native metering semantics (unmapped protocol), records
 *   stay `estimated` — no invented precision, no invented currency.
 * - Included categories (reasoning inside output, cache inside input, ...)
 *   carry their inclusion relation next to the figure, so totals and later
 *   rate computation cannot double-count them.
 * - The reported usage payload is preserved verbatim (whatever its source) so
 *   every figure can be checked against what the call actually reported.
 */
import { LedgerValidationError } from "./errors.js";
import {
  TOKEN_CATEGORIES,
  allUnknown,
  totalOf,
  resolveMeteringAdapter,
  type MappedUsage,
  type MeteringUnit,
  type ProviderMeteringAdapter,
  type TokenCategory,
  type UsageCompleteness,
  type UsageFigure,
  type UsageProvenance,
} from "./metering.js";

export const USAGE_RECORD_SCHEMA_VERSION = 1;

export type { UsageCompleteness, UsageProvenance } from "./metering.js";

/** How an attempt ended, as the transport reported it. */
export type LedgerFinishStatus =
  | "stop"
  | "length"
  | "tool_use"
  | "error"
  | "aborted"
  /** The transport failed before or instead of a provider finish. */
  | "transport_failed"
  /** The stream ended without any terminal signal to read a finish from. */
  | "unknown";

const FINISH_STATUSES: readonly LedgerFinishStatus[] = [
  "stop",
  "length",
  "tool_use",
  "error",
  "aborted",
  "transport_failed",
  "unknown",
];

/** Finishes of an attempt that ran to a provider-reported end. */
const COMPLETED_FINISHES: readonly LedgerFinishStatus[] = ["stop", "length", "tool_use"];

/** Where a usage report came from; `provenance` adds "absent" for none at all. */
export type UsageReportSource = "provider_wire" | "transport_reported";

export interface UsageReportObservation {
  /**
   * `provider_wire` is the provider's own usage object as the transport
   * surfaced it; `transport_reported` is the usage report the transport
   * derives from the provider's metering (the pi-ai SDK normalizes usage and
   * exposes no wire payload, so pi-ai-backed attempts report from here).
   */
  source: UsageReportSource;
  /** Provider-native usage payload, or the transport's normalized report. */
  payload: unknown;
}

/** Correlation identity of the dispatch call this attempt belongs to. */
export interface InvocationAttemptIdentity {
  enterprise_id: string;
  workspace_id: string;
  issue_id: string;
  run_id: string;
  invocation_id: string;
  trace_id: string;
}

/**
 * What the gateway observed for one invocation attempt. This is the input to
 * `buildInvocationUsageRecord`; it carries facts only, never derived figures.
 */
export interface InvocationAttemptObservation {
  identity: InvocationAttemptIdentity;
  /** 1-based attempt number within the dispatch call (retries/fallbacks count up). */
  attempt: number;
  destination: {
    endpoint_id: string;
    provider: string;
    /** The model id the attempt requested. */
    model_id: string;
    internal: boolean;
  };
  /** Provider protocol identity — the metering adapter key. */
  api: string;
  started_at: string;
  ended_at: string;
  finish_status: LedgerFinishStatus;
  /** Provider request id where the provider exposes one; null when not exposed. */
  provider_request_id: string | null;
  /** Model identity the provider returned; null when not exposed. */
  returned_model: string | null;
  /** The usage the provider or transport reported; null when nothing was reported. */
  usage_report: UsageReportObservation | null;
}

/** Metering semantics snapshot carried on every record. */
export interface MeteringSnapshot {
  adapter_id: string;
  adapter_revision: number;
  unit: MeteringUnit;
  currency: string | null;
  provider_native: boolean;
  categories: Record<TokenCategory, { included_in: TokenCategory | null }>;
}

export interface InvocationUsageRecord {
  schema_version: number;
  enterprise_id: string;
  workspace_id: string;
  issue_id: string;
  run_id: string;
  invocation_id: string;
  trace_id: string;
  attempt: number;
  endpoint_id: string;
  provider: string;
  api: string;
  requested_model: string;
  returned_model: string | null;
  provider_request_id: string | null;
  internal: boolean;
  started_at: string;
  ended_at: string;
  finish_status: LedgerFinishStatus;
  metering: MeteringSnapshot;
  usage: {
    input: UsageFigure;
    output: UsageFigure;
    cache_read: UsageFigure;
    cache_write: UsageFigure;
    reasoning: UsageFigure;
    /** Sum of figures the provider meters on their own line; null when unknown. */
    total_tokens: number | null;
    /** Record-level reconciliation state; an independent, queryable field. */
    completeness: UsageCompleteness;
    provenance: UsageProvenance;
  };
  /**
   * The usage payload exactly as reported — the provider's native usage
   * object when the transport exposes one (`provenance: provider_wire`),
   * otherwise the transport's usage report as translated by the SDK
   * (`provenance: transport_reported`; a transport report may carry an
   * SDK-computed cost estimate, which is evidence of what the transport said,
   * never a billed amount). Preserved verbatim so usage can be reconciled
   * against provider records. Never request/response content.
   */
  raw_usage: Record<string, unknown> | null;
  /** Store-stamped time this record was first written. */
  recorded_at: string;
}

function unknownUsage(adapter: ProviderMeteringAdapter): MappedUsage {
  return allUnknown(adapter.categories);
}

/**
 * Honest figures for an attempt that never completed: the provider finalizes
 * its completion-dependent categories only at stream end, so those stay
 * unknown rather than a stale partial count or a zero-fill. What the provider
 * did meter at request time survives as an estimate — never a reconciled
 * amount.
 */
function uncompletedUsage(mapped: MappedUsage, adapter: ProviderMeteringAdapter): MappedUsage {
  const finalize = (category: TokenCategory, usageFigure: UsageFigure): UsageFigure => {
    if (adapter.completionDependent.includes(category)) {
      return {
        tokens: null,
        completeness: "unknown",
        included_in: usageFigure.included_in,
      };
    }
    return usageFigure.tokens === null
      ? usageFigure
      : { ...usageFigure, completeness: "estimated" };
  };
  const categories: Record<TokenCategory, UsageFigure> = {
    input: finalize("input", mapped.input),
    output: finalize("output", mapped.output),
    cache_read: finalize("cache_read", mapped.cache_read),
    cache_write: finalize("cache_write", mapped.cache_write),
    reasoning: finalize("reasoning", mapped.reasoning),
  };
  // The total follows its figures: null while any own-line figure is unknown.
  return { ...categories, total_tokens: totalOf(categories) };
}

function rollupCompleteness(
  mapped: MappedUsage,
  completed: boolean,
  providerNative: boolean,
): UsageCompleteness {
  const figures = [
    mapped.input,
    mapped.output,
    mapped.cache_read,
    mapped.cache_write,
    mapped.reasoning,
  ];
  if (figures.every((usageFigure) => usageFigure.tokens === null)) {
    return "unknown";
  }
  if (completed && providerNative && mapped.total_tokens !== null) {
    return "known";
  }
  return "estimated";
}

/**
 * The usage payload exactly as it was reported, preserved verbatim for
 * reconciliation — whichever source it came from. A wire payload is the
 * provider's own usage object; a transport report is the provider's metering
 * as the SDK translated it. Both are checkable evidence of what the call
 * reported; neither is ever request/response content.
 */
function reportedPayload(report: UsageReportObservation | null): Record<string, unknown> | null {
  if (!report) {
    return null;
  }
  const payload = report.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as Record<string, unknown>;
}

/**
 * Build the immutable ledger record for one observed attempt. Figures come
 * from the provider metering adapter for the attempt's protocol; anything the
 * adapter cannot establish stays unknown instead of being defaulted.
 */
export function buildInvocationUsageRecord(
  observation: InvocationAttemptObservation,
  defaultRecordedAt: string,
): InvocationUsageRecord {
  const adapter = resolveMeteringAdapter(observation.api);
  const report = observation.usage_report;
  let mapped: MappedUsage;
  let provenance: UsageProvenance;
  try {
    if (!report) {
      mapped = unknownUsage(adapter);
      provenance = "absent";
    } else if (report.source === "provider_wire") {
      mapped = adapter.normalize(report.payload);
      provenance = "provider_wire";
    } else {
      mapped = adapter.fromTransport(report.payload);
      provenance = "transport_reported";
    }
  } catch {
    // Metering must never fabricate figures from a payload it cannot read.
    mapped = unknownUsage(adapter);
    provenance = report ? report.source : "absent";
  }
  const completed = COMPLETED_FINISHES.includes(observation.finish_status);
  const usage = completed ? mapped : uncompletedUsage(mapped, adapter);
  return validateInvocationUsageRecord({
    schema_version: USAGE_RECORD_SCHEMA_VERSION,
    enterprise_id: observation.identity.enterprise_id,
    workspace_id: observation.identity.workspace_id,
    issue_id: observation.identity.issue_id,
    run_id: observation.identity.run_id,
    invocation_id: observation.identity.invocation_id,
    trace_id: observation.identity.trace_id,
    attempt: observation.attempt,
    endpoint_id: observation.destination.endpoint_id,
    provider: observation.destination.provider,
    api: observation.api,
    requested_model: observation.destination.model_id,
    returned_model: observation.returned_model,
    provider_request_id: observation.provider_request_id,
    internal: observation.destination.internal,
    started_at: observation.started_at,
    ended_at: observation.ended_at,
    finish_status: observation.finish_status,
    metering: {
      adapter_id: adapter.id,
      adapter_revision: adapter.revision,
      unit: adapter.unit,
      currency: adapter.currency,
      provider_native: adapter.providerNative,
      categories: Object.fromEntries(
        TOKEN_CATEGORIES.map((category) => [
          category,
          { included_in: adapter.categories[category].includedIn },
        ]),
      ) as Record<TokenCategory, { included_in: TokenCategory | null }>,
    },
    usage: {
      input: usage.input,
      output: usage.output,
      cache_read: usage.cache_read,
      cache_write: usage.cache_write,
      reasoning: usage.reasoning,
      total_tokens: usage.total_tokens,
      completeness: rollupCompleteness(usage, completed, adapter.providerNative),
      provenance,
    },
    raw_usage: reportedPayload(report),
    recorded_at: defaultRecordedAt,
  });
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LedgerValidationError(`usage record ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerValidationError(`usage record field "${field}" must be a non-empty string`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, field);
}

function asTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new LedgerValidationError(`usage record field "${field}" must be an RFC 3339 timestamp`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new LedgerValidationError(`usage record field "${field}" must be a boolean`);
  }
  return value;
}

function asUsageFigure(value: unknown, field: string): UsageFigure {
  const record = asRecord(value, field);
  const tokens = record["tokens"];
  const completeness = record["completeness"];
  const includedIn = record["included_in"];
  if (tokens !== null && (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)) {
    throw new LedgerValidationError(
      `usage record figure "${field}.tokens" must be null or a non-negative number`,
    );
  }
  if (!["known", "estimated", "unknown"].includes(completeness as string)) {
    throw new LedgerValidationError(
      `usage record figure "${field}.completeness" must be known, estimated, or unknown`,
    );
  }
  if (includedIn !== null && !TOKEN_CATEGORIES.includes(includedIn as TokenCategory)) {
    throw new LedgerValidationError(
      `usage record figure "${field}.included_in" must be a token category or null`,
    );
  }
  if ((tokens === null) !== (completeness === "unknown")) {
    throw new LedgerValidationError(
      `usage record figure "${field}" must pair a missing token count with completeness unknown`,
    );
  }
  return {
    tokens: tokens as number | null,
    completeness: completeness as UsageCompleteness,
    included_in: includedIn as TokenCategory | null,
  };
}

/**
 * Validate one fully-shaped current-version record. A record whose figures,
 * totals, or completeness disagree is a contract failure — the same intent as
 * the trace envelope: corruption must never masquerade as known data.
 */
export function validateInvocationUsageRecord(value: unknown): InvocationUsageRecord {
  const record = asRecord(value, "record");
  const version = record["schema_version"];
  if (version !== USAGE_RECORD_SCHEMA_VERSION) {
    throw new LedgerValidationError(
      `usage record schema ${String(version)} is not ${USAGE_RECORD_SCHEMA_VERSION}`,
    );
  }
  for (const field of [
    "enterprise_id",
    "workspace_id",
    "issue_id",
    "run_id",
    "invocation_id",
    "trace_id",
    "endpoint_id",
    "provider",
    "api",
    "requested_model",
  ]) {
    asString(record[field], field);
  }
  asNullableString(record["returned_model"], "returned_model");
  asNullableString(record["provider_request_id"], "provider_request_id");
  const attempt = record["attempt"];
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new LedgerValidationError(
      `usage record field "attempt" must be an integer starting at 1`,
    );
  }
  asBoolean(record["internal"], "internal");
  asTimestamp(record["started_at"], "started_at");
  asTimestamp(record["ended_at"], "ended_at");
  asTimestamp(record["recorded_at"], "recorded_at");
  const finish = record["finish_status"];
  if (!FINISH_STATUSES.includes(finish as LedgerFinishStatus)) {
    throw new LedgerValidationError(`usage record field "finish_status" has unknown value`);
  }
  const metering = asRecord(record["metering"], "metering");
  asString(metering["adapter_id"], "metering.adapter_id");
  const revision = metering["adapter_revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new LedgerValidationError(
      `usage record field "metering.adapter_revision" must be a positive integer`,
    );
  }
  if (metering["unit"] !== "tokens") {
    throw new LedgerValidationError(`usage record field "metering.unit" must be "tokens"`);
  }
  asNullableString(metering["currency"], "metering.currency");
  asBoolean(metering["provider_native"], "metering.provider_native");
  const meteringCategories = asRecord(metering["categories"], "metering.categories");
  for (const category of TOKEN_CATEGORIES) {
    const entry = asRecord(meteringCategories[category], `metering.categories.${category}`);
    const includedIn = entry["included_in"];
    if (includedIn !== null && !TOKEN_CATEGORIES.includes(includedIn as TokenCategory)) {
      throw new LedgerValidationError(
        `usage record metering category "${category}" must include into a category or null`,
      );
    }
  }
  const usage = asRecord(record["usage"], "usage");
  const figures: Record<TokenCategory, UsageFigure> = {
    input: asUsageFigure(usage["input"], "usage.input"),
    output: asUsageFigure(usage["output"], "usage.output"),
    cache_read: asUsageFigure(usage["cache_read"], "usage.cache_read"),
    cache_write: asUsageFigure(usage["cache_write"], "usage.cache_write"),
    reasoning: asUsageFigure(usage["reasoning"], "usage.reasoning"),
  };
  const total = usage["total_tokens"];
  if (total !== null && (typeof total !== "number" || !Number.isFinite(total) || total < 0)) {
    throw new LedgerValidationError(
      `usage record field "usage.total_tokens" must be null or a non-negative number`,
    );
  }
  // Totals sum only the figures the provider meters on their own line; an
  // included category is never added on top again.
  let expectedTotal = 0;
  for (const category of TOKEN_CATEGORIES) {
    const usageFigure = figures[category];
    if (usageFigure.included_in !== null) {
      continue;
    }
    if (usageFigure.tokens === null) {
      expectedTotal = Number.NaN;
      break;
    }
    expectedTotal += usageFigure.tokens;
  }
  const totalKnown = !Number.isNaN(expectedTotal);
  if ((total === null) !== !totalKnown) {
    throw new LedgerValidationError(
      `usage record field "usage.total_tokens" disagrees with its category figures`,
    );
  }
  if (totalKnown && total !== expectedTotal) {
    throw new LedgerValidationError(
      `usage record field "usage.total_tokens" double-counts or drops a category figure`,
    );
  }
  const completeness = usage["completeness"];
  if (!["known", "estimated", "unknown"].includes(completeness as string)) {
    throw new LedgerValidationError(
      `usage record field "usage.completeness" must be known, estimated, or unknown`,
    );
  }
  const provenance = usage["provenance"];
  if (!["provider_wire", "transport_reported", "absent"].includes(provenance as string)) {
    throw new LedgerValidationError(`usage record field "usage.provenance" has unknown value`);
  }
  const rawUsage = record["raw_usage"];
  if (rawUsage !== null && (typeof rawUsage !== "object" || Array.isArray(rawUsage))) {
    throw new LedgerValidationError(`usage record field "raw_usage" must be an object or null`);
  }
  return record as unknown as InvocationUsageRecord;
}

/**
 * Upgrade one stored record to the current schema and validate it. There is
 * no older shape yet, so a record that does not claim the current version is
 * refused loudly rather than reinterpreted.
 */
export function migrateInvocationUsageRecord(raw: unknown): InvocationUsageRecord {
  return validateInvocationUsageRecord(raw);
}
