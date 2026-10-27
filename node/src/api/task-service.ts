import { randomUUID } from "node:crypto";

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getEnvApiKey } from "@mariozechner/pi-ai";

import type { OrchestratorConfig } from "../config.js";
import { DshError } from "../dsh/client.js";
import type { DshClient } from "../dsh/client.js";
import type { DshGrantSummary, DshProposedWork, DshState } from "../dsh/types.js";
import { createDshRequestActionTool } from "../pi/dsh-request-action-tool.js";
import { piSystemPrompt, taskPrompt } from "../pi/prompts.js";
import type { PiSessionOptions } from "../pi/session.js";
import { PiSession } from "../pi/session.js";
import { ApiError, apiErrorFromDsh } from "./errors.js";
import type { TaskRecord, TaskEvent, TaskResource, TimelineItem, TaskStore } from "./task-store.js";
import {
  UI_STATUSES,
  createTaskRecord,
  isTerminalStatus,
  newTaskId,
  projectDshState,
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

  constructor(deps: TaskServiceDeps) {
    this.deps = deps;
  }

  get store(): TaskStore {
    return this.deps.store;
  }

  async createTask(input: CreateTaskInput): Promise<TaskResource> {
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
    const acceptanceCriteria = (input.acceptance_criteria ?? []).filter(
      (criterion) => criterion.trim().length > 0,
    );

    const taskId = newTaskId();
    const sourceReference = input.source_reference?.trim() || null;
    try {
      const created = await this.deps.dsh.createRun({
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
      });
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

  getTimeline(taskId: string): TimelineItem[] {
    return this.requireRecord(taskId).events;
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    const record = this.requireRecord(taskId);
    record.subscribers.add(listener);
    return () => record.subscribers.delete(listener);
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
    this.store.appendEvent(record, "task.terminal", { status: "rejected" });
    record.terminal = true;
    return record;
  }

  private startPi(record: TaskRecord, grant: DshGrantSummary): void {
    if (!this.deps.model || !record.runId) {
      this.store.setStatus(record, "stopped", "PI_UNAVAILABLE: no Pi model configured");
      this.store.appendEvent(record, "task.terminal", { status: "stopped" });
      return;
    }
    const sessionId = `pis_${randomUUID().replaceAll("-", "")}`;
    const observedToolCalls = new Set<string>();
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
      tools: [tool],
      listener: (event) => {
        if (record.terminal) {
          return;
        }
        switch (event.type) {
          case "text_delta":
            this.store.appendEvent(record, "pi.text_delta", { delta: event.delta });
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
            this.queueRefresh(record);
            break;
          case "agent_error":
            record.agentSettled = true;
            this.store.appendEvent(record, "pi.turn_settled", { error: event.message });
            this.queueRefresh(record);
            break;
          case "run_started":
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
    const runtime: TaskRuntime = { session, observedToolCalls, watchdog };
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
    });
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
    if (!record.terminal) {
      return;
    }
    this.store.appendEvent(record, "task.terminal", { status: record.status });
    this.disposeRuntime(record.id);
  }
}
