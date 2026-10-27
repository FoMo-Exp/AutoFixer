import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  association: {
    task_id: string;
    run_id: string | null;
    repository_id: string;
    base_sha: string;
    head_sha: string | null;
  };
  revision: { base_sha: string; head_sha: string | null };
  status: UiStatus;
  status_reason: string | null;
  risk: { class: string; decision_code: string; requires_human_approval: boolean } | null;
  progress: { phase: string | null; actions_completed: number; actions_total: number | null };
  governance: {
    current_head_sha: string | null;
    observations_valid: boolean;
    merge_queue_eligible: boolean;
  };
  artifacts: {
    patch: null;
    report: null;
    evidence_bundle_available: boolean;
    index: ArtifactMetadata[];
  };
}

export interface ArtifactMetadata {
  artifact_id: string;
  available: boolean;
  digest: string | null;
  head_sha: string | null;
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
  /** Current dsh patch revision, never inferred from a Node event. */
  headSha: string | null;
  /** Head to which the most recent dsh governance snapshot applies. */
  approvalSnapshotHeadSha: string | null;
  governanceValid: boolean;
  mergeQueueEligible: boolean;
  artifactIndex: ArtifactMetadata[];
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
  /** Prevents recovery or duplicate refreshes from appending terminal twice. */
  terminalEventRecorded: boolean;
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
    headSha: null,
    approvalSnapshotHeadSha: null,
    governanceValid: true,
    mergeQueueEligible: false,
    artifactIndex: [],
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
    terminalEventRecorded: false,
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
    association: {
      task_id: record.id,
      run_id: record.runId,
      repository_id: record.repository.id,
      base_sha: record.repository.base_sha,
      head_sha: record.headSha,
    },
    revision: { base_sha: record.repository.base_sha, head_sha: record.headSha },
    status: record.status,
    status_reason: record.statusReason,
    risk: record.risk,
    progress: record.progress,
    governance: {
      current_head_sha: record.headSha,
      observations_valid: record.governanceValid,
      merge_queue_eligible: record.mergeQueueEligible,
    },
    artifacts: {
      patch: null,
      report: null,
      evidence_bundle_available: record.evidenceBundleAvailable,
      index: record.artifactIndex.map((artifact) => ({ ...artifact })),
    },
  };
}

/**
 * Versioned task projection and event log. The projection is persisted as one
 * atomically replaced JSON document when a path is configured. JSON is used
 * deliberately here: Node must not become a second authority for dsh evidence,
 * and the projection has no query workload that warrants a database engine.
 * The envelope is schema-versioned and migrated on load so a restart cannot
 * silently interpret an older projection as a newer one. Corrupt or
 * future-versioned state fails startup rather than dropping history.
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly persistencePath: string | undefined;
  private readonly idempotency = new Map<string, CreateIdempotencyRecord>();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(options: TaskStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.load();
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  put(record: TaskRecord): void {
    this.tasks.set(record.id, record);
    this.schedulePersist();
  }

  /** Persist a record after callers update projected fields without an event. */
  save(record: TaskRecord): void {
    if (this.tasks.get(record.id) !== record) {
      this.tasks.set(record.id, record);
    }
    this.schedulePersist();
  }

  getIdempotentTask(key: string, fingerprint: string): TaskRecord | null {
    const entry = this.idempotency.get(key);
    if (!entry) {
      return null;
    }
    if (entry.fingerprint !== fingerprint) {
      throw new Error("idempotency key was already used with a different payload");
    }
    return this.tasks.get(entry.taskId) ?? null;
  }

  rememberIdempotentTask(key: string, fingerprint: string, taskId: string): void {
    this.idempotency.set(key, { fingerprint, taskId });
    this.schedulePersist();
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
    if (type === "task.terminal") {
      // Terminal is a durability boundary: flush so a restart cannot lose the
      // event that closes the task's evidence timeline.
      this.schedulePersist();
      this.flushSync();
    } else {
      this.schedulePersist();
    }
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
   * reached a terminal outcome. A null reason never rewrites an existing
   * reason on its own, so recovery re-projections of an unchanged status
   * append no duplicate business events.
   */
  setStatus(record: TaskRecord, status: UiStatus, reason: string | null): TaskEvent | null {
    if (isTerminalStatus(record.status)) {
      return null;
    }
    if (record.status === status && (reason === null || record.statusReason === reason)) {
      return null;
    }
    const previous = record.status;
    record.status = status;
    record.statusReason = reason;
    record.terminal = isTerminalStatus(status);
    return this.appendEvent(record, "task.status_changed", { from: previous, to: status, reason });
  }

  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as unknown;
    const migrated = migratePersistedState(raw);
    for (const serialized of migrated.tasks) {
      const record = deserializeTask(serialized);
      this.tasks.set(record.id, record);
    }
    for (const [key, entry] of Object.entries(migrated.idempotency)) {
      this.idempotency.set(key, entry);
    }
  }

  /** Coalesce mutations into one write per tick; text-delta storms stay cheap. */
  private schedulePersist(): void {
    if (!this.persistencePath) {
      return;
    }
    this.dirty = true;
    if (this.persistTimer !== null) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushSync();
    }, 25);
    this.persistTimer.unref?.();
  }

  /** Write the projection now if it is dirty; idempotent. */
  flushSync(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistencePath || !this.dirty) {
      return;
    }
    const state: PersistedState = {
      schema_version: CURRENT_SCHEMA_VERSION,
      tasks: [...this.tasks.values()].map(serializeTask),
      idempotency: Object.fromEntries(this.idempotency),
    };
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistencePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
    this.dirty = false;
  }
}

export interface TaskStoreOptions {
  /** A private durable projection file. Omit for a process-local store in tests. */
  persistencePath?: string;
}

interface CreateIdempotencyRecord {
  fingerprint: string;
  taskId: string;
}

/** The persisted shape is the record minus its live subscriber set. */
type PersistedTaskRecord = Omit<TaskRecord, "subscribers">;

interface PersistedState {
  schema_version: number;
  tasks: PersistedTaskRecord[];
  idempotency: Record<string, CreateIdempotencyRecord>;
}

const CURRENT_SCHEMA_VERSION = 1;

/** Version-0 was the unversioned M2 shape; migrate it before deserializing. */
function migratePersistedState(raw: unknown): PersistedState {
  if (raw === null || typeof raw !== "object") {
    throw new Error("task projection is not a JSON object");
  }
  const value = raw as Record<string, unknown>;
  const version = typeof value["schema_version"] === "number" ? value["schema_version"] : 0;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`task projection schema ${version} is newer than ${CURRENT_SCHEMA_VERSION}`);
  }
  const tasks = Array.isArray(value["tasks"]) ? (value["tasks"] as PersistedTaskRecord[]) : [];
  const idempotency =
    value["idempotency"] && typeof value["idempotency"] === "object"
      ? (value["idempotency"] as Record<string, CreateIdempotencyRecord>)
      : {};
  return { schema_version: CURRENT_SCHEMA_VERSION, tasks, idempotency };
}

function serializeTask(record: TaskRecord): PersistedTaskRecord {
  const { subscribers: _subscribers, ...serializable } = record;
  return structuredClone(serializable);
}

function deserializeTask(serialized: PersistedTaskRecord): TaskRecord {
  const record = serialized as TaskRecord;
  record.subscribers = new Set();
  record.headSha ??= null;
  record.approvalSnapshotHeadSha ??= null;
  record.governanceValid ??= true;
  record.mergeQueueEligible ??= false;
  record.artifactIndex ??= [];
  // A terminal status is terminal regardless of what a stale flag says; the
  // flag records whether the closing event exists. Derive it from the events
  // themselves: if they disagree (damaged or hand-migrated file), the
  // events win and recovery re-records the missing frame exactly once.
  record.terminal = record.terminal === true || isTerminalStatus(record.status);
  record.terminalEventRecorded = record.events.some((event) => event.type === "task.terminal");
  record.actionsInFlight = 0;
  return record;
}
