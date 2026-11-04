/**
 * Strict distillation output schema (DAT-233).
 *
 * The extractor emits one JSON object of candidate facts, lessons, playbooks,
 * and anti-patterns. The TypeBox schema below is the descriptive contract
 * shown to the model; the actual gate is `parseDistillationOutput`, which
 * re-checks everything server-side in the DAT-193 tradition: closed keys at
 * every level, closed vocabularies, bounded strings and cardinalities, and at
 * least one stated precondition per candidate. Anything else is rejected —
 * there is no partial or lenient parse.
 *
 * Evidence citations are deliberately allowed to be empty here: an
 * evidence-less candidate is *dropped* later with a recorded reason, so the
 * ledger — not the schema — decides what counts as attributable.
 */

import { Type } from "typebox";
import type { Static } from "typebox";

import { ValidationError } from "../control-plane/errors.js";
import {
  DISTILL_CANDIDATES_MAX,
  DISTILL_EVIDENCE_MAX,
  DISTILL_KINDS,
  DISTILL_PRECONDITION_MAX,
  DISTILL_PRECONDITIONS_MAX,
  DISTILL_SCOPE_FIELD_MAX,
  DISTILL_STATEMENT_MAX,
  OUTCOME_EVIDENCE_TYPES,
  OUTCOME_REFERENCE_MAX,
} from "./types.js";
import type {
  CandidateEvidenceRef,
  DistillKind,
  DistillScope,
  DistillationCandidate,
  DistillationOutput,
  OutcomeEvidenceType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Descriptive schema (shown to the model)
// ---------------------------------------------------------------------------

export const candidateEvidenceSchema = Type.Object(
  {
    evidence_type: Type.Enum(OUTCOME_EVIDENCE_TYPES, {
      description: "Kind of captured evidence reference, from the closed list.",
    }),
    reference: Type.String({
      minLength: 1,
      maxLength: OUTCOME_REFERENCE_MAX,
      description: "Exact reference as listed in the captured evidence. Never invented.",
    }),
  },
  { additionalProperties: false },
);

export const distillationCandidateSchema = Type.Object(
  {
    kind: Type.Enum(DISTILL_KINDS, {
      description: "Candidate kind, from the closed list. Episodes capture; policy never learns.",
    }),
    statement: Type.String({
      minLength: 1,
      maxLength: DISTILL_STATEMENT_MAX,
      description: "The durable fact, lesson, ordered playbook steps, or anti-pattern.",
    }),
    preconditions: Type.Array(Type.String({ minLength: 1, maxLength: DISTILL_PRECONDITION_MAX }), {
      minItems: 1,
      maxItems: DISTILL_PRECONDITIONS_MAX,
      description: "When the item applies. At least one; never omitted.",
    }),
    scope: Type.Optional(
      Type.Object(
        {
          team_id: Type.Optional(Type.String({ maxLength: DISTILL_SCOPE_FIELD_MAX })),
          path_prefix: Type.Optional(Type.String({ maxLength: DISTILL_SCOPE_FIELD_MAX })),
          language: Type.Optional(Type.String({ maxLength: DISTILL_SCOPE_FIELD_MAX })),
          task_family: Type.Optional(Type.String({ maxLength: DISTILL_SCOPE_FIELD_MAX })),
        },
        { additionalProperties: false },
      ),
    ),
    evidence: Type.Array(candidateEvidenceSchema, {
      minItems: 0,
      maxItems: DISTILL_EVIDENCE_MAX,
      description: "At least one captured evidence citation is required to keep the candidate.",
    }),
  },
  { additionalProperties: false },
);

export const distillationOutputSchema = Type.Object(
  {
    candidates: Type.Array(distillationCandidateSchema, { maxItems: DISTILL_CANDIDATES_MAX }),
  },
  { additionalProperties: false },
);

export type DistillationOutputParams = Static<typeof distillationOutputSchema>;

// ---------------------------------------------------------------------------
// Server-side gate
// ---------------------------------------------------------------------------

const OUTPUT_KEYS = new Set(["candidates"]);
const CANDIDATE_KEYS = new Set(["kind", "statement", "preconditions", "scope", "evidence"]);
const SCOPE_KEYS = new Set(["team_id", "path_prefix", "language", "task_family"]);
const EVIDENCE_KEYS = new Set(["evidence_type", "reference"]);

function strictObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`distillation ${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`distillation ${label} carries unknown field ${key}`);
    }
  }
  return record;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`distillation ${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new ValidationError(`distillation ${field} must not exceed ${max} characters`);
  }
  return value;
}

function parseScope(value: unknown): DistillScope {
  const record = strictObject(value, SCOPE_KEYS, "scope");
  const scope: DistillScope = {};
  for (const key of SCOPE_KEYS) {
    const entry = record[key];
    if (entry === undefined) continue;
    scope[key as keyof DistillScope] = boundedString(
      entry,
      `scope.${key}`,
      DISTILL_SCOPE_FIELD_MAX,
    );
  }
  return scope;
}

function parseEvidence(value: unknown, index: number): CandidateEvidenceRef {
  const record = strictObject(value, EVIDENCE_KEYS, `evidence[${index}]`);
  const evidenceType = record["evidence_type"];
  if (
    typeof evidenceType !== "string" ||
    !(OUTCOME_EVIDENCE_TYPES as readonly string[]).includes(evidenceType)
  ) {
    throw new ValidationError("distillation evidence_type must be one of the closed list");
  }
  return {
    evidence_type: evidenceType as OutcomeEvidenceType,
    reference: boundedString(
      record["reference"],
      `evidence[${index}].reference`,
      OUTCOME_REFERENCE_MAX,
    ),
  };
}

function parseCandidate(value: unknown, index: number): DistillationCandidate {
  const record = strictObject(value, CANDIDATE_KEYS, `candidates[${index}]`);
  const kind = record["kind"];
  if (typeof kind !== "string" || !(DISTILL_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `distillation candidates[${index}].kind must be one of ${DISTILL_KINDS.join(", ")}`,
    );
  }
  const preconditions = record["preconditions"];
  if (
    !Array.isArray(preconditions) ||
    preconditions.length < 1 ||
    preconditions.length > DISTILL_PRECONDITIONS_MAX
  ) {
    throw new ValidationError(
      `distillation candidates[${index}].preconditions must state 1-${DISTILL_PRECONDITIONS_MAX} entries`,
    );
  }
  const evidence = record["evidence"];
  if (!Array.isArray(evidence) || evidence.length > DISTILL_EVIDENCE_MAX) {
    throw new ValidationError(
      `distillation candidates[${index}].evidence must be an array of at most ${DISTILL_EVIDENCE_MAX} entries`,
    );
  }
  return {
    kind: kind as DistillKind,
    statement: boundedString(
      record["statement"],
      `candidates[${index}].statement`,
      DISTILL_STATEMENT_MAX,
    ),
    preconditions: preconditions.map((entry, position) =>
      boundedString(
        entry,
        `candidates[${index}].preconditions[${position}]`,
        DISTILL_PRECONDITION_MAX,
      ),
    ),
    scope: record["scope"] === undefined ? {} : parseScope(record["scope"]),
    evidence: evidence.map((entry, position) => parseEvidence(entry, position)),
  };
}

/**
 * Parse one extractor response. The model's text is never trusted: JSON shape,
 * key sets, vocabularies, lengths, and cardinalities are all re-checked here.
 * A response that fails any check is rejected as a whole.
 */
export function parseDistillationOutput(text: string): DistillationOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("distillation output must be valid JSON");
  }
  const record = strictObject(parsed, OUTPUT_KEYS, "output");
  const candidates = record["candidates"];
  if (!Array.isArray(candidates) || candidates.length > DISTILL_CANDIDATES_MAX) {
    throw new ValidationError(
      `distillation candidates must be an array of at most ${DISTILL_CANDIDATES_MAX} entries`,
    );
  }
  return {
    candidates: candidates.map((entry, index) => parseCandidate(entry, index)),
  };
}
