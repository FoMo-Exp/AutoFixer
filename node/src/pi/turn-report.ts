import { Type } from "typebox";
import type { Static } from "typebox";

/**
 * Structured Pi turn report (DAT-193 trusted source).
 *
 * This is the only channel through which a settled Pi turn can produce
 * displayable natural-language text. Its trust chain, as ruled by the
 * Architect on DAT-193:
 *
 * 1. The model reports the work of one turn through a strict schema whose
 *    parameters are closed enums — there is no free-text field and no
 *    parameter that could carry a command, token, path, or log.
 * 2. Node validates the report against the same closed vocabulary in the
 *    tool's `execute` (the provider-side schema is descriptive only, so
 *    membership, count limits, and shape are re-checked server-side) and
 *    records it only when it is valid. Unknown, missing, or invalid reports
 *    are never rendered: the turn fails closed as it would with no report.
 * 3. The displayed text is composed by Node from fixed phrases in this
 *    module — the model never supplies displayable words — and is framed as
 *    Pi's own report ("Pi reported that it …"), not as an independently
 *    verified fact.
 * 4. The rendered text is additionally run through the DAT-192 classifier
 *    as defence in depth; a hit withholds it. The classifier can only ever
 *    add a rejection here, never create an allowance.
 *
 * No additional model, external network call, widened permission, or
 * activity-count substitute is involved: the report tool executes nothing
 * (it records a report), and the vocabulary describes concrete work
 * (what was done, to which part of the work, with which outcome), not run
 * status or action counters.
 */

/** Tool name registered on the Pi session alongside `dsh_request_action`. */
export const TURN_REPORT_TOOL_NAME = "report_turn_summary";

/** Parts of the work a report can name; each maps to a fixed display phrase. */
export const TURN_REPORT_AREAS = [
  "manifest",
  "lockfile",
  "source",
  "tests",
  "documentation",
  "configuration",
  "ci",
  "types",
  "build",
  "dependencies",
  "contracts",
  "fixtures",
] as const;

/** What the agent did to the named parts; each maps to a fixed display phrase. */
export const TURN_REPORT_ACTIVITIES = [
  "inspected",
  "updated",
  "added",
  "removed",
  "fixed",
  "verified",
  "reproduced",
  "documented",
  "refactored",
  "migrated",
] as const;

/** How the agent judged the turn's work; each maps to a fixed display clause. */
export const TURN_REPORT_OUTCOMES = [
  "ready_for_review",
  "needs_approval",
  "blocked",
  "failed",
  "completed",
] as const;

export type TurnReportArea = (typeof TURN_REPORT_AREAS)[number];
export type TurnReportActivity = (typeof TURN_REPORT_ACTIVITIES)[number];
export type TurnReportOutcome = (typeof TURN_REPORT_OUTCOMES)[number];

/** One validated structured report for a single settled turn. */
export interface TurnReport {
  areas: TurnReportArea[];
  activities: TurnReportActivity[];
  outcome: TurnReportOutcome;
}

/** Bounded cardinality keeps the rendered sentence short and reviewable. */
export const TURN_REPORT_MAX_ITEMS = 3;

/**
 * Strict schema shown to the model. Every parameter is a closed enum (or an
 * array of one): no free text, no path, no command-shaped argument.
 */
export const turnReportSchema = Type.Object({
  areas: Type.Array(Type.Enum(TURN_REPORT_AREAS), {
    minItems: 1,
    maxItems: TURN_REPORT_MAX_ITEMS,
    description:
      "Which parts of the work this turn touched, from the closed list. " +
      "Keys only, never free text.",
  }),
  activities: Type.Array(Type.Enum(TURN_REPORT_ACTIVITIES), {
    minItems: 1,
    maxItems: TURN_REPORT_MAX_ITEMS,
    description:
      "What this turn did to those parts, from the closed list. " + "Keys only, never free text.",
  }),
  outcome: Type.Enum(TURN_REPORT_OUTCOMES, {
    description: "How this turn's work ended, from the closed list.",
  }),
});

export type TurnReportParams = Static<typeof turnReportSchema>;

const AREA_PHRASES: Record<TurnReportArea, string> = {
  manifest: "the package manifest",
  lockfile: "the lockfile",
  source: "the source files",
  tests: "the tests",
  documentation: "the documentation",
  configuration: "the configuration",
  ci: "the CI workflow",
  types: "the type declarations",
  build: "the build setup",
  dependencies: "the dependency list",
  contracts: "the API contract",
  fixtures: "the test fixtures",
};

const ACTIVITY_PHRASES: Record<TurnReportActivity, string> = {
  inspected: "inspected",
  updated: "updated",
  added: "added",
  removed: "removed",
  fixed: "fixed",
  verified: "verified",
  reproduced: "reproduced",
  documented: "documented",
  refactored: "refactored",
  migrated: "migrated",
};

const OUTCOME_PHRASES: Record<TurnReportOutcome, string> = {
  ready_for_review: "the change is ready for review",
  needs_approval: "the work needs human approval",
  blocked: "the work is blocked",
  failed: "the work did not complete",
  completed: "the work is complete",
};

function isTurnReportArea(value: unknown): value is TurnReportArea {
  return typeof value === "string" && (TURN_REPORT_AREAS as readonly string[]).includes(value);
}

function isTurnReportActivity(value: unknown): value is TurnReportActivity {
  return typeof value === "string" && (TURN_REPORT_ACTIVITIES as readonly string[]).includes(value);
}

function isTurnReportOutcome(value: unknown): value is TurnReportOutcome {
  return typeof value === "string" && (TURN_REPORT_OUTCOMES as readonly string[]).includes(value);
}

function isBoundedUniqueList(
  value: unknown,
  isMember: (item: unknown) => boolean,
): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= TURN_REPORT_MAX_ITEMS &&
    value.every(isMember) &&
    new Set(value).size === value.length
  );
}

const ALLOWED_REPORT_KEYS = new Set(["areas", "activities", "outcome"]);

/**
 * Server-side validation of one report. The provider-side schema is only
 * descriptive — nothing in the agent loop enforces it — so this is the
 * actual gate: shape, membership, cardinality, uniqueness, and no keys
 * outside the vocabulary, all against the closed lists. Anything else
 * returns null and is never recorded.
 */
export function validateTurnReport(params: unknown): TurnReport | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  const candidate = params as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !ALLOWED_REPORT_KEYS.has(key))) {
    return null;
  }
  const areas = candidate["areas"];
  const activities = candidate["activities"];
  const outcome = candidate["outcome"];
  if (!isBoundedUniqueList(areas, isTurnReportArea)) {
    return null;
  }
  if (!isBoundedUniqueList(activities, isTurnReportActivity)) {
    return null;
  }
  if (!isTurnReportOutcome(outcome)) {
    return null;
  }
  return {
    areas: areas as TurnReportArea[],
    activities: activities as TurnReportActivity[],
    outcome,
  };
}

/** English list: `a`, `a and b`, `a, b, and c`. */
function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length === 1) {
    return phrases[0] ?? "";
  }
  if (phrases.length === 2) {
    return `${phrases[0]} and ${phrases[1]}`;
  }
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/**
 * Render one validated report with fixed wording.
 *
 * The whole sentence is framed as Pi's own report — the model chose the
 * closed-vocabulary labels; Node wrote every displayed word. Output is
 * bounded by the enum cardinalities (well under the contract's 240-char
 * bound) and contains only the fixed phrases above.
 */
export function renderTurnReport(report: TurnReport): string {
  const activities = joinPhrases(report.activities.map((activity) => ACTIVITY_PHRASES[activity]));
  const areas = joinPhrases(report.areas.map((area) => AREA_PHRASES[area]));
  const outcome = OUTCOME_PHRASES[report.outcome];
  return `Pi reported that it ${activities} ${areas} and that ${outcome}.`;
}
