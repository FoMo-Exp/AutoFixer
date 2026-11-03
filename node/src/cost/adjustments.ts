/**
 * Linked adjustment entries (DAT-228, ADR-0008 "Provider corrections produce
 * linked adjustment entries, not overwritten historical charges").
 *
 * A correction is a NEW immutable record pointing at the posting it corrects.
 * The original posting keeps every figure it was written with; the effective
 * (net) view replays the adjustment chain on top of it. Corrections restates
 * category figures — by explicit amount, by corrected units recomputed under
 * the posting's OWN bound rate snapshot (that is what the snapshot is for),
 * or by voiding a figure back to unknown.
 *
 * A correction never converts currencies and never invents a figure: a void
 * correction makes the component unknown again instead of zeroing it.
 */
import { CostValidationError } from "./errors.js";
import { assertCanonicalAmount, computeChargeScaled, formatAmount, parseAmount } from "./money.js";
import { rollupCompleteness, postingCurrency } from "./pricing.js";
import {
  COST_CATEGORIES,
  COST_SCHEMA_VERSION,
  type AdjustmentComponent,
  type AdjustmentEntry,
  type AdjustmentInput,
  type CostClassTotals,
  type CostComponent,
  type CostCompleteness,
  type CostLedgerEntry,
  type CostPosting,
  type CostSummary,
  type RateCardRevision,
} from "./types.js";
import {
  asCurrency,
  asNonEmptyString,
  asNullableString,
  asOneOf,
  asRecord,
  asTimestamp,
  asUnitCount,
} from "./validate.js";

const ADJUSTMENT_REASONS = ["provider_correction", "administrator_correction"] as const;
const ADJUSTMENT_SOURCES = ["provider", "administrator"] as const;

/**
 * Validate one fully-shaped current-version adjustment. Returns the input
 * object; every coherence rule of the correction contract is checked here so
 * a stored adjustment is exactly as trustworthy as a fresh one.
 */
export function validateAdjustmentEntry(value: unknown): AdjustmentEntry {
  const record = asRecord(value, "adjustment");
  const version = record["schema_version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CostValidationError(`cost field "schema_version" must be an integer`);
  }
  if (version > COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost adjustment schema ${version} is newer than ${COST_SCHEMA_VERSION}`,
    );
  }
  if (version !== COST_SCHEMA_VERSION) {
    throw new CostValidationError(
      `cost adjustment schema ${version} must be migrated to ${COST_SCHEMA_VERSION} first`,
    );
  }
  asNonEmptyString(record["adjustment_id"], "adjustment_id");
  asNonEmptyString(record["enterprise_id"], "enterprise_id");
  asNonEmptyString(record["workspace_id"], "workspace_id");
  asNonEmptyString(record["target_posting_id"], "target_posting_id");
  const reason = asOneOf(record["reason"], ADJUSTMENT_REASONS, "reason");
  const source = asOneOf(record["source"], ADJUSTMENT_SOURCES, "source");
  if ((reason === "provider_correction") !== (source === "provider")) {
    throw new CostValidationError(
      'cost adjustment reason and source must agree: "provider_correction" is asserted by ' +
        '"provider", "administrator_correction" by "administrator"',
    );
  }
  asTimestamp(record["created_at"], "created_at");
  asNullableString(record["note"], "note");
  const components = record["components"];
  if (!Array.isArray(components) || components.length === 0) {
    throw new CostValidationError('cost field "components" must be a non-empty array');
  }
  const seenCategories = new Set<string>();
  for (const component of components) {
    const parsed = asRecord(component, "adjustment component");
    const category = asOneOf(parsed["category"], COST_CATEGORIES, "adjustment component.category");
    if (seenCategories.has(category)) {
      throw new CostValidationError(
        `cost adjustment corrects category ${category} twice in one entry`,
      );
    }
    seenCategories.add(category);
    validateAdjustmentComponent(parsed);
  }
  return value as AdjustmentEntry;
}

function validateAdjustmentComponent(record: Record<string, unknown>): void {
  const completeness = asOneOf(
    record["completeness"],
    ["known", "estimated", "unknown"] as const,
    "adjustment component.completeness",
  );
  const correctedCost = record["corrected_cost"];
  const correctedCurrency = record["corrected_currency"];
  const correctedUnits = record["corrected_units"];
  const correctedRevision = record["corrected_rate_revision_id"];
  if (correctedCost !== null) {
    const scaled = assertCanonicalAmount(
      asNonEmptyString(correctedCost, "adjustment component.corrected_cost"),
      "adjustment component.corrected_cost",
    );
    if (scaled < 0n) {
      throw new CostValidationError(
        "adjustment component.corrected_cost restates a cost and cannot be negative",
      );
    }
    asCurrency(correctedCurrency, "adjustment component.corrected_currency");
  } else if (correctedCurrency !== null) {
    throw new CostValidationError(
      "adjustment component.corrected_currency only speaks for a corrected_cost",
    );
  }
  if (correctedUnits !== null) {
    asUnitCount(correctedUnits, "adjustment component.corrected_units");
  }
  asNullableString(correctedRevision, "adjustment component.corrected_rate_revision_id");
  asNullableString(record["note"], "adjustment component.note");
  if (completeness === "unknown") {
    if (correctedCost !== null || correctedUnits !== null || correctedRevision !== null) {
      throw new CostValidationError(
        'an adjustment component of completeness "unknown" voids the figure and restates nothing',
      );
    }
    return;
  }
  if (correctedCost === null && correctedUnits === null && correctedRevision === null) {
    throw new CostValidationError(
      "an adjustment component must restate a cost, units, or the bound rate revision",
    );
  }
}

/**
 * Build a complete current-version adjustment from writer input and validate
 * it. `created_at` is the store's stamp; the correction content is taken as
 * written.
 */
export function buildAdjustment(input: AdjustmentInput, createdAt: string): AdjustmentEntry {
  return validateAdjustmentEntry({
    schema_version: COST_SCHEMA_VERSION,
    adjustment_id: input.adjustment_id,
    enterprise_id: input.enterprise_id,
    workspace_id: input.workspace_id,
    target_posting_id: input.target_posting_id,
    reason: input.reason,
    source: input.source,
    created_at: createdAt,
    note: input.note,
    components: input.components,
  });
}

/** The effective shape of one category line after its correction chain. */
export interface NetPostingView {
  /** The untouched original posting. */
  posting: CostPosting;
  /** Effective components: the posting's figures with every correction replayed. */
  components: CostComponent[];
  currency: string | null;
  completeness: CostCompleteness;
  /** The adjustments applied, in recording order. */
  adjustments: AdjustmentEntry[];
}

/**
 * Replay the correction chain over a posting. The posting itself is never
 * modified — the view is derived, so the full trail from original figures to
 * net amount stays replayable.
 */
export function netPosting(
  entry: CostLedgerEntry,
  revisions: readonly RateCardRevision[],
): NetPostingView {
  const components = structuredClone(entry.posting.components);
  for (const adjustment of entry.adjustments) {
    // A replay is bound to the posting it corrects: the adjustment must
    // target exactly this posting, in exactly its enterprise/workspace.
    if (adjustment.target_posting_id !== entry.posting.posting_id) {
      throw new CostValidationError(
        `adjustment ${adjustment.adjustment_id} targets posting ` +
          `${adjustment.target_posting_id}, not the posting being replayed ` +
          `(${entry.posting.posting_id})`,
      );
    }
    if (
      adjustment.enterprise_id !== entry.posting.enterprise_id ||
      adjustment.workspace_id !== entry.posting.workspace_id
    ) {
      throw new CostValidationError(
        `adjustment ${adjustment.adjustment_id} is outside the enterprise/workspace ` +
          "scope of the posting it would correct",
      );
    }
    for (const correction of adjustment.components) {
      const index = components.findIndex((component) => component.category === correction.category);
      if (index === -1) {
        throw new CostValidationError(
          `adjustment ${adjustment.adjustment_id} corrects category ${correction.category}, ` +
            "which the target posting does not carry",
        );
      }
      components[index] = applyCorrection(
        components[index] as CostComponent,
        correction,
        revisions,
        entry.posting,
        adjustment,
      );
    }
  }
  return {
    posting: entry.posting,
    components,
    currency: postingCurrency(components),
    completeness: rollupCompleteness(components),
    adjustments: entry.adjustments,
  };
}

/**
 * Resolve and vet a rebind target — used at BOTH the record boundary (the
 * store refuses to persist a correction naming it) and the replay boundary
 * (the net view refuses to apply one). The revision must be recorded and must
 * actually price this correction: same enterprise/workspace scope, the
 * posting's deployment target, the corrected category, and the corrected
 * line's unit. A missing or mismatched revision is refused loudly — never
 * guessed around and never recomputed under a wrong rate.
 */
export function resolveRebindRevision(
  correction: AdjustmentComponent,
  component: CostComponent,
  posting: CostPosting,
  adjustment: AdjustmentEntry,
  revisions: readonly RateCardRevision[],
): RateCardRevision {
  const revision = revisions.find(
    (candidate) => candidate.revision_id === correction.corrected_rate_revision_id,
  );
  if (!revision) {
    throw new CostValidationError(
      `adjustment ${adjustment.adjustment_id} rebinds to rate revision ` +
        `${String(correction.corrected_rate_revision_id)}, which is not recorded`,
    );
  }
  const mismatches: string[] = [];
  // The revision must belong to the same enterprise/workspace as BOTH the
  // adjustment and the posting it corrects; netPosting additionally requires
  // adjustment and posting to agree, so the three-way scope is identical.
  if (
    revision.enterprise_id !== adjustment.enterprise_id ||
    revision.workspace_id !== adjustment.workspace_id ||
    revision.enterprise_id !== posting.enterprise_id ||
    revision.workspace_id !== posting.workspace_id
  ) {
    mismatches.push("the enterprise/workspace scope of the posting and adjustment");
  }
  if (revision.target !== posting.target) {
    mismatches.push(`deployment target ${posting.target}`);
  }
  if (revision.category !== correction.category) {
    mismatches.push(`category ${correction.category}`);
  }
  if (revision.unit !== component.unit) {
    mismatches.push(`unit ${component.unit}`);
  }
  if (mismatches.length > 0) {
    throw new CostValidationError(
      `adjustment ${adjustment.adjustment_id} rebinds to rate revision ${revision.revision_id}, ` +
        `which does not price ${mismatches.join(", ")} of the corrected line`,
    );
  }
  return revision;
}

function applyCorrection(
  original: CostComponent,
  correction: AdjustmentComponent,
  revisions: readonly RateCardRevision[],
  posting: CostPosting,
  adjustment: AdjustmentEntry,
): CostComponent {
  if (correction.completeness === "unknown") {
    // A voided figure is unknown again — never a zeroed charge.
    return {
      ...original,
      chargeable_units: correction.corrected_units ?? original.chargeable_units,
      cost: null,
      completeness: "unknown",
      unknown_reason: "usage_unknown",
    };
  }
  let base = original;
  if (correction.corrected_rate_revision_id !== null) {
    const revision = resolveRebindRevision(correction, original, posting, adjustment, revisions);
    base = {
      ...base,
      currency: revision.currency,
      rate_revision_id: revision.revision_id,
      rate: revision.rate,
      divisor: revision.divisor,
    };
  }
  const units = correction.corrected_units ?? base.chargeable_units;
  const restated: CostComponent = {
    ...base,
    chargeable_units: units,
    completeness: correction.completeness,
    unknown_reason: null,
  };
  if (correction.corrected_cost !== null) {
    return {
      ...restated,
      currency: correction.corrected_currency ?? restated.currency,
      cost: correction.corrected_cost,
    };
  }
  if (units === null) {
    // Nothing to recompute from: the figure stays unknown, honestly.
    return {
      ...restated,
      cost: null,
      completeness: "unknown",
      unknown_reason: "usage_unknown",
    };
  }
  if (restated.rate === null || restated.divisor === null) {
    return {
      ...restated,
      cost: null,
      completeness: "unknown",
      unknown_reason: "rate_unknown",
    };
  }
  return {
    ...restated,
    cost: formatAmount(computeChargeScaled(units, parseAmount(restated.rate), restated.divisor)),
  };
}

/**
 * Per (currency, cost class) totals over net postings. Known and estimated
 * amounts stay in separate buckets — an estimate is provisional and is never
 * presented as an invoiced amount — and unpriced components are counted as
 * unknown instead of folded in as zeros.
 */
export function summarizeCosts(
  entries: readonly CostLedgerEntry[],
  revisions: readonly RateCardRevision[],
): CostSummary {
  interface Bucket {
    currency: string | null;
    cost_class: string;
    known: bigint;
    estimated: bigint;
    unknown: number;
    components: number;
    postings: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const entry of entries) {
    const view = netPosting(entry, revisions);
    const postingClasses = new Set<string>();
    for (const component of view.components) {
      // Included categories are recorded on the posting for reconciliation
      // but are not cost evidence: they are never charged, never unknown.
      if (!component.chargeable) {
        continue;
      }
      const key = JSON.stringify([component.currency, component.cost_class]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          currency: component.currency,
          cost_class: component.cost_class,
          known: 0n,
          estimated: 0n,
          unknown: 0,
          components: 0,
          postings: 0,
        };
        buckets.set(key, bucket);
      }
      bucket.components += 1;
      postingClasses.add(key);
      if (component.cost === null) {
        bucket.unknown += 1;
      } else {
        const scaled = parseAmount(component.cost);
        if (component.completeness === "estimated") {
          bucket.estimated += scaled;
        } else {
          bucket.known += scaled;
        }
      }
    }
    for (const key of postingClasses) {
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.postings += 1;
      }
    }
  }
  const lines: CostClassTotals[] = [...buckets.values()].map((bucket) => ({
    currency: bucket.currency,
    cost_class: bucket.cost_class as CostClassTotals["cost_class"],
    known_cost: formatAmount(bucket.known),
    estimated_cost: formatAmount(bucket.estimated),
    unknown_components: bucket.unknown,
    components: bucket.components,
    postings: bucket.postings,
  }));
  lines.sort((left, right) =>
    JSON.stringify([left.currency, left.cost_class]).localeCompare(
      JSON.stringify([right.currency, right.cost_class]),
    ),
  );
  return { lines };
}
