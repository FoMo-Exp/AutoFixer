import type {
  RsiApproval,
  RsiEvaluation,
  RsiProposal,
  RsiProposalStatus,
  RsiRisk,
  RsiTarget,
} from "../api/client";

/**
 * RSI is a governed feedback loop: the workbench renders the evidence the
 * server stored and the gate it computed. It never invites a caller to type a
 * score, and a self-grade has no place in the type system (or on screen).
 */

export const RSI_STATUS_ORDER: RsiProposalStatus[] = [
  "proposed",
  "awaiting_approval",
  "ready",
  "canary",
  "promoted",
  "rolled_back",
  "blocked",
];

export const RSI_STATUS_LABELS: Record<RsiProposalStatus, string> = {
  proposed: "Proposed",
  awaiting_approval: "Awaiting approval",
  ready: "Ready for canary",
  canary: "Canary",
  promoted: "Promoted",
  rolled_back: "Rolled back",
  blocked: "Blocked",
};

const RSI_STATUS_TONES: Record<RsiProposalStatus, string> = {
  proposed: "neutral",
  awaiting_approval: "attention",
  ready: "done",
  canary: "active",
  promoted: "done",
  rolled_back: "muted",
  blocked: "danger",
};

export const RISK_ORDER: RsiRisk[] = ["A", "B", "C", "D"];

export const RISK_LABELS: Record<RsiRisk, string> = {
  A: "Class A · low risk",
  B: "Class B · bounded memory",
  C: "Class C · retrieval bounds",
  D: "Class D · forbidden to RSI",
};

export const RISK_LADDER: Record<RsiRisk, { requirement: string; detail: string }> = {
  A: {
    requirement: "Automatic only when enabled",
    detail:
      "Retrieval weights and ranking tiebreakers. The workspace may enable automatic promotion of a passing class A change; otherwise one named human approves it.",
  },
  B: {
    requirement: "One named human",
    detail:
      "A lesson, playbook, or prompt hint needs a passing offline replay and one named human approval.",
  },
  C: {
    requirement: "Two humans · owner + reviewer",
    detail:
      "Retrieval bounds, scope taxonomy, and consolidation thresholds need a passing offline replay and two distinct humans with the owner and reviewer keys.",
  },
  D: {
    requirement: "Rejected by RSI",
    detail:
      "Capability grants, approval rules, the evidence schema, evaluation definitions, safety policy, and merge/deploy are never proposed, evaluated, or promoted through this loop.",
  },
};

export const TARGET_LABELS: Record<RsiTarget, string> = {
  retrieval_weights: "Retrieval weights",
  ranking_tiebreakers: "Ranking tiebreakers",
  lesson: "Lesson",
  playbook: "Playbook",
  prompt_hint: "Prompt hint",
  retrieval_bounds: "Retrieval bounds",
  scope_taxonomy: "Scope taxonomy",
  consolidation_thresholds: "Consolidation thresholds",
  capability_grant: "Capability grant",
  approval_rules: "Approval rules",
  evidence_schema: "Evidence schema",
  evaluation_definition: "Evaluation definition",
  safety_policy: "Safety policy",
  merge_deploy: "Merge / deploy",
};

export const APPROVAL_KEY_LABELS: Record<RsiApproval["approval_key"], string> = {
  single: "Single approval",
  owner: "Owner key",
  reviewer: "Reviewer key",
};

export const VERDICT_LABELS: Record<RsiEvaluation["verdict"], string> = {
  pass: "Pass",
  fail: "Fail",
  inconclusive: "Inconclusive",
};

const VERDICT_TONES: Record<RsiEvaluation["verdict"], string> = {
  pass: "done",
  fail: "danger",
  inconclusive: "attention",
};

export const HOLDOUT_NOTE =
  "The hidden holdout is read-only to the learning loop. Only its aggregate sample counts and evaluation time are exposed; case content is never part of any response or rendered here.";

export const GATE_NOTE =
  "The server computes the verdict, confidence interval, required approval keys, and canary eligibility. This view cannot submit a score, and a self-report is not a verifier.";

export function rsiStatusLabel(status: string): string {
  return RSI_STATUS_LABELS[status as RsiProposalStatus] ?? `Unknown proposal status (${status})`;
}

export function rsiStatusTone(status: string): string {
  return RSI_STATUS_TONES[status as RsiProposalStatus] ?? "unknown";
}

export function rsiTargetLabel(target: string): string {
  return TARGET_LABELS[target as RsiTarget] ?? `Unknown target (${target})`;
}

export function rsiRiskLabel(risk: string): string {
  return RISK_LABELS[risk as RsiRisk] ?? `Unknown risk class (${risk})`;
}

export function verdictTone(verdict: string): string {
  return VERDICT_TONES[verdict as RsiEvaluation["verdict"]] ?? "unknown";
}

export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict as RsiEvaluation["verdict"]] ?? `Unknown verdict (${verdict})`;
}

/** Group evaluations by dataset without assuming arrival order. */
export function evaluationsByDataset(evaluations: RsiEvaluation[]): {
  golden: RsiEvaluation[];
  holdout: RsiEvaluation[];
} {
  return {
    golden: evaluations.filter((entry) => entry.dataset === "golden"),
    holdout: evaluations.filter((entry) => entry.dataset === "holdout"),
  };
}

export interface RsiEvidenceRisk {
  safetyEvents: number;
  regressions: RsiEvaluation[];
  failed: RsiEvaluation[];
}

/** Surface real failure and security evidence instead of burying it in a table. */
export function evidenceRisk(proposal: RsiProposal): RsiEvidenceRisk {
  return {
    safetyEvents: proposal.evaluations.reduce((sum, entry) => sum + entry.safety_events, 0),
    regressions: proposal.evaluations.filter((entry) => entry.success_delta < 0),
    failed: proposal.evaluations.filter((entry) => entry.verdict === "fail"),
  };
}

export function formatRate(successes: number, sample: number): string {
  if (sample <= 0) return "—";
  return `${((successes / sample) * 100).toFixed(1)}%`;
}

export function formatSignedPercent(value: number, digits = 2): string {
  const points = value * 100;
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(digits)} pp`;
}

export function formatInterval(low: number, high: number): string {
  return `[${(low * 100).toFixed(2)}, ${(high * 100).toFixed(2)}] pp`;
}

export function formatCost(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function stageLabel(stage: number): string {
  return stage === 100 ? "100% · full" : `${stage}% canary`;
}

export interface RsiError {
  code: string;
  message: string;
  missing: boolean;
  forbidden: boolean;
}

export function describeRsiError(caught: unknown): RsiError {
  if (caught instanceof Error && "status" in caught && typeof caught.status === "number") {
    const error = caught as Error & { status: number; code?: string };
    return {
      code: error.code ?? "REQUEST_FAILED",
      message: error.message,
      missing: error.status === 404,
      forbidden: error.status === 403,
    };
  }
  return {
    code: "REQUEST_FAILED",
    message: caught instanceof Error ? caught.message : "The RSI request failed.",
    missing: false,
    forbidden: false,
  };
}
