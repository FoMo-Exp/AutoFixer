/**
 * Policy lint over candidate text (DAT-234).
 *
 * Memory is advisory data and can never move the gate: a candidate carrying
 * instructions to expand permissions, claim or bypass approval, skip tests or
 * review, ignore policy, or address the evaluator is rejected outright. The
 * dsh control plane remains the only enforcement point — nothing here grants,
 * waives, or checks authority — but a lesson that tries to talk the next run
 * into relaxing a gate never gets to be memory.
 *
 * The patterns are blunt and bilingual (English and Chinese) on purpose: a
 * dropped candidate costs one lesson, a poisoned one costs the workspace. This
 * is the admission-time gate and runs on every candidate regardless of source;
 * the distillation-time lint on the capture path is a separate, earlier line
 * of defence and is not a substitute for this one.
 *
 * Patterns carry no `g` flag: they are only ever used with `test()`, which
 * would otherwise leave `lastIndex` behind and make the second scan of the
 * same text return different answers.
 */

import type { AdmissionReason } from "./types.js";

/** The subset of reason codes this lint can produce. */
export type PolicyReason = Extract<
  AdmissionReason,
  | "policy_privilege_expansion"
  | "policy_approval_claim"
  | "policy_approval_bypass"
  | "policy_test_gate_bypass"
  | "policy_ignore"
  | "policy_evaluator_directed"
>;

interface LintRule {
  reason: PolicyReason;
  pattern: RegExp;
}

const LINT_RULES: LintRule[] = [
  // ---- privilege expansion ------------------------------------------------
  {
    reason: "policy_privilege_expansion",
    pattern:
      /\b(?:grant|elevate|expand|escalate|add|raise|give|allow)\b[^.\n]{0,40}\b(?:permission|capability|scope|access|privilege|right|role|admin)s?\b|\b(?:admin|root|sudo|superuser)\b[^.\n]{0,20}\b(?:access|rights?|privileges?)\b/iu,
  },
  {
    reason: "policy_privilege_expansion",
    pattern:
      /扩权|提权|提升权限|扩大.{0,6}(?:权限|范围)|授予.{0,10}(?:权限|能力|访问)|加白|放开.{0,6}(?:权限|限制)/u,
  },

  // ---- approval claims ----------------------------------------------------
  // A lesson that *asserts* something is approved claims an authority it does
  // not have. Approval lives in the review record, never in memory text.
  {
    reason: "policy_approval_claim",
    pattern:
      /\b(?:approved|preapproved|pre-approved|signed ?off|lgtm|rubber[- ]?stamped)\b[^.\n]{0,20}\b(?:by|for|already)\b|\b(?:this|the) (?:change|pr|patch|merge) (?:is|was|has been) approved\b|\bno (?:further |more )?(?:review|approval) (?:is )?(?:needed|required|necessary)\b/iu,
  },
  {
    reason: "policy_approval_claim",
    pattern:
      /已(?:经)?批准|已(?:经)?审批|已(?:经)?通过审批|批准通过|审批通过|无需.{0,6}(?:审批|评审|批准|审核)|免审|免批|评审已通过/u,
  },

  // ---- approval bypass ----------------------------------------------------
  {
    reason: "policy_approval_bypass",
    pattern:
      /\b(?:bypass|skip|avoid|circumvent|waive|ignore|sidestep|work around)\b[^.\n]{0,30}\b(?:approval|review|gate|check|quorum|merge queue|sign[- ]?off)\b|\bmerge\b[^.\n]{0,20}\bwithout\b/iu,
  },
  {
    reason: "policy_approval_bypass",
    pattern: /绕过.{0,8}(?:审批|批准|评审|闸门|检查|门禁)|跳过.{0,8}(?:审批|评审|检查|批准|审核)/u,
  },

  // ---- test gate bypass ---------------------------------------------------
  {
    reason: "policy_test_gate_bypass",
    pattern:
      /\b(?:skip|disable|bypass|turn off|shut off|stub out|delete|remove|comment out|neutralize|force)\b[^.\n]{0,30}\btests?\b|\btests?\b[^.\n]{0,25}\b(?:are|is|can be|may be) (?:optional|skipped|disabled|ignored)\b|\bdo not run (?:the )?tests?\b|\bno need to (?:run )?tests?\b/iu,
  },
  {
    reason: "policy_test_gate_bypass",
    pattern:
      /跳过.{0,8}(?:测试|单测|用例)|禁用.{0,8}(?:测试|用例)|关闭.{0,6}测试|删掉.{0,6}(?:测试|用例)|测试.{0,6}(?:可选|不必|不用)跑|无需.{0,6}(?:跑)?测试|把测试.{0,6}(?:改|删)/u,
  },

  // ---- policy ignore ------------------------------------------------------
  {
    reason: "policy_ignore",
    pattern:
      /\b(?:ignore|disregard|override|suppress|bypass|drop|forget)\b[^.\n]{0,30}\b(?:policy|policies|rule|rules|instruction|instructions|guardrail|constraint|AGENTS\.md|CLAUDE\.md)\b/iu,
  },
  {
    reason: "policy_ignore",
    pattern:
      /忽略.{0,8}(?:策略|政策|规则|指令|约束)|无视.{0,8}(?:策略|规则|约束)|绕过.{0,6}(?:策略|约束)|作废.{0,6}(?:规则|约束)/u,
  },

  // ---- evaluator-directed text -------------------------------------------
  {
    reason: "policy_evaluator_directed",
    pattern:
      /\bevaluators?\b|\bgraders?\b|\bhidden holdout\b|\bholdout set\b|\bgolden set\b|\bsystem prompt\b|\bignore (?:all |any |previous |prior )*(?:instructions|prompts)\b|\bwhen (?:you|the) (?:evaluate|evaluating|grade|grading)\b|\bfor (?:the )?(?:grader|evaluator|reviewer) to (?:see|pass|accept)\b/iu,
  },
  {
    reason: "policy_evaluator_directed",
    pattern:
      /评估器|评估者|评分器|评分者|隐藏评估集|隐藏测试集|评估集|忽略.{0,6}(?:此前|之前|上述).{0,6}指令|系统提示词|系统提示|让(?:评审|评分|评估).{0,8}(?:通过|满意)/u,
  },
];

/**
 * Scan candidate text for prohibited instructions. Returns the distinct
 * violation kinds found; the matched text is used only to decide and is never
 * returned or persisted.
 */
export function lintForPolicyInstructions(text: string): PolicyReason[] {
  const found: PolicyReason[] = [];
  for (const rule of LINT_RULES) {
    if (found.includes(rule.reason)) continue;
    if (rule.pattern.test(text)) {
      found.push(rule.reason);
    }
  }
  return found;
}
