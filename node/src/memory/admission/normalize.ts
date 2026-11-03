/**
 * Statement normalization and comparison (DAT-234).
 *
 * Dedupe and contradiction detection both need "are these two statements about
 * the same thing?". This module answers that with a deliberately boring,
 * deterministic lexical measure rather than an embedding: the gate's decision
 * must be reproducible and testable, and a false "duplicate" merges two
 * distinct memories while a false "not duplicate" merely leaves two items
 * sitting side by side. The measure is therefore tuned to only call two
 * statements alike when they share nearly all of their content words.
 *
 * This is a near-duplicate detector, not a semantic one. An embedding-based
 * comparison belongs with the retrieval index, and can be layered on later
 * without changing the verdict contract.
 */

/** Characters folded away: punctuation and separators carry no meaning here. */
const SEPARATORS =
  /[\s\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65!-/:-@[-`{-~]/u;

/** CJK runs are compared as character bigrams; word runs as whole tokens. */
const CJK = /[㐀-䶿一-鿿豈-﫿]/u;

const MAX_STATEMENT_TOKENS = 400;

/**
 * Normalize a statement to a comparable token list: case-folded, separators
 * stripped, whitespace collapsed. Token order is preserved for the polarity
 * check and discarded for the similarity measure.
 */
export function normalizeTokens(text: string): string[] {
  const folded = text.toLowerCase().normalize("NFKC");
  const tokens: string[] = [];
  for (const chunk of folded.split(SEPARATORS)) {
    if (chunk.length === 0) continue;
    if (CJK.test(chunk)) {
      // A CJK run has no spaces, so compare it as overlapping character
      // bigrams; a single-character run degenerates to that character.
      if (chunk.length === 1) {
        tokens.push(chunk);
        continue;
      }
      for (let index = 0; index + 1 < chunk.length; index += 1) {
        tokens.push(chunk.slice(index, index + 2));
      }
      continue;
    }
    tokens.push(chunk);
    if (tokens.length >= MAX_STATEMENT_TOKENS) break;
  }
  return tokens;
}

/**
 * Token-set Jaccard similarity in `[0, 1]`. Two statements that share every
 * content word score 1 regardless of order; two statements that share none
 * score 0.
 */
export function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Similarity between two raw statements, after normalization. */
export function statementSimilarity(a: string, b: string): number {
  return tokenSimilarity(normalizeTokens(a), normalizeTokens(b));
}

/**
 * Near-duplicate threshold. High on purpose: at 0.8 two statements differ in
 * roughly one content word in five, which is where reworded duplicates live
 * while genuinely distinct facts stay apart.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.8;

/**
 * Contradiction threshold. Two statements this similar are about the same
 * thing; whether they conflict is then decided by polarity alone.
 *
 * There is deliberately no upper bound. The sharpest contradiction there is —
 * "use `npm test`" against "never use `npm test`" — differs by exactly one
 * token and scores near 1.0, so a band that stopped at "rewording" would
 * exclude the case it exists for.
 */
export const CONTRADICTION_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// Polarity
// ---------------------------------------------------------------------------

/**
 * Negation markers, English and Chinese. A statement carrying one of these is
 * asserting that something should *not* be done or is *not* true.
 *
 * The list is intentionally blunt. A missed negation means no contradiction
 * link is drawn — safe. A spurious one costs a human one review — also safe.
 * Nothing here overwrites or deletes anything.
 */
const NEGATIONS = [
  /\bnot\b/u,
  /\bnever\b/u,
  /\bno\b/u,
  /\bdon'?t\b/u,
  /\bdo not\b/u,
  /\bdoes not\b/u,
  /\bcannot\b/u,
  /\bcan'?t\b/u,
  /\bshould not\b/u,
  /\bshouldn'?t\b/u,
  /\bmust not\b/u,
  /\bmustn'?t\b/u,
  /\bavoid\b/u,
  /\brefrain\b/u,
  /\bforbid(?:den)?\b/u,
  /\bdisallow\b/u,
  /\bdeprecated\b/u,
  /\b不再\b/u,
  /\b不要\b/u,
  /\b不用\b/u,
  /\b无需\b/u,
  /\b不能\b/u,
  /\b不可\b/u,
  /\b不应\b/u,
  /\b禁止\b/u,
  /\b避免\b/u,
  /\b别\b/u,
  /\b非\b/u,
];

/** Whether a statement asserts a negation. */
export function hasNegation(text: string): boolean {
  return NEGATIONS.some((pattern) => pattern.test(text));
}

/**
 * True when the two statements are about overlapping content but disagree on
 * polarity — the shape of a contradiction rather than a duplicate.
 */
export function isPolarityFlip(a: string, b: string): boolean {
  return hasNegation(a) !== hasNegation(b);
}
