/**
 * Period, timezone, pagination and percentile helpers for the dashboard.
 *
 * A dashboard period is half-open `[from, to)`. Date breakdowns are bucketed
 * in the requested IANA timezone, so a "day" boundary follows that zone's
 * civil calendar rather than the server's local time; bucket keys are the
 * local wall-clock label (`2026-11-03`, `2026-11-03T14:00`, `2026-W45`, ...),
 * never a silently re-interpreted UTC instant.
 *
 * Cursors are opaque to clients: base64url-encoded offsets over a stable sort
 * order. A malformed cursor is a request error, never "start from the top".
 */

import { ApiError } from "../api/errors.js";

const DAY_MS = 86_400_000;

export function parseInstant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be an RFC 3339 timestamp`);
  }
  return parsed;
}

/** Validate an IANA timezone name by asking ICU to format with it. */
export function requireTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ApiError(400, "INVALID_REQUEST", `unknown timezone ${JSON.stringify(timezone)}`);
  }
  return timezone;
}

/** Half-open `[from, to)`; rejects inverted or over-long ranges. */
export function halfOpenPeriod(
  from: string,
  to: string,
  maxRangeDays: number,
): { from_ms: number; to_ms: number; until_inclusive: string } {
  const fromMs = parseInstant(from, "from");
  const toMs = parseInstant(to, "to");
  if (toMs <= fromMs) {
    throw new ApiError(400, "INVALID_REQUEST", "to must be later than from");
  }
  if (toMs - fromMs > maxRangeDays * DAY_MS) {
    throw new ApiError(
      400,
      "RANGE_TOO_LARGE",
      `the requested range exceeds ${maxRangeDays} days; narrow the period`,
    );
  }
  // The upstream stores filter with inclusive bounds, so subtract one
  // millisecond to keep the contract's upper bound exclusive.
  return { from_ms: fromMs, to_ms: toMs, until_inclusive: new Date(toMs - 1).toISOString() };
}

export function inHalfOpenWindow(
  instant: string,
  window: { from_ms: number; to_ms: number },
): boolean {
  const parsed = Date.parse(instant);
  return !Number.isNaN(parsed) && parsed >= window.from_ms && parsed < window.to_ms;
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
}

function localParts(instant: string, timezone: string): LocalParts | null {
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(parsed))) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  const { year, month, day, hour } = parts;
  if (year === undefined || month === undefined || day === undefined || hour === undefined) {
    return null;
  }
  return { year, month, day, hour };
}

/** Bucket key for `breakdown=date`; null when the instant is unparseable. */
export function dateBucketKey(
  instant: string,
  timezone: string,
  bucket: "hour" | "day" | "week" | "month",
): string | null {
  const parts = localParts(instant, timezone);
  if (parts === null) {
    return null;
  }
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (bucket === "hour") {
    return `${date}T${parts.hour}:00`;
  }
  if (bucket === "day") {
    return date;
  }
  if (bucket === "month") {
    return `${parts.year}-${parts.month}`;
  }
  // Week buckets are the Monday that starts the local civil week.
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const weekday = local.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  local.setUTCDate(local.getUTCDate() - mondayOffset);
  return local.toISOString().slice(0, 10);
}

/** Nearest-rank percentile over an unsorted sample; null for an empty sample. */
export function nearestRank(samples: readonly number[], percentile: number): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function roundRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

/** Encode an offset as an opaque cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

/** Decode an opaque cursor; any malformed value is a 400, never offset 0. */
export function decodeCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "the cursor is not valid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { offset?: unknown }).offset !== "number" ||
    !Number.isInteger((parsed as { offset: number }).offset) ||
    (parsed as { offset: number }).offset < 0
  ) {
    throw new ApiError(400, "INVALID_CURSOR", "the cursor is not valid");
  }
  return (parsed as { offset: number }).offset;
}

/** Slice `[offset, offset+limit)` and report the next cursor. */
export function pageSlice<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { items: T[]; next_cursor: string | null } {
  if (offset > items.length && offset !== 0) {
    throw new ApiError(400, "INVALID_CURSOR", "the cursor points past the result set");
  }
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
  return { items: page, next_cursor: next };
}

/** Default period: the last N hours ending at `now`, rounded to the second. */
export function defaultPeriod(now: Date, hours: number): { from: string; to: string } {
  const to = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Validate a page limit against the endpoint's ceiling. */
export function requireLimit(value: string | null, fallback: number, max: number): number {
  if (value === null) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "limit must be a positive integer");
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) {
    throw new ApiError(400, "LIMIT_OUT_OF_RANGE", `limit must be between 1 and ${max}`);
  }
  return parsed;
}
