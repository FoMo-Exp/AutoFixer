/**
 * Evidence resolution for memory candidates (DAT-234).
 *
 * "Every active long-term item has evidence" is an ADR invariant, and the
 * cheap way to violate it is to cite evidence that does not exist. This module
 * checks that a candidate's citations actually resolve against what the
 * workspace's outcome-capture path recorded, and that at least one of them
 * comes from a **known** terminal outcome.
 *
 * The check is only as good as its resolver, so the resolver is injected
 * rather than assumed. A candidate whose citations resolve nowhere is held as
 * `proposed`; a candidate that cites nothing at all is held too. Neither ever
 * reaches retrieval, which is what makes "unvalidated items appear in no
 * bundle" true rather than aspirational.
 */

import type { MemoryEvidenceType } from "../types.js";
import type { CandidateEvidenceRef, EvidenceResolution, EvidenceResolver } from "./types.js";

/**
 * Canonical identity of one evidence citation.
 *
 * A citation is its type **and** its reference, never the reference alone:
 * `pr:42` and `issue:42` are different pieces of evidence that happen to share
 * a reference string. Anything that keeps a set or index of citations uses
 * this one key, so no two call sites can disagree about what identifies what.
 */
export function evidenceKey(evidenceType: MemoryEvidenceType, reference: string): string {
  return `${evidenceType}\u0000${reference}`;
}

/**
 * Build a resolver from an explicit ledger of captured evidence.
 *
 * The ledger is what the outcome-capture path recorded for this workspace.
 * Duplicate citations collapse to one entry; a reference is only ever
 * something capture recorded from a real outcome envelope, never something a
 * model can add.
 */
export function ledgerEvidenceResolver(entries: readonly EvidenceResolution[]): EvidenceResolver {
  const index = new Map<string, EvidenceResolution>();
  for (const entry of entries) {
    const key = evidenceKey(entry.evidence_type, entry.reference);
    if (!index.has(key)) {
      index.set(key, entry);
    }
  }
  return {
    resolve: (ref) => index.get(evidenceKey(ref.evidence_type, ref.reference)),
  };
}

/** A resolver that resolves nothing: the safe default for a caller without a ledger. */
export const emptyEvidenceResolver: EvidenceResolver = {
  resolve: () => undefined,
};

export interface EvidenceCheckResult {
  reasons: ("evidence_missing" | "evidence_unresolved" | "evidence_no_known_outcome")[];
  /** Citations that resolved, in candidate order. */
  resolved: EvidenceResolution[];
}

/**
 * Check a candidate's citations. Reports three distinct failures, because they
 * mean different things to whoever has to fix the candidate:
 *
 * - `evidence_missing` — the candidate cites nothing at all;
 * - `evidence_unresolved` — a citation points at evidence this workspace never
 *   captured, which is exactly the shape of a fabricated reference;
 * - `evidence_no_known_outcome` — everything cited is episode-only (timeout,
 *   unknown delivery, infrastructure failure), which the ADR forbids as
 *   support for a lesson.
 */
export function checkEvidence(
  refs: readonly CandidateEvidenceRef[],
  resolver: EvidenceResolver,
): EvidenceCheckResult {
  const reasons: EvidenceCheckResult["reasons"] = [];
  if (refs.length === 0) {
    return { reasons: ["evidence_missing"], resolved: [] };
  }

  const resolved: EvidenceResolution[] = [];
  for (const ref of refs) {
    const entry = resolver.resolve(ref);
    // Defence in depth at the read side: an implementation that answers with
    // a different type's entry has not resolved *this* citation, whatever its
    // reference says.
    if (entry === undefined || entry.evidence_type !== ref.evidence_type) {
      reasons.push("evidence_unresolved");
      return { reasons, resolved };
    }
    resolved.push(entry);
  }

  if (!resolved.some((entry) => entry.known)) {
    reasons.push("evidence_no_known_outcome");
  }
  return { reasons, resolved };
}
