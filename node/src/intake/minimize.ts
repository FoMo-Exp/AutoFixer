import { scrubSecrets } from "../gateway/redact.js";
import { normalizeMessage, normalizeStackLocations } from "./fingerprint.js";
import type { CanonicalSeverity } from "./rules.js";

/**
 * Model-input minimization (DAT-216 acceptance: minimize before any model
 * input and route it through the ADR-0005 gateway).
 *
 * The briefing is an allowlist projection of one signal: canonical identity,
 * a scrubbed and truncated message excerpt, and canonical stack frames. Raw
 * provider payloads, labels, credentials, absolute paths, and full messages
 * never enter the projection — anything a model sees comes from here.
 */

export const BRIEFING_MESSAGE_MAX = 160;
export const BRIEFING_STACK_MAX = 3;

/** The complete set of fields a model may ever see about one signal. */
export interface ModelSignalBriefing {
  signal_key: string;
  severity: CanonicalSeverity;
  service: string;
  environment: string;
  error_class: string;
  error_signature: string;
  message_excerpt: string;
  stack_locations: string[];
  occurrences: number;
  rate: { count: number; window_seconds: number };
}

export interface MinimizeInput {
  signal_key: string;
  severity: CanonicalSeverity;
  service: string;
  environment: string;
  error_class: string;
  error_signature: string;
  message: string;
  stack_locations?: string[] | undefined;
  occurrences: number;
  rate: { count: number; window_seconds: number };
}

/**
 * Project one signal down to its model briefing. Only the allowlisted fields
 * are copied; the message is secret-scrubbed first, then normalized and
 * truncated, and stack locations lose their host paths.
 */
export function minimizeSignal(input: MinimizeInput): ModelSignalBriefing {
  const excerpt = normalizeMessage(scrubSecrets(input.message));
  return {
    signal_key: input.signal_key,
    severity: input.severity,
    service: input.service,
    environment: input.environment,
    error_class: input.error_class,
    error_signature: input.error_signature,
    message_excerpt:
      excerpt.length > BRIEFING_MESSAGE_MAX ? excerpt.slice(0, BRIEFING_MESSAGE_MAX) : excerpt,
    stack_locations: normalizeStackLocations(input.stack_locations).slice(0, BRIEFING_STACK_MAX),
    occurrences: input.occurrences,
    rate: { count: input.rate.count, window_seconds: input.rate.window_seconds },
  };
}
