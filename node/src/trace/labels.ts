import { TraceValidationError } from "./errors.js";
import type { TraceEvent } from "./schema.js";

export { TraceValidationError } from "./errors.js";

/**
 * Metric label vocabulary for trace events (DAT-224).
 *
 * Labels are the only part of an event a metric may read, so the keys are a
 * closed, low-cardinality allowlist. Payloads, file contents, credentials,
 * and raw error text stay in `payload` (or in ADR-0005 quarantine) and are
 * never promoted to a label; a metric label must not become a side channel
 * for exactly the material the trace viewer is not allowed to show.
 */
export const METRIC_LABEL_KEYS = [
  "status",
  "outcome",
  "reason_code",
  "queue",
  "phase",
  "provider",
  "model",
] as const;

/** Every dimension an aggregate or metric may group by. */
export const METRIC_DIMENSION_KEYS: readonly string[] = [
  "source",
  "kind",
  "record_class",
  ...METRIC_LABEL_KEYS,
];

/** Bounds label values so free-form error text cannot ride along as a label. */
export const MAX_METRIC_LABEL_VALUE_LENGTH = 96;

/** Printable ASCII only: no newlines, control characters, or hidden content. */
const LABEL_VALUE_PATTERN = /^[\x20-\x7E]+$/;

export function validateMetricLabels(labels: unknown): void {
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
    throw new TraceValidationError("trace event labels must be a plain object");
  }
  for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
    if (!METRIC_LABEL_KEYS.includes(key as (typeof METRIC_LABEL_KEYS)[number])) {
      throw new TraceValidationError(
        `metric label key "${key}" is outside the metric vocabulary; ` +
          "payload, content, credentials, and error text stay out of labels",
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new TraceValidationError(`metric label "${key}" must be a non-empty string`);
    }
    if (value.length > MAX_METRIC_LABEL_VALUE_LENGTH) {
      throw new TraceValidationError(
        `metric label "${key}" exceeds ${MAX_METRIC_LABEL_VALUE_LENGTH} characters`,
      );
    }
    if (!LABEL_VALUE_PATTERN.test(value)) {
      throw new TraceValidationError(`metric label "${key}" must contain printable ASCII only`);
    }
  }
}

/**
 * The metric-safe view of one event: identity fields plus validated labels.
 * `payload` is never read here, so payload material cannot reach a metric.
 */
export function metricLabelsFor(event: TraceEvent): Record<string, string> {
  validateMetricLabels(event.labels);
  return {
    source: event.source,
    kind: event.kind,
    record_class: event.record_class,
    ...event.labels,
  };
}
