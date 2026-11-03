import { createHash } from "node:crypto";

/**
 * Versioned signal fingerprint and error signature (DAT-216).
 *
 * Deduplication is layered: the provider event id deduplicates individual
 * alert deliveries, while the fingerprint here identifies the incident a
 * repeated alert belongs to. The fingerprint is a versioned hash over the
 * canonical identity fields the deterministic rules select (service,
 * environment, error signature) — never over raw message values, so replayed
 * or slightly reworded alerts of one incident always land on one issue.
 *
 * The version prefix is part of every emitted key: a future normalization
 * change bumps the version and both generations of keys can coexist in the
 * dedup index instead of silently reinterpreting history.
 */

export const SIGNAL_FINGERPRINT_VERSION = 1;

const SIGNATURE_MESSAGE_MAX = 200;

const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const UUID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_PATTERN = /\b[0-9a-fA-F]{8,}\b/g;
const INTEGER_PATTERN = /\d+/g;

/** Provider-shaped error information as carried by an intake event. */
export interface ErrorShape {
  class?: string | undefined;
  message: string;
  stack_locations?: string[] | undefined;
}

/**
 * Canonical identity fields of one incident signal. Deliberately excludes
 * per-arrival noise (raw message, severity, timestamps, counts): two alerts
 * about the same incident at the same service in the same environment carry
 * the same identity, so they collapse onto one issue. The enterprise and
 * workspace scope are part of the identity: incidents never cross tenant
 * boundaries, so two workspaces seeing the same error map to different
 * signals and never share evidence or issues.
 */
export interface SignalIdentity {
  enterprise_id: string;
  workspace_id: string;
  service: string;
  environment: string;
  error_signature: string;
}

/**
 * Normalize a raw message into its stable identity shape: volatile tokens
 * (timestamps, uuids, hex ids, numbers, paths/urls) become placeholders, the
 * text is lowercased and whitespace-collapsed, and the result is truncated.
 */
export function normalizeMessage(message: string): string {
  const masked = message
    .replace(TIMESTAMP_PATTERN, "<ts>")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(HEX_PATTERN, "<hex>");
  const tokens = masked
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) =>
      token.includes("/") || token.includes("\\")
        ? "<path>"
        : token.replace(INTEGER_PATTERN, "<n>"),
    );
  const normalized = tokens.join(" ").toLowerCase();
  return normalized.length > SIGNATURE_MESSAGE_MAX
    ? normalized.slice(0, SIGNATURE_MESSAGE_MAX)
    : normalized;
}

/**
 * Canonical error class: the provider-declared class wins, then a
 * `FooError:` style message prefix, then the explicit `unknown` marker —
 * never an invented class.
 */
export function normalizeErrorClass(error: ErrorShape): string {
  const declared = error.class?.trim();
  if (declared !== undefined && declared.length > 0) {
    return declared;
  }
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception|Fault))\s*:/.exec(error.message);
  return match?.[1] ?? "unknown";
}

function fileBase(location: string): string {
  const tail = location.trim().split(/[/\\]/).pop() ?? location.trim();
  return tail.replace(/:\d+(?::\d+)?$/, "");
}

function normalizeStackLocation(location: string): string {
  const inSplit = /\s+in\s+/.exec(location);
  if (inSplit) {
    const parts = location.split(/\s+in\s+/);
    const file = fileBase(parts[0] ?? "");
    const fn = (parts[1] ?? "").trim().split(/\s+/)[0] ?? "";
    return fn.length > 0 ? `${file}:${fn}` : file;
  }
  const parenMatch = /^(\S+)\s+\((.+)\)$/.exec(location.trim());
  if (parenMatch) {
    const fn = parenMatch[1] ?? "";
    const file = fileBase(parenMatch[2] ?? "");
    return fn.length > 0 ? `${file}:${fn}` : file;
  }
  return fileBase(location);
}

/**
 * Canonical `file:function` frames, top three only. Absolute paths are
 * reduced to the file base so the signature carries no host layout.
 */
export function normalizeStackLocations(locations: readonly string[] | undefined): string[] {
  if (locations === undefined) {
    return [];
  }
  return locations.slice(0, 3).map(normalizeStackLocation);
}

/**
 * The error signature: canonical class, normalized message, and top frames.
 * Pure and deterministic — the same incident always yields the same string.
 */
export function errorSignature(error: ErrorShape): string {
  return [
    normalizeErrorClass(error),
    normalizeMessage(error.message),
    normalizeStackLocations(error.stack_locations).join("+"),
  ].join(" | ");
}

/** Versioned fingerprint over the canonical identity fields. */
/**
 * Versioned fingerprint over the canonical identity fields, scoped to the
 * owning enterprise/workspace. The workspace scope is hashed in, so dedup
 * keys and signal storage are workspace-scoped by construction.
 */
export function signalFingerprint(identity: SignalIdentity): string {
  const canonical = JSON.stringify({
    enterprise_id: identity.enterprise_id,
    error_signature: identity.error_signature,
    environment: identity.environment,
    service: identity.service,
    workspace_id: identity.workspace_id,
  });
  return `fp${SIGNAL_FINGERPRINT_VERSION}:${createHash("sha256").update(canonical).digest("hex")}`;
}
