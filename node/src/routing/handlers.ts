import { createHash } from "node:crypto";

import { digestOf } from "../collab/audit.js";
import type { WorkspaceRole } from "../control-plane/types.js";
import type { RoutingAuditCommand } from "./audit.js";
import { RoutingError } from "./errors.js";
import { candidateEligibility, hasApprovalAuthority, resolveRouting } from "./resolve.js";
import type {
  AffectedFile,
  ApprovalRequestRecord,
  AssignmentRecord,
  BlameFact,
  DirectoryMember,
  DirectoryTeam,
  IdentityMatch,
  OwnerRef,
  PathRule,
  ProviderIdentityRef,
  Recommendation,
  ResolvedFacts,
  RouteEvidence,
  RoutingDecision,
  RoutingPolicy,
  RoutingScope,
  RoutingState,
  ServiceMapping,
  TeamRule,
  TransferProposal,
} from "./types.js";
import { policyKey } from "./types.js";

/**
 * Pure routing handlers.
 *
 * Each handler validates its fully normalized payload — including the ids,
 * timestamp, and directory facts the machine resolved and recorded before the
 * handler ran — and mutates the state. Replaying the audit log through these
 * handlers is therefore a faithful reconstruction: the same payload on the
 * same prior state yields the same result and the same denials. Handlers
 * never mint identifiers, never read the wall clock, and never call the
 * directory: `payload.at` is the effective time and `payload.resolved` is the
 * eligibility evidence.
 */

type Payload = Record<string, unknown>;

const BASE_KEYS = ["operation_id", "actor", "at", "scope"] as const;

const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member", "viewer"];
const CHANGE_CLASSIFICATIONS = ["substantive", "cosmetic", "bulk"] as const;
const MAPPING_STATUSES = ["mapped", "unmapped", "ambiguous"] as const;

const ID_MAX = 200;
const KEY_MAX = 200;
const PATH_MAX = 1000;
const PATTERN_MAX = 500;
const REVISION_MAX = 200;
const LABEL_MAX = 200;
const REASON_MAX = 500;
const RATIONALE_MAX = 2000;
const POLICY_VERSION_MAX = 100;
const NAME_MAX = 200;
const SEED_MAX = 100;

function assertExactKeys(payload: Payload, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new RoutingError("INVALID_INPUT", `${label} has unknown field ${key}`, {
        field: key,
      });
    }
  }
}

function object(value: unknown, field: string): Payload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingError("INVALID_INPUT", `${field} must be an object`, { field });
  }
  return value as Payload;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RoutingError("INVALID_INPUT", `${field} must be an array`, { field });
  }
  return value;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RoutingError("INVALID_INPUT", `${field} must be a non-empty string`, { field });
  }
  return value;
}

function bounded(value: unknown, field: string, max: number): string {
  const text = str(value, field);
  if (text.length > max) {
    throw new RoutingError("INVALID_INPUT", `${field} exceeds ${max} characters`, {
      field,
      max,
      length: text.length,
    });
  }
  return text;
}

function boundedOrNull(value: unknown, field: string, max: number): string | null {
  return value === null || value === undefined ? null : bounded(value, field, max);
}

function iso(value: unknown, field: string): string {
  const text = str(value, field);
  const time = Date.parse(text);
  if (Number.isNaN(time)) {
    throw new RoutingError("INVALID_INPUT", `${field} must be an RFC 3339 timestamp`, { field });
  }
  return new Date(time).toISOString();
}

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RoutingError("INVALID_INPUT", `${field} must be a finite number >= 0`, {
      field,
    });
  }
  return value;
}

function role(value: unknown, field: string): WorkspaceRole {
  const text = str(value, field);
  if (!(WORKSPACE_ROLES as readonly string[]).includes(text)) {
    throw new RoutingError("INVALID_INPUT", `${field} must be a workspace role`, {
      field,
      allowed: WORKSPACE_ROLES,
    });
  }
  return text as WorkspaceRole;
}

function roles(value: unknown, field: string): WorkspaceRole[] {
  const seen = new Set<string>();
  return array(value, field).map((entry, index) => {
    const parsed = role(entry, `${field}[${index}]`);
    if (seen.has(parsed)) {
      throw new RoutingError("INVALID_INPUT", `${field} repeats role ${parsed}`, {
        field,
        role: parsed,
      });
    }
    seen.add(parsed);
    return parsed;
  });
}

function parseScope(value: unknown, field: string): RoutingScope {
  const source = object(value, field);
  assertExactKeys(source, ["enterprise_id", "workspace_id"], field);
  return {
    enterprise_id: bounded(source["enterprise_id"], `${field}.enterprise_id`, KEY_MAX),
    workspace_id: bounded(source["workspace_id"], `${field}.workspace_id`, KEY_MAX),
  };
}

function parseOwnerRef(value: unknown, field: string): OwnerRef {
  const source = object(value, field);
  const kind = str(source["kind"], `${field}.kind`);
  if (kind === "user") {
    assertExactKeys(source, ["kind", "user_id"], field);
    return { kind: "user", user_id: bounded(source["user_id"], `${field}.user_id`, ID_MAX) };
  }
  if (kind === "team") {
    assertExactKeys(source, ["kind", "team_id"], field);
    return { kind: "team", team_id: bounded(source["team_id"], `${field}.team_id`, ID_MAX) };
  }
  throw new RoutingError("INVALID_INPUT", `${field}.kind must be user or team`, { field });
}

function parsePathRule(value: unknown, field: string): PathRule {
  const source = object(value, field);
  assertExactKeys(source, ["rule_id", "pattern", "owner"], field);
  return {
    rule_id: bounded(source["rule_id"], `${field}.rule_id`, ID_MAX),
    pattern: bounded(source["pattern"], `${field}.pattern`, PATTERN_MAX),
    owner: parseOwnerRef(source["owner"], `${field}.owner`),
  };
}

function parseTeamRule(value: unknown, field: string): TeamRule {
  const source = object(value, field);
  assertExactKeys(source, ["rule_id", "pattern", "team_id"], field);
  return {
    rule_id: bounded(source["rule_id"], `${field}.rule_id`, ID_MAX),
    pattern: bounded(source["pattern"], `${field}.pattern`, PATTERN_MAX),
    team_id: bounded(source["team_id"], `${field}.team_id`, ID_MAX),
  };
}

function parsePolicy(value: unknown, field: string): RoutingPolicy {
  const source = object(value, field);
  assertExactKeys(
    source,
    [
      "policy_version",
      "ownership_rules",
      "codeowners_rules",
      "team_rules",
      "confidence",
      "triage_roles",
      "approval_roles",
      "transfer",
    ],
    field,
  );
  const confidence = object(source["confidence"], `${field}.confidence`);
  assertExactKeys(confidence, ["min_top_weight", "min_margin"], `${field}.confidence`);
  const transfer = object(source["transfer"], `${field}.transfer`);
  assertExactKeys(transfer, ["propose_roles", "confirm_roles"], `${field}.transfer`);
  const policy: RoutingPolicy = {
    policy_version: bounded(
      source["policy_version"],
      `${field}.policy_version`,
      POLICY_VERSION_MAX,
    ),
    ownership_rules: array(source["ownership_rules"], `${field}.ownership_rules`).map(
      (entry, index) => parsePathRule(entry, `${field}.ownership_rules[${index}]`),
    ),
    codeowners_rules: array(source["codeowners_rules"], `${field}.codeowners_rules`).map(
      (entry, index) => parsePathRule(entry, `${field}.codeowners_rules[${index}]`),
    ),
    team_rules: array(source["team_rules"], `${field}.team_rules`).map((entry, index) =>
      parseTeamRule(entry, `${field}.team_rules[${index}]`),
    ),
    confidence: {
      min_top_weight: nonNegative(
        confidence["min_top_weight"],
        `${field}.confidence.min_top_weight`,
      ),
      min_margin: nonNegative(confidence["min_margin"], `${field}.confidence.min_margin`),
    },
    triage_roles: roles(source["triage_roles"], `${field}.triage_roles`),
    approval_roles: roles(source["approval_roles"], `${field}.approval_roles`),
    transfer: {
      propose_roles: roles(transfer["propose_roles"], `${field}.transfer.propose_roles`),
      confirm_roles: roles(transfer["confirm_roles"], `${field}.transfer.confirm_roles`),
    },
  };
  const ruleIds = new Set<string>();
  for (const rule of [
    ...policy.ownership_rules,
    ...policy.codeowners_rules,
    ...policy.team_rules,
  ]) {
    if (ruleIds.has(rule.rule_id)) {
      throw new RoutingError("POLICY_INVALID", `policy repeats rule_id ${rule.rule_id}`, {
        rule_id: rule.rule_id,
      });
    }
    ruleIds.add(rule.rule_id);
  }
  return policy;
}

function parseServiceMapping(value: unknown, field: string): ServiceMapping {
  const source = object(value, field);
  assertExactKeys(source, ["service", "status"], field);
  const status = str(source["status"], `${field}.status`);
  if (!MAPPING_STATUSES.includes(status as (typeof MAPPING_STATUSES)[number])) {
    throw new RoutingError("INVALID_INPUT", `${field}.status must be a mapping status`, { field });
  }
  return {
    service: boundedOrNull(source["service"], `${field}.service`, NAME_MAX),
    status: status as ServiceMapping["status"],
  };
}

function parseIdentityRef(value: unknown, field: string): ProviderIdentityRef {
  const source = object(value, field);
  assertExactKeys(source, ["provider_instance_id", "subject"], field);
  return {
    provider_instance_id: bounded(
      source["provider_instance_id"],
      `${field}.provider_instance_id`,
      ID_MAX,
    ),
    subject: bounded(source["subject"], `${field}.subject`, ID_MAX),
  };
}

function parseAffectedFile(value: unknown, field: string): AffectedFile {
  const source = object(value, field);
  assertExactKeys(source, ["path", "classification", "weight"], field);
  const classification = str(source["classification"], `${field}.classification`);
  if (!CHANGE_CLASSIFICATIONS.includes(classification as (typeof CHANGE_CLASSIFICATIONS)[number])) {
    throw new RoutingError("INVALID_INPUT", `${field}.classification must be a change class`, {
      field,
    });
  }
  return {
    path: bounded(source["path"], `${field}.path`, PATH_MAX),
    classification: classification as AffectedFile["classification"],
    weight: nonNegative(source["weight"], `${field}.weight`),
  };
}

function parseBlameFact(value: unknown, field: string): BlameFact {
  const source = object(value, field);
  assertExactKeys(source, ["path", "revision", "author", "author_label", "weight"], field);
  const author = source["author"];
  return {
    path: bounded(source["path"], `${field}.path`, PATH_MAX),
    revision: bounded(source["revision"], `${field}.revision`, REVISION_MAX),
    author:
      author === null || author === undefined ? null : parseIdentityRef(author, `${field}.author`),
    author_label: bounded(source["author_label"], `${field}.author_label`, LABEL_MAX),
    weight: nonNegative(source["weight"], `${field}.weight`),
  };
}

function parseEvidence(value: unknown, field: string): RouteEvidence {
  const source = object(value, field);
  assertExactKeys(source, ["affected_files", "blame"], field);
  const affectedFiles = array(source["affected_files"], `${field}.affected_files`).map(
    (entry, index) => parseAffectedFile(entry, `${field}.affected_files[${index}]`),
  );
  const paths = new Set<string>();
  for (const file of affectedFiles) {
    if (paths.has(file.path)) {
      throw new RoutingError("INVALID_INPUT", `${field} repeats affected path ${file.path}`, {
        field,
        path: file.path,
      });
    }
    paths.add(file.path);
  }
  const blame = array(source["blame"], `${field}.blame`).map((entry, index) =>
    parseBlameFact(entry, `${field}.blame[${index}]`),
  );
  for (const fact of blame) {
    if (!paths.has(fact.path)) {
      throw new RoutingError(
        "INVALID_INPUT",
        `${field}.blame references unknown path ${fact.path}`,
        {
          field,
          path: fact.path,
        },
      );
    }
  }
  return { affected_files: affectedFiles, blame };
}

function parseMember(value: unknown, field: string): DirectoryMember {
  const source = object(value, field);
  assertExactKeys(source, ["user_id", "role", "status"], field);
  const status = str(source["status"], `${field}.status`);
  if (status !== "active" && status !== "suspended") {
    throw new RoutingError("INVALID_INPUT", `${field}.status must be active or suspended`, {
      field,
    });
  }
  return {
    user_id: bounded(source["user_id"], `${field}.user_id`, ID_MAX),
    role: role(source["role"], `${field}.role`),
    status,
  };
}

function parseTeam(value: unknown, field: string): DirectoryTeam {
  const source = object(value, field);
  assertExactKeys(source, ["team_id", "name", "responsibility", "leader_user_id"], field);
  return {
    team_id: bounded(source["team_id"], `${field}.team_id`, ID_MAX),
    name: bounded(source["name"], `${field}.name`, NAME_MAX),
    responsibility: boundedOrNull(source["responsibility"], `${field}.responsibility`, REASON_MAX),
    leader_user_id: boundedOrNull(source["leader_user_id"], `${field}.leader_user_id`, ID_MAX),
  };
}

function parseIdentityMatch(value: unknown, field: string): IdentityMatch {
  const source = object(value, field);
  assertExactKeys(source, ["ref", "user_id"], field);
  return {
    ref: parseIdentityRef(source["ref"], `${field}.ref`),
    user_id: boundedOrNull(source["user_id"], `${field}.user_id`, ID_MAX),
  };
}

function parseResolved(value: unknown, field: string): ResolvedFacts {
  const source = object(value, field);
  assertExactKeys(source, ["members", "teams", "identity_matches"], field);
  return {
    members: array(source["members"], `${field}.members`).map((entry, index) =>
      parseMember(entry, `${field}.members[${index}]`),
    ),
    teams: array(source["teams"], `${field}.teams`).map((entry, index) =>
      parseTeam(entry, `${field}.teams[${index}]`),
    ),
    identity_matches: array(source["identity_matches"], `${field}.identity_matches`).map(
      (entry, index) => parseIdentityMatch(entry, `${field}.identity_matches[${index}]`),
    ),
  };
}

function parseRecommendation(value: unknown, field: string): Recommendation {
  const source = object(value, field);
  assertExactKeys(source, ["recommended_user_id", "rationale", "asserted_confidence"], field);
  const asserted = source["asserted_confidence"];
  return {
    recommended_user_id: bounded(
      source["recommended_user_id"],
      `${field}.recommended_user_id`,
      ID_MAX,
    ),
    rationale: boundedOrNull(source["rationale"], `${field}.rationale`, RATIONALE_MAX),
    asserted_confidence:
      asserted === null || asserted === undefined
        ? null
        : nonNegative(asserted, `${field}.asserted_confidence`),
  };
}

function policyFor(state: RoutingState, scope: RoutingScope): RoutingPolicy {
  const policy = state.policies.get(policyKey(scope));
  if (policy === undefined) {
    throw new RoutingError("POLICY_NOT_REGISTERED", "no routing policy registered for the scope", {
      scope,
    });
  }
  return policy;
}

function memberOf(facts: ResolvedFacts, userId: string): DirectoryMember | undefined {
  return facts.members.find((member) => member.user_id === userId);
}

/**
 * Deterministic id for the request a sweep re-addresses: derived from the
 * machine-minted per-command seed so a replay reproduces the exact ids while
 * one sweep can re-address any number of requests.
 */
function readdressedRequestId(seed: string, oldRequestId: string): string {
  return `rap_${createHash("sha256").update(`${seed}:${oldRequestId}`).digest("hex").slice(0, 32)}`;
}

function sameScope(a: RoutingScope, b: RoutingScope): boolean {
  return a.enterprise_id === b.enterprise_id && a.workspace_id === b.workspace_id;
}

function newApprovalRequest(
  requestId: string,
  scope: RoutingScope,
  issueId: string,
  addresseeUserId: string,
  policyVersion: string,
  addressedBy: string,
  at: string,
): ApprovalRequestRecord {
  return {
    request_id: requestId,
    scope,
    issue_id: issueId,
    addressee_user_id: addresseeUserId,
    status: "pending",
    policy_version: policyVersion,
    addressed_at: at,
    addressed_by: addressedBy,
    invalidated_at: null,
    invalidation_reason: null,
    readdressed_request_id: null,
  };
}

function requireProposal(
  state: RoutingState,
  scope: RoutingScope,
  proposalId: string,
): TransferProposal {
  const proposal = state.transfers.get(proposalId);
  if (proposal === undefined || !sameScope(proposal.scope, scope)) {
    throw new RoutingError("PROPOSAL_NOT_FOUND", "unknown transfer proposal", {
      proposal_id: proposalId,
    });
  }
  return proposal;
}

function registerPolicyHandler(state: RoutingState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "policy"], "register_policy");
  const scope = parseScope(payload["scope"], "scope");
  let policy: RoutingPolicy;
  try {
    policy = parsePolicy(payload["policy"], "policy");
  } catch (error) {
    if (error instanceof RoutingError && error.code === "INVALID_INPUT") {
      throw new RoutingError("POLICY_INVALID", error.message, error.details);
    }
    throw error;
  }
  state.policies.set(policyKey(scope), policy);
  return {
    scope,
    policy_version: policy.policy_version,
    policy_digest: digestOf(policy),
  };
}

function routeHandler(state: RoutingState, payload: Payload): RoutingDecision {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "issue_id", "service_mapping", "evidence", "resolved", "decision_id"],
    "route",
  );
  const scope = parseScope(payload["scope"], "scope");
  const issueId = bounded(payload["issue_id"], "issue_id", ID_MAX);
  const serviceMapping = parseServiceMapping(payload["service_mapping"], "service_mapping");
  const evidence = parseEvidence(payload["evidence"], "evidence");
  const facts = parseResolved(payload["resolved"], "resolved");
  const decisionId = bounded(payload["decision_id"], "decision_id", ID_MAX);
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);
  const resolution = resolveRouting({ policy, evidence, service_mapping: serviceMapping, facts });

  const decision: RoutingDecision = {
    decision_id: decisionId,
    issue_id: issueId,
    scope,
    service_mapping: serviceMapping,
    policy_version: policy.policy_version,
    policy_digest: digestOf(policy),
    evidence_digest: digestOf({ evidence, resolved: facts }),
    candidates: resolution.candidates,
    unmatched_identities: resolution.unmatched_identities,
    team_gaps: resolution.team_gaps,
    ignored_changes: resolution.ignored_changes,
    confidence: {
      level: resolution.confidence.level,
      top_weight: resolution.confidence.top_weight,
      margin: resolution.confidence.margin,
      min_top_weight: policy.confidence.min_top_weight,
      min_margin: policy.confidence.min_margin,
    },
    fallback_reason: resolution.fallback_reason,
    outcome: resolution.outcome,
    assignee_user_id: resolution.assignee_user_id,
    triage_owners: resolution.triage_owners,
    at,
  };
  state.decisions.set(decisionId, decision);
  if (decision.outcome === "assign" && decision.assignee_user_id !== null) {
    state.assignments.set(issueId, {
      issue_id: issueId,
      assignee_user_id: decision.assignee_user_id,
      source: "routing",
      decision_id: decisionId,
      transfer_id: null,
      policy_version: policy.policy_version,
      assigned_at: at,
      updated_at: at,
    });
  }
  if (decision.outcome === "unassigned_alert") {
    state.alerts.push({
      kind: "unassigned_no_eligible_owner",
      scope,
      issue_id: issueId,
      subject_user_id: null,
      detail: "no eligible assignee and no eligible owner/admin for the triage queue",
      at,
    });
  }
  return decision;
}

function recommendAssigneeHandler(state: RoutingState, payload: Payload): AssignmentRecord {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "decision_id", "recommendation", "resolved"],
    "recommend_assignee",
  );
  const scope = parseScope(payload["scope"], "scope");
  const decisionId = bounded(payload["decision_id"], "decision_id", ID_MAX);
  const recommendation = parseRecommendation(payload["recommendation"], "recommendation");
  const facts = parseResolved(payload["resolved"], "resolved");
  const at = iso(payload["at"], "at");

  const decision = state.decisions.get(decisionId);
  if (decision === undefined || !sameScope(decision.scope, scope)) {
    throw new RoutingError("DECISION_NOT_FOUND", "unknown routing decision", {
      decision_id: decisionId,
    });
  }
  if (decision.outcome !== "assign") {
    throw new RoutingError("ASSIGNMENT_NOT_ALLOWED", "decision did not produce an assignee", {
      decision_id: decisionId,
      outcome: decision.outcome,
    });
  }
  const boundedCandidate = decision.candidates.find(
    (candidate) =>
      candidate.user_id === recommendation.recommended_user_id &&
      candidate.eligibility === "eligible",
  );
  if (boundedCandidate === undefined) {
    throw new RoutingError(
      "CANDIDATE_NOT_BOUNDED",
      "recommendation is outside the bounded candidates",
      {
        decision_id: decisionId,
        recommended_user_id: recommendation.recommended_user_id,
      },
    );
  }
  if (candidateEligibility(memberOf(facts, recommendation.recommended_user_id)) !== "eligible") {
    throw new RoutingError("NOT_ELIGIBLE", "recommended user is not a current eligible member", {
      recommended_user_id: recommendation.recommended_user_id,
    });
  }
  const assignment = state.assignments.get(decision.issue_id);
  if (assignment === undefined || assignment.decision_id !== decisionId) {
    throw new RoutingError(
      "ASSIGNMENT_SUPERSEDED",
      "assignment no longer comes from this decision",
      {
        decision_id: decisionId,
        issue_id: decision.issue_id,
      },
    );
  }
  const updated: AssignmentRecord = {
    ...assignment,
    assignee_user_id: recommendation.recommended_user_id,
    source: "llm_recommendation",
    policy_version: decision.policy_version,
    updated_at: at,
  };
  state.assignments.set(decision.issue_id, updated);
  return updated;
}

function proposeTransferHandler(state: RoutingState, payload: Payload): TransferProposal {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "issue_id", "to_user_id", "reason", "evidence", "resolved", "transfer_id"],
    "propose_transfer",
  );
  const scope = parseScope(payload["scope"], "scope");
  const issueId = bounded(payload["issue_id"], "issue_id", ID_MAX);
  const toUserId = bounded(payload["to_user_id"], "to_user_id", ID_MAX);
  const reason = bounded(payload["reason"], "reason", REASON_MAX);
  const evidence = boundedOrNull(payload["evidence"], "evidence", REASON_MAX);
  const facts = parseResolved(payload["resolved"], "resolved");
  const transferId = bounded(payload["transfer_id"], "transfer_id", ID_MAX);
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);

  const actor = bounded(payload["actor"], "actor", ID_MAX);
  const actorMember = memberOf(facts, actor);
  if (
    actorMember === undefined ||
    candidateEligibility(actorMember) !== "eligible" ||
    !policy.transfer.propose_roles.includes(actorMember.role)
  ) {
    throw new RoutingError("ROLE_FORBIDDEN", "actor may not propose transfers", {
      actor,
      required_roles: policy.transfer.propose_roles,
    });
  }
  const assignment = state.assignments.get(issueId);
  const fromUserId = assignment?.assignee_user_id ?? null;
  if (toUserId === fromUserId) {
    throw new RoutingError("INVALID_INPUT", "transfer target is already the assignee", {
      issue_id: issueId,
      to_user_id: toUserId,
    });
  }
  if (candidateEligibility(memberOf(facts, toUserId)) !== "eligible") {
    throw new RoutingError(
      "DESTINATION_INELIGIBLE",
      "transfer destination is not an eligible member",
      {
        to_user_id: toUserId,
      },
    );
  }
  const proposal: TransferProposal = {
    transfer_id: transferId,
    scope,
    issue_id: issueId,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    reason,
    evidence,
    proposed_by: actor,
    status: "proposed",
    policy_version: policy.policy_version,
    created_at: at,
    resolved_at: null,
    resolved_by: null,
  };
  state.transfers.set(transferId, proposal);
  return proposal;
}

function confirmTransferHandler(
  state: RoutingState,
  payload: Payload,
): { proposal: TransferProposal; assignment: AssignmentRecord } {
  assertExactKeys(payload, [...BASE_KEYS, "proposal_id", "resolved"], "confirm_transfer");
  const scope = parseScope(payload["scope"], "scope");
  const proposalId = bounded(payload["proposal_id"], "proposal_id", ID_MAX);
  const facts = parseResolved(payload["resolved"], "resolved");
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);

  const proposal = requireProposal(state, scope, proposalId);
  if (proposal.status !== "proposed") {
    throw new RoutingError("TRANSFER_NOT_PENDING", "transfer proposal is not pending", {
      proposal_id: proposalId,
      status: proposal.status,
    });
  }
  const assignment = state.assignments.get(proposal.issue_id);
  const currentAssignee = assignment?.assignee_user_id ?? null;
  if (proposal.from_user_id !== currentAssignee) {
    throw new RoutingError("TRANSFER_STALE", "assignee changed since the proposal", {
      proposal_id: proposalId,
      from_user_id: proposal.from_user_id,
      current_assignee: currentAssignee,
    });
  }
  const actor = bounded(payload["actor"], "actor", ID_MAX);
  const actorMember = memberOf(facts, actor);
  const actorIsAssignee = currentAssignee !== null && actor === currentAssignee;
  const actorHasRole =
    actorMember !== undefined &&
    candidateEligibility(actorMember) === "eligible" &&
    policy.transfer.confirm_roles.includes(actorMember.role);
  if (!actorIsAssignee && !actorHasRole) {
    throw new RoutingError("ROLE_FORBIDDEN", "actor may not confirm transfers", {
      actor,
      required_roles: policy.transfer.confirm_roles,
    });
  }
  if (candidateEligibility(memberOf(facts, proposal.to_user_id)) !== "eligible") {
    throw new RoutingError(
      "DESTINATION_INELIGIBLE",
      "transfer destination is not an eligible member",
      {
        to_user_id: proposal.to_user_id,
      },
    );
  }
  const confirmed: TransferProposal = {
    ...proposal,
    status: "confirmed",
    resolved_at: at,
    resolved_by: actor,
  };
  state.transfers.set(proposalId, confirmed);
  const updated: AssignmentRecord = {
    issue_id: proposal.issue_id,
    assignee_user_id: proposal.to_user_id,
    source: "transfer",
    decision_id: null,
    transfer_id: proposalId,
    policy_version: proposal.policy_version,
    assigned_at: at,
    updated_at: at,
  };
  state.assignments.set(proposal.issue_id, updated);
  return { proposal: confirmed, assignment: updated };
}

function rejectTransferHandler(state: RoutingState, payload: Payload): TransferProposal {
  assertExactKeys(payload, [...BASE_KEYS, "proposal_id", "reason", "resolved"], "reject_transfer");
  const scope = parseScope(payload["scope"], "scope");
  const proposalId = bounded(payload["proposal_id"], "proposal_id", ID_MAX);
  bounded(payload["reason"], "reason", REASON_MAX);
  const facts = parseResolved(payload["resolved"], "resolved");
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);

  const proposal = requireProposal(state, scope, proposalId);
  if (proposal.status !== "proposed") {
    throw new RoutingError("TRANSFER_NOT_PENDING", "transfer proposal is not pending", {
      proposal_id: proposalId,
      status: proposal.status,
    });
  }
  const assignment = state.assignments.get(proposal.issue_id);
  const currentAssignee = assignment?.assignee_user_id ?? null;
  const actor = bounded(payload["actor"], "actor", ID_MAX);
  const actorMember = memberOf(facts, actor);
  const actorIsAssignee = currentAssignee !== null && actor === currentAssignee;
  const actorHasRole =
    actorMember !== undefined &&
    candidateEligibility(actorMember) === "eligible" &&
    policy.transfer.confirm_roles.includes(actorMember.role);
  if (!actorIsAssignee && !actorHasRole) {
    throw new RoutingError("ROLE_FORBIDDEN", "actor may not reject transfers", {
      actor,
      required_roles: policy.transfer.confirm_roles,
    });
  }
  const rejected: TransferProposal = {
    ...proposal,
    status: "rejected",
    resolved_at: at,
    resolved_by: actor,
  };
  state.transfers.set(proposalId, rejected);
  return rejected;
}

function addressApprovalHandler(state: RoutingState, payload: Payload): ApprovalRequestRecord {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "issue_id", "reviewer_user_id", "resolved", "request_id"],
    "address_approval",
  );
  const scope = parseScope(payload["scope"], "scope");
  const issueId = bounded(payload["issue_id"], "issue_id", ID_MAX);
  const reviewerUserId = bounded(payload["reviewer_user_id"], "reviewer_user_id", ID_MAX);
  const facts = parseResolved(payload["resolved"], "resolved");
  const requestId = bounded(payload["request_id"], "request_id", ID_MAX);
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);

  for (const request of state.approvals.values()) {
    if (
      request.status === "pending" &&
      request.issue_id === issueId &&
      sameScope(request.scope, scope)
    ) {
      throw new RoutingError(
        "APPROVAL_ALREADY_PENDING",
        "issue already has a pending approval request",
        {
          issue_id: issueId,
          request_id: request.request_id,
        },
      );
    }
  }
  const reviewer = memberOf(facts, reviewerUserId);
  if (candidateEligibility(reviewer) !== "eligible") {
    throw new RoutingError("NOT_ELIGIBLE", "reviewer is not a current eligible member", {
      reviewer_user_id: reviewerUserId,
    });
  }
  if (!hasApprovalAuthority(reviewer, policy.approval_roles)) {
    throw new RoutingError("REVIEWER_NOT_AUTHORIZED", "reviewer holds no approval authority", {
      reviewer_user_id: reviewerUserId,
      approval_roles: policy.approval_roles,
    });
  }
  const request = newApprovalRequest(
    requestId,
    scope,
    issueId,
    reviewerUserId,
    policy.policy_version,
    bounded(payload["actor"], "actor", ID_MAX),
    at,
  );
  state.approvals.set(requestId, request);
  return request;
}

function revokeAuthorityHandler(state: RoutingState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "subject_user_id", "reason", "resolved", "readdress_seed"],
    "revoke_authority",
  );
  const scope = parseScope(payload["scope"], "scope");
  const subjectUserId = bounded(payload["subject_user_id"], "subject_user_id", ID_MAX);
  bounded(payload["reason"], "reason", REASON_MAX);
  const facts = parseResolved(payload["resolved"], "resolved");
  const seed = bounded(payload["readdress_seed"], "readdress_seed", SEED_MAX);
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);

  if (hasApprovalAuthority(memberOf(facts, subjectUserId), policy.approval_roles)) {
    throw new RoutingError("AUTHORITY_STILL_ACTIVE", "subject still holds approval authority", {
      subject_user_id: subjectUserId,
    });
  }
  const pending = [...state.approvals.values()]
    .filter(
      (request) =>
        request.status === "pending" &&
        request.addressee_user_id === subjectUserId &&
        sameScope(request.scope, scope),
    )
    .sort((a, b) => a.request_id.localeCompare(b.request_id));
  const replacement = facts.members
    .filter(
      (member) =>
        member.user_id !== subjectUserId && hasApprovalAuthority(member, policy.approval_roles),
    )
    .map((member) => member.user_id)
    .sort()[0];

  const actor = bounded(payload["actor"], "actor", ID_MAX);
  const invalidated: ApprovalRequestRecord[] = [];
  const created: ApprovalRequestRecord[] = [];
  for (const request of pending) {
    let newRequestId: string | null = null;
    if (replacement !== undefined) {
      newRequestId = readdressedRequestId(seed, request.request_id);
      const createdRequest = newApprovalRequest(
        newRequestId,
        scope,
        request.issue_id,
        replacement,
        policy.policy_version,
        actor,
        at,
      );
      state.approvals.set(createdRequest.request_id, createdRequest);
      created.push(createdRequest);
    } else {
      state.alerts.push({
        kind: "approval_unaddressable",
        scope,
        issue_id: request.issue_id,
        subject_user_id: subjectUserId,
        detail: "no eligible approver remains to re-address the pending approval",
        at,
      });
    }
    const invalidatedRequest: ApprovalRequestRecord = {
      ...request,
      status: "invalidated",
      invalidated_at: at,
      invalidation_reason: "authority_revoked",
      readdressed_request_id: newRequestId,
    };
    state.approvals.set(request.request_id, invalidatedRequest);
    invalidated.push(invalidatedRequest);
  }
  return { invalidated, created };
}

function changeReviewerHandler(state: RoutingState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "issue_id", "new_reviewer_user_id", "reason", "resolved", "request_id"],
    "change_reviewer",
  );
  const scope = parseScope(payload["scope"], "scope");
  const issueId = bounded(payload["issue_id"], "issue_id", ID_MAX);
  const newReviewerUserId = bounded(
    payload["new_reviewer_user_id"],
    "new_reviewer_user_id",
    ID_MAX,
  );
  bounded(payload["reason"], "reason", REASON_MAX);
  const facts = parseResolved(payload["resolved"], "resolved");
  const requestId = bounded(payload["request_id"], "request_id", ID_MAX);
  const at = iso(payload["at"], "at");
  const policy = policyFor(state, scope);

  const pending = [...state.approvals.values()]
    .filter(
      (request) =>
        request.status === "pending" &&
        request.issue_id === issueId &&
        sameScope(request.scope, scope),
    )
    .sort((a, b) => a.request_id.localeCompare(b.request_id));
  const existing = pending[0];
  if (existing === undefined) {
    throw new RoutingError("NO_PENDING_APPROVAL", "issue has no pending approval request", {
      issue_id: issueId,
    });
  }
  const reviewer = memberOf(facts, newReviewerUserId);
  if (candidateEligibility(reviewer) !== "eligible") {
    throw new RoutingError("NOT_ELIGIBLE", "new reviewer is not a current eligible member", {
      reviewer_user_id: newReviewerUserId,
    });
  }
  if (!hasApprovalAuthority(reviewer, policy.approval_roles)) {
    throw new RoutingError("REVIEWER_NOT_AUTHORIZED", "new reviewer holds no approval authority", {
      reviewer_user_id: newReviewerUserId,
      approval_roles: policy.approval_roles,
    });
  }
  const actor = bounded(payload["actor"], "actor", ID_MAX);
  const created = newApprovalRequest(
    requestId,
    scope,
    issueId,
    newReviewerUserId,
    policy.policy_version,
    actor,
    at,
  );
  state.approvals.set(requestId, created);
  const invalidated: ApprovalRequestRecord = {
    ...existing,
    status: "invalidated",
    invalidated_at: at,
    invalidation_reason: "reviewer_changed",
    readdressed_request_id: requestId,
  };
  state.approvals.set(existing.request_id, invalidated);
  return { invalidated, created };
}

type Handler = (state: RoutingState, payload: Payload) => unknown;

export const HANDLERS: Record<RoutingAuditCommand, Handler> = {
  register_policy: registerPolicyHandler,
  route: routeHandler,
  recommend_assignee: recommendAssigneeHandler,
  propose_transfer: proposeTransferHandler,
  confirm_transfer: confirmTransferHandler,
  reject_transfer: rejectTransferHandler,
  address_approval: addressApprovalHandler,
  revoke_authority: revokeAuthorityHandler,
  change_reviewer: changeReviewerHandler,
};
