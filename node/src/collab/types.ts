import type { DshState } from "../dsh/types.js";
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
    handoffs: [],
    dedupe: new Map(),
    attempts: new Map(),
    results: new Map(),
  };
}
