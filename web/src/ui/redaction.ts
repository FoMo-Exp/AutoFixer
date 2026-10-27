const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_VALUE = /\b(?:sk|ghp|github_pat|xoxb|xoxp)[_-][A-Za-z0-9_-]+\b/g;
const ABSOLUTE_PATH = /(^|[\s("'`])\/(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~-]+/g;
const WINDOWS_PATH = /\b[A-Z]:\\[^\s,;"'`]+/g;
const KEY_VALUE_SECRET = /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
const SENSITIVE_KEY =
  /\b(?:command|cmd|argv|stdout|stderr|logs?|output|raw[_-]?(?:log|output)|token|secret|password|api[_-]?key)\b/i;
const SHELL_COMMAND =
  /\b(?:sudo\s+)?(?:bash|sh|zsh|fish|node|npm|npx|pnpm|yarn|go|git|curl|wget|rm|mv|cp|chmod|chown|python3?|make|docker|find|grep|sed|cat|touch|mkdir|tar|ssh|scp)\s+[^\n]+/gi;

export function redactText(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(SECRET_VALUE, "[redacted]")
    .replace(SHELL_COMMAND, "[command redacted]")
    .replace(ABSOLUTE_PATH, "$1[path redacted]")
    .replace(WINDOWS_PATH, "[path redacted]")
    .replace(KEY_VALUE_SECRET, "$1: [redacted]");
}

export function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactText(key),
        SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(entry),
      ]),
    );
  }
  return value;
}
