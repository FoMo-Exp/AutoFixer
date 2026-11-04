import type { AuditCommand } from "./audit.js";
import { canonicalJson, digestOf } from "./audit.js";
import {
  APPROVAL_INVALIDATION_REASONS,
  DELIVERY_STATES,
  TASK_EVIDENCE_CONTRACT_VERSION,
} from "./contract.js";
import type { ApprovalInvalidationReason, DeliveryState } from "./contract.js";
import { bindingForCandidate, bindingMismatch, approvalStateAt } from "./approval.js";
import {
  canTransitionDelivery,
  deliveryBranchProblem,
  providerMatchesRepository,
} from "./delivery.js";
import { CollabError } from "./errors.js";
import { resolveRevisionEvidence, resolveValidationEvidence } from "./evidence.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  ArtifactRef,
  CandidateDiff,
  CandidateRecord,
  CandidateValidation,
  CandidateValidationResult,
  CapabilityGrant,
  ChangeRisk,
  CollabState,
  DeliveryRecord,
  Disposition,
  GrantTool,
  HandoffRecord,
  IssueRecord,
  LeaseRecord,
  RepositoryRef,
  RiskClass,
  Role,
  RunLimits,
  RunRecord,
  RunScope,
  TaskRecord,
  TaskState,
  TestPlanRecord,
  TestPolicyRecord,
  UserRef,
  WorkspaceScope,
  WorktreeRef,
} from "./types.js";
import { RISK_CLASSES, grantStateAt, testPolicyScopeKey } from "./types.js";
import type { DshState } from "../dsh/types.js";
import {
  canTransitionProduct,
  canTransitionRun,
  isTerminalRunState,
  productRunConflict,
  runTransitionIssueConflict,
} from "./states.js";
import type { ProductState } from "./states.js";

/**
 * Pure domain handlers.
 *
 * Each handler validates its fully normalized payload (including the ids and
 * timestamp the machine minted before recording it) and mutates the state.
 * Replaying the audit log through these handlers is therefore a faithful
 * reconstruction: the same payload on the same prior state yields the same
 * result and the same denials. Handlers never mint identifiers and never read
 * the wall clock — `payload.at` is the effective time.
 */

const HANDOFF_SUMMARY_MAX = 2000;
const SUMMARY_MAX = 1000;
const REASON_MAX = 500;
const APPROVAL_NOTE_MAX = 1000;
const DELIVERY_ERROR_CODE_MAX = 160;
const BRANCH_MAX = 200;
const DISPLAY_NAME_MAX = 200;

type Payload = Record<string, unknown>;

const BASE_KEYS = ["operation_id", "actor", "at"] as const;

function assertExactKeys(payload: Payload, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      throw new CollabError("INVALID_INPUT", `${label} has unknown field ${key}`, {
        field: key,
      });
    }
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CollabError("INVALID_INPUT", `${field} must be a non-empty string`, { field });
  }
  return value;
}

function strOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return str(value, field);
}

function bounded(value: unknown, field: string, max: number): string {
  const text = str(value, field);
  if (text.length > max) {
    throw new CollabError("INVALID_INPUT", `${field} exceeds ${max} characters`, {
      field,
      max,
      length: text.length,
    });
  }
  return text;
}

function iso(value: unknown, field: string): string {
  const text = str(value, field);
  const time = Date.parse(text);
  if (Number.isNaN(time)) {
    throw new CollabError("INVALID_INPUT", `${field} must be an RFC 3339 timestamp`, { field });
  }
  return new Date(time).toISOString();
}

function int(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new CollabError("INVALID_INPUT", `${field} must be an integer >= ${min}`, { field, min });
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CollabError("INVALID_INPUT", `${field} must be a boolean`, { field });
  }
  return value;
}

function strArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new CollabError("INVALID_INPUT", `${field} must be an array of strings`, { field });
  }
  return value.map((entry, index) => str(entry, `${field}[${index}]`));
}

function object(value: unknown, field: string): Payload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CollabError("INVALID_INPUT", `${field} must be an object`, { field });
  }
  return value as Payload;
}

function parseWorkspace(value: unknown, field: string): WorkspaceScope {
  const source = object(value, field);
  assertExactKeys(source, ["enterprise_id", "workspace_id"], field);
  return {
    enterprise_id: str(source["enterprise_id"], `${field}.enterprise_id`),
    workspace_id: str(source["workspace_id"], `${field}.workspace_id`),
  };
}

function parseRepository(value: unknown, field: string): RepositoryRef {
  const source = object(value, field);
  assertExactKeys(source, ["repository_id", "url", "base_ref", "base_sha"], field);
  return {
    repository_id: str(source["repository_id"], `${field}.repository_id`),
    url: str(source["url"], `${field}.url`),
    base_ref: str(source["base_ref"], `${field}.base_ref`),
    base_sha: str(source["base_sha"], `${field}.base_sha`),
  };
}

function parseWorktree(value: unknown, field: string): WorktreeRef {
  const source = object(value, field);
  assertExactKeys(source, ["worktree_id", "path"], field);
  return {
    worktree_id: str(source["worktree_id"], `${field}.worktree_id`),
    path: str(source["path"], `${field}.path`),
  };
}

function parseScope(value: unknown, field: string): RunScope {
  const source = object(value, field);
  assertExactKeys(source, ["tools", "paths", "network"], field);
  return {
    tools: strArray(source["tools"], `${field}.tools`),
    paths: strArray(source["paths"], `${field}.paths`),
    network: strArray(source["network"], `${field}.network`),
  };
}

function parseLimits(value: unknown, field: string): RunLimits {
  const source = object(value, field);
  assertExactKeys(source, ["max_wall_clock_seconds", "max_memory_mb", "max_tokens"], field);
  return {
    max_wall_clock_seconds: int(
      source["max_wall_clock_seconds"],
      `${field}.max_wall_clock_seconds`,
      1,
    ),
    max_memory_mb: int(source["max_memory_mb"], `${field}.max_memory_mb`, 1),
    max_tokens: int(source["max_tokens"], `${field}.max_tokens`, 1),
  };
}

function parseRole(value: unknown, field: string): Role {
  const text = str(value, field);
  const roles: Role[] = ["analysis", "planning", "implementation", "verification", "delivery"];
  if (!roles.includes(text as Role)) {
    throw new CollabError("INVALID_INPUT", `${field} is not a known role`, { field, value: text });
  }
  return text as Role;
}

function parseTaskState(value: unknown, field: string): TaskState {
  const text = str(value, field);
  const states: TaskState[] = ["open", "active", "done", "cancelled"];
  if (!states.includes(text as TaskState)) {
    throw new CollabError("INVALID_INPUT", `${field} is not a known task state`, {
      field,
      value: text,
    });
  }
  return text as TaskState;
}

function parseRunState(value: unknown, field: string): DshState {
  const text = str(value, field);
  const states: DshState[] = [
    "requested",
    "approved",
    "running",
    "awaiting_review",
    "approved_for_merge",
    "stopped",
    "timed_out",
    "expired",
    "rejected",
    "cancelled",
    "merged",
  ];
  if (!states.includes(text as DshState)) {
    throw new CollabError("INVALID_INPUT", `${field} is not a harness state`, {
      field,
      value: text,
    });
  }
  return text as DshState;
}

function parseProductState(value: unknown, field: string): ProductState {
  const text = str(value, field);
  const states: ProductState[] = [
    "triage",
    "planning",
    "implementing",
    "validating",
    "awaiting_change_approval",
    "delivering",
    "pr_review",
    "completed",
    "needs_human",
    "cancelled",
  ];
  if (!states.includes(text as ProductState)) {
    throw new CollabError("INVALID_INPUT", `${field} is not a product state`, {
      field,
      value: text,
    });
  }
  return text as ProductState;
}

function parseLease(value: unknown, field: string): { holder: string; fencing_token: number } {
  const source = object(value, field);
  assertExactKeys(source, ["holder", "fencing_token"], field);
  return {
    holder: str(source["holder"], `${field}.holder`),
    fencing_token: int(source["fencing_token"], `${field}.fencing_token`, 1),
  };
}

function parseDisposition(value: unknown, field: string): Disposition {
  const source = object(value, field);
  assertExactKeys(source, ["actor", "reference"], field);
  return {
    actor: str(source["actor"], `${field}.actor`),
    reference: str(source["reference"], `${field}.reference`),
  };
}

function parseArtifact(value: unknown, field: string): ArtifactRef {
  const source = object(value, field);
  assertExactKeys(
    source,
    ["artifact_id", "kind", "digest_algorithm", "digest", "base_sha", "head_sha"],
    field,
  );
  const digest = str(source["digest"], `${field}.digest`);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new CollabError("INVALID_INPUT", `${field}.digest must be a sha256 hex digest`, {
      field: `${field}.digest`,
    });
  }
  return {
    artifact_id: str(source["artifact_id"], `${field}.artifact_id`),
    kind: str(source["kind"], `${field}.kind`),
    digest_algorithm: str(source["digest_algorithm"], `${field}.digest_algorithm`),
    digest,
    base_sha: str(source["base_sha"], `${field}.base_sha`),
    head_sha: strOrNull(source["head_sha"], `${field}.head_sha`),
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function uniqueStrings(values: string[], field: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new CollabError("INVALID_INPUT", `${field} contains a duplicate value`, {
        field,
        value,
      });
    }
    seen.add(value);
  }
  return values;
}

function parseDigestRef(value: unknown, field: string): { algorithm: string; value: string } {
  const source = object(value, field);
  assertExactKeys(source, ["algorithm", "value"], field);
  const algorithm = str(source["algorithm"], `${field}.algorithm`);
  const digest = str(source["value"], `${field}.value`);
  if (algorithm !== "sha256") {
    throw new CollabError("CANDIDATE_INVALID", `${field}.algorithm must be sha256`, {
      field: `${field}.algorithm`,
      value: algorithm,
    });
  }
  if (!SHA256_HEX.test(digest)) {
    throw new CollabError("CANDIDATE_INVALID", `${field}.value must be a sha256 hex digest`, {
      field: `${field}.value`,
      value: digest,
    });
  }
  return { algorithm, value: digest };
}

function parseUserRef(value: unknown, field: string): UserRef {
  const source = object(value, field);
  assertExactKeys(source, ["id", "display_name"], field);
  return {
    id: str(source["id"], `${field}.id`),
    display_name: bounded(source["display_name"], `${field}.display_name`, DISPLAY_NAME_MAX),
  };
}

function parseUserRefOrNull(value: unknown, field: string): UserRef | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseUserRef(value, field);
}

/** The approver-authority facts the trusted caller observed at command time. */
interface ApproverAuthorityFacts {
  member_active: boolean;
  repository_access: boolean;
  approval_authority: boolean;
  authority_version: string;
}

function parseApproverAuthority(value: unknown, field: string): ApproverAuthorityFacts {
  const source = object(value, field);
  assertExactKeys(
    source,
    ["member_active", "repository_access", "approval_authority", "authority_version"],
    field,
  );
  return {
    member_active: bool(source["member_active"], `${field}.member_active`),
    repository_access: bool(source["repository_access"], `${field}.repository_access`),
    approval_authority: bool(source["approval_authority"], `${field}.approval_authority`),
    authority_version: bounded(source["authority_version"], `${field}.authority_version`, 200),
  };
}

function approverAuthorized(facts: ApproverAuthorityFacts): boolean {
  return facts.member_active && facts.repository_access && facts.approval_authority;
}

/** The delivery-authority/audit facts the trusted broker observed before a write. */
interface DeliveryAuthorityFacts {
  approver_authorized: boolean;
  delivery_authorized: boolean;
  audit_available: boolean;
}

function parseDeliveryAuthority(value: unknown, field: string): DeliveryAuthorityFacts {
  const source = object(value, field);
  assertExactKeys(source, ["approver_authorized", "delivery_authorized", "audit_available"], field);
  return {
    approver_authorized: bool(source["approver_authorized"], `${field}.approver_authorized`),
    delivery_authorized: bool(source["delivery_authorized"], `${field}.delivery_authorized`),
    audit_available: bool(source["audit_available"], `${field}.audit_available`),
  };
}

function parseDeliveryState(value: unknown, field: string): DeliveryState {
  const text = str(value, field);
  if (!(DELIVERY_STATES as readonly string[]).includes(text)) {
    throw new CollabError("INVALID_INPUT", `${field} is not a delivery state`, {
      field,
      value: text,
    });
  }
  return text as DeliveryState;
}

function parseProvider(value: unknown, field: string): "github" | "gitlab" {
  const text = str(value, field);
  if (text !== "github" && text !== "gitlab") {
    throw new CollabError("INVALID_INPUT", `${field} must be github or gitlab`, {
      field,
      value: text,
    });
  }
  return text;
}

function parseBranch(value: unknown, field: string): string {
  const branch = bounded(value, field, BRANCH_MAX);
  if (
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("~") ||
    branch.includes("^") ||
    branch.includes(":") ||
    branch.includes("?") ||
    branch.includes("*") ||
    branch.includes("[") ||
    branch.includes("\\") ||
    branch.includes(" ") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    throw new CollabError("INVALID_INPUT", `${field} is not a valid branch name`, {
      field,
      value: branch,
    });
  }
  return branch;
}

function parseErrorCodeOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const code = bounded(value, field, DELIVERY_ERROR_CODE_MAX);
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
    throw new CollabError("INVALID_INPUT", `${field} must be a safe machine code`, {
      field,
      value: code,
    });
  }
  return code;
}

function relativePath(value: unknown, field: string): string {
  const text = str(value, field);
  const normalised = text.replaceAll("\\", "/");
  if (
    normalised.startsWith("/") ||
    normalised.split("/").includes("..") ||
    /^[A-Za-z]:/.test(text)
  ) {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be a repository-relative path`, {
      field,
      value: text,
    });
  }
  return text;
}

/**
 * A candidate diff is immutable evidence: sha256 over the retained content,
 * a non-empty set of repository-relative changed paths, and the exact line
 * counts a reviewer sees. A renamed or empty-diff change is still a valid
 * candidate; only a digest that cannot be recomputed is refused.
 */
function parseCandidateDiff(value: unknown, field: string): CandidateDiff {
  const source = object(value, field);
  assertExactKeys(
    source,
    ["digest_algorithm", "digest", "changed_paths", "insertions", "deletions"],
    field,
  );
  const algorithm = str(source["digest_algorithm"], `${field}.digest_algorithm`);
  if (algorithm !== "sha256") {
    throw new CollabError("CANDIDATE_INVALID", `${field}.digest_algorithm must be sha256`, {
      field: `${field}.digest_algorithm`,
      value: algorithm,
    });
  }
  const digest = str(source["digest"], `${field}.digest`);
  if (!SHA256_HEX.test(digest)) {
    throw new CollabError("CANDIDATE_INVALID", `${field}.digest must be a sha256 hex digest`, {
      field: `${field}.digest`,
      value: digest,
    });
  }
  const changedPaths = strArray(source["changed_paths"], `${field}.changed_paths`).map(
    (path, index) => relativePath(path, `${field}.changed_paths[${index}]`),
  );
  if (changedPaths.length === 0) {
    throw new CollabError("CANDIDATE_INVALID", `${field}.changed_paths must not be empty`, {
      field: `${field}.changed_paths`,
    });
  }
  uniqueStrings(changedPaths, `${field}.changed_paths`);
  return {
    digest_algorithm: algorithm,
    digest,
    changed_paths: changedPaths,
    insertions: int(source["insertions"], `${field}.insertions`, 0),
    deletions: int(source["deletions"], `${field}.deletions`, 0),
  };
}

function parseValidationResult(value: unknown, field: string): CandidateValidationResult {
  const source = object(value, field);
  assertExactKeys(source, ["tool", "exit_status", "output_digest", "event_reference"], field);
  if (
    typeof source["exit_status"] !== "number" ||
    !Number.isInteger(source["exit_status"]) ||
    source["exit_status"] !== 0
  ) {
    // A frozen candidate carries passing evidence only. A failed attempt leaves
    // the run in a stop state that needs human disposition, never a review card.
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field}.exit_status must be 0: a frozen candidate cannot include a failed or unexecuted validation`,
      { field: `${field}.exit_status`, value: source["exit_status"] },
    );
  }
  if (source["output_digest"] === null || source["output_digest"] === undefined) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field}.output_digest is required for executed validation evidence`,
      { field: `${field}.output_digest` },
    );
  }
  return {
    tool: str(source["tool"], `${field}.tool`),
    exit_status: 0,
    output_digest: parseDigestRef(source["output_digest"], `${field}.output_digest`),
    event_reference: str(source["event_reference"], `${field}.event_reference`),
  };
}

function parseCandidateValidation(value: unknown, field: string): CandidateValidation {
  const source = object(value, field);
  assertExactKeys(source, ["config_digest", "environment", "required_checks", "results"], field);
  const rawResults = source["results"];
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field}.results must record at least one validation attempt`,
      { field: `${field}.results` },
    );
  }
  const requiredChecks = uniqueStrings(
    strArray(source["required_checks"], `${field}.required_checks`),
    `${field}.required_checks`,
  );
  if (requiredChecks.length === 0) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field}.required_checks must name the checks the approved test plan requires`,
      { field: `${field}.required_checks` },
    );
  }
  const results = rawResults.map((entry, index) =>
    parseValidationResult(entry, `${field}.results[${index}]`),
  );
  for (const check of requiredChecks) {
    if (!results.some((result) => result.tool === check)) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        `required check ${JSON.stringify(check)} has no recorded passing attempt`,
        { field: `${field}.required_checks`, check },
      );
    }
  }
  return {
    config_digest: str(source["config_digest"], `${field}.config_digest`),
    environment: str(source["environment"], `${field}.environment`),
    required_checks: requiredChecks,
    results,
  };
}

/**
 * The pre-approval risk decision. `prohibited` work never becomes a reviewable
 * candidate, and `elevated` work always carries the human-approval flag —
 * the review card must not understate what the approver is agreeing to.
 */
function parseChangeRisk(value: unknown, field: string): ChangeRisk {
  const source = object(value, field);
  assertExactKeys(source, ["class", "decision_code", "requires_human_approval"], field);
  const riskClass = str(source["class"], `${field}.class`);
  if (!(RISK_CLASSES as readonly string[]).includes(riskClass)) {
    throw new CollabError("INVALID_INPUT", `${field}.class is not a risk class`, {
      field: `${field}.class`,
      value: riskClass,
    });
  }
  if (riskClass === "prohibited") {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "prohibited work is rejected; it never becomes a reviewable candidate",
      { field: `${field}.class` },
    );
  }
  const requiresHumanApproval = bool(
    source["requires_human_approval"],
    `${field}.requires_human_approval`,
  );
  if (requiresHumanApproval !== (riskClass === "elevated")) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field}.requires_human_approval must be ${riskClass === "elevated"} for class ${riskClass}`,
      { field: `${field}.requires_human_approval`, class: riskClass as RiskClass },
    );
  }
  return {
    class: riskClass as RiskClass,
    decision_code: str(source["decision_code"], `${field}.decision_code`),
    requires_human_approval: requiresHumanApproval,
  };
}

function parseInvalidationReason(value: unknown, field: string): ApprovalInvalidationReason {
  const text = str(value, field);
  if (!(APPROVAL_INVALIDATION_REASONS as readonly string[]).includes(text)) {
    throw new CollabError("INVALID_INPUT", `${field} is not an invalidation reason`, {
      field,
      value: text,
    });
  }
  return text as ApprovalInvalidationReason;
}

function parseGrantTools(value: unknown, field: string): GrantTool[] {
  if (!Array.isArray(value)) {
    throw new CollabError("INVALID_INPUT", `${field} must be an array`, { field });
  }
  return value.map((entry, index) => {
    const source = object(entry, `${field}[${index}]`);
    assertExactKeys(source, ["identity", "allowed_arguments"], `${field}[${index}]`);
    return {
      identity: str(source["identity"], `${field}[${index}].identity`),
      allowed_arguments: strArray(
        source["allowed_arguments"],
        `${field}[${index}].allowed_arguments`,
      ),
    };
  });
}

interface GrantInput {
  grant_id: string;
  capability_grant_version: string;
  policy_version: string;
  issued_at: string;
  expires_at: string;
  permitted_paths: string[];
  permitted_tools: GrantTool[];
  network_destinations: string[];
  max_wall_clock_seconds: number;
  resource_limits: { max_memory_mb: number; max_tokens: number };
  may_create_patch: boolean;
  may_create_or_update_pr: boolean;
  scope_digest: string;
}

function parseGrantInput(value: unknown, field: string): GrantInput {
  const source = object(value, field);
  assertExactKeys(
    source,
    [
      "grant_id",
      "capability_grant_version",
      "policy_version",
      "issued_at",
      "expires_at",
      "permitted_paths",
      "permitted_tools",
      "network_destinations",
      "max_wall_clock_seconds",
      "resource_limits",
      "may_create_patch",
      "may_create_or_update_pr",
      "scope_digest",
    ],
    field,
  );
  const limits = object(source["resource_limits"], `${field}.resource_limits`);
  assertExactKeys(limits, ["max_memory_mb", "max_tokens"], `${field}.resource_limits`);
  return {
    grant_id: str(source["grant_id"], `${field}.grant_id`),
    capability_grant_version: str(
      source["capability_grant_version"],
      `${field}.capability_grant_version`,
    ),
    policy_version: str(source["policy_version"], `${field}.policy_version`),
    issued_at: iso(source["issued_at"], `${field}.issued_at`),
    expires_at: iso(source["expires_at"], `${field}.expires_at`),
    permitted_paths: strArray(source["permitted_paths"], `${field}.permitted_paths`),
    permitted_tools: parseGrantTools(source["permitted_tools"], `${field}.permitted_tools`),
    network_destinations: strArray(source["network_destinations"], `${field}.network_destinations`),
    max_wall_clock_seconds: int(
      source["max_wall_clock_seconds"],
      `${field}.max_wall_clock_seconds`,
      1,
    ),
    resource_limits: {
      max_memory_mb: int(limits["max_memory_mb"], `${field}.resource_limits.max_memory_mb`, 1),
      max_tokens: int(limits["max_tokens"], `${field}.resource_limits.max_tokens`, 1),
    },
    may_create_patch: bool(source["may_create_patch"], `${field}.may_create_patch`),
    may_create_or_update_pr: bool(
      source["may_create_or_update_pr"],
      `${field}.may_create_or_update_pr`,
    ),
    scope_digest: str(source["scope_digest"], `${field}.scope_digest`),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function issueOf(state: CollabState, issueId: unknown, field: string): IssueRecord {
  const issue = state.issues.get(str(issueId, field));
  if (!issue) {
    throw new CollabError("ISSUE_NOT_FOUND", "unknown issue", { issue_id: issueId });
  }
  return issue;
}

function runOf(state: CollabState, runId: unknown, field: string): RunRecord {
  const run = state.runs.get(str(runId, field));
  if (!run) {
    throw new CollabError("RUN_NOT_FOUND", "unknown run", { run_id: runId });
  }
  return run;
}

/**
 * Enforce the lease/fencing rule: only the current holder of the current
 * fencing token may mutate the run, and only while the lease is unexpired.
 * A worker that lost its lease (expiry, crash, restart) can never overwrite a
 * newer writer because the fencing token is monotonic and never reused.
 */
function assertLeaseHeld(run: RunRecord, value: unknown, at: string): void {
  const lease = parseLease(value, "lease");
  const current = run.lease;
  if (current === null) {
    throw new CollabError("LEASE_REQUIRED", "run holds no lease", { run_id: run.run_id });
  }
  if (current.expires_at <= at) {
    throw new CollabError("LEASE_STALE", "run lease has expired", {
      run_id: run.run_id,
      holder: current.holder,
      fencing_token: current.fencing_token,
    });
  }
  if (current.holder !== lease.holder || current.fencing_token !== lease.fencing_token) {
    throw new CollabError("LEASE_STALE", "lease is held by another worker", {
      run_id: run.run_id,
      holder: current.holder,
      fencing_token: current.fencing_token,
    });
  }
}

/** Revocation is recorded and permanent; it never depends on the clock. */
function revokeGrant(grant: CapabilityGrant, at: string, reason: string): void {
  if (grant.revoked_at === null) {
    grant.revoked_at = at;
    grant.revoked_reason = reason;
  }
}

function activeGrants(run: RunRecord, at: string): CapabilityGrant[] {
  return run.grants.filter((grant) => grantStateAt(grant, at) === "active");
}

const STOPPING_RUN_STATES: DshState[] = [
  "stopped",
  "timed_out",
  "expired",
  "rejected",
  "cancelled",
  "merged",
];

function handleCreateIssue(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "issue_id",
      "workspace",
      "repository",
      "dedupe_key",
      "summary",
      "source_reference",
    ],
    "create_issue",
  );
  const issueId = str(payload["issue_id"], "issue_id");
  const workspace = parseWorkspace(payload["workspace"], "workspace");
  const repository = parseRepository(payload["repository"], "repository");
  const dedupeKey = str(payload["dedupe_key"], "dedupe_key");
  const summary = bounded(payload["summary"], "summary", SUMMARY_MAX);
  const sourceReference = strOrNull(payload["source_reference"], "source_reference");

  const existingId = state.dedupe.get(dedupeKey);
  if (existingId !== undefined) {
    const existing = state.issues.get(existingId);
    if (!existing) {
      throw new CollabError("ISSUE_NOT_FOUND", "dedupe index references an unknown issue", {
        dedupe_key: dedupeKey,
      });
    }
    const same =
      existing.summary === summary &&
      existing.source_reference === sourceReference &&
      canonicalJson(existing.workspace) === canonicalJson(workspace) &&
      canonicalJson(existing.repository) === canonicalJson(repository);
    if (!same) {
      throw new CollabError("ISSUE_DEDUPE_CONFLICT", "dedupe key was used with a different issue", {
        dedupe_key: dedupeKey,
        issue_id: existingId,
      });
    }
    return clone(existing);
  }

  const issue: IssueRecord = {
    issue_id: issueId,
    workspace,
    repository,
    dedupe_key: dedupeKey,
    summary,
    source_reference: sourceReference,
    product_state: "triage",
    state_reason: null,
    created_at: payload["at"] as string,
    updated_at: payload["at"] as string,
  };
  state.issues.set(issueId, issue);
  state.dedupe.set(dedupeKey, issueId);
  return clone(issue);
}

function handleAddTask(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "task_id", "issue_id", "role", "assignee_agent_id", "depends_on"],
    "add_task",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const taskId = str(payload["task_id"], "task_id");
  const role = parseRole(payload["role"], "role");
  const assignee = strOrNull(payload["assignee_agent_id"], "assignee_agent_id");
  const dependsOn = strArray(payload["depends_on"], "depends_on");
  for (const dependency of dependsOn) {
    const task = state.tasks.get(dependency);
    if (!task || task.issue_id !== issue.issue_id) {
      throw new CollabError("TASK_DEPENDENCY_INVALID", "dependency is not a task of this issue", {
        task_id: dependency,
        issue_id: issue.issue_id,
      });
    }
    if (dependency === taskId) {
      throw new CollabError("TASK_DEPENDENCY_INVALID", "task cannot depend on itself", {
        task_id: taskId,
      });
    }
  }
  const task: TaskRecord = {
    task_id: taskId,
    issue_id: issue.issue_id,
    role,
    assignee_agent_id: assignee,
    depends_on: dependsOn,
    state: "open",
    created_at: payload["at"] as string,
    updated_at: payload["at"] as string,
  };
  state.tasks.set(taskId, task);
  return clone(task);
}

function handleSetTaskState(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "task_id", "to"], "set_task_state");
  const task = state.tasks.get(str(payload["task_id"], "task_id"));
  if (!task) {
    throw new CollabError("TASK_NOT_FOUND", "unknown task", { task_id: payload["task_id"] });
  }
  const to = parseTaskState(payload["to"], "to");
  const allowed: Record<TaskState, TaskState[]> = {
    open: ["active", "cancelled"],
    active: ["done", "cancelled"],
    done: [],
    cancelled: [],
  };
  if (!allowed[task.state].includes(to)) {
    throw new CollabError("TRANSITION_FORBIDDEN", `task cannot move ${task.state} -> ${to}`, {
      task_id: task.task_id,
      from: task.state,
      to,
    });
  }
  if (to === "active") {
    for (const dependency of task.depends_on) {
      const dependencyTask = state.tasks.get(dependency);
      if (!dependencyTask || dependencyTask.state !== "done") {
        throw new CollabError("TASK_BLOCKED", "task dependencies are not complete", {
          task_id: task.task_id,
          blocked_by: dependency,
        });
      }
    }
  }
  task.state = to;
  task.updated_at = payload["at"] as string;
  return clone(task);
}

const RUN_OPEN_STATES: ProductState[] = [
  "planning",
  "implementing",
  "validating",
  "awaiting_change_approval",
  "delivering",
  "needs_human",
];

function handleOpenRun(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "run_id",
      "issue_id",
      "task_id",
      "role",
      "repository",
      "worktree",
      "scope",
      "limits",
    ],
    "open_run",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  if (!RUN_OPEN_STATES.includes(issue.product_state)) {
    throw new CollabError(
      "RUN_OPEN_FORBIDDEN",
      `no run may open in product state ${issue.product_state}`,
      {
        issue_id: issue.issue_id,
        product_state: issue.product_state,
      },
    );
  }
  const taskId = strOrNull(payload["task_id"], "task_id");
  if (taskId !== null) {
    const task = state.tasks.get(taskId);
    if (!task || task.issue_id !== issue.issue_id) {
      throw new CollabError("TASK_NOT_FOUND", "run task is not a task of this issue", {
        task_id: taskId,
        issue_id: issue.issue_id,
      });
    }
  }
  const repository = parseRepository(payload["repository"], "repository");
  if (repository.repository_id !== issue.repository.repository_id) {
    throw new CollabError("INVALID_INPUT", "run repository must match the issue repository", {
      repository_id: repository.repository_id,
      expected: issue.repository.repository_id,
    });
  }
  const worktree = parseWorktree(payload["worktree"], "worktree");
  for (const other of state.runs.values()) {
    if (isTerminalRunState(other.state)) {
      continue;
    }
    if (
      other.worktree.worktree_id === worktree.worktree_id ||
      other.worktree.path === worktree.path
    ) {
      throw new CollabError("WORKTREE_CONFLICT", "worktree is bound to another active run", {
        worktree_id: worktree.worktree_id,
        run_id: other.run_id,
      });
    }
  }
  const run: RunRecord = {
    run_id: str(payload["run_id"], "run_id"),
    issue_id: issue.issue_id,
    task_id: taskId,
    role: parseRole(payload["role"], "role"),
    workspace: issue.workspace,
    repository,
    worktree,
    scope: parseScope(payload["scope"], "scope"),
    limits: parseLimits(payload["limits"], "limits"),
    state: "requested",
    head_sha: null,
    stop_reason: null,
    stopped_at: null,
    fencing_counter: 0,
    lease: null,
    grants: [],
    artifact_refs: [],
    opened_at: payload["at"] as string,
    updated_at: payload["at"] as string,
  };
  state.runs.set(run.run_id, run);
  return clone(run);
}

function handleAcquireLease(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "run_id", "holder", "ttl_seconds"], "acquire_lease");
  const run = runOf(state, payload["run_id"], "run_id");
  if (isTerminalRunState(run.state)) {
    throw new CollabError("RUN_TERMINAL", "terminal run holds no lease", { run_id: run.run_id });
  }
  const holder = str(payload["holder"], "holder");
  const ttl = int(payload["ttl_seconds"], "ttl_seconds", 1);
  const at = payload["at"] as string;
  const current = run.lease;
  if (current !== null && current.expires_at > at) {
    throw new CollabError("LEASE_HELD", "run lease is held by another worker", {
      run_id: run.run_id,
      holder: current.holder,
      fencing_token: current.fencing_token,
    });
  }
  run.fencing_counter += 1;
  const lease: LeaseRecord = {
    holder,
    fencing_token: run.fencing_counter,
    acquired_at: at,
    expires_at: new Date(Date.parse(at) + ttl * 1000).toISOString(),
  };
  run.lease = lease;
  run.updated_at = at;
  return clone(lease);
}

function handleRenewLease(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "run_id", "holder", "fencing_token", "ttl_seconds"],
    "renew_lease",
  );
  const run = runOf(state, payload["run_id"], "run_id");
  const at = payload["at"] as string;
  assertLeaseHeld(run, { holder: payload["holder"], fencing_token: payload["fencing_token"] }, at);
  const ttl = int(payload["ttl_seconds"], "ttl_seconds", 1);
  const lease = run.lease as LeaseRecord;
  lease.expires_at = new Date(Date.parse(at) + ttl * 1000).toISOString();
  run.updated_at = at;
  return clone(lease);
}

function handleReleaseLease(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "run_id", "holder", "fencing_token"], "release_lease");
  const run = runOf(state, payload["run_id"], "run_id");
  const lease = parseLease(
    { holder: payload["holder"], fencing_token: payload["fencing_token"] },
    "lease",
  );
  const current = run.lease;
  if (current === null) {
    throw new CollabError("LEASE_REQUIRED", "run holds no lease", { run_id: run.run_id });
  }
  if (current.holder !== lease.holder || current.fencing_token !== lease.fencing_token) {
    throw new CollabError("LEASE_STALE", "lease is held by another worker", {
      run_id: run.run_id,
      holder: current.holder,
      fencing_token: current.fencing_token,
    });
  }
  run.lease = null;
  run.updated_at = payload["at"] as string;
  return clone(current);
}

function handleRecordGrant(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "run_id", "lease", "grant"], "record_grant");
  const run = runOf(state, payload["run_id"], "run_id");
  const at = payload["at"] as string;
  assertLeaseHeld(run, payload["lease"], at);
  if (isTerminalRunState(run.state)) {
    throw new CollabError("RUN_TERMINAL", "terminal run holds no grant", { run_id: run.run_id });
  }
  const input = parseGrantInput(payload["grant"], "grant");
  if (input.issued_at > at) {
    throw new CollabError("INVALID_INPUT", "grant issued_at is in the future", {
      issued_at: input.issued_at,
    });
  }
  if (input.expires_at <= input.issued_at) {
    throw new CollabError("INVALID_INPUT", "grant expires_at must follow issued_at", {
      issued_at: input.issued_at,
      expires_at: input.expires_at,
    });
  }
  if (activeGrants(run, at).length > 0) {
    throw new CollabError("ACTIVE_GRANT_EXISTS", "run already holds an active grant", {
      run_id: run.run_id,
    });
  }
  const grant: CapabilityGrant = {
    grant_id: input.grant_id,
    run_id: run.run_id,
    capability_grant_version: input.capability_grant_version,
    policy_version: input.policy_version,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    permitted_paths: input.permitted_paths,
    permitted_tools: input.permitted_tools,
    network_destinations: input.network_destinations,
    max_wall_clock_seconds: input.max_wall_clock_seconds,
    resource_limits: input.resource_limits,
    may_create_patch: input.may_create_patch,
    may_create_or_update_pr: input.may_create_or_update_pr,
    scope_digest: input.scope_digest,
    revoked_at: null,
    revoked_reason: null,
  };
  run.grants.push(grant);
  run.updated_at = at;
  return clone(grant);
}

function handleRevokeGrant(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "run_id", "grant_id", "reason"], "revoke_grant");
  const run = runOf(state, payload["run_id"], "run_id");
  const grantId = str(payload["grant_id"], "grant_id");
  const reason = bounded(payload["reason"], "reason", REASON_MAX);
  const grant = run.grants.find((entry) => entry.grant_id === grantId);
  if (!grant) {
    throw new CollabError("GRANT_NOT_FOUND", "unknown grant", { grant_id: grantId });
  }
  revokeGrant(grant, payload["at"] as string, reason);
  run.updated_at = payload["at"] as string;
  return clone(grant);
}

function handleRecordRunState(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "run_id",
      "lease",
      "to",
      "stop_reason",
      "new_grant_id",
      "disposition",
      "head_sha",
    ],
    "record_run_state",
  );
  const run = runOf(state, payload["run_id"], "run_id");
  const at = payload["at"] as string;
  assertLeaseHeld(run, payload["lease"], at);
  const issue = issueOf(state, run.issue_id, "issue_id");
  const to = parseRunState(payload["to"], "to");
  if (isTerminalRunState(run.state)) {
    throw new CollabError("RUN_TERMINAL", `terminal run is ${run.state}`, {
      run_id: run.run_id,
      state: run.state,
    });
  }
  if (!canTransitionRun(run.state, to)) {
    throw new CollabError("TRANSITION_FORBIDDEN", `run cannot move ${run.state} -> ${to}`, {
      run_id: run.run_id,
      from: run.state,
      to,
    });
  }
  const conflict = runTransitionIssueConflict(to, issue.product_state);
  if (conflict !== null) {
    throw new CollabError(conflict.code, conflict.message, conflict.details);
  }

  if (run.state === "stopped" && to === "approved") {
    if (payload["new_grant_id"] === undefined) {
      throw new CollabError("GRANT_REQUIRED", "stopped -> approved requires a new grant", {
        run_id: run.run_id,
      });
    }
    const grantId = str(payload["new_grant_id"], "new_grant_id");
    const grant = run.grants.find((entry) => entry.grant_id === grantId);
    if (!grant) {
      throw new CollabError("GRANT_NOT_FOUND", "stopped run needs a new recorded grant", {
        grant_id: grantId,
      });
    }
    if (run.stopped_at === null || grant.issued_at <= run.stopped_at) {
      throw new CollabError("GRANT_REQUIRED", "grant predates the stop; a new grant is required", {
        grant_id: grantId,
        stopped_at: run.stopped_at,
      });
    }
    const grantState = grantStateAt(grant, at);
    if (grantState === "revoked") {
      throw new CollabError("GRANT_REVOKED", "revoked grants never revive", { grant_id: grantId });
    }
    if (grantState === "expired") {
      throw new CollabError("GRANT_EXPIRED", "expired grants never revive", { grant_id: grantId });
    }
    if (payload["disposition"] === undefined) {
      throw new CollabError("DISPOSITION_REQUIRED", "stopped -> approved needs human disposition", {
        run_id: run.run_id,
      });
    }
    parseDisposition(payload["disposition"], "disposition");
  }

  if (STOPPING_RUN_STATES.includes(to)) {
    const reason = bounded(payload["stop_reason"], "stop_reason", REASON_MAX);
    run.stop_reason = reason;
    run.stopped_at ??= at;
    for (const grant of activeGrants(run, at)) {
      revokeGrant(grant, at, `run_state:${to}`);
    }
  }

  if (payload["head_sha"] !== undefined) {
    run.head_sha = strOrNull(payload["head_sha"], "head_sha");
  }
  run.state = to;
  run.updated_at = at;
  return clone(run);
}

function handleAttachArtifact(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "run_id", "lease", "artifact"], "attach_artifact");
  const run = runOf(state, payload["run_id"], "run_id");
  const at = payload["at"] as string;
  assertLeaseHeld(run, payload["lease"], at);
  if (isTerminalRunState(run.state)) {
    throw new CollabError("RUN_TERMINAL", "terminal run holds no new artifacts", {
      run_id: run.run_id,
    });
  }
  const input = parseArtifact(payload["artifact"], "artifact");
  if (input.base_sha !== run.repository.base_sha) {
    throw new CollabError("INVALID_INPUT", "artifact must bind to the run's base revision", {
      base_sha: input.base_sha,
      expected: run.repository.base_sha,
    });
  }
  const existing = run.artifact_refs.find(
    (ref) =>
      ref.kind === input.kind && ref.digest === input.digest && ref.head_sha === input.head_sha,
  );
  if (existing) {
    return clone(existing);
  }
  run.artifact_refs.push(input);
  run.updated_at = at;
  return clone(input);
}

function handleTransitionIssue(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "issue_id", "to", "reason"], "transition_issue");
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const to = parseProductState(payload["to"], "to");
  const reason = strOrNull(payload["reason"], "reason");
  if (!canTransitionProduct(issue.product_state, to)) {
    throw new CollabError(
      "TRANSITION_FORBIDDEN",
      `issue cannot move ${issue.product_state} -> ${to}`,
      { issue_id: issue.issue_id, from: issue.product_state, to },
    );
  }
  if ((to === "needs_human" || to === "cancelled") && reason === null) {
    throw new CollabError("INVALID_INPUT", `${to} requires a recorded reason`, { to });
  }
  const runs = [...state.runs.values()].filter((run) => run.issue_id === issue.issue_id);
  const conflict = productRunConflict(
    to,
    runs.map((run) => ({ state: run.state, artifact_refs: run.artifact_refs })),
  );
  if (conflict !== null) {
    throw new CollabError(conflict.code, conflict.message, conflict.details);
  }
  if (to === "needs_human" || to === "cancelled") {
    for (const run of runs) {
      for (const grant of activeGrants(run, payload["at"] as string)) {
        revokeGrant(grant, payload["at"] as string, `issue_state:${to}`);
      }
    }
  }
  if (to === "cancelled") {
    // Cancellation revokes remaining actions: pending approvals can no longer
    // be decided, and an operation that has not produced a provider side
    // effect is cancelled rather than left able to write later.
    cancelApprovalsForIssue(state, issue.issue_id, payload["at"] as string);
    for (const delivery of state.deliveries.values()) {
      if (delivery.issue_id !== issue.issue_id) {
        continue;
      }
      if (
        delivery.state === "pending" ||
        delivery.state === "pushing" ||
        delivery.state === "opening_pr" ||
        delivery.state === "unknown"
      ) {
        delivery.state = "cancelled";
        delivery.updated_at = payload["at"] as string;
      }
    }
  }
  issue.product_state = to;
  issue.state_reason = reason;
  issue.updated_at = payload["at"] as string;
  return clone(issue);
}

const HANDOFF_KEYS = [
  ...BASE_KEYS,
  "handoff_id",
  "issue_id",
  "from_run_id",
  "to_run_id",
  "summary",
  "artifact_refs",
  "head_identity",
  "lease",
] as const;

function handleRecordHandoff(state: CollabState, payload: Payload): unknown {
  // Strict shape: a handoff carries a bounded summary, immutable artifact
  // references, and head identity. Raw memory, transcripts, or chat history
  // are rejected as unknown fields, never silently shared.
  assertExactKeys(payload, HANDOFF_KEYS, "record_handoff");
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const fromRun = runOf(state, payload["from_run_id"], "from_run_id");
  const at = payload["at"] as string;
  assertLeaseHeld(fromRun, payload["lease"], at);
  if (fromRun.issue_id !== issue.issue_id) {
    throw new CollabError("INVALID_INPUT", "source run belongs to another issue", {
      run_id: fromRun.run_id,
      issue_id: fromRun.issue_id,
    });
  }
  const toRunId = strOrNull(payload["to_run_id"], "to_run_id");
  if (toRunId !== null) {
    const toRun = state.runs.get(toRunId);
    if (!toRun || toRun.issue_id !== issue.issue_id) {
      throw new CollabError("RUN_NOT_FOUND", "target run is not a run of this issue", {
        run_id: toRunId,
        issue_id: issue.issue_id,
      });
    }
  }
  const summary = bounded(payload["summary"], "summary", HANDOFF_SUMMARY_MAX);
  const rawRefs = payload["artifact_refs"];
  if (!Array.isArray(rawRefs)) {
    throw new CollabError("INVALID_INPUT", "artifact_refs must be an array", {
      field: "artifact_refs",
    });
  }
  const refs = rawRefs.map((entry, index) => parseArtifact(entry, `artifact_refs[${index}]`));
  for (const ref of refs) {
    const source = fromRun.artifact_refs.find(
      (candidate) => candidate.artifact_id === ref.artifact_id && candidate.digest === ref.digest,
    );
    if (!source) {
      throw new CollabError(
        "ARTIFACT_NOT_FOUND",
        "handoff reference is not an artifact of the run",
        {
          artifact_id: ref.artifact_id,
          run_id: fromRun.run_id,
        },
      );
    }
    if (canonicalJson(source) !== canonicalJson(ref)) {
      throw new CollabError(
        "INVALID_INPUT",
        "handoff reference does not match the artifact record",
        {
          artifact_id: ref.artifact_id,
        },
      );
    }
  }
  const headSource = object(payload["head_identity"], "head_identity");
  assertExactKeys(headSource, ["base_sha", "head_sha"], "head_identity");
  const headIdentity = {
    base_sha: str(headSource["base_sha"], "head_identity.base_sha"),
    head_sha: strOrNull(headSource["head_sha"], "head_identity.head_sha"),
  };
  if (
    headIdentity.base_sha !== fromRun.repository.base_sha ||
    headIdentity.head_sha !== (fromRun.head_sha ?? null)
  ) {
    throw new CollabError("INVALID_INPUT", "head identity must match the source run", {
      run_id: fromRun.run_id,
      head_identity: headIdentity,
    });
  }
  const handoff: HandoffRecord = {
    handoff_id: str(payload["handoff_id"], "handoff_id"),
    issue_id: issue.issue_id,
    from_run_id: fromRun.run_id,
    to_run_id: toRunId,
    summary,
    artifact_refs: refs,
    head_identity: headIdentity,
    created_at: at,
  };
  state.handoffs.push(handoff);
  return clone(handoff);
}

function handleRequestRunRestart(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "run_id", "trigger"], "request_run_restart");
  const run = runOf(state, payload["run_id"], "run_id");
  const trigger = str(payload["trigger"], "trigger");
  if (trigger !== "queue_retry" && trigger !== "model_message") {
    throw new CollabError("INVALID_INPUT", "trigger must be queue_retry or model_message", {
      trigger,
    });
  }
  // A stopped or terminal run is never restarted by a queue retry or a model
  // message; continuation needs human disposition and a fresh run/grant.
  throw new CollabError(
    "RUN_RESTART_FORBIDDEN",
    `run state ${run.state} cannot be restarted by ${trigger}`,
    { run_id: run.run_id, run_state: run.state, trigger },
  );
}

const POLICY_CONFIG_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Digest over the immutable content of one test-policy version. */
function testPolicyDigest(input: {
  workspace: WorkspaceScope;
  repository_id: string;
  repository_url: string;
  policy_version: string;
  checks: string[];
  config_digest: string;
  environment: string;
}): string {
  return digestOf({
    workspace: input.workspace,
    repository_id: input.repository_id,
    repository_url: input.repository_url,
    policy_version: input.policy_version,
    checks: input.checks,
    config_digest: input.config_digest,
    environment: input.environment,
  });
}

/**
 * Register one version of the workspace + repository test policy. Required
 * checks, config digest, and environment are approved here by the caller
 * boundary (the configuration administrator) and recorded as `registered_by`;
 * a run lease never defines policy. The new version becomes the repository's
 * current one and older versions stay for audit and replay.
 */
function handleRegisterTestPolicy(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "policy_id",
      "workspace",
      "repository_id",
      "repository_url",
      "policy_version",
      "checks",
      "config_digest",
      "environment",
    ],
    "register_test_policy",
  );
  const workspace = parseWorkspace(payload["workspace"], "workspace");
  const repositoryId = str(payload["repository_id"], "repository_id");
  const repositoryUrl = str(payload["repository_url"], "repository_url");
  const policyVersion = str(payload["policy_version"], "policy_version");
  const checks = uniqueStrings(strArray(payload["checks"], "checks"), "checks");
  if (checks.length === 0) {
    throw new CollabError("INVALID_INPUT", "a test policy requires at least one check", {
      field: "checks",
    });
  }
  const configDigest = str(payload["config_digest"], "config_digest");
  if (!POLICY_CONFIG_DIGEST.test(configDigest)) {
    throw new CollabError("INVALID_INPUT", "config_digest must be sha256:<64 hex characters>", {
      field: "config_digest",
      value: configDigest,
    });
  }
  const environment = str(payload["environment"], "environment");
  const content = {
    workspace,
    repository_id: repositoryId,
    repository_url: repositoryUrl,
    policy_version: policyVersion,
    checks,
    config_digest: configDigest,
    environment,
  };
  const policyDigest = testPolicyDigest(content);
  const scope = testPolicyScopeKey(workspace, repositoryId);
  for (const existing of state.testPolicies.values()) {
    if (
      testPolicyScopeKey(existing.workspace, existing.repository_id) === scope &&
      existing.policy_version === policyVersion
    ) {
      throw new CollabError(
        "TEST_POLICY_CONFLICT",
        "that policy version is already registered; a changed policy needs a new version",
        { policy_version: policyVersion, policy_id: existing.policy_id },
      );
    }
  }
  const policy: TestPolicyRecord = {
    policy_id: str(payload["policy_id"], "policy_id"),
    workspace,
    repository_id: repositoryId,
    repository_url: repositoryUrl,
    policy_version: policyVersion,
    checks,
    config_digest: configDigest,
    environment,
    policy_digest: policyDigest,
    registered_by: str(payload["actor"], "actor"),
    registered_at: payload["at"] as string,
  };
  state.testPolicies.set(policy.policy_id, policy);
  state.currentTestPolicies.set(scope, policy.policy_id);
  return clone(policy);
}

/**
 * Bind one run to the repository's current test-policy version. The plan takes
 * only the binding — checks, config digest, and environment are frozen from
 * the registered policy and must never be supplied per command.
 */
function handleRecordTestPlan(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "plan_id", "run_id", "policy_id"], "record_test_plan");
  const run = runOf(state, payload["run_id"], "run_id");
  const at = payload["at"] as string;
  if (isTerminalRunState(run.state)) {
    throw new CollabError("RUN_TERMINAL", "terminal run records no test plan", {
      run_id: run.run_id,
    });
  }
  if (run.state !== "approved" && run.state !== "running") {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `a test plan is recorded before validation runs (run is ${run.state})`,
      { run_id: run.run_id, state: run.state },
    );
  }
  const policyId = str(payload["policy_id"], "policy_id");
  const policy = state.testPolicies.get(policyId);
  if (policy === undefined) {
    throw new CollabError("TEST_POLICY_NOT_FOUND", "unknown test policy", {
      policy_id: policyId,
    });
  }
  if (
    policy.workspace.enterprise_id !== run.workspace.enterprise_id ||
    policy.workspace.workspace_id !== run.workspace.workspace_id ||
    policy.repository_id !== run.repository.repository_id ||
    policy.repository_url !== run.repository.url
  ) {
    // Another repository's or workspace's policy is indistinguishable from a
    // missing one: the binding cannot be used to enumerate other scopes.
    throw new CollabError("TEST_POLICY_NOT_FOUND", "unknown test policy", {
      policy_id: policyId,
    });
  }
  const current = state.currentTestPolicies.get(
    testPolicyScopeKey(policy.workspace, policy.repository_id),
  );
  if (current !== policyId) {
    throw new CollabError(
      "TEST_POLICY_CONFLICT",
      "the run may only bind the repository's current policy version",
      { policy_id: policyId, current_policy_id: current ?? null },
    );
  }
  for (const existing of state.testPlans.values()) {
    if (existing.run_id === run.run_id) {
      throw new CollabError(
        "TEST_PLAN_CONFLICT",
        "the run already has an approved test plan; a new plan needs a new run",
        { run_id: run.run_id, plan_id: existing.plan_id },
      );
    }
  }
  const planId = str(payload["plan_id"], "plan_id");
  if (state.testPlans.has(planId)) {
    throw new CollabError("TEST_PLAN_CONFLICT", "test plan id already exists", {
      plan_id: planId,
    });
  }
  const plan: TestPlanRecord = {
    plan_id: planId,
    run_id: run.run_id,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_digest: policy.policy_digest,
    checks: [...policy.checks],
    config_digest: policy.config_digest,
    environment: policy.environment,
    recorded_at: at,
  };
  state.testPlans.set(plan.plan_id, plan);
  run.updated_at = at;
  return clone(plan);
}

const CANDIDATE_FREEZE_PRODUCT_STATES: ProductState[] = [
  "implementing",
  "validating",
  "awaiting_change_approval",
];

function handleFreezeCandidate(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "candidate_id",
      "issue_id",
      "run_id",
      "summary",
      "base_sha",
      "head_sha",
      "tree_sha",
      "diff",
      "validation",
      "risk",
      "artifact_ids",
      "audit_refs",
    ],
    "freeze_candidate",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const run = runOf(state, payload["run_id"], "run_id");
  if (run.issue_id !== issue.issue_id) {
    throw new CollabError("CANDIDATE_INVALID", "candidate run belongs to another issue", {
      issue_id: issue.issue_id,
      run_id: run.run_id,
    });
  }
  if (!CANDIDATE_FREEZE_PRODUCT_STATES.includes(issue.product_state)) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `no candidate may freeze in product state ${issue.product_state}`,
      { issue_id: issue.issue_id, product_state: issue.product_state },
    );
  }
  if (run.state !== "stopped") {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `candidate freezes only when the preparation run stopped (run is ${run.state})`,
      { run_id: run.run_id, state: run.state },
    );
  }
  const at = payload["at"] as string;
  if (activeGrants(run, at).length > 0) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "the preparation grant must be revoked before the candidate is frozen",
      { run_id: run.run_id },
    );
  }

  const baseSha = str(payload["base_sha"], "base_sha");
  if (baseSha !== run.repository.base_sha || baseSha !== issue.repository.base_sha) {
    // The base moved after preparation; the diff and its test evidence no
    // longer describe the tree that would be delivered.
    throw new CollabError("BASE_ADVANCED", "the repository base advanced after the run opened", {
      base_sha: baseSha,
      run_base_sha: run.repository.base_sha,
      issue_base_sha: issue.repository.base_sha,
    });
  }
  const headSha = str(payload["head_sha"], "head_sha");
  if (run.head_sha !== headSha) {
    throw new CollabError("CANDIDATE_INVALID", "candidate head must match the stopped run head", {
      run_id: run.run_id,
      run_head_sha: run.head_sha,
      head_sha: headSha,
    });
  }
  const treeSha = str(payload["tree_sha"], "tree_sha");
  const summary = bounded(payload["summary"], "summary", SUMMARY_MAX);
  const diff = parseCandidateDiff(payload["diff"], "diff");
  const validation = parseCandidateValidation(payload["validation"], "validation");
  const risk = parseChangeRisk(payload["risk"], "risk");

  // The required checks are not the candidate submitter's to declare: they
  // come from the run's approved test plan, recorded before validation ran.
  const plan = [...state.testPlans.values()].find((entry) => entry.run_id === run.run_id);
  if (plan === undefined) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "no approved test plan was recorded for the preparation run",
      { run_id: run.run_id },
    );
  }
  const policy = state.testPolicies.get(plan.policy_id);
  if (policy === undefined) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "the test policy bound to the run's plan is no longer registered",
      { run_id: run.run_id, policy_id: plan.policy_id },
    );
  }
  // The plan is a binding, not a copy: its frozen values must still be exactly
  // the registered version it claims, or the evidence is bound to nothing.
  if (
    plan.policy_digest !== policy.policy_digest ||
    plan.policy_version !== policy.policy_version ||
    plan.config_digest !== policy.config_digest ||
    plan.environment !== policy.environment ||
    canonicalJson(plan.checks) !== canonicalJson(policy.checks)
  ) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "the bound test plan diverges from its registered policy version",
      { plan_id: plan.plan_id, policy_id: policy.policy_id },
    );
  }
  if (
    validation.config_digest !== plan.config_digest ||
    validation.environment !== plan.environment
  ) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "validation configuration or environment differs from the approved test plan",
      {
        plan_config_digest: plan.config_digest,
        validation_config_digest: validation.config_digest,
        plan_environment: plan.environment,
        validation_environment: validation.environment,
      },
    );
  }
  const planChecks = [...plan.checks].sort();
  const declaredChecks = [...validation.required_checks].sort();
  if (
    planChecks.length !== declaredChecks.length ||
    planChecks.some((check, index) => check !== declaredChecks[index])
  ) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "required checks must be exactly the checks of the approved test plan",
      { plan_checks: plan.checks, required_checks: validation.required_checks },
    );
  }
  for (const result of validation.results) {
    if (!plan.checks.includes(result.tool)) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "a validation result names a check that is not in the approved test plan",
        { tool: result.tool, plan_checks: plan.checks },
      );
    }
  }

  const artifactIds = uniqueStrings(
    strArray(payload["artifact_ids"], "artifact_ids"),
    "artifact_ids",
  );
  if (artifactIds.length === 0) {
    throw new CollabError("CANDIDATE_INVALID", "candidate evidence references no artifact", {
      field: "artifact_ids",
    });
  }
  const artifacts = artifactIds.map((artifactId) => {
    const artifact = run.artifact_refs.find((ref) => ref.artifact_id === artifactId);
    if (!artifact) {
      throw new CollabError("ARTIFACT_NOT_FOUND", "artifact is not retained by the run", {
        artifact_id: artifactId,
        run_id: run.run_id,
      });
    }
    return artifact;
  });
  const patch = artifacts.find((artifact) => artifact.kind === "patch");
  if (!patch) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "candidate evidence must reference a patch artifact",
      {
        field: "artifact_ids",
      },
    );
  }
  if (patch.digest !== diff.digest || patch.head_sha !== headSha || patch.base_sha !== baseSha) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "patch artifact does not bind the frozen diff digest, base, and head",
      {
        artifact_id: patch.artifact_id,
        artifact_digest: patch.digest,
        diff_digest: diff.digest,
      },
    );
  }
  if (!artifacts.some((artifact) => artifact.kind === "report")) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "candidate evidence must reference a report artifact",
      { field: "artifact_ids" },
    );
  }
  if (!run.artifact_refs.some((artifact) => artifact.kind === "candidate")) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "the stopped preparation run must preserve a candidate artifact",
      { run_id: run.run_id },
    );
  }

  // Every claimed reference must resolve to a record this run actually
  // retained. Validation evidence is additionally a retained execution
  // artifact from the exact frozen revision whose digest is the declared
  // output digest, so a card cannot cite an unrelated artifact, another
  // revision, or an unbacked "passing" result.
  const evidence = { run, plan };
  const binding = { base_sha: baseSha, head_sha: headSha };
  for (const [index, result] of validation.results.entries()) {
    resolveValidationEvidence(
      evidence,
      result.event_reference,
      `validation.results[${index}].event_reference`,
      binding,
      result.output_digest as { algorithm: string; value: string },
    );
  }
  const auditRefs = uniqueStrings(strArray(payload["audit_refs"], "audit_refs"), "audit_refs");
  if (auditRefs.length === 0) {
    throw new CollabError("CANDIDATE_INVALID", "candidate evidence has no audit reference", {
      field: "audit_refs",
    });
  }
  for (const [index, reference] of auditRefs.entries()) {
    resolveRevisionEvidence(evidence, reference, `audit_refs[${index}]`, binding);
  }

  // One preparation run freezes exactly one candidate; a later revision is a
  // new run, never an edit of this record.
  for (const existing of state.candidates.values()) {
    if (existing.run_id === run.run_id) {
      throw new CollabError(
        "CANDIDATE_CONFLICT",
        "the preparation run already froze a candidate; a revision needs a new run",
        { run_id: run.run_id, candidate_id: existing.candidate_id },
      );
    }
  }
  const candidateId = str(payload["candidate_id"], "candidate_id");
  if (state.candidates.has(candidateId)) {
    throw new CollabError("CANDIDATE_CONFLICT", "candidate id already exists", {
      candidate_id: candidateId,
    });
  }

  const candidate: CandidateRecord = {
    candidate_id: candidateId,
    issue_id: issue.issue_id,
    run_id: run.run_id,
    workspace: clone(issue.workspace),
    repository: clone(run.repository),
    base_sha: baseSha,
    head_sha: headSha,
    tree_sha: treeSha,
    diff,
    summary,
    validation,
    risk,
    test_policy: {
      policy_id: plan.policy_id,
      policy_version: plan.policy_version,
      policy_digest: plan.policy_digest,
    },
    artifacts: artifacts.map((artifact) => clone(artifact)),
    audit_refs: auditRefs,
    created_at: at,
    invalidated_at: null,
    invalidated_reason: null,
  };
  state.candidates.set(candidateId, candidate);
  return clone(candidate);
}

function handleInvalidateCandidate(state: CollabState, payload: Payload): unknown {
  assertExactKeys(payload, [...BASE_KEYS, "candidate_id", "reason"], "invalidate_candidate");
  const candidateId = str(payload["candidate_id"], "candidate_id");
  const candidate = state.candidates.get(candidateId);
  if (!candidate) {
    throw new CollabError("CANDIDATE_NOT_FOUND", "unknown candidate", {
      candidate_id: candidateId,
    });
  }
  const reason = parseInvalidationReason(payload["reason"], "reason");
  if (candidate.invalidated_at === null) {
    // Invalidation is recorded once and never cleared: a later revision is a
    // new candidate, not a revival of this record.
    candidate.invalidated_at = payload["at"] as string;
    candidate.invalidated_reason = reason;
  }
  // An approval bound to a candidate that is no longer valid can never
  // authorize delivery, so the request is invalidated in the same record.
  invalidateApprovalsForCandidate(state, candidate.candidate_id, payload["at"] as string, reason);
  return clone(candidate);
}

/**
 * Record that the issue's base revision advanced (rebase or upstream push).
 * Every candidate frozen against an older base becomes permanently invalid and
 * can never be approved or delivered; new work needs a fresh run and a new
 * candidate. Records are never rewritten, only marked.
 */
function handleRecordBaseAdvance(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "issue_id", "base_sha", "base_ref"],
    "record_base_advance",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const baseSha = str(payload["base_sha"], "base_sha");
  const baseRef = strOrNull(payload["base_ref"], "base_ref");
  const at = payload["at"] as string;
  if (baseRef !== null) {
    issue.repository.base_ref = baseRef;
  }
  issue.repository.base_sha = baseSha;
  issue.updated_at = at;
  const invalidatedCandidateIds: string[] = [];
  for (const candidate of state.candidates.values()) {
    if (
      candidate.issue_id === issue.issue_id &&
      candidate.invalidated_at === null &&
      candidate.base_sha !== baseSha
    ) {
      candidate.invalidated_at = at;
      candidate.invalidated_reason = "base_advanced";
      invalidatedCandidateIds.push(candidate.candidate_id);
    }
  }
  // Base advancement and a changed target branch both invalidate an approval:
  // the approved tree/evidence or the intended destination no longer describes
  // what delivery would produce. A consumed approval is invalidated too, so a
  // broker write after the change is refused rather than authorized by a
  // consumed but stale request.
  const invalidatedApprovalIds: string[] = [];
  for (const approval of state.approvals.values()) {
    if (approval.issue_id !== issue.issue_id) {
      continue;
    }
    if (!approvalIsActionable(approval, at) && approval.state !== "consumed") {
      continue;
    }
    if (approval.state === "invalidated" || approval.state === "cancelled") {
      continue;
    }
    const reason =
      baseRef !== null && approval.binding.target_branch !== baseRef
        ? "target_changed"
        : invalidatedCandidateIds.includes(approval.candidate_id)
          ? "base_advanced"
          : null;
    if (reason === null) {
      continue;
    }
    approval.state = "invalidated";
    approval.invalidated_at = at;
    approval.invalidated_reason = reason;
    invalidatedApprovalIds.push(approval.approval_id);
  }
  return {
    issue: clone(issue),
    invalidated_candidate_ids: invalidatedCandidateIds,
    invalidated_approval_ids: invalidatedApprovalIds,
  };
}

function approvalOf(state: CollabState, approvalId: unknown, field: string): ApprovalRecord {
  const id = str(approvalId, field);
  const approval = state.approvals.get(id);
  if (!approval) {
    throw new CollabError("APPROVAL_NOT_FOUND", "unknown approval request", {
      approval_id: id,
    });
  }
  return approval;
}

function deliveryOf(state: CollabState, deliveryId: unknown, field: string): DeliveryRecord {
  const id = str(deliveryId, field);
  const delivery = state.deliveries.get(id);
  if (!delivery) {
    throw new CollabError("DELIVERY_NOT_FOUND", "unknown delivery operation", {
      delivery_id: id,
    });
  }
  return delivery;
}

function approvalIsActionable(approval: ApprovalRecord, at: string): boolean {
  const effective = approvalStateAt(approval, at);
  return effective === "pending" || effective === "approved";
}

/**
 * Invalidate every still-actionable approval bound to one candidate. The old
 * request is never reused; a new revision needs a new candidate and a newly
 * addressed request.
 */
function invalidateApprovalsForCandidate(
  state: CollabState,
  candidateId: string,
  at: string,
  reason: ApprovalInvalidationReason,
): string[] {
  const invalidated: string[] = [];
  for (const approval of state.approvals.values()) {
    if (approval.candidate_id !== candidateId) {
      continue;
    }
    if (!approvalIsActionable(approval, at) && approval.state !== "consumed") {
      continue;
    }
    if (approval.state === "invalidated" || approval.state === "cancelled") {
      continue;
    }
    approval.state = "invalidated";
    approval.invalidated_at = at;
    approval.invalidated_reason = reason;
    invalidated.push(approval.approval_id);
  }
  return invalidated;
}

function cancelApprovalsForIssue(state: CollabState, issueId: string, at: string): string[] {
  const cancelled: string[] = [];
  for (const approval of state.approvals.values()) {
    if (approval.issue_id !== issueId) {
      continue;
    }
    if (!approvalIsActionable(approval, at)) {
      continue;
    }
    approval.state = "cancelled";
    cancelled.push(approval.approval_id);
  }
  return cancelled;
}

/** Deny with the approval-specific state conflict semantics. */
function approvalStateConflict(approval: ApprovalRecord, at: string): CollabError {
  const effective = approvalStateAt(approval, at);
  return new CollabError("APPROVAL_STATE_CONFLICT", `approval is ${effective}, not pending`, {
    approval_id: approval.approval_id,
    state: effective,
  });
}

function handleRequestApproval(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "approval_id",
      "issue_id",
      "candidate_id",
      "target_branch",
      "approver",
      "no_eligible_approver",
      "authority",
      "expires_at",
    ],
    "request_approval",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  if (issue.product_state !== "awaiting_change_approval") {
    throw new CollabError(
      "APPROVAL_REQUIRED",
      `approval may only be requested while the issue awaits change approval (issue is ${issue.product_state})`,
      { issue_id: issue.issue_id, product_state: issue.product_state },
    );
  }
  const candidateId = str(payload["candidate_id"], "candidate_id");
  const candidate = state.candidates.get(candidateId);
  if (!candidate || candidate.issue_id !== issue.issue_id) {
    throw new CollabError("CANDIDATE_NOT_FOUND", "candidate is not frozen on this issue", {
      candidate_id: candidateId,
      issue_id: issue.issue_id,
    });
  }
  if (candidate.invalidated_at !== null) {
    throw new CollabError("CANDIDATE_INVALID", "an invalidated candidate cannot be approved", {
      candidate_id: candidate.candidate_id,
      reason: candidate.invalidated_reason ?? "invalidated",
    });
  }
  if (candidate.base_sha !== issue.repository.base_sha) {
    throw new CollabError("BASE_ADVANCED", "the issue base advanced after the candidate froze", {
      candidate_base_sha: candidate.base_sha,
      issue_base_sha: issue.repository.base_sha,
    });
  }
  const targetBranch = parseBranch(payload["target_branch"], "target_branch");
  if (targetBranch !== issue.repository.base_ref) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "an approval may only bind the issue's intended target branch",
      { target_branch: targetBranch, base_ref: issue.repository.base_ref },
    );
  }
  const approver = parseUserRefOrNull(payload["approver"], "approver");
  const noEligible = bool(payload["no_eligible_approver"], "no_eligible_approver");
  const authority = parseApproverAuthority(payload["authority"], "authority");
  if (approver === null) {
    if (!noEligible) {
      throw new CollabError(
        "APPROVER_NOT_AUTHORIZED",
        "an unaddressed approval request requires that no eligible approver exists",
        { frame: "no_eligible_approver" },
      );
    }
  } else {
    if (noEligible) {
      throw new CollabError(
        "APPROVER_NOT_AUTHORIZED",
        "an eligible approver exists; the request must name them",
        { approver_id: approver.id },
      );
    }
    if (!approverAuthorized(authority)) {
      throw new CollabError(
        "APPROVER_NOT_AUTHORIZED",
        "the named approver lacks current repository access or approval authority",
        { approver_id: approver.id, authority_version: authority.authority_version },
      );
    }
  }
  const at = payload["at"] as string;
  for (const existing of state.approvals.values()) {
    if (
      existing.candidate_id === candidate.candidate_id &&
      existing.issue_id === issue.issue_id &&
      approvalIsActionable(existing, at)
    ) {
      throw new CollabError(
        "APPROVAL_ALREADY_PENDING",
        "the candidate already has an actionable approval request",
        { approval_id: existing.approval_id, candidate_id: candidate.candidate_id },
      );
    }
  }
  const approvalId = str(payload["approval_id"], "approval_id");
  if (state.approvals.has(approvalId)) {
    throw new CollabError("APPROVAL_STATE_CONFLICT", "approval id already exists", {
      approval_id: approvalId,
    });
  }
  const expiresAt = iso(payload["expires_at"], "expires_at");
  if (expiresAt <= at) {
    throw new CollabError("INVALID_INPUT", "approval expiry must follow the request time", {
      expires_at: expiresAt,
    });
  }
  const approval: ApprovalRecord = {
    contract_version: TASK_EVIDENCE_CONTRACT_VERSION,
    approval_id: approvalId,
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    state: "pending",
    binding: bindingForCandidate(candidate, targetBranch),
    approver: approver === null ? null : clone(approver),
    requested_at: at,
    decided_at: null,
    expires_at: expiresAt,
    decision: null,
    invalidated_at: null,
    invalidated_reason: null,
    consumed_by_delivery_id: null,
  };
  state.approvals.set(approvalId, approval);
  return clone(approval);
}

function handleDecideApproval(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "approval_id",
      "issue_id",
      "decision",
      "diff_digest",
      "note",
      "actor_user",
      "authority",
    ],
    "decide_approval",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const approval = approvalOf(state, payload["approval_id"], "approval_id");
  if (approval.issue_id !== issue.issue_id) {
    throw new CollabError("APPROVAL_NOT_FOUND", "approval is not addressed to this issue", {
      approval_id: approval.approval_id,
      issue_id: issue.issue_id,
    });
  }
  const actorUser = parseUserRef(payload["actor_user"], "actor_user");
  if (approval.approver === null || approval.approver.id !== actorUser.id) {
    throw new CollabError(
      "APPROVER_NOT_AUTHORIZED",
      "only the addressed human approver may decide this request",
      { approval_id: approval.approval_id },
    );
  }
  const at = payload["at"] as string;
  if (approvalStateAt(approval, at) !== "pending") {
    throw approvalStateConflict(approval, at);
  }
  const authority = parseApproverAuthority(payload["authority"], "authority");
  if (!approverAuthorized(authority)) {
    throw new CollabError(
      "APPROVER_NOT_AUTHORIZED",
      "the approver lost current repository access or approval authority",
      { approver_id: actorUser.id, authority_version: authority.authority_version },
    );
  }
  const candidate = state.candidates.get(approval.candidate_id);
  if (!candidate) {
    throw new CollabError("APPROVAL_BINDING_STALE", "the bound candidate no longer exists", {
      approval_id: approval.approval_id,
    });
  }
  const mismatch = bindingMismatch(approval, candidate, issue.repository.base_sha);
  if (mismatch !== null) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the approval no longer binds the exact candidate revision",
      { approval_id: approval.approval_id, mismatch },
    );
  }
  const diffDigest = parseDigestRef(payload["diff_digest"], "diff_digest");
  if (
    diffDigest.algorithm !== approval.binding.diff_digest.algorithm ||
    diffDigest.value !== approval.binding.diff_digest.value
  ) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the approved diff digest does not match the bound candidate",
      { approval_id: approval.approval_id },
    );
  }
  const decision = str(payload["decision"], "decision");
  if (decision !== "approve" && decision !== "reject") {
    throw new CollabError("INVALID_INPUT", 'decision must be "approve" or "reject"', {
      field: "decision",
    });
  }
  const note = strOrNull(payload["note"], "note");
  if (note !== null && note.length > APPROVAL_NOTE_MAX) {
    throw new CollabError("INVALID_INPUT", `note exceeds ${APPROVAL_NOTE_MAX} characters`, {
      field: "note",
    });
  }
  const recorded: ApprovalDecision = {
    decision,
    decided_by: clone(actorUser),
    decided_at: at,
    note,
  };
  approval.decision = recorded;
  approval.decided_at = at;
  approval.state = decision === "approve" ? "approved" : "rejected";
  return clone(approval);
}

function handleInvalidateApproval(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "approval_id", "issue_id", "reason"],
    "invalidate_approval",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  const approval = approvalOf(state, payload["approval_id"], "approval_id");
  if (approval.issue_id !== issue.issue_id) {
    throw new CollabError("APPROVAL_NOT_FOUND", "approval is not addressed to this issue", {
      approval_id: approval.approval_id,
      issue_id: issue.issue_id,
    });
  }
  const reason = parseInvalidationReason(payload["reason"], "reason");
  const at = payload["at"] as string;
  if (approval.state === "invalidated" || approval.state === "cancelled") {
    return clone(approval);
  }
  if (!approvalIsActionable(approval, at) && approval.state !== "consumed") {
    return clone(approval);
  }
  approval.state = "invalidated";
  approval.invalidated_at = at;
  approval.invalidated_reason = reason;
  return clone(approval);
}

function handleRequestDelivery(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [
      ...BASE_KEYS,
      "delivery_id",
      "issue_id",
      "candidate_id",
      "approval_id",
      "target_branch",
      "provider",
      "branch",
      "grant_id",
      "requester_authorized",
    ],
    "request_delivery",
  );
  const issue = issueOf(state, payload["issue_id"], "issue_id");
  if (issue.product_state !== "awaiting_change_approval" && issue.product_state !== "delivering") {
    throw new CollabError(
      "APPROVAL_REQUIRED",
      `delivery requires an awaiting_change_approval or delivering issue (issue is ${issue.product_state})`,
      { issue_id: issue.issue_id, product_state: issue.product_state },
    );
  }
  if (!bool(payload["requester_authorized"], "requester_authorized")) {
    throw new CollabError("DELIVERY_FORBIDDEN", "the requester lacks delivery authority", {
      issue_id: issue.issue_id,
    });
  }
  const candidateId = str(payload["candidate_id"], "candidate_id");
  const candidate = state.candidates.get(candidateId);
  if (!candidate || candidate.issue_id !== issue.issue_id) {
    throw new CollabError("CANDIDATE_NOT_FOUND", "candidate is not frozen on this issue", {
      candidate_id: candidateId,
      issue_id: issue.issue_id,
    });
  }
  const approvalId = str(payload["approval_id"], "approval_id");
  const approval = state.approvals.get(approvalId);
  if (!approval || approval.issue_id !== issue.issue_id) {
    throw new CollabError("APPROVAL_NOT_FOUND", "unknown approval request", {
      approval_id: approvalId,
    });
  }
  if (approval.candidate_id !== candidate.candidate_id) {
    throw new CollabError("APPROVAL_BINDING_STALE", "the approval is bound to another candidate", {
      approval_id: approvalId,
      candidate_id: candidate.candidate_id,
    });
  }
  const at = payload["at"] as string;
  const effective = approvalStateAt(approval, at);
  if (effective === "consumed" || approval.consumed_by_delivery_id !== null) {
    throw new CollabError(
      "APPROVAL_CONSUMED",
      "the approval was consumed by its delivery operation; safe retries reconcile that same operation",
      { approval_id: approvalId },
    );
  }
  if (effective !== "approved") {
    throw new CollabError(
      "APPROVAL_NOT_APPROVED",
      `delivery requires a current approved request (approval is ${effective})`,
      { approval_id: approvalId, state: effective },
    );
  }
  const mismatch = bindingMismatch(approval, candidate, issue.repository.base_sha);
  if (mismatch !== null) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the approval no longer binds the exact candidate revision",
      { approval_id: approvalId, mismatch },
    );
  }
  const targetBranch = parseBranch(payload["target_branch"], "target_branch");
  if (
    targetBranch !== approval.binding.target_branch ||
    targetBranch !== issue.repository.base_ref
  ) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the intended target branch changed after approval",
      { target_branch: targetBranch, approved_target: approval.binding.target_branch },
    );
  }
  const provider = parseProvider(payload["provider"], "provider");
  if (!providerMatchesRepository(provider, issue.repository)) {
    throw new CollabError("DELIVERY_FORBIDDEN", `repository is not a ${provider} repository`, {
      provider,
      repository_id: issue.repository.repository_id,
    });
  }
  const branch = parseBranch(payload["branch"], "branch");
  const branchProblem = deliveryBranchProblem(issue.repository, issue.issue_id, branch);
  if (branchProblem !== null) {
    const protectedMain =
      branch === issue.repository.base_ref || branch === "main" || branch === "master";
    throw new CollabError(protectedMain ? "DELIVERY_FORBIDDEN" : "INVALID_INPUT", branchProblem, {
      branch,
      issue_id: issue.issue_id,
    });
  }
  const grantId = str(payload["grant_id"], "grant_id");
  let grant: CapabilityGrant | undefined;
  let grantRun: RunRecord | undefined;
  for (const run of state.runs.values()) {
    if (run.issue_id !== issue.issue_id) {
      continue;
    }
    const found = run.grants.find((entry) => entry.grant_id === grantId);
    if (found !== undefined) {
      grant = found;
      grantRun = run;
      break;
    }
  }
  if (grant === undefined || grantRun === undefined) {
    throw new CollabError("GRANT_NOT_FOUND", "delivery requires a recorded delivery grant", {
      grant_id: grantId,
    });
  }
  if (grantRun.role !== "delivery") {
    throw new CollabError(
      "DELIVERY_FORBIDDEN",
      "delivery writes require a delivery-role capability grant",
      { run_id: grantRun.run_id, role: grantRun.role },
    );
  }
  if (!grant.may_create_or_update_pr) {
    throw new CollabError("DELIVERY_FORBIDDEN", "the delivery grant does not permit push/PR", {
      grant_id: grant.grant_id,
    });
  }
  if (grantRun.head_sha !== candidate.head_sha) {
    throw new CollabError(
      "DELIVERY_FORBIDDEN",
      "the delivery grant is not bound to the approved candidate head",
      { run_head_sha: grantRun.head_sha, candidate_head_sha: candidate.head_sha },
    );
  }
  const grantState = grantStateAt(grant, at);
  if (grantState === "revoked") {
    throw new CollabError("GRANT_REVOKED", "revoked grants never authorize a write", {
      grant_id: grant.grant_id,
    });
  }
  if (grantState === "expired") {
    throw new CollabError("GRANT_EXPIRED", "an expired grant never authorizes a write", {
      grant_id: grant.grant_id,
    });
  }
  const deliveryId = str(payload["delivery_id"], "delivery_id");
  if (state.deliveries.has(deliveryId)) {
    throw new CollabError("DELIVERY_STATE_CONFLICT", "delivery id already exists", {
      delivery_id: deliveryId,
    });
  }
  const delivery: DeliveryRecord = {
    delivery_id: deliveryId,
    operation_id: str(payload["operation_id"], "operation_id"),
    issue_id: issue.issue_id,
    candidate_id: candidate.candidate_id,
    approval_id: approval.approval_id,
    repository: clone(issue.repository),
    target_branch: targetBranch,
    head_sha: candidate.head_sha,
    provider,
    state: "pending",
    branch: null,
    pr_id: null,
    pr_url: null,
    error_code: null,
    created_at: at,
    updated_at: at,
    reconciled_at: null,
    grant_id: grant.grant_id,
  };
  approval.state = "consumed";
  approval.consumed_by_delivery_id = delivery.delivery_id;
  state.deliveries.set(delivery.delivery_id, delivery);
  return clone(delivery);
}

function handleRecordDeliveryState(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "delivery_id", "to", "branch", "pr_id", "pr_url", "error_code", "authority"],
    "record_delivery_state",
  );
  const delivery = deliveryOf(state, payload["delivery_id"], "delivery_id");
  const authority = parseDeliveryAuthority(payload["authority"], "authority");
  if (!authority.audit_available) {
    throw new CollabError(
      "DELIVERY_AUDIT_UNAVAILABLE",
      "delivery requires an available audit sink before any provider write",
      { delivery_id: delivery.delivery_id },
    );
  }
  if (!authority.approver_authorized || !authority.delivery_authorized) {
    throw new CollabError(
      "DELIVERY_FORBIDDEN",
      "current approval or delivery authority no longer permits the write",
      { delivery_id: delivery.delivery_id },
    );
  }
  const to = parseDeliveryState(payload["to"], "to");
  if (!canTransitionDelivery(delivery.state, to)) {
    throw new CollabError(
      "DELIVERY_STATE_CONFLICT",
      `delivery cannot move ${delivery.state} -> ${to}`,
      { delivery_id: delivery.delivery_id, from: delivery.state, to },
    );
  }
  const issue = issueOf(state, delivery.issue_id, "issue_id");
  const candidate = state.candidates.get(delivery.candidate_id);
  if (!candidate || candidate.issue_id !== issue.issue_id) {
    throw new CollabError("APPROVAL_BINDING_STALE", "the delivered candidate no longer exists", {
      delivery_id: delivery.delivery_id,
    });
  }
  const approval = state.approvals.get(delivery.approval_id);
  if (!approval || approval.consumed_by_delivery_id !== delivery.delivery_id) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the delivery does not hold the consumed approval it was created with",
      { delivery_id: delivery.delivery_id },
    );
  }
  if (approval.state === "invalidated" || approval.state === "cancelled") {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the approval was invalidated before the provider write",
      { approval_id: approval.approval_id },
    );
  }
  const mismatch = bindingMismatch(approval, candidate, issue.repository.base_sha);
  if (mismatch !== null || delivery.head_sha !== candidate.head_sha) {
    throw new CollabError(
      "APPROVAL_BINDING_STALE",
      "the candidate or its base changed after approval",
      { delivery_id: delivery.delivery_id, mismatch: mismatch ?? "head_sha" },
    );
  }
  let grant: CapabilityGrant | undefined;
  for (const run of state.runs.values()) {
    if (run.issue_id !== delivery.issue_id) {
      continue;
    }
    grant = run.grants.find((entry) => entry.grant_id === delivery.grant_id);
    if (grant !== undefined) {
      break;
    }
  }
  if (grant === undefined) {
    throw new CollabError("GRANT_NOT_FOUND", "delivery grant is no longer recorded", {
      grant_id: delivery.grant_id,
    });
  }
  const at = payload["at"] as string;
  const grantState = grantStateAt(grant, at);
  if (grantState === "revoked") {
    throw new CollabError("GRANT_REVOKED", "revoked grants never authorize a write", {
      grant_id: grant.grant_id,
    });
  }
  if (grantState === "expired") {
    throw new CollabError("GRANT_EXPIRED", "an expired grant never authorizes a write", {
      grant_id: grant.grant_id,
    });
  }
  if (!grant.may_create_or_update_pr) {
    throw new CollabError("DELIVERY_FORBIDDEN", "the grant does not permit push/PR", {
      grant_id: grant.grant_id,
    });
  }
  const branch = strOrNull(payload["branch"], "branch");
  if (branch !== null) {
    const branchProblem = deliveryBranchProblem(issue.repository, issue.issue_id, branch);
    if (branchProblem !== null) {
      throw new CollabError("DELIVERY_FORBIDDEN", branchProblem, { branch });
    }
  }
  const prId = strOrNull(payload["pr_id"], "pr_id");
  const prUrl = strOrNull(payload["pr_url"], "pr_url");
  const errorCode = parseErrorCodeOrNull(payload["error_code"], "error_code");
  const effectiveBranch = branch ?? delivery.branch;
  if (to === "pushing" && effectiveBranch !== null) {
    throw new CollabError("INVALID_INPUT", "a pending push has no verified branch yet", {
      branch: effectiveBranch,
    });
  }
  if ((to === "opening_pr" || to === "partial" || to === "delivered") && effectiveBranch === null) {
    throw new CollabError("INVALID_INPUT", `delivery state ${to} requires a verified branch`, {
      to,
    });
  }
  if (to === "delivered" && (prId === null || prUrl === null)) {
    throw new CollabError("INVALID_INPUT", "delivered requires provider PR identity", {});
  }
  if ((to === "unknown" || to === "failed") && errorCode === null) {
    throw new CollabError("INVALID_INPUT", `delivery state ${to} requires a safe error code`, {
      to,
    });
  }
  if (to === "partial" && errorCode === null) {
    throw new CollabError("INVALID_INPUT", "partial delivery requires a safe error code", {});
  }
  delivery.state = to;
  if (branch !== null) {
    delivery.branch = branch;
  }
  if (prId !== null) {
    delivery.pr_id = prId;
  }
  if (prUrl !== null) {
    delivery.pr_url = prUrl;
  }
  if (errorCode !== null) {
    delivery.error_code = errorCode;
  }
  delivery.updated_at = at;
  return clone(delivery);
}

function handleReconcileDelivery(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "delivery_id", "to", "branch", "pr_id", "pr_url", "error_code", "evidence"],
    "reconcile_delivery",
  );
  const delivery = deliveryOf(state, payload["delivery_id"], "delivery_id");
  if (delivery.state !== "unknown" && delivery.state !== "partial") {
    throw new CollabError(
      "DELIVERY_STATE_CONFLICT",
      `delivery state ${delivery.state} has nothing to reconcile`,
      { delivery_id: delivery.delivery_id, state: delivery.state },
    );
  }
  const to = parseDeliveryState(payload["to"], "to");
  const allowed: DeliveryState[] = ["delivered", "partial", "failed", "unknown"];
  if (!allowed.includes(to)) {
    throw new CollabError(
      "DELIVERY_STATE_CONFLICT",
      `reconciliation cannot record ${to} from ${delivery.state}`,
      { delivery_id: delivery.delivery_id, from: delivery.state, to },
    );
  }
  const evidence = object(payload["evidence"], "evidence");
  assertExactKeys(evidence, ["branch_head_sha", "pr_head_sha", "pr_branch"], "evidence");
  const observedBranchHead = strOrNull(evidence["branch_head_sha"], "evidence.branch_head_sha");
  const observedPrHead = strOrNull(evidence["pr_head_sha"], "evidence.pr_head_sha");
  const observedPrBranch = strOrNull(evidence["pr_branch"], "evidence.pr_branch");
  const branch = strOrNull(payload["branch"], "branch");
  const prId = strOrNull(payload["pr_id"], "pr_id");
  const prUrl = strOrNull(payload["pr_url"], "pr_url");
  const errorCode = parseErrorCodeOrNull(payload["error_code"], "error_code");
  const issue = issueOf(state, delivery.issue_id, "issue_id");
  const effectiveBranch = branch ?? delivery.branch;
  if (to === "delivered") {
    if (effectiveBranch === null || prId === null || prUrl === null) {
      throw new CollabError("INVALID_INPUT", "delivered requires branch and PR identity", {});
    }
    if (observedPrHead !== delivery.head_sha || observedPrBranch !== effectiveBranch) {
      throw new CollabError(
        "DELIVERY_STATE_CONFLICT",
        "provider PR evidence is not bound to the approved head and branch",
        { delivery_id: delivery.delivery_id },
      );
    }
    if (observedBranchHead !== delivery.head_sha) {
      throw new CollabError(
        "DELIVERY_STATE_CONFLICT",
        "delivered requires the provider branch to hold the approved commit",
        { delivery_id: delivery.delivery_id },
      );
    }
  }
  if (to === "partial") {
    if (effectiveBranch === null || errorCode === null) {
      throw new CollabError("INVALID_INPUT", "partial requires a branch and error code", {});
    }
    if (observedBranchHead !== delivery.head_sha) {
      throw new CollabError(
        "DELIVERY_STATE_CONFLICT",
        "partial requires the branch to hold the approved commit",
        { delivery_id: delivery.delivery_id },
      );
    }
  }
  if (to === "failed") {
    if (errorCode === null) {
      throw new CollabError("INVALID_INPUT", "failed requires a safe error code", {});
    }
    if (observedBranchHead !== null || observedPrHead !== null || prId !== null) {
      throw new CollabError(
        "DELIVERY_STATE_CONFLICT",
        "failed requires evidence that no provider side effect exists",
        { delivery_id: delivery.delivery_id },
      );
    }
  }
  if (to === "unknown") {
    if (errorCode === null) {
      throw new CollabError(
        "INVALID_INPUT",
        "an unresolved outcome requires a safe error code",
        {},
      );
    }
  }
  if (branch !== null) {
    const branchProblem = deliveryBranchProblem(issue.repository, issue.issue_id, branch);
    if (branchProblem !== null) {
      throw new CollabError("DELIVERY_FORBIDDEN", branchProblem, { branch });
    }
    delivery.branch = branch;
  }
  if (prId !== null) {
    delivery.pr_id = prId;
  }
  if (prUrl !== null) {
    delivery.pr_url = prUrl;
  }
  if (errorCode !== null) {
    delivery.error_code = errorCode;
  }
  delivery.state = to;
  delivery.reconciled_at = payload["at"] as string;
  delivery.updated_at = payload["at"] as string;
  return clone(delivery);
}

export const HANDLERS: Record<AuditCommand, (state: CollabState, payload: Payload) => unknown> = {
  create_issue: handleCreateIssue,
  add_task: handleAddTask,
  set_task_state: handleSetTaskState,
  open_run: handleOpenRun,
  acquire_lease: handleAcquireLease,
  renew_lease: handleRenewLease,
  release_lease: handleReleaseLease,
  record_grant: handleRecordGrant,
  revoke_grant: handleRevokeGrant,
  record_run_state: handleRecordRunState,
  attach_artifact: handleAttachArtifact,
  register_test_policy: handleRegisterTestPolicy,
  record_test_plan: handleRecordTestPlan,
  freeze_candidate: handleFreezeCandidate,
  invalidate_candidate: handleInvalidateCandidate,
  record_base_advance: handleRecordBaseAdvance,
  request_approval: handleRequestApproval,
  decide_approval: handleDecideApproval,
  invalidate_approval: handleInvalidateApproval,
  request_delivery: handleRequestDelivery,
  record_delivery_state: handleRecordDeliveryState,
  reconcile_delivery: handleReconcileDelivery,
  transition_issue: handleTransitionIssue,
  record_handoff: handleRecordHandoff,
  request_run_restart: handleRequestRunRestart,
};
