/**
 * Quarantine redaction (DAT-251).
 *
 * A `quarantined` item is suspected poisoned, secret-leaking, or otherwise
 * unsafe. Its content must not be served by the governance or browse surfaces
 * — not the current statement, not a historical statement, not a precondition,
 * and not the evidence reference (which can itself embed a URL, run id, or
 * pasted material). What survives is the shape needed to *manage* the item:
 * `statement: null` plus `statement_redacted: true`, an empty precondition
 * list, and evidence reduced to its type plus a one-way identifier.
 *
 * The redaction is one-way by design. v1 has no route that returns a
 * quarantined item's original content; ADR-0009 requires separately
 * authorized access to quarantine and evidence, and this surface has no such
 * grant.
 */

import { createHash } from "node:crypto";

import type { MemoryEvidence, MemoryEvidenceType, MemoryStatus } from "./types.js";

/** Evidence pair as served by any memory read surface. */
export interface ServedEvidence {
  evidence_type: MemoryEvidenceType;
  reference: string;
}

/** Prefix marking an evidence reference that has been replaced by a digest. */
export const REDACTED_EVIDENCE_PREFIX = "sha256:";

/**
 * Stable one-way identifier for a redacted evidence reference. The digest is
 * deterministic so the same citation still lines up across responses, and
 * truncated so it is an identifier rather than an archive of the original.
 */
export function opaqueEvidenceReference(reference: string): string {
  return `${REDACTED_EVIDENCE_PREFIX}${createHash("sha256")
    .update(reference, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export function isQuarantined(status: MemoryStatus): boolean {
  return status === "quarantined";
}

/** Statement as served: null with an explicit redaction marker when quarantined. */
export function servedStatement(
  status: MemoryStatus,
  statement: string,
): { statement: string | null; statement_redacted: boolean } {
  if (isQuarantined(status)) {
    return { statement: null, statement_redacted: true };
  }
  return { statement, statement_redacted: false };
}

export function servedPreconditions(status: MemoryStatus, preconditions: string[]): string[] {
  return isQuarantined(status) ? [] : [...preconditions];
}

/**
 * Evidence as served. Quarantine keeps the evidence class (a reviewer needs to
 * know a security report named the item) but replaces the reference with its
 * one-way identifier, and never echoes a note.
 */
export function servedEvidence(
  status: MemoryStatus,
  evidence: ReadonlyArray<Pick<MemoryEvidence, "evidence_type" | "reference">>,
): ServedEvidence[] {
  return evidence.map((entry) => ({
    evidence_type: entry.evidence_type as MemoryEvidenceType,
    reference: isQuarantined(status) ? opaqueEvidenceReference(entry.reference) : entry.reference,
  }));
}
