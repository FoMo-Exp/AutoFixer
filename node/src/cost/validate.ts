/**
 * Shared runtime validators for cost-domain records (DAT-228), following the
 * `trace/schema.ts` convention: one canonical record guard in this module's
 * validation layer plus `as*` field validators consumed at parse boundaries.
 *
 * Records arrive from JSONL loads and from callers; both paths get the same
 * runtime checks, so every record type refuses the same malformed input the
 * same way. A missing or malformed field is a control failure, never a
 * defaulted value.
 */
import { CostValidationError } from "./errors.js";

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Canonical guard of the cost validation layer; parse functions call it at the boundary. */
export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CostValidationError(`cost ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CostValidationError(`cost field "${field}" must be a non-empty string`);
  }
  return value;
}

export function asNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return asNonEmptyString(value, field);
}

export function asTimestamp(value: unknown, field: string): string {
  const text = asNonEmptyString(value, field);
  if (!TIMESTAMP_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new CostValidationError(`cost field "${field}" must be an RFC 3339 timestamp`);
  }
  return text;
}

export function asCurrency(value: unknown, field: string): string {
  const text = asNonEmptyString(value, field);
  if (!CURRENCY_PATTERN.test(text)) {
    throw new CostValidationError(`cost field "${field}" must be an ISO 4217 alphabetic code`);
  }
  return text;
}

export function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CostValidationError(`cost field "${field}" must be an integer starting at 1`);
  }
  return value;
}

/** Non-negative safe integer: token counts, chargeable units. */
export function asUnitCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CostValidationError(`cost field "${field}" must be a non-negative safe integer`);
  }
  return value;
}

export function asOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new CostValidationError(
      `cost field "${field}" must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`,
    );
  }
  return value as T;
}
