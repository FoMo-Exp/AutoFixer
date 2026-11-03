/**
 * Duplicate detection for memory candidates (DAT-234).
 *
 * Two ways a candidate can be a repeat of something already remembered:
 *
 * - **Exact.** The canonical content hash matches an existing version. The
 *   hash covers kind, applicability scope, statement, preconditions, and
 *   sensitivity, so an equal hash means identical content. This is what makes
 *   a re-delivered batch idempotent instead of doubling the corpus.
 * - **Near.** The same memory in different words. Detected lexically and
 *   conservatively: same kind, comparable applicability scope, same polarity,
 *   and nearly all content words shared. A merge is the destructive half of
 *   this — two distinct facts collapsed into one is information loss — so the
 *   threshold is high and anything uncertain is simply left as its own item.
 *
 * The cross-scope boundary is part of the question, not a footnote: the same
 * statement under two disjoint applicability scopes is two memories, and the
 * boundary is what stops the hash from merging across it. Cross-workspace
 * comparison never happens at all; the repository layer makes other workspaces
 * invisible to this scan.
 */

import type { MemoryItemRecord } from "../types.js";
import type { AdmissionCandidate, DuplicateFinding } from "./types.js";
import { scopesComparableForDedupe } from "./consistency.js";
import {
  NEAR_DUPLICATE_THRESHOLD,
  isPolarityFlip,
  normalizeTokens,
  tokenSimilarity,
} from "./normalize.js";

function preconditionTokens(entries: readonly string[]): string[] {
  return normalizeTokens(entries.join("\n"));
}

/** Jaccard over the combined precondition text; two empty lists are identical. */
function preconditionSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return tokenSimilarity(preconditionTokens(a), preconditionTokens(b));
}

/**
 * Find the existing item this candidate duplicates, if any.
 *
 * Returns at most one finding — the strongest match — so a caller always knows
 * which item to fold the candidate into. An exact hash match always wins over
 * a near match, because it is the only one that is certain.
 */
export function findDuplicate(
  candidate: AdmissionCandidate,
  candidateHash: string,
  existing: readonly MemoryItemRecord[],
): DuplicateFinding | null {
  let best: DuplicateFinding | null = null;
  let bestScore = -1;

  for (const record of existing) {
    const version = record.current;
    if (!scopesComparableForDedupe(candidate.scope, version.scope)) {
      // Cross-scope boundary: same words, different domain, not a duplicate.
      continue;
    }

    if (version.content_hash === candidateHash) {
      return {
        item_id: record.item.id,
        kind: "exact",
        matched_hash: version.content_hash,
      };
    }

    // A rewording of a claim with the opposite polarity is a contradiction,
    // not a duplicate; contradiction detection owns that case.
    if (isPolarityFlip(candidate.statement, version.statement)) continue;
    if (candidate.kind !== version.kind) continue;

    const statementScore = tokenSimilarity(
      normalizeTokens(candidate.statement),
      normalizeTokens(version.statement),
    );
    const preconditionsScore = preconditionSimilarity(
      candidate.preconditions,
      version.preconditions,
    );
    if (statementScore < NEAR_DUPLICATE_THRESHOLD) continue;
    if (preconditionsScore < NEAR_DUPLICATE_THRESHOLD) continue;

    const score = statementScore + preconditionsScore;
    if (score > bestScore) {
      bestScore = score;
      best = {
        item_id: record.item.id,
        kind: "near",
        matched_hash: version.content_hash,
      };
    }
  }

  return best;
}

/**
 * Is this candidate a duplicate at all, as opposed to a new memory?
 * Exposed separately so callers can gate a whole batch without acting on it.
 */
export function isDuplicate(
  candidate: AdmissionCandidate,
  candidateHash: string,
  existing: readonly MemoryItemRecord[],
): boolean {
  return findDuplicate(candidate, candidateHash, existing) !== null;
}
