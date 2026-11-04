/**
 * Retrieval eligibility for memory items (DAT-234).
 *
 * The acceptance rule is blunt: an item that did not pass validation appears
 * in **no** bundle. That is not a ranking weight or a default filter — it is a
 * predicate the read path must consult, and there is exactly one of it so
 * there is nothing to get subtly wrong in three different call sites.
 *
 * Two independent questions, deliberately kept apart:
 *
 * - {@link isRetrievalEligible} — may the item appear at all. Requires the
 *   item to be in a retrievable state, still within its validity window, and
 *   to have a recorded admission decision that accepted the exact content
 *   version being read. An item created behind the gate's back has no such
 *   decision and is therefore invisible, which is the property the tests pin.
 * - {@link allowsFactualInjection} — may the item be presented as fact. A
 *   contradicting item stays visible so the conflict can be surfaced, but its
 *   claim is never injected as fact while the conflict stands.
 */

import type { MemoryItem, MemoryItemVersion, MemoryStatus } from "../types.js";
import type { MemoryAdmissionDecision } from "./repositories.js";

/** Statuses a bundle may draw from. `proposed` is not one of them. */
const RETRIEVABLE_STATUSES: readonly MemoryStatus[] = ["active", "candidate"];

export interface EligibilityInput {
  item: MemoryItem;
  /** The exact content version being read. */
  version: MemoryItemVersion;
  /**
   * Every admission decision recorded for this item, newest first. The one
   * that matters is the newest one covering `version.version`.
   */
  decisions: readonly MemoryAdmissionDecision[];
  /** Instant used for the validity-window check; defaults to now. */
  at?: string;
}

function decisionForVersion(input: EligibilityInput): MemoryAdmissionDecision | undefined {
  return input.decisions.find(
    (decision) =>
      decision.item_id === input.item.id &&
      (decision.item_version === null || decision.item_version === input.version.version),
  );
}

function isExpired(version: MemoryItemVersion, at: string): boolean {
  return version.valid_to !== null && Date.parse(version.valid_to) <= Date.parse(at);
}

/**
 * May this item appear in a memory bundle in any form?
 *
 * False for anything that did not pass validation for the exact content
 * version being read — including items written without going through the
 * admission gate at all, because they have no decision to point at.
 */
export function isRetrievalEligible(input: EligibilityInput): boolean {
  if (!RETRIEVABLE_STATUSES.includes(input.item.status)) return false;
  const at = input.at ?? new Date().toISOString();
  if (isExpired(input.version, at)) return false;

  const decision = decisionForVersion(input);
  if (decision === undefined) return false;
  return (
    (decision.disposition === "admitted" || decision.disposition === "merged") &&
    decision.retrieval_eligible
  );
}

/**
 * May this item's claim be presented as fact?
 *
 * Implies {@link isRetrievalEligible}. False while the item contradicts
 * something: the conflict is surfaced instead, and neither side is injected as
 * a claim until a human or the consolidation job resolves it.
 */
export function allowsFactualInjection(input: EligibilityInput): boolean {
  if (!isRetrievalEligible(input)) return false;
  if (input.item.contradiction_count > 0) return false;
  const decision = decisionForVersion(input);
  return decision !== undefined && decision.factual_injection_allowed;
}
