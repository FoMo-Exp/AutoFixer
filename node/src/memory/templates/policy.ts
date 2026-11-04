/**
 * Template policy lint (DAT-237).
 *
 * A template is advisory memory published by one workspace and adopted by
 * another. It may never carry an instruction that expands permissions, claims
 * an approval, bypasses a gate, or addresses an evaluator — publication fails
 * closed on any such text, whatever the source item's status was.
 *
 * The same lint runs at publication and again at adoption, because a template
 * row is data: even though it is immutable through this module, adoption does
 * not assume the row was never tampered with.
 */

import { PROCEDURAL_TEMPLATE_KINDS, type EnterpriseTemplateKind } from "./types.js";

export type TemplatePolicyViolationCode =
  | "capability_expansion"
  | "approval_bypass"
  | "approval_claim"
  | "test_or_policy_bypass"
  | "evaluator_instruction"
  | "instruction_injection";

export interface TemplatePolicyViolation {
  code: TemplatePolicyViolationCode;
  field: "statement" | "preconditions";
}

interface PolicyRule {
  code: TemplatePolicyViolationCode;
  pattern: RegExp;
  /** Negated guidance ("never skip the test gate") is not an instruction to skip. */
  negation_exempt: boolean;
}

const NEGATION_PREFIX =
  /\b(?:never|not|avoid|without|do not|don't|must not|cannot|should not)\b[^.\n]{0,12}$/i;

/** Closed rule set; exported so the contract doc and tests stay aligned. */
export const TEMPLATE_POLICY_RULES: readonly PolicyRule[] = [
  {
    code: "capability_expansion",
    pattern:
      /\b(?:grant|granting|escalate|escalating|elevate|elevating|expand|expanding|widen|widen(?:ing)?|increase|increasing)\b[^.\n]{0,40}\b(?:permissions?|privileges?|capabilit(?:y|ies)|access|grants?|scopes?|roles?)\b/gi,
    negation_exempt: true,
  },
  {
    code: "approval_bypass",
    pattern:
      /\b(?:bypass|bypassing|skip|skipping|ignore|ignoring|disable|disabling|circumvent|waive|waiving|remove|removing)\b[^.\n]{0,40}\b(?:approvals?|reviews?|human review|change gates?|guardrails?)\b/gi,
    negation_exempt: true,
  },
  {
    code: "test_or_policy_bypass",
    pattern:
      /\b(?:bypass|bypassing|skip|skipping|ignore|ignoring|disable|disabling|circumvent|waive|waiving|turn off)\b[^.\n]{0,40}\b(?:tests?|test gates?|test suites?|policy|policies|sandbox(?:ing)?|audit(?:ing)?|dsh)\b/gi,
    negation_exempt: true,
  },
  {
    code: "approval_claim",
    pattern:
      /\b(?:auto[- ]?approved|self[- ]?approved|pre[- ]?approved|approval (?:is )?(?:not required|unnecessary)|no approval (?:is )?(?:needed|required))\b/gi,
    negation_exempt: false,
  },
  {
    code: "approval_claim",
    pattern:
      /\b(?:approved|authorized|waived)\b[^.\n]{0,30}\bby\b[^.\n]{0,30}\b(?:agent|assistant|model|ai|automation|template|system)\b/gi,
    negation_exempt: false,
  },
  {
    code: "evaluator_instruction",
    pattern:
      /\b(?:ignore|ignoring|disregard|disregarding|override|overriding|mark|score|report|treat|inflate|suppress|select)\b[^.\n]{0,60}\b(?:evaluator|grader|grading|rubric|holdout|golden set)\b/gi,
    negation_exempt: true,
  },
  {
    code: "evaluator_instruction",
    pattern:
      /\b(?:evaluator|grader|grading|rubric|holdout|golden set)\b[^.\n]{0,60}\b(?:ignore|disregard|override|always pass|always succeed|never fail)\b/gi,
    negation_exempt: true,
  },
  {
    code: "instruction_injection",
    pattern:
      /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?|system prompt|developer message|you are now\b/gi,
    negation_exempt: false,
  },
  { code: "instruction_injection", pattern: /<\|[^|\n]*\|>/g, negation_exempt: false },
];

/** True when the match is preceded by a negation, e.g. "never skip tests". */
function isNegated(text: string, matchIndex: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  return NEGATION_PREFIX.test(prefix);
}

function lintField(
  text: string,
  field: TemplatePolicyViolation["field"],
  violations: TemplatePolicyViolation[],
): void {
  for (const rule of TEMPLATE_POLICY_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (rule.negation_exempt && isNegated(text, index)) {
        continue;
      }
      const violation = { code: rule.code, field };
      if (!violations.some((entry) => entry.code === rule.code && entry.field === field)) {
        violations.push(violation);
      }
    }
  }
}

/**
 * Lint scrubbed template content. Publication/adoption throws on any
 * violation; the codes — not the offending text — are safe to log and return.
 */
export function lintTemplateContent(content: {
  statement: string;
  preconditions: readonly string[];
}): TemplatePolicyViolation[] {
  const violations: TemplatePolicyViolation[] = [];
  lintField(content.statement, "statement", violations);
  for (const precondition of content.preconditions) {
    lintField(precondition, "preconditions", violations);
  }
  return violations;
}

export function assertTemplatePolicyClean(content: {
  statement: string;
  preconditions: readonly string[];
}): void {
  const violations = lintTemplateContent(content);
  if (violations.length > 0) {
    const codes = [...new Set(violations.map((violation) => violation.code))].join(", ");
    throw new TemplatePolicyError(violations, codes);
  }
}

/** Stable error surface for handlers: codes without the offending content. */
export class TemplatePolicyError extends Error {
  readonly code = "TEMPLATE_POLICY_VIOLATION";
  readonly violations: readonly TemplatePolicyViolation[];

  constructor(violations: readonly TemplatePolicyViolation[], codes: string) {
    super(`template content violates policy: ${codes}`);
    this.name = "TemplatePolicyError";
    this.violations = violations;
  }
}

/** Template kinds that need a named security review before publication. */
export function requiresSecurityReview(kind: EnterpriseTemplateKind): boolean {
  return PROCEDURAL_TEMPLATE_KINDS.includes(kind);
}
