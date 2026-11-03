/**
 * Deterministic intake rule engine (DAT-216).
 *
 * Before any model analysis, plain ordered rules select the canonical
 * severity, service, environment, error-signature inputs, rate/window policy,
 * suppression, and repository mapping. There is no scoring, no randomness,
 * and no model call in this layer: the same inputs and the same rule config
 * always produce the same decision, with every contributing rule recorded for
 * audit.
 *
 * Mapping is deliberately fail-closed: a repository is named only when every
 * matching rule agrees on exactly one repository. Zero matches or conflicting
 * candidates produce `unmapped`/`ambiguous` and the signal goes to triage —
 * the engine never guesses.
 */

export type CanonicalSeverity = "critical" | "error" | "warning" | "info";

const SEVERITY_LADDER: CanonicalSeverity[] = ["info", "warning", "error", "critical"];

const DEFAULT_RATE_WINDOW_SECONDS = 300;

/** Repository identity an intake issue can be opened against. */
export interface RepositoryCandidate {
  repository_id: string;
  url: string;
  base_ref: string;
  base_sha: string;
}

/** Match on provider-native fields; an absent matcher is a wildcard. */
export interface RuleMatch {
  provider_severity_in?: string[];
  provider_service_in?: string[];
  provider_environment_in?: string[];
  error_class_in?: string[];
  label_equals?: Record<string, string>;
}

export interface RuleDecisionFields {
  severity?: CanonicalSeverity;
  service?: string;
  environment?: string;
  rate_window_seconds?: number;
  rate_escalate_at?: number;
  suppress?: { reason: string };
  repositories?: RepositoryCandidate[];
}

export interface IntakeRule {
  rule_id: string;
  match: RuleMatch;
  decision: RuleDecisionFields;
}

export interface RuleConfig {
  /** Policy version recorded on every decision. */
  version: string;
  rules: IntakeRule[];
}

export interface RuleEvaluationInput {
  provider_severity: string;
  provider_service: string;
  provider_environment: string;
  error_class: string;
  error_signature: string;
  labels: Record<string, string>;
}

export interface RateObservation {
  /** Occurrences of this signal inside the selected window. */
  count_in_window: number;
}

export type RepositoryMappingStatus = "mapped" | "unmapped" | "ambiguous";

export interface RepositoryMapping {
  status: RepositoryMappingStatus;
  /** Set only when `status` is `mapped`. */
  repository: RepositoryCandidate | null;
  /** Every distinct candidate any matching rule named. */
  candidates: RepositoryCandidate[];
  /** Rules that contributed a repository decision. */
  rule_ids: string[];
}

export interface SuppressionDecision {
  rule_id: string;
  reason: string;
}

export interface SignalDecision {
  policy_version: string;
  /** Every matching rule, in config order. */
  rule_ids: string[];
  severity: CanonicalSeverity;
  service: string;
  environment: string;
  error_signature: string;
  rate_window_seconds: number;
  rate_escalate_at: number | null;
  rate_count: number;
  suppression: SuppressionDecision | null;
  repository_mapping: RepositoryMapping;
}

function matchesIn(values: string[] | undefined, actual: string): boolean {
  if (values === undefined) {
    return true;
  }
  const wanted = actual.toLowerCase();
  return values.some((value) => value.toLowerCase() === wanted);
}

function ruleMatches(rule: IntakeRule, input: RuleEvaluationInput): boolean {
  const match = rule.match;
  return (
    matchesIn(match.provider_severity_in, input.provider_severity) &&
    matchesIn(match.provider_service_in, input.provider_service) &&
    matchesIn(match.provider_environment_in, input.provider_environment) &&
    matchesIn(match.error_class_in, input.error_class) &&
    Object.entries(match.label_equals ?? {}).every(([key, value]) => input.labels[key] === value)
  );
}

/** Provider severity fallback table; unknown tokens map to `error`. */
export function fallbackSeverity(providerSeverity: string): CanonicalSeverity {
  const token = providerSeverity.trim().toLowerCase();
  if (["fatal", "critical", "crit"].includes(token)) {
    return "critical";
  }
  if (["error", "err"].includes(token)) {
    return "error";
  }
  if (["warn", "warning"].includes(token)) {
    return "warning";
  }
  if (["info", "debug", "trace", "notice"].includes(token)) {
    return "info";
  }
  return "error";
}

function escalate(severity: CanonicalSeverity): CanonicalSeverity {
  const index = SEVERITY_LADDER.indexOf(severity);
  const next =
    index < 0 ? SEVERITY_LADDER.length - 1 : Math.min(index + 1, SEVERITY_LADDER.length - 1);
  return SEVERITY_LADDER[next] ?? severity;
}

function repositoryKey(candidate: RepositoryCandidate): string {
  return JSON.stringify([
    candidate.repository_id,
    candidate.url,
    candidate.base_ref,
    candidate.base_sha,
  ]);
}

/**
 * Evaluate the ordered rule set for one normalized signal. Pure: no clock, no
 * I/O, no randomness — replaying the same evaluation reproduces the decision.
 */
export function evaluateRules(
  config: RuleConfig,
  input: RuleEvaluationInput,
  rate: RateObservation,
): SignalDecision {
  const matched = config.rules.filter((rule) => ruleMatches(rule, input));

  let severity: CanonicalSeverity | null = null;
  let service: string | null = null;
  let environment: string | null = null;
  let windowSeconds: number | null = null;
  let escalateAt: number | null = null;
  let suppression: SuppressionDecision | null = null;
  const candidates = new Map<string, RepositoryCandidate>();
  const mappingRuleIds: string[] = [];

  for (const rule of matched) {
    const decision = rule.decision;
    if (severity === null && decision.severity !== undefined) {
      severity = decision.severity;
    }
    if (service === null && decision.service !== undefined) {
      service = decision.service;
    }
    if (environment === null && decision.environment !== undefined) {
      environment = decision.environment;
    }
    if (windowSeconds === null && decision.rate_window_seconds !== undefined) {
      windowSeconds = decision.rate_window_seconds;
    }
    if (escalateAt === null && decision.rate_escalate_at !== undefined) {
      escalateAt = decision.rate_escalate_at;
    }
    if (suppression === null && decision.suppress !== undefined) {
      suppression = { rule_id: rule.rule_id, reason: decision.suppress.reason };
    }
    if (decision.repositories !== undefined && decision.repositories.length > 0) {
      mappingRuleIds.push(rule.rule_id);
      for (const candidate of decision.repositories) {
        candidates.set(repositoryKey(candidate), candidate);
      }
    }
  }

  let selectedSeverity = severity ?? fallbackSeverity(input.provider_severity);
  if (escalateAt !== null && rate.count_in_window >= escalateAt) {
    selectedSeverity = escalate(selectedSeverity);
  }

  const distinct = [...candidates.values()];
  const mapping: RepositoryMapping = {
    status: distinct.length === 1 ? "mapped" : distinct.length === 0 ? "unmapped" : "ambiguous",
    repository: distinct.length === 1 ? (distinct[0] ?? null) : null,
    candidates: distinct,
    rule_ids: mappingRuleIds,
  };

  return {
    policy_version: config.version,
    rule_ids: matched.map((rule) => rule.rule_id),
    severity: selectedSeverity,
    service: service ?? input.provider_service,
    environment: environment ?? input.provider_environment,
    error_signature: input.error_signature,
    rate_window_seconds: windowSeconds ?? DEFAULT_RATE_WINDOW_SECONDS,
    rate_escalate_at: escalateAt,
    rate_count: rate.count_in_window,
    suppression: suppression,
    repository_mapping: mapping,
  };
}
