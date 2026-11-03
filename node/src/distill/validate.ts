/**
 * Candidate validation: evidence resolution, claim attribution, policy lint,
 * and redaction (DAT-233).
 *
 * A candidate survives only when every part of it is attributable:
 *
 * - it cites at least one evidence reference, and every citation resolves in
 *   the ledger of evidence captured from this workspace's outcomes;
 * - at least one citation comes from a **known** outcome (accepted/merged,
 *   rejected-with-reason, cancelled-with-reason, classified failed) — an
 *   episode-only outcome (timeout, unknown, infra failure) never supports a
 *   candidate and never counts as success;
 * - every positive outcome claim (merged, tests passed, review approved) is
 *   backed by captured evidence of exactly that kind, so the extractor cannot
 *   fabricate test results, reviewer decisions, or merge state;
 * - the text carries no privilege-expansion / approval-bypass / policy-ignore
 *   / evaluator-directed instructions; a policy violation rejects the whole
 *   batch, not just the offending candidate;
 * - no secret survives minimization (the candidate is dropped), and personal
 *   data is minimized to placeholders before anything can be persisted.
 */

import type {
  CandidateDropReason,
  CandidateValidationResult,
  CapturedOutcome,
  DistillScope,
  DistillationCandidate,
  DistillationOutput,
  DroppedCandidate,
  EvidenceLedger,
  EvidenceLedgerEntry,
  OutcomeClaimKind,
  RedactionReport,
  ValidatedCandidate,
} from "./types.js";
import { detectOutcomeClaims } from "./claims.js";
import { lintForPolicyInstructions } from "./policy.js";
import { assertNoSecretOrPii, redactText, sensitivityFor, snippet } from "./redact.js";
import { ValidationError } from "../control-plane/errors.js";
import type { MemorySensitivity } from "../memory/index.js";

/** Ledger key for one evidence citation. */
export function ledgerKey(evidenceType: string, reference: string): string {
  return `${evidenceType}\u0000${reference}`;
}

/** Model-supplied applicability scope fields; every one takes the redaction path. */
const SCOPE_FIELD_KEYS = ["team_id", "path_prefix", "language", "task_family"] as const;
type ScopeFieldKey = (typeof SCOPE_FIELD_KEYS)[number];

/**
 * Build the ledger of everything captured in one workspace. Duplicate
 * citations collapse to one entry; a reference is only ever what capture
 * recorded from a real outcome envelope, never something a model can add.
 */
export function buildEvidenceLedger(
  captured: readonly Pick<CapturedOutcome, "evidence">[],
): EvidenceLedger {
  const ledger = new Map<string, EvidenceLedgerEntry>();
  for (const outcome of captured) {
    for (const entry of outcome.evidence) {
      const key = ledgerKey(entry.evidence_type, entry.reference);
      if (!ledger.has(key)) {
        ledger.set(key, entry);
      }
    }
  }
  return ledger;
}

function claimSupported(claim: OutcomeClaimKind, cited: readonly EvidenceLedgerEntry[]): boolean {
  switch (claim) {
    case "merged":
      // A merge/acceptance claim needs evidence captured from an
      // accepted/merged outcome. Episode-only outcomes are never success.
      return cited.some((entry) => entry.positive && entry.outcome_class === "accepted");
    case "tests_passed":
      // A test-pass claim needs a retained validation attempt that exited 0;
      // a bare `test` reference without a status proves nothing.
      return cited.some((entry) => entry.evidence_type === "test" && entry.test_passed === true);
    case "review_approved":
      // A review-approval claim needs a captured reviewer decision; no
      // extractor statement can stand in for one.
      return cited.some((entry) => entry.evidence_type === "reviewer_decision");
  }
}

function drop(
  candidate: DistillationCandidate,
  reason: CandidateDropReason,
  detail: string,
): DroppedCandidate {
  return { candidate, reason, detail };
}

/**
 * Validate one parsed distillation output against the captured evidence
 * ledger. Returns the accepted candidates (redacted, with their resolved
 * evidence) and the dropped ones with reasons. When any candidate carries a
 * prohibited instruction the whole batch is rejected: `rejected` is true and
 * the caller must persist nothing.
 */
export function validateCandidates(
  output: DistillationOutput,
  ledger: EvidenceLedger,
): CandidateValidationResult {
  const accepted: ValidatedCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  let rejected = false;

  for (const candidate of output.candidates) {
    const text = [candidate.statement, ...candidate.preconditions].join("\n");

    // 1. Policy lint: prohibited instructions reject the batch outright.
    const violations = lintForPolicyInstructions(text);
    if (violations.length > 0) {
      rejected = true;
      dropped.push(
        drop(
          candidate,
          "policy_violation",
          violations.map((violation) => violation.kind).join(","),
        ),
      );
      continue;
    }

    // 2. Secrets never enter an item; personal data is minimized. Every
    //    model-supplied content field takes the same path — statement,
    //    preconditions, and the applicability scope values alike.
    const redactedStatement = redactText(candidate.statement);
    const redactedPreconditions = candidate.preconditions.map((entry) => redactText(entry));
    const scopeReports: Array<{ key: ScopeFieldKey; report: RedactionReport }> = [];
    for (const key of SCOPE_FIELD_KEYS) {
      const value = candidate.scope[key];
      if (value === undefined) continue;
      scopeReports.push({ key, report: redactText(value) });
    }
    const kinds = new Set([
      ...redactedStatement.kinds,
      ...redactedPreconditions.flatMap((entry) => entry.kinds),
      ...scopeReports.flatMap((entry) => entry.report.kinds),
    ]);
    if (kinds.has("secret")) {
      dropped.push(drop(candidate, "secret_or_pii", "secret material in candidate content"));
      continue;
    }
    const candidateText = [
      redactedStatement.text,
      ...redactedPreconditions.map((entry) => entry.text),
      ...scopeReports.map((entry) => entry.report.text),
    ];
    try {
      for (const line of candidateText) {
        assertNoSecretOrPii(line, "candidate");
      }
    } catch (error) {
      const detail =
        error instanceof ValidationError ? error.message : "candidate failed redaction";
      dropped.push(drop(candidate, "secret_or_pii", snippet(detail)));
      continue;
    }
    const sensitivity: MemorySensitivity = sensitivityFor([...kinds]);
    const redactedScope: DistillScope = {};
    for (const entry of scopeReports) {
      redactedScope[entry.key] = entry.report.text;
    }

    // 3. Evidence: present, resolvable, and attributable to a known outcome.
    if (candidate.evidence.length === 0) {
      dropped.push(drop(candidate, "missing_evidence", "candidate cites no evidence"));
      continue;
    }
    const cited: EvidenceLedgerEntry[] = [];
    let unresolved: string | null = null;
    for (const ref of candidate.evidence) {
      const entry = ledger.get(ledgerKey(ref.evidence_type, ref.reference));
      if (entry === undefined) {
        unresolved = `${ref.evidence_type}:${snippet(ref.reference)}`;
        break;
      }
      cited.push(entry);
    }
    if (unresolved !== null) {
      dropped.push(
        drop(candidate, "unresolved_evidence", `no captured evidence for ${unresolved}`),
      );
      continue;
    }
    if (!cited.some((entry) => entry.known)) {
      dropped.push(
        drop(candidate, "no_known_outcome_evidence", "all cited evidence is episode-only"),
      );
      continue;
    }

    // 4. Outcome claims must resolve to captured evidence of that kind.
    const claims = detectOutcomeClaims(text);
    let unsupported: OutcomeClaimKind | null = null;
    for (const claim of claims) {
      if (!claimSupported(claim, cited)) {
        unsupported = claim;
        break;
      }
    }
    if (unsupported !== null) {
      dropped.push(
        drop(candidate, "unsupported_claim", `${unsupported} claim without captured evidence`),
      );
      continue;
    }

    accepted.push({
      candidate: {
        kind: candidate.kind,
        statement: redactedStatement.text,
        preconditions: redactedPreconditions.map((entry) => entry.text),
        scope: redactedScope,
        evidence: candidate.evidence,
      },
      sensitivity,
      evidence: cited,
    });
  }

  return { accepted, dropped, rejected };
}
