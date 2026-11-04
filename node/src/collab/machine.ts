import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AuditCommand, AuditRecord } from "./audit.js";
import { auditChainProblem, auditDigest, digestOf } from "./audit.js";
import type { CandidateFreshness } from "./candidate.js";
import { candidateFreshness as freshnessOf } from "./candidate.js";
import { diffDigest } from "./candidate-store.js";
import type { CandidateContentStore } from "./candidate-store.js";
import type { ApprovalInvalidationReason } from "./contract.js";
import { CollabError } from "./errors.js";
import { HANDLERS } from "./handlers.js";
import {
  newArtifactId,
  newCandidateId,
  newGrantId,
  newHandoffId,
  newIssueId,
  newRunId,
  newTaskId,
} from "./ids.js";
import type {
  ArtifactRef,
  CandidateDiff,
  CandidateRecord,
  CandidateValidation,
  CapabilityGrant,
  ChangeRisk,
  CollabState,
  Disposition,
  GrantTool,
  HandoffRecord,
  IssueRecord,
  LeaseRecord,
  RepositoryRef,
  Role,
  RunLimits,
  RunRecord,
  RunScope,
  TaskRecord,
  TaskState,
  WorkspaceScope,
  WorktreeRef,
} from "./types.js";
import { emptyCollabState, grantStateAt } from "./types.js";
import type { DshState } from "../dsh/types.js";
import type { ProductState } from "./states.js";

/**
 * Durable collaboration state machine (DAT-215).
 *
 * Delivery guarantees, in one place:
 *
 * - **At-least-once safe**: every command carries an `operation_id`; a
 *   redelivered operation with the same payload returns the recorded result
 *   and appends nothing. The same id with a different payload is an
 *   `OPERATION_CONFLICT`. A denied attempt is retriable with the same
 *   operation id (its payload stays bound), so an out-of-order delivery that
 *   arrived too early can still apply once its precondition lands.
 * - **Replay-safe**: one append-only audit record per first attempt, with a
 *   digest chain. Replaying the log through the same handlers reproduces the
 *   exact state — same identifiers, same timestamps, same denials.
 * - **Restart-safe**: the persisted form is the audit log itself; a restart
 *   rebuilds only that persisted state. Grants are never re-activated:
 *   revocation is recorded, expiry is derived from the clock, and a stopped or
 *   terminal run cannot be restarted by a queue retry or a model message.
 * - **Lease/fencing**: run mutations need the current lease holder's current
 *   fencing token; tokens are monotonic across renewals and restarts, so a
 *   crashed or replaced worker can never overwrite a newer writer.
 *
 * This layer grants no authority. dsh remains the execution gate and
 * re-checks every operation against the run's capability grant.
 */

type Payload = Record<string, unknown>;

const SCHEMA_VERSION = 1;

export type CommandBase = {
  operation_id: string;
  actor: string;
};

export type CreateIssueInput = CommandBase & {
  workspace: WorkspaceScope;
  repository: RepositoryRef;
  dedupe_key: string;
  summary: string;
  source_reference?: string | null;
};

export type AddTaskInput = CommandBase & {
  issue_id: string;
  role: Role;
  assignee_agent_id?: string | null;
  depends_on?: string[];
};

export type SetTaskStateInput = CommandBase & {
  task_id: string;
  to: TaskState;
};

export type OpenRunInput = CommandBase & {
  issue_id: string;
  task_id?: string | null;
  role: Role;
  repository: RepositoryRef;
  worktree: WorktreeRef;
  scope: RunScope;
  limits: RunLimits;
};

export type LeaseInput = CommandBase & {
  run_id: string;
  holder: string;
  fencing_token: number;
};

export type AcquireLeaseInput = CommandBase & {
  run_id: string;
  holder: string;
  ttl_seconds: number;
};

export type RenewLeaseInput = AcquireLeaseInput & { fencing_token: number };

export type GrantInput = {
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
};

export type RecordGrantInput = CommandBase & {
  run_id: string;
  lease: { holder: string; fencing_token: number };
  grant: GrantInput;
};

export type RevokeGrantInput = CommandBase & {
  run_id: string;
  grant_id: string;
  reason: string;
};

export type RecordRunStateInput = CommandBase & {
  run_id: string;
  lease: { holder: string; fencing_token: number };
  to: DshState;
  stop_reason?: string;
  new_grant_id?: string;
  disposition?: Disposition;
  head_sha?: string | null;
};

export type ArtifactInput = Omit<ArtifactRef, "artifact_id">;

export type AttachArtifactInput = CommandBase & {
  run_id: string;
  lease: { holder: string; fencing_token: number };
  artifact: ArtifactInput;
};

export type TransitionIssueInput = CommandBase & {
  issue_id: string;
  to: ProductState;
  reason?: string | null;
};

export type RecordHandoffInput = CommandBase & {
  issue_id: string;
  from_run_id: string;
  to_run_id?: string | null;
  summary: string;
  /** References into the source run's append-only artifact records. */
  artifact_refs: ArtifactRef[];
  head_identity: { base_sha: string; head_sha: string | null };
  lease: { holder: string; fencing_token: number };
};

export type RequestRunRestartInput = CommandBase & {
  run_id: string;
  trigger: "queue_retry" | "model_message";
};

/**
 * Freeze one immutable candidate (DAT-219, ADR-0007).
 *
 * `diff_content` is the exact reviewable diff. The machine verifies it against
 * `diff.digest`, retains it in the candidate content store (outside the
 * ephemeral worktree), and records only the digest in the audited payload — the
 * append-only log never carries patch text or tool output.
 */
export type FreezeCandidateInput = CommandBase & {
  issue_id: string;
  run_id: string;
  summary: string;
  base_sha: string;
  head_sha: string;
  tree_sha: string;
  diff: CandidateDiff;
  diff_content: string;
  validation: CandidateValidation;
  risk: ChangeRisk;
  artifact_ids: string[];
  audit_refs: string[];
};

export type InvalidateCandidateInput = CommandBase & {
  candidate_id: string;
  reason: ApprovalInvalidationReason;
};

export type RecordBaseAdvanceInput = CommandBase & {
  issue_id: string;
  base_sha: string;
  base_ref?: string | null;
};

export interface BaseAdvanceResult {
  issue: IssueRecord;
  invalidated_candidate_ids: string[];
}

export interface CollabMachineOptions {
  /** Durable audit log location. Omit for a process-local machine in tests. */
  persistencePath?: string;
  /**
   * Retention boundary for frozen candidate content. Required by
   * `freezeCandidate`; a candidate cannot exist without its verifiable diff.
   */
  candidateStore?: CandidateContentStore;
  /** Clock seam; captured per command as the audited effective time. */
  now?: () => Date;
}

interface PersistedState {
  schema_version: number;
  audit: AuditRecord[];
}

export class CollabMachine {
  private readonly state: CollabState = emptyCollabState();
  private readonly audit: AuditRecord[] = [];
  private readonly persistencePath: string | undefined;
  private readonly candidateStore: CandidateContentStore | undefined;
  private readonly clock: () => Date;

  constructor(options: CollabMachineOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.candidateStore = options.candidateStore;
    this.clock = options.now ?? (() => new Date());
    if (this.persistencePath !== undefined && fs.existsSync(this.persistencePath)) {
      const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as unknown;
      this.restore(readPersistedState(raw).audit);
    }
  }

  /** Rebuild a machine from an audit log; used for recovery and reproducibility proofs. */
  static fromAudit(
    records: readonly AuditRecord[],
    options: CollabMachineOptions = {},
  ): CollabMachine {
    const machine = new CollabMachine(options);
    machine.restore(records);
    return machine;
  }

  // ---------------------------------------------------------------- commands

  createIssue(input: CreateIssueInput): IssueRecord {
    const payload: Payload = {
      ...input,
      source_reference: input.source_reference ?? null,
      at: this.clock().toISOString(),
      issue_id: newIssueId(),
    };
    return this.execute("create_issue", input, payload) as IssueRecord;
  }

  addTask(input: AddTaskInput): TaskRecord {
    const payload: Payload = {
      ...input,
      assignee_agent_id: input.assignee_agent_id ?? null,
      depends_on: input.depends_on ?? [],
      at: this.clock().toISOString(),
      task_id: newTaskId(),
    };
    return this.execute("add_task", input, payload) as TaskRecord;
  }

  setTaskState(input: SetTaskStateInput): TaskRecord {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("set_task_state", input, payload) as TaskRecord;
  }

  openRun(input: OpenRunInput): RunRecord {
    const payload: Payload = {
      ...input,
      task_id: input.task_id ?? null,
      at: this.clock().toISOString(),
      run_id: newRunId(),
    };
    return this.execute("open_run", input, payload) as RunRecord;
  }

  acquireLease(input: AcquireLeaseInput): LeaseRecord {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("acquire_lease", input, payload) as LeaseRecord;
  }

  renewLease(input: RenewLeaseInput): LeaseRecord {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("renew_lease", input, payload) as LeaseRecord;
  }

  releaseLease(input: LeaseInput): LeaseRecord {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("release_lease", input, payload) as LeaseRecord;
  }

  recordGrant(input: RecordGrantInput): CapabilityGrant {
    const payload: Payload = {
      ...input,
      grant: { ...input.grant, grant_id: newGrantId() },
      at: this.clock().toISOString(),
    };
    return this.execute("record_grant", input, payload) as CapabilityGrant;
  }

  revokeGrant(input: RevokeGrantInput): CapabilityGrant {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("revoke_grant", input, payload) as CapabilityGrant;
  }

  recordRunState(input: RecordRunStateInput): RunRecord {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("record_run_state", input, payload) as RunRecord;
  }

  attachArtifact(input: AttachArtifactInput): ArtifactRef {
    const payload: Payload = {
      ...input,
      artifact: { ...input.artifact, artifact_id: newArtifactId() },
      at: this.clock().toISOString(),
    };
    return this.execute("attach_artifact", input, payload) as ArtifactRef;
  }

  /**
   * Freeze one immutable candidate from a stopped preparation run.
   *
   * The declared digest is recomputed from the exact content and the content is
   * retained before the record is written, so a recorded candidate always has a
   * verifiable diff. Freezing performs no provider write: no branch, no push, no
   * PR — delivery is a separate, approval-bound operation.
   */
  freezeCandidate(input: FreezeCandidateInput): CandidateRecord {
    if (this.candidateStore === undefined) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "a candidate content store is required to retain the frozen diff",
        {},
      );
    }
    const computed = diffDigest(input.diff_content);
    if (computed !== input.diff.digest) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "diff content does not match the declared diff digest",
        { declared: input.diff.digest, computed },
      );
    }
    const run = this.state.runs.get(input.run_id);
    if (run !== undefined) {
      this.candidateStore.assertOutsideWorktree(run.worktree.path);
    }
    this.candidateStore.put(input.diff_content);
    const { diff_content: _diffContent, ...rest } = input;
    const payload: Payload = {
      ...rest,
      at: this.clock().toISOString(),
      candidate_id: newCandidateId(),
    };
    return this.execute("freeze_candidate", input, payload) as CandidateRecord;
  }

  /** Permanently mark a candidate invalid; a later revision is a new candidate. */
  invalidateCandidate(input: InvalidateCandidateInput): CandidateRecord {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    return this.execute("invalidate_candidate", input, payload) as CandidateRecord;
  }

  /**
   * Record that the issue's base revision advanced. Every candidate frozen
   * against an older base becomes permanently invalid, so a previously granted
   * approval can never be used to deliver a rewritten tree.
   */
  recordBaseAdvance(input: RecordBaseAdvanceInput): BaseAdvanceResult {
    const payload: Payload = {
      ...input,
      base_ref: input.base_ref ?? null,
      at: this.clock().toISOString(),
    };
    return this.execute("record_base_advance", input, payload) as BaseAdvanceResult;
  }

  transitionIssue(input: TransitionIssueInput): IssueRecord {
    const payload: Payload = {
      ...input,
      reason: input.reason ?? null,
      at: this.clock().toISOString(),
    };
    return this.execute("transition_issue", input, payload) as IssueRecord;
  }

  recordHandoff(input: RecordHandoffInput): HandoffRecord {
    const payload: Payload = {
      ...input,
      to_run_id: input.to_run_id ?? null,
      at: this.clock().toISOString(),
      handoff_id: newHandoffId(),
    };
    return this.execute("record_handoff", input, payload) as HandoffRecord;
  }

  /**
   * Queue retries and model follow-up messages never restart a stopped or
   * terminal run. The request is always denied and recorded; continuation
   * needs human disposition plus a fresh run or grant.
   */
  requestRunRestart(input: RequestRunRestartInput): never {
    const payload: Payload = { ...input, at: this.clock().toISOString() };
    this.execute("request_run_restart", input, payload);
    throw new CollabError("RUN_RESTART_FORBIDDEN", "run restart is never granted", {});
  }

  // ------------------------------------------------------------------ reads

  getIssue(issueId: string): IssueRecord | undefined {
    const issue = this.state.issues.get(issueId);
    return issue ? structuredClone(issue) : undefined;
  }

  getTask(taskId: string): TaskRecord | undefined {
    const task = this.state.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  getRun(runId: string): RunRecord | undefined {
    const run = this.state.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  getCandidate(candidateId: string): CandidateRecord | undefined {
    const candidate = this.state.candidates.get(candidateId);
    return candidate ? structuredClone(candidate) : undefined;
  }

  /**
   * Frozen candidates in freeze order (oldest first). Ties on `created_at`
   * break on candidate id so pagination is stable across reads.
   */
  listCandidates(issueId: string): CandidateRecord[] {
    return [...this.state.candidates.values()]
      .filter((candidate) => candidate.issue_id === issueId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.candidate_id.localeCompare(b.candidate_id),
      )
      .map((candidate) => structuredClone(candidate));
  }

  /**
   * Whether one candidate may still authorize delivery. `observedBaseSha` is
   * the repository base the caller just observed; when it differs from the
   * frozen base the candidate is stale even if no base advance was recorded
   * locally.
   */
  candidateFreshness(candidateId: string, observedBaseSha?: string): CandidateFreshness {
    const candidate = this.state.candidates.get(candidateId);
    if (!candidate) {
      throw new CollabError("CANDIDATE_NOT_FOUND", "unknown candidate", {
        candidate_id: candidateId,
      });
    }
    return freshnessOf(candidate, observedBaseSha);
  }

  listIssues(): IssueRecord[] {
    return [...this.state.issues.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((issue) => structuredClone(issue));
  }

  listRuns(issueId: string): RunRecord[] {
    return [...this.state.runs.values()]
      .filter((run) => run.issue_id === issueId)
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at))
      .map((run) => structuredClone(run));
  }

  listTasks(issueId: string): TaskRecord[] {
    return [...this.state.tasks.values()]
      .filter((task) => task.issue_id === issueId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((task) => structuredClone(task));
  }

  listHandoffs(issueId: string): HandoffRecord[] {
    return this.state.handoffs
      .filter((handoff) => handoff.issue_id === issueId)
      .map((handoff) => structuredClone(handoff));
  }

  /**
   * Effective grant states for one run at a point in time (default: now).
   * Revoked and expired grants stay that way forever; only the clock moves an
   * unrevoked grant from active to expired.
   */
  grantStates(
    runId: string,
    at?: string,
  ): { grant_id: string; state: "active" | "expired" | "revoked" }[] {
    const run = this.state.runs.get(runId);
    if (!run) {
      throw new CollabError("RUN_NOT_FOUND", "unknown run", { run_id: runId });
    }
    const point = at ?? this.clock().toISOString();
    return run.grants.map((grant) => ({
      grant_id: grant.grant_id,
      state: grantStateAt(grant, point),
    }));
  }

  auditLog(): AuditRecord[] {
    return structuredClone(this.audit);
  }

  /**
   * Digest over the whole machine state. Equal digests on two machines mean
   * the audit log reproduced the same issues, runs, grants, leases, handoffs,
   * and operation bookkeeping.
   */
  snapshotDigest(): string {
    return digestOf({
      issues: [...this.state.issues.values()].sort((a, b) => a.issue_id.localeCompare(b.issue_id)),
      tasks: [...this.state.tasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
      runs: [...this.state.runs.values()].sort((a, b) => a.run_id.localeCompare(b.run_id)),
      candidates: [...this.state.candidates.values()].sort((a, b) =>
        a.candidate_id.localeCompare(b.candidate_id),
      ),
      handoffs: this.state.handoffs,
      dedupe: [...this.state.dedupe.entries()].sort(),
      attempts: [...this.state.attempts.entries()].sort(),
      results: [...this.state.results.entries()].sort(),
      audit_head:
        this.audit.length > 0 ? (this.audit[this.audit.length - 1]?.digest ?? null) : null,
    });
  }

  // ------------------------------------------------------------ durability

  /** Atomically persist the audit log if a path is configured. */
  flushSync(): void {
    if (this.persistencePath === undefined) {
      return;
    }
    const state: PersistedState = { schema_version: SCHEMA_VERSION, audit: [...this.audit] };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }

  // --------------------------------------------------------------- internals

  /**
   * Apply one command exactly once per first attempt.
   *
   * A redelivered `operation_id` with the same payload returns the recorded
   * result (or re-raises the recorded denial without a new record when the
   * attempt was denied and retried). A different payload under a known id is a
   * protocol violation and changes nothing at all — not even the audit log.
   */
  private execute(command: AuditCommand, input: Payload, payload: Payload): unknown {
    const operationId = requireOperationId(input);
    const inputDigest = digestOf(input);
    const known = this.state.attempts.get(operationId);
    if (known !== undefined && known !== inputDigest) {
      throw new CollabError(
        "OPERATION_CONFLICT",
        "operation id was used with a different payload",
        {
          operation_id: operationId,
        },
      );
    }
    const memo = this.state.results.get(operationId);
    if (memo !== undefined) {
      return structuredClone(memo);
    }

    let result: unknown;
    let denial: CollabError | null = null;
    try {
      result = HANDLERS[command](this.state, payload);
    } catch (error) {
      if (!(error instanceof CollabError)) {
        throw error;
      }
      denial = error;
    }

    const at = payload["at"] as string;
    const previous =
      this.audit.length > 0 ? (this.audit[this.audit.length - 1]?.digest ?? null) : null;
    const content = {
      sequence: this.audit.length + 1,
      event_id: `evt_${randomUUID().replaceAll("-", "")}`,
      operation_id: operationId,
      command,
      actor: String(payload["actor"] ?? ""),
      at,
      outcome: denial === null ? ("applied" as const) : ("denied" as const),
      denial_code: denial?.code ?? null,
      fingerprint: inputDigest,
      payload_digest: digestOf(payload),
      payload: structuredClone(payload),
      result_digest: denial === null ? digestOf(result) : null,
      previous_digest: previous,
    };
    const record: AuditRecord = { ...content, digest: auditDigest(content) };
    this.audit.push(record);
    this.state.attempts.set(operationId, inputDigest);
    if (denial === null) {
      this.state.results.set(operationId, structuredClone(result));
    }
    this.flushSync();
    if (denial !== null) {
      throw denial;
    }
    return structuredClone(result);
  }

  /**
   * Rebuild state by re-executing recorded attempts through the same handlers.
   * Any divergence — broken chain, changed payload, different outcome — fails
   * the rebuild instead of silently accepting corrupted history.
   */
  private restore(records: readonly AuditRecord[]): void {
    const problem = auditChainProblem(records);
    if (problem !== null) {
      throw new Error(`collaboration audit log is not intact: ${problem}`);
    }
    for (const record of records) {
      const known = this.state.attempts.get(record.operation_id);
      if (known !== undefined && known !== record.fingerprint) {
        throw new Error(
          `collaboration audit log reuses operation ${record.operation_id} with a different payload`,
        );
      }
      if (this.state.results.has(record.operation_id)) {
        throw new Error(
          `collaboration audit log records operation ${record.operation_id} after it was applied`,
        );
      }
      let result: unknown;
      let denial: CollabError | null = null;
      try {
        result = HANDLERS[record.command](this.state, record.payload);
      } catch (error) {
        if (!(error instanceof CollabError)) {
          throw error;
        }
        denial = error;
      }
      if (record.outcome === "applied") {
        if (denial !== null) {
          throw new Error(
            `audit replay diverged at sequence ${record.sequence}: expected applied, got ${denial.code}`,
          );
        }
        if (digestOf(result) !== record.result_digest) {
          throw new Error(`audit replay diverged at sequence ${record.sequence}: result mismatch`);
        }
        this.state.results.set(record.operation_id, structuredClone(result));
      } else {
        if (denial === null || denial.code !== record.denial_code) {
          throw new Error(
            `audit replay diverged at sequence ${record.sequence}: expected ${record.denial_code}`,
          );
        }
      }
      this.state.attempts.set(record.operation_id, record.fingerprint);
    }
    this.audit.push(...structuredClone(records));
  }
}

function requireOperationId(input: Payload): string {
  const value = input["operation_id"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CollabError("INVALID_INPUT", "operation_id must be a non-empty string", {
      field: "operation_id",
    });
  }
  return value;
}

function readPersistedState(raw: unknown): PersistedState {
  if (raw === null || typeof raw !== "object") {
    throw new Error("collaboration state is not a JSON object");
  }
  const value = raw as Record<string, unknown>;
  const version = value["schema_version"];
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `collaboration state schema ${String(version)} is not supported (${SCHEMA_VERSION})`,
    );
  }
  const audit = value["audit"];
  if (!Array.isArray(audit)) {
    throw new Error("collaboration state has no audit log");
  }
  return { schema_version: SCHEMA_VERSION, audit: audit as AuditRecord[] };
}
