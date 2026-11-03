/**
 * The admission service (DAT-234).
 *
 * The gate decides; this service is what makes that decision real. It is the
 * only path that should create a memory item, and it runs every candidate
 * through the gate first — distillation output, a human proposal, and an
 * adopted enterprise template all arrive here, so nothing reaches the corpus
 * by arriving through a different writer.
 *
 * What it does, in order:
 *
 * - short-circuits on a candidate this workspace already accepted, so a
 *   re-delivered batch is idempotent rather than doubling the corpus;
 * - evaluates the candidate against the same workspace's items and the
 *   captured-evidence ledger;
 * - creates the item, folds a duplicate's evidence into its twin, holds a
 *   malformed candidate as `proposed`, or persists nothing at all;
 * - draws `contradicts` links and recomputes confidence from the rows that
 *   back it, never from a self-reported score;
 * - proposes retiring the contradicted item, as a proposal a human accepts;
 * - records the decision with its reasons, which is the audit trail.
 *
 * No step promotes anything. Reaching `active` is a separate, human-gated
 * decision, and a discarded candidate never becomes an item to promote.
 */

import { ValidationError } from "../../control-plane/errors.js";
import type { WorkspaceScope } from "../../control-plane/types.js";
import type { MemoryEvidence, MemoryItemId, MemoryItemRecord, MemoryLink } from "../types.js";
import type { MemoryRepositories } from "../repositories.js";
import type { AdmissionCandidate, AdmissionVerdict, EvidenceResolver } from "./types.js";
import { retirementProposalsFor } from "./contradiction.js";
import { evidenceKey } from "./evidence.js";
import { evaluateCandidate } from "./gate.js";
import type {
  MemoryAdmissionDecision,
  MemoryAdmissionRepository,
  MemoryRetirementCandidate,
  RecordAdmissionDecisionInput,
} from "./repositories.js";

export interface AdmitOptions {
  /** Ledger of this workspace's captured evidence. Required. */
  evidence: EvidenceResolver;
  run_id?: string | null;
}

export interface AdmissionOutcome {
  verdict: AdmissionVerdict;
  decision: MemoryAdmissionDecision;
  /** The item the candidate became or merged into; null when nothing was kept. */
  item: MemoryItemRecord | null;
  evidence: MemoryEvidence[];
  links: MemoryLink[];
  retirement_candidates: MemoryRetirementCandidate[];
}

/**
 * Statuses that still hold a claim worth comparing against. A retired item is
 * terminal and a quarantined one is out of the corpus entirely, so neither
 * should absorb or contradict a fresh candidate.
 */
const COMPARABLE_STATUSES = ["proposed", "candidate", "active", "deprecated"] as const;

function comparableItems(memory: MemoryRepositories, scope: WorkspaceScope): MemoryItemRecord[] {
  return memory.items
    .list(scope)
    .filter((record) => (COMPARABLE_STATUSES as readonly string[]).includes(record.item.status));
}

function outcomeFor(
  memory: MemoryRepositories,
  admission: MemoryAdmissionRepository,
  scope: WorkspaceScope,
  verdict: AdmissionVerdict,
  decision: MemoryAdmissionDecision,
): AdmissionOutcome {
  const record =
    decision.item_id === null ? undefined : memory.items.getById(scope, decision.item_id);
  return {
    verdict,
    decision,
    item: record ?? null,
    evidence: record === undefined ? [] : memory.evidence.listByItem(scope, record.item.id),
    links: record === undefined ? [] : memory.links.listByItem(scope, record.item.id),
    retirement_candidates: admission
      .listRetirementCandidates(scope, { limit: 500 })
      .filter((entry) => entry.decision_id === decision.id),
  };
}

/**
 * Run one candidate through the gate and act on the verdict.
 *
 * Idempotent by content hash: an identical candidate already accepted in this
 * workspace returns the earlier outcome instead of creating a second item. A
 * candidate previously *held* is evaluated again, because a human may have
 * fixed the reason it was held.
 */
export function admitCandidate(
  memory: MemoryRepositories,
  admission: MemoryAdmissionRepository,
  scope: WorkspaceScope,
  candidate: AdmissionCandidate,
  options: AdmitOptions,
): AdmissionOutcome {
  if (options === undefined || options.evidence === undefined) {
    throw new ValidationError("admission requires an evidence resolver");
  }

  const existing = comparableItems(memory, scope);
  const verdict = evaluateCandidate(candidate, { existing, evidence: options.evidence });

  // Idempotency first: the hash covers kind, scope, statement, preconditions,
  // and sensitivity, so an identical re-delivery is the same memory and must
  // not become a second item.
  const prior =
    verdict.disposition === "merged" || verdict.disposition === "admitted"
      ? admission.findAcceptedDecision(scope, verdict.candidate_hash)
      : undefined;
  if (prior !== undefined && prior.item_id !== null) {
    return outcomeFor(memory, admission, scope, verdict, prior);
  }

  return admitOrMerge(memory, admission, scope, candidate, options, verdict);
}

/**
 * The one place a decision is written. `itemId` is null for a discarded
 * candidate, which left nothing behind but the record of its rejection.
 */
function decisionInputFor(
  verdict: AdmissionVerdict,
  options: AdmitOptions,
  itemId: MemoryItemId | null,
  itemVersion: number | null,
): RecordAdmissionDecisionInput {
  return {
    candidate_hash: verdict.candidate_hash,
    item_id: itemId,
    item_version: itemVersion,
    disposition: verdict.disposition,
    reason_codes: verdict.reasons,
    check_results: verdict.checks,
    duplicate_of_item_id: verdict.duplicate?.item_id ?? null,
    contradicts_item_ids: verdict.contradictions.map((finding) => finding.item_id),
    // A discarded candidate is never eligible for anything; the flag is
    // written as false so the audit never has to be inferred from context.
    retrieval_eligible: verdict.disposition === "discarded" ? false : verdict.retrieval_eligible,
    factual_injection_allowed:
      verdict.disposition === "discarded" ? false : verdict.factual_injection_allowed,
    run_id: options.run_id ?? null,
  };
}

function admitOrMerge(
  memory: MemoryRepositories,
  admission: MemoryAdmissionRepository,
  scope: WorkspaceScope,
  candidate: AdmissionCandidate,
  options: AdmitOptions,
  verdict: AdmissionVerdict,
): AdmissionOutcome {
  // A discarded candidate leaves nothing behind but its rejection record.
  if (verdict.disposition === "discarded") {
    const decision = admission.recordDecision(
      scope,
      decisionInputFor(verdict, options, null, null),
    );
    return { verdict, decision, item: null, evidence: [], links: [], retirement_candidates: [] };
  }

  const disposition = verdict.disposition;
  // A merged candidate becomes somebody else's supporting evidence; an
  // admitted or held one becomes an item of its own. Only `admitted` may act
  // on a contradiction — a held candidate has no standing to retire anything.
  const target =
    disposition === "merged"
      ? mergeIntoExisting(memory, scope, candidate, verdict)
      : createItem(memory, scope, candidate);

  const links =
    disposition === "admitted"
      ? drawContradictionLinks(memory, scope, target.item.id, verdict)
      : [];

  // The ADR's `proposed -> candidate` step is exactly these checks passing.
  // A held candidate stays `proposed` for human review; a merged one is not a
  // new item and keeps whatever state its twin already had.
  if (disposition === "admitted") {
    memory.items.setStatus(scope, target.item.id, "candidate", target.item.current_version);
  }

  const decision = admission.recordDecision(
    scope,
    decisionInputFor(verdict, options, target.item.id, target.item.current_version),
  );

  const retirement_candidates =
    disposition === "admitted"
      ? proposeRetirements(memory, admission, scope, target, verdict, decision.id)
      : [];

  return {
    verdict,
    decision,
    item: memory.items.getById(scope, target.item.id) ?? null,
    evidence: memory.evidence.listByItem(scope, target.item.id),
    links: [...memory.links.listByItem(scope, target.item.id), ...links],
    retirement_candidates,
  };
}

function createItem(
  memory: MemoryRepositories,
  scope: WorkspaceScope,
  candidate: AdmissionCandidate,
): MemoryItemRecord {
  const record = memory.items.create(scope, {
    kind: candidate.kind,
    scope: candidate.scope,
    statement: candidate.statement,
    preconditions: candidate.preconditions,
    provenance: candidate.provenance,
    trust: candidate.trust,
    sensitivity: candidate.sensitivity,
    valid_from: candidate.valid_from,
    valid_to: candidate.valid_to ?? null,
    source_run_id: candidate.source_run_id ?? null,
  });
  // Evidence is what makes the item a *memory* rather than an assertion. It is
  // attached before confidence is recounted, so support is a count of rows and
  // never a number somebody typed in.
  for (const ref of candidate.evidence) {
    memory.evidence.add(scope, record.item.id, {
      evidence_type: ref.evidence_type,
      reference: ref.reference,
    });
  }
  memory.items.recountConfidence(scope, record.item.id);
  return memory.items.getById(scope, record.item.id) ?? record;
}

function mergeIntoExisting(
  memory: MemoryRepositories,
  scope: WorkspaceScope,
  candidate: AdmissionCandidate,
  verdict: AdmissionVerdict,
): MemoryItemRecord {
  const targetId: MemoryItemId = verdict.duplicate?.item_id ?? "";
  const record = memory.items.getById(scope, targetId);
  if (record === undefined) {
    throw new ValidationError("admission merge target is gone");
  }
  // The duplicate's evidence is what makes the merge a *strengthening* of one
  // memory rather than a second copy of it. Evidence already on the item is
  // not added twice.
  const seen = new Set(
    memory.evidence
      .listByItem(scope, targetId)
      .map((entry) => evidenceKey(entry.evidence_type, entry.reference)),
  );
  for (const ref of candidate.evidence) {
    const key = evidenceKey(ref.evidence_type, ref.reference);
    if (seen.has(key)) continue;
    seen.add(key);
    memory.evidence.add(scope, targetId, {
      evidence_type: ref.evidence_type,
      reference: ref.reference,
    });
  }
  memory.items.recountConfidence(scope, targetId);
  return memory.items.getById(scope, targetId) ?? record;
}

function drawContradictionLinks(
  memory: MemoryRepositories,
  scope: WorkspaceScope,
  itemId: MemoryItemId,
  verdict: AdmissionVerdict,
): MemoryLink[] {
  const links: MemoryLink[] = [];
  for (const finding of verdict.contradictions) {
    // `reason` on a link is free text, so it carries the fixed reason code and
    // nothing else. The detail an incident review needs is in the decision row.
    links.push(
      memory.links.create(scope, {
        item_id: itemId,
        target_item_id: finding.item_id,
        link_type: "contradicts",
        reason: finding.reason,
      }),
    );
  }
  if (links.length > 0) {
    memory.items.recountConfidence(scope, itemId);
    for (const finding of verdict.contradictions) {
      memory.items.recountConfidence(scope, finding.item_id);
    }
  }
  return links;
}

function proposeRetirements(
  memory: MemoryRepositories,
  admission: MemoryAdmissionRepository,
  scope: WorkspaceScope,
  target: MemoryItemRecord,
  verdict: AdmissionVerdict,
  decisionId: string,
): MemoryRetirementCandidate[] {
  const trustOf = (itemId: MemoryItemId) =>
    memory.items.getById(scope, itemId)?.current.trust ?? "agent";
  return retirementProposalsFor(verdict.contradictions, {
    successorItemId: target.item.id,
    successorTrust: target.current.trust,
    trustOf,
  }).map((proposal) =>
    admission.proposeRetirement(scope, {
      item_id: proposal.item_id,
      successor_item_id: proposal.successor_item_id,
      proposed_action: proposal.proposed_action,
      reason_code: proposal.reason,
      decision_id: decisionId,
    }),
  );
}
