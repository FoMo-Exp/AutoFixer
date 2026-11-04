import { randomUUID } from "node:crypto";

/**
 * Opaque identifier minting for the collaboration domain.
 *
 * Identifiers are opaque strings (task-evidence-contract-v1 §1); the prefixes
 * only make logs and audit records readable. Every id is unique per mint; the
 * machine captures minted ids into the audited command payload so a replay
 * reproduces the exact same identifiers instead of minting new ones.
 */
export function newIssueId(): string {
  return `iss_${randomUUID().replaceAll("-", "")}`;
}

export function newTaskId(): string {
  return `tsk_${randomUUID().replaceAll("-", "")}`;
}

export function newRunId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

export function newGrantId(): string {
  return `grt_${randomUUID().replaceAll("-", "")}`;
}

export function newArtifactId(): string {
  return `art_${randomUUID().replaceAll("-", "")}`;
}

export function newTestPolicyId(): string {
  return `pol_${randomUUID().replaceAll("-", "")}`;
}

export function newTestPlanId(): string {
  return `pln_${randomUUID().replaceAll("-", "")}`;
}

export function newCandidateId(): string {
  return `cand_${randomUUID().replaceAll("-", "")}`;
}

export function newHandoffId(): string {
  return `hof_${randomUUID().replaceAll("-", "")}`;
}

export function newEventId(): string {
  return `evt_${randomUUID().replaceAll("-", "")}`;
}
