import { createHash, randomUUID } from "node:crypto";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getEnvApiKey } from "@mariozechner/pi-ai";

import type { OrchestratorConfig } from "../config.js";
import { DshError } from "../dsh/client.js";
import type { DshClient } from "../dsh/client.js";
import type { DshGrantSummary, DshProposedWork, DshRunResponse, DshState } from "../dsh/types.js";
import { createDshRequestActionTool } from "../pi/dsh-request-action-tool.js";
import { createTurnSummaryReportTool } from "../pi/turn-report-tool.js";
import { piSystemPrompt, taskPrompt } from "../pi/prompts.js";
import type { PiSessionOptions } from "../pi/session.js";
import { PiSession } from "../pi/session.js";
import { ApiError, apiErrorFromDsh } from "./errors.js";
import { PiSummaryTracker } from "./pi-summary.js";
import type { PiSummary } from "./pi-summary.js";
import type {
  TaskRecord,
  TaskEvent,
  TaskResource,
  TimelineItem,
  TaskStore,
  ArtifactMetadata,
  UiStatus,
} from "./task-store.js";
import {
  UI_STATUSES,
  createTaskRecord,
  isTerminalStatus,
  newTaskId,
  projectDshState,
  projectEventForDisplay,
  runningPhaseFor,
  toTaskResource,
} from "./task-store.js";

export interface CreateTaskInput {
  repository_id: string;
  base_ref: string;
  summary: string;
  source_reference?: string;
  acceptance_criteria?: string[];
}

export interface CreateTaskOptions {
  /**
   * Client-supplied replay key for POST /api/v1/tasks. Repeating a create
   * with the same key and payload returns the original task instead of
   * minting a second dsh run; the same key with a different payload is a
   * 409 IDEMPOTENCY_CONFLICT.
   */
  idempotencyKey?: string;
}

export interface ApproveTaskInput {
  decision: "approve" | "reject";
  scope_digest: string;
}

export interface TaskPage {
  items: TaskResource[];
  next_cursor: string | null;
}

/** Per-task runtime state that is deliberately not part of the task record. */
interface TaskRuntime {
  session: PiSession;
  observedToolCalls: Set<string>;
  watchdog: NodeJS.Timeout;
  /** Accumulates the session's streamed text into the safe summary. */
  summaryTracker: PiSummaryTracker;
}

export interface TaskServiceDeps {
  config: OrchestratorConfig;
  dsh: DshClient;
  store: TaskStore;
  /**
   * Pi model for live runs. Unset means PI_UNAVAILABLE: create/approve refuse
   * to start work the service cannot run.
   */
  model?: Model<Api>;
  /** Injectable stream function for deterministic tests. */
  streamFn?: StreamFn;
  /** Clock seam for approval-window timestamps in tests. */
  now?: () => Date;
}

/**
 * The declared work shape Node submits to dsh.
 *
 * Node never classifies risk — dsh does, independently, from these facts.
 * The forgepilot-api/v1 create body carries no authenticated, structured
 * risk facts (only free-text summary and criteria strings, which are
 * attacker-influencable), so Node declares no positive low-risk signal.
 * harness.AssessRisk then fails every task closed to `elevated`, and each
 * one requires the pre-grant human approval. A low-risk fast path may return
 * only when the API contract grows explicit, authenticated risk declarations
 * that dsh can bind to the grant — never inferred from free text. (QA
 * round-1 blocker: criteria presence is not a trustworthy risk fact.)
 */
function neutralProposedWork(): DshProposedWork {
  return {
    localized_reversible_change: false,
    broad_refactor: false,
    dependency_change: false,
    data_shape_change: false,
    migration: false,
    permission_sensitive: false,
    material_uncertainty: false,
    requests_secret_access: false,
    writes_to_main: false,
    edits_ci_workflows: false,
    edits_governance: false,
    publishes_package: false,
    deploys: false,
    alters_infrastructure: false,
    unapproved_network: false,
  };
}

/** Best-effort external issue id from a source reference URL. */
function externalIdFrom(sourceReference: string | null | undefined, taskId: string): string {
  if (!sourceReference) {
    return taskId;
  }
  const segments = sourceReference.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last ?? taskId;
}

/**
 * Project one authoritative dsh run read onto the task's durable fields:
 * head-SHA binding, governance validity, and the artifact index.
 *
 * Governance observations (QA, checks, quorum) only describe the exact head
 * they were taken against: when dsh reports a current head that differs from
 * the head of the last approval snapshot, the old head's approvals and checks
 * are invalidated (`observations_valid: false`) and the task is no longer
 * projected merge-queue eligible, no matter what the stale snapshot said.
 */
export function applyRunFacts(record: TaskRecord, run: DshRunResponse): void {
  const head = run.patch_report?.head_sha ?? null;
  if (head !== null) {
    record.headSha = head;
  }
  const snapshotHead = run.approval_snapshot?.head_sha ?? null;
  record.approvalSnapshotHeadSha = snapshotHead;
  if (record.headSha !== null && snapshotHead !== null) {
    record.governanceValid = snapshotHead === record.headSha;
    record.mergeQueueEligible =
      record.governanceValid && run.approval_snapshot?.merge_queue_eligible === true;
  } else {
    // No head has been observed for this run: nothing can be stale, and
    // merge-queue admission is impossible without an exact head binding.
    record.governanceValid = true;
    record.mergeQueueEligible = false;
  }
  // The index lists artifacts dsh actually reports; availability flips are
  // reflected by later reads, not pre-listed as unavailable placeholders.
  if (run.patch_report) {
    upsertArtifactMetadata(record, {
      artifact_id: "patch_report",
      available: true,
      digest: run.patch_report.report_digest ?? null,
      head_sha: run.patch_report.head_sha ?? null,
    });
  }
  if (run.bundle_available) {
    upsertArtifactMetadata(record, {
      artifact_id: "evidence_bundle",
      available: true,
      digest: null,
      head_sha: record.headSha,
    });
  }
}

function upsertArtifactMetadata(record: TaskRecord, entry: ArtifactMetadata): void {
  const existing = record.artifactIndex.find(
    (artifact) => artifact.artifact_id === entry.artifact_id,
  );
  if (existing) {
    Object.assign(existing, entry);
    return;
  }
  record.artifactIndex.push(entry);
}

/** Statuses whose display implies a live Pi session drove the run. */
const SESSION_BEARING_STATUSES: ReadonlySet<UiStatus> = new Set<UiStatus>([
  "approved",
  "planning",
  "executing",
  "validating",
]);

/**
 * Stable fingerprint of a create request, keyed on the fields that define a
 * task's identity. Normalization mirrors what createTask trims, so two
 * byte-different but semantically equal bodies share one idempotency slot.
 */
function createTaskFingerprint(input: CreateTaskInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.repository_id,
        input.base_ref,
        input.summary.trim(),
        input.source_reference?.trim() || null,
        (input.acceptance_criteria ?? []).filter((criterion) => criterion.trim().length > 0),
      ]),
    )
    .digest("hex");
}

/**
 * Orchestration core behind forgepilot-api/v1.
 *
 * Owns the task registry, the dsh-control conversation, and the Pi sessions.
 * Authority stays where ADR-0003 put it: dsh decides risk, grants, and
 * execution; this service forwards intents and projects dsh's states onto the
 * UI vocabulary without inventing any.
 */
export class TaskService {
  private readonly deps: TaskServiceDeps;
  private readonly runtimes = new Map<string, TaskRuntime>();
  /**
   * Per-task serialization of dsh state refreshes (QA round-1 blocker):
   * overlapping getRun responses can resolve out of order, so each refresh
   * waits for the previous one before projecting. Combined with the store's
   * absorbing terminal statuses, a stale read can never revive a task.
   */
  private readonly refreshQueues = new Map<string, Promise<void>>();
  /**
   * In-flight creates keyed by Idempotency-Key (M3): two concurrent creates
   * with the same key join one dsh run instead of racing two.
   */
  private readonly pendingCreates = new Map<
    string,
    { fingerprint: string; promise: Promise<TaskResource> }
  >();

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  get store(): TaskStore {
    return this.deps.store;
  }

  async createTask(input: CreateTaskInput, options: CreateTaskOptions = {}): Promise<TaskResource> {
    if (input.repository_id !== this.deps.config.repositoryId) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `repository_id must be ${this.deps.config.repositoryId} for this pilot`,
        { repository_id: input.repository_id },
      );
    }
    if (input.base_ref !== this.deps.config.baseRef) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        `base_ref must be ${this.deps.config.baseRef} for this pilot`,
        { base_ref: input.base_ref },
      );
    }
    const summary = input.summary?.trim() ?? "";
    if (summary.length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", "summary is required");
    }
    const normalized: CreateTaskInput = {
      repository_id: input.repository_id,
      base_ref: input.base_ref,
      summary,
      ...(input.source_reference?.trim()
        ? { source_reference: input.source_reference.trim() }
        : {}),
      acceptance_criteria: (input.acceptance_criteria ?? []).filter(
        (criterion) => criterion.trim().length > 0,
      ),
    };

    const key = options.idempotencyKey?.trim();
    if (!key) {
      return this.executeCreate(normalized);
    }
    // The dsh run is bound to the client key too: even if Node's own ledger
    // were bypassed, dsh replays the recorded response instead of minting a
    // second run for the same logical create.
    const dshIdempotencyKey = `task-create-${createHash("sha256").update(key).digest("hex")}`;
    const fingerprint = createTaskFingerprint(normalized);
    const pending = this.pendingCreates.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          `Idempotency-Key ${JSON.stringify(key)} was already used with a different payload.`,
          { idempotency_key: key },
        );
      }
      return pending.promise;
    }
    let existing: TaskRecord | null = null;
    try {
      existing = this.store.getIdempotentTask(key, fingerprint);
    } catch {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        `Idempotency-Key ${JSON.stringify(key)} was already used with a different payload.`,
        { idempotency_key: key },
      );
    }
    if (existing) {
      return this.replayCreatedTask(existing);
    }
    const promise = this.executeCreate(normalized, dshIdempotencyKey)
      .then((resource) => {
        this.store.rememberIdempotentTask(key, fingerprint, resource.id);
        return resource;
      })
      .catch((error: unknown) => {
        // A prohibited create still materialized a rejected task; remember it
        // so a retry replays the same refusal instead of minting a new run.
        if (
          error instanceof ApiError &&
          error.code === "DSH_RISK_PROHIBITED" &&
          typeof error.details["task_id"] === "string"
        ) {
          this.store.rememberIdempotentTask(key, fingerprint, error.details["task_id"]);
        }
        throw error;
      })
      .finally(() => {
        this.pendingCreates.delete(key);
      });
    this.pendingCreates.set(key, { fingerprint, promise });
    return promise;
  }

  /** Replay a remembered create; prohibited outcomes re-refuse identically. */
  private replayCreatedTask(record: TaskRecord): TaskResource {
    if (record.status === "rejected" && record.risk?.class === "prohibited") {
      throw new ApiError(
        422,
        "DSH_RISK_PROHIBITED",
        "dsh rejected the requested work as prohibited",
        {
          ...Object.fromEntries(
            Object.entries(record.risk).map(([field, value]) => [`risk_${field}`, value]),
          ),
          task_id: record.id,
        },
      );
    }
    return toTaskResource(record);
  }

  private async executeCreate(
    input: CreateTaskInput,
    dshIdempotencyKey?: string,
  ): Promise<TaskResource> {
    const summary = input.summary;
    const acceptanceCriteria = input.acceptance_criteria ?? [];
    const taskId = newTaskId();
    const sourceReference = input.source_reference ?? null;
    try {
      const created = await this.deps.dsh.createRun(
        {
          task_id: taskId,
          issue: {
            provider: "github",
            external_id: externalIdFrom(sourceReference, taskId),
            source_reference: sourceReference ?? `forgepilot://tasks/${taskId}`,
          },
          repository: {
            repository_id: this.deps.config.repositoryId,
            url: this.deps.config.repositoryUrl,
            base_ref: this.deps.config.baseRef,
            base_sha: this.deps.config.baseSha,
          },
          request: {
            summary,
            acceptance_criteria: acceptanceCriteria,
            requested_by: {
              actor_id: this.deps.config.actorId,
              display_name: this.deps.config.actorDisplayName,
            },
          },
          proposed_work: neutralProposedWork(),
          requested_scope: {
            path_hints: [...this.deps.config.pathHints],
            tool_capabilities: [...this.deps.config.toolCapabilities],
            max_wall_clock_seconds: this.deps.config.maxWallClockSeconds,
          },
        },
        dshIdempotencyKey,
      );
      const record = this.materializeCreatedTask(
        taskId,
        summary,
        sourceReference,
        acceptanceCriteria,
        created,
      );
      if (created.state === "approved" && created.grant) {
        this.startPi(record, created.grant);
      }
      return toTaskResource(record);
    } catch (error) {
      if (error instanceof DshError && error.status === 422) {
        // dsh recorded a rejected run before refusing: expose it as a terminal
        // task so the evidence stays queryable, then surface the contract error.
        const record = this.materializeProhibitedTask(
          taskId,
          summary,
          sourceReference,
          acceptanceCriteria,
          error,
        );
        throw new ApiError(422, "DSH_RISK_PROHIBITED", error.message, {
          ...error.details,
          task_id: record.id,
        });
      }
      if (error instanceof DshError) {
        throw apiErrorFromDsh(error);
      }
      throw error;
    }
  }

  async approveTask(taskId: string, input: ApproveTaskInput): Promise<TaskResource> {
    const record = this.requireRecord(taskId);
    this.requireActive(record, "approve");
    if (record.status !== "awaiting_approval" || !record.runId) {
      throw new ApiError(
        409,
        "TASK_STATE_CONFLICT",
        `Task ${taskId} is not awaiting approval (status: ${record.status})`,
        { status: record.status },
      );
    }
    if (input.decision !== "approve" && input.decision !== "reject") {
      throw new ApiError(400, "INVALID_REQUEST", 'decision must be "approve" or "reject"');
    }
    if (!input.scope_digest) {
      throw new ApiError(400, "INVALID_REQUEST", "scope_digest is required");
    }
    if (!this.deps.model && input.decision === "approve") {
      throw new ApiError(503, "PI_UNAVAILABLE", "No Pi model is configured for this orchestrator");
    }
    const now = this.deps.now ? this.deps.now() : new Date();
    try {
      const approved = await this.deps.dsh.recordApproval(record.runId, {
        approval_id: `apr_${randomUUID().replaceAll("-", "")}`,
        decision: input.decision,
        approved_by: {
          actor_id: this.deps.config.actorId,
          identity: this.deps.config.approverIdentity,
        },
        approved_at: now.toISOString(),
        scope_digest: input.scope_digest,
      });
      this.store.appendEvent(record, "approval.resolved", {
        decision: input.decision,
        state: approved.state,
      });
      if (approved.state === "approved" && approved.grant) {
        if (record.risk) {
          record.risk = { ...record.risk, requires_human_approval: false };
        }
        record.scopeDigest = null;
        this.projectDshState(record, approved.state, null);
        this.startPi(record, approved.grant);
      } else {
        this.projectDshState(record, approved.state, `approval ${input.decision} recorded by dsh`);
      }
      return toTaskResource(record);
    } catch (error) {
      if (error instanceof DshError) {
        throw apiErrorFromDsh(error);
      }
      throw error;
    }
  }

  async cancelTask(taskId: string, reason?: string): Promise<TaskResource> {
    const record = this.requireRecord(taskId);
    this.requireActive(record, "cancel");
    if (!record.runId) {
      throw new ApiError(409, "TASK_STATE_CONFLICT", `Task ${taskId} has no run to cancel`);
    }
    this.disposeRuntime(record.id);
    try {
      const cancelled = await this.deps.dsh.cancelRun(record.runId, {
        requested_by: {
          actor_id: this.deps.config.actorId,
          identity: this.deps.config.approverIdentity,
        },
        reason: reason?.trim() || "cancelled through the product API",
      });
      this.projectDshState(record, cancelled.state, reason?.trim() || null);
      return toTaskResource(record);
    } catch (error) {
      if (error instanceof DshError) {
        throw apiErrorFromDsh(error);
      }
      throw error;
    }
  }

  async sendMessage(taskId: string, mode: "steer" | "follow_up", content: string): Promise<void> {
    const record = this.requireRecord(taskId);
    this.requireActive(record, "send messages to");
    const runtime = this.runtimes.get(taskId);
    if (!runtime) {
      throw new ApiError(
        409,
        "TASK_STATE_CONFLICT",
        `Task ${taskId} has no active Pi session (not approved yet, or already finished)`,
        { status: record.status },
      );
    }
    if (!content || content.trim().length === 0) {
      throw new ApiError(400, "INVALID_REQUEST", "content is required");
    }
    if (runtime.session.running) {
      if (mode === "steer") {
        await runtime.session.steer(content);
      } else {
        await runtime.session.followUp(content);
      }
      return;
    }
    // Idle session: deliver the queued message as the next run, which is what
    // "queued" means contractually when nothing is in flight.
    this.runPromptSafely(record, runtime, content);
  }

  getTask(taskId: string): TaskResource {
    return toTaskResource(this.requireRecord(taskId));
  }

  /**
   * Whether the task reached a terminal projection. The SSE handler uses
   * this to decide that no future events can exist, so it must never
   * subscribe a client to a terminal task — including one whose replay has
   * nothing left to write (Last-Event-ID anchored at task.terminal).
   */
  isTerminal(taskId: string): boolean {
    return this.requireRecord(taskId).terminal;
  }

  listTasks(cursor: string | null, status: string | null): TaskPage {
    if (status !== null && !(UI_STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(400, "INVALID_REQUEST", `Unknown status filter ${JSON.stringify(status)}`);
    }
    let records = this.deps.store.list();
    if (status !== null) {
      records = records.filter((record) => record.status === status);
    }
    let startIndex = 0;
    if (cursor !== null) {
      const index = records.findIndex((record) => record.id === cursor);
      if (index === -1) {
        throw new ApiError(400, "INVALID_CURSOR", `Unknown cursor ${JSON.stringify(cursor)}`);
      }
      startIndex = index + 1;
    }
    const page = records.slice(startIndex, startIndex + 50);
    const last = page[page.length - 1];
    return {
      items: page.map((record) => toTaskResource(record)),
      next_cursor: last && startIndex + page.length < records.length ? last.id : null,
    };
  }

  getRunSummaries(taskId: string) {
    return this.requireRecord(taskId).runs;
  }

  /**
   * The recorded timeline as the API serves it: every event passes the
   * display gate, so a `pi.summary.updated` payload is re-proven exactly
   * like the task's `pi_summary` (DAT-194). Records and durable bytes are
   * untouched — this returns gated copies in their recorded order.
   */
  getTimeline(taskId: string): TimelineItem[] {
    return this.requireRecord(taskId).events.map(projectEventForDisplay);
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    const record = this.requireRecord(taskId);
    // Live events go through the same display gate as replayed ones, so a
    // subscriber sees one contract no matter how the event reaches it.
    const gated = (event: TaskEvent): void => listener(projectEventForDisplay(event));
    record.subscribers.add(gated);
    return () => record.subscribers.delete(gated);
  }

  async getArtifact(taskId: string, artifactId: string): Promise<Record<string, unknown>> {
    const record = this.requireRecord(taskId);
    if (!record.runId) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task ${taskId} has no run artifacts`);
    }
    try {
      return await this.deps.dsh.getArtifact(record.runId, artifactId);
    } catch (error) {
      if (error instanceof DshError) {
        throw apiErrorFromDsh(error);
      }
      throw error;
    }
  }

  /** Release sessions and timers for a task; idempotent. */
  disposeRuntime(taskId: string): void {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) {
      return;
    }
    clearTimeout(runtime.watchdog);
    runtime.session.dispose();
    this.runtimes.delete(taskId);
  }

  disposeAll(): void {
    for (const taskId of [...this.runtimes.keys()]) {
      this.disposeRuntime(taskId);
    }
  }

  private requireRecord(taskId: string): TaskRecord {
    const record = this.deps.store.get(taskId);
    if (!record) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task ${taskId} was not found`);
    }
    return record;
  }

  private requireActive(record: TaskRecord, verb: string): void {
    if (record.terminal || isTerminalStatus(record.status)) {
      throw new ApiError(
        409,
        "TASK_STATE_CONFLICT",
        `The task cannot be ${verb} in its terminal state.`,
        { status: record.status },
      );
    }
  }

  private materializeCreatedTask(
    taskId: string,
    summary: string,
    sourceReference: string | null,
    acceptanceCriteria: string[],
    created: {
      run_id: string;
      state: DshState;
      risk_assessment: { risk_class: string; decision_code: string };
      required_action: { type: string; scope_digest: string } | null;
    },
  ): TaskRecord {
    const record = createTaskRecord({
      id: taskId,
      repository: {
        id: this.deps.config.repositoryId,
        display_name: this.deps.config.repositoryId.replace(/^github:/, ""),
        base_ref: this.deps.config.baseRef,
        base_sha: this.deps.config.baseSha,
      },
      summary,
      sourceReference,
      acceptanceCriteria,
    });
    record.runId = created.run_id;
    record.runs.push({
      run_id: created.run_id,
      state: created.state,
      created_at: record.createdAt,
    });
    record.risk = {
      class: created.risk_assessment.risk_class,
      decision_code: created.risk_assessment.decision_code,
      requires_human_approval: created.state === "requested",
    };
    this.deps.store.put(record);
    if (created.state === "requested") {
      this.store.setStatus(record, "awaiting_approval", "dsh requires a pre-grant human approval");
      if (created.required_action) {
        record.scopeDigest = created.required_action.scope_digest;
        this.store.appendEvent(record, "approval.required", {
          run_id: created.run_id,
          approval_type: created.required_action.type,
          scope_digest: created.required_action.scope_digest,
        });
      }
    } else {
      this.store.setStatus(record, "approved", null);
    }
    return record;
  }

  private materializeProhibitedTask(
    taskId: string,
    summary: string,
    sourceReference: string | null,
    acceptanceCriteria: string[],
    error: DshError,
  ): TaskRecord {
    const record = createTaskRecord({
      id: taskId,
      repository: {
        id: this.deps.config.repositoryId,
        display_name: this.deps.config.repositoryId.replace(/^github:/, ""),
        base_ref: this.deps.config.baseRef,
        base_sha: this.deps.config.baseSha,
      },
      summary,
      sourceReference,
      acceptanceCriteria,
    });
    const runId = typeof error.details["run_id"] === "string" ? error.details["run_id"] : null;
    record.runId = runId;
    if (runId) {
      record.runs.push({ run_id: runId, state: "rejected", created_at: record.createdAt });
    }
    record.evidenceBundleAvailable = error.details["evidence_bundle_available"] === true;
    record.risk = {
      class: "prohibited",
      decision_code:
        typeof error.details["decision_code"] === "string"
          ? error.details["decision_code"]
          : "risk_prohibited",
      requires_human_approval: false,
    };
    this.deps.store.put(record);
    this.store.setStatus(record, "rejected", "dsh rejected the requested work as prohibited");
    // setStatus already flagged the record terminal; this records the single
    // terminal event and marks it so recovery can never append a second one.
    this.finalizeIfTerminal(record);
    return record;
  }

  private startPi(record: TaskRecord, grant: DshGrantSummary): void {
    if (!this.deps.model || !record.runId) {
      this.store.setStatus(record, "stopped", "PI_UNAVAILABLE: no Pi model configured");
      this.finalizeIfTerminal(record);
      return;
    }
    const sessionId = `pis_${randomUUID().replaceAll("-", "")}`;
    const observedToolCalls = new Set<string>();
    // The summary lifecycle starts with the run: pending until the first
    // turn settles, then one evaluated summary per settled turn (DAT-191).
    const summaryTracker = new PiSummaryTracker(record.id);
    this.publishSummary(record, summaryTracker.beginRun(record.runId));
    // The structured report tool is the session's trusted display source
    // (DAT-193): it records the model's closed-vocabulary report of the
    // open turn; it executes nothing and adds no capability.
    const reportTool = createTurnSummaryReportTool({
      onReport: (report) => summaryTracker.recordReport(report),
    });
    let sessionRef: PiSession | null = null;
    const tool = createDshRequestActionTool({
      client: this.deps.dsh,
      runId: record.runId,
      sessionId,
      getTurnId: () => sessionRef?.currentTurnId() ?? "turn_0",
      observe: (observation) => {
        if (record.terminal) {
          return;
        }
        observedToolCalls.add(observation.toolCallId);
        if (observation.outcome === "accepted") {
          this.store.appendEvent(record, "tool.completed", {
            tool_call_id: observation.toolCallId,
            tool_id: observation.toolId,
            action_id: observation.actionId,
            state: observation.state ?? null,
          });
          // An accepted action produced dsh audit evidence; surface it as the
          // contract's evidence.appended event so the UI can show the chain
          // growing without reading dsh directly.
          if (observation.auditEventReference) {
            this.store.appendEvent(record, "evidence.appended", {
              action_id: observation.actionId,
              audit_event_reference: observation.auditEventReference,
            });
          }
        } else {
          this.store.appendEvent(record, "tool.denied", {
            tool_call_id: observation.toolCallId,
            tool_id: observation.toolId,
            action_id: observation.actionId,
            error_code: observation.errorCode ?? "DSH_UNAVAILABLE",
            message: observation.errorMessage ?? "dsh did not answer",
          });
        }
        this.queueRefresh(record);
      },
    });
    const sessionOptions: PiSessionOptions = {
      sessionId,
      systemPrompt: piSystemPrompt(),
      model: this.deps.model,
      tools: [tool, reportTool],
      listener: (event) => {
        if (record.terminal) {
          return;
        }
        switch (event.type) {
          case "text_delta":
            this.store.appendEvent(record, "pi.text_delta", { delta: event.delta });
            // The safe summary is judged on the fully assembled turn at
            // settlement; fragments are accumulated, never judged alone.
            summaryTracker.appendText(event.delta);
            break;
          case "tool_started":
            if (event.toolName === "dsh_request_action") {
              record.actionsInFlight += 1;
              const args = event.args as { tool_id?: string; path_scope?: string[] };
              this.store.appendEvent(record, "tool.requested", {
                tool_call_id: event.toolCallId,
                tool_id: args.tool_id ?? null,
                path_scope: args.path_scope ?? [],
              });
            }
            break;
          case "tool_finished":
            if (event.toolName === "dsh_request_action") {
              record.actionsInFlight = Math.max(0, record.actionsInFlight - 1);
              if (!observedToolCalls.has(event.toolCallId)) {
                // The tool failed before dsh answered (transport or bug): the
                // intent never reached the control plane, so record it as
                // denied rather than leaving a requested hole in the timeline.
                this.store.appendEvent(record, "tool.denied", {
                  tool_call_id: event.toolCallId,
                  tool_id: null,
                  error_code: "DSH_UNAVAILABLE",
                  message: "the action intent did not reach dsh",
                });
              }
              observedToolCalls.delete(event.toolCallId);
            }
            break;
          case "agent_settled":
            record.agentSettled = true;
            this.store.appendEvent(record, "pi.turn_settled", {});
            this.settleSummary(record, summaryTracker);
            this.queueRefresh(record);
            break;
          case "agent_error":
            record.agentSettled = true;
            this.store.appendEvent(record, "pi.turn_settled", { error: event.message });
            // The partial turn text is judged exactly like a clean one: the
            // gate fails closed, so an error cannot launder raw content.
            this.settleSummary(record, summaryTracker);
            this.queueRefresh(record);
            break;
          case "run_started":
            summaryTracker.beginTurn(sessionRef?.currentTurnId() ?? "turn_0");
            break;
        }
      },
    };
    if (this.deps.streamFn) {
      sessionOptions.streamFn = this.deps.streamFn;
    }
    sessionOptions.getApiKey = (provider: string) => getEnvApiKey(provider);
    const session = new PiSession(sessionOptions);
    sessionRef = session;

    // Node-side watchdog: dsh bounds tool executions, but nothing bounds the
    // model loop itself. When the wall clock elapses, stop the agent and let
    // dsh record the authoritative cancellation.
    const watchdog = setTimeout(
      () => {
        if (record.terminal || !record.runId) {
          return;
        }
        session.abort();
        void this.deps.dsh
          .cancelRun(record.runId, {
            requested_by: {
              actor_id: this.deps.config.actorId,
              identity: this.deps.config.approverIdentity,
            },
            reason: "task wall clock elapsed",
          })
          .then((response) =>
            this.projectDshState(record, response.state, "task wall clock elapsed"),
          )
          .catch(() => {
            // dsh unreachable: keep the current projection; the grant expiry
            // still blocks further dispatch on dsh's side.
          });
      },
      this.deps.config.maxWallClockSeconds * 1000 + 2000,
    );
    watchdog.unref();
    const runtime: TaskRuntime = { session, observedToolCalls, watchdog, summaryTracker };
    this.runtimes.set(record.id, runtime);

    this.runPromptSafely(
      record,
      runtime,
      taskPrompt({
        summary: record.summary,
        sourceReference: record.sourceReference,
        acceptanceCriteria: record.acceptanceCriteria,
        repositoryId: record.repository.id,
        baseRef: record.repository.base_ref,
        baseSha: record.repository.base_sha,
        grant,
      }),
    );
  }

  private runPromptSafely(record: TaskRecord, runtime: TaskRuntime, prompt: string): void {
    void runtime.session.runPrompt(prompt).catch((error: unknown) => {
      if (record.terminal) {
        return;
      }
      this.store.appendEvent(record, "pi.turn_settled", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.settleSummary(record, runtime.summaryTracker);
    });
  }

  /**
   * Project one evaluated Pi summary onto the task and record it as the
   * contract's `pi.summary.updated` event. Only evaluated summaries are
   * published: the raw turn text lives nowhere in the event or the record.
   */
  private publishSummary(record: TaskRecord, summary: PiSummary): void {
    record.piSummary = summary;
    this.store.appendEvent(record, "pi.summary.updated", { summary: { ...summary } });
  }

  /**
   * Close the open turn through the safety gate and publish the outcome.
   * A settlement with no open turn (the `agent_error` then `agent_settled`
   * double emission of one run) publishes nothing: each turn yields exactly
   * one pi.summary.updated, as the contract promises.
   */
  private settleSummary(record: TaskRecord, tracker: PiSummaryTracker): void {
    const settled = tracker.settleTurn();
    if (settled === null) {
      return;
    }
    this.publishSummary(record, settled);
  }

  /**
   * Queue a dsh state refresh for this task. Refreshes for one task are
   * serialized so out-of-order getRun responses cannot apply stale state on
   * top of newer projections.
   */
  private queueRefresh(record: TaskRecord): void {
    const previous = this.refreshQueues.get(record.id) ?? Promise.resolve();
    const next = previous
      .then(() => this.refreshRunState(record))
      .catch(() => {
        // refreshRunState already swallows dsh errors it can classify; this
        // catch keeps one failed refresh from poisoning the task's queue.
      });
    this.refreshQueues.set(record.id, next);
  }

  /**
   * Re-read the authoritative run state from dsh and re-project the task.
   * Called after every tool outcome and at turn settlement so dsh-side
   * transitions (stopped by a stop condition, timed_out, expired, ...)
   * surface in Node task status.
   */
  private async refreshRunState(record: TaskRecord): Promise<void> {
    if (!record.runId || record.terminal) {
      return;
    }
    const runId = record.runId;
    let run;
    try {
      run = await this.deps.dsh.getRun(runId);
    } catch (error) {
      if (record.terminal) {
        return;
      }
      if (error instanceof DshError && error.status === 404) {
        this.store.setStatus(record, "stopped", "dsh no longer knows this run");
        this.finalizeIfTerminal(record);
      }
      return;
    }
    // Terminal statuses are absorbing: a stale read that lands after a newer
    // projection finalized the task must not revive it (QA round-1 blocker).
    if (record.terminal) {
      return;
    }
    this.updateRunSummary(record, run.run_id, run.state);
    // Head-SHA binding, governance validity, and artifact index all follow
    // the authoritative run read — never a Node-side inference.
    applyRunFacts(record, run);
    // Emit artifact.available exactly on the unavailable→available edge so
    // the UI learns about a finalized evidence bundle without polling dsh.
    if (run.bundle_available && !record.evidenceBundleAvailable) {
      this.store.appendEvent(record, "artifact.available", {
        run_id: run.run_id,
        artifact_id: "evidence_bundle",
      });
    }
    record.evidenceBundleAvailable = run.bundle_available;
    record.risk = {
      class: run.risk_assessment.risk_class,
      decision_code: run.risk_assessment.decision_code,
      requires_human_approval: run.state === "requested",
    };
    const phase = runningPhaseFor(
      record.agentSettled,
      run.execution_counts.actions_allowed,
      record.actionsInFlight > 0,
    );
    record.progress = {
      phase,
      actions_completed: run.execution_counts.actions_allowed,
      actions_total: null,
    };
    this.projectDshState(record, run.state, null);
    this.store.save(record);
  }

  private updateRunSummary(record: TaskRecord, runId: string, state: DshState): void {
    const entry = record.runs.find((run) => run.run_id === runId);
    if (entry) {
      entry.state = state;
      return;
    }
    record.runs.push({ run_id: runId, state, created_at: record.updatedAt });
  }

  /** Project one dsh state onto the task, emitting terminal bookkeeping. */
  private projectDshState(record: TaskRecord, state: DshState, reason: string | null): void {
    const phase = runningPhaseFor(
      record.agentSettled,
      record.progress.actions_completed,
      record.actionsInFlight > 0,
    );
    this.store.setStatus(record, projectDshState(state, phase), reason);
    this.finalizeIfTerminal(record);
  }

  private finalizeIfTerminal(record: TaskRecord): void {
    if (!record.terminal || record.terminalEventRecorded) {
      return;
    }
    record.terminalEventRecorded = true;
    this.store.appendEvent(record, "task.terminal", { status: record.status });
    this.disposeRuntime(record.id);
  }

  /**
   * Re-associate every persisted non-terminal task with its dsh run after a
   * restart (M3).
   *
   * dsh stays the fact source: recovery only re-reads run state and
   * re-projects. It never fabricates, overwrites, or reorders timeline
   * events — a task that was already terminal before the restart keeps its
   * recorded history byte-for-byte, and a run that reached a terminal dsh
   * state while Node was down gets exactly one new status transition and one
   * terminal event at recovery time.
   *
   * Pi sessions are deliberately not resumed: a model loop cannot be
   * reconstructed from the projection, and silently restarting agent work
   * under a grant the operator approved for a different session would
   * fabricate execution. A task stuck mid-run surfaces its dsh-projected
   * status with a recovery reason; the operator cancels it or dsh's own stop
   * conditions end the run.
   */
  async recoverFromDsh(): Promise<void> {
    for (const record of this.deps.store.list()) {
      if (record.terminal) {
        if (!record.terminalEventRecorded) {
          // A terminal projection without its closing frame (only reachable
          // from a hand-migrated or damaged state file): record it exactly
          // once so replayed timelines always end on task.terminal.
          this.finalizeIfTerminal(record);
        }
        continue;
      }
      if (!record.runId) {
        // Created before dsh answered: nothing to re-associate. Leave the
        // projection untouched rather than inventing an outcome.
        continue;
      }
      if (SESSION_BEARING_STATUSES.has(record.status)) {
        // The Pi session died with the previous process; say so instead of
        // pretending the run is still progressing.
        record.agentSettled = false;
        this.store.setStatus(
          record,
          record.status,
          "recovered after orchestrator restart; the Pi session was not resumed",
        );
      }
      await this.refreshRunState(record);
    }
    this.store.flushSync();
  }
}
