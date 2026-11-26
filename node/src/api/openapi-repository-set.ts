/**
 * OpenAPI contract for the workspace repository-addition surface
 * (DAT-286, ADR-0011).
 *
 * Three operations, one decision:
 *
 * 1. `preview` reports the exact before/after impact of adding repositories to
 *    a workspace and writes nothing.
 * 2. `confirm` records an actor-bound, expiring confirmation of exactly that
 *    impact. It is evidence of an informed decision, never an authorization
 *    grant.
 * 3. `commit` re-authorizes and revalidates everything inside one transaction
 *    and writes the bindings, the new set version, the approved ceiling
 *    reductions, the required grant revocations and the audit row together.
 *
 * The contract states the two boundaries a client must not have to guess:
 * a preview `authorizes_access` is always false, and the preview is produced
 * only for an actor authorized to see the whole impact — a redacted preview is
 * not informed consent. It carries no credentials, provider subjects,
 * repository URLs or repository names, so it is safe to render as-is.
 */

import type { JsonObject } from "./openapi-types.js";
import { CAPABILITY_BLOCK_REASONS } from "../control-plane/member-capability-types.js";
import { REPOSITORY_CAPABILITIES } from "../control-plane/member-capability-types.js";
import { REPOSITORY_SET_ADDITION_COMMIT_BLOCKS } from "../provider-access/repository-set-change.js";
import {
  ADMISSION_EVIDENCE_CLASSES,
  EFFECTIVE_OWNER_REASONS,
} from "../provider-access/member-admission.js";
import { WORKSPACE_ROLES } from "../control-plane/types.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

const WORKSPACE_ID_PARAMETER: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Workspace locator, resolved against the caller's live membership.",
};

const CONFIRMATION_ID_PARAMETER: JsonObject = {
  name: "confirmation_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description:
    "Opaque id of a confirmation this actor recorded for this workspace; " +
    "another actor's confirmation is indistinguishable from a missing one.",
};

const CAPABILITIES_SCHEMA: JsonObject = {
  type: "array",
  items: { type: "string", enum: [...REPOSITORY_CAPABILITIES] },
  description:
    "Provider-proven repository capabilities, in canonical order. Never a " +
    "provider role name and never a workspace role.",
};

const ADDITION_REPOSITORY_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["provider_instance_id", "installation_ref", "repository_id"],
  properties: {
    provider_instance_id: {
      type: "string",
      description: "An instance this enterprise has approved; an unapproved one fails evidence.",
    },
    installation_ref: {
      type: ["string", "null"],
      description:
        "The approved, active installation that observes exactly this workspace, " +
        "instance and repository. A new addition always needs one; a null value " +
        "only describes the legacy backfill and is refused for a new binding.",
    },
    repository_id: {
      type: "string",
      description:
        "Immutable provider-assigned repository id; the only authority-bearing identity.",
    },
    repository_url: {
      type: ["string", "null"],
      description:
        "Display metadata. Never stored in a confirmation, a binding or an " +
        "audit row, and never used for authorization.",
    },
    repository_name: {
      type: ["string", "null"],
      description:
        "Display metadata. Never stored in a confirmation or an audit row; the " +
        "committed binding takes its name from the verified installation.",
    },
  },
};

const PROPOSAL_PROPERTIES: Record<string, JsonObject> = {
  expected_set_version: {
    type: ["integer", "null"],
    minimum: 1,
    description:
      "The repository-set version the caller observed. The preview compares it " +
      "with the stored version and refuses a conflict; the confirmation binds it, " +
      "so a set change while the actor decides invalidates the decision. Optional " +
      "on preview (the stored version is used), required to confirm.",
  },
  additional_repositories: {
    type: "array",
    minItems: 1,
    items: { $ref: "#/components/schemas/RepositorySetAdditionRepository" },
    description:
      "Repositories to add. A proposal only adds: an already-bound repository is " +
      "refused (409 REPOSITORY_SET_CHANGE_INVALID_PROPOSAL).",
  },
};

const reductionSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["membership_id", "user_id", "capabilities"],
  properties: {
    membership_id: { type: "string" },
    user_id: { type: "string" },
    capabilities: CAPABILITIES_SCHEMA,
  },
};

export const REPOSITORY_SET_OPENAPI_SCHEMAS = {
  RepositorySetAdditionRepository: ADDITION_REPOSITORY_SCHEMA,
  RepositorySetAdditionPreview: {
    type: "object",
    required: [
      "preview",
      "authorizes_access",
      "enterprise_id",
      "workspace_id",
      "set_version",
      "proposed_repository_count",
      "multi_repository_gate",
      "current_set_blocked_reason",
      "checked_at",
      "members",
      "owners",
      "last_owner_survives",
      "all_members_retain_admission",
      "reductions_required",
      "impact",
      "committable",
      "commit_blocked_reasons",
    ],
    properties: {
      preview: { type: "boolean", enum: [true] },
      authorizes_access: {
        type: "boolean",
        enum: [false],
        description:
          "Always false: a preview describes a repository set that does not " +
          "exist yet, so it never authorizes access.",
      },
      enterprise_id: { type: "string" },
      workspace_id: { type: "string" },
      set_version: {
        type: "integer",
        minimum: 1,
        description: "The stored set version this preview was formed against.",
      },
      proposed_repository_count: {
        type: "integer",
        minimum: 1,
        description: "Every active repository plus the proposed additions.",
      },
      multi_repository_gate: {
        type: "string",
        enum: ["enabled", "disabled", "unreadable"],
        description:
          "Rollout gate. A change cannot commit while it is disabled: the set " +
          "would be storage no access path enforces.",
      },
      current_set_blocked_reason: {
        type: ["string", "null"],
        enum: [...CAPABILITY_BLOCK_REASONS, null],
        description: "Why the *current* set already authorizes nothing, if it does.",
      },
      checked_at: { type: "string", format: "date-time" },
      members: {
        type: "array",
        items: { $ref: "#/components/schemas/RepositorySetAdditionPreviewMember" },
      },
      owners: {
        type: "array",
        items: { $ref: "#/components/schemas/RepositorySetAdditionPreviewOwner" },
      },
      last_owner_survives: {
        type: "boolean",
        description:
          "False when no owner would keep every necessary management capability " +
          "across the proposed set, even if everyone retains read.",
      },
      all_members_retain_admission: {
        type: "boolean",
        description:
          "True only when every current effective member keeps verified code read " +
          "on every repository of the proposed set.",
      },
      reductions_required: {
        type: "array",
        items: { $ref: "#/components/schemas/ConfirmedReduction" },
        description:
          "Exactly the members and capabilities a confirmation must acknowledge. " +
          "An empty list means the addition removes nothing.",
      },
      impact: { $ref: "#/components/schemas/RepositorySetChangeImpact" },
      committable: {
        type: "boolean",
        description: "True only when this exact addition may proceed to confirmation.",
      },
      commit_blocked_reasons: {
        type: "array",
        items: { type: "string", enum: [...REPOSITORY_SET_ADDITION_COMMIT_BLOCKS] },
        description:
          "Every reason the addition cannot be committed, in canonical order. " +
          "Empty exactly when `committable` is true.",
      },
    },
  },
  RepositorySetAdditionPreviewMember: {
    type: "object",
    required: [
      "membership_id",
      "user_id",
      "role",
      "retains_admission",
      "current_capabilities",
      "proposed_capabilities",
      "reduction",
      "evidence_classes",
      "evidence_complete",
      "reason",
      "verified_at",
    ],
    properties: {
      membership_id: { type: "string" },
      user_id: { type: "string" },
      role: {
        type: "string",
        enum: [...WORKSPACE_ROLES],
        description: "The assigned workspace role, preserved by any capability change.",
      },
      retains_admission: {
        type: "boolean",
        description: "True when the member keeps verified code read on the proposed set.",
      },
      current_capabilities: {
        ...CAPABILITIES_SCHEMA,
        description:
          "The verified effective intersection today. Empty when today's evidence " +
          "cannot establish one — `evidence_classes` says why, and an empty list " +
          "here is never a recorded revocation.",
      },
      proposed_capabilities: CAPABILITIES_SCHEMA,
      reduction: CAPABILITIES_SCHEMA,
      evidence_classes: {
        type: "array",
        items: { type: "string", enum: [...ADMISSION_EVIDENCE_CLASSES] },
        description:
          "Every evidence class that is not `verified`: why the proposed set could " +
          "not establish this member's admission. Unknown, expired, truncated or " +
          "unavailable evidence is never reported as a confirmed removal.",
      },
      evidence_complete: { type: "boolean" },
      reason: {
        type: ["string", "null"],
        enum: [...CAPABILITY_BLOCK_REASONS, null],
        description: "Why the proposed set does not verify, when it does not.",
      },
      verified_at: {
        type: ["string", "null"],
        format: "date-time",
        description: "Oldest verification timestamp behind the facts (safe bound).",
      },
    },
  },
  RepositorySetAdditionPreviewOwner: {
    type: "object",
    required: ["user_id", "effective", "reason"],
    properties: {
      user_id: { type: "string" },
      effective: {
        type: "boolean",
        description:
          "True only for an owner assignment with verified management capability " +
          "across every repository of the proposed set.",
      },
      reason: {
        type: ["string", "null"],
        enum: [...EFFECTIVE_OWNER_REASONS, null],
      },
    },
  },
  ConfirmedReduction: reductionSchema,
  RepositorySetChangeImpact: {
    type: "object",
    required: [
      "proposed_repository_count",
      "protected_members",
      "reduced_members",
      "removed_capabilities",
      "effective_owners",
      "last_owner_survives",
    ],
    properties: {
      proposed_repository_count: { type: "integer", minimum: 1 },
      protected_members: { type: "integer", minimum: 0 },
      reduced_members: { type: "integer", minimum: 0 },
      removed_capabilities: { type: "integer", minimum: 0 },
      effective_owners: { type: "integer", minimum: 0 },
      last_owner_survives: { type: "boolean" },
    },
  },
  RepositorySetAdditionConfirmation: {
    type: "object",
    required: [
      "confirmation_id",
      "workspace_id",
      "set_version",
      "proposed_repositories",
      "members",
      "owners",
      "last_owner_survives",
      "all_members_retain_admission",
      "evidence_complete",
      "impact",
      "checked_at",
      "expires_at",
      "created_at",
      "authorizes_access",
      "consumed_at",
    ],
    properties: {
      confirmation_id: { type: "string" },
      workspace_id: { type: "string" },
      set_version: {
        type: "integer",
        minimum: 1,
        description: "The set version the confirmation was formed against.",
      },
      proposed_repositories: {
        type: "array",
        items: { $ref: "#/components/schemas/RepositorySetAdditionRepositoryIdentity" },
      },
      members: {
        type: "array",
        items: { $ref: "#/components/schemas/RepositorySetAdditionConfirmationMember" },
      },
      owners: {
        type: "array",
        items: {
          type: "object",
          required: ["user_id", "effective"],
          properties: {
            user_id: { type: "string" },
            effective: { type: "boolean" },
          },
        },
      },
      last_owner_survives: { type: "boolean" },
      all_members_retain_admission: { type: "boolean" },
      evidence_complete: { type: "boolean" },
      impact: { $ref: "#/components/schemas/RepositorySetChangeImpact" },
      checked_at: { type: "string", format: "date-time" },
      expires_at: {
        type: "string",
        format: "date-time",
        description:
          "Bounded validity. After this instant the commit is refused and a fresh " +
          "preview and confirmation are required.",
      },
      created_at: { type: "string", format: "date-time" },
      authorizes_access: {
        type: "boolean",
        enum: [false],
        description: "Always false: a confirmation is evidence of a decision, not a grant.",
      },
      consumed_at: {
        type: ["string", "null"],
        format: "date-time",
        description: "Set once a commit consumed the confirmation; a change commits at most once.",
      },
    },
  },
  RepositorySetAdditionRepositoryIdentity: {
    type: "object",
    required: ["provider_instance_id", "repository_id"],
    properties: {
      provider_instance_id: { type: "string" },
      repository_id: { type: "string" },
    },
    description:
      "The immutable identity a confirmation binds. Display metadata is " +
      "deliberately absent: a decision record never stores a repository URL or name.",
  },
  RepositorySetAdditionConfirmationMember: {
    type: "object",
    required: [
      "membership_id",
      "user_id",
      "role",
      "retains_admission",
      "proposed_capabilities",
      "reduction",
    ],
    properties: {
      membership_id: { type: "string" },
      user_id: { type: "string" },
      role: { type: "string", enum: [...WORKSPACE_ROLES] },
      retains_admission: { type: "boolean" },
      proposed_capabilities: CAPABILITIES_SCHEMA,
      reduction: CAPABILITIES_SCHEMA,
    },
  },
  RepositorySetAdditionCommitResult: {
    type: "object",
    required: [
      "workspace_id",
      "confirmation_id",
      "set_version_before",
      "set_version_after",
      "repositories",
      "members_reduced",
      "grants_revoked",
      "effective_owners",
      "committed_at",
    ],
    properties: {
      workspace_id: { type: "string" },
      confirmation_id: { type: "string" },
      set_version_before: { type: "integer", minimum: 1 },
      set_version_after: {
        type: "integer",
        minimum: 2,
        description:
          "The committed set version. Decisions formed against the old version are " +
          "invalid and must be re-read.",
      },
      repositories: {
        type: "array",
        items: { $ref: "#/components/schemas/RepositorySetAdditionRepositoryIdentity" },
      },
      members_reduced: {
        type: "array",
        items: {
          type: "object",
          required: ["user_id", "capabilities"],
          properties: {
            user_id: { type: "string" },
            capabilities: CAPABILITIES_SCHEMA,
          },
        },
      },
      grants_revoked: {
        type: "integer",
        minimum: 0,
        description:
          "Live capability grants revoked because the reduced ceiling no longer supports them.",
      },
      effective_owners: {
        type: "array",
        items: { type: "string" },
        description:
          "Owners that retain every necessary management capability over the committed set.",
      },
      committed_at: { type: "string", format: "date-time" },
    },
  },
};

const PROPOSAL_BODY: JsonObject = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["additional_repositories"],
        properties: PROPOSAL_PROPERTIES,
      },
    },
  },
};

const PREVIEW_DESCRIPTION =
  "Evaluates every current effective member's capability intersection over the " +
  "proposed set and reports the exact before/after impact, the surviving " +
  "effective owners, the reductions a confirmation must acknowledge, and every " +
  "reason the addition cannot be committed. It writes nothing and grants " +
  "nothing (`authorizes_access: false`). A member without verified code read on " +
  "every proposed repository, or a member whose evidence is unknown, expired, " +
  "truncated or unavailable, makes the addition non-committable — unknown " +
  "evidence is never reported as a confirmed removal. The preview is only " +
  "produced for a caller whose verified repository management covers every " +
  "current repository; a caller who cannot see the whole impact is refused " +
  "instead of being shown a redacted preview.";

export function repositorySetOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/api/v1/workspaces/{workspace_id}/repository-set-additions/preview": {
      post: {
        operationId: "previewRepositorySetAddition",
        summary: "Preview the member impact of adding repositories to a workspace",
        description: PREVIEW_DESCRIPTION,
        parameters: [WORKSPACE_ID_PARAMETER],
        requestBody: PROPOSAL_BODY,
        responses: {
          200: {
            description: "The full-set impact preview. Nothing was written.",
            ...jsonRef("#/components/schemas/RepositorySetAdditionPreview"),
          },
          400: errorResponse("INVALID_REQUEST — malformed proposal"),
          403: errorResponse(
            "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED — not an active workspace owner/admin " +
              "with verified repository management across the current set; " +
              "SCOPE_MUTATION_DISABLED / FEATURE_GATE_UNREADABLE when the gate refuses",
          ),
          404: errorResponse("NOT_FOUND — unknown workspace or no live membership"),
          409: errorResponse(
            "REPOSITORY_SET_VERSION_CONFLICT or REPOSITORY_SET_CHANGE_INVALID_PROPOSAL",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/repository-set-additions/confirmations": {
      post: {
        operationId: "confirmRepositorySetAddition",
        summary: "Record an actor-bound confirmation of the previewed addition",
        description:
          "Records a durable, actor-bound, expiring confirmation of exactly the " +
          "impact a preview showed. `confirmed_reductions` must match the preview's " +
          "`reductions_required` exactly; any difference is refused as stale, so a " +
          "capability reduction can never be a silent side effect. The change is " +
          "refused outright when a protected member would lose admission, when any " +
          "necessary evidence is not verified, or when no effective owner would " +
          "survive — no member is removed and no unverified evidence is treated as " +
          "consent. No binding is written; the confirmation is evidence of a " +
          "decision, not a grant.",
        parameters: [WORKSPACE_ID_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["expected_set_version", "additional_repositories"],
                properties: {
                  ...PROPOSAL_PROPERTIES,
                  expected_set_version: {
                    ...(PROPOSAL_PROPERTIES["expected_set_version"] as JsonObject),
                    type: "integer",
                  },
                  confirmed_reductions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ConfirmedReduction" },
                    description:
                      "Exactly the affected members and capabilities the preview " +
                      "reported in `reductions_required`. Empty when nothing is reduced.",
                  },
                  ttl_ms: {
                    type: "integer",
                    minimum: 1,
                    maximum: 86_400_000,
                    description:
                      "Optional bounded validity override (default fifteen minutes, " +
                      "maximum one day). A confirmation that outlives a workday is not " +
                      "a bounded decision.",
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "The recorded confirmation, with its exact impact and expiry.",
            ...jsonRef("#/components/schemas/RepositorySetAdditionConfirmation"),
          },
          400: errorResponse(
            "INVALID_REQUEST — malformed proposal or missing expected_set_version",
          ),
          403: errorResponse(
            "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED, SCOPE_MUTATION_DISABLED — the " +
              "caller may not decide this change",
          ),
          404: errorResponse("NOT_FOUND — unknown workspace or no live membership"),
          409: errorResponse(
            "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE — a protected member would lose " +
              "admission, evidence is not verified, or no effective owner would " +
              "survive; REPOSITORY_SET_CHANGE_CONFIRMATION_STALE — the confirmed " +
              "reductions differ from the current impact; REPOSITORY_SET_VERSION_CONFLICT",
          ),
          500: errorResponse("REPOSITORY_SET_CHANGE_AUDIT_FAILED — nothing was recorded"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/repository-set-additions/confirmations/{confirmation_id}/commit":
      {
        post: {
          operationId: "commitRepositorySetAddition",
          summary: "Commit one confirmed repository addition atomically",
          description:
            "Inside one transaction: re-authorizes the actor, re-reads the set " +
            "version, re-evaluates every protected member, owner and provider " +
            "evidence fact, compares it with the confirmed facts, then writes the " +
            "bindings, the new set version, the approved ceiling reductions (the " +
            "assigned roles are preserved), the required grant revocations, the " +
            "required audit row and the confirmation's consumption together. Any " +
            "change, expiry, permission loss or write failure refuses the whole " +
            "change: a stale decision never commits and nothing is partially " +
            "applied. A conflict is retried by previewing and confirming again; the " +
            "old confirmation stays refused.",
          parameters: [WORKSPACE_ID_PARAMETER, CONFIRMATION_ID_PARAMETER],
          responses: {
            200: {
              description: "The committed change and its impact.",
              ...jsonRef("#/components/schemas/RepositorySetAdditionCommitResult"),
            },
            403: errorResponse(
              "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED, SCOPE_MUTATION_DISABLED — the " +
                "caller may no longer decide this change",
            ),
            404: errorResponse("NOT_FOUND — unknown workspace or no live membership"),
            409: errorResponse(
              "REPOSITORY_SET_CHANGE_CONFIRMATION_REQUIRED / _CONSUMED / _EXPIRED / " +
                "_STALE, REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE, " +
                "REPOSITORY_SET_CHANGE_CONFLICT, REPOSITORY_SET_VERSION_CONFLICT",
            ),
            500: errorResponse(
              "REPOSITORY_SET_CHANGE_AUDIT_FAILED — the whole change was rolled back",
            ),
          },
        },
      },
  };
}
