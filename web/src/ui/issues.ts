import type { IssueEvent, IssueRunState, IssueTaskState, ProductState } from "../api/client";

/**
 * Product lifecycle stages (ADR-0007) are a different axis from the observed
 * harness (FP-01) run states. Nothing here maps one onto the other: the
 * workbench renders both, labelled, and never derives a product stage from a
 * run state or a run state from a product stage.
 */

export const PRODUCT_STATE_LABELS: Record<ProductState, string> = {
  triage: "Triage",
  planning: "Planning",
  implementing: "Implementing",
  validating: "Validating",
  awaiting_change_approval: "Awaiting change approval",
  delivering: "Delivering",
  pr_review: "PR review",
  completed: "Completed",
  needs_human: "Needs human disposition",
  cancelled: "Cancelled",
};

export const PRODUCT_STATE_DESCRIPTIONS: Record<ProductState, string> = {
  triage: "Signal collected; the workspace has not routed bounded work yet.",
  planning: "A bounded plan is being produced for this issue.",
  implementing: "A bounded run is preparing a local change.",
  validating: "The candidate revision is being validated.",
  awaiting_change_approval:
    "A frozen candidate awaits a human change approval. No remote branch or PR exists at this stage.",
  delivering: "An approved candidate is with the delivery broker.",
  pr_review: "The pushed change is under the repository's own review and checks.",
  completed: "Terminal: the change has a provider-confirmed merge.",
  needs_human: "Terminal until a human records a disposition for this stop.",
  cancelled: "Terminal: this issue accepts no further stage transitions.",
};

export const HARNESS_STATE_LABELS: Record<IssueRunState, string> = {
  requested: "Requested",
  approved: "Approved",
  running: "Running",
  awaiting_review: "Awaiting review",
  approved_for_merge: "Approved for merge",
  stopped: "Stopped",
  timed_out: "Timed out",
  expired: "Expired",
  rejected: "Rejected",
  cancelled: "Cancelled",
  merged: "Merged",
};

export const ISSUE_TASK_STATE_LABELS: Record<IssueTaskState, string> = {
  open: "Open",
  active: "Active",
  done: "Done",
  cancelled: "Cancelled",
};

const TERMINAL_PRODUCT_STATE: Record<string, true> = {
  completed: true,
  cancelled: true,
};

/** Outcome states after which a run never resumes and its grant is over. */
const NON_RESUMABLE_RUN_STATE: Record<string, true> = {
  stopped: true,
  timed_out: true,
  expired: true,
  rejected: true,
  cancelled: true,
  merged: true,
};

export const HARNESS_STATE_NOTE =
  "Harness states below are observed from dsh for one bounded run; they are not product stages.";

export function productStateLabel(state: string): string {
  return PRODUCT_STATE_LABELS[state as ProductState] ?? `Unknown product stage (${state})`;
}

export function productStateDescription(state: string): string {
  return (
    PRODUCT_STATE_DESCRIPTIONS[state as ProductState] ??
    "The service reported a product stage this build does not recognise. Nothing is inferred from it."
  );
}

export function isTerminalProductState(state: string): boolean {
  return TERMINAL_PRODUCT_STATE[state] === true;
}

export function isKnownProductState(state: string): boolean {
  return Object.hasOwn(PRODUCT_STATE_LABELS, state);
}

export function harnessStateLabel(state: string): string {
  return HARNESS_STATE_LABELS[state as IssueRunState] ?? `Unknown harness state (${state})`;
}

export function isKnownHarnessState(state: string): boolean {
  return Object.hasOwn(HARNESS_STATE_LABELS, state);
}

export function issueTaskStateLabel(state: string): string {
  return ISSUE_TASK_STATE_LABELS[state as IssueTaskState] ?? `Unknown task state (${state})`;
}

export function isTerminalTaskState(state: string): boolean {
  return state === "done" || state === "cancelled";
}

/** A stop or cancellation records why; the service requires the reason. */
export function stageChangeNeedsReason(to: string): boolean {
  return to === "needs_human" || to === "cancelled";
}

/** Leaving `needs_human` requires a recorded human disposition reference. */
export function stageChangeNeedsDisposition(from: string): boolean {
  return from === "needs_human";
}

/** Terminal run outcomes that require a human disposition before new work. */
export function runRequiresDisposition(state: string): boolean {
  return NON_RESUMABLE_RUN_STATE[state] === true && state !== "merged";
}

const PRODUCT_STAGE_TONE: Record<string, string> = {
  triage: "neutral",
  planning: "active",
  implementing: "active",
  validating: "active",
  awaiting_change_approval: "attention",
  delivering: "active",
  pr_review: "attention",
  completed: "done",
  needs_human: "attention",
  cancelled: "muted",
};

const HARNESS_STATE_TONE: Record<string, string> = {
  requested: "neutral",
  approved: "active",
  running: "active",
  awaiting_review: "attention",
  approved_for_merge: "attention",
  stopped: "danger",
  timed_out: "danger",
  expired: "muted",
  rejected: "danger",
  cancelled: "muted",
  merged: "done",
};

export function productStageTone(state: string): string {
  return PRODUCT_STAGE_TONE[state] ?? "unknown";
}

export function harnessStateTone(state: string): string {
  return HARNESS_STATE_TONE[state] ?? "unknown";
}

const ISSUE_EVENT_LABELS: Record<IssueEvent["type"], string> = {
  "issue.created": "Issue created",
  "issue.stage_changed": "Stage changed",
  "issue.terminal": "Issue terminal",
  "task.created": "Task added",
  "task.state_changed": "Task state changed",
  "run.opened": "Run opened",
  "run.state_changed": "Run state changed",
  "run.grant_recorded": "Grant recorded",
  "run.grant_revoked": "Grant revoked",
  "run.artifact_attached": "Artifact attached",
  "candidate.frozen": "Candidate frozen",
  "approval.requested": "Approval requested",
  "approval.decided": "Approval decided",
  "approval.invalidated": "Approval invalidated",
  "delivery.requested": "Delivery requested",
  "delivery.state_changed": "Delivery state changed",
  "delivery.reconciled": "Delivery reconciled",
  "operation.denied": "Operation denied",
};

export function issueEventLabel(type: string): string {
  return ISSUE_EVENT_LABELS[type as IssueEvent["type"]] ?? `Unrecognized event (${type})`;
}

export function isKnownIssueEvent(type: string): boolean {
  return Object.hasOwn(ISSUE_EVENT_LABELS, type);
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * One-line, data-backed event summary. Only fields the issue-event contract
 * documents are read; an unrecognised event or payload renders explicitly as
 * unknown instead of a guessed sentence.
 */
export function issueEventSummary(event: IssueEvent): string {
  const data = event.data;
  if (event.type === "issue.stage_changed") {
    const from = stringField(data, "from");
    const to = stringField(data, "to");
    const reason = stringField(data, "reason");
    if (from && to) {
      const base = `Product stage moved from ${productStateLabel(from)} to ${productStateLabel(to)}.`;
      return reason ? `${base} Reason: ${reason}` : base;
    }
  }
  if (event.type === "issue.created") {
    const state = stringField(data, "product_state");
    return state ? `Issue recorded in ${productStateLabel(state)}.` : "Issue recorded.";
  }
  if (event.type === "issue.terminal") {
    const state = stringField(data, "product_state");
    return state
      ? `Issue reached the terminal stage ${productStateLabel(state)}.`
      : "Issue reached a terminal stage.";
  }
  if (event.type === "task.created" || event.type === "task.state_changed") {
    const taskId = stringField(data, "task_id");
    const state = stringField(data, "state");
    const role = stringField(data, "role");
    if (taskId && state) {
      return `Task ${taskId}${role ? ` (${role})` : ""} is ${issueTaskStateLabel(state)}.`;
    }
  }
  if (event.type === "run.opened" || event.type === "run.state_changed") {
    const runId = stringField(data, "run_id");
    const state = stringField(data, "state");
    const stopReason = stringField(data, "stop_reason");
    if (runId && state) {
      const base = `Run ${runId} is ${harnessStateLabel(state)}.`;
      return stopReason ? `${base} Stop reason: ${stopReason}` : base;
    }
  }
  if (event.type === "run.grant_recorded" || event.type === "run.grant_revoked") {
    const grantId = stringField(data, "grant_id");
    const state = stringField(data, "state");
    if (grantId) return `Grant ${grantId}${state ? ` is ${state}` : " changed"}.`;
  }
  if (event.type === "run.artifact_attached") {
    const artifactId = stringField(data, "artifact_id");
    const kind = stringField(data, "kind");
    if (artifactId) return `${kind ?? "Artifact"} ${artifactId} attached to the run.`;
  }
  if (event.type === "operation.denied") {
    const operationId = stringField(data, "operation_id");
    const errorCode = stringField(data, "error_code");
    return `Operation ${operationId ?? "unknown"} denied${errorCode ? ` (${errorCode})` : ""}.`;
  }
  if (isKnownIssueEvent(event.type)) return `${issueEventLabel(event.type)} recorded.`;
  return `Unrecognized event type ${event.type}. The workbench cannot summarise it.`;
}
