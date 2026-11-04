/**
 * Policy lint for distilled candidates (DAT-233).
 *
 * A memory item is advisory data and can never move the gate: a candidate that
 * carries instructions to expand permissions, bypass change approval, ignore
 * policy, or address the evaluator is rejected outright. This is a lint over
 * candidate text — the dsh control plane remains the only enforcement point,
 * and nothing here grants, waives, or checks authority.
 *
 * The patterns are blunt and bilingual (English and Chinese) on purpose: a
 * dropped candidate costs one lesson, a poisoned one costs the workspace.
 */

import type { PolicyViolation, PolicyViolationKind } from "./types.js";
import { snippet } from "./redact.js";

interface LintRule {
  kind: PolicyViolationKind;
  pattern: RegExp;
}

/** Bounded number of reported violations per candidate. */
const VIOLATIONS_MAX = 8;

const LINT_RULES: LintRule[] = [
  {
    kind: "privilege_expansion",
    pattern:
      /\b(?:grant|elevate|expand|escalate|add|raise)\b[^.\n]{0,40}\b(?:permission|capability|scope|access|privilege|right)s?\b|\b(?:admin|root|sudo)\b[^.\n]{0,20}\b(?:access|rights?)\b/gi,
  },
  {
    kind: "privilege_expansion",
    pattern: /扩权|提权|提升权限|扩大.{0,6}(?:权限|范围)|授予.{0,10}(?:权限|能力|访问)/g,
  },
  {
    kind: "approval_bypass",
    pattern:
      /\b(?:bypass|skip|avoid|circumvent|waive|ignore)\b[^.\n]{0,30}\b(?:approval|review|gate|check|quorum|merge queue)\b|\bmerge\b[^.\n]{0,20}\bwithout\b/gi,
  },
  {
    kind: "approval_bypass",
    pattern: /绕过.{0,8}(?:审批|批准|评审|闸门|检查)|跳过.{0,8}(?:审批|评审|检查|批准)/g,
  },
  {
    kind: "policy_ignore",
    pattern:
      /\b(?:ignore|disregard|override|suppress)\b[^.\n]{0,30}\b(?:policy|policies|rule|rules|instruction|instructions|guardrail|AGENTS\.md)\b/gi,
  },
  {
    kind: "policy_ignore",
    pattern: /忽略.{0,8}(?:策略|政策|规则|指令|约束)|无视.{0,8}(?:策略|规则|约束)/g,
  },
  {
    kind: "evaluator_directed",
    pattern:
      /\bevaluators?\b|\bgraders?\b|\bhidden holdout\b|\bsystem prompt\b|\bignore (?:all |any |previous |prior )*(?:instructions|prompts)\b|\bwhen (?:you|the) (?:evaluate|evaluating|grade|grading)\b/gi,
  },
  {
    kind: "evaluator_directed",
    pattern:
      /评估器|评估者|评分器|评分者|隐藏评估集|忽略.{0,6}(?:此前|之前|上述).{0,6}指令|系统提示词/g,
  },
];

/**
 * Scan one candidate text for prohibited instructions. Returns every distinct
 * violation kind with a bounded snippet of what matched; the snippet is for
 * the drop record only and is never persisted.
 */
export function lintForPolicyInstructions(text: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const seen = new Set<string>();
  for (const rule of LINT_RULES) {
    if (violations.length >= VIOLATIONS_MAX) break;
    const match = text.match(rule.pattern);
    if (match === null) continue;
    for (const hit of match) {
      const key = `${rule.kind}\u0000${hit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ kind: rule.kind, match: snippet(hit) });
      if (violations.length >= VIOLATIONS_MAX) break;
    }
  }
  return violations;
}
