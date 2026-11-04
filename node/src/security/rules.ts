/**
 * Versioned rule corrections for the secret detectors (DAT-211,
 * ADR-0005 §4).
 *
 * A false positive is corrected by a *bounded* rule correction: exactly one
 * detector, one enterprise/workspace scope, and narrowing match constraints —
 * never an exemption. This module is the closed vocabulary and the validation
 * boundary that keeps it that way:
 *
 * - A rule can never select an invocation, case, request digest, or
 *   individual secret value. Attempts are *identified* and rejected
 *   (`RULE_TARGETED_EXEMPTION`), not silently dropped.
 * - A whole-detector disable or blanket allow is not a false-positive
 *   correction (`RULE_BLANKET_EXEMPTION`).
 * - Corrections only ever narrow a detector's matching; {@link constrainDetector}
 *   can widen nothing and can never turn a detector off.
 * - Regression evidence is computed, not asserted: the service runs trusted
 *   true-secret samples through the corrected scanner (`regression.ts`) and
 *   never accepts evidence results from a proposal.
 *
 * Rule changes are policy changes, not run grants: the same complete-request
 * checks apply before and after activation.
 */

import { SecurityError } from "./types.js";
import type { SecretDetector } from "../gateway/pattern-scanner.js";
import type { RegressionEvidence } from "./regression.js";

/** Boundary parse: unvalidated proposal input must be a JSON object. */
function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SecurityError("RULE_PROPOSAL_INVALID", `rule ${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Narrowing match constraints one correction may add to one detector. */
export interface DetectorConstraints {
  /** Minimum Shannon entropy (bits/char) the matched material must reach. */
  minShannonEntropy?: number;
  /** Minimum length the matched material must reach. */
  minLength?: number;
  /** The matched material must start with this fixed marker. */
  requiredPrefix?: string;
  /** The matched material must end with this fixed marker. */
  requiredSuffix?: string;
}

/** Machine-checked proof that true-secret detection still works. */
export type { RegressionEvidence, TrueSecretSample } from "./regression.js";

/**
 * The proposal as submitted, before validation. Accepted as an untyped record
 * precisely so disguised exemption shapes can be identified and named in the
 * rejection instead of failing some generic type error.
 *
 * A proposal carries no regression evidence: the service computes evidence
 * itself from the trusted corpus at proposal and activation time
 * (`regression.ts`), so request-supplied `result` fields can never open the
 * activation gate.
 */
export interface RuleCorrectionDraft {
  detectorId: string;
  scope: { enterpriseId: string; workspaceId: string };
  constraints: DetectorConstraints;
  reason: string;
  /** ISO timestamp; a correction is bounded in time and expires. */
  expiresAt: string;
  /** Optional interim review date; must not exceed the expiry. */
  reviewAt?: string;
}

/** Lifecycle status of one versioned rule revision. */
export type RuleRevisionStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "activated"
  | "superseded"
  | "rolled_back"
  | "expired"
  | "applied";

/** Independent review decision recorded on a revision. */
export interface RuleReview {
  reviewerId: string;
  approved: boolean;
  reason: string;
  at: string;
}

/**
 * One versioned entry in a correction lineage (`detectorId` + scope).
 * Corrections walk `proposed → approved → activated → superseded |
 * rolled_back | expired`; a rollback entry (`kind: "rollback"`) records a
 * versioned rollback of the then-active correction and re-activates nothing.
 */
export interface RuleRevision {
  lineage: string;
  /** 1-based per lineage; strictly increasing with every entry. */
  version: number;
  kind: "correction" | "rollback";
  status: RuleRevisionStatus;
  detectorId: string;
  scope: { enterpriseId: string; workspaceId: string };
  constraints: DetectorConstraints;
  reason: string;
  expiresAt: string;
  reviewAt?: string;
  /** Evidence the service computed at proposal time (never client input). */
  regressionEvidence: readonly RegressionEvidence[];
  /**
   * Commitment binding the evidence to the exact rule content and the exact
   * trusted corpus it was computed against; activation re-verifies both.
   */
  regressionBinding?: {
    ruleDigest: string;
    corpusDigest: string;
    at: string;
  };
  /** Proposing human principal (security handler). */
  authorId: string;
  proposedAt: string;
  review?: RuleReview;
  activatedBy?: string;
  activatedAt?: string;
  supersededAt?: string;
  rolledBackBy?: string;
  rolledBackAt?: string;
  /** On rollback entries: the version whose activation was rolled back. */
  rollsBackVersion?: number;
  expiredAt?: string;
  /** Populated when a proposal is identified as a disguised exemption. */
  rejectedCode?: string;
}

/** Append-only per-lineage audit event kinds (proposal/review/activation/rollback). */
export type RuleEventType =
  | "rule.proposed"
  | "rule.proposal_rejected"
  | "rule.review_approved"
  | "rule.review_rejected"
  | "rule.review_denied"
  | "rule.activated"
  | "rule.activation_denied"
  | "rule.superseded"
  | "rule.rolled_back"
  | "rule.rollback_denied"
  | "rule.expired";

export interface RuleEvent {
  /** Per-lineage, 1-based, strictly increasing; the history never rewrites. */
  seq: number;
  lineage: string;
  type: RuleEventType;
  at: string;
  /** Acting principal and its effective duty; null for service sweeps. */
  actor: { principalId: string; duty: string } | null;
  /** Non-secret scalars only (ids, versions, codes, enum words). */
  detail: Record<string, string | number | boolean>;
}

/**
 * One active correction as the scanner consumes it: the lineage's activated,
 * unexpired revision, already narrowed and version-tagged. The scope is part
 * of the value so the scanner applies a correction only to scans resolved for
 * exactly that enterprise *and* workspace.
 */
export interface ActiveRuleCorrection {
  lineage: string;
  version: number;
  detectorId: string;
  scope: { enterpriseId: string; workspaceId: string };
  constraints: DetectorConstraints;
}

/**
 * Selector keys that turn a "correction" into a targeted exemption for one
 * invocation, case, request, or secret value (ADR-0005 §4: forbidden).
 * Matched case- and separator-insensitively at any depth of the raw proposal.
 */
const TARGETED_SELECTOR_KEYS: Record<string, true> = {
  invocationid: true,
  invocation: true,
  caseid: true,
  case: true,
  requestid: true,
  request: true,
  requestdigest: true,
  digest: true,
  secretvalue: true,
  secret: true,
  secrethash: true,
  matchedvalue: true,
  matchedsecret: true,
  match: true,
  value: true,
  content: true,
  payload: true,
  body: true,
  text: true,
};

/**
 * Keys that disable a detector or allow everything through — blanket
 * allowances, never a false-positive correction (also forbidden).
 */
const BLANKET_KEYS: Record<string, true> = {
  enabled: true,
  disabled: true,
  action: true,
  mode: true,
  allow: true,
  allowall: true,
  exempt: true,
  exemption: true,
  whitelist: true,
  allowlist: true,
  ignore: true,
  skip: true,
  skipbinary: true,
  classification: true,
  pattern: true,
};

/** The closed proposal schema: anything else in the raw draft is rejected. */
const KNOWN_KEYS: Record<string, true> = {
  detectorid: true,
  scope: true,
  enterpriseid: true,
  workspaceid: true,
  constraints: true,
  minshannonentropy: true,
  minlength: true,
  requiredprefix: true,
  requiredsuffix: true,
  reason: true,
  expiresat: true,
  reviewat: true,
};

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

/** Offending key paths of a raw proposal, classified by rejection reason. */
export interface DisguisedExemptionScan {
  /** Selectors for one invocation/case/request/secret value. */
  targeted: string[];
  /** Detector-disable / allow-everything shapes. */
  blanket: string[];
  /** Fields outside the closed proposal schema. */
  unknown: string[];
}

/**
 * Recursively classify every key of a raw proposal: targeted-exemption
 * selectors, blanket-allow/detector-disable shapes, and unknown fields are
 * each named by path so the rejection can say exactly what it refused.
 */
export function scanDisguisedExemptions(raw: unknown, path = "proposal"): DisguisedExemptionScan {
  const offenders: DisguisedExemptionScan = { targeted: [], blanket: [], unknown: [] };
  const walk = (value: unknown, here: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${here}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(asRecord(value, here))) {
      const normalized = normalizeKey(key);
      const keyPath = `${here}.${key}`;
      if (TARGETED_SELECTOR_KEYS[normalized]) {
        offenders.targeted.push(keyPath);
      } else if (BLANKET_KEYS[normalized]) {
        offenders.blanket.push(keyPath);
      } else if (!KNOWN_KEYS[normalized]) {
        offenders.unknown.push(keyPath);
      } else {
        walk(entry, keyPath);
      }
    }
  };
  walk(raw, path);
  return offenders;
}

/**
 * Every offending key path (targeted, blanket, or unknown) in a raw proposal
 * — the flat view used by diagnostics and tests.
 */
export function findDisguisedExemptions(raw: unknown, path = "proposal"): string[] {
  const scan = scanDisguisedExemptions(raw, path);
  return [...scan.targeted, ...scan.blanket, ...scan.unknown];
}

/**
 * Lenient identity extraction for auditing rejected proposals: the lineage a
 * rejected draft *would* have belonged to, when derivable at all. Best
 * effort by design — a draft too malformed to attribute simply throws
 * without a lineage record.
 */
export function correctionLineage(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = asRecord(raw, "proposal");
  const detectorId = record["detectorId"];
  const scopeRaw = record["scope"];
  if (
    typeof detectorId !== "string" ||
    detectorId.length === 0 ||
    scopeRaw === null ||
    typeof scopeRaw !== "object" ||
    Array.isArray(scopeRaw)
  ) {
    return undefined;
  }
  const scope = asRecord(scopeRaw, "scope");
  const enterpriseId = scope["enterpriseId"];
  const workspaceId = scope["workspaceId"];
  if (typeof enterpriseId !== "string" || typeof workspaceId !== "string") return undefined;
  return [detectorId, enterpriseId, workspaceId].join("|");
}

/**
 * True when the value looks like it selects one specific secret value or
 * request digest rather than a bounded class: long fixed markers and
 * digest-shaped hex are value selectors, never class constraints.
 */
function looksLikeValueSelector(value: string): boolean {
  if (value.length > 24) return true;
  return /^[a-f0-9]{16,}$/i.test(value);
}

/**
 * Validate one rule correction draft. Throws:
 * - `RULE_TARGETED_EXEMPTION` when the draft names an invocation, case,
 *   request digest, or individual secret value (offending paths in details);
 * - `RULE_BLANKET_EXEMPTION` when the draft disables a detector or allows
 *   everything;
 * - `RULE_PROPOSAL_INVALID` for missing reason, unbounded applicability,
 *   missing expiry, or any field outside the closed schema — including
 *   client-supplied regression-evidence results, which are never accepted.
 *
 * Regression evidence itself is computed by the service (`regression.ts`),
 * never taken from the proposal.
 */
export function validateRuleCorrection(raw: unknown, now: Date): RuleCorrectionDraft {
  const offenders = scanDisguisedExemptions(raw);
  if (offenders.blanket.length > 0) {
    throw new SecurityError(
      "RULE_BLANKET_EXEMPTION",
      "a blanket allow or detector disable is not a false-positive correction",
      { paths: offenders.blanket },
    );
  }
  if (offenders.targeted.length > 0) {
    throw new SecurityError(
      "RULE_TARGETED_EXEMPTION",
      "a rule cannot target an invocation, case, request digest, or individual secret value",
      { paths: offenders.targeted },
    );
  }
  if (offenders.unknown.length > 0) {
    throw new SecurityError(
      "RULE_PROPOSAL_INVALID",
      "a proposal may not carry fields outside the closed correction schema",
      { paths: offenders.unknown },
    );
  }
  const record = asRecord(raw, "proposal");
  const detectorIdRaw = record["detectorId"];
  const detectorId =
    typeof detectorIdRaw === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(detectorIdRaw)
      ? detectorIdRaw
      : undefined;
  const scopeRaw = record["scope"];
  let scope: { enterpriseId: string; workspaceId: string } | undefined;
  if (scopeRaw !== null && typeof scopeRaw === "object" && !Array.isArray(scopeRaw)) {
    const scopeRecord = asRecord(scopeRaw, "scope");
    const enterpriseId = scopeRecord["enterpriseId"];
    const workspaceId = scopeRecord["workspaceId"];
    if (
      typeof enterpriseId === "string" &&
      enterpriseId.length > 0 &&
      typeof workspaceId === "string" &&
      workspaceId.length > 0
    ) {
      scope = { enterpriseId, workspaceId };
    }
  }
  if (!detectorId || !scope) {
    throw new SecurityError(
      "RULE_PROPOSAL_INVALID",
      "a correction needs one token-shaped detectorId and an enterprise/workspace scope",
    );
  }
  const reasonRaw = record["reason"];
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length === 0) {
    throw new SecurityError("RULE_PROPOSAL_INVALID", "a correction needs a reason");
  }
  const constraints = validateConstraints(record["constraints"]);
  const expiresAt = parseFutureDate(record["expiresAt"], "expiresAt", now);
  let reviewAt: string | undefined;
  if (record["reviewAt"] !== undefined) {
    reviewAt = parseFutureDate(record["reviewAt"], "reviewAt", now);
    if (Date.parse(reviewAt) > Date.parse(expiresAt)) {
      throw new SecurityError("RULE_PROPOSAL_INVALID", "reviewAt must not exceed the expiry date", {
        reviewAt,
        expiresAt,
      });
    }
  }
  return {
    detectorId,
    scope,
    constraints,
    reason,
    expiresAt,
    ...(reviewAt !== undefined ? { reviewAt } : {}),
  };
}

function validateConstraints(raw: unknown): DetectorConstraints {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SecurityError(
      "RULE_PROPOSAL_INVALID",
      "a correction needs bounded applicability (narrowing match constraints)",
    );
  }
  const input = asRecord(raw, "constraints");
  if (Object.keys(input).length === 0) {
    throw new SecurityError(
      "RULE_PROPOSAL_INVALID",
      "a correction needs bounded applicability (narrowing match constraints)",
    );
  }
  const constraints: DetectorConstraints = {};
  const entropy = input["minShannonEntropy"];
  if (entropy !== undefined) {
    if (typeof entropy !== "number" || !Number.isFinite(entropy) || entropy <= 0 || entropy > 8) {
      throw new SecurityError("RULE_PROPOSAL_INVALID", "minShannonEntropy must be in (0, 8]");
    }
    constraints.minShannonEntropy = entropy;
  }
  const minLength = input["minLength"];
  if (minLength !== undefined) {
    if (
      typeof minLength !== "number" ||
      !Number.isInteger(minLength) ||
      minLength < 1 ||
      minLength > 256
    ) {
      throw new SecurityError("RULE_PROPOSAL_INVALID", "minLength must be an integer in [1, 256]");
    }
    constraints.minLength = minLength;
  }
  for (const key of ["requiredPrefix", "requiredSuffix"] as const) {
    const marker = input[key];
    if (marker === undefined) continue;
    if (
      typeof marker !== "string" ||
      marker.length < 2 ||
      marker.length > 24 ||
      /\s/.test(marker)
    ) {
      throw new SecurityError(
        "RULE_PROPOSAL_INVALID",
        `${key} must be a 2..24 character marker without whitespace`,
      );
    }
    if (looksLikeValueSelector(marker)) {
      throw new SecurityError(
        "RULE_TARGETED_EXEMPTION",
        `${key} selects one secret value or digest instead of a bounded class`,
        { [key]: "value-shaped" },
      );
    }
    constraints[key] = marker;
  }
  return constraints;
}

function parseFutureDate(value: unknown, name: string, now: Date): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SecurityError("RULE_PROPOSAL_INVALID", `${name} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (parsed.getTime() <= now.getTime()) {
    throw new SecurityError("RULE_PROPOSAL_INVALID", `${name} must be in the future`, {
      [name]: value,
    });
  }
  return parsed.toISOString();
}

/**
 * Apply one correction to one detector. Narrowing only: constraints combine
 * with the detector's own bounds by taking the stricter side, and a
 * correction whose prefix/suffix contradicts the detector's own would empty
 * the match set — that is a disguised detector disable and is refused.
 */
export function constrainDetector(
  detector: SecretDetector,
  constraints: DetectorConstraints,
): Partial<
  Pick<SecretDetector, "minShannonEntropy" | "minLength" | "requiredPrefix" | "requiredSuffix">
> {
  const narrowed: Partial<
    Pick<SecretDetector, "minShannonEntropy" | "minLength" | "requiredPrefix" | "requiredSuffix">
  > = {};
  if (detector.minShannonEntropy !== undefined) {
    narrowed.minShannonEntropy = detector.minShannonEntropy;
  }
  if (detector.minLength !== undefined) narrowed.minLength = detector.minLength;
  if (detector.requiredPrefix !== undefined) narrowed.requiredPrefix = detector.requiredPrefix;
  if (detector.requiredSuffix !== undefined) narrowed.requiredSuffix = detector.requiredSuffix;
  if (constraints.minShannonEntropy !== undefined) {
    narrowed.minShannonEntropy = Math.max(
      narrowed.minShannonEntropy ?? 0,
      constraints.minShannonEntropy,
    );
  }
  if (constraints.minLength !== undefined) {
    narrowed.minLength = Math.max(narrowed.minLength ?? 0, constraints.minLength);
  }
  for (const key of ["requiredPrefix", "requiredSuffix"] as const) {
    const constraint = constraints[key];
    if (constraint === undefined) continue;
    const existing = narrowed[key];
    if (existing === undefined) {
      narrowed[key] = constraint;
      continue;
    }
    const longer =
      key === "requiredPrefix"
        ? constraint.startsWith(existing)
          ? constraint
          : existing.startsWith(constraint)
            ? existing
            : undefined
        : constraint.endsWith(existing)
          ? constraint
          : existing.endsWith(constraint)
            ? existing
            : undefined;
    if (longer === undefined) {
      throw new SecurityError(
        "RULE_BLANKET_EXEMPTION",
        `${key} constraints are disjoint: the correction would disable the detector`,
        { detectorId: detector.id, [key]: "disjoint" },
      );
    }
    narrowed[key] = longer;
  }
  return narrowed;
}
