/**
 * OpenAPI contract for the workspace memory v1 surface (DAT-236).
 *
 * Kept beside the implementation so the contract test can compare closed
 * vocabularies against the same constants the service uses. Merge this into
 * the main document from `openapi.ts`.
 */

import type { JsonObject } from "./openapi-types.js";
import {
  MEMORY_EVIDENCE_TYPES,
  MEMORY_FEEDBACK_OUTCOMES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  MEMORY_BUNDLE_VERSION,
  RETRIEVAL_HARD_LIMITS,
} from "../memory/retrieval/index.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

const memoryApplicabilitySchema: JsonObject = {
  type: "object",
  description:
    "Applicability of a memory item, and of a retrieval request's run context. " +
    "An item field that is set only applies when the request field matches " +
    "(path prefixes match on segment boundaries); empty means broad.",
  additionalProperties: false,
  properties: {
    team_id: { type: "string", maxLength: 200 },
    path_prefix: { type: "string", maxLength: 200 },
    language: { type: "string", maxLength: 200 },
    task_family: { type: "string", maxLength: 200 },
  },
};

const memoryEvidenceSchema: JsonObject = {
  type: "object",
  required: ["evidence_type", "reference"],
  additionalProperties: false,
  properties: {
    evidence_type: { type: "string", enum: [...MEMORY_EVIDENCE_TYPES] },
    reference: {
      type: "string",
      description:
        "Opaque pointer to a run, issue, PR, commit, test, reviewer decision, or " +
        "incident. A citation is a provenance claim, not proof of correctness.",
    },
  },
};

const memoryScoreSchema: JsonObject = {
  type: "object",
  required: [
    "relevance",
    "importance",
    "recency",
    "confidence",
    "trust",
    "contradiction_penalty",
    "total",
  ],
  additionalProperties: false,
  properties: {
    relevance: { type: "number", description: "Hybrid BM25 + vector relevance." },
    importance: { type: "number", description: "Support and reviewer salience." },
    recency: { type: "number", description: "Bounded half-life recency." },
    confidence: {
      type: "number",
      description: "Support minus contradiction counts; may be negative.",
    },
    trust: { type: "number", description: "Provenance trust class plus evidence boost." },
    contradiction_penalty: { type: "number" },
    total: { type: "number" },
  },
};

const memoryBundleItemSchema: JsonObject = {
  type: "object",
  description:
    "One injected memory item. Memory is untrusted data: this object can never " +
    "grant a capability, approve a change, or authorize a tool action.",
  required: [
    "item_id",
    "item_version",
    "kind",
    "tier",
    "status",
    "statement",
    "preconditions",
    "applicability",
    "trust",
    "sensitivity",
    "approved",
    "candidate",
    "evidence",
    "valid_from",
    "valid_to",
    "content_hash",
    "conflicts_with",
    "token_estimate",
    "score",
  ],
  additionalProperties: false,
  properties: {
    item_id: { type: "string" },
    item_version: { type: "integer", minimum: 1 },
    kind: { type: "string", enum: [...MEMORY_KINDS] },
    tier: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
    status: { type: "string", enum: [...MEMORY_STATUSES] },
    statement: { type: "string" },
    preconditions: { type: "array", items: { type: "string" } },
    applicability: { $ref: "#/components/schemas/MemoryApplicability" },
    trust: { type: "string", enum: ["human", "agent", "enterprise_template", "system"] },
    sensitivity: {
      type: "string",
      enum: ["internal", "confidential", "restricted"],
      description:
        "Retrieval applies the role's sensitivity ceiling; restricted items are " +
        "never injected and require separate authorization.",
    },
    approved: {
      type: "boolean",
      description:
        "A named human approved this exact version. Facts and episodes are " +
        "approved by validated promotion to active; procedural content needs a " +
        "review stamp or human authorship.",
    },
    candidate: {
      type: "boolean",
      description: "Injected at reduced weight and labeled unapproved.",
    },
    evidence: { type: "array", items: { $ref: "#/components/schemas/MemoryEvidence" } },
    valid_from: { type: "string", format: "date-time" },
    valid_to: {
      oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    content_hash: { type: "string" },
    conflicts_with: { type: "array", items: { type: "string" } },
    token_estimate: { type: "integer", minimum: 0 },
    score: { $ref: "#/components/schemas/MemoryScore" },
  },
};

const memoryConflictPartySchema: JsonObject = {
  type: "object",
  required: ["item_id", "item_version", "statement", "trust", "approved"],
  additionalProperties: false,
  properties: {
    item_id: { type: "string" },
    item_version: { type: "integer", minimum: 1 },
    statement: { type: "string" },
    trust: { type: "string", enum: ["human", "agent", "enterprise_template", "system"] },
    approved: { type: "boolean" },
  },
};

const memoryConflictSchema: JsonObject = {
  type: "object",
  description:
    "A visible contradiction. Neither side is injected as fact while the " +
    "conflict is unresolved; a resolved conflict names the winning item.",
  required: ["item_ids", "reason", "resolved", "winner_item_id", "parties"],
  additionalProperties: false,
  properties: {
    item_ids: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    reason: { type: "string" },
    resolved: { type: "boolean" },
    winner_item_id: { oneOf: [{ type: "string" }, { type: "null" }] },
    parties: { type: "array", items: { $ref: "#/components/schemas/MemoryConflictParty" } },
  },
};

const memoryBundleSchema: JsonObject = {
  type: "object",
  description:
    "Bounded, cited, reproducible memory context for one run. Mandatory L4 " +
    "policy is never counted against the budget. A degraded bundle means memory " +
    "was unavailable and the run proceeds with configured policy only. " +
    "`memory_version` plus `policy_version` identify the exact memory a run read.",
  required: [
    "bundle_id",
    "schema_version",
    "purpose",
    "enterprise_id",
    "workspace_id",
    "version",
    "degraded",
    "degraded_reason",
    "sparse",
    "budget",
    "policy_items",
    "lessons",
    "episodes",
    "facts",
    "candidates",
    "conflicts",
    "signals",
    "trust_boundary",
    "created_at",
  ],
  additionalProperties: false,
  properties: {
    bundle_id: { type: "string" },
    schema_version: { type: "integer", enum: [MEMORY_BUNDLE_VERSION] },
    purpose: { type: "string", enum: ["run_plan", "review", "browse", "eval_replay"] },
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    version: {
      type: "object",
      required: ["memory_version", "policy_version", "policy_hash"],
      additionalProperties: false,
      properties: {
        memory_version: {
          type: "string",
          description: "Deterministic digest of the corpus the bundle read.",
        },
        policy_version: { type: "integer", minimum: 0 },
        policy_hash: { type: "string" },
      },
    },
    degraded: { type: "boolean" },
    degraded_reason: {
      oneOf: [
        { type: "string", enum: ["memory_unavailable", "policy_unavailable", "retrieval_error"] },
        { type: "null" },
      ],
    },
    sparse: {
      type: "boolean",
      description: "Fewer items than the eligible corpus warranted; omitted over diluted.",
    },
    budget: {
      type: "object",
      required: [
        "max_items",
        "max_tokens",
        "context_window_tokens",
        "max_context_share",
        "used_items",
        "used_tokens",
        "omitted_count",
      ],
      additionalProperties: false,
      properties: {
        max_items: { type: "integer", minimum: 0 },
        max_tokens: { type: "integer", minimum: 0 },
        context_window_tokens: { type: "integer", minimum: 0 },
        max_context_share: { type: "number" },
        used_items: { type: "integer", minimum: 0 },
        used_tokens: { type: "integer", minimum: 0 },
        omitted_count: { type: "integer", minimum: 0 },
      },
    },
    policy_items: {
      type: "array",
      description:
        "Mandatory L4 policy; excluded from the token/item budget and never " +
        "truncated. If the workspace policy corpus exceeds the supported bound, " +
        "the request fails with a validation error instead of returning a bundle " +
        "missing policy; that refusal is never reported as a degraded bundle.",
      items: { $ref: "#/components/schemas/MemoryBundleItem" },
    },
    lessons: { type: "array", items: { $ref: "#/components/schemas/MemoryBundleItem" } },
    episodes: { type: "array", items: { $ref: "#/components/schemas/MemoryBundleItem" } },
    facts: { type: "array", items: { $ref: "#/components/schemas/MemoryBundleItem" } },
    candidates: {
      type: "array",
      maxItems: 2,
      description: "Unapproved candidates at reduced weight, capped at two.",
      items: { $ref: "#/components/schemas/MemoryBundleItem" },
    },
    conflicts: { type: "array", items: { $ref: "#/components/schemas/MemoryConflict" } },
    signals: {
      type: "object",
      required: ["lexical", "vector", "vector_unavailable_reason"],
      additionalProperties: false,
      properties: {
        lexical: { type: "boolean" },
        vector: { type: "boolean" },
        vector_unavailable_reason: {
          oneOf: [{ type: "string" }, { type: "null" }],
        },
      },
    },
    trust_boundary: {
      type: "object",
      required: [
        "memory_is_untrusted_data",
        "instructions_allowed",
        "tool_control_authority",
        "citations_required",
        "render_fence",
      ],
      additionalProperties: false,
      properties: {
        memory_is_untrusted_data: { type: "boolean", enum: [true] },
        instructions_allowed: { type: "boolean", enum: [false] },
        tool_control_authority: { type: "string", enum: ["dsh"] },
        citations_required: { type: "boolean", enum: [true] },
        render_fence: { type: "string", enum: ["memory"] },
      },
    },
    created_at: { type: "string", format: "date-time" },
  },
};

const memorySearchRequestSchema: JsonObject = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    purpose: {
      type: "string",
      enum: ["run_plan", "review", "browse", "eval_replay"],
      default: "run_plan",
    },
    query: {
      type: "string",
      maxLength: RETRIEVAL_HARD_LIMITS.query_chars,
      description: "Task/issue text. Used for relevance only, never as authority.",
    },
    scope: { $ref: "#/components/schemas/MemoryApplicability" },
    path_prefix: { type: "string", maxLength: 200 },
    run_id: { type: "string", maxLength: 200 },
    context_window_tokens: {
      type: "integer",
      minimum: 1000,
      maximum: 2000000,
      description:
        "Caller's model context window. Values below 1,000 are rejected rather " +
        "than raised: the token budget is exactly 15% (or the policy share) of " +
        "the stated window, never of a larger substituted one.",
    },
    max_items: {
      type: "integer",
      minimum: 1,
      description: "Clamped down to the policy bound and the hard ceiling.",
    },
    max_tokens: { type: "integer", minimum: 1 },
    include_candidates: { type: "boolean", default: true },
    policy_version: {
      type: "integer",
      minimum: 1,
      description: "Pin a policy version to reproduce a historical run.",
    },
    query_embedding: {
      type: "object",
      required: ["model", "vector"],
      additionalProperties: false,
      description:
        "Query embedding produced through the model gateway (ADR-0005). The " +
        "memory service never calls a model; absent means lexical-only scoring.",
      properties: {
        model: { type: "string", maxLength: 200 },
        vector: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 4096 },
      },
    },
  },
};

const memoryFeedbackRequestSchema: JsonObject = {
  type: "object",
  required: ["bundle_id", "run_id", "outcome"],
  additionalProperties: false,
  properties: {
    bundle_id: { type: "string" },
    run_id: { type: "string" },
    outcome: { type: "string", enum: [...MEMORY_FEEDBACK_OUTCOMES] },
    items: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["item_id", "item_version"],
        additionalProperties: false,
        properties: {
          item_id: { type: "string" },
          item_version: { type: "integer", minimum: 1 },
          useful: { oneOf: [{ type: "boolean" }, { type: "null" }] },
          contradicted: { type: "boolean" },
        },
      },
    },
    note: { type: "string", maxLength: 2000 },
  },
};

const memoryFeedbackRecordSchema: JsonObject = {
  type: "object",
  required: ["feedback_id", "bundle_id", "run_id", "outcome", "items", "created_at", "created_by"],
  additionalProperties: false,
  properties: {
    feedback_id: { type: "string" },
    bundle_id: { type: "string" },
    run_id: { type: "string" },
    outcome: { type: "string", enum: [...MEMORY_FEEDBACK_OUTCOMES] },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["item_id", "item_version", "useful", "contradicted"],
        additionalProperties: false,
        properties: {
          item_id: { type: "string" },
          item_version: { type: "integer" },
          useful: { oneOf: [{ type: "boolean" }, { type: "null" }] },
          contradicted: { type: "boolean" },
        },
      },
    },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "string" },
  },
};

const memoryItemViewSchema: JsonObject = {
  type: "object",
  description:
    "Human browse view of one memory item's current version. Reads are bounded " +
    "and workspace-scoped; there is no cross-workspace browse.",
  required: [
    "item_id",
    "status",
    "current_version",
    "versions_count",
    "kind",
    "tier",
    "statement",
    "preconditions",
    "applicability",
    "trust",
    "sensitivity",
    "approved",
    "valid_from",
    "valid_to",
    "content_hash",
    "support_count",
    "contradiction_count",
    "evidence",
    "updated_at",
  ],
  additionalProperties: false,
  properties: {
    item_id: { type: "string" },
    status: { type: "string", enum: [...MEMORY_STATUSES] },
    current_version: { type: "integer", minimum: 1 },
    versions_count: { type: "integer", minimum: 0 },
    kind: { type: "string", enum: [...MEMORY_KINDS] },
    tier: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
    statement: { type: "string" },
    preconditions: { type: "array", items: { type: "string" } },
    applicability: { $ref: "#/components/schemas/MemoryApplicability" },
    trust: { type: "string", enum: ["human", "agent", "enterprise_template", "system"] },
    sensitivity: { type: "string", enum: ["internal", "confidential", "restricted"] },
    approved: { type: "boolean" },
    valid_from: { type: "string", format: "date-time" },
    valid_to: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    content_hash: { type: "string" },
    support_count: { type: "integer", minimum: 0 },
    contradiction_count: { type: "integer", minimum: 0 },
    evidence: { type: "array", items: { $ref: "#/components/schemas/MemoryEvidence" } },
    updated_at: { type: "string", format: "date-time" },
  },
};

const memoryItemsPageSchema: JsonObject = {
  type: "object",
  required: ["items", "next_cursor"],
  additionalProperties: false,
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/MemoryItemView" } },
    next_cursor: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
};

const retrievalWeightsSchema: JsonObject = {
  type: "object",
  required: ["relevance", "importance", "recency", "confidence", "trust", "contradiction"],
  additionalProperties: false,
  properties: {
    relevance: { type: "number" },
    importance: { type: "number" },
    recency: { type: "number" },
    confidence: { type: "number" },
    trust: { type: "number" },
    contradiction: { type: "number" },
  },
};

const retrievalBoundsSchema: JsonObject = {
  type: "object",
  required: [
    "max_items",
    "max_tokens",
    "max_context_share",
    "context_window_tokens",
    "relevance_floor",
    "candidate_weight",
    "candidate_max",
    "recency_half_life_days",
    "trust_class_weights",
    "evidence_class_boost",
  ],
  additionalProperties: true,
  properties: {
    max_items: { type: "integer" },
    max_tokens: { type: "integer" },
    max_context_share: { type: "number" },
    context_window_tokens: { type: "integer" },
    relevance_floor: { type: "number" },
    candidate_weight: { type: "number" },
    candidate_max: { type: "integer" },
    recency_half_life_days: { type: "number" },
    trust_class_weights: { type: "object", additionalProperties: { type: "number" } },
    evidence_class_boost: { type: "object", additionalProperties: { type: "number" } },
  },
};

const memoryVersionsSchema: JsonObject = {
  type: "object",
  description:
    "Retrieval-policy versions plus the corpus digest and a bounded per-item " +
    "version index for diffing. Version history is immutable; a bundle's " +
    "`version` object names the exact pair it read. The index and corpus counts " +
    "obey the caller's sensitivity ceiling: identifiers, versions, hashes, and " +
    "timestamps of items the role cannot browse are not enumerable here. The " +
    "ceiling is applied to every historical version's own sensitivity, so a " +
    "restricted version stays hidden after the item's current version becomes " +
    "internal.",
  required: [
    "schema_version",
    "memory_version",
    "retrieval_policy",
    "policy_versions",
    "corpus",
    "items",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer" },
    memory_version: { type: "string" },
    retrieval_policy: {
      type: "object",
      required: ["version", "policy_hash", "weights", "bounds"],
      additionalProperties: false,
      properties: {
        version: { type: "integer" },
        policy_hash: { type: "string" },
        weights: { $ref: "#/components/schemas/RetrievalWeights" },
        bounds: { $ref: "#/components/schemas/RetrievalBounds" },
      },
    },
    policy_versions: {
      type: "array",
      items: {
        type: "object",
        required: ["version", "policy_hash", "created_at"],
        additionalProperties: false,
        properties: {
          version: { type: "integer" },
          policy_hash: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
    },
    corpus: {
      type: "object",
      required: ["items", "active_items", "versions", "last_updated_at"],
      additionalProperties: false,
      properties: {
        items: { type: "integer" },
        active_items: { type: "integer" },
        versions: { type: "integer" },
        last_updated_at: { oneOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["item_id", "current_version", "versions"],
        additionalProperties: false,
        properties: {
          item_id: { type: "string" },
          current_version: { type: "integer" },
          versions: {
            type: "array",
            items: {
              type: "object",
              required: ["version", "content_hash", "created_at"],
              additionalProperties: false,
              properties: {
                version: { type: "integer" },
                content_hash: { type: "string" },
                created_at: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
};

const memoryEvalRunRequestSchema: JsonObject = {
  type: "object",
  description:
    "Evaluation result record. Recording a result never promotes memory; the " +
    "RSI approval flow owns that decision. Evaluation cases cannot be written " +
    "through this surface, and the hidden holdout stays read-only to the loop.",
  required: ["kind", "dataset", "policy_version", "memory_version", "metrics", "verdict"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["offline_replay", "canary"] },
    dataset: {
      type: "object",
      required: ["name", "sample_size", "holdout"],
      additionalProperties: false,
      properties: {
        name: { type: "string", maxLength: 200 },
        sample_size: { type: "integer", minimum: 1, maximum: 100000 },
        holdout: { type: "boolean" },
      },
    },
    policy_version: { type: "integer", minimum: 1 },
    memory_version: { type: "string" },
    metrics: {
      type: "object",
      required: ["sample_size"],
      additionalProperties: false,
      properties: {
        success_rate_delta: { type: "number" },
        rework_rate_delta: { type: "number" },
        cost_delta: { type: "number" },
        safety_events: { type: "number" },
        sample_size: { type: "integer", minimum: 1, maximum: 100000 },
      },
    },
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    notes: { type: "string", maxLength: 2000 },
  },
};

const memoryEvalRunRecordSchema: JsonObject = {
  type: "object",
  required: [
    "eval_run_id",
    "kind",
    "dataset",
    "policy_version",
    "memory_version",
    "metrics",
    "verdict",
    "created_at",
    "created_by",
  ],
  additionalProperties: false,
  properties: {
    eval_run_id: { type: "string" },
    kind: { type: "string", enum: ["offline_replay", "canary"] },
    dataset: {
      type: "object",
      required: ["name", "sample_size", "holdout"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        sample_size: { type: "integer" },
        holdout: { type: "boolean" },
      },
    },
    policy_version: { type: "integer" },
    memory_version: { type: "string" },
    metrics: { type: "object", additionalProperties: { type: "number" } },
    verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
    notes: { type: "string" },
    created_at: { type: "string", format: "date-time" },
    created_by: { type: "string" },
  },
};

export const MEMORY_OPENAPI_SCHEMAS: Record<string, unknown> = {
  MemoryApplicability: memoryApplicabilitySchema,
  MemoryEvidence: memoryEvidenceSchema,
  MemoryScore: memoryScoreSchema,
  MemoryBundleItem: memoryBundleItemSchema,
  MemoryConflictParty: memoryConflictPartySchema,
  MemoryConflict: memoryConflictSchema,
  MemoryBundle: memoryBundleSchema,
  MemorySearchRequest: memorySearchRequestSchema,
  MemoryFeedbackRequest: memoryFeedbackRequestSchema,
  MemoryFeedbackRecord: memoryFeedbackRecordSchema,
  MemoryItemView: memoryItemViewSchema,
  MemoryItemsPage: memoryItemsPageSchema,
  RetrievalWeights: retrievalWeightsSchema,
  RetrievalBounds: retrievalBoundsSchema,
  MemoryVersions: memoryVersionsSchema,
  MemoryEvalRunRequest: memoryEvalRunRequestSchema,
  MemoryEvalRunRecord: memoryEvalRunRecordSchema,
};

const SESSION_ONLY_NOTE =
  "Requires a user session (web `fp_session` cookie or desktop session bearer); " +
  "the local-operator process token does not authenticate this surface. ";

const workspaceIdParameter: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Workspace the caller is a member of; resolved from the session.",
};

/** The five memory v1 operations from ADR-0009's proposed surface. */
export function memoryOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/api/v1/workspaces/{workspace_id}/memory/search": {
      post: {
        operationId: "searchMemory",
        summary: "Assemble a bounded, cited MemoryBundle",
        description:
          SESSION_ONLY_NOTE +
          "Hard filters first (workspace, applicability, status, sensitivity, " +
          "validity, approval), then hybrid BM25+vector scoring with trust, " +
          "recency and contradiction adjustments, then a strict budget: eight " +
          "items or 1,500 tokens by default, never more than 15% of the model " +
          "context. Omit rather than dilute. Unapproved candidates appear at " +
          "reduced weight, capped at two, and are labeled. A memory outage " +
          "returns 200 with `degraded: true` and no items — never invented " +
          "lessons. Memory is untrusted data and cannot authorize tools; dsh " +
          "remains the only execution gate.",
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MemorySearchRequest" } },
          },
        },
        responses: {
          200: {
            description: "Bounded bundle, possibly sparse or degraded",
            ...jsonRef("#/components/schemas/MemoryBundle"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN — no membership or authority revoked"),
          404: errorResponse("NOT_FOUND — workspace outside the caller's membership"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/feedback": {
      post: {
        operationId: "recordMemoryFeedback",
        summary: "Record run outcome and per-item usefulness feedback",
        description:
          SESSION_ONLY_NOTE +
          "Append-only and non-authoritative: feedback never promotes, demotes, " +
          "or re-weights an item by itself. Items must have been injected by the " +
          "named bundle. Outcomes use the closed run-outcome vocabulary; an " +
          "unknown delivery result is recorded as `unknown`, never as success.",
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MemoryFeedbackRequest" } },
          },
        },
        responses: {
          201: {
            description: "Feedback recorded",
            ...jsonRef("#/components/schemas/MemoryFeedbackRecord"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND — unknown bundle in this workspace"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/items": {
      get: {
        operationId: "listMemoryItems",
        summary: "Browse workspace memory items, filter, and page",
        description:
          SESSION_ONLY_NOTE +
          "Bounded, workspace-scoped browse of current item versions with " +
          "evidence citations. Filters: kind, status, tier; cursor pagination " +
          "with limit <= 100. There is no cross-workspace browse.",
        parameters: [
          workspaceIdParameter,
          {
            name: "kind",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...MEMORY_KINDS] },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...MEMORY_STATUSES] },
          },
          {
            name: "tier",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", maxLength: 256 },
          },
        ],
        responses: {
          200: {
            description: "Bounded item page",
            ...jsonRef("#/components/schemas/MemoryItemsPage"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/versions": {
      get: {
        operationId: "getMemoryVersions",
        summary: "Retrieval-policy and corpus versions",
        description:
          SESSION_ONLY_NOTE +
          "The current retrieval policy with its immutable version history, the " +
          "deterministic corpus digest (`memory_version`), corpus counts, and a " +
          "bounded per-item version index for diffing. Every run records the pair " +
          "it used, so a bad promotion is reproducible.",
        parameters: [workspaceIdParameter],
        responses: {
          200: {
            description: "Policy and corpus versions",
            ...jsonRef("#/components/schemas/MemoryVersions"),
          },
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/memory/eval-runs": {
      post: {
        operationId: "recordMemoryEvalRun",
        summary: "Record an offline replay or canary evaluation result",
        description:
          SESSION_ONLY_NOTE +
          "Workspace owner only. Records an immutable evaluation result that " +
          "names the policy and memory version evaluated. Recording never " +
          "promotes memory or changes retrieval weights; the RSI approval flow " +
          "(DAT-238) owns promotion, and evaluation cases or holdout content can " +
          "never be written here.",
        parameters: [workspaceIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MemoryEvalRunRequest" } },
          },
        },
        responses: {
          201: {
            description: "Evaluation recorded",
            ...jsonRef("#/components/schemas/MemoryEvalRunRecord"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED"),
          403: errorResponse("FORBIDDEN — owner role required"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
  };
}
