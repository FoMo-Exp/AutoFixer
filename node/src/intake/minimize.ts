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
/** Bound for every other raw-derived briefing field. */
export const BRIEFING_FIELD_MAX = 200;

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
 * are copied. Every field derived from raw provider input — service,
 * environment, error class, error signature, message excerpt, and stack
 * frames — is uniformly secret-scrubbed, normalized where a canonical form
 * exists, and length-bounded before it enters the briefing, so credential
 * material can never ride out through a signature or a frame name.
 */
export function minimizeSignal(input: MinimizeInput): ModelSignalBriefing {
  return {
    signal_key: input.signal_key,
    severity: input.severity,
    service: safe(input.service),
    environment: safe(input.environment),
    error_class: safe(input.error_class),
    error_signature: safe(input.error_signature),
    message_excerpt: safe(normalizeMessage(scrubSecrets(input.message)), BRIEFING_MESSAGE_MAX),
    stack_locations: normalizeStackLocations(input.stack_locations)
      .map((frame) => safe(frame))
      .slice(0, BRIEFING_STACK_MAX),
    occurrences: input.occurrences,
    rate: { count: input.rate.count, window_seconds: input.rate.window_seconds },
  };
}

/** Scrub credential-shaped material and bound the field's length. */
function safe(value: string, max: number = BRIEFING_FIELD_MAX): string {
  const scrubbed = scrubSecrets(value);
  return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
}
