/**
 * Structural, trust, and scope consistency for a memory candidate (DAT-234).
 *
 * Three separate concerns that all answer "does this candidate's shape match
 * what it claims to be?":
 *
 * - **Shape caps.** A memory item is a short, cited statement with a few
 *   preconditions, not a pasted transcript. Size caps are also what keeps the
 *   ever-growing, self-referential playbook collapse out of the corpus.
 * - **Provenance and trust.** Trust describes who authored the version and is
 *   derived from the author, never asserted by the text. An agent that writes
 *   `trust: "human"` to reach automatic promotion is the classic poisoning
 *   move, and it is rejected here rather than at promotion time.
 * - **Scope consistency.** Applicability values are structured metadata. They
 *   must be well formed, must not point outside the workspace, and must not
 *   contradict the item's kind — an agent-authored `policy` item is rejected,
 *   because the institutional tier is human-authored and never learned.
 */

import type { MemoryApplicability, MemoryKind } from "../types.js";
import type { AdmissionCandidate, AdmissionReason } from "./types.js";

// ---------------------------------------------------------------------------
// Shape caps
// ---------------------------------------------------------------------------

/** A statement is a fact or a procedure, not a document. */
export const MAX_STATEMENT_LENGTH = 2_000;
export const MAX_PRECONDITIONS = 12;
export const MAX_PRECONDITION_LENGTH = 500;

export function checkShape(candidate: AdmissionCandidate): AdmissionReason[] {
  const reasons: AdmissionReason[] = [];
  const statement = candidate.statement.trim();
  if (statement.length === 0) {
    reasons.push("shape_missing_statement");
  } else if (statement.length > MAX_STATEMENT_LENGTH) {
    reasons.push("shape_statement_too_long");
  }
  if (candidate.preconditions.length > MAX_PRECONDITIONS) {
    reasons.push("shape_too_many_preconditions");
  }
  if (candidate.preconditions.some((entry) => entry.length > MAX_PRECONDITION_LENGTH)) {
    reasons.push("shape_precondition_too_long");
  }
  // An open-ended validity window is fine; one that ends before it starts is
  // not, and neither is a malformed timestamp — both break point-in-time reads.
  const from = candidate.valid_from;
  const to = candidate.valid_to;
  const fromValid = from === undefined || !Number.isNaN(Date.parse(from));
  const toValid = to === null || to === undefined || !Number.isNaN(Date.parse(to));
  if (!fromValid || !toValid) {
    reasons.push("shape_invalid_temporality");
  } else if (
    from !== undefined &&
    to !== null &&
    to !== undefined &&
    Date.parse(to) <= Date.parse(from)
  ) {
    reasons.push("shape_invalid_temporality");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Provenance and trust
// ---------------------------------------------------------------------------

/**
 * Trust is a statement about the author, not about the content. An author may
 * only claim the trust class that matches it: an agent-authored version is an
 * agent-trusted version, whatever the payload says.
 */
export function checkProvenanceTrust(candidate: AdmissionCandidate): AdmissionReason[] {
  const reasons: AdmissionReason[] = [];
  const author = candidate.provenance.author_type;
  const trust = candidate.trust;

  // An adopted enterprise template is the one legitimate exception: the local
  // copy is authored by a system adoption step but keeps the template's trust
  // class so its origin stays visible.
  const templateCopy = trust === "enterprise_template" && author === "system";
  if (!templateCopy && trust !== author) {
    reasons.push("trust_mismatch_with_author");
    // An agent claiming any other class is the classic self-promotion move;
    // name it specifically so the audit reads as an attack, not a typo.
    if (author === "agent") {
      reasons.push("trust_self_raised");
    }
  }

  // Institutional policy is human-authored and never learned. An agent writing
  // a `policy` item is the one case where the kind itself is the violation.
  if (candidate.kind === "policy" && author !== "human") {
    reasons.push("policy_kind_requires_human");
  }

  // An agent-authored version that names no model cannot be reproduced or
  // audited, and therefore carries no evidence of its own.
  if (author === "agent" && !candidate.provenance.agent_model) {
    reasons.push("trust_untrusted_origin");
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// Scope consistency
// ---------------------------------------------------------------------------

const TEAM_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const PATH_PREFIX = /^[\w.\-/+~@]{1,256}$/;
const LANGUAGE = /^[a-z0-9+#._-]{1,32}$/;
const TASK_FAMILY = /^[a-z0-9_-]{1,64}$/;

const SCOPE_KEYS = ["team_id", "path_prefix", "language", "task_family"] as const;
type ScopeKey = (typeof SCOPE_KEYS)[number];

const SCOPE_PATTERNS: Record<ScopeKey, RegExp> = {
  team_id: TEAM_ID,
  path_prefix: PATH_PREFIX,
  language: LANGUAGE,
  task_family: TASK_FAMILY,
};

/** Applicability keys each learned kind may carry. */
const KIND_SCOPE_EXPECTATIONS: Partial<Record<MemoryKind, ScopeKey[]>> = {
  fact: ["language", "path_prefix", "task_family", "team_id"],
  lesson: ["language", "path_prefix", "task_family", "team_id"],
  playbook: ["path_prefix", "task_family", "team_id"],
  anti_pattern: ["language", "path_prefix", "task_family", "team_id"],
};

export function checkScopeConsistency(candidate: AdmissionCandidate): AdmissionReason[] {
  const reasons: AdmissionReason[] = [];
  const scope = candidate.scope;

  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      reasons.push("scope_malformed_value");
      continue;
    }
    if (!SCOPE_PATTERNS[key].test(value)) {
      reasons.push("scope_malformed_value");
    }
  }

  // A scope value naming another workspace, enterprise, or external tenant is
  // a cross-scope reference, and memory is workspace-isolated.
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (value === undefined) continue;
    if (/(?:workspace|enterprise|tenant|org)[ _-]?(?:id)?[:=/]/iu.test(value)) {
      reasons.push("scope_foreign_reference");
    }
  }

  // An `episode` or `policy` item has no learned applicability domain: an
  // episode is about one run, and policy binds the whole workspace.
  const expected = KIND_SCOPE_EXPECTATIONS[candidate.kind];
  if (expected === undefined) {
    if (SCOPE_KEYS.some((key) => scope[key] !== undefined)) {
      reasons.push("scope_kind_inconsistent");
    }
  } else {
    for (const key of SCOPE_KEYS) {
      if (scope[key] !== undefined && !expected.includes(key)) {
        reasons.push("scope_kind_inconsistent");
      }
    }
  }

  return [...new Set(reasons)];
}

// ---------------------------------------------------------------------------
// Scope overlap semantics
// ---------------------------------------------------------------------------

function prefixContains(broad: string, narrow: string): boolean {
  if (narrow === broad) return true;
  return narrow.startsWith(broad.endsWith("/") ? broad : `${broad}/`);
}

/**
 * Does the scope `inner` fall entirely inside `outer`?
 *
 * A missing field means broad applicability, so an empty scope contains every
 * narrower one. `path_prefix` is a path prefix, so `/a` contains `/a/b`; the
 * other fields are exact.
 */
export function scopeContains(outer: MemoryApplicability, inner: MemoryApplicability): boolean {
  return SCOPE_KEYS.every((key) => {
    const broad = outer[key];
    const narrow = inner[key];
    if (broad === undefined || broad === "") return true;
    if (narrow === undefined || narrow === "") return false;
    return key === "path_prefix" ? prefixContains(broad, narrow) : narrow === broad;
  });
}

/**
 * Can the two scopes cover the same situation at all?
 *
 * Unlike {@link scopeContains} this is permissive: they overlap unless some
 * dimension both of them pin disagrees. `language: ts` and `language: go` are
 * disjoint; `language: ts` and `task_family: build` may well meet.
 *
 * Used for contradiction detection, where the dangerous miss is failing to
 * notice that two claims fight over the same ground.
 */
export function scopesMayOverlap(a: MemoryApplicability, b: MemoryApplicability): boolean {
  return SCOPE_KEYS.every((key) => {
    const left = a[key];
    const right = b[key];
    if (left === undefined || left === "" || right === undefined || right === "") return true;
    if (key === "path_prefix") {
      return prefixContains(left, right) || prefixContains(right, left);
    }
    return left === right;
  });
}

/**
 * Cross-scope dedupe boundary.
 *
 * Two candidates are dedupe-comparable only when their applicability scopes
 * are **identical**. Dedupe never crosses a scope boundary: the same statement
 * under two different scopes is two memories, and merging them would silently
 * drop which domain the claim was about — the narrow "TypeScript builds run
 * `tsc`" is not the same memory as the unscoped "builds run `tsc`", even
 * though one contains the other.
 *
 * Byte-identical content is still caught exactly, because the canonical
 * content hash covers the scope as well: an equal hash already implies an
 * equal scope. This rule is what stops the *near*-duplicate detector from
 * reaching across one.
 */
export function scopesComparableForDedupe(a: MemoryApplicability, b: MemoryApplicability): boolean {
  return SCOPE_KEYS.every((key) => (a[key] ?? "") === (b[key] ?? ""));
}
