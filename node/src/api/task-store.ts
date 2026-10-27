import { randomUUID } from "node:crypto";

import type { DshState } from "../dsh/types.js";

/** UI status enum from the M0 forgepilot-api/v1 contract. */
export const UI_STATUSES = [
  "queued",
  "assessing_risk",
  "awaiting_approval",
  "approved",
  "planning",
  "executing",
  "validating",
  "awaiting_review",
  "approved_for_merge",
  "stopped",
  "rejected",
  "cancelled",
  "timed_out",
  "expired",
  "merged",
] as const;

export type UiStatus = (typeof UI_STATUSES)[number];

/** Statuses that are terminal for the task; no further transitions are projected. */
const TERMINAL_STATUS_TABLE: Record<UiStatus, boolean> = {
  queued: false,
  assessing_risk: false,
  awaiting_approval: false,
  approved: false,
  planning: false,
  executing: false,
  validating: false,
  awaiting_review: false,
  approved_for_merge: false,
  stopped: true,
  rejected: true,
  cancelled: true,
  timed_out: true,
  expired: true,
  merged: true,
};

export function isTerminalStatus(status: UiStatus): boolean {
  return TERMINAL_STATUS_TABLE[status];
}

/**
 * The complete M0 SSE event vocabulary (forgepilot-api/v1). All 13 types are
 * allowed on the stream; M2 emits the ones with real producers (see
 * TaskService) and reserves `plan.updated` / `validation.completed` for the
 * milestones that produce plans and validation runs.
 */
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** Runtime list backing TaskEventType; single source for the OpenAPI enum. */
export const TASK_EVENT_TYPES = [
  "task.status_changed",
  "pi.text_delta",
  "pi.turn_settled",
  "plan.updated",
  "approval.required",
  "approval.resolved",
  "tool.requested",
  "tool.completed",
  "tool.denied",
  "validation.completed",
  "artifact.available",
  "evidence.appended",
  "task.terminal",
] as const;

export interface TaskEvent {
  event_id: string;
  sequence: number;
  occurred_at: string;
  task_id: string;
  task_version: number;
  type: TaskEventType;
  data: Record<string, unknown>;
}

/** Timeline item shape returned by GET /api/v1/tasks/{id}/timeline. */
export type TimelineItem = TaskEvent;

export interface TaskResource {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
  current_run_id: string | null;
  run_history_url: string;
  repository: { id: string; display_name: string; base_ref: string; base_sha: string };
  request: { summary: string; source_reference: string | null };
  status: UiStatus;
  status_reason: string | null;
  risk: { class: string; decision_code: string; requires_human_approval: boolean } | null;
  progress: { phase: string | null; actions_completed: number; actions_total: number | null };
  artifacts: { patch: null; report: null; evidence_bundle_available: boolean };
}

/** Redacted run summary listed by GET /api/v1/tasks/{id}/runs. */
export interface RunSummary {
  run_id: string;
  state: DshState;
  created_at: string;
}

/**
 * Project the authoritative dsh run state onto the UI status vocabulary.
 *
 * Follows the M0 mapping table exactly; `running` maps to the display phases
 * chosen by the caller (planning/executing/validating). `queued` and
 * `assessing_risk` exist only before dsh answers and are passed in directly.
 */
export function projectDshState(state: DshState, runningPhase: UiStatus): UiStatus {
  switch (state) {
    case "requested":
      return "awaiting_approval";
    case "approved":
      return "approved";
    case "running":
      return runningPhase;
    default:
      return state;
  }
}

/** Display phase for a `running` dsh state given what the task has observed. */
export function runningPhaseFor(
  agentSettled: boolean,
  actionsCompleted: number,
  actionsInFlight: boolean,
): UiStatus {
  if (agentSettled) {
    return "validating";
  }
  if (actionsCompleted > 0 || actionsInFlight) {
    return "executing";
  }
  return "planning";
}

export interface TaskRecord {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  repository: TaskResource["repository"];
  summary: string;
  sourceReference: string | null;
  acceptanceCriteria: string[];
  status: UiStatus;
  statusReason: string | null;
  risk: TaskResource["risk"];
  progress: TaskResource["progress"];
  runId: string | null;
  runs: RunSummary[];
  /** Scope digest dsh requires on approvals for an elevated run. */
  scopeDigest: string | null;
  evidenceBundleAvailable: boolean;
  events: TaskEvent[];
  subscribers: Set<(event: TaskEvent) => void>;
  /** True once a terminal status was projected; gates cancel/messages. */
  terminal: boolean;
  /** Pi-side observation flags feeding the running display phase. */
  agentSettled: boolean;
  actionsInFlight: number;
}

export function newTaskId(): string {
  return `tsk_${randomUUID().replaceAll("-", "")}`;
}

export function createTaskRecord(input: {
  id: string;
  repository: TaskResource["repository"];
  summary: string;
  sourceReference: string | null;
  acceptanceCriteria: string[];
}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    repository: input.repository,
    summary: input.summary,
    sourceReference: input.sourceReference,
    acceptanceCriteria: input.acceptanceCriteria,
    status: "queued",
    statusReason: null,
    risk: null,
    progress: { phase: null, actions_completed: 0, actions_total: null },
    runId: null,
    runs: [],
    scopeDigest: null,
    evidenceBundleAvailable: false,
    events: [],
    subscribers: new Set(),
    terminal: false,
    agentSettled: false,
    actionsInFlight: 0,
  };
}

export function toTaskResource(record: TaskRecord): TaskResource {
  return {
    id: record.id,
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    current_run_id: record.runId,
    run_history_url: `/api/v1/tasks/${record.id}/runs`,
    repository: record.repository,
    request: { summary: record.summary, source_reference: record.sourceReference },
    status: record.status,
    status_reason: record.statusReason,
    risk: record.risk,
    progress: record.progress,
    artifacts: {
      patch: null,
      report: null,
      evidence_bundle_available: record.evidenceBundleAvailable,
    },
  };
}

/**
 * In-memory task registry with the versioned event log that backs both the
 * timeline endpoint and the SSE stream. Durable persistence is M3 scope; this
 * store intentionally lives only for the process lifetime.
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  put(record: TaskRecord): void {
    this.tasks.set(record.id, record);
  }

  /** Ordered by creation time, matching the contract's list semantics. */
  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Append one event, bump the task version, and notify SSE subscribers. */
  appendEvent(record: TaskRecord, type: TaskEventType, data: Record<string, unknown>): TaskEvent {
    record.version += 1;
    record.updatedAt = new Date().toISOString();
    const event: TaskEvent = {
      event_id: `evt_${randomUUID().replaceAll("-", "")}`,
      sequence: record.events.length + 1,
      occurred_at: record.updatedAt,
      task_id: record.id,
      task_version: record.version,
      type,
      data,
    };
    record.events.push(event);
    for (const subscriber of record.subscribers) {
      subscriber(event);
    }
    return event;
  }

  /**
   * Set a new status, recording the change event when the status really moved.
   *
   * Terminal statuses are absorbing, mirroring dsh's FP-01 state table: a
   * stale or out-of-order projection can never revive a task that already
   * reached a terminal outcome.
   */
  setStatus(record: TaskRecord, status: UiStatus, reason: string | null): TaskEvent | null {
    if (isTerminalStatus(record.status)) {
      return null;
    }
    if (record.status === status && record.statusReason === reason) {
      return null;
    }
    const previous = record.status;
    record.status = status;
    record.statusReason = reason;
    record.terminal = isTerminalStatus(status);
    return this.appendEvent(record, "task.status_changed", { from: previous, to: status, reason });
  }
}
