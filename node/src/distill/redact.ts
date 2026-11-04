/**
 * Secret scanning, PII minimization, and sensitivity classification (DAT-233).
 *
 * Everything the write path persists or sends to a model passes through here
 * first. Credential-shaped material is scrubbed (same blunt defense as the
 * gateway and the error envelope), personal data is minimized to placeholders,
 * and the result is scanned again: anything that still looks like a secret or
 * personal data fails closed instead of entering a memory item. Sensitivity is
 * classified from what was found, so a redacted item stays constrained in
 * retrieval, export, and retention.
 */

import { ValidationError } from "../control-plane/errors.js";
import { scrubSecrets } from "../gateway/redact.js";
import type { MemorySensitivity } from "../memory/index.js";
import type { RedactionKind, RedactionReport } from "./types.js";

export const REDACTED_PLACEHOLDER = "[redacted]";
export const EMAIL_PLACEHOLDER = "[email]";
export const PHONE_PLACEHOLDER = "[phone]";
export const CARD_PLACEHOLDER = "[payment_card]";
export const USER_PATH_PLACEHOLDER = "[user_path]";

/** Bounded snippet length for reported matches. */
const SNIPPET_MAX = 40;

// PII minimization patterns. Placeholders are chosen so the patterns can
// never re-match their own output (no `@`, digits, or path separators left).
const PII_PATTERNS: Array<{ kind: RedactionKind; pattern: RegExp; placeholder: string }> = [
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: EMAIL_PLACEHOLDER,
  },
  {
    kind: "phone",
    pattern: /\+\d{6,15}\b|\b\d{3}[.\s-]\d{3}[.\s-]\d{4}\b/g,
    placeholder: PHONE_PLACEHOLDER,
  },
  {
    kind: "payment_card",
    pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g,
    placeholder: CARD_PLACEHOLDER,
  },
  {
    kind: "user_path",
    pattern: /(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"'<>]+/g,
    placeholder: USER_PATH_PLACEHOLDER,
  },
];

/**
 * Detect secret- and PII-shaped material in `text` without changing it.
 * Detection is blunt by design: a false positive costs a dropped candidate,
 * a false negative costs a leak.
 */
export function detectSecretOrPii(text: string): RedactionKind[] {
  const kinds: RedactionKind[] = [];
  // The scrubber is idempotent on already-redacted text ("token=[redacted]"
  // scrubs to itself), so "the scrubber would change something" is a precise
  // secret-shape detector with no placeholder false positives.
  if (scrubSecrets(text) !== text) {
    kinds.push("secret");
  }
  const scrubbed = scrubSecrets(text);
  for (const { kind, pattern } of PII_PATTERNS) {
    // `String.match` resets a global regex's lastIndex, so repeated detection
    // stays stateless.
    if (scrubbed.match(pattern) !== null) {
      kinds.push(kind);
    }
  }
  return [...new Set(kinds)];
}

/**
 * Minimize `text`: scrub credential-shaped material, replace personal data
 * with placeholders, and report what was found. The returned text is safe to
 * persist as memory content or send to a model.
 */
export function redactText(text: string): RedactionReport {
  const kinds = detectSecretOrPii(text);
  let out = scrubSecrets(text);
  for (const { pattern, placeholder } of PII_PATTERNS) {
    out = out.replace(pattern, placeholder);
  }
  return { text: out, kinds };
}

/** Classify sensitivity from the material found in the raw text. */
export function sensitivityFor(kinds: readonly RedactionKind[]): MemorySensitivity {
  if (kinds.includes("secret")) {
    return "restricted";
  }
  if (kinds.length > 0) {
    return "confidential";
  }
  return "internal";
}

/**
 * Fail closed unless `text` is clean of secrets and personal data. Used as the
 * last gate before persistence: an item never carries raw credential or
 * personal material, even if an upstream minimization step missed something.
 */
export function assertNoSecretOrPii(text: string, field: string): void {
  const kinds = detectSecretOrPii(text);
  if (kinds.length > 0) {
    throw new ValidationError(
      `memory ${field} must not carry secret or personal material (${kinds.join(", ")})`,
    );
  }
}

/** Bounded snippet of a match for diagnostics; never persisted. */
export function snippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}
