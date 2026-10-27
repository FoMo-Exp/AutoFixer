const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_VALUE = /\b(?:sk|ghp|github_pat|xoxb|xoxp)[_-][A-Za-z0-9_-]+\b/g;
const ABSOLUTE_PATH =
  /(?:\/(?:Users|home|private|var|tmp|opt|workspace|workspaces)\/[^\s,;"'`]+)/gi;
const WINDOWS_PATH = /\b[A-Z]:\\[^\s,;"'`]+/g;
const KEY_VALUE_SECRET = /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;

export function redactText(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(SECRET_VALUE, "[redacted]")
    .replace(ABSOLUTE_PATH, "[path redacted]")
    .replace(WINDOWS_PATH, "[path redacted]")
    .replace(KEY_VALUE_SECRET, "$1: [redacted]");
}

export function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactText(key), sanitizeValue(entry)]),
    );
  }
  return value;
}
