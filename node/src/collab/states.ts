import type { DshState } from "../dsh/types.js";

/**
 * Product lifecycle states (ADR-0007 "Product lifecycle and the existing
 * harness").
 *
 * This vocabulary belongs to the issue lifecycle, distinct from the harness
 * (dsh / FP-01) run-state vocabulary in `../dsh/types.js`. `awaiting_change_approval`
 * is a product state — an immutable candidate waits for a human change approval
 * and no PR exists yet. Harness `awaiting_review` means a provider PR exists
 * for the current commit. Neither may ever stand in for the other: the two
 * vocabularies are separate kinds (only the plain word `cancelled` appears in
 * both, meaning an issue cancellation and a run cancellation), and the
 * relations below reject every attempt to equate approval with review.
 */
export const PRODUCT_STATES = [
  "triage",
  "planning",
  "implementing",
  "validating",
  "awaiting_change_approval",
  "delivering",
  "pr_review",
  "completed",
  "needs_human",
  "cancelled",
] as const;

export type ProductState = (typeof PRODUCT_STATES)[number];

/**
 * Allowed product-state edges, each backed by ADR-0007's stage table:
 *
 * - `triage`: deduplicated signal/manual issue, repository and routing context.
 * - `planning`: bounded diagnosis and proposed scope.
 * - `implementing`: authorized read/search/edit in an isolated checkout.
 * - `validating`: approved test plan against the exact candidate revision.
 * - `awaiting_change_approval`: immutable candidate + summary/diff card; local
 *   preparation is complete and its run's grant is revoked. Not a PR state.
 * - `delivering`: current human change approval plus a separate delivery grant;
 *   broker-controlled push/PR happens here.
 * - `pr_review`: the provider PR exists (harness `awaiting_review` territory).
 * - `completed`: provider-confirmed merge, never merely a published PR.
 * - `needs_human`: a stop reason awaits human disposition; grants are revoked.
 * - `cancelled`: explicitly recorded cancellation; grants are revoked.
 *
 * A failed validation or security stop leaves `validating` for `needs_human`;
 * another implementation attempt starts from there with a fresh run/grant
 * (ADR-0007: human disposition is required before another attempt). Terminal
 * states have no outgoing edges.
 */
export const PRODUCT_TRANSITIONS: Record<ProductState, readonly ProductState[]> = {
  triage: ["planning", "needs_human", "cancelled"],
  planning: ["implementing", "needs_human", "cancelled"],
  implementing: ["validating", "needs_human", "cancelled"],
  validating: ["awaiting_change_approval", "needs_human", "cancelled"],
  awaiting_change_approval: ["delivering", "implementing", "needs_human", "cancelled"],
  delivering: ["pr_review", "needs_human", "cancelled"],
  pr_review: ["completed", "needs_human", "cancelled"],
  completed: [],
  needs_human: ["triage", "planning", "implementing", "cancelled"],
  cancelled: [],
};

export function canTransitionProduct(from: ProductState, to: ProductState): boolean {
  return PRODUCT_TRANSITIONS[from].includes(to);
}

/** Terminal product states: no outgoing edge exists. */
export function isTerminalProductState(state: ProductState): boolean {
  return PRODUCT_TRANSITIONS[state].length === 0;
}

/**
 * Harness (FP-01) run-state table, mirrored from `harness/state.go`.
 *
 * The collaboration layer only records observed dsh transitions; dsh remains
 * the execution gate. This mirror exists so a replayed or out-of-order
 * observation can never move a run across an edge FP-01 does not allow.
 * `stopped -> approved` is permitted only with a new capability grant (enforced
 * by the machine, see `machine.ts`). Terminal states have no outgoing edges: a
 * later attempt is a new run id that begins in `requested`.
 */
export const RUN_STATE_TRANSITIONS: Record<DshState, readonly DshState[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["running", "cancelled", "expired"],
  running: ["awaiting_review", "stopped", "timed_out", "cancelled"],
  awaiting_review: ["approved_for_merge", "stopped", "cancelled"],
  approved_for_merge: ["merged", "stopped"],
  stopped: ["cancelled", "approved"],
  timed_out: [],
  expired: [],
  rejected: [],
  cancelled: [],
  merged: [],
};

export function canTransitionRun(from: DshState, to: DshState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to);
}

/** Terminal harness states: the grant is finished and never resumes. */
export function isTerminalRunState(state: DshState): boolean {
  return RUN_STATE_TRANSITIONS[state].length === 0;
}

/** Harness states in which a run holds (or held) a repository mutation path. */
export const PR_RUN_STATES = ["awaiting_review", "approved_for_merge"] as const;

export interface RunView {
  state: DshState;
  artifact_refs: readonly { kind: string }[];
}

export interface ProductRelation {
  /** Harness states that must appear on at least one run of the issue. */
  require: readonly DshState[];
  /** Harness states no run of the issue may be in when entering the state. */
  forbid: readonly DshState[];
  /** The issue may hold no run at all (triage). */
  noRuns?: boolean;
  /**
   * At least one `stopped` run must preserve a `candidate` artifact reference:
   * local preparation finished and its candidate survived the grant revocation.
   */
  requireCandidate?: boolean;
}

/**
 * Product-state versus harness-state relation.
 *
 * This is where the two vocabularies are explicitly kept apart:
 * `awaiting_change_approval` forbids every PR-bearing harness state and only
 * accepts a stopped preparation run, while `pr_review` requires one. Entering
 * `completed` requires a merged run — a published PR alone is never completion.
 */
export const PRODUCT_RUN_RELATION: Record<ProductState, ProductRelation> = {
  triage: { require: [], forbid: [], noRuns: true },
  planning: { require: [], forbid: ["awaiting_review", "approved_for_merge", "merged"] },
  implementing: { require: [], forbid: ["awaiting_review", "approved_for_merge", "merged"] },
  validating: { require: [], forbid: ["awaiting_review", "approved_for_merge", "merged"] },
  awaiting_change_approval: {
    require: [],
    forbid: ["awaiting_review", "approved_for_merge", "merged"],
    requireCandidate: true,
  },
  delivering: { require: [], forbid: ["awaiting_review", "approved_for_merge", "merged"] },
  pr_review: { require: ["awaiting_review", "approved_for_merge"], forbid: [] },
  completed: { require: ["merged"], forbid: [] },
  needs_human: { require: [], forbid: ["awaiting_review", "approved_for_merge", "merged"] },
  cancelled: { require: [], forbid: ["awaiting_review", "approved_for_merge", "merged"] },
};

export interface ProductConflict {
  code: "PRODUCT_HARNESS_CONFLICT";
  message: string;
  details: Record<string, unknown>;
}

/**
 * Check one product state against the harness states of the issue's runs.
 * Returns null when consistent, otherwise the conflict to deny with.
 */
export function productRunConflict(
  productState: ProductState,
  runs: readonly RunView[],
): ProductConflict | null {
  const relation = PRODUCT_RUN_RELATION[productState];
  if (relation.noRuns === true && runs.length > 0) {
    return {
      code: "PRODUCT_HARNESS_CONFLICT",
      message: `product state ${productState} holds no runs`,
      details: { product_state: productState, run_states: runs.map((run) => run.state) },
    };
  }
  for (const run of runs) {
    if (relation.forbid.includes(run.state)) {
      return {
        code: "PRODUCT_HARNESS_CONFLICT",
        message: `harness state ${run.state} cannot coexist with product state ${productState}`,
        details: { product_state: productState, harness_state: run.state },
      };
    }
  }
  if (relation.require.length > 0 && !runs.some((run) => relation.require.includes(run.state))) {
    return {
      code: "PRODUCT_HARNESS_CONFLICT",
      message: `product state ${productState} requires a run in [${relation.require.join(", ")}]`,
      details: { product_state: productState, required: relation.require },
    };
  }
  if (
    relation.requireCandidate === true &&
    !runs.some(
      (run) => run.state === "stopped" && run.artifact_refs.some((ref) => ref.kind === "candidate"),
    )
  ) {
    return {
      code: "PRODUCT_HARNESS_CONFLICT",
      message: "awaiting_change_approval requires a stopped run preserving a candidate artifact",
      details: { product_state: productState },
    };
  }
  return null;
}

/**
 * Issue-product-state gate for run observations that only exist once a provider
 * PR is in play. Recording harness `awaiting_review` while the issue is in
 * `awaiting_change_approval` is exactly the confusion ADR-0007 forbids, so it
 * is denied here as well as in `productRunConflict`.
 */
export function runTransitionIssueConflict(
  to: DshState,
  productState: ProductState,
): ProductConflict | null {
  const allowed: Record<string, readonly ProductState[]> = {
    awaiting_review: ["delivering", "pr_review"],
    approved_for_merge: ["pr_review"],
    merged: ["pr_review"],
  };
  const permitted = allowed[to];
  if (permitted !== undefined && !permitted.includes(productState)) {
    return {
      code: "PRODUCT_HARNESS_CONFLICT",
      message: `harness state ${to} is inconsistent with product state ${productState}`,
      details: { harness_state: to, product_state: productState, permitted },
    };
  }
  return null;
}
