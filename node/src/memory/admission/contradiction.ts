/**
 * Contradiction detection for memory candidates (DAT-234).
 *
 * A contradiction is a claim that fights something already remembered. The ADR
 * is emphatic about what must *not* happen next: no silent overwrite, no
 * confidence won by a model's own assertion, no quietly retiring the older
 * item because a newer one showed up. What must happen is visible and
 * conservative:
 *
 * - a `contradicts` link between the two items;
 * - a lower confidence on both, from a real evidence count rather than a score;
 * - a proposal to deprecate or supersede one of them, which a human or the
 *   consolidation job accepts or rejects;
 * - and neither side injected as fact while the conflict stands.
 *
 * Detection itself is a heuristic — same ground, opposite polarity — and that
 * is acceptable precisely because the response is this conservative. A false
 * positive costs a reviewer one decision and changes no content; a false
 * negative simply draws no link. Nothing in this file mutates anything.
 */

import type { MemoryApplicability, MemoryItemId, MemoryItemRecord, MemoryTrust } from "../types.js";
import type { ContradictionFinding, RetirementCandidate } from "./types.js";
import { scopesMayOverlap } from "./consistency.js";
import {
  CONTRADICTION_THRESHOLD,
  isPolarityFlip,
  normalizeTokens,
  tokenSimilarity,
} from "./normalize.js";

/** How many contradictions against one candidate are worth reporting. */
const MAX_CONTRADICTIONS = 8;

/**
 * Trust rank, higher is stronger. Used only to decide which of two conflicting
 * claims would replace the other — never to skip a gate or grant anything.
 */
const TRUST_RANK: Record<MemoryTrust, number> = {
  human: 3,
  system: 2,
  enterprise_template: 1,
  agent: 0,
};

/**
 * Find existing items this candidate contradicts.
 *
 * The candidate must be about the same thing as the existing item — the two
 * statements sit inside the contradiction similarity band — and must assert
 * the opposite polarity. Their applicability scopes must be able to cover the
 * same situation; two claims that can never meet are not in conflict.
 */
export function findContradictions(
  candidateStatement: string,
  candidatePreconditions: readonly string[],
  candidateScope: MemoryApplicability,
  existing: readonly MemoryItemRecord[],
): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  const candidateTokens = normalizeTokens(candidateStatement);

  for (const record of existing) {
    if (findings.length >= MAX_CONTRADICTIONS) break;
    const version = record.current;

    if (!scopesMayOverlap(candidateScope, version.scope)) continue;
    if (!isPolarityFlip(candidateStatement, version.statement)) continue;

    const score = tokenSimilarity(candidateTokens, normalizeTokens(version.statement));
    if (score < CONTRADICTION_THRESHOLD) continue;

    // Distinct preconditions mean two different situations, and two claims can
    // disagree about different situations without being in conflict.
    const preconditionScore = tokenSimilarity(
      normalizeTokens(candidatePreconditions.join("\n")),
      normalizeTokens(version.preconditions.join("\n")),
    );
    if (preconditionScore < CONTRADICTION_THRESHOLD) continue;

    findings.push({
      item_id: record.item.id,
      reason: "contradiction_detected",
      scope_overlap: true,
    });
  }

  return findings;
}

/**
 * Turn findings into retirement proposals.
 *
 * The proposal names which item to retire and, when the incoming claim is at
 * least as strong as the one it contradicts, which item would take its place.
 * When the incoming claim is weaker the proposal is a plain deprecation with
 * no successor, because a weaker claim must not be allowed to retire a
 * stronger one even indirectly.
 *
 * Nothing is executed here. Both forms land as `pending`, and a human or the
 * consolidation job accepts or rejects them. This is what "no silent
 * overwrite" means in practice.
 */
export function retirementProposalsFor(
  contradictions: readonly ContradictionFinding[],
  options: {
    /** Item id the incoming claim became, or null when it became no item. */
    successorItemId: MemoryItemId | null;
    successorTrust: MemoryTrust;
    /** Trust of the item being contradicted. */
    trustOf: (itemId: MemoryItemId) => MemoryTrust;
  },
): RetirementCandidate[] {
  return contradictions.map((finding) => {
    const existingTrust = options.trustOf(finding.item_id);
    const maySupersede =
      options.successorItemId !== null &&
      TRUST_RANK[options.successorTrust] >= TRUST_RANK[existingTrust];
    return {
      item_id: finding.item_id,
      successor_item_id: maySupersede ? options.successorItemId : null,
      proposed_action: maySupersede ? "supersede" : "deprecate",
      reason: finding.reason,
    };
  });
}
