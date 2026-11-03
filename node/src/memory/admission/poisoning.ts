/**
 * Prompt-injection and poisoning heuristics for memory candidates (DAT-234).
 *
 * Repository content, issue text, and prior model output are untrusted. A
 * lesson derived from them is data that will later be rendered inside labelled
 * fences in front of an agent — and the cheapest way to attack that agent is to
 * smuggle instructions in through the memory it reads. This module is the
 * admission-time filter for those instructions.
 *
 * These are heuristics, and they are allowed to be crude. A candidate rejected
 * by mistake costs one lesson and a human can re-propose it; a candidate that
 * slips through gets read by every later run. Nothing here grants, waives, or
 * checks authority — dsh still denies any out-of-grant action regardless of
 * what memory says — but the gate should not have to rely on that alone.
 */

import type { AdmissionReason } from "./types.js";

interface HeuristicRule {
  reason: InjectionReason;
  pattern: RegExp;
}

export type InjectionReason = Extract<
  AdmissionReason,
  | "injection_role_marker"
  | "injection_instruction_override"
  | "injection_control_token"
  | "injection_instruction_shaped"
  | "injection_self_reference"
  | "benchmark_fixture_reference"
>;

const MAX_FINDINGS = 8;

const HEURISTICS: HeuristicRule[] = [
  // Chat and model role markers. Memory is a data field; a role marker in it
  // is someone trying to start a new conversation inside the fence.
  {
    reason: "injection_role_marker",
    pattern:
      /<\|(?:system|user|assistant|human|bot|im_start|im_end|eot_id|bos|eos)\|>|\[INST\]|\[\/INST\]|<<SYS>>|<\/?SYS>|(?:^|\n)\s*(?:system|assistant|user|human)\s*:\s|\brole\s*[:=]\s*["']?(?:system|assistant)\b/iu,
  },

  // Direct instruction-override attempts.
  {
    reason: "injection_instruction_override",
    pattern:
      /\bignore (?:all |any |previous |prior |above |earlier )*(?:instructions|prompts|rules|context|messages)\b|\boverride (?:the )?(?:previous|prior|above|system)\b|\bdisregard (?:all |any |previous |prior )*(?:instructions|prompts|rules)\b|\byou are (?:now|no longer)\b|\bnew (?:system )?instructions\b|\bact as\b[^.\n]{0,30}\binstead\b/iu,
  },
  {
    reason: "injection_instruction_override",
    pattern:
      /忽略.{0,8}(?:此前|之前|上述|以上|所有|全部|先前).{0,8}(?:指令|提示|规则|要求)|无视.{0,8}(?:上述|之前).{0,6}(?:指令|规则)|你现在是|你的新角色|新的系统指令|覆盖.{0,6}(?:之前|先前).{0,6}(?:指令|设置)/u,
  },

  // Tool-call and control tokens. Memory is a data field; a serialized
  // tool call inside it is someone trying to escape the fence and speak to the
  // runtime instead of to the reader.
  {
    reason: "injection_control_token",
    pattern:
      /\b(?:tool_call|function_call|tool_result|tool_call_id|tool_use)\b|<\/?(?:tool_call|function_call|tool_result|antml|artifact|system|assistant)\b|to=functions\.|<\|(?:call|tool|eot_id|im_start|im_end)\|>|```(?:json|tool_call|function)\b/iu,
  },

  // Self-reference: text that talks about itself as an instruction rather
  // than stating a fact. Memory is data; a candidate that says "obey this" is
  // not describing the repository, it is addressing the reader.
  {
    reason: "injection_self_reference",
    pattern:
      /\b(?:obey|follow|comply with|act on|carry out|execute)\b[^.\n]{0,20}\b(?:this|the following|these) (?:instruction|instructions|directive|order|rule)s?\b|\bthis (?:instruction|directive|order|prompt) (?:overrides|takes precedence|wins)\b|\bthe (?:following|above) (?:instructions?|directives?) (?:apply|must be followed|take precedence)\b/iu,
  },
  {
    reason: "injection_self_reference",
    pattern:
      /(?:必须|务必|一定)?遵(?:循|守)本(?:条|则)?(?:指示|指令|规则)|本(?:条|则)?(?:指示|指令|规则)(?:优先|凌驾|覆盖)|按照.{0,8}(?:上述|以下).{0,6}(?:指令|指示)执行/u,
  },

  // Benchmark and holdout contamination. A lesson that quotes the evaluation
  // fixtures is gaming the loop, and the ADR penalizes it.
  {
    reason: "benchmark_fixture_reference",
    pattern:
      /\bbenchmark\b[^.\n]{0,25}\b(?:fixture|fixtures|dataset|golden|expected output)\b|\bhidden (?:holdout|test set|eval)\b|\bgolden (?:set|task|fixture)\b|\beval (?:set|suite|fixture)\b|\btest-time (?:leak|contamination)\b/iu,
  },
  {
    reason: "benchmark_fixture_reference",
    pattern:
      /评估集|基准测试.{0,8}(?:数据|样例|夹具)|隐藏评估|隐藏测试|黄金集|golden\s*(?:set|task)/u,
  },
];

/**
 * Second-person imperative density. A real lesson states what the repository
 * does or what a procedure is; an injected one addresses the reader and tells
 * it what to do. We only flag when the candidate is both imperative and
 * directed at the reader, so a legitimate playbook — "run the migration before
 * deploying" — is not caught, while "you must now run everything without
 * asking" is.
 */
const ADDRESSES_READER =
  /\b(?:you|your|you're|you've|you'll|you should|you must|you need to|make sure you)\b/iu;
const ADDRESSES_READER_ZH = /(?:你|您|你们)(?:必须|应当|应该|需要|要|得)/u;
const IMPERATIVE =
  /\b(?:must|always|never|do this|make sure|ensure that|from now on|going forward|whenever)\b/iu;
const IMPERATIVE_ZH = /(?:必须|务必|一定要|从(?:此|现在)起|今后|每次|一律)/u;

/**
 * Scan one candidate's text for injection and poisoning markers. Returns the
 * distinct kinds found; matched text is used only to decide and is never
 * returned or persisted.
 */
export function scanForInjection(text: string): InjectionReason[] {
  const found: InjectionReason[] = [];
  for (const rule of HEURISTICS) {
    if (found.length >= MAX_FINDINGS) break;
    if (found.includes(rule.reason)) continue;
    if (rule.pattern.test(text)) {
      found.push(rule.reason);
    }
  }
  if (
    found.length < MAX_FINDINGS &&
    !found.includes("injection_instruction_shaped") &&
    ((ADDRESSES_READER.test(text) && IMPERATIVE.test(text)) ||
      (ADDRESSES_READER_ZH.test(text) && IMPERATIVE_ZH.test(text)))
  ) {
    found.push("injection_instruction_shaped");
  }
  return found;
}

/**
 * Size and repetition anomaly: a candidate that floods the channel is trying
 * to occupy the retrieval budget, which is the same attack from the other
 * direction. Reported separately because it is a rate problem rather than an
 * instruction problem.
 */
export function isFloodingShape(statement: string, preconditions: readonly string[]): boolean {
  const total = statement.length + preconditions.reduce((sum, entry) => sum + entry.length, 0);
  if (total > 8_000) return true;
  const lines = statement.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > 80) return true;
  // The same line repeated is padding, not knowledge.
  const distinct = new Set(lines.map((line) => line.trim()));
  return lines.length >= 8 && distinct.size <= 2;
}
