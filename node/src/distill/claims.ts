/**
 * Outcome-claim detection for distilled candidates (DAT-233).
 *
 * The extractor cannot invent test results, reviewer decisions, or merge
 * state. Every positive outcome claim in a candidate — "the PR was merged",
 * "the tests passed", "the reviewer approved" — must resolve to captured
 * evidence of exactly that kind from a known outcome; anything else is an
 * unsupported claim and the candidate is dropped. Negated claims ("the tests
 * did not pass") are observations, not assertions of success, and are allowed
 * to cite failure evidence.
 *
 * The detector is a bounded pattern scan with a negation window. It can only
 * ever add a rejection here — a missed pattern is caught by the evidence
 * requirement, never turned into an allowance.
 */

import type { OutcomeClaimKind } from "./types.js";

interface ClaimRule {
  kind: OutcomeClaimKind;
  pattern: RegExp;
  /** Words that turn a nearby match into a negated (non-)claim. */
  negation: RegExp;
}

const NEGATION =
  /\b(?:not|never|no|without|fail(?:s|ed|ure)?|pending|revert(?:ed)?|unmerged|blocked|refused)\b|未|没|不|失败|拒绝|尚未|还没/gi;

const CLAIM_RULES: ClaimRule[] = [
  {
    kind: "merged",
    pattern:
      /\bmerged\b|\baccepted\b|\blanded\b|(?:已)?(?:合入|合并到?)主干|(?:变更|补丁|PR).{0,10}(?:已)?(?:合入|合并|被接受)/gi,
    negation: NEGATION,
  },
  {
    kind: "tests_passed",
    pattern:
      /\btests?[^.\n]{0,24}\bpass(?:ed)?\b|\btests? (?:are green|green)\b|测试(?:全部)?通过|测试全绿|全部测试通过/gi,
    negation: NEGATION,
  },
  {
    kind: "review_approved",
    pattern:
      /\breview(?:er)?s? (?:approved|approval)\b|\bapproved by (?:the )?review\w*\b|评审通过|评审批准|审批通过|批准合入/gi,
    negation: NEGATION,
  },
];

/** Bounded window around a match in which a negation cancels the claim. */
const NEGATION_WINDOW = 48;

/**
 * Detect positive outcome claims in one candidate text. A match whose nearby
 * context negates it is not a claim. Returns the distinct claim kinds.
 */
export function detectOutcomeClaims(text: string): OutcomeClaimKind[] {
  const claims = new Set<OutcomeClaimKind>();
  for (const rule of CLAIM_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      const start = Math.max(0, index - NEGATION_WINDOW);
      const end = Math.min(text.length, index + match[0].length + NEGATION_WINDOW);
      const window = text.slice(start, end);
      const negation = new RegExp(rule.negation.source, rule.negation.flags);
      if (negation.test(window)) continue;
      claims.add(rule.kind);
    }
  }
  return [...claims];
}
