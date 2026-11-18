/**
 * Provider-observed delivery merge → outcome envelope (DAT-266).
 *
 * A remediation ends with the human merging the delivered pull request. That
 * merge is never a dsh state: dsh finalized the local preparation as
 * `prepared_no_pr` and cannot see the provider. The merge is nevertheless an
 * authoritative delivery fact, so this module reads it back from the delivery
 * provider and binds it to the exact records the product already owns:
 *
 * - the delivery record (branch, PR id/url, target branch, exact head),
 * - its candidate (run, scope, head, retained validation attempts),
 * - the human approval that authorized that head and was consumed by this
 *   delivery,
 * - a live provider read whose `state` is `merged` at that same head.
 *
 * Every identity must agree. An open/closed PR, a moved head, a different PR,
 * a different base, an unapproved candidate, or an unreadable provider is
 * refused with a stable code — never captured as a success. `unknown` never
 * becomes `accepted`.
 *
 * The produced shape is an untrusted `OutcomeEnvelopeInput`: `captureOutcome`
 * re-parses and re-checks it, and evidence references are limited to the
 * candidate's own retained event references plus the consumed approval.
 */

import type { DeliveryProvider } from "../collab/delivery-broker.js";
import { autofixerBranchFor } from "../collab/types.js";
import type { CandidateRecord, DeliveryRecord } from "../collab/types.js";
import type { CollabMachine } from "../collab/machine.js";
import {
  OUTCOME_CHANGE_SUMMARY_MAX,
  OUTCOME_ENVELOPE_CONTRACT_VERSION,
  OUTCOME_EVIDENCE_MAX,
  OUTCOME_REFERENCE_MAX,
  OUTCOME_TOOL_MAX,
  OUTCOME_VALIDATION_MAX,
} from "./types.js";
import type {
  OutcomeEnvelopeInput,
  OutcomeEvidenceRef,
  OutcomeValidationEvidence,
} from "./types.js";
import { CaptureEvidenceError } from "./run-evidence.js";

/** The provider read the merge path needs; only the read member is used. */
export type DeliveryProviderLookup = (
  provider: "github" | "gitlab",
) => DeliveryProvider | undefined;

/**
 * One delivery's verified terminal evidence. The workspace/task/run come from
 * the durable product records, never from the provider response, so a job can
 * be checked against its persisted scope before anything is written.
 */
export interface DeliveryOutcomeEvidence {
  envelope: OutcomeEnvelopeInput;
  enterprise_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
}

function refuse(code: string, message: string): never {
  throw new CaptureEvidenceError(code, message);
}

function boundedReference(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    refuse("DELIVERY_EVIDENCE_INCOMPLETE", `${field} is empty`);
  }
  if (value.length > OUTCOME_REFERENCE_MAX) {
    refuse("DELIVERY_EVIDENCE_INCOMPLETE", `${field} is longer than the evidence bound`);
  }
  return value;
}

function validationOf(
  candidate: CandidateRecord,
  delivery: DeliveryRecord,
): OutcomeValidationEvidence[] {
  const results = candidate.validation.results;
  if (!Array.isArray(results) || results.length === 0) {
    // A merge with no retained validation evidence cannot support "the tests
    // passed", so it must not become a positive lesson.
    refuse(
      "DELIVERY_VALIDATION_MISSING",
      `delivery ${delivery.delivery_id} has no validation evidence`,
    );
  }
  if (results.length > OUTCOME_VALIDATION_MAX) {
    refuse(
      "DELIVERY_TOO_LARGE",
      `delivery ${delivery.delivery_id} has too many validation attempts`,
    );
  }
  return results.map((result) => {
    if (typeof result.tool !== "string" || result.tool.trim().length === 0) {
      refuse("DELIVERY_EVIDENCE_INCOMPLETE", "validation attempt has no tool");
    }
    if (result.tool.length > OUTCOME_TOOL_MAX) {
      refuse("DELIVERY_EVIDENCE_INCOMPLETE", "validation tool identity is too long");
    }
    const exit = result.exit_status;
    if (exit !== null && !Number.isInteger(exit)) {
      refuse("DELIVERY_EVIDENCE_INCOMPLETE", "validation exit status is not an integer");
    }
    return {
      tool: result.tool,
      exit_status: exit,
      event_reference: boundedReference(result.event_reference, "validation event_reference"),
    };
  });
}

/**
 * Read one delivery's merge evidence and build the envelope. Throws a
 * {@link CaptureEvidenceError} when the merge cannot be proven; the capture
 * outbox records the code and never treats the attempt as a success.
 */
export async function readDeliveryOutcome(
  machine: CollabMachine,
  providerFor: DeliveryProviderLookup,
  deliveryId: string,
): Promise<DeliveryOutcomeEvidence> {
  const delivery = machine.getDelivery(deliveryId);
  if (delivery === undefined) {
    refuse("DELIVERY_NOT_FOUND", `delivery ${deliveryId} is not recorded`);
  }
  // Only a delivery whose provider write completed has a PR identity at all.
  if (delivery.state !== "delivered" || delivery.pr_id === null || delivery.pr_url === null) {
    refuse(
      "DELIVERY_NOT_DELIVERED",
      `delivery ${delivery.delivery_id} is ${delivery.state} with no delivered PR`,
    );
  }
  const candidate = machine.getCandidate(delivery.candidate_id);
  if (candidate === undefined) {
    refuse(
      "DELIVERY_CANDIDATE_MISSING",
      `delivery ${delivery.delivery_id} has no candidate record`,
    );
  }
  if (candidate.invalidated_at !== null) {
    refuse("CANDIDATE_INVALIDATED", `candidate ${candidate.candidate_id} was invalidated`);
  }
  if (candidate.head_sha !== delivery.head_sha) {
    refuse(
      "DELIVERY_HEAD_MISMATCH",
      `delivery ${delivery.delivery_id} does not carry its candidate head`,
    );
  }
  const run = machine.getRun(candidate.run_id);
  if (run === undefined || run.task_id === null) {
    refuse("TASK_LINK_MISSING", `candidate ${candidate.candidate_id} has no task-bound run`);
  }
  const approval = machine.getApproval(delivery.approval_id);
  if (approval === undefined) {
    refuse("DELIVERY_APPROVAL_MISSING", `delivery ${delivery.delivery_id} has no approval record`);
  }
  if (
    approval.consumed_by_delivery_id !== delivery.delivery_id ||
    approval.binding.head_sha !== delivery.head_sha ||
    approval.approver === null
  ) {
    refuse(
      "DELIVERY_APPROVAL_MISMATCH",
      `approval ${approval.approval_id} did not authorize this delivery head`,
    );
  }

  const provider = providerFor(delivery.provider);
  if (provider === undefined) {
    // No readable provider means the merge is unknown; it is retryable, not a
    // failure and never a success.
    refuse(
      "DELIVERY_PROVIDER_UNAVAILABLE",
      `no ${delivery.provider} provider is configured to observe the merge`,
    );
  }
  const branch = delivery.branch ?? autofixerBranchFor(delivery.issue_id);
  let observed;
  try {
    observed = await provider.findPullRequest(
      delivery.repository,
      branch,
      delivery.head_sha,
      delivery.target_branch,
    );
  } catch {
    // A refused read or an outage is unknown. The provider error message can
    // carry provider text, so only the stable code is used.
    refuse("DELIVERY_PROVIDER_UNAVAILABLE", `the ${delivery.provider} merge could not be read`);
  }
  if (observed === null) {
    refuse("PR_NOT_OBSERVED", `delivery ${delivery.delivery_id} has no observable pull request`);
  }
  if (observed.state !== "merged") {
    refuse(
      "PR_NOT_MERGED",
      `delivery ${delivery.delivery_id} pull request is ${observed.state}, not merged`,
    );
  }
  if (
    observed.pr_id !== delivery.pr_id ||
    observed.head_sha !== delivery.head_sha ||
    observed.branch !== branch ||
    observed.base_ref !== delivery.target_branch
  ) {
    refuse(
      "PR_IDENTITY_MISMATCH",
      `delivery ${delivery.delivery_id} pull request does not match the delivered identity`,
    );
  }

  if (candidate.summary.trim().length === 0) {
    refuse("DELIVERY_EVIDENCE_INCOMPLETE", "candidate has no change summary");
  }
  if (candidate.summary.length > OUTCOME_CHANGE_SUMMARY_MAX) {
    refuse("DELIVERY_EVIDENCE_INCOMPLETE", "candidate change summary is too long");
  }

  const evidence: OutcomeEvidenceRef[] = [
    // A named human approved this exact head before it was delivered; the
    // reference is the approval record, not provider text.
    { evidence_type: "reviewer_decision", reference: `approval:${approval.approval_id}` },
  ];
  for (const reference of candidate.audit_refs) {
    if (evidence.length >= OUTCOME_EVIDENCE_MAX) {
      break;
    }
    if (typeof reference === "string" && reference.trim().length > 0) {
      evidence.push({ evidence_type: "run", reference });
    }
  }

  return {
    enterprise_id: candidate.workspace.enterprise_id,
    workspace_id: candidate.workspace.workspace_id,
    task_id: run.task_id,
    run_id: candidate.run_id,
    envelope: {
      contract_version: OUTCOME_ENVELOPE_CONTRACT_VERSION,
      task_id: run.task_id,
      run_id: candidate.run_id,
      issue_id: candidate.issue_id,
      terminal_state: "merged",
      stop_disposition: null,
      failure_cause: null,
      reason: null,
      delivery: {
        patch_status: "merged",
        head_sha: delivery.head_sha,
        pr_id: delivery.pr_id,
        change_summary: candidate.summary,
        validation: validationOf(candidate, delivery),
      },
      evidence,
    },
  };
}
