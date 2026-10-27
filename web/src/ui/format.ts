import type { TaskEvent, TaskStatus } from "../api/client";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  assessing_risk: "Assessing risk",
  awaiting_approval: "Approval needed",
  approved: "Approved",
  planning: "Planning",
  executing: "Executing",
  validating: "Validating",
  awaiting_review: "Awaiting review",
  approved_for_merge: "Merge-ready",
  stopped: "Stopped",
  rejected: "Rejected",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  expired: "Expired",
  merged: "Merged",
};

export const TERMINAL_STATUSES = new Set<TaskStatus>([
  "stopped",
  "rejected",
  "cancelled",
  "timed_out",
  "expired",
  "merged",
]);

export function formatStatus(status: TaskStatus): string {
  return STATUS_LABELS[status];
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortId(value: string | null | undefined, length = 10): string {
  if (!value) return "—";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function progressPercent(completed: number, total: number | null): number | undefined {
  if (!total || total <= 0) return undefined;
  return Math.min(100, Math.round((completed / total) * 100));
}

const EVENT_LABELS: Record<TaskEvent["type"], string> = {
  "task.status_changed": "Status updated",
  "pi.text_delta": "Pi text (withheld)",
  "pi.turn_settled": "Pi turn settled",
  "pi.summary.updated": "Pi summary updated",
  "plan.updated": "Plan updated",
  "approval.required": "Approval requested",
  "approval.resolved": "Approval recorded",
  "tool.requested": "Action requested",
  "tool.completed": "Action completed",
  "tool.denied": "Action denied",
  "validation.completed": "Validation completed",
  "artifact.available": "Artifact available",
  "evidence.appended": "Evidence recorded",
  "task.terminal": "Task finished",
};

export function eventLabel(type: TaskEvent["type"]): string {
  return EVENT_LABELS[type];
}

export function eventSummary(event: TaskEvent): string {
  const data = event.data;
  if (event.type === "task.status_changed") {
    const status = data["to"] ?? data["status"];
    return typeof status === "string"
      ? `Task moved to ${status.replaceAll("_", " ")}.`
      : "Task status changed.";
  }
  if (event.type === "approval.required")
    return "A human decision is required before the run can proceed.";
  if (event.type === "approval.resolved") {
    const decision = data["decision"];
    return typeof decision === "string"
      ? `Approval decision: ${decision}.`
      : "Approval decision recorded.";
  }
  if (event.type === "pi.summary.updated") {
    const summary = data["summary"] as { status?: unknown; unavailable_reason?: unknown } | null;
    if (summary?.status === "available") return "Pi published a certified summary for this turn.";
    if (summary?.status === "unavailable") {
      return typeof summary.unavailable_reason === "string"
        ? `Pi summary unavailable (${summary.unavailable_reason}).`
        : "Pi summary unavailable.";
    }
    if (summary?.status === "pending") return "Pi summary is pending for the current turn.";
    return "Pi summary updated.";
  }
  if (event.type === "tool.denied") return "An action was denied by the task policy.";
  if (event.type === "tool.completed") return "A policy-approved action completed.";
  if (event.type === "validation.completed") return "Validation results were recorded.";
  if (event.type === "artifact.available") return "A redacted artifact is ready to browse.";
  if (event.type === "task.terminal") return "The authoritative run reached a terminal outcome.";
  return `${eventLabel(event.type)} recorded.`;
}

export interface PiTurnRow {
  kind: "pi_turn";
  key: string;
  startedAt: string;
  endedAt: string;
  updates: number;
  settled: boolean;
}

export interface TimelineEventRow {
  kind: "event";
  key: string;
  event: TaskEvent;
}

export type TimelineRow = TimelineEventRow | PiTurnRow;

/**
 * Group consecutive Pi text deltas into one turn row and absorb the settling
 * marker into it. Every other event keeps its own row, so actions, approvals,
 * and status changes stay between the Pi turns that actually produced them.
 */
export function buildTimelineRows(events: TaskEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let turn: PiTurnRow | undefined;
  for (const event of events) {
    if (event.type === "pi.text_delta") {
      if (!turn) {
        turn = {
          kind: "pi_turn",
          key: `pi_turn:${event.event_id}`,
          startedAt: event.occurred_at,
          endedAt: event.occurred_at,
          updates: 0,
          settled: false,
        };
        rows.push(turn);
      }
      turn.updates += 1;
      turn.endedAt = event.occurred_at;
      continue;
    }
    if (event.type === "pi.turn_settled" && turn) {
      turn.settled = true;
      turn.endedAt = event.occurred_at;
      continue;
    }
    turn = undefined;
    rows.push({ kind: "event", key: event.event_id, event });
  }
  return rows;
}

export function piTurnSummary(row: PiTurnRow): string {
  const updates = `${row.updates} Pi text ${row.updates === 1 ? "update" : "updates"}`;
  const state = row.settled ? "turn settled" : "turn in progress";
  return `${updates} · ${state} · text withheld`;
}

export function approvalScopeDigest(events: TaskEvent[], taskId: string): string | undefined {
  const approval = [...events]
    .reverse()
    .find((event) => event.task_id === taskId && event.type === "approval.required");
  const digest = approval?.data["scope_digest"];
  return typeof digest === "string" ? digest : undefined;
}
