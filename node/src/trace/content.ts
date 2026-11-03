/**
 * Pre-persistence content handling for trace material (DAT-225).
 *
 * Request/response/tool/SDK-error material is scanned and redacted before any
 * ordinary persistence — including model calls that never leave the internal
 * environment: the scan is unconditional and there is no egress-based skip.
 * Detection reuses the shared DAT-209 detector corpus (the scanner seam plus
 * the built-in pattern scanner) and redaction reuses the shared DAT-226 blunt
 * pass, so dispatch-time and persistence-time handling can never drift into
 * two different secret vocabularies.
 *
 * Raw content capture is opt-in and default-off: without it only metadata and
 * non-secret scan evidence are kept, and full content replay is unavailable.
 * Nothing here returns or stores unredacted material — required source
 * material for a security investigation belongs to the ADR-0005 quarantine,
 * which is a separately authorized store (see access.ts).
 */
import { randomUUID } from "node:crypto";

import { REDACTED, redactSensitiveText } from "../errors/redact.js";
import { createPatternSecretScanner } from "../gateway/pattern-scanner.js";
import type { ScannableSegment, SecretScanner, SecretScanReport } from "../gateway/scan.js";
import type { DataClass, SecretClassification } from "../gateway/types.js";

import { TraceValidationError } from "./errors.js";
import type { RetentionConfig } from "./retention.js";
import { parseRetentionConfig } from "./retention.js";
import type { TraceEvent } from "./schema.js";

/** The material kinds that may only persist through this module. */
export const MATERIAL_KINDS = ["prompt", "response", "tool", "sdk_error"] as const;

export type MaterialKind = (typeof MATERIAL_KINDS)[number];

/**
 * Enterprise content-capture policy. Raw capture is opt-in (default off);
 * every capture needs finite retention before it can be enabled at all —
 * there is no silent "retain forever" default (ADR-0008).
 */
export interface ContentCapturePolicy {
  /** Persist redacted material text at all; false keeps metadata only. */
  readonly raw_content_capture: boolean;
  /** Maximum redacted characters kept per material; excess is truncated. */
  readonly max_material_chars: number;
  /** Finite per-class retention for everything this policy enables. */
  readonly retention: RetentionConfig;
}

/**
 * Non-secret scan evidence kept with every captured record: detector
 * identities, rule version, counts, and classification only — never matched
 * material (the DAT-209 evidence rule).
 */
export interface MaterialScanEvidence {
  readonly scanner: string;
  readonly rule_version: string;
  readonly classification: SecretClassification;
  /** Detector identities that fired, sorted; never their matched values. */
  readonly detectors: string[];
  readonly findings: {
    readonly suspected: number;
    readonly confirmed: number;
    readonly unknown: number;
  };
}

export interface CapturedMaterial {
  readonly record_id: string;
  readonly kind: MaterialKind;
  readonly data_classes: DataClass[];
  readonly captured_at: string;
  readonly scan: MaterialScanEvidence;
  /**
   * Redacted material text when raw content capture is enabled; otherwise
   * null — metadata and event continuity remain, full replay does not.
   */
  readonly text: string | null;
  readonly original_chars: number;
  readonly persisted_chars: number;
  readonly redactions: number;
  readonly truncated: boolean;
}

export interface MaterialInput {
  kind: MaterialKind;
  /** Raw material exactly as produced. Never persisted, never returned. */
  text: string;
  /** Content classes this material carries; at least one is required. */
  data_classes: DataClass[];
  /** Values the caller already knows are secret (resolved credentials etc.). */
  literal_secrets?: readonly string[];
}

/** Explicit capture counters; every truncation or drop is visible, never silent. */
export interface CaptureCounters {
  scanned: number;
  redactions: number;
  truncated: number;
  /** Materials whose text was dropped from persistence by policy. */
  dropped: number;
}

/**
 * The scanner seam is allowed to be asynchronous (see DAT-209); the
 * persistence path is synchronous and fails closed instead of storing
 * material the scan could not finish.
 */
export class ContentScanUnavailableError extends Error {
  readonly code = "CONTENT_SCAN_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContentScanUnavailableError";
  }
}

/**
 * Token-shaped evidence identifiers only (same rule as DAT-209 scan
 * evidence): a detector or rule name must never smuggle matched material
 * into persisted evidence.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/;

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

/**
 * Own-property membership in the closed vocabularies, mirroring DAT-209:
 * the `in` operator would let prototype properties like `toString` pass.
 */
const SECRET_CLASS_VOCABULARY: Record<SecretClassification, true> = {
  clean: true,
  secret_suspected: true,
  secret_confirmed: true,
  unknown: true,
};

function isSecretClassification(value: unknown): value is SecretClassification {
  return typeof value === "string" && Object.hasOwn(SECRET_CLASS_VOCABULARY, value);
}

const DATA_CLASS_VOCABULARY: Record<DataClass, true> = {
  system: true,
  user_input: true,
  history: true,
  code: true,
  logs: true,
  diffs: true,
  tool_results: true,
  derived_summaries: true,
};

function assertMaterialInput(input: MaterialInput): void {
  if (
    typeof input.kind !== "string" ||
    !(MATERIAL_KINDS as readonly string[]).includes(input.kind)
  ) {
    throw new TraceValidationError(`material kind ${JSON.stringify(input.kind)} is not recognized`);
  }
  if (typeof input.text !== "string") {
    throw new TraceValidationError("material text must be a string");
  }
  if (!Array.isArray(input.data_classes) || input.data_classes.length === 0) {
    throw new TraceValidationError("material must declare at least one data class");
  }
  for (const dataClass of input.data_classes) {
    if (typeof dataClass !== "string" || !Object.hasOwn(DATA_CLASS_VOCABULARY, dataClass)) {
      throw new TraceValidationError(
        `material data class ${JSON.stringify(dataClass)} is not recognized`,
      );
    }
  }
  if (input.literal_secrets !== undefined && !Array.isArray(input.literal_secrets)) {
    throw new TraceValidationError("material literal_secrets must be an array of strings");
  }
}

/**
 * Validate one scanner report read as untyped data. The persistence path
 * treats a missing, malformed, or unsafe report exactly like an unavailable
 * scanner: material is never stored on the strength of a report the gate
 * cannot trust. Detector and rule names are evidence and must stay
 * token-shaped so they can never smuggle matched material into a record.
 */
export interface ValidatedFinding {
  detector: string;
  rule_version: string;
  classification: "secret_suspected" | "secret_confirmed" | "unknown";
  match?: string;
}

function readScanReport(raw: unknown): {
  scanner: string;
  rule_version: string;
  classification: SecretClassification;
  findings: ValidatedFinding[];
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContentScanUnavailableError("the secret scanner returned no report");
  }
  const report = raw as Record<string, unknown>;
  const scanner = report["scanner"];
  const ruleVersion = report["ruleVersion"];
  if (!isSafeIdentifier(scanner) || !isSafeIdentifier(ruleVersion)) {
    throw new ContentScanUnavailableError(
      "the secret scanner report has unsafe scanner or rule identities",
    );
  }
  const classification = report["classification"];
  if (!isSecretClassification(classification)) {
    throw new ContentScanUnavailableError(
      "the secret scanner report has an unknown classification",
    );
  }
  const rawFindings = report["findings"];
  if (!Array.isArray(rawFindings)) {
    throw new ContentScanUnavailableError("the secret scanner report has no findings array");
  }
  const findings: ValidatedFinding[] = [];
  for (const rawFinding of rawFindings) {
    if (rawFinding === null || typeof rawFinding !== "object" || Array.isArray(rawFinding)) {
      throw new ContentScanUnavailableError(
        "the secret scanner report contains an invalid finding",
      );
    }
    const finding = rawFinding as Record<string, unknown>;
    const findingClass = finding["classification"];
    const detector = finding["detector"];
    const findingRule = finding["ruleVersion"];
    const match = finding["match"];
    if (
      !isSafeIdentifier(detector) ||
      !isSafeIdentifier(findingRule) ||
      !isSecretClassification(findingClass) ||
      findingClass === "clean" ||
      typeof finding["segmentId"] !== "string" ||
      (match !== undefined && typeof match !== "string")
    ) {
      throw new ContentScanUnavailableError(
        "the secret scanner report contains an invalid finding",
      );
    }
    findings.push({
      detector,
      rule_version: findingRule,
      classification: findingClass,
      match,
    });
  }
  return { scanner, rule_version: ruleVersion, classification, findings };
}

export interface MaterialScanResult {
  classification: SecretClassification;
  findings: readonly ValidatedFinding[];
  evidence: MaterialScanEvidence;
}

/** Run one scan synchronously; an async or failing scanner fails closed. */
export function scanMaterial(
  text: string,
  dataClasses: readonly DataClass[],
  scanner: SecretScanner,
): MaterialScanResult {
  const segment: ScannableSegment = {
    id: "material",
    path: ["material"],
    text,
    dataClasses: [...dataClasses],
  };
  let report: SecretScanReport | Promise<SecretScanReport>;
  try {
    report = scanner.scan({ segments: [segment] });
  } catch (error) {
    throw new ContentScanUnavailableError("the secret scanner failed on this material", {
      cause: error,
    });
  }
  if (report instanceof Promise) {
    throw new ContentScanUnavailableError(
      "the secret scanner is asynchronous; the persistence path needs a synchronous scanner",
    );
  }
  const validated = readScanReport(report);
  const counts = { suspected: 0, confirmed: 0, unknown: 0 };
  const detectors = new Set<string>();
  for (const finding of validated.findings) {
    if (finding.classification === "secret_suspected") counts.suspected += 1;
    else if (finding.classification === "secret_confirmed") counts.confirmed += 1;
    else counts.unknown += 1;
    detectors.add(finding.detector);
  }
  return {
    classification: validated.classification,
    findings: validated.findings,
    evidence: {
      scanner: validated.scanner,
      rule_version: validated.rule_version,
      classification: validated.classification,
      detectors: [...detectors].sort(),
      findings: counts,
    },
  };
}

/**
 * Replace every scanner-matched span with the shared placeholder. Detector
 * findings carry the exact matched material precisely so it can be removed
 * before persistence; the placeholder is the only thing that survives.
 */
function redactFindings(text: string, findings: readonly ValidatedFinding[]): string {
  let out = text;
  for (const finding of findings) {
    const match = finding.match;
    if (match === undefined || match.length === 0) {
      continue;
    }
    out = out.split(match).join(REDACTED);
  }
  return out;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Placeholder insertions made across all redaction passes. */
function redactionCount(before: string, after: string): number {
  return countOccurrences(after, REDACTED) - countOccurrences(before, REDACTED);
}

export interface RedactionOptions {
  /** Detector-based scanner; defaults to the shared built-in pattern scanner. */
  scanner?: SecretScanner;
  /** Values the caller already knows are secret. */
  literal_secrets?: readonly string[];
}

export interface RedactedText {
  text: string;
  classification: SecretClassification;
  /** Detector identities that fired, sorted; never their matched values. */
  detectors: string[];
  redactions: number;
}

const DEFAULT_SCANNER: SecretScanner = createPatternSecretScanner();

/**
 * Scan and redact one text: detector matches first, then the shared blunt
 * pattern pass, then caller-known literal secrets. The result is safe to
 * persist; the input never is.
 */
export function redactMaterial(text: string, options: RedactionOptions = {}): RedactedText {
  const scanner = options.scanner ?? DEFAULT_SCANNER;
  const { classification, findings, evidence } = scanMaterial(text, [], scanner);
  const redacted = redactSensitiveText(
    redactFindings(text, findings),
    options.literal_secrets ?? [],
  );
  return {
    text: redacted,
    classification,
    detectors: evidence.detectors,
    redactions: redactionCount(text, redacted),
  };
}

/**
 * Deep redaction of a JSON-safe value: every string leaf is scanned and
 * redacted with the same core as material capture. Used before export so an
 * export can never become a second leak surface. Object keys are schema
 * field names and are left alone; values are not.
 */
export function redactContentStrings(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") {
    return redactMaterial(value, options).text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactContentStrings(entry, options));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactContentStrings(entry, options);
    }
    return out;
  }
  return value;
}

/**
 * Enforce the content policy on one event at the ordinary-persistence
 * boundary: every free-form text container (`payload` strings, label values)
 * is scanned and redacted before the event is stored. Identity and
 * correlation fields are not material and stay intact. The trace store
 * applies this at `append`; material text itself only persists through
 * {@link ContentCapture}, under the raw-capture opt-in.
 */
export function redactEventContent(event: TraceEvent): TraceEvent {
  return {
    ...event,
    // The walk preserves keys and non-string values; only text is scanned.
    labels: redactContentStrings(event.labels) as Record<string, string>,
    payload:
      event.payload === null
        ? null
        : (redactContentStrings(event.payload) as Record<string, unknown>),
  };
}

/**
 * Fail-closed parse of the enterprise content-capture policy. Raw capture is
 * the only defaulted field (off); the character bound and the finite
 * retention values are required before any capture is enabled.
 */
export function parseContentCapturePolicy(value: unknown): ContentCapturePolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TraceValidationError("content capture policy must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const rawCapture = record["raw_content_capture"] ?? false;
  if (typeof rawCapture !== "boolean") {
    throw new TraceValidationError("content capture policy raw_content_capture must be a boolean");
  }
  const maxChars = record["max_material_chars"];
  if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 1) {
    throw new TraceValidationError(
      "content capture policy max_material_chars must be a positive integer",
    );
  }
  return {
    raw_content_capture: rawCapture,
    max_material_chars: maxChars,
    retention: parseRetentionConfig(record["retention"]),
  };
}

/**
 * The single gate through which request/response/tool/SDK-error material may
 * reach ordinary persistence. It scans unconditionally — including material
 * from internal model calls — redacts, truncates at the configured bound, and
 * applies the raw-capture opt-in before anything is kept.
 */
export class ContentCapture {
  private readonly policy: ContentCapturePolicy;
  private readonly scanner: SecretScanner;
  private readonly now: () => Date;
  private readonly counts = { scanned: 0, redactions: 0, truncated: 0, dropped: 0 };

  constructor(options: {
    policy: ContentCapturePolicy;
    /** Detector-based scanner; defaults to the shared built-in pattern scanner. */
    scanner?: SecretScanner;
    now?: () => Date;
  }) {
    // Re-parse so a hand-built policy object cannot bypass validation.
    this.policy = parseContentCapturePolicy({
      raw_content_capture: options.policy.raw_content_capture,
      max_material_chars: options.policy.max_material_chars,
      retention: options.policy.retention,
    });
    this.scanner = options.scanner ?? DEFAULT_SCANNER;
    this.now = options.now ?? (() => new Date());
  }

  capture(input: MaterialInput): CapturedMaterial {
    assertMaterialInput(input);
    const { findings, evidence } = scanMaterial(input.text, input.data_classes, this.scanner);
    const redacted = redactSensitiveText(
      redactFindings(input.text, findings),
      input.literal_secrets ?? [],
    );
    const redactions = redactionCount(input.text, redacted);

    let text: string | null = redacted;
    let truncated = false;
    if (redacted.length > this.policy.max_material_chars) {
      text = redacted.slice(0, this.policy.max_material_chars);
      truncated = true;
      this.counts.truncated += 1;
    }
    if (!this.policy.raw_content_capture) {
      text = null;
      this.counts.dropped += 1;
    }

    this.counts.scanned += 1;
    this.counts.redactions += redactions;

    return {
      record_id: randomUUID(),
      kind: input.kind,
      data_classes: [...input.data_classes],
      captured_at: this.now().toISOString(),
      scan: evidence,
      text,
      original_chars: input.text.length,
      persisted_chars: text === null ? 0 : text.length,
      redactions,
      truncated,
    };
  }

  counters(): CaptureCounters {
    return { ...this.counts };
  }
}
