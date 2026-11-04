/**
 * Independent supporting runs (DAT-235).
 *
 * Automatic fact promotion needs "at least two independent supporting runs".
 * Independence is a property of the support ledger, not of anything a model
 * says about itself: "independent" means distinct runs **and** distinct
 * evidence, and a retried attempt or repackaged evidence does not count
 * twice. This module is the single definition, pure and unit-testable, that
 * the promotion gate applies.
 *
 * The rules, in order:
 *
 * 1. Only a run with a known terminal outcome supports anything. A timeout,
 *    unknown delivery result, or infrastructure failure is never support.
 * 2. Observations naming the same `run_id` are one run; their evidence
 *    accumulates but the run is counted once.
 * 3. A run counts as independent only if it contributes at least one evidence
 *    citation — identified by its `(evidence_type, reference)` pair — that no
 *    earlier supporting run contributed. A retry whose evidence is the same
 *    work repackaged therefore never raises the count.
 * 4. A run that contributes no citations at all is not support.
 *
 * Because run evidence is per-run (a `run`-type citation names the run
 * itself), two genuinely distinct runs normally bring distinct citations;
 * what rule 3 excludes is the same evidence observed again and presented as
 * new support.
 */

import type { EvidenceCitation, RunSupport } from "./types.js";

export interface IndependentSupport {
  /** Support runs that survived the independence rules. */
  independent_runs: number;
  /** Run ids counted, in evaluation order. */
  counted_run_ids: string[];
  /** Run ids collapsed: retries, repackaged evidence, or no new evidence. */
  collapsed_run_ids: string[];
}

/** Canonical identity of one evidence citation: type plus reference. */
export function citationKey(citation: EvidenceCitation): string {
  return `${citation.evidence_type} ${citation.reference}`;
}

/**
 * Count independent supporting runs from a support ledger.
 *
 * The ledger is evaluated in the order supplied (the outcome-capture path
 * records chronologically). The result is deterministic for a given input.
 */
export function assessIndependentSupport(runs: readonly RunSupport[]): IndependentSupport {
  const byRun = new Map<string, { known_outcome: boolean; citations: Set<string> }>();
  const order: string[] = [];
  for (const run of runs) {
    if (typeof run.run_id !== "string" || run.run_id.length === 0) {
      continue;
    }
    let entry = byRun.get(run.run_id);
    if (entry === undefined) {
      entry = { known_outcome: run.known_outcome, citations: new Set<string>() };
      byRun.set(run.run_id, entry);
      order.push(run.run_id);
    }
    // Divergent observations of one run fail closed: if any observation says
    // the outcome was unknown, the run never supports anything.
    entry.known_outcome = entry.known_outcome && run.known_outcome;
    for (const citation of run.evidence) {
      entry.citations.add(citationKey(citation));
    }
  }

  const seenCitations = new Set<string>();
  const counted: string[] = [];
  const collapsed: string[] = [];
  for (const runId of order) {
    const entry = byRun.get(runId);
    if (entry === undefined || !entry.known_outcome || entry.citations.size === 0) {
      collapsed.push(runId);
      continue;
    }
    let bringsNewEvidence = false;
    for (const key of entry.citations) {
      if (!seenCitations.has(key)) {
        bringsNewEvidence = true;
        break;
      }
    }
    if (!bringsNewEvidence) {
      collapsed.push(runId);
      continue;
    }
    for (const key of entry.citations) {
      seenCitations.add(key);
    }
    counted.push(runId);
  }

  return {
    independent_runs: counted.length,
    counted_run_ids: counted,
    collapsed_run_ids: collapsed,
  };
}
