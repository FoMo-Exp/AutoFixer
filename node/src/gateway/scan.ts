/**
 * Complete-request secret detection, classification, minimization, and the
 * fail-closed scan gate (DAT-209, ADR-0005 §1 and §5).
 *
 * The gate runs before every dispatch attempt — retries, model switches, and
 * fallbacks included — over the entire request: system prompt, tool
 * definitions, user input, history, code, logs, diffs, tool results, and
 * derived summaries. Uncertain secret removal sends zero request bytes:
 * suspected or confirmed secret material blocks the invocation unless a
 * separately authorized deterministic minimization policy removes exactly the
 * detected material and a full re-scan of the minimized request comes back
 * clean. Scanner failure, unknown classification, missing authorization, and a
 * missing or failing required audit sink block just the same.
 */

import type { Context } from "@mariozechner/pi-ai";

import { scrubSecrets } from "./redact.js";
import type { DataClass, RequestScanEvidence, SecretClassification } from "./types.js";

const REDACTED = "[redacted]";

/**
 * Safe identifier format for anything a scanner or policy report may name and
 * the gate may record in audit evidence (detector ids, rule versions, scanner
 * ids, policy ids). Pluggable scanners and request-carried provenance are
 * untrusted text sources: identifiers must be token-shaped, deny details never
 * contain them at all, so request content can never ride them into
 * user-visible errors, logs, or the audit/analytics stream.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{1,64}$/;

function isSafeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_IDENTIFIER.test(value) &&
    // Reject credential-shaped identifiers outright: a value the scrubber
    // would redact is a credential whatever it calls itself.
    scrubSecrets(value) === value &&
    // The scanner's own high-entropy shape (long base64-ish run with high
    // Shannon entropy) is credential-shaped whatever it calls itself.
    !(/^[A-Za-z0-9+/=]{28,}$/.test(value) && shannonEntropy(value) >= 4.0)
  );
}

const SEVERITY: Record<SecretClassification, number> = {
  clean: 0,
  secret_suspected: 1,
  secret_confirmed: 2,
  unknown: 3,
};

/**
 * Own-property membership in the closed classification vocabulary. The `in`
 * operator is unsafe here: prototype properties like `toString` or
 * `constructor` would pass it and poison severity comparisons.
 */
function isSecretClassification(value: unknown): value is SecretClassification {
  return typeof value === "string" && Object.hasOwn(SEVERITY, value);
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * Join classifications by worst case; `unknown` is the fail-closed maximum.
 * Anything outside the closed vocabulary — a malformed report, a prototype
 * property — joins to `unknown`, never to `clean`.
 */
export function joinClassification(
  left: SecretClassification,
  right: SecretClassification,
): SecretClassification {
  if (!isSecretClassification(left) || !isSecretClassification(right)) return "unknown";
  return SEVERITY[left] >= SEVERITY[right] ? left : right;
}

function joinAll(classifications: Iterable<SecretClassification>): SecretClassification {
  let joined: SecretClassification = "clean";
  for (const classification of classifications) {
    joined = joinClassification(joined, classification);
  }
  return joined;
}

/** Stable, content-free identity for one request text leaf. */
export function segmentId(path: readonly (string | number)[]): string {
  let id = "";
  for (const key of path) {
    if (typeof key === "number") {
      id += `[${key}]`;
    } else {
      id += id.length === 0 ? key : `.${key}`;
    }
  }
  return id.length > 0 ? id : "(root)";
}

/** A deterministic policy reference as declared by a derivation producer. */
export interface DeterministicPolicyRef {
  id: string;
  version: string;
}

/**
 * Declared provenance of a derived request segment (e.g. a context
 * compaction summary). The producer is service-side derivation code; the gate
 * joins the declared source classifications so a derived summary can never be
 * cleaner than the content it was derived from, unless a separately
 * authorized deterministic policy changed the classification.
 */
export interface DerivedProvenance {
  /**
   * Classification of the derivation sources as recorded by the derivation
   * pipeline. Missing or empty means the classification cannot be
   * established and the segment classifies as `unknown`.
   */
  sourceClassifications: SecretClassification[];
  /** Source references for audit correlation; ids only, never content. */
  sourceRefs?: string[];
  /** The deterministic policy that derived this text. */
  classificationPolicy?: DeterministicPolicyRef;
}

/**
 * Service-side authorization for one deterministic minimization (secret
 * removal) policy. `authorized` is a deployment decision, never something a
 * request can assert about itself; `appliesTo` bounds what it may touch.
 */
export interface MinimizationPolicy {
  id: string;
  version: string;
  authorized: boolean;
  appliesTo: {
    /** Detectors whose findings this policy may remove. */
    detectors: string[];
    /** Data classes this policy may touch; unset means none. */
    dataClasses?: DataClass[];
  };
}

/**
 * Service-side authorization for one deterministic derived-classification
 * policy. A derived summary keeps its source classification unless the
 * declared derivation policy matches this record and it is authorized.
 */
export interface DerivedClassificationPolicy {
  id: string;
  version: string;
  authorized: boolean;
}

/** Separately authorized deterministic policies governing the scan gate. */
export interface SecretScanPolicy {
  minimization?: MinimizationPolicy;
  derivedClassification?: DerivedClassificationPolicy;
}

/** One text leaf of the complete model request. */
export interface ScannableSegment {
  id: string;
  /** Location of the leaf inside the request; structure only, no content. */
  path: (string | number)[];
  text: string;
  /** Structural and content-derived data classes this leaf carries. */
  dataClasses: DataClass[];
  /** True for binary leaves (e.g. image data); entropy rules do not apply. */
  binary?: boolean;
  /** Declared provenance when this leaf is derived from other content. */
  derived?: DerivedProvenance;
}

export interface SecretScanRequest {
  segments: ScannableSegment[];
}

export interface SecretFinding {
  classification: "secret_suspected" | "secret_confirmed" | "unknown";
  /**
   * Detector identity (audit only). Must be token-shaped
   * (`[A-Za-z0-9._-]{1,64}`); anything else invalidates the report. Never the
   * matched value — deny details contain no scanner-provided text at all.
   */
  detector: string;
  /** Rule version; token-shaped like `detector`. */
  ruleVersion: string;
  segmentId: string;
  /**
   * Exact matched material, required for deterministic removal. Internal to
   * the gate: it never reaches audit events, errors, logs, or analytics.
   */
  match?: string;
}

export interface SecretScanReport {
  scanner: string;
  ruleVersion: string;
  classification: SecretClassification;
  findings: SecretFinding[];
}

/**
 * Scanner adapter seam. A deployment wires its detector backend here; the
 * gateway fails closed when `scan` throws, hangs, or returns anything the
 * gate cannot validate. Reports must cover every segment of the request.
 */
export interface SecretScanner {
  /** Token-shaped identity (`[A-Za-z0-9._-]{1,64}`); unsafe identities fail closed. */
  readonly id: string;
  /** Token-shaped rule version. */
  readonly ruleVersion: string;
  scan(request: SecretScanRequest): SecretScanReport | Promise<SecretScanReport>;
}

/** A collected request: the exact dispatch copy plus its scanned segments. */
export interface CollectedRequest {
  /**
   * Deep copy of the request context. The gate may minimize it in place; the
   * adapter receives this copy and never adds unchecked content after scan.
   */
  context: Context;
  segments: ScannableSegment[];
}

export type ScanDenyReason =
  | "SCANNER_UNAVAILABLE"
  | "SENSITIVE_DATA_UNCERTAIN"
  | "CLASSIFICATION_UNKNOWN"
  | "AUTHORIZATION_MISSING";

export interface ScanGateDeps {
  scanner?: SecretScanner;
  scanPolicy?: SecretScanPolicy;
  scanTimeoutMs?: number;
}

export type ScanGateResult =
  | { ok: true; context: Context; evidence: RequestScanEvidence }
  | { ok: false; reason: ScanDenyReason; detail: string; evidence: RequestScanEvidence };

const DEFAULT_SCAN_TIMEOUT_MS = 10_000;

/**
 * Attach derivation provenance to a message produced by service-side
 * derivation (context compaction, summarization). The provenance travels with
 * the request so the gate can enforce classification inheritance on it.
 */
export function tagDerivedSummary<M extends object>(
  message: M,
  provenance: DerivedProvenance,
): M & { derived: DerivedProvenance } {
  return { ...message, derived: provenance };
}

function isDerivedProvenance(value: unknown): value is DerivedProvenance {
  return typeof value === "object" && value !== null;
}

/**
 * Normalize request-carried derivation provenance at the collection seam.
 * Source classifications outside the closed vocabulary become `unknown` (the
 * fail-closed value) and policy references that are not token-shaped are
 * dropped: untrusted text can never reach audit evidence or error details.
 */
function normalizeDerivedProvenance(raw: unknown): DerivedProvenance {
  if (
    !isDerivedProvenance(raw) ||
    !Array.isArray((raw as DerivedProvenance).sourceClassifications)
  ) {
    return { sourceClassifications: [] };
  }
  const provenance = raw as DerivedProvenance;
  const { classificationPolicy, sourceRefs, ...rest } = provenance;
  const sourceClassifications = provenance.sourceClassifications.map(
    (classification): SecretClassification =>
      isSecretClassification(classification) ? classification : "unknown",
  );
  const policyRef =
    classificationPolicy !== undefined &&
    isSafeIdentifier(classificationPolicy.id) &&
    isSafeIdentifier(classificationPolicy.version)
      ? { id: classificationPolicy.id, version: classificationPolicy.version }
      : undefined;
  return {
    ...rest,
    sourceClassifications,
    ...(Array.isArray(sourceRefs) ? { sourceRefs } : {}),
    ...(policyRef ? { classificationPolicy: policyRef } : {}),
  };
}

const DIFF_PATTERN =
  /(?:^|\n)(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+ |@@ -\d|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null))/;
const CODE_PATTERN =
  /```|(?:^|\n)\s*(?:import\s|export\s|from\s|function\s|class\s|def\s|const\s|let\s|var\s|package\s|public\s|private\s|static\s|return\s|if\s*\(|for\s*\(|while\s*\(|#include|<\?php)/;
const LOG_PATTERN =
  /(?:^|\n)\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\[\d{2}:\d{2}:\d{2}\]|\b(?:DEBUG|TRACE|INFO|WARN|WARNING|ERROR|FATAL)\b\s*[:-])/;

/**
 * Deterministic content classification. Only ever adds classes (the direction
 * that makes authorization stricter): a tool result embedding a diff needs
 * both `tool_results` and `diffs` authorized at the destination.
 */
function sniffContentClasses(text: string): DataClass[] {
  const found: DataClass[] = [];
  if (DIFF_PATTERN.test(text)) found.push("diffs");
  if (CODE_PATTERN.test(text)) found.push("code");
  if (LOG_PATTERN.test(text)) found.push("logs");
  return found;
}

/**
 * Deep copy of the request data for scanning and dispatch. `structuredClone`
 * is not usable here: `context.tools` carries agent-tool `execute` functions
 * that must not cross the egress boundary anyway. The copy keeps every data
 * leaf — anything the provider would see — and drops functions and symbols.
 */
function copyRequestData(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, item]) => [copyRequestData(key), copyRequestData(item)]),
    );
  }
  if (value instanceof Set) {
    return new Set([...value.values()].map((item) => copyRequestData(item)));
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyRequestData(item)).filter((item: unknown) => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const copied = copyRequestData(child);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

function segmentFor(
  text: string,
  path: (string | number)[],
  baseClasses: readonly DataClass[],
  derived: DerivedProvenance | undefined,
  binary: boolean,
): ScannableSegment {
  const classes = new Set<DataClass>(baseClasses);
  if (!binary) {
    for (const extra of sniffContentClasses(text)) classes.add(extra);
  }
  if (derived) classes.add("derived_summaries");
  return {
    id: segmentId(path),
    path,
    text,
    dataClasses: [...classes],
    ...(binary ? { binary: true } : {}),
    ...(derived ? { derived } : {}),
  };
}

function collectValue(
  value: unknown,
  path: (string | number)[],
  baseClasses: readonly DataClass[],
  derived: DerivedProvenance | undefined,
  out: ScannableSegment[],
): void {
  if (typeof value === "string") {
    out.push(segmentFor(value, path, baseClasses, derived, false));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectValue(item, [...path, index], baseClasses, derived, out);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const isImage = record["type"] === "image" && typeof record["data"] === "string";
    for (const [key, child] of Object.entries(record)) {
      // Provenance metadata is not request content; it is interpreted, not
      // scanned. Image bytes are scanned but exempt from entropy heuristics.
      if (key === "derived") continue;
      if (isImage && key === "data") {
        out.push(segmentFor(child as string, [...path, key], baseClasses, derived, true));
        continue;
      }
      collectValue(child, [...path, key], baseClasses, derived, out);
    }
    return;
  }
  // Numbers, booleans, null: no text leaves to scan.
}

const ROLE_CLASSES: Record<string, DataClass> = {
  user: "user_input",
  assistant: "history",
  toolResult: "tool_results",
};

/**
 * Flatten the complete request — system prompt, tools, every message kind
 * including history and tool results — into scanned segments, on a deep copy
 * the gate can minimize and dispatch. Nothing that reaches the provider is
 * left out: every string leaf of the request appears here.
 */
export function collectRequestSegments(context: Context): CollectedRequest {
  const copy = copyRequestData(context) as Context;
  const segments: ScannableSegment[] = [];
  if (typeof copy.systemPrompt === "string") {
    segments.push(segmentFor(copy.systemPrompt, ["systemPrompt"], ["system"], undefined, false));
  }
  collectValue(copy.tools, ["tools"], ["system"], undefined, segments);
  (copy.messages ?? []).forEach((message, index) => {
    const record = message as unknown as Record<string, unknown>;
    const role = typeof record["role"] === "string" ? record["role"] : "history";
    // Own-property lookup: a message claiming a prototype property as its
    // role must not inherit one from Object.prototype.
    const base = Object.hasOwn(ROLE_CLASSES, role) ? (ROLE_CLASSES[role] as DataClass) : "history";
    // A message carrying a `derived` marker is a derived summary; a malformed
    // marker still derives — with unestablishable source classification.
    let derived: DerivedProvenance | undefined;
    if ("derived" in record) {
      derived = normalizeDerivedProvenance(record["derived"]);
    }
    collectValue(message, ["messages", index], [base], derived, segments);
  });
  return { context: copy, segments };
}

function writeLeaf(root: unknown, path: readonly (string | number)[], text: string): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (last === undefined) return;
  node[last] = text;
}

/** Sentinel for a report field that could not be read as plain data. */
const UNREADABLE = Symbol("unreadable");

/** The plain-data snapshot of a scanner report; every field is string data. */
interface ReportSnapshot {
  scanner?: string;
  ruleVersion?: string;
  classification: string;
  findings: {
    classification: string;
    detector: string;
    ruleVersion: string;
    segmentId: string;
    match?: string;
  }[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read one report field exactly once and accept only plain string data. The
 * single `Reflect.get` is the one and only read of the field — a getter, if
 * any, fires exactly once and what it returns is the value the snapshot
 * observes. A field provided through an accessor is not data and fails
 * closed; so do a non-string value and a missing required field.
 */
function readSnapshotField(
  source: Record<string, unknown>,
  key: string,
  required: boolean,
): string | undefined | typeof UNREADABLE {
  const value: unknown = Reflect.get(source, key);
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return required ? UNREADABLE : undefined;
  if ("get" in descriptor || "set" in descriptor) return UNREADABLE;
  if (value === undefined) return required ? UNREADABLE : undefined;
  return typeof value === "string" ? value : UNREADABLE;
}

const MAX_REPORT_FINDINGS = 10_000;

/**
 * Copy the findings array — real array, plain elements, every field read
 * exactly once — and fail closed on any shape that is not plain data. The
 * copy runs even when the array itself is later found unusable: each field
 * of the report is observed exactly once no matter what the report is.
 */
function readSnapshotFindings(
  source: Record<string, unknown>,
): ReportSnapshot["findings"] | typeof UNREADABLE {
  const value: unknown = Reflect.get(source, "findings");
  const descriptor = Object.getOwnPropertyDescriptor(source, "findings");
  let invalid = !descriptor || "get" in descriptor || "set" in descriptor || !Array.isArray(value);
  const findings: ReportSnapshot["findings"] = [];
  if (Array.isArray(value)) {
    // The length and every index must be own data properties, confirmed
    // before they are read: an accessor is never invoked, and accessors,
    // missing indices (holes), and failing reads all fail closed (QA
    // re-review — index accessors must be rejected like any accessor).
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown =
      lengthDescriptor && !("get" in lengthDescriptor) && !("set" in lengthDescriptor)
        ? lengthDescriptor.value
        : UNREADABLE;
    if (
      length === UNREADABLE ||
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > MAX_REPORT_FINDINGS
    ) {
      invalid = true;
    } else {
      for (let index = 0; index < length; index += 1) {
        const indexDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!indexDescriptor || "get" in indexDescriptor || "set" in indexDescriptor) {
          invalid = true;
          continue;
        }
        const element: unknown = indexDescriptor.value;
        if (!isPlainRecord(element)) {
          invalid = true;
          continue;
        }
        const classification = readSnapshotField(element, "classification", true);
        const detector = readSnapshotField(element, "detector", true);
        const ruleVersion = readSnapshotField(element, "ruleVersion", true);
        const segmentId = readSnapshotField(element, "segmentId", true);
        const match = readSnapshotField(element, "match", false);
        if (
          classification === UNREADABLE ||
          typeof classification !== "string" ||
          detector === UNREADABLE ||
          typeof detector !== "string" ||
          ruleVersion === UNREADABLE ||
          typeof ruleVersion !== "string" ||
          segmentId === UNREADABLE ||
          typeof segmentId !== "string" ||
          match === UNREADABLE
        ) {
          invalid = true;
          continue;
        }
        findings.push({
          classification,
          detector,
          ruleVersion,
          segmentId,
          ...(match !== undefined ? { match } : {}),
        });
      }
    }
  }
  return invalid ? UNREADABLE : findings;
}

/**
 * Single-read snapshot of an untrusted scanner report (QA round-3). The
 * report, its findings array, and every element may be getters, proxies, or
 * other hostile shapes whose reads disagree with each other. Every field is
 * read exactly once here and copied into plain fixed-shape data; validation
 * and execution never touch the scanner's objects again, so whatever the
 * report does after this point cannot change any decision, minimization,
 * evidence, error, or log — those always carry the values observed here.
 * Anything that cannot be copied as plain data fails closed: a throwing
 * getter or proxy trap, an accessor or non-plain object, a circular or
 * non-array findings value, a field that is not a string.
 */
function snapshotReport(raw: unknown): ReportSnapshot | undefined {
  try {
    if (!isPlainRecord(raw)) return undefined;
    const classification = readSnapshotField(raw, "classification", true);
    const scanner = readSnapshotField(raw, "scanner", false);
    const ruleVersion = readSnapshotField(raw, "ruleVersion", false);
    const findings = readSnapshotFindings(raw);
    if (
      classification === UNREADABLE ||
      typeof classification !== "string" ||
      scanner === UNREADABLE ||
      ruleVersion === UNREADABLE ||
      findings === UNREADABLE
    ) {
      return undefined;
    }
    return {
      classification,
      ...(scanner !== undefined ? { scanner } : {}),
      ...(ruleVersion !== undefined ? { ruleVersion } : {}),
      findings,
    };
  } catch {
    // A throwing getter or proxy trap anywhere in the copy: fail closed.
    return undefined;
  }
}

/**
 * Semantic validation of the plain-data report snapshot: closed
 * classification vocabulary (own properties only), token-shaped
 * non-credential identifiers, and findings bound to real segments whose
 * claimed material actually occurs in them. Operates exclusively on the
 * snapshot — never on the scanner's own objects.
 */
function isValidReport(
  report: ReportSnapshot,
  segments: readonly ScannableSegment[],
): report is SecretScanReport {
  // Own-property enum check: prototype properties like `toString` are not
  // classifications and must never pass as one.
  if (!isSecretClassification(report.classification)) return false;
  // Scanner-named identifiers that may surface in errors or audit evidence
  // must be token-shaped; a report smuggling text (e.g. matched material)
  // through them is invalid and blocks.
  if (report.scanner !== undefined && !isSafeIdentifier(report.scanner)) return false;
  if (report.ruleVersion !== undefined && !isSafeIdentifier(report.ruleVersion)) return false;
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  for (const finding of report.findings) {
    if (
      finding.classification !== "secret_suspected" &&
      finding.classification !== "secret_confirmed" &&
      finding.classification !== "unknown"
    ) {
      return false;
    }
    if (!isSafeIdentifier(finding.detector)) return false;
    if (!isSafeIdentifier(finding.ruleVersion)) return false;
    const segment = byId.get(finding.segmentId);
    if (!segment) return false;
    if (finding.match !== undefined) {
      // A finding's exact material must actually occur in its own segment:
      // a match that is not there can never be removed, so a report claiming
      // one is invalid — never a basis for dispatching the request.
      if (finding.match === "" || !segment.text.includes(finding.match)) return false;
    }
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("secret scan timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Fail-closed scanner invocation. A missing scanner, a throw, a hang, or an
 * invalid report is "scanner unavailable": the gate never treats any of them
 * as clean. Scanner error text is never propagated — it may echo request
 * content, and errors and logs must not contain secrets.
 */
/** Scanner entry point and identity, read exactly once per gate run. */
interface ResolvedScanner {
  owner: object;
  scan: (request: SecretScanRequest) => unknown;
  id: string;
  ruleVersion: string;
}

/**
 * Resolve the scanner seam with exactly one read per field. A missing
 * scanner, a non-function entry point, or non token-shaped identifiers are
 * unusable — and scanner-provided text never enters denials.
 */
function resolveScanner(scanner: SecretScanner | undefined): ResolvedScanner | undefined {
  try {
    if (typeof scanner !== "object" || scanner === null) return undefined;
    const scanFn: unknown = Reflect.get(scanner, "scan");
    const id: unknown = Reflect.get(scanner, "id");
    const ruleVersion: unknown = Reflect.get(scanner, "ruleVersion");
    if (typeof scanFn !== "function" || !isSafeIdentifier(id) || !isSafeIdentifier(ruleVersion)) {
      return undefined;
    }
    return {
      owner: scanner,
      scan: scanFn as ResolvedScanner["scan"],
      id,
      ruleVersion,
    };
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed scanner invocation. A missing scanner, a throw, a hang, or an
 * invalid report is "scanner unavailable": the gate never treats any of them
 * as clean. Scanner error text is never propagated — it may echo request
 * content, and errors and logs must not contain secrets.
 */
async function scanSegments(
  scanner: ResolvedScanner | undefined,
  segments: ScannableSegment[],
  timeoutMs: number,
): Promise<{ report: SecretScanReport } | { unavailable: string }> {
  if (!scanner) {
    return { unavailable: "no usable secret scanner is configured" };
  }
  let raw: unknown;
  try {
    raw = await withTimeout(
      Promise.resolve(scanner.scan.call(scanner.owner, { segments })),
      timeoutMs,
    );
  } catch {
    return { unavailable: "the secret scanner failed or timed out" };
  }
  // Single-read snapshot of the untrusted report (QA round-3): everything
  // downstream — validation, evaluation, minimization, evidence, errors,
  // logs — uses only this plain-data copy and never the scanner's objects.
  const snapshot = snapshotReport(raw);
  if (!snapshot || !isValidReport(snapshot, segments)) {
    return { unavailable: "the secret scanner returned an invalid report" };
  }
  return {
    report: {
      scanner: isSafeIdentifier(snapshot.scanner) ? snapshot.scanner : scanner.id,
      ruleVersion: isSafeIdentifier(snapshot.ruleVersion)
        ? snapshot.ruleVersion
        : scanner.ruleVersion,
      classification: snapshot.classification,
      findings: snapshot.findings,
    },
  };
}

interface Evaluation {
  overall: SecretClassification;
  blocked?: { reason: ScanDenyReason; detail: string };
  /** Suspected findings a separately authorized policy may deterministically remove. */
  removals: SecretFinding[];
  derivedSegments: number;
  changes: { policyId: string; policyVersion: string; segments: number }[];
}

function removalEligible(
  finding: SecretFinding,
  segment: ScannableSegment,
  policy: SecretScanPolicy | undefined,
): boolean {
  const minimization = policy?.minimization;
  if (!minimization || !minimization.authorized) return false;
  // The policy's own identity reaches audit evidence and must be token-shaped.
  if (!isSafeIdentifier(minimization.id) || !isSafeIdentifier(minimization.version)) return false;
  if (finding.classification !== "secret_suspected") return false;
  if (typeof finding.match !== "string" || finding.match.length === 0) return false;
  // The exact material must actually occur in its own segment: material that
  // is not there can never be removed.
  if (!segment.text.includes(finding.match)) return false;
  if (!minimization.appliesTo.detectors.includes(finding.detector)) return false;
  const bounds = minimization.appliesTo.dataClasses;
  if (bounds && !segment.dataClasses.some((dataClass) => bounds.includes(dataClass))) return false;
  return true;
}

/**
 * Classify the complete request from one scan report. Effective content
 * classification is the worst of the scanner's own results and, for derived
 * segments, the inherited source classification — a derived summary is never
 * cleaner than its sources unless a separately authorized deterministic
 * policy changed it.
 */
function evaluateReport(
  report: SecretScanReport,
  segments: readonly ScannableSegment[],
  policy: SecretScanPolicy | undefined,
  allowMinimization: boolean,
): Evaluation {
  const bySegment = new Map<string, SecretFinding[]>();
  for (const finding of report.findings) {
    const list = bySegment.get(finding.segmentId) ?? [];
    list.push(finding);
    bySegment.set(finding.segmentId, list);
  }
  let overall: SecretClassification = report.classification;
  const changes: { policyId: string; policyVersion: string; segments: number }[] = [];
  let derivedSegments = 0;
  let blocked: Evaluation["blocked"];
  const blockOnce = (reason: ScanDenyReason, detail: string): void => {
    if (!blocked) blocked = { reason, detail };
  };

  for (const segment of segments) {
    const own = joinAll((bySegment.get(segment.id) ?? []).map((finding) => finding.classification));
    let effective = own;
    if (segment.derived) {
      derivedSegments += 1;
      // Missing or empty source classification cannot be established: unknown.
      const inherited =
        segment.derived.sourceClassifications.length > 0
          ? joinAll(segment.derived.sourceClassifications)
          : "unknown";
      const declared = segment.derived.classificationPolicy;
      const authorized = policy?.derivedClassification;
      const policyAuthorized =
        declared !== undefined &&
        authorized !== undefined &&
        authorized.authorized &&
        authorized.id === declared.id &&
        authorized.version === declared.version;
      if (SEVERITY[inherited] > SEVERITY.clean && own === "clean" && policyAuthorized && declared) {
        // The one exception to inheritance: a separately authorized
        // deterministic policy changed the classification, and the derived
        // text itself scans clean.
        const existing = changes.find(
          (change) => change.policyId === declared.id && change.policyVersion === declared.version,
        );
        if (existing) {
          existing.segments += 1;
        } else {
          changes.push({ policyId: declared.id, policyVersion: declared.version, segments: 1 });
        }
        effective = "clean";
      } else if (SEVERITY[inherited] > SEVERITY.clean) {
        effective = joinClassification(own, inherited);
        if (inherited === "unknown") {
          blockOnce(
            "CLASSIFICATION_UNKNOWN",
            "a derived summary has unestablished source classification",
          );
        } else if (declared && authorized && !authorized.authorized) {
          blockOnce(
            "AUTHORIZATION_MISSING",
            "a derived summary policy is not authorized; source classification is inherited",
          );
        } else {
          blockOnce(
            "SENSITIVE_DATA_UNCERTAIN",
            "a derived summary inherits a non-clean source classification",
          );
        }
      } else {
        effective = joinClassification(own, inherited);
      }
    }
    overall = joinClassification(overall, effective);
  }

  // Denial details are fully static: scanner- and request-provided text
  // (detector names, policy ids, matched material) never enters user-visible
  // errors or logs. The same identifiers reach audit evidence only through
  // the token-shape validation above.
  const removals: SecretFinding[] = [];
  for (const finding of report.findings) {
    const segment = segments.find((candidate) => candidate.id === finding.segmentId);
    if (finding.classification === "unknown") {
      blockOnce("CLASSIFICATION_UNKNOWN", "a detector returned an unknown classification");
      continue;
    }
    if (finding.classification === "secret_confirmed") {
      blockOnce("SENSITIVE_DATA_UNCERTAIN", "detected secret material; removal is not established");
      continue;
    }
    if (!segment || !removalEligible(finding, segment, policy)) {
      blockOnce(
        "SENSITIVE_DATA_UNCERTAIN",
        "suspected secret material; removal cannot be confirmed",
      );
      continue;
    }
    if (allowMinimization) {
      removals.push(finding);
    } else {
      blockOnce(
        "SENSITIVE_DATA_UNCERTAIN",
        "suspected secret material; removal cannot be confirmed",
      );
    }
  }

  if (overall === "unknown") {
    blockOnce("CLASSIFICATION_UNKNOWN", "the request contains content with unknown classification");
  } else if (overall !== "clean" && removals.length === 0) {
    // The scanner flagged the request without any removable finding (e.g. a
    // heuristic overall classification): fail closed on the join, never on
    // the absence of detail. When removals are pending, the full re-scan
    // after minimization is what must come back clean.
    blockOnce(
      "SENSITIVE_DATA_UNCERTAIN",
      `the request scans ${overall}; removal cannot be confirmed`,
    );
  }

  return { overall, blocked, removals, derivedSegments, changes };
}

function evidenceOf(
  scanner: string,
  ruleVersion: string,
  classification: SecretClassification,
  segments: readonly ScannableSegment[],
  report: SecretScanReport | undefined,
  evaluation: Evaluation | undefined,
  minimization?: RequestScanEvidence["minimization"],
): RequestScanEvidence {
  const findings = report?.findings ?? [];
  // Belt and braces: identifiers are already token-shape validated at the
  // report seam; scrubbing credential-shaped material keeps even a validly
  // shaped secret out of the audit/analytics stream.
  return {
    scanner: scrubSecrets(scanner),
    ruleVersion: scrubSecrets(ruleVersion),
    classification,
    segments: segments.length,
    dataClasses: [...new Set(segments.flatMap((segment) => segment.dataClasses))].sort(),
    findingCounts: {
      suspected: findings.filter((finding) => finding.classification === "secret_suspected").length,
      confirmed: findings.filter((finding) => finding.classification === "secret_confirmed").length,
      unknown: findings.filter((finding) => finding.classification === "unknown").length,
    },
    detectors: [...new Set(findings.map((finding) => scrubSecrets(finding.detector)))].sort(),
    derivedSegments: evaluation?.derivedSegments ?? 0,
    classificationChanges: (evaluation?.changes ?? []).map((change) => ({
      ...change,
      policyId: scrubSecrets(change.policyId),
      policyVersion: scrubSecrets(change.policyVersion),
    })),
    ...(minimization
      ? {
          minimization: {
            ...minimization,
            policyId: scrubSecrets(minimization.policyId),
            policyVersion: scrubSecrets(minimization.policyVersion),
          },
        }
      : {}),
  };
}

/**
 * The complete-request scan gate. Returns the exact request copy the adapter
 * may dispatch (possibly minimized) together with non-secret audit evidence,
 * or a fail-closed denial. Every dispatch attempt runs this gate in full.
 */
export async function runRequestScanGate(
  context: Context,
  deps: ScanGateDeps,
): Promise<ScanGateResult> {
  const timeoutMs = deps.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  // The configured scanner is untrusted input too: resolved once here and
  // reused by every scan pass of this gate run.
  const resolvedScanner = resolveScanner(deps.scanner);
  const scannerId = resolvedScanner?.id ?? "none";
  const scannerRuleVersion = resolvedScanner?.ruleVersion ?? "n/a";

  // Collecting the complete request must never fail open: a request the gate
  // cannot flatten is a request it cannot clear.
  let collected: CollectedRequest;
  try {
    collected = collectRequestSegments(context);
  } catch {
    return {
      ok: false,
      reason: "SENSITIVE_DATA_UNCERTAIN",
      detail: "the complete request could not be collected for scanning",
      evidence: evidenceOf(scannerId, scannerRuleVersion, "unknown", [], undefined, undefined),
    };
  }

  const scan = await scanSegments(resolvedScanner, collected.segments, timeoutMs);
  if ("unavailable" in scan) {
    return {
      ok: false,
      reason: "SCANNER_UNAVAILABLE",
      detail: scan.unavailable,
      evidence: evidenceOf(
        scannerId,
        scannerRuleVersion,
        "unknown",
        collected.segments,
        undefined,
        undefined,
      ),
    };
  }

  const evaluation = evaluateReport(scan.report, collected.segments, deps.scanPolicy, true);
  const firstEvidence = (classification: SecretClassification): RequestScanEvidence =>
    evidenceOf(
      scan.report.scanner,
      scan.report.ruleVersion,
      classification,
      collected.segments,
      scan.report,
      evaluation,
    );

  if (evaluation.blocked) {
    return {
      ok: false,
      reason: evaluation.blocked.reason,
      detail: evaluation.blocked.detail,
      evidence: firstEvidence(evaluation.overall),
    };
  }

  if (evaluation.removals.length === 0) {
    return {
      ok: true,
      context: collected.context,
      evidence: firstEvidence("clean"),
    };
  }

  // Deterministic minimization: remove exactly the detected material, then
  // prove the request actually changed and prove removal with a fresh scan of
  // the complete minimized request. A removal that cannot be applied to its
  // own segment, a request left byte-identical, any residual finding, any
  // leftover match, or any scanner failure keeps the request blocked —
  // removal that cannot be confirmed sends zero bytes.
  const minimizationPolicy = deps.scanPolicy?.minimization;
  const removal = {
    policyId:
      minimizationPolicy && isSafeIdentifier(minimizationPolicy.id)
        ? minimizationPolicy.id
        : "unknown",
    policyVersion:
      minimizationPolicy && isSafeIdentifier(minimizationPolicy.version)
        ? minimizationPolicy.version
        : "unknown",
    removedFindings: evaluation.removals.length,
    verified: false,
  };
  const unconfirmed = (segments: readonly ScannableSegment[]): ScanGateResult => ({
    ok: false,
    reason: "SENSITIVE_DATA_UNCERTAIN",
    detail:
      "removal of suspected secret material could not be confirmed; the request stays blocked",
    evidence: evidenceOf(
      scan.report.scanner,
      scan.report.ruleVersion,
      "secret_suspected",
      segments,
      scan.report,
      evaluation,
      removal,
    ),
  });
  for (const finding of evaluation.removals) {
    const segment = collected.segments.find((candidate) => candidate.id === finding.segmentId);
    if (!segment || typeof finding.match !== "string" || !segment.text.includes(finding.match)) {
      return unconfirmed(collected.segments);
    }
    writeLeaf(collected.context, segment.path, segment.text.split(finding.match).join(REDACTED));
  }
  const minimized = collectRequestSegments(collected.context);
  // The replacement must actually have changed the request: a minimization
  // that would dispatch byte-identical content confirms nothing.
  const beforeById = new Map(collected.segments.map((segment) => [segment.id, segment.text]));
  const applied = evaluation.removals.every((finding) => {
    if (typeof finding.match !== "string") return false;
    const before = beforeById.get(finding.segmentId) ?? "";
    const after =
      minimized.segments.find((segment) => segment.id === finding.segmentId)?.text ?? "";
    return before.includes(finding.match) && after !== before && !after.includes(finding.match);
  });
  if (!applied) {
    return unconfirmed(minimized.segments);
  }
  const rescan = await scanSegments(resolvedScanner, minimized.segments, timeoutMs);
  if ("unavailable" in rescan) {
    return {
      ok: false,
      reason: "SCANNER_UNAVAILABLE",
      detail: rescan.unavailable,
      evidence: evidenceOf(
        scan.report.scanner,
        scan.report.ruleVersion,
        "unknown",
        minimized.segments,
        undefined,
        undefined,
        removal,
      ),
    };
  }
  const revaluation = evaluateReport(rescan.report, minimized.segments, deps.scanPolicy, false);
  const leftover = evaluation.removals.some((finding) =>
    typeof finding.match === "string"
      ? minimized.segments.some((segment) => segment.text.includes(finding.match as string))
      : true,
  );
  if (revaluation.blocked || leftover || revaluation.overall !== "clean") {
    return {
      ok: false,
      reason: revaluation.blocked?.reason ?? "SENSITIVE_DATA_UNCERTAIN",
      detail:
        revaluation.blocked?.detail ??
        "removal of suspected secret material could not be confirmed; the request stays blocked",
      evidence: evidenceOf(
        rescan.report.scanner,
        rescan.report.ruleVersion,
        revaluation.overall,
        minimized.segments,
        rescan.report,
        revaluation,
        removal,
      ),
    };
  }
  removal.verified = true;
  return {
    ok: true,
    context: minimized.context,
    evidence: evidenceOf(
      rescan.report.scanner,
      rescan.report.ruleVersion,
      "clean",
      minimized.segments,
      rescan.report,
      revaluation,
      removal,
    ),
  };
}

/**
 * Destination data-class authorization (ADR-0005 §1: a destination is
 * enabled together with its permitted data classes). Missing authorization
 * fails closed; a class the destination is not authorized for denies the
 * request before any byte is sent.
 */
export function authorizeRequestDataClasses(
  dataClasses: readonly DataClass[],
  endpoint: { permittedDataClasses?: DataClass[] },
):
  | { ok: true }
  | { ok: false; reason: "AUTHORIZATION_MISSING" | "DATA_CLASS_NOT_AUTHORIZED"; detail: string } {
  const permitted = endpoint.permittedDataClasses;
  if (!permitted || permitted.length === 0) {
    return {
      ok: false,
      reason: "AUTHORIZATION_MISSING",
      detail:
        "the approved endpoint has no permitted data classes; this request cannot be authorized",
    };
  }
  const missing = [
    ...new Set(dataClasses.filter((dataClass) => !permitted.includes(dataClass))),
  ].sort();
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "DATA_CLASS_NOT_AUTHORIZED",
      detail: `data classes not authorized for this destination: ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}
