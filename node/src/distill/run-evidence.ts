/**
 * Authoritative dsh run evidence → outcome envelope (DAT-264).
 *
 * DAT-233 defined the envelope and the capture write; this module is the only
 * producer that turns a *real* terminal dsh run into one. Nothing here is
 * inferred from a Node-side projection or from agent self-report:
 *
 * - the terminal state comes from `GET /v1/runs/{id}`,
 * - the delivery facts come from that run's finalized `patch_report`,
 * - the terminal stop/decision code comes from the run's append-only event
 *   chain (`GET /v1/runs/{id}/events`),
 * - validation attempts come from the patch report, not from model output.
 *
 * A run that is not terminal, lacks its patch report, or whose latest
 * transition does not match the reported state is **not capturable**. The
 * builder refuses instead of inventing a delivery or a success: a missing
 * `merged` patch record never becomes `accepted`, and a rejection or
 * cancellation without a recorded code never becomes a "reason".
 */

import type { DshEventsResponse, DshPatchReportSummary, DshRunResponse } from "../dsh/types.js";
import {
  OUTCOME_ENVELOPE_CONTRACT_VERSION,
  OUTCOME_EVIDENCE_MAX,
  OUTCOME_VALIDATION_MAX,
} from "./types.js";
import type {
  FailureCause,
  OutcomeEnvelopeInput,
  OutcomeEvidenceRef,
  OutcomeValidationEvidence,
  StopDisposition,
  TerminalState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Bounded evidence source
// ---------------------------------------------------------------------------

/**
 * The two authoritative reads capture needs. `DshClient` satisfies this
 * structurally; tests bind a real local dsh or a narrow fake.
 */
export interface RunEvidenceSource {
  getRun(runId: string): Promise<DshRunResponse>;
  getEvents(runId: string, afterSequence?: number, limit?: number): Promise<DshEventsResponse>;
}

/** Page cap for one run's evidence chain: 50 × 100 events. */
export const RUN_EVENTS_MAX_PAGES = 50;
const RUN_EVENTS_PAGE = 100;

/** dsh states that end a run for capture purposes (harness terminal + stopped). */
const CAPTURE_TERMINAL_STATES: Readonly<Record<string, true>> = {
  stopped: true,
  timed_out: true,
  expired: true,
  rejected: true,
  cancelled: true,
  merged: true,
};

export function isCaptureTerminalState(state: string): boolean {
  return CAPTURE_TERMINAL_STATES[state] === true;
}

/**
 * Raised when a run cannot truthfully become an outcome envelope. The code is
 * a stable machine token the scheduler stores on the job; it is never a
 * success and never a fabricated fallback outcome.
 */
export class CaptureEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CaptureEvidenceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

export interface TerminalRunEvidence {
  run: DshRunResponse;
  events: Array<Record<string, unknown>>;
}

/**
 * Read one run's authoritative terminal state and its complete event chain.
 * Non-terminal runs are refused with `RUN_NOT_TERMINAL`; an evidence chain
 * longer than the page bound is refused rather than truncated.
 */
export async function readTerminalRunEvidence(
  dsh: RunEvidenceSource,
  runId: string,
): Promise<TerminalRunEvidence> {
  const run = await dsh.getRun(runId);
  if (!isCaptureTerminalState(run.state)) {
    throw new CaptureEvidenceError(
      "RUN_NOT_TERMINAL",
      `run ${runId} is ${run.state}; capture requires a terminal dsh state`,
    );
  }
  const events: Array<Record<string, unknown>> = [];
  let after = 0;
  for (let page = 0; page < RUN_EVENTS_MAX_PAGES; page += 1) {
    const batch = await dsh.getEvents(runId, after, RUN_EVENTS_PAGE);
    events.push(...batch.events);
    if (!batch.has_more) {
      return { run, events };
    }
    if (batch.next_after_sequence <= after) {
      throw new CaptureEvidenceError(
        "EVIDENCE_CURSOR_INCOMPLETE",
        `run ${runId} event cursor did not advance`,
      );
    }
    after = batch.next_after_sequence;
  }
  throw new CaptureEvidenceError(
    "EVIDENCE_UNBOUNDED",
    `run ${runId} evidence chain exceeds ${RUN_EVENTS_MAX_PAGES * RUN_EVENTS_PAGE} events`,
  );
}

// ---------------------------------------------------------------------------
// Terminal code classification
// ---------------------------------------------------------------------------

/**
 * Decisions that stop a run because it left the grant or attempted a
 * prohibited operation. They are policy denials, not tool failures.
 */
const POLICY_DENIAL_CODES: Readonly<Record<string, true>> = {
  stop_out_of_grant: true,
  path_escape_denied: true,
  symlink_escape_denied: true,
  prohibited_path_denied: true,
  edit_scope_denied: true,
  overprivileged_request_denied: true,
  grant_scope_exceeded: true,
};

/** Stop codes proving the execution hit a granted resource limit. */
const RESOURCE_LIMIT_CODES: Readonly<Record<string, true>> = {
  execution_resource_limit_exceeded: true,
};

/**
 * Stop codes proving the control plane lost enforcement or supervision. These
 * stay `infra_failure`: episode-only, never a lesson.
 */
const INFRA_FAILURE_CODES: Readonly<Record<string, true>> = {
  execution_limit_unenforceable: true,
  execution_supervision_unavailable: true,
  execution_descendants_survived: true,
  stop_audit_failure: true,
};

/** The one code that names an execution-side failure. */
const EXECUTION_FAILURE_CODE = "stop_execution_failure";

export interface StopClassification {
  stop_disposition: StopDisposition;
  failure_cause: FailureCause | null;
}

/**
 * Map an authoritative stop/decision code to the envelope's disposition and
 * failure cause. An unrecognized code is `unknown`, never an invented failure
 * class and never success; `timeout` and `infra_failure` are never learnable.
 */
export function classifyStopCode(code: string | null): StopClassification {
  if (code === null) {
    return { stop_disposition: "unknown", failure_cause: null };
  }
  // Harness `deny_*` decisions are policy denials too: they are recorded on
  // the refusing event even when the run stops without a `stop_*` code.
  if (POLICY_DENIAL_CODES[code] === true || code.startsWith("deny_")) {
    return { stop_disposition: "failed", failure_cause: "policy_denied" };
  }
  if (code === EXECUTION_FAILURE_CODE) {
    return { stop_disposition: "failed", failure_cause: "tool_failure" };
  }
  if (RESOURCE_LIMIT_CODES[code] === true) {
    return { stop_disposition: "failed", failure_cause: "resource_limit" };
  }
  if (INFRA_FAILURE_CODES[code] === true) {
    return { stop_disposition: "infra_failure", failure_cause: null };
  }
  // `stop_local_review_required`, `execution_cancelled`, provider-specific
  // codes, and anything the contract does not classify: a human disposition
  // is still pending, so this is unknown rather than a fabricated failure.
  return { stop_disposition: "unknown", failure_cause: null };
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

interface TerminalTransition {
  sequence: number;
  decision_or_stop_code: string | null;
}

/**
 * Find the last state transition and prove it ends in the run's reported
 * state. A mismatch means the run moved between the two reads (or the chain is
 * damaged); capture must retry, never record the older snapshot as final.
 */
function terminalTransition(
  run: DshRunResponse,
  events: Array<Record<string, unknown>>,
): TerminalTransition & { resulting_state: string } {
  // Tool-invocation events may trail the transition that ended the run, so
  // the authority is the *last* state transition, not the last event.
  let last: (TerminalTransition & { resulting_state: string }) | null = null;
  for (const event of events) {
    if (event["event_type"] !== "state_transition") {
      continue;
    }
    const resulting = event["resulting_state"];
    const sequence = event["sequence"];
    if (typeof sequence !== "number" || !Number.isInteger(sequence)) {
      throw new CaptureEvidenceError(
        "EVIDENCE_MALFORMED",
        `run ${run.run_id} carries a state transition without a numeric sequence`,
      );
    }
    if (typeof resulting !== "string") {
      throw new CaptureEvidenceError(
        "EVIDENCE_MALFORMED",
        `run ${run.run_id} carries a state transition without a resulting state`,
      );
    }
    const code = event["decision_or_stop_code"];
    last = {
      sequence,
      resulting_state: resulting,
      decision_or_stop_code: typeof code === "string" && code.length > 0 ? code : null,
    };
  }
  if (last === null) {
    throw new CaptureEvidenceError(
      "TERMINAL_EVENT_MISSING",
      `run ${run.run_id} has no state transition evidence`,
    );
  }
  if (last.resulting_state !== run.state) {
    // The chain reports a later transition than the run read. Either the read
    // is stale or the run is mid-transition; retrying is the only truthful
    // answer.
    throw new CaptureEvidenceError(
      "TERMINAL_EVENT_MISMATCH",
      `run ${run.run_id} newest transition is ${last.resulting_state}, run reports ${run.state}`,
    );
  }
  return last;
}

function requirePatchReport(run: DshRunResponse): DshPatchReportSummary {
  const patch = run.patch_report;
  if (patch === null) {
    throw new CaptureEvidenceError(
      "PATCH_REPORT_MISSING",
      `run ${run.run_id} is ${run.state} but carries no finalized patch report`,
    );
  }
  return patch;
}

const PATCH_STATUS_VALUES: Readonly<Record<string, true>> = {
  not_created: true,
  prepared_no_pr: true,
  proposed: true,
  merged: true,
};

function deliveryValidation(patch: DshPatchReportSummary): OutcomeValidationEvidence[] {
  const attempts = patch.validation ?? [];
  if (attempts.length > OUTCOME_VALIDATION_MAX) {
    throw new CaptureEvidenceError(
      "DELIVERY_TOO_LARGE",
      `patch report carries more than ${OUTCOME_VALIDATION_MAX} validation attempts`,
    );
  }
  return attempts.map((attempt) => {
    if (typeof attempt.tool !== "string" || attempt.tool.length === 0) {
      throw new CaptureEvidenceError("EVIDENCE_MALFORMED", "validation attempt has no tool");
    }
    if (typeof attempt.event_reference !== "string" || attempt.event_reference.length === 0) {
      throw new CaptureEvidenceError(
        "EVIDENCE_MALFORMED",
        "validation attempt has no event reference",
      );
    }
    const exit = attempt.exit_status;
    if (exit !== null && exit !== undefined && !Number.isInteger(exit)) {
      throw new CaptureEvidenceError(
        "EVIDENCE_MALFORMED",
        "validation exit status is not an integer",
      );
    }
    return {
      tool: attempt.tool,
      exit_status: exit ?? null,
      event_reference: attempt.event_reference,
    };
  });
}

/**
 * Build the DAT-233 outcome envelope from one terminal dsh run. The result is
 * deliberately *untrusted input* to `parseOutcomeEnvelope`, which re-checks
 * every closed vocabulary and cross-field rule; this function only refuses
 * evidence gaps its caller must not paper over.
 */
export function buildOutcomeEnvelope(evidence: TerminalRunEvidence): OutcomeEnvelopeInput {
  const { run, events } = evidence;
  if (!isCaptureTerminalState(run.state)) {
    throw new CaptureEvidenceError(
      "RUN_NOT_TERMINAL",
      `run ${run.run_id} is ${run.state}; capture requires a terminal dsh state`,
    );
  }
  const transition = terminalTransition(run, events);
  const code = transition.decision_or_stop_code;
  const patch = requirePatchReport(run);

  const patchStatus = patch.patch_status;
  if (typeof patchStatus !== "string" || PATCH_STATUS_VALUES[patchStatus] !== true) {
    throw new CaptureEvidenceError(
      "PATCH_REPORT_INCOMPLETE",
      `run ${run.run_id} patch report has no valid patch_status`,
    );
  }
  if (run.state === "merged" && patchStatus !== "merged") {
    // A merged run whose delivery record says no patch exists is contradictory
    // evidence. It must never be captured as `accepted`.
    throw new CaptureEvidenceError(
      "MERGED_WITHOUT_DELIVERY",
      `run ${run.run_id} is merged but its patch report is ${patchStatus}`,
    );
  }
  if (typeof patch.change_summary !== "string" || patch.change_summary.trim().length === 0) {
    throw new CaptureEvidenceError(
      "PATCH_REPORT_INCOMPLETE",
      `run ${run.run_id} patch report has no change summary`,
    );
  }

  const terminalState = run.state as TerminalState;
  let stopDisposition: StopDisposition | null = null;
  let failureCause: FailureCause | null = null;
  let reason: string | null = null;

  if (terminalState === "stopped") {
    const classified = classifyStopCode(code);
    stopDisposition = classified.stop_disposition;
    failureCause = classified.failure_cause;
  } else if (terminalState === "rejected" || terminalState === "cancelled") {
    // DAT-233 requires a recorded reason. The terminal event's decision code
    // is the only recorded reason the evidence chain carries; without it the
    // outcome is not capturable.
    if (code === null) {
      throw new CaptureEvidenceError(
        "TERMINAL_REASON_MISSING",
        `run ${run.run_id} is ${terminalState} without a recorded decision or stop code`,
      );
    }
    reason = code;
  }

  const evidenceRefs: OutcomeEvidenceRef[] = [];
  for (const reference of patch.evidence_references ?? []) {
    if (typeof reference !== "string" || reference.length === 0) {
      throw new CaptureEvidenceError(
        "EVIDENCE_MALFORMED",
        `run ${run.run_id} patch report carries an empty evidence reference`,
      );
    }
    // Patch-report evidence points into this run's retained evidence chain.
    // Approval snapshots are deliberately not mapped to reviewer_decision:
    // the local control plane records "no PR was observed", which must never
    // support an approval claim.
    evidenceRefs.push({ evidence_type: "run", reference });
  }
  if (evidenceRefs.length > OUTCOME_EVIDENCE_MAX) {
    throw new CaptureEvidenceError(
      "EVIDENCE_TOO_LARGE",
      `run ${run.run_id} carries more than ${OUTCOME_EVIDENCE_MAX} evidence references`,
    );
  }

  return {
    contract_version: OUTCOME_ENVELOPE_CONTRACT_VERSION,
    task_id: run.task_id,
    run_id: run.run_id,
    issue_id: run.issue_id,
    terminal_state: terminalState,
    stop_disposition: stopDisposition,
    failure_cause: failureCause,
    reason,
    delivery: {
      patch_status: patchStatus as OutcomeEnvelopeInput["delivery"]["patch_status"],
      head_sha: patch.head_sha ?? null,
      pr_id: patch.pr_id ?? null,
      change_summary: patch.change_summary,
      validation: deliveryValidation(patch),
    },
    evidence: dedupeEvidence(evidenceRefs),
  };
}

function dedupeEvidence(refs: OutcomeEvidenceRef[]): OutcomeEvidenceRef[] {
  const seen = new Set<string>();
  const unique: OutcomeEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.evidence_type}\u0000${ref.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}
