/**
 * OpenAPI contract for bounded RSI (DAT-238).
 *
 * Mounted under the workspace memory surface. The holdout is represented by
 * an aggregate counter only: no operation returns its case content, and the
 * evaluation request accepts a verifier identity but never a score. The
 * contract is kept beside the implementation so closed vocabularies come from
 * the same constants the service enforces.
 */

import type { JsonObject } from "./openapi-types.js";
import {
  RSI_APPROVAL_KEYS,
  RSI_CANARY_STAGES,
  RSI_DATASETS,
  RSI_PROPOSAL_STATUSES,
  RSI_PROPOSER_KINDS,
  RSI_RISKS,
  RSI_ROLLOUT_STATUSES,
  RSI_TARGETS,
  RSI_VERIFIER_KINDS,
} from "../memory/rsi/index.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

const RSI_DESCRIPTION =
  "RSI is a governed feedback loop over memory artifacts and retrieval policy. " +
  "Only class A and C retrieval-policy changes and class B memory-item changes " +
  "may be proposed; class D targets (capability grants, approval rules, " +
  "evidence schema, evaluation definitions, safety policy, merge/deploy) are " +
  "rejected. Evaluation runs the offline replay itself and computes the " +
  "confidence interval: the caller cannot submit a score. The hidden holdout " +
  "contributes only aggregate sample counts. The workspace kill switch stops " +
  "all RSI actions immediately and rolls back an active canary.";

const artifactSchema: JsonObject = {
  type: "object",
  required: ["kind", "baseline_policy_version", "candidate_policy_hash", "item_id", "item_version"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["retrieval_policy", "memory_item"] },
    baseline_policy_version: { type: "integer", minimum: 1 },
    candidate_policy_hash: { type: ["string", "null"] },
    item_id: { type: ["string", "null"] },
    item_version: { type: ["integer", "null"] },
  },
};

const proposerSchema: JsonObject = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: [...RSI_PROPOSER_KINDS] },
    model: { type: "string" },
  },
};

const evaluationSchema: JsonObject = {
  type: "object",
  required: [
    "evaluation_id",
    "proposal_id",
    "proposal_version",
    "dataset",
    "holdout_used",
    "sample_size",
    "baseline_sample_size",
    "candidate_sample_size",
    "baseline_successes",
    "candidate_successes",
    "baseline_rework",
    "candidate_rework",
    "baseline_cost",
    "candidate_cost",
    "safety_events",
    "success_delta",
    "delta_ci_low",
    "delta_ci_high",
    "verdict",
    "verifier",
    "policy_version",
    "policy_hash",
    "memory_version",
    "reflection_tokens",
    "created_at",
    "created_by",
  ],
  additionalProperties: false,
  properties: {
    evaluation_id: { type: "string" },
    proposal_id: { type: "string" },
    proposal_version: { type: "integer", minimum: 1 },
    dataset: { type: "string", enum: [...RSI_DATASETS] },
    holdout_used: { type: "boolean" },
    sample_size: { type: "integer", minimum: 0 },
    baseline_sample_size: { type: "integer", minimum: 0 },
    candidate_sample_size: { type: "integer", minimum: 0 },
    baseline_successes: { type: "integer", minimum: 0 },
    candidate_successes: { type: "integer", minimum: 0 },
    baseline_rework: { type: "integer", minimum: 0 },
    candidate_rework: { type: "integer", minimum: 0 },
    baseline_cost: { type: "number", minimum: 0 },
    candidate_cost: { type: "number", minimum: 0 },
    safety_events: { type: "integer", minimum: 0 },
    success_delta: { type: "number" },
    delta_ci_low: { type: "number" },
    delta_ci_high: { type: "number" },
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    verifier: {
      type: "object",
      required: ["kind", "id", "reference"],
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: [...RSI_VERIFIER_KINDS],
          description:
            "The server-run replay is the only verifier; agent self-report is not a kind.",
        },
        id: { type: "string" },
        reference: { type: "string" },
      },
    },
    policy_version: { type: "integer", minimum: 1 },
    policy_hash: { type: "string" },
    memory_version: { type: "string" },
    reflection_tokens: { type: "integer", minimum: 0 },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "string" },
  },
};

const approvalSchema: JsonObject = {
  type: "object",
  required: [
    "approval_id",
    "proposal_id",
    "proposal_version",
    "approval_key",
    "approver_id",
    "role",
    "note",
    "created_at",
  ],
  additionalProperties: false,
  properties: {
    approval_id: { type: "string" },
    proposal_id: { type: "string" },
    proposal_version: { type: "integer", minimum: 1 },
    approval_key: { type: "string", enum: [...RSI_APPROVAL_KEYS] },
    approver_id: { type: "string" },
    role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
    note: { type: ["string", "null"] },
    created_at: { type: "string", format: "date-time" },
  },
};

const rolloutSchema: JsonObject = {
  type: "object",
  required: [
    "rollout_id",
    "proposal_id",
    "stage",
    "status",
    "baseline_policy_version",
    "candidate_hash",
    "reason",
    "started_at",
    "ended_at",
    "updated_at",
  ],
  additionalProperties: false,
  properties: {
    rollout_id: { type: "string" },
    proposal_id: { type: "string" },
    stage: { type: "integer", enum: [...RSI_CANARY_STAGES] },
    status: { type: "string", enum: [...RSI_ROLLOUT_STATUSES] },
    baseline_policy_version: { type: "integer", minimum: 1 },
    candidate_hash: { type: "string" },
    reason: { type: ["string", "null"] },
    started_at: { type: "string", format: "date-time" },
    ended_at: { type: ["string", "null"], format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const gateSchema: JsonObject = {
  type: "object",
  required: [
    "offline_evaluation",
    "holdout_required",
    "approvals_required",
    "approvals_satisfied",
    "approval_keys",
    "budget_ok",
    "kill_switch",
    "canary_eligible",
    "reasons",
  ],
  additionalProperties: false,
  properties: {
    offline_evaluation: { type: "string", enum: ["missing", "pass", "fail"] },
    holdout_required: { type: "boolean" },
    approvals_required: { type: "integer", minimum: 0 },
    approvals_satisfied: { type: "integer", minimum: 0 },
    approval_keys: { type: "array", items: { type: "string", enum: [...RSI_APPROVAL_KEYS] } },
    budget_ok: { type: "boolean" },
    kill_switch: { type: "boolean" },
    canary_eligible: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
  },
};

const observationSchema: JsonObject = {
  type: "object",
  required: [
    "observation_id",
    "rollout_id",
    "stage",
    "sample_size",
    "baseline_sample_size",
    "candidate_sample_size",
    "baseline_successes",
    "candidate_successes",
    "baseline_rework",
    "candidate_rework",
    "baseline_cost",
    "candidate_cost",
    "safety_events",
    "success_delta",
    "delta_ci_low",
    "delta_ci_high",
    "verdict",
    "evidence_reference",
    "created_at",
    "created_by",
  ],
  additionalProperties: false,
  description:
    "One canary stage sample derived from pinned runs and their terminal task " +
    "outcomes. Evidence is the server-generated pin set, never request text.",
  properties: {
    observation_id: { type: "string" },
    rollout_id: { type: "string" },
    stage: { type: "integer", enum: [...RSI_CANARY_STAGES] },
    sample_size: { type: "integer", minimum: 0 },
    baseline_sample_size: { type: "integer", minimum: 0 },
    candidate_sample_size: { type: "integer", minimum: 0 },
    baseline_successes: { type: "integer", minimum: 0 },
    candidate_successes: { type: "integer", minimum: 0 },
    baseline_rework: { type: "integer", minimum: 0 },
    candidate_rework: { type: "integer", minimum: 0 },
    baseline_cost: { type: "number", minimum: 0 },
    candidate_cost: { type: "number", minimum: 0 },
    safety_events: { type: "integer", minimum: 0 },
    success_delta: { type: "number" },
    delta_ci_low: { type: "number" },
    delta_ci_high: { type: "number" },
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    evidence_reference: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "string" },
  },
};

const proposalSchema: JsonObject = {
  type: "object",
  required: [
    "proposal_id",
    "title",
    "summary",
    "diff",
    "target",
    "risk",
    "status",
    "status_reason",
    "artifact",
    "proposer",
    "baseline_policy_version",
    "baseline_memory_version",
    "applied_policy_version",
    "version",
    "created_at",
    "created_by",
    "evaluations",
    "approvals",
    "rollout",
    "observations",
    "gate",
  ],
  additionalProperties: false,
  properties: {
    proposal_id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    diff: { type: "string" },
    target: { type: "string", enum: [...RSI_TARGETS] },
    risk: { type: "string", enum: [...RSI_RISKS] },
    status: { type: "string", enum: [...RSI_PROPOSAL_STATUSES] },
    status_reason: { type: ["string", "null"] },
    artifact: { $ref: "#/components/schemas/RsiArtifact" },
    proposer: { $ref: "#/components/schemas/RsiProposer" },
    baseline_policy_version: { type: "integer", minimum: 1 },
    baseline_memory_version: { type: "string" },
    applied_policy_version: { type: ["integer", "null"] },
    version: { type: "integer", minimum: 1 },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "string" },
    evaluations: { type: "array", items: { $ref: "#/components/schemas/RsiEvaluation" } },
    approvals: { type: "array", items: { $ref: "#/components/schemas/RsiApproval" } },
    rollout: {
      oneOf: [{ $ref: "#/components/schemas/RsiRollout" }, { type: "null" }],
    },
    observations: {
      type: "array",
      items: { $ref: "#/components/schemas/RsiCanaryObservation" },
    },
    gate: { $ref: "#/components/schemas/RsiGate" },
  },
};

const proposalListSchema: JsonObject = {
  type: "object",
  required: ["proposals"],
  additionalProperties: false,
  properties: {
    proposals: { type: "array", items: { $ref: "#/components/schemas/RsiProposal" } },
  },
};

const controlsSchema: JsonObject = {
  type: "object",
  required: [
    "kill_switch",
    "kill_switch_reason",
    "kill_switch_changed_at",
    "kill_switch_changed_by",
    "auto_promote_low_risk",
    "weekly_change_budget",
    "weekly_reflection_token_budget",
    "updated_at",
    "updated_by",
  ],
  additionalProperties: false,
  properties: {
    kill_switch: { type: "boolean" },
    kill_switch_reason: { type: ["string", "null"] },
    kill_switch_changed_at: { type: ["string", "null"], format: "date-time" },
    kill_switch_changed_by: { type: ["string", "null"] },
    auto_promote_low_risk: { type: "boolean" },
    weekly_change_budget: { type: "integer", minimum: 0 },
    weekly_reflection_token_budget: { type: "integer", minimum: 0 },
    updated_at: { type: ["string", "null"], format: "date-time" },
    updated_by: { type: ["string", "null"] },
  },
};

const budgetSchema: JsonObject = {
  type: "object",
  required: [
    "week_start",
    "weekly_change_budget",
    "changes_promoted",
    "changes_remaining",
    "weekly_reflection_token_budget",
    "reflection_tokens_used",
    "reflection_tokens_remaining",
  ],
  additionalProperties: false,
  properties: {
    week_start: { type: "string", description: "Monday of the ISO week (YYYY-MM-DD, UTC)." },
    weekly_change_budget: { type: "integer", minimum: 0 },
    changes_promoted: { type: "integer", minimum: 0 },
    changes_remaining: { type: "integer", minimum: 0 },
    weekly_reflection_token_budget: { type: "integer", minimum: 0 },
    reflection_tokens_used: { type: "integer", minimum: 0 },
    reflection_tokens_remaining: { type: "integer", minimum: 0 },
  },
};

const holdoutSchema: JsonObject = {
  type: "object",
  required: ["cases", "last_evaluated_at"],
  additionalProperties: false,
  properties: {
    cases: {
      type: "integer",
      minimum: 0,
      description: "Aggregate count only; holdout case content is never exposed.",
    },
    last_evaluated_at: { type: ["string", "null"], format: "date-time" },
  },
};

const statusSchema: JsonObject = {
  type: "object",
  required: ["contract_version", "controls", "budget", "holdout", "active_rollout", "proposals"],
  additionalProperties: false,
  properties: {
    contract_version: { type: "integer", minimum: 1 },
    controls: { $ref: "#/components/schemas/RsiControls" },
    budget: { $ref: "#/components/schemas/RsiBudget" },
    holdout: { $ref: "#/components/schemas/RsiHoldoutStatus" },
    active_rollout: {
      oneOf: [{ $ref: "#/components/schemas/RsiRollout" }, { type: "null" }],
    },
    proposals: {
      type: "object",
      additionalProperties: false,
      required: [...RSI_PROPOSAL_STATUSES],
      properties: Object.fromEntries(
        RSI_PROPOSAL_STATUSES.map((status) => [status, { type: "integer", minimum: 0 }]),
      ),
    },
  },
};

const createProposalRequestSchema: JsonObject = {
  type: "object",
  required: ["title", "summary", "diff", "target"],
  additionalProperties: false,
  description:
    "The proposer is the session user and the risk is derived from the target; " +
    "neither may be sent. A retrieval-policy target carries `candidate_policy`; " +
    "a memory-item target carries `memory_item` referencing a candidate version.",
  properties: {
    title: { type: "string", maxLength: 160 },
    summary: { type: "string", maxLength: 2000 },
    diff: { type: "string", maxLength: 20000 },
    target: { type: "string", enum: [...RSI_TARGETS] },
    candidate_policy: {
      type: "object",
      description:
        "Complete candidate retrieval policy. Validated against the same hard " +
        "ceilings as a stored policy and unpublished until promotion.",
    },
    memory_item: {
      type: "object",
      additionalProperties: false,
      required: ["item_id", "item_version"],
      properties: {
        item_id: { type: "string" },
        item_version: { type: "integer", minimum: 1 },
      },
    },
  },
};

const evaluationRequestSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  description:
    "Selects datasets only. The replay, its per-arm samples, delta, confidence " +
    "interval, and verifier identity are computed or bound server-side; a " +
    "request that carries metrics, a verifier claim, or evidence text is refused.",
  properties: {
    datasets: {
      type: "array",
      items: { type: "string", enum: [...RSI_DATASETS] },
      description: "Defaults to both datasets; the canary gate requires both.",
    },
  },
};

const controlsRequestSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    auto_promote_low_risk: { type: "boolean" },
    weekly_change_budget: { type: "integer", minimum: 0 },
    weekly_reflection_token_budget: { type: "integer", minimum: 0 },
  },
};

const controlsResponseSchema: JsonObject = {
  type: "object",
  required: ["controls"],
  additionalProperties: false,
  properties: { controls: { $ref: "#/components/schemas/RsiControls" } },
};

export const RSI_OPENAPI_SCHEMAS: Record<string, unknown> = {
  RsiArtifact: artifactSchema,
  RsiProposer: proposerSchema,
  RsiEvaluation: evaluationSchema,
  RsiApproval: approvalSchema,
  RsiRollout: rolloutSchema,
  RsiCanaryObservation: observationSchema,
  RsiGate: gateSchema,
  RsiProposal: proposalSchema,
  RsiProposalList: proposalListSchema,
  RsiControls: controlsSchema,
  RsiBudget: budgetSchema,
  RsiHoldoutStatus: holdoutSchema,
  RsiStatus: statusSchema,
  RsiCreateProposalRequest: createProposalRequestSchema,
  RsiEvaluationRequest: evaluationRequestSchema,
  RsiControlsRequest: controlsRequestSchema,
  RsiControlsResponse: controlsResponseSchema,
};

const SESSION_NOTE =
  "Requires a web/desktop session and derives enterprise/workspace scope from " + "membership. ";

const workspaceIdParameter: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Workspace the caller is a member of; resolved from the session.",
};

const proposalIdParameter: JsonObject = {
  name: "proposal_id",
  in: "path",
  required: true,
  schema: { type: "string" },
};

function proposalResponse(description: string): JsonObject {
  return { description, ...jsonRef("#/components/schemas/RsiProposal") };
}

export function rsiOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/api/v1/workspaces/{workspace_id}/memory/proposals": {
      get: {
        operationId: "listRsiProposals",
        summary: "List bounded RSI proposals",
        description: `${SESSION_NOTE}${RSI_DESCRIPTION} Bounded list, newest first.`,
        parameters: [
          workspaceIdParameter,
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...RSI_PROPOSAL_STATUSES] },
          },
          {
            name: "risk",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...RSI_RISKS] },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
        ],
        responses: {
          200: {
            description: "Bounded proposal list",
            ...jsonRef("#/components/schemas/RsiProposalList"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
      post: {
        operationId: "createRsiProposal",
        summary: "Open a governed RSI proposal",
        description:
          `${SESSION_NOTE}${RSI_DESCRIPTION} A class D target is rejected; the ` +
          "proposer is the authenticated user and is recorded as such.",
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RsiCreateProposalRequest" },
            },
          },
        },
        responses: {
          201: proposalResponse("Proposal created"),
          400: errorResponse("INVALID_REQUEST — including a class D target or a scope claim"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("CONFLICT — the RSI kill switch is active"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}": {
      get: {
        operationId: "getRsiProposal",
        summary: "Proposal detail with evaluations, approvals, rollout, and gate",
        description:
          `${SESSION_NOTE}${RSI_DESCRIPTION} The holdout contributes an aggregate ` +
          "counter only; its case content is not part of this payload.",
        parameters: [workspaceIdParameter, proposalIdParameter],
        responses: {
          200: proposalResponse("Proposal detail"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/evaluations": {
      post: {
        operationId: "evaluateRsiProposal",
        summary: "Run the offline replay over the golden set and hidden holdout",
        description:
          `${SESSION_NOTE}Workspace owner only. The server executes the replay over ` +
          "the stored corpus and both datasets, computes the per-arm samples, delta " +
          "and Newcombe confidence interval, and records one evaluation per dataset. " +
          "The verifier is the authenticated evaluator with a server-derived replay " +
          "reference; metrics, verifier claims, and evidence text in the request are " +
          "refused, and the proposer cannot evaluate itself. Reaching the weekly " +
          "reflection-token budget blocks the run before anything is recorded.",
        parameters: [workspaceIdParameter, proposalIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RsiEvaluationRequest" },
            },
          },
        },
        responses: {
          201: proposalResponse("Evaluation recorded; the returned gate is recomputed"),
          400: errorResponse("INVALID_REQUEST — including self-verification"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN — owner role required"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("CONFLICT — kill switch active, budget exhausted, or already live"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/approvals": {
      post: {
        operationId: "approveRsiProposal",
        summary: "Record a named human approval for the exact proposal version",
        description:
          `${SESSION_NOTE}Owner or admin. Class B needs one named human; class C ` +
          "needs two distinct humans with the owner and reviewer keys; class A " +
          "needs none only when the workspace enabled automatic promotion. The " +
          "proposer can never approve its own proposal.",
        parameters: [workspaceIdParameter, proposalIdParameter],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { note: { type: "string", maxLength: 1000 } },
              },
            },
          },
        },
        responses: {
          201: proposalResponse("Approval recorded; the gate is recomputed"),
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN — owner or admin required"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("CONFLICT — evaluation has not passed or the proposal is final"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/canary": {
      post: {
        operationId: "startRsiCanary",
        summary: "Start the 10% canary for an eligible proposal",
        description:
          `${SESSION_NOTE}Owner only. Requires a passing offline replay over both ` +
          "datasets, the required human approvals, remaining weekly change budget, " +
          "and an inactive kill switch. The candidate policy stays unpublished: only " +
          "runs pinned into the canary receive it.",
        parameters: [workspaceIdParameter, proposalIdParameter],
        responses: {
          201: proposalResponse("Canary started at 10%"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("CONFLICT — gate not satisfied or kill switch active"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/canary/observations": {
      post: {
        operationId: "recordRsiCanaryObservation",
        summary: "Record a canary stage observation and advance or roll back",
        description:
          `${SESSION_NOTE}Owner only. The sample is derived server-side from the ` +
          "runs this rollout pinned and their terminal task outcomes; pending runs " +
          "are excluded and any request body is refused. The stage advances " +
          "10% → 50% → 100% only after its minimum sample passes. Any security " +
          "event, negative delta, a confidence interval establishing a regression " +
          "beyond the margin, or a rework/cost breach triggers an automatic " +
          "rollback. A pass at 100% promotes and publishes exactly one policy " +
          "version (or activates the candidate memory item).",
        parameters: [workspaceIdParameter, proposalIdParameter],
        responses: {
          201: proposalResponse("Observation recorded; the rollout state reflects the decision"),
          400: errorResponse("INVALID_REQUEST — a request body carrying samples"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("CONFLICT — no active canary or no terminal pinned runs"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/proposals/{proposal_id}/rollback": {
      post: {
        operationId: "rollbackRsiProposal",
        summary: "Roll back a canary or revert a promoted change",
        description:
          `${SESSION_NOTE}Owner only. A canary is stopped; a promoted retrieval change ` +
          "is reverted by publishing the baseline policy as a new immutable version, " +
          "and a promoted memory item is deprecated. Historical run pins are not " +
          "rewritten.",
        parameters: [workspaceIdParameter, proposalIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["reason"],
                additionalProperties: false,
                properties: { reason: { type: "string", maxLength: 1000 } },
              },
            },
          },
        },
        responses: {
          200: proposalResponse("Rolled back"),
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("CONFLICT — nothing to roll back"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/rsi/status": {
      get: {
        operationId: "getRsiStatus",
        summary: "Workspace RSI controls, budgets, holdout counter, and active rollout",
        description:
          `${SESSION_NOTE}${RSI_DESCRIPTION} The holdout block is an aggregate count ` +
          "and last-evaluation timestamp only.",
        parameters: [workspaceIdParameter],
        responses: {
          200: { description: "RSI status", ...jsonRef("#/components/schemas/RsiStatus") },
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/rsi/kill-switch": {
      post: {
        operationId: "setRsiKillSwitch",
        summary: "Engage or release the per-workspace RSI kill switch",
        description:
          `${SESSION_NOTE}Owner only. Engaging requires a reason and takes effect in ` +
          "the same call: every active canary is rolled back, new runs resolve to " +
          "the baseline policy, and proposals, evaluations, approvals, and canaries " +
          "are refused until it is released.",
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["enabled"],
                additionalProperties: false,
                properties: {
                  enabled: { type: "boolean" },
                  reason: { type: ["string", "null"], maxLength: 1000 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Updated controls",
            ...jsonRef("#/components/schemas/RsiControlsResponse"),
          },
          400: errorResponse("INVALID_REQUEST — engaging without a reason"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/rsi/controls": {
      patch: {
        operationId: "updateRsiControls",
        summary: "Tighten automatic promotion or the weekly budgets",
        description:
          `${SESSION_NOTE}Owner only. A workspace can disable automatic promotion and ` +
          "lower its weekly change and reflection-token budgets. Sample sizes, " +
          "regression ceilings, and approval requirements are code constants and " +
          "cannot be raised here.",
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RsiControlsRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "Updated controls",
            ...jsonRef("#/components/schemas/RsiControlsResponse"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
  };
}
