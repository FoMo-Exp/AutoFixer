/**
 * Redaction helpers for the gateway's outward-facing text.
 *
 * Provider credentials must never appear in errors, logs, audit events, or
 * anything a renderer can observe. Two defenses: exact-value scrubbing of the
 * credentials the gateway actually resolved for the attempt, plus generic
 * credential-shaped pattern scrubbing for values the gateway never knew.
 */

const REDACTED = "[redacted]";

const CREDENTIAL_PATTERNS: RegExp[] = [
  // Authorization header material.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // Common provider key shapes (sk-..., AIza..., ghp_...).
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  // key=value shapes where the key names a credential.
  /\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("?)[^\s"']{4,}\2/g,
];

/** Replace credential-shaped material and known secret values in `text`. */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let result = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, (match, name?: string) =>
      // Keep the variable name visible for debugging; drop only the value.
      typeof name === "string" && name.length > 0 ? `${name}=${REDACTED}` : REDACTED,
    );
  }
  for (const secret of secrets) {
    if (!secret) continue;
    // Short values are scrubbed case-sensitively and only when they are long
    // enough to be a real credential; empty strings are ignored above.
    if (secret.length < 4) continue;
    result = result.split(secret).join(REDACTED);
  }
  return result;
}
