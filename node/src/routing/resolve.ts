import type { WorkspaceRole } from "../control-plane/types.js";
import { pathMatchesPattern } from "./match.js";
import type {
  BlameFact,
  CandidateEligibility,
  CandidateSource,
  CandidateSourceKind,
  DirectoryMember,
  FallbackReason,
  IgnoredChange,
  OwnerRef,
  ProviderIdentityRef,
  ResolvedFacts,
  RouteEvidence,
  RoutingCandidate,
  RoutingConfidence,
  RoutingOutcome,
  RoutingPolicy,
  ServiceMapping,
  TeamGap,
  UnmatchedIdentity,
} from "./types.js";

/**
 * Deterministic candidate resolution (ADR-0007 "Routing and responsibility").
 *
 * Scoring, in substantive-code weight units:
 *
 * - Every substantive affected file with weight w splits w evenly across the
 *   distinct users its matching ownership rules, CODEOWNERS rules, and team
 *   rules resolve to (a team resolves to its active leader). Cosmetic and
 *   bulk changes contribute nothing and are recorded as ignored.
 * - Every blame attribution on a substantive file adds its own weight to the
 *   resolved user. An author without a verified provider identity is
 *   recorded as an unmatched identity and never a candidate.
 *
 * `score = ownership_weight + blame_weight`. The highest scorer must be
 * eligible (a departed or suspended top scorer falls back to triage rather
 * than silently picking the runner-up); confidence is high only when the top
 * score reaches `min_top_weight` and leads the runner-up by `min_margin`.
 */

export function candidateEligibility(member: DirectoryMember | undefined): CandidateEligibility {
  if (member === undefined) {
    return "not_a_member";
  }
  if (member.status !== "active") {
    return "suspended";
  }
  if (member.role === "viewer") {
    return "viewer_role";
  }
  return "eligible";
}

export function hasApprovalAuthority(
  member: DirectoryMember | undefined,
  approvalRoles: readonly WorkspaceRole[],
): boolean {
  return (
    member !== undefined &&
    candidateEligibility(member) === "eligible" &&
    approvalRoles.includes(member.role)
  );
}

export interface ResolutionInput {
  policy: RoutingPolicy;
  evidence: RouteEvidence;
  service_mapping: ServiceMapping;
  facts: ResolvedFacts;
}

/** The computed part of a routing decision; the handler adds ids and digests. */
export interface Resolution {
  candidates: RoutingCandidate[];
  unmatched_identities: UnmatchedIdentity[];
  team_gaps: TeamGap[];
  ignored_changes: IgnoredChange[];
  confidence: {
    level: RoutingConfidence;
    top_weight: number;
    margin: number;
  };
  fallback_reason: FallbackReason | null;
  outcome: RoutingOutcome;
  assignee_user_id: string | null;
  triage_owners: string[];
}

interface MutableSource {
  kind: CandidateSourceKind;
  rule_id: string | null;
  paths: Set<string>;
}

interface CandidateAccumulator {
  ownership_weight: number;
  blame_weight: number;
  sources: Map<string, MutableSource>;
}

function identityKey(ref: ProviderIdentityRef): string {
  return `${ref.provider_instance_id} ${ref.subject}`;
}

function sourceKey(kind: CandidateSourceKind, ruleId: string | null): string {
  return `${kind} ${ruleId ?? ""}`;
}

function toCandidates(
  accumulators: Map<string, CandidateAccumulator>,
  facts: ResolvedFacts,
): RoutingCandidate[] {
  const members = new Map(facts.members.map((member) => [member.user_id, member]));
  const candidates: RoutingCandidate[] = [];
  for (const [userId, accumulator] of accumulators) {
    const sources: CandidateSource[] = [...accumulator.sources.values()]
      .map((source) => ({ ...source, paths: [...source.paths].sort() }))
      .sort(
        (a, b) => a.kind.localeCompare(b.kind) || (a.rule_id ?? "").localeCompare(b.rule_id ?? ""),
      );
    candidates.push({
      user_id: userId,
      score: accumulator.ownership_weight + accumulator.blame_weight,
      ownership_weight: accumulator.ownership_weight,
      blame_weight: accumulator.blame_weight,
      sources,
      eligibility: candidateEligibility(members.get(userId)),
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.user_id.localeCompare(b.user_id));
  return candidates;
}

export function resolveRouting(input: ResolutionInput): Resolution {
  const { policy, evidence, facts } = input;
  const accumulators = new Map<string, CandidateAccumulator>();
  const teamGaps: TeamGap[] = [];
  const unmatched: UnmatchedIdentity[] = [];
  const ignoredChanges: IgnoredChange[] = [];

  const accumulatorFor = (userId: string): CandidateAccumulator => {
    let accumulator = accumulators.get(userId);
    if (accumulator === undefined) {
      accumulator = { ownership_weight: 0, blame_weight: 0, sources: new Map() };
      accumulators.set(userId, accumulator);
    }
    return accumulator;
  };
  const addSource = (
    accumulator: CandidateAccumulator,
    kind: CandidateSourceKind,
    ruleId: string | null,
    path: string,
  ): void => {
    const key = sourceKey(kind, ruleId);
    let source = accumulator.sources.get(key);
    if (source === undefined) {
      source = { kind, rule_id: ruleId, paths: new Set() };
      accumulator.sources.set(key, source);
    }
    source.paths.add(path);
  };

  const members = new Map(facts.members.map((member) => [member.user_id, member]));
  const teams = new Map(facts.teams.map((team) => [team.team_id, team]));
  const identityMatches = new Map(
    facts.identity_matches.map((match) => [identityKey(match.ref), match.user_id]),
  );
  const blameByPath = new Map<string, BlameFact[]>();
  for (const fact of evidence.blame) {
    const bucket = blameByPath.get(fact.path);
    if (bucket === undefined) {
      blameByPath.set(fact.path, [fact]);
    } else {
      bucket.push(fact);
    }
  }

  const triageOwners = facts.members
    .filter(
      (member) =>
        candidateEligibility(member) === "eligible" && policy.triage_roles.includes(member.role),
    )
    .map((member) => member.user_id)
    .sort();

  for (const file of evidence.affected_files) {
    if (file.classification === "cosmetic" || file.classification === "bulk") {
      ignoredChanges.push({ path: file.path, classification: file.classification });
      continue;
    }
    if (file.weight <= 0) {
      continue;
    }

    // Ownership signals for this file, resolved to users; a team resolves to
    // its active leader or records a gap.
    const fileOwners = new Map<string, { kind: CandidateSourceKind; rule_id: string }[]>();
    const ruleHits: { kind: CandidateSourceKind; rule_id: string; owner: OwnerRef }[] = [];
    for (const rule of policy.ownership_rules) {
      if (pathMatchesPattern(rule.pattern, file.path)) {
        ruleHits.push({ kind: "ownership_rule", rule_id: rule.rule_id, owner: rule.owner });
      }
    }
    for (const rule of policy.codeowners_rules) {
      if (pathMatchesPattern(rule.pattern, file.path)) {
        ruleHits.push({ kind: "codeowners_rule", rule_id: rule.rule_id, owner: rule.owner });
      }
    }
    for (const rule of policy.team_rules) {
      if (pathMatchesPattern(rule.pattern, file.path)) {
        ruleHits.push({
          kind: "team_leader",
          rule_id: rule.rule_id,
          owner: { kind: "team", team_id: rule.team_id },
        });
      }
    }
    for (const hit of ruleHits) {
      if (hit.owner.kind === "user") {
        const hits = fileOwners.get(hit.owner.user_id) ?? [];
        hits.push({ kind: hit.kind, rule_id: hit.rule_id });
        fileOwners.set(hit.owner.user_id, hits);
        continue;
      }
      const teamId = hit.owner.team_id;
      const team = teams.get(teamId);
      const existingGap = teamGaps.find(
        (gap) => gap.kind === hit.kind && gap.rule_id === hit.rule_id && gap.team_id === teamId,
      );
      const leader = team?.leader_user_id ?? null;
      if (
        team === undefined ||
        leader === null ||
        candidateEligibility(members.get(leader)) !== "eligible"
      ) {
        const reason: TeamGap["reason"] =
          team === undefined
            ? "team_missing"
            : leader === null
              ? "leader_missing"
              : "leader_not_eligible";
        if (existingGap === undefined) {
          teamGaps.push({
            kind: hit.kind,
            rule_id: hit.rule_id,
            team_id: teamId,
            paths: [file.path],
            reason,
          });
        } else {
          existingGap.paths.push(file.path);
        }
        continue;
      }
      const hits = fileOwners.get(leader) ?? [];
      hits.push({ kind: hit.kind, rule_id: hit.rule_id });
      fileOwners.set(leader, hits);
    }

    if (fileOwners.size > 0) {
      const share = file.weight / fileOwners.size;
      for (const [userId, hits] of fileOwners) {
        const accumulator = accumulatorFor(userId);
        accumulator.ownership_weight += share;
        for (const hit of hits) {
          addSource(accumulator, hit.kind, hit.rule_id, file.path);
        }
      }
    }

    for (const fact of blameByPath.get(file.path) ?? []) {
      if (fact.weight <= 0) {
        continue;
      }
      if (fact.author === null) {
        unmatched.push({
          author_label: fact.author_label,
          ref: null,
          path: fact.path,
          reason: "unverified_author_identity",
        });
        continue;
      }
      const userId = identityMatches.get(identityKey(fact.author));
      if (userId === null || userId === undefined) {
        unmatched.push({
          author_label: fact.author_label,
          ref: fact.author,
          path: fact.path,
          reason: "identity_not_found",
        });
        continue;
      }
      const accumulator = accumulatorFor(userId);
      accumulator.blame_weight += fact.weight;
      addSource(accumulator, "blame", null, fact.path);
    }
  }

  const candidates = toCandidates(accumulators, facts);
  const top = candidates[0];
  const fallbackReason: FallbackReason | null =
    top === undefined
      ? "no_candidates"
      : top.eligibility === "eligible"
        ? null
        : "top_candidate_ineligible";

  let confidence: Resolution["confidence"] = { level: "none", top_weight: 0, margin: 0 };
  let outcome: RoutingOutcome;
  let assigneeUserId: string | null = null;
  if (input.service_mapping.status !== "mapped") {
    outcome = triageOwners.length > 0 ? "triage_queue" : "unassigned_alert";
    return {
      candidates,
      unmatched_identities: unmatched,
      team_gaps: teamGaps,
      ignored_changes: ignoredChanges,
      confidence,
      fallback_reason: "service_unmapped",
      outcome,
      assignee_user_id: null,
      triage_owners: triageOwners,
    };
  }
  if (fallbackReason !== null) {
    outcome = triageOwners.length > 0 ? "triage_queue" : "unassigned_alert";
  } else {
    const second = candidates[1];
    const topWeight = top?.score ?? 0;
    const margin = second === undefined ? topWeight : topWeight - second.score;
    const level: RoutingConfidence =
      topWeight >= policy.confidence.min_top_weight && margin >= policy.confidence.min_margin
        ? "high"
        : "low";
    confidence = { level, top_weight: topWeight, margin };
    if (level === "high") {
      outcome = "assign";
      assigneeUserId = top?.user_id ?? null;
    } else {
      outcome = "manual_triage";
    }
  }

  return {
    candidates,
    unmatched_identities: unmatched,
    team_gaps: teamGaps,
    ignored_changes: ignoredChanges,
    confidence,
    fallback_reason: fallbackReason,
    outcome,
    assignee_user_id: assigneeUserId,
    triage_owners: triageOwners,
  };
}
