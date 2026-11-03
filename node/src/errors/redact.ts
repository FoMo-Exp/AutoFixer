/**
 * Secret redaction for every text that crosses the shared error envelope
 * (DAT-226).
 *
 * The envelope only ever carries catalog-authored safe text plus correlation
 * references, so this is defense in depth: anything that still passes through
 * a text field — sealed diagnostics included — is scrubbed of secret-shaped
 * material first. Redaction is intentionally blunt: a redacted placeholder is
 * always safer than a leaked credential, and raw detail never reaches the
 * envelope, the model, or a metric label.
 */

export const REDACTED = "[redacted]";

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const NAMED_SECRET =
  /\b(password|passwd|secret|token|api[_-]?key|credential|authorization)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Scrub secret-shaped material out of one text.
 *
 * `literalSecrets` covers values the caller already knows are secret (a
 * credential looked up from a store, for example); everything else is a
 * pattern. The result is safe to hand to an operator or a model, but it is
 * still diagnostic text and goes through the diagnostics access check rather
 * than the envelope.
 */
export function redactSensitiveText(text: string, literalSecrets: readonly string[] = []): string {
  let out = text;
  for (const literal of literalSecrets) {
    if (typeof literal === "string" && literal.length >= 4) {
      out = out.split(literal).join(REDACTED);
    }
  }
  return out
    .replace(PEM_BLOCK, REDACTED)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(OPENAI_STYLE_KEY, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(SLACK_TOKEN, REDACTED)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(
      NAMED_SECRET,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    );
}
