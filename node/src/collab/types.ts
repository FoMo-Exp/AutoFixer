import type { DshState } from "../dsh/types.js";
import type { ApprovalInvalidationReason } from "./contract.js";
import type { ProductState } from "./states.js";

/**
 * Domain records for the durable collaboration state machine (DAT-215,
 * ADR-0007 "Durable issue orchestration, bounded execution").
 *
 * These records are the service-owned collaboration state. They never grant
 * authority: dsh remains the execution gate and re-checks every operation
 * against the run's capability grant. Workspace scope follows ADR-0006 — an
 * issue and everything derived from it belongs to exactly one
 * enterprise/workspace pair, resolved from authenticated membership by the
 * layer above this one.
 */

export interface WorkspaceScope {
  enterprise_id: string;
  workspace_id: string;
}

/** Pi configurations a task or run may be routed under (ADR-0007 roles). */
export const ROLES = [
  "analysis",
  "planning",
  "implementation",
  "verification",
  "delivery",
] as const;

export type Role = (typeof ROLES)[number];

/** Immutable repository identity (ADR-0006 binds an ID, not a mutable URL). */
export interface RepositoryRef {
  repository_id: string;
  url: string;
  base_ref: string;
  base_sha: string;
}

/**
 * One run's isolated checkout. Different runs use separate worktrees; the
 * machine refuses to bind one worktree identity to two concurrent runs.
 */
export interface WorktreeRef {
  worktree_id: string;
  path: string;
}

/** Tool, path, and network scope recorded for one bounded run. */
export interface RunScope {
  tools: string[];
  paths: string[];
  network: string[];
}

/** Duration, resource, and token limits recorded for one bounded run. */
export interface RunLimits {
  max_wall_clock_seconds: number;
  max_memory_mb: number;
  max_tokens: number;
}

/**
 * Lease with fencing token. Only the current holder of the current fencing
 * token may mutate the run; a token is never reused, so a worker that lost its
 * lease (expiry, crash, restart) can never overwrite a newer writer.
 */
export interface LeaseRecord {
  holder: string;
  fencing_token: number;
  acquired_at: string;
  expires_at: string;
}

export interface GrantTool {
  identity: string;
  allowed_arguments: string[];
}

/**
 * Capability grant as recorded for one run (fields follow
 * task-evidence-contract-v1 §2). The recorded grant mirrors what dsh issued;
 * `revoked_at` is set by this layer whenever the run stops, reaches a terminal
 * state, or its issue enters `needs_human`/`cancelled`.
 */
export interface CapabilityGrant {
  grant_id: string;
  run_id: string;
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
  revoked_at: string | null;
  revoked_reason: string | null;
}

export const GRANT_STATES = ["active", "expired", "revoked"] as const;

export type GrantState = (typeof GRANT_STATES)[number];

/**
 * Effective grant state at a point in time.
 *
 * Revocation is recorded and permanent; expiry is derived from the clock, so a
 * grant whose window passed while the process was down comes back `expired`,
 * never `active`.
 */
export function grantStateAt(grant: CapabilityGrant, at: string): GrantState {
  if (grant.revoked_at !== null) {
    return "revoked";
  }
  return grant.expires_at <= at ? "expired" : "active";
}

/**
 * Immutable artifact reference (ADR-0007: handoffs carry artifact references
 * and head identity, never raw memory). The digest binds the reference to
 * exactly one artifact content; `base_sha`/`head_sha` bind it to the revision
 * it was produced from.
 */
export interface ArtifactRef {
  artifact_id: string;
  kind: string;
  digest_algorithm: string;
  digest: string;
  base_sha: string;
  head_sha: string | null;
}

/** Child-task lifecycle (ADR-0007: durable issues and child tasks). */
export const TASK_STATES = ["open", "active", "done", "cancelled"] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Child task of an issue (ADR-0007: durable issues and child tasks). */
export interface TaskRecord {
  task_id: string;
  issue_id: string;
  role: Role;
  assignee_agent_id: string | null;
  depends_on: string[];
  state: TaskState;
  created_at: string;
  updated_at: string;
}

/**
 * One bounded remediation run: repository/base revision, isolated worktree,
 * tool/path/network scope, duration/resource/token limits, capability grants,
 * lease, and observed harness state. The harness state mirrors dsh (FP-01) and
 * is never invented here.
 */
export interface RunRecord {
  run_id: string;
  issue_id: string;
  task_id: string | null;
  role: Role;
  workspace: WorkspaceScope;
  repository: RepositoryRef;
  worktree: WorktreeRef;
  scope: RunScope;
  limits: RunLimits;
  state: DshState;
  /** Candidate head identity produced so far; null until one exists. */
  head_sha: string | null;
  stop_reason: string | null;
  stopped_at: string | null;
  /**
   * Monotonic fencing-token counter. A token is issued from it on every lease
   * acquisition and is never reused, so a worker that lost its lease can never
   * pass the fencing check of a later lease.
   */
  fencing_counter: number;
  lease: LeaseRecord | null;
  grants: CapabilityGrant[];
  artifact_refs: ArtifactRef[];
  opened_at: string;
  updated_at: string;
}

/** Product issue aggregate; its state is the product lifecycle, not a harness state. */
export interface IssueRecord {
  issue_id: string;
  workspace: WorkspaceScope;
  repository: RepositoryRef;
  dedupe_key: string;
  summary: string;
  source_reference: string | null;
  product_state: ProductState;
  state_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Handoff between runs: a bounded summary plus immutable artifact references
 * and head identity. There is intentionally no field for raw memory, session
 * transcripts, or chat history; unknown input fields are rejected.
 */
export interface HandoffRecord {
  handoff_id: string;
  issue_id: string;
  from_run_id: string;
  to_run_id: string | null;
  summary: string;
  artifact_refs: ArtifactRef[];
  head_identity: { base_sha: string; head_sha: string | null };
  created_at: string;
}

/**
 * Digest and shape of the exact diff a pre-PR approver reviews (ADR-0007).
 * `digest` is the sha256 of the retained diff content, so an independent
 * reader can recompute it from the retained artifact rather than trusting the
 * record.
 */
export interface CandidateDiff {
  digest_algorithm: string;
  digest: string;
  changed_paths: string[];
  insertions: number;
  deletions: number;
}

/** One validation attempt against the exact candidate revision. */
export interface CandidateValidationResult {
  tool: string;
  exit_status: number | null;
  output_digest: { algorithm: string; value: string } | null;
  event_reference: string;
}

/**
 * A versioned, workspace + repository scoped test policy (DAT-219, ADR-0007).
 *
 * Required checks are policy, not execution output: they are registered by a
 * configuration administrator (recorded as `registered_by`) and a worker lease
 * can never define or edit them. Each repository has exactly one current
 * version; registering a new version moves that pointer and older versions stay
 * for audit and replay, so a caller cannot shop for a friendlier policy.
 */
export interface TestPolicyRecord {
  policy_id: string;
  workspace: WorkspaceScope;
  repository_id: string;
  repository_url: string;
  policy_version: string;
  checks: string[];
  config_digest: string;
  environment: string;
  /** Digest over the exact policy content this version froze. */
  policy_digest: string;
  registered_by: string;
  registered_at: string;
}

/** Scope key of one repository's current-policy pointer. */
export function testPolicyScopeKey(workspace: WorkspaceScope, repositoryId: string): string {
  return `${workspace.enterprise_id}\u0000${workspace.workspace_id}\u0000${repositoryId}`;
}

/**
 * The plan of one run: a binding to one registered test-policy version,
 * recorded before validation executes (ADR-0007 "validating": approved test
 * plan against the exact revision).
 *
 * The plan carries no caller-supplied checks or configuration — it freezes the
 * referenced policy version's values, so a candidate can only show that
 * policy's checks passing. `policy_version`, `policy_digest`, the checks,
 * config digest, and environment are copied at binding time and never edited.
 */
export interface TestPlanRecord {
  plan_id: string;
  run_id: string;
  policy_id: string;
  policy_version: string;
  policy_digest: string;
  checks: string[];
  config_digest: string;
  environment: string;
  recorded_at: string;
}

/**
 * The test evidence an approval is bound to. `required_checks` must equal the
 * run's recorded test plan checks, and every check needs a passing attempt
 * backed by a retained execution artifact.
 */
export interface CandidateValidation {
  config_digest: string;
  environment: string;
  required_checks: string[];
  results: CandidateValidationResult[];
}

/** Risk classes of the pre-approval assessment (FP-01). */
export const RISK_CLASSES = ["low", "elevated", "prohibited"] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

/** The test-policy identity a frozen candidate's evidence is bound to. */
export interface CandidateTestPolicy {
  policy_id: string;
  policy_version: string;
  policy_digest: string;
}

/** The pre-approval risk decision for the candidate's work. */
export interface ChangeRisk {
  class: RiskClass;
  decision_code: string;
  requires_human_approval: boolean;
}

/**
 * An immutable frozen candidate (DAT-219, ADR-0007).
 *
 * A candidate is produced by the service when local preparation stops: the
 * preparation run's grant is revoked while the candidate is preserved outside
 * the ephemeral worktree, so it stays reviewable and deliverable after cleanup.
 * Nothing is added or edited after validation; the diff content is retained by
 * digest in the candidate content store, and `diff.digest` is the sha256 over
 * that retained content.
 *
 * Invalidation is the only later recorded fact: base advancement, test-evidence
 * change, or a policy/authority change marks the candidate permanently invalid,
 * and an approval bound to it can never be reused for another revision.
 */
export interface CandidateRecord {
  candidate_id: string;
  issue_id: string;
  /** The stopped preparation run that produced the candidate. */
  run_id: string;
  workspace: WorkspaceScope;
  repository: RepositoryRef;
  base_sha: string;
  head_sha: string;
  tree_sha: string;
  diff: CandidateDiff;
  summary: string;
  validation: CandidateValidation;
  /** The registered test-policy version this candidate's evidence is bound to. */
  test_policy: CandidateTestPolicy;
  risk: ChangeRisk;
  /** Patch, report, and evidence-bundle references retained after cleanup. */
  artifacts: ArtifactRef[];
  /** References into the append-only audit/evidence records. */
  audit_refs: string[];
  created_at: string;
  invalidated_at: string | null;
  invalidated_reason: ApprovalInvalidationReason | null;
}

/** Human disposition reference for the stopped -> approved (new grant) path. */
export interface Disposition {
  actor: string;
  reference: string;
}

/** Everything the machine owns durably. Rebuilt only from the audit log. */
export interface CollabState {
  issues: Map<string, IssueRecord>;
  tasks: Map<string, TaskRecord>;
  runs: Map<string, RunRecord>;
  testPolicies: Map<string, TestPolicyRecord>;
  /** scope key -> current policy id; old versions stay in `testPolicies`. */
  currentTestPolicies: Map<string, string>;
  testPlans: Map<string, TestPlanRecord>;
  candidates: Map<string, CandidateRecord>;
  handoffs: HandoffRecord[];
  /** Signal fingerprint -> issue id; replays reuse the issue instead of a new one. */
  dedupe: Map<string, string>;
  /** operation id -> payload fingerprint; binds one id to exactly one payload. */
  attempts: Map<string, string>;
  /** operation id -> recorded result of the applied attempt. */
  results: Map<string, unknown>;
}

export function emptyCollabState(): CollabState {
  return {
    issues: new Map(),
    tasks: new Map(),
    runs: new Map(),
    testPolicies: new Map(),
    currentTestPolicies: new Map(),
    testPlans: new Map(),
    candidates: new Map(),
    handoffs: [],
    dedupe: new Map(),
    attempts: new Map(),
    results: new Map(),
  };
}
