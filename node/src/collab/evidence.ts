import { CollabError } from "./errors.js";
import type { RunRecord } from "./types.js";

/**
 * Evidence reference resolution for frozen candidates (DAT-219, ADR-0007).
 *
 * A candidate may only claim evidence that actually exists in the append-only
 * record set of its preparation run: retained artifacts (patch, report,
 * candidate, evidence bundle) and the run's recorded capability grants. A
 * reference is an opaque, stable string under `evidence://runs/{run_id}/...`
 * and is resolved against the run record — a made-up reference, a reference to
 * another run's artifact, or an artifact bound to a different revision never
 * freezes a candidate.
 *
 * Artifacts additionally carry the revision they were produced from, so a
 * validation result can be bound to the exact candidate head instead of merely
 * "some artifact of the run".
 */

export const RUN_EVIDENCE_PREFIX = "evidence://runs/";

export function artifactEvidenceRef(runId: string, artifactId: string): string {
  return `${RUN_EVIDENCE_PREFIX}${runId}/artifacts/${artifactId}`;
}

export function grantEvidenceRef(runId: string, grantId: string): string {
  return `${RUN_EVIDENCE_PREFIX}${runId}/grants/${grantId}`;
}

export interface ResolvedEvidence {
  reference: string;
  kind: "artifact" | "grant";
  run_id: string;
  record_id: string;
  /** Revision binding; null for a grant record, which is run-scoped. */
  base_sha: string | null;
  head_sha: string | null;
}

/**
 * Every reference the run can actually resolve. Built from the run record, so
 * it is identical on replay and a budget-free lookup for the freeze gate.
 */
export function runEvidenceIndex(run: RunRecord): Map<string, ResolvedEvidence> {
  const index = new Map<string, ResolvedEvidence>();
  for (const artifact of run.artifact_refs) {
    const reference = artifactEvidenceRef(run.run_id, artifact.artifact_id);
    index.set(reference, {
      reference,
      kind: "artifact",
      run_id: run.run_id,
      record_id: artifact.artifact_id,
      base_sha: artifact.base_sha,
      head_sha: artifact.head_sha,
    });
  }
  for (const grant of run.grants) {
    const reference = grantEvidenceRef(run.run_id, grant.grant_id);
    index.set(reference, {
      reference,
      kind: "grant",
      run_id: run.run_id,
      record_id: grant.grant_id,
      base_sha: null,
      head_sha: null,
    });
  }
  return index;
}

/**
 * Resolve one reference against the run, or deny the freeze with a uniform
 * `CANDIDATE_INVALID`. The denial never echoes whether a similarly named record
 * exists elsewhere.
 */
export function resolveRunEvidence(
  run: RunRecord,
  reference: string,
  field: string,
): ResolvedEvidence {
  const resolved = runEvidenceIndex(run).get(reference);
  if (resolved === undefined) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} does not resolve to a retained record of this run`,
      { field, reference, run_id: run.run_id },
    );
  }
  return resolved;
}

/**
 * Resolve evidence that must be bound to the exact frozen revision — a
 * validation attempt claims what ran against this candidate, so only an
 * artifact produced from that base and head qualifies.
 */
export function resolveRevisionEvidence(
  run: RunRecord,
  reference: string,
  field: string,
  binding: { base_sha: string; head_sha: string },
): ResolvedEvidence {
  const resolved = resolveRunEvidence(run, reference, field);
  if (resolved.kind !== "artifact") {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} must reference an artifact produced from the candidate revision`,
      { field, reference, kind: resolved.kind },
    );
  }
  if (resolved.base_sha !== binding.base_sha || resolved.head_sha !== binding.head_sha) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} is bound to a different revision than the frozen candidate`,
      {
        field,
        reference,
        artifact_base_sha: resolved.base_sha,
        artifact_head_sha: resolved.head_sha,
        base_sha: binding.base_sha,
        head_sha: binding.head_sha,
      },
    );
  }
  return resolved;
}
