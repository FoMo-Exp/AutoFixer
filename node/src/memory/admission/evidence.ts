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

import type { CandidateEvidenceRef, EvidenceResolution, EvidenceResolver } from "./types.js";

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
    const key = `${entry.evidence_type} ${entry.reference}`;
    if (!index.has(key)) {
      index.set(key, entry);
    }
  }
  return {
    resolve(refs: readonly CandidateEvidenceRef[]) {
      const resolved = new Map<string, EvidenceResolution | undefined>();
      for (const ref of refs) {
        resolved.set(ref.reference, index.get(`${ref.evidence_type} ${ref.reference}`));
      }
      return resolved;
    },
  };
}

/** A resolver that resolves nothing: the safe default for a caller without a ledger. */
export const emptyEvidenceResolver: EvidenceResolver = {
  resolve(refs: readonly CandidateEvidenceRef[]) {
    const resolved = new Map<string, EvidenceResolution | undefined>();
    for (const ref of refs) {
      resolved.set(ref.reference, undefined);
    }
    return resolved;
  },
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
  const lookedUp = resolver.resolve(refs);
  for (const ref of refs) {
    const entry = lookedUp.get(ref.reference);
    if (entry === undefined) {
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
