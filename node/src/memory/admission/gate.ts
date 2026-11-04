/**
 * The admission gate (DAT-234).
 *
 * One question, answered before a candidate can become visible: may this be
 * remembered, and if so, how may it be used. The evaluation is pure — no
 * database, no clock, no side effects — so the verdict for a given candidate
 * against a given corpus is reproducible and testable, and the side effects
 * (creating items, links, retirement proposals, audit rows) live in the
 * admission service where they can be transactional.
 *
 * Order matters. The security checks run first and a security failure means
 * `discarded`, whatever else the candidate is: a poisoned candidate that is
 * also a duplicate must never be merged into a good item. Quality failures
 * only hold the candidate as `proposed`. Nothing here promotes anything.
 */

import type { MemoryItemRecord } from "../types.js";
import { memoryContentHash } from "../hash.js";
import type {
  AdmissionCandidate,
  AdmissionCheckResult,
  AdmissionDisposition,
  AdmissionReason,
  AdmissionVerdict,
  DuplicateFinding,
  EvidenceResolver,
} from "./types.js";
import { checkShape, checkProvenanceTrust, checkScopeConsistency } from "./consistency.js";
import { findContradictions } from "./contradiction.js";
import { findDuplicate } from "./dedupe.js";
import { checkEvidence } from "./evidence.js";
import { isFloodingShape, scanForInjection } from "./poisoning.js";
import { lintForPolicyInstructions } from "./policy.js";

/**
 * Reasons that mean the candidate is trying to move the gate rather than
 * describe the workspace. These discard the candidate outright: it is never
 * persisted as visible memory, and it can never reach `active` or retrieval.
 */
const SECURITY_REASONS: ReadonlySet<AdmissionReason> = new Set<AdmissionReason>([
  "policy_privilege_expansion",
  "policy_approval_claim",
  "policy_approval_bypass",
  "policy_test_gate_bypass",
  "policy_ignore",
  "policy_evaluator_directed",
  "injection_role_marker",
  "injection_instruction_override",
  "injection_control_token",
  "injection_instruction_shaped",
  "injection_self_reference",
  "benchmark_fixture_reference",
  "trust_mismatch_with_author",
  "trust_self_raised",
  "trust_untrusted_origin",
  "policy_kind_requires_human",
]);

/** Reasons that mean the candidate is malformed rather than hostile. */
const QUALITY_REASONS: ReadonlySet<AdmissionReason> = new Set<AdmissionReason>([
  "shape_missing_statement",
  "shape_statement_too_long",
  "shape_too_many_preconditions",
  "shape_precondition_too_long",
  "shape_invalid_temporality",
  "scope_malformed_value",
  "scope_foreign_reference",
  "scope_kind_inconsistent",
  "evidence_missing",
  "evidence_unresolved",
  "evidence_no_known_outcome",
]);

function result(
  check: AdmissionCheckResult["check"],
  reasons: AdmissionReason[],
): AdmissionCheckResult {
  const blocking = reasons.some(
    (reason) => SECURITY_REASONS.has(reason) || QUALITY_REASONS.has(reason),
  );
  return {
    check,
    status: blocking ? "fail" : reasons.length > 0 ? "flag" : "pass",
    reasons,
  };
}

function contentHashFor(candidate: AdmissionCandidate): string {
  return memoryContentHash({
    kind: candidate.kind,
    scope: candidate.scope,
    statement: candidate.statement,
    preconditions: candidate.preconditions,
    sensitivity: candidate.sensitivity,
  });
}

export interface EvaluateContext {
  /**
   * Existing items of the **same workspace**. The gate never sees another
   * workspace's memory: cross-workspace comparison is not a policy choice
   * here, it is unreachable, because the repository layer will not return it.
   */
  existing: readonly MemoryItemRecord[];
  evidence: EvidenceResolver;
}

/**
 * Evaluate one candidate. Returns the full verdict — every check, every reason
 * code, and the two independent eligibility flags the read path needs.
 *
 * Retirement proposals are deliberately *not* part of the verdict: which item
 * would replace a contradicted one depends on the id of the item this candidate
 * becomes, which does not exist yet. The admission service derives them from
 * `contradictions` once it knows.
 */
export function evaluateCandidate(
  candidate: AdmissionCandidate,
  context: EvaluateContext,
): AdmissionVerdict {
  const candidateHash = contentHashFor(candidate);
  const checks: AdmissionCheckResult[] = [];

  // 1. Shape and size. A candidate that is not a bounded statement is not a
  //    memory item at all.
  const shapeReasons = checkShape(candidate);
  if (isFloodingShape(candidate.statement, candidate.preconditions)) {
    shapeReasons.push("shape_statement_too_long");
  }
  checks.push(result("shape", shapeReasons));

  // 2. Policy lint. Prohibited instructions reject the candidate outright,
  //    and the finding is a security failure however well evidenced the rest
  //    of the candidate is.
  const lintText = [
    candidate.statement,
    ...candidate.preconditions,
    ...Object.values(candidate.scope).filter((value): value is string => value !== undefined),
  ].join("\n");
  checks.push(result("policy_lint", lintForPolicyInstructions(lintText)));

  // 3. Injection and poisoning heuristics over the same text.
  const injectionText = [candidate.statement, ...candidate.preconditions].join("\n");
  checks.push(result("injection_heuristics", scanForInjection(injectionText)));

  // 4. Provenance and trust. Trust describes the author; a candidate cannot
  //    promote itself by claiming a class its author does not have.
  checks.push(result("provenance_trust", checkProvenanceTrust(candidate)));

  // 5. Scope consistency: well-formed values, no cross-workspace reference,
  //    and applicability that matches the item's kind.
  checks.push(result("scope_consistency", checkScopeConsistency(candidate)));

  // 6. Evidence resolvability.
  const evidenceCheck = checkEvidence(candidate.evidence, context.evidence);
  checks.push(result("evidence_resolution", evidenceCheck.reasons));

  // 7. Dedupe against the same workspace's corpus.
  const duplicate = findDuplicate(candidate, candidateHash, context.existing);
  checks.push(result("dedupe", duplicate === null ? [] : [dedupeReason(duplicate)]));

  // 8. Contradiction. A contradiction is a real finding but not a validation
  //    failure: the item stays visible, the link is drawn, and neither side is
  //    injected as fact. That is why this check reports `flag`, not `fail`.
  const contradictions = findContradictions(
    candidate.statement,
    candidate.preconditions,
    candidate.scope,
    context.existing,
  );
  checks.push(
    result("contradiction", contradictions.length === 0 ? [] : ["contradiction_detected"]),
  );

  const reasons = [...new Set(checks.flatMap((check) => check.reasons))];
  const security = reasons.some((reason) => SECURITY_REASONS.has(reason));
  const quality = reasons.some((reason) => QUALITY_REASONS.has(reason));

  const disposition: AdmissionDisposition = security
    ? "discarded"
    : quality
      ? "held"
      : duplicate !== null
        ? "merged"
        : "admitted";

  // Eligibility, two independent axes.
  //
  // Anything that failed validation is invisible to every bundle in every
  // form. An admitted item that contradicts something stays visible — the
  // conflict has to be surfaced — but is never presented as fact.
  const retrieval_eligible = disposition === "admitted" || disposition === "merged";
  const factual_injection_allowed = retrieval_eligible && contradictions.length === 0;

  return {
    disposition,
    candidate_hash: candidateHash,
    checks,
    reasons,
    duplicate,
    contradictions,
    retrieval_eligible,
    factual_injection_allowed,
  };
}

function dedupeReason(duplicate: DuplicateFinding): AdmissionReason {
  return duplicate.kind === "exact" ? "dedupe_exact_duplicate" : "dedupe_near_duplicate";
}
