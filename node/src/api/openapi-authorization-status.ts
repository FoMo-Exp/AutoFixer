/**
 * OpenAPI contract for workspace authorization status (DAT-296, ADR-0011).
 *
 * One read-only, admin-scoped operational view: the build/database schema
 * versions, the immutable rollout gate, the workspace repository-set version,
 * the caller's own live authorization context (evidence freshness and safe
 * refusal code) and a bounded denial trend from the append-only audit. It is
 * evidence, never a grant, and it carries no credential, repository URL,
 * resource content or other member's identity.
 */

import type { JsonObject } from "./openapi-types.js";
import {
  CAPABILITY_BLOCK_REASONS,
  REPOSITORY_CAPABILITIES,
} from "../control-plane/member-capability-types.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

const WORKSPACE_ID_PARAMETER: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Workspace locator, resolved against the caller's live membership.",
};

const CAPABILITY_LIST: JsonObject = {
  type: "array",
  items: { type: "string", enum: [...REPOSITORY_CAPABILITIES] },
  description: "Provider-proven repository capabilities, in canonical order.",
};

export const AUTHORIZATION_STATUS_OPENAPI_SCHEMAS: Record<string, JsonObject> = {
  AuthorizationStatusRepository: {
    type: "object",
    additionalProperties: false,
    required: [
      "repository_id",
      "provider_instance_id",
      "state",
      "capabilities",
      "reason",
      "verified_at",
      "freshness",
      "target",
    ],
    properties: {
      repository_id: { type: "string" },
      provider_instance_id: { type: "string" },
      state: { type: "string", enum: ["verified", "unverified", "removed"] },
      capabilities: CAPABILITY_LIST,
      reason: { type: ["string", "null"], enum: [...CAPABILITY_BLOCK_REASONS, null] },
      verified_at: { type: ["string", "null"], format: "date-time" },
      freshness: { type: "string", enum: ["fresh", "stale", "expired", "unknown"] },
      target: { type: "boolean" },
    },
  },
  AuthorizationStatusCaller: {
    type: "object",
    additionalProperties: false,
    required: [
      "evaluated",
      "allowed",
      "code",
      "status",
      "reason",
      "capability_reason",
      "requires_reconciliation",
      "required_capability",
      "target",
      "repository_set_version",
      "context_schema_version",
      "capabilities",
      "available_capabilities",
      "freshness",
      "repositories",
    ],
    properties: {
      evaluated: {
        type: "boolean",
        description: "False when this deployment or this database could not evaluate the context.",
      },
      allowed: { type: "boolean" },
      code: { type: ["string", "null"] },
      status: { type: ["integer", "null"] },
      reason: { type: ["string", "null"] },
      capability_reason: { type: ["string", "null"], enum: [...CAPABILITY_BLOCK_REASONS, null] },
      requires_reconciliation: { type: "boolean" },
      required_capability: { type: ["string", "null"], enum: [...REPOSITORY_CAPABILITIES, null] },
      target: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["provider_instance_id", "repository_id"],
        properties: {
          provider_instance_id: { type: "string" },
          repository_id: { type: "string" },
        },
      },
      repository_set_version: { type: ["integer", "null"] },
      context_schema_version: { type: ["integer", "null"] },
      capabilities: CAPABILITY_LIST,
      available_capabilities: CAPABILITY_LIST,
      freshness: {
        type: "object",
        additionalProperties: false,
        required: ["verified_at", "fresh_window_ms", "stale_after_ms", "state"],
        properties: {
          verified_at: { type: ["string", "null"], format: "date-time" },
          fresh_window_ms: { type: "integer" },
          stale_after_ms: { type: "integer" },
          state: { type: "string", enum: ["fresh", "stale", "expired", "unknown"] },
        },
      },
      repositories: {
        type: "array",
        items: { $ref: "#/components/schemas/AuthorizationStatusRepository" },
      },
    },
  },
  WorkspaceAuthorizationStatus: {
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "enterprise_id",
      "workspace_id",
      "checked_at",
      "build",
      "rollout",
      "repository_set",
      "caller",
      "denials",
    ],
    properties: {
      schema_version: { type: "string", enum: ["1"] },
      enterprise_id: { type: "string" },
      workspace_id: { type: "string" },
      checked_at: { type: "string", format: "date-time" },
      build: {
        type: "object",
        additionalProperties: false,
        required: ["schema_version", "database_schema_version", "mixed_version"],
        properties: {
          schema_version: { type: "integer" },
          database_schema_version: { type: "integer" },
          mixed_version: {
            type: "boolean",
            description:
              "True when the database was migrated by a newer build than this process; " +
              "authorization refuses on that state and names this fact.",
          },
        },
      },
      rollout: {
        type: "object",
        additionalProperties: false,
        required: ["gate", "enforcement"],
        properties: {
          gate: {
            type: "object",
            additionalProperties: false,
            required: ["key", "state", "min_schema_version", "unreadable_code"],
            properties: {
              key: { type: "string" },
              state: { type: "string", enum: ["enabled", "disabled", "unreadable"] },
              min_schema_version: { type: ["integer", "null"] },
              unreadable_code: { type: ["string", "null"] },
            },
          },
          enforcement: {
            type: "string",
            enum: ["complete", "none"],
            description: "This build's complete-set enforcement mode; not a rollout switch.",
          },
        },
      },
      repository_set: {
        type: "object",
        additionalProperties: false,
        required: [
          "readable",
          "unreadable_reason",
          "version",
          "repository_count",
          "multi_repository",
          "usable",
          "blocked_reason",
        ],
        properties: {
          readable: { type: "boolean" },
          unreadable_reason: {
            type: ["string", "null"],
            description: "A stable repository-set refusal code when the set could not be read.",
          },
          version: { type: ["integer", "null"] },
          repository_count: { type: ["integer", "null"] },
          multi_repository: { type: ["boolean", "null"] },
          usable: { type: ["boolean", "null"] },
          blocked_reason: { type: ["string", "null"] },
        },
      },
      caller: { $ref: "#/components/schemas/AuthorizationStatusCaller" },
      denials: {
        type: "object",
        additionalProperties: false,
        required: [
          "since",
          "until",
          "window_ms",
          "total",
          "by_code",
          "by_action",
          "by_capability_reason",
        ],
        properties: {
          since: { type: "string", format: "date-time" },
          until: { type: "string", format: "date-time" },
          window_ms: { type: "integer" },
          total: { type: "integer" },
          by_code: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "count"],
              properties: { code: { type: "string" }, count: { type: "integer" } },
            },
          },
          by_action: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["action", "count"],
              properties: { action: { type: "string" }, count: { type: "integer" } },
            },
          },
          by_capability_reason: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["code", "count"],
              properties: {
                code: { type: "string", enum: [...CAPABILITY_BLOCK_REASONS] },
                count: { type: "integer" },
              },
            },
          },
          series: {
            type: "array",
            description: "Sparse UTC hourly counts, oldest first; a missing hour is a zero.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["bucket_start", "count"],
              properties: {
                bucket_start: { type: "string", format: "date-time" },
                count: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
};

export function authorizationStatusOpenApiPaths(): Record<string, JsonObject> {
  return {
    "/api/v1/workspaces/{workspace_id}/authorization-status": {
      get: {
        operationId: "getWorkspaceAuthorizationStatus",
        summary: "Workspace authorization status and denial trend",
        description:
          "Admin/owner-scoped, read-only evidence for incident response: build and " +
          "database schema versions, the immutable multi-repository rollout gate, " +
          "the workspace repository-set version, the caller's own live authorization " +
          "context (per-repository evidence freshness and the safe refusal code), and " +
          "denial counts by code/action/capability reason inside a bounded window. " +
          "It remains readable while authority is unverified, which is the state it " +
          "exists to explain. It grants nothing: every protected request decides on " +
          "its own. It exposes no credential, repository URL or content, or other " +
          "member's identity.",
        tags: ["workspaces"],
        parameters: [
          WORKSPACE_ID_PARAMETER,
          {
            name: "window_minutes",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 10080, default: 1440 },
            description: "Denial-trend window; clamped to the service's bounded range.",
          },
        ],
        responses: {
          200: {
            description: "The workspace's authorization status.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WorkspaceAuthorizationStatus" },
              },
            },
          },
          400: errorResponse("INVALID_REQUEST — window_minutes is not a positive number"),
          403: errorResponse("WORKSPACE_ROLE_REQUIRED — the caller is not admin or owner"),
          404: errorResponse("NOT_FOUND — unknown workspace or no live membership"),
        },
      },
    },
  };
}
