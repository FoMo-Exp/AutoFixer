import type { AuditCommand } from "./audit.js";
import { canonicalJson } from "./audit.js";
import { APPROVAL_INVALIDATION_REASONS } from "./contract.js";
import type { ApprovalInvalidationReason } from "./contract.js";
import { CollabError } from "./errors.js";
import { resolveRevisionEvidence, resolveValidationEvidence } from "./evidence.js";
import type {
  ArtifactRef,
  CandidateDiff,
  CandidateRecord,
  CandidateValidation,
  CandidateValidationResult,
  CapabilityGrant,
  ChangeRisk,
  CollabState,
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
  WorkspaceScope,
  WorktreeRef,
} from "./types.js";
import { RISK_CLASSES, grantStateAt } from "./types.js";
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

function handleRecordTestPlan(state: CollabState, payload: Payload): unknown {
  assertExactKeys(
    payload,
    [...BASE_KEYS, "plan_id", "run_id", "lease", "config_digest", "environment", "checks"],
    "record_test_plan",
  );
  const run = runOf(state, payload["run_id"], "run_id");
  const at = payload["at"] as string;
  assertLeaseHeld(run, payload["lease"], at);
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
  for (const existing of state.testPlans.values()) {
    if (existing.run_id === run.run_id) {
      throw new CollabError(
        "TEST_PLAN_CONFLICT",
        "the run already has an approved test plan; a new plan needs a new run",
        { run_id: run.run_id, plan_id: existing.plan_id },
      );
    }
  }
  const checks = uniqueStrings(strArray(payload["checks"], "checks"), "checks");
  if (checks.length === 0) {
    throw new CollabError("CANDIDATE_INVALID", "the approved test plan requires no check", {
      field: "checks",
    });
  }
  const plan: TestPlanRecord = {
    plan_id: str(payload["plan_id"], "plan_id"),
    run_id: run.run_id,
    config_digest: str(payload["config_digest"], "config_digest"),
    environment: str(payload["environment"], "environment"),
    checks,
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
  return { issue: clone(issue), invalidated_candidate_ids: invalidatedCandidateIds };
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
  record_test_plan: handleRecordTestPlan,
  freeze_candidate: handleFreezeCandidate,
  invalidate_candidate: handleInvalidateCandidate,
  record_base_advance: handleRecordBaseAdvance,
  transition_issue: handleTransitionIssue,
  record_handoff: handleRecordHandoff,
  request_run_restart: handleRequestRunRestart,
};
