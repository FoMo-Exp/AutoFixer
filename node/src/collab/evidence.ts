import { CollabError } from "./errors.js";
import type { RunRecord, TestPlanRecord } from "./types.js";

/**
 * Evidence reference resolution for frozen candidates (DAT-219, ADR-0007).
 *
 * A candidate may only claim evidence that actually exists in the append-only
 * record set of its preparation run: the approved test plan, retained artifacts
 * (patch, test report, candidate, evidence bundle), and the run's recorded
 * capability grants. A reference is an opaque, stable string under
 * `evidence://runs/{run_id}/...` and is resolved against the run record — a
 * made-up reference, a reference to another run's artifact, or an artifact
 * bound to a different revision never freezes a candidate.
 *
 * Artifacts carry the revision they were produced from and their content
 * digest, so a validation result is bound both to the exact candidate revision
 * and to the exact execution artifact whose digest it declares.
 */

export const RUN_EVIDENCE_PREFIX = "evidence://runs/";

/** Artifact kinds that may back a validation attempt. */
export const VALIDATION_ARTIFACT_KINDS = ["test_report"] as const;

export function artifactEvidenceRef(runId: string, artifactId: string): string {
  return `${RUN_EVIDENCE_PREFIX}${runId}/artifacts/${artifactId}`;
}

export function grantEvidenceRef(runId: string, grantId: string): string {
  return `${RUN_EVIDENCE_PREFIX}${runId}/grants/${grantId}`;
}

export function planEvidenceRef(runId: string, planId: string): string {
  return `${RUN_EVIDENCE_PREFIX}${runId}/plans/${planId}`;
}

export interface ResolvedEvidence {
  reference: string;
  kind: "artifact" | "grant" | "plan";
  run_id: string;
  record_id: string;
  /** Artifact kind for an artifact record; null otherwise. */
  artifact_kind: string | null;
  /** Artifact content digest; null for grants and plans. */
  digest_algorithm: string | null;
  digest: string | null;
  /** Revision binding; null for a grant or a plan, which are run-scoped. */
  base_sha: string | null;
  head_sha: string | null;
}

/** The run-scoped records a reference may resolve to. */
export interface RunEvidenceContext {
  run: RunRecord;
  plan?: TestPlanRecord | undefined;
}

/**
 * Every reference the run can actually resolve. Built from the run record (and
 * its approved test plan), so it is identical on replay.
 */
export function runEvidenceIndex(context: RunEvidenceContext): Map<string, ResolvedEvidence> {
  const { run, plan } = context;
  const index = new Map<string, ResolvedEvidence>();
  for (const artifact of run.artifact_refs) {
    const reference = artifactEvidenceRef(run.run_id, artifact.artifact_id);
    index.set(reference, {
      reference,
      kind: "artifact",
      run_id: run.run_id,
      record_id: artifact.artifact_id,
      artifact_kind: artifact.kind,
      digest_algorithm: artifact.digest_algorithm,
      digest: artifact.digest,
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
      artifact_kind: null,
      digest_algorithm: null,
      digest: null,
      base_sha: null,
      head_sha: null,
    });
  }
  if (plan !== undefined) {
    const reference = planEvidenceRef(run.run_id, plan.plan_id);
    index.set(reference, {
      reference,
      kind: "plan",
      run_id: run.run_id,
      record_id: plan.plan_id,
      artifact_kind: null,
      digest_algorithm: null,
      digest: null,
      base_sha: null,
      head_sha: null,
    });
  }
  return index;
}

/**
 * Resolve one reference against the run, or deny the freeze with a uniform
 * `CANDIDATE_INVALID`.
 */
export function resolveRunEvidence(
  context: RunEvidenceContext,
  reference: string,
  field: string,
): ResolvedEvidence {
  const resolved = runEvidenceIndex(context).get(reference);
  if (resolved === undefined) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} does not resolve to a retained record of this run`,
      { field, reference, run_id: context.run.run_id },
    );
  }
  return resolved;
}

/**
 * Resolve evidence that must be bound to the exact frozen revision — an audit
 * reference that names an artifact claims where it came from, so only an
 * artifact produced from that base and head qualifies. Grants and the approved
 * test plan are run-scoped and carry no revision.
 */
export function resolveRevisionEvidence(
  context: RunEvidenceContext,
  reference: string,
  field: string,
  binding: { base_sha: string; head_sha: string },
): ResolvedEvidence {
  const resolved = resolveRunEvidence(context, reference, field);
  if (resolved.kind !== "artifact") {
    // Grants and the approved test plan are run-scoped, not revision-scoped.
    return resolved;
  }
  assertRevision(resolved, field, binding);
  return resolved;
}

/**
 * Resolve the execution evidence of one validation attempt. The reference must
 * be a retained test-report artifact produced from the frozen base and head,
 * and the artifact digest must equal the declared `output_digest` — a result
 * can neither point at the patch/report of another purpose nor claim a digest
 * the retained execution artifact does not have.
 */
export function resolveValidationEvidence(
  context: RunEvidenceContext,
  reference: string,
  field: string,
  binding: { base_sha: string; head_sha: string },
  outputDigest: { algorithm: string; value: string },
): ResolvedEvidence {
  const resolved = resolveRunEvidence(context, reference, field);
  if (resolved.kind !== "artifact") {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} must reference a retained execution artifact`,
      { field, reference, kind: resolved.kind },
    );
  }
  if (!(VALIDATION_ARTIFACT_KINDS as readonly string[]).includes(resolved.artifact_kind ?? "")) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} must reference a ${VALIDATION_ARTIFACT_KINDS.join("/")} artifact`,
      { field, reference, artifact_kind: resolved.artifact_kind },
    );
  }
  assertRevision(resolved, field, binding);
  if (
    resolved.digest_algorithm !== outputDigest.algorithm ||
    resolved.digest !== outputDigest.value
  ) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} artifact digest does not match the declared output digest`,
      {
        field,
        reference,
        artifact_digest: resolved.digest,
        output_digest: outputDigest.value,
      },
    );
  }
  return resolved;
}

function assertRevision(
  resolved: ResolvedEvidence,
  field: string,
  binding: { base_sha: string; head_sha: string },
): void {
  if (resolved.base_sha !== binding.base_sha || resolved.head_sha !== binding.head_sha) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${field} is bound to a different revision than the frozen candidate`,
      {
        field,
        reference: resolved.reference,
        artifact_base_sha: resolved.base_sha,
        artifact_head_sha: resolved.head_sha,
        base_sha: binding.base_sha,
        head_sha: binding.head_sha,
      },
    );
  }
}
