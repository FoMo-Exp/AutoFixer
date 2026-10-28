import type { Task, TaskEvent } from "../api/client";

/**
 * Whether this build renders `pi_summary.text`.
 *
 * The merged contract (0.5.0, DAT-193, main `5828f92`) defines the only
 * displayable source as the validated structured Pi report, with fixed
 * wording composed by Node. It also states that recorded history is never
 * rewritten, so a summary settled before DAT-193 can still be `available`
 * with arbitrary free-model text — the earlier boundary exposed
 * command-shaped text (`node app succeeded.`). `PiSummary` exposes no
 * provenance or schema-version discriminator, so a client cannot tell a
 * trusted report rendering from a legacy free-text summary, and text
 * inspection is explicitly not the trust boundary. Displaying on `status`
 * alone would therefore render unprovable content; deriving provenance from
 * the wording would fabricate it. This build fails closed and withholds
 * `text`, pending a contract field that positively identifies the source.
 */
export const PI_SUMMARY_TEXT_DISPLAY_ALLOWED = false;

export type PiSummaryState = "none" | "pending" | "available" | "unavailable";

export interface PiSummaryView {
  state: PiSummaryState;
  /** Contract reason for `unavailable`; unknown codes are preserved verbatim. */
  reason?: string;
  /** Only populated when text display is allowed. */
  text?: string;
  /** True when the server certified a summary but this build withholds its text. */
  withheld: boolean;
  runId: string | null;
  turnId: string | null;
  updatedAt?: string;
}

/** The subset of `PiSummary` this module reads; every field may be absent. */
interface SummaryPayload {
  task_id?: unknown;
  run_id?: unknown;
  turn_id?: unknown;
  status?: unknown;
  text?: unknown;
  unavailable_reason?: unknown;
  updated_at?: unknown;
}

/**
 * Read one summary candidate from a Task projection or a
 * `pi.summary.updated` event. Returns null unless the candidate is positively
 * attributable to the task's current run: a foreign `task_id`, a missing
 * identity (no `run_id`, or a task without `current_run_id`), and a previous
 * run all fail closed.
 */
function candidate(value: unknown, task: Task): SummaryPayload | null {
  if (value === null || typeof value !== "object") return null;
  const summary = value as SummaryPayload;
  if (summary.task_id !== task.id) return null;
  if (task.current_run_id === null) return null;
  if (typeof summary.run_id !== "string") return null;
  if (summary.run_id !== task.current_run_id) return null;
  return summary;
}

function project(value: SummaryPayload): PiSummaryView {
  const runId = typeof value.run_id === "string" ? value.run_id : null;
  const turnId = typeof value.turn_id === "string" ? value.turn_id : null;
  const updatedAt = typeof value.updated_at === "string" ? value.updated_at : undefined;
  const base = { withheld: false, runId, turnId, ...(updatedAt ? { updatedAt } : {}) };

  if (value.status === "pending") return { ...base, state: "pending" };
  if (value.status === "available") {
    // A contract-violating available summary without text is not displayable;
    // fail closed rather than inventing a state.
    if (typeof value.text !== "string" || value.text.trim() === "") {
      return { ...base, state: "unavailable", reason: "invalid_summary" };
    }
    return PI_SUMMARY_TEXT_DISPLAY_ALLOWED
      ? { ...base, state: "available", text: value.text }
      : { ...base, state: "available", withheld: true };
  }
  if (value.status === "unavailable") {
    return {
      ...base,
      state: "unavailable",
      ...(typeof value.unavailable_reason === "string" ? { reason: value.unavailable_reason } : {}),
    };
  }
  // Unknown status: the enum is additive, so render a plain unavailable state.
  return { ...base, state: "unavailable", reason: "unknown_status" };
}

/**
 * Resolve the summary for `task` from its projection plus the streamed
 * timeline.
 *
 * `Task.version` is the contract's monotonic task version, and every event
 * carries the `task_version` it produced. The projection at version V already
 * contains every event with `task_version <= V`, so a replayed or reordered
 * timeline must never overwrite it: only strictly newer events apply, and they
 * are applied in `sequence` order regardless of arrival order. Summaries of
 * other tasks and of previous runs never apply.
 */
export function resolvePiSummary(task: Task, events: TaskEvent[]): PiSummaryView {
  const projection = task.pi_summary === null ? null : candidate(task.pi_summary, task);
  let view: PiSummaryView = projection
    ? project(projection)
    : { state: "none", withheld: false, runId: null, turnId: null };

  const newer = events
    .filter(
      (event) =>
        event.type === "pi.summary.updated" &&
        event.task_id === task.id &&
        event.task_version > task.version,
    )
    .sort((left, right) => left.sequence - right.sequence);

  for (const event of newer) {
    const payload = candidate(event.data["summary"], task);
    if (payload) view = project(payload);
  }
  return view;
}

const REASON_LABELS: Record<string, string> = {
  no_content: "Pi produced no displayable text for this turn.",
  unsafe_content: "Pi output was withheld because it contained unsafe material.",
  undecidable: "Pi output could not be certified as safe to display.",
  gate_error: "The summary safety gate failed; no text is shown.",
  untrusted_source:
    "Pi produced no validated structured report for this turn, so there is no trustworthy text to show.",
};

export function piSummaryHeadline(view: PiSummaryView): string {
  switch (view.state) {
    case "none":
      return "No Pi summary yet.";
    case "pending":
      return "The current Pi turn has not settled yet.";
    case "available":
      return view.withheld
        ? "The summary has no client-verifiable provenance field, so this build withholds its text rather than render an unprovable source."
        : (view.text ?? "");
    case "unavailable":
      return (
        (view.reason !== undefined ? REASON_LABELS[view.reason] : undefined) ??
        "Pi summary is unavailable."
      );
  }
}

export function piSummaryStateLabel(view: PiSummaryView): string {
  switch (view.state) {
    case "none":
      return "No summary";
    case "pending":
      return "Pending";
    case "available":
      return view.withheld ? "Available · text withheld" : "Available";
    case "unavailable":
      return "Unavailable";
  }
}
